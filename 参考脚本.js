//<script>
(async () => {
    // ─── constants ────────────────────────────────────────────────────────────
    const VERSION = '2.18';
    const MODAL = 'flow_guard_modal';
    const STYLE = 'flow_guard_style';
    const NAME = 'flow_guard';
    const CONFIG_FILE = '/sdcard/flow_guard_config.conf';
    const SH_FILE = '/sdcard/flow_guard.sh';
    const LOG_FILE = '/sdcard/flow_guard_log.log';
    const DATA_DIR = '/sdcard/flow_guard_data';
    const BOOT_SH_FILE = '/sdcard/ufi_tools_boot.sh';
    const BOOT_LINE = `/system/bin/sh ${SH_FILE} &`;
    const LS_KEY = 'flow_guard_';

    // ─── utils ────────────────────────────────────────────────────────────────
    const sq = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
    const esc = (v) => String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    const run = async (cmd, timeout = 30000) => runShellWithRoot(cmd, timeout);

    // ─── state ────────────────────────────────────────────────────────────────
    const state = {
        installed: false,
        autoLog: false,
        autoLogTimer: null,
        needsResetFlowDay: false,   // 当日流量是否需要重置
        needsResetFlowMonth: false, // 当月流量是否需要重置
        needsResetTemp: false,      // 温度是否需要重置
        config: {
            dailyLimit: parseFloat(localStorage.getItem(LS_KEY + 'dailyLimit')) || 0,
            monthlyLimit: parseFloat(localStorage.getItem(LS_KEY + 'monthlyLimit')) || 0,
            tempLimit: parseInt(localStorage.getItem(LS_KEY + 'tempLimit')) || 0,
            pushPlusToken: localStorage.getItem(LS_KEY + 'pushPlusToken') || '',
        },
    };

    // ─── shell script template ────────────────────────────────────────────────
    const genScript = () => {
        return `#!/system/bin/sh
# auto generated: flow guard monitor v${VERSION}
LOG_FILE="${LOG_FILE}"
CONFIG_FILE="${CONFIG_FILE}"
DATA_DIR="${DATA_DIR}"
CHECK_INTERVAL=60 # 1分钟循环

mkdir -p "$DATA_DIR"
rm -f "$LOG_FILE"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"; }

log "设备状态守护v${VERSION} 已启动 (PID=$$)"

trap 'kill $(jobs -p) 2>/dev/null; log "设备状态守护已退出"; exit 0' INT TERM

DAILY_LIMIT=${state.config.dailyLimit}
MONTHLY_LIMIT=${state.config.monthlyLimit}
TEMP_LIMIT=${state.config.tempLimit}
PUSHPLUS_TOKEN='${state.config.pushPlusToken}'

CURL_BIN="/data/data/com.minikano.f50_sms/files/curl"
[ ! -x "$CURL_BIN" ] && CURL_BIN="curl"

# WAN 接口探测
detect_wan() {
    for iface in $(ls /sys/class/net/ 2>/dev/null); do
        case "$iface" in
            lo|br0|wlan0|ap0|swlan0|dummy*|ifb*|tunl*|gre*|sit*|ip6*|erspan*|ip_vti*) continue ;;
        esac
        ip addr show dev "$iface" 2>/dev/null | grep -q "inet " || continue
        rx=$(awk '{print}' "/sys/class/net/\$iface/statistics/rx_bytes" 2>/dev/null)
        [ "\${rx:-0}" != "0" ] && { echo "$iface"; return; }
    done
    for cand in sipa_eth0 rmnet_data0 rmnet0; do
        [ -d "/sys/class/net/$cand" ] && { echo "$cand"; return; }
    done
}
WAN_IF=$(detect_wan)

# 读取 WAN 接口 sysfs rx+tx 总和
read_sysfs_total() {
    [ -z "$WAN_IF" ] && { echo 0; return; }
    awk 'NR==1{r=$0}NR==2{print r+$0}' \\
        "/sys/class/net/$WAN_IF/statistics/rx_bytes" \\
        "/sys/class/net/$WAN_IF/statistics/tx_bytes" 2>/dev/null || echo 0
}

# dumpsys 专用获取网卡使用数据
get_usage_bytes() {
    ms=\$(date -d "\$(date +%Y-%m)-01 00:00:00" +%s 2>/dev/null)
    ds=\$(date -d "\$(date +%Y-%m-%d) 00:00:00" +%s 2>/dev/null)
    if echo "\$ms" | grep -qE '^[0-9]+$' && echo "\$ds" | grep -qE '^[0-9]+$'; then
        result=\$(dumpsys netstats --full 2>/dev/null | awk -v ms="\$ms" -v ds="\$ds" '
        /^Dev stats:/{d=1;next}
        d && /^[^ ]/{exit}
        d && /type=0/{m=1}
        d && /ident=/ && !/type=0/{m=0}
        d && m && /st=/{
          split(\$1,a,"="); split(\$2,b,"="); split(\$4,c,"=")
          bs=a[2]+0; v=b[2]+c[2]
          if(bs>=ms) tm+=v
          if(bs>=ds) td+=v
        }
        END{print tm+0, td+0}')
        read dm_bytes dd_bytes <<EOF2
\$result
EOF2
        if [ "\${dm_bytes:-0}" != "0" ]; then
            echo "\$dm_bytes \$dd_bytes"
            return
        fi
    fi
    echo "0 0"
}

# 状态标志位
PREV_DISCONNECTED=""
FIRST_RUN="1"
FIRST_RUN_TEMP="1"

notify() {
    [ -z "$PUSHPLUS_TOKEN" ] && { log "[通知] 未配置 PushPlus Token，跳过发送"; return 1; }
    
    log "[通知] 正在通过 PushPlus 发送报警消息..."
    msg=$(printf '%s' "$1" | sed 's/"/\\"/g')
    
    # 构造 JSON 请求体
    cat > "$DATA_DIR/pp_body.json" <<EOF4
{
    "token": "$PUSHPLUS_TOKEN",
    "title": "设备状态提醒",
    "content": "$msg"
}
EOF4

    notify_out=$($CURL_BIN -s -X POST http://www.pushplus.plus/send -H "Content-Type: application/json" -d @"$DATA_DIR/pp_body.json" 2>&1)
    notify_ret=$?
    
    if [ "$notify_ret" -eq 0 ] && echo "$notify_out" | grep -q '"code":200'; then
        log "[通知] 发送成功"
    else
        log "[通知] 发送失败(代码:\$notify_ret) - \$notify_out"
    fi
}

# 全节点遍历提取最高真实核心温度
get_device_temp() {
    cat /sys/class/thermal/thermal_zone*/temp /sys/devices/virtual/thermal/thermal_zone*/temp 2>/dev/null | awk '
    BEGIN { max=0 }
    {
        v=$1+0
        if (v > 1000) v = int(v/1000)
        else if (v > 200 && v < 1000) v = int(v/10)
        
        # 过滤荒谬值，寻找合理范围内的最大值 (0 ~ 150度)
        if (v > 0 && v < 150 && v > max) {
            max = v
        }
    }
    END { print max }'
}

check_temp() {
    MSG_TEMP=""
    [ -z "$TEMP_LIMIT" ] || [ "$TEMP_LIMIT" = "0" ] && return
    
    local cur_temp=\$(get_device_temp)
    [ -z "\$cur_temp" ] || [ "\$cur_temp" = "0" ] && return

    # 首次运行时打印真实测温结果
    if [ "$FIRST_RUN_TEMP" = "1" ]; then
        log "温度传感器自检: 获取到当前最高核心温度为 \$cur_temp ℃"
        FIRST_RUN_TEMP="0"
    fi

    if [ "\$cur_temp" -ge "$TEMP_LIMIT" ]; then
        # 检查今天是否已经发送过温度报警
        last_notify_temp=\$(awk '{print}' "$DATA_DIR/notified_temp_today.txt" 2>/dev/null)
        if [ "\$last_notify_temp" != "\$cur_day" ]; then
            log "[提醒] 当前温度 \$cur_temp ℃，超过设定限额 $TEMP_LIMIT ℃"
            MSG_TEMP="设备温度警告：当前设备最高核心温度已达 \${cur_temp}℃，超过设定的 \${TEMP_LIMIT}℃ 阈值，请注意设备散热防爆！"
        fi
    fi
}

check_flow() {
    MSG_FLOW_DAY=""
    MSG_FLOW_MONTH=""
    
    if [ -z "$WAN_IF" ] || ! ip addr show "$WAN_IF" 2>/dev/null | grep -q "inet "; then
        if [ "$PREV_DISCONNECTED" != "1" ]; then
            log "数据网络未连接，等待恢复..."
            PREV_DISCONNECTED="1"
        fi
        return
    fi

    if [ "$PREV_DISCONNECTED" = "1" ]; then
        log "数据网络已恢复，重新开始监控"
    fi
    PREV_DISCONNECTED="0"

    read used_bytes today_bytes <<EOF
\$(get_usage_bytes)
EOF
    if [ -z "$used_bytes" ]; then
        return
    fi

    read used_gb today_gb <<EOF
\$(awk "BEGIN{u=\$used_bytes/1073741824; t=\$today_bytes/1073741824; printf \\"%.2f %.2f\\", u, t}")
EOF

    if [ "$FIRST_RUN" = "1" ]; then
        log "本月已用: \$used_gb GB, 今日已用: \$today_gb GB"
        FIRST_RUN="0"
    fi

    # 当日流量检测
    if [ "$DAILY_LIMIT" != "0" ] && [ -n "$DAILY_LIMIT" ]; then
        if awk "BEGIN{exit (\$today_gb >= \$DAILY_LIMIT) ? 0 : 1}"; then
            last_notify_day=\$(awk '{print}' "$DATA_DIR/notified_today.txt" 2>/dev/null)
            if [ "\$last_notify_day" != "\$cur_day" ]; then
                log "[提醒] 今日已用 \$today_gb GB，超过设定限额 \$DAILY_LIMIT GB"
                MSG_FLOW_DAY="当日已使用流量超过设定阈值\${DAILY_LIMIT}g，实际使用\${today_gb}g"
            fi
        fi
    fi

    # 当月流量检测
    if [ "$MONTHLY_LIMIT" != "0" ] && [ -n "$MONTHLY_LIMIT" ]; then
        if awk "BEGIN{exit (\$used_gb >= \$MONTHLY_LIMIT) ? 0 : 1}"; then
            last_notify_month=\$(awk '{print}' "$DATA_DIR/notified_month.txt" 2>/dev/null)
            if [ "\$last_notify_month" != "\$cur_month" ]; then
                log "[提醒] 本月已用 \$used_gb GB，超过设定限额 \$MONTHLY_LIMIT GB"
                MSG_FLOW_MONTH="当月已使用流量超过设定阈值\${MONTHLY_LIMIT}g，实际使用\${used_gb}g"
            fi
        fi
    fi
}

while true; do
    cur_day=\$(date +%Y-%m-%d)
    cur_month=\$(date +%Y-%m)
    MSG_FLOW_DAY=""
    MSG_FLOW_MONTH=""
    MSG_TEMP=""
    
    check_flow
    check_temp
    
    # —— 核心：合并通知发送逻辑 ——
    FINAL_MSG=""
    
    [ -n "\$MSG_FLOW_DAY" ] && FINAL_MSG="\$MSG_FLOW_DAY"
    
    if [ -n "\$MSG_FLOW_MONTH" ]; then
        [ -n "\$FINAL_MSG" ] && FINAL_MSG="\${FINAL_MSG}\\\\n\\\\n"
        FINAL_MSG="\${FINAL_MSG}\${MSG_FLOW_MONTH}"
    fi

    if [ -n "\$MSG_TEMP" ]; then
        [ -n "\$FINAL_MSG" ] && FINAL_MSG="\${FINAL_MSG}\\\\n\\\\n"
        FINAL_MSG="\${FINAL_MSG}\${MSG_TEMP}"
    fi

    if [ -n "\$FINAL_MSG" ]; then
        # 统一发一次合并消息
        notify "\$FINAL_MSG"
        
        # 发送成功后才修改标记位，避免重复通知
        [ -n "\$MSG_FLOW_DAY" ] && printf '%s' "\$cur_day" > "$DATA_DIR/notified_today.txt"
        [ -n "\$MSG_FLOW_MONTH" ] && printf '%s' "\$cur_month" > "$DATA_DIR/notified_month.txt"
        [ -n "\$MSG_TEMP" ] && printf '%s' "\$cur_day" > "$DATA_DIR/notified_temp_today.txt"
    fi

    sleep "$CHECK_INTERVAL"
done
`;
    };

    // ─── helpers ──────────────────────────────────────────────────────────────
    const killProcessByName = async () => {
        await run(`pkill -f ${sq(SH_FILE)} 2>/dev/null; sleep 1; pkill -9 -f ${sq(SH_FILE)} 2>/dev/null`);
    };

    const syncApiSnapshot = async () => {
        try {
            const data = await getUFIData();
            if (!data) return false;
            const monthly = data.monthly_data;
            const daily = data.daily_data;
            if (monthly == null) return false;
            const sysfsRes = await run(`
for iface in $(ls /sys/class/net/ 2>/dev/null); do
    case "$iface" in lo|br0|wlan0|ap0|swlan0|dummy*|ifb*|tunl*|gre*|sit*|ip6*|erspan*|ip_vti*) continue;; esac
    ip addr show dev "$iface" 2>/dev/null | grep -q "inet " || continue
    rx=$(awk '{print}' "/sys/class/net/$iface/statistics/rx_bytes" 2>/dev/null)
    [ "\${rx:-0}" != "0" ] && { awk 'NR==1{r=$0}NR==2{print r+$0}' "/sys/class/net/$iface/statistics/rx_bytes" "/sys/class/net/$iface/statistics/tx_bytes" 2>/dev/null; exit; }
done; echo 0`, 3000);
            const sysfs = String(sysfsRes?.content || '0').trim();
            const day = new Date().toISOString().slice(0, 10);
            const month = day.slice(0, 7).replace('-', '');
            await run(`mkdir -p ${sq(DATA_DIR)} && printf '%s' ${sq(`${monthly} ${daily} ${sysfs} ${day} ${month}`)} > ${sq(DATA_DIR + '/api_snapshot.txt')}`);
            return true;
        } catch { return false; }
    };

    // ─── config read/write ────────────────────────────────────────────────────
    const saveToLocalStorage = () => {
        localStorage.setItem(LS_KEY + 'dailyLimit', String(state.config.dailyLimit));
        localStorage.setItem(LS_KEY + 'monthlyLimit', String(state.config.monthlyLimit));
        localStorage.setItem(LS_KEY + 'tempLimit', String(state.config.tempLimit));
        localStorage.setItem(LS_KEY + 'pushPlusToken', String(state.config.pushPlusToken || ''));
    };

    const readStatus = async () => {
        const result = await run(`
echo __CONFIG__
timeout 2s awk '{print}' ${sq(CONFIG_FILE)} 2>/dev/null || true
echo __BOOT__
timeout 2s awk '{print}' ${sq(BOOT_SH_FILE)} 2>/dev/null || true
`);
        const text = String(result?.content || '');
        const configPart = text.includes('__CONFIG__') ? text.split('__CONFIG__')[1].split('__BOOT__')[0] : '';
        const bootPart = text.includes('__BOOT__') ? text.split('__BOOT__')[1] : '';

        if (configPart.trim()) {
            try {
                const parsed = JSON.parse(configPart.trim());
                if (parsed.dailyLimit !== undefined) state.config.dailyLimit = parsed.dailyLimit;
                if (parsed.monthlyLimit !== undefined) state.config.monthlyLimit = parsed.monthlyLimit;
                if (parsed.tempLimit !== undefined) state.config.tempLimit = parsed.tempLimit;
                if (parsed.pushPlusToken !== undefined) state.config.pushPlusToken = parsed.pushPlusToken;
                saveToLocalStorage();
            } catch { /* ignore parse errors */ }
        }
        state.installed = bootPart.includes(NAME);
    };

    // 分别检查各项报警是否需要重置
    const checkResetState = async () => {
        const res = await run(`
            d=$(date +%Y-%m-%d)
            m=$(date +%Y-%m)
            f1=$(cat ${sq(DATA_DIR + '/notified_today.txt')} 2>/dev/null)
            f2=$(cat ${sq(DATA_DIR + '/notified_temp_today.txt')} 2>/dev/null)
            f3=$(cat ${sq(DATA_DIR + '/notified_month.txt')} 2>/dev/null)
            r1=0; r2=0; r3=0
            [ "$d" = "$f1" ] && r1=1
            [ "$d" = "$f2" ] && r2=1
            [ "$m" = "$f3" ] && r3=1
            echo "$r1 $r2 $r3"
        `);
        const parts = String(res?.content || '').trim().split(' ');
        state.needsResetFlowDay = parts[0] === '1';
        state.needsResetTemp = parts[1] === '1';
        state.needsResetFlowMonth = parts[2] === '1';
    };

    // 动态更新三处重置按钮的UI颜色
    const updateResetButtonUI = () => {
        const updateBtn = (selector, needReset) => {
            const btn = document.querySelector(selector);
            if (btn) {
                if (needReset) {
                    btn.classList.remove('fg-btn-ghost');
                    btn.classList.add('fg-btn-danger'); // 红色
                } else {
                    btn.classList.remove('fg-btn-danger');
                    btn.classList.add('fg-btn-ghost'); // 灰色
                }
            }
        };
        updateBtn('[data-act="clear-flow-day-state"]', state.needsResetFlowDay);
        updateBtn('[data-act="clear-flow-month-state"]', state.needsResetFlowMonth);
        updateBtn('[data-act="clear-temp-state"]', state.needsResetTemp);
    };

    // ─── install / uninstall ──────────────────────────────────────────────────
    const install = async () => {
        try {
            if (!(await checkAdvancedFunc())) return createToast('没有开启高级功能，无法使用！', 'red');
            saveToLocalStorage();
            const cfgObj = {
                dailyLimit: state.config.dailyLimit,
                monthlyLimit: state.config.monthlyLimit,
                tempLimit: state.config.tempLimit,
                pushPlusToken: state.config.pushPlusToken,
            };
            const cfgJson = JSON.stringify(cfgObj, null, 2);
            await run(`timeout 2s printf '%s' ${sq(cfgJson)} > ${sq(CONFIG_FILE)}`);
            // 每次重新启用或保存配置时，自动清理标记，使其处于可触发状态
            await run(`rm -f ${sq(DATA_DIR + '/sysfs_carry.txt')} ${sq(DATA_DIR + '/sysfs_last.txt')} ${sq(DATA_DIR + '/notified_today.txt')} ${sq(DATA_DIR + '/notified_temp_today.txt')} ${sq(DATA_DIR + '/notified_month.txt')}`);
            const snapOk = await syncApiSnapshot();
            if (!snapOk) createToast('API快照写入失败，数据可能不准确', 'pink', 4000);
            if (!(await saveConfig(new File([genScript()], 'flow_guard.sh', { type: 'text/plain' }), SH_FILE))) {
                return createToast('上传脚本文件失败！', 'red');
            }
            await run(`chmod 755 ${sq(SH_FILE)}`);
            await run(`grep -qxF ${sq(BOOT_LINE)} ${sq(BOOT_SH_FILE)} || echo ${sq(BOOT_LINE)} >> ${sq(BOOT_SH_FILE)}`);
            await killProcessByName();
            await run(`/system/bin/sh ${sq(SH_FILE)} &`);
            state.installed = true;
            await checkResetState();
            updateResetButtonUI();
        } catch (e) {
            console.error("Install Error:", e);
            createToast('发生未知错误，请查看控制台: ' + e.message, 'red');
        }
    };

    const uninstall = async () => {
        if (!(await checkAdvancedFunc())) return createToast('没有开启高级功能，无法使用！', 'red');
        await run(`sed -i '/${NAME}/d' ${sq(BOOT_SH_FILE)}`);
        await run(`rm -rf ${sq(CONFIG_FILE)} ${sq(SH_FILE)} ${sq(LOG_FILE)} ${sq(DATA_DIR)}`);
        await killProcessByName();
        state.installed = false;
        state.needsResetFlowDay = false;
        state.needsResetFlowMonth = false;
        state.needsResetTemp = false;
        updateResetButtonUI();
        createToast('设备状态守护已停用');
    };

    // ─── log ──────────────────────────────────────────────────────────────────
    let logLoading = false;
    const loadLog = async () => {
        const logEl = document.querySelector('#fg_log');
        if (!logEl || logLoading) return;
        logLoading = true;
        try {
            const result = await run(`[ -f ${sq(LOG_FILE)} ] && timeout 2s tail -50 ${sq(LOG_FILE)} || echo "(暂无日志)"`, 5000);
            logEl.value = String(result?.content ?? '').trim();
            logEl.scrollTop = logEl.scrollHeight;
        } finally {
            logLoading = false;
        }
    };

    const stopAutoLog = () => {
        if (state.autoLogTimer) clearInterval(state.autoLogTimer);
        state.autoLogTimer = null;
    };

    const setAutoLog = (enabled) => {
        state.autoLog = Boolean(enabled && state.installed);
        stopAutoLog();
        if (state.autoLog) {
            state.autoLogTimer = setInterval(async () => {
                if (!document.querySelector(`#${MODAL}`) || !state.installed || !state.autoLog) {
                    setAutoLog(false);
                    return;
                }
                await loadLog();
                // 动态检查是否需要更新重置按钮颜色
                const oldFD = state.needsResetFlowDay;
                const oldFM = state.needsResetFlowMonth;
                const oldTemp = state.needsResetTemp;
                await checkResetState();
                if (oldFD !== state.needsResetFlowDay || oldFM !== state.needsResetFlowMonth || oldTemp !== state.needsResetTemp) {
                    updateResetButtonUI();
                }
            }, 2000);
        }
        syncAutoLogButton();
    };

    const syncAutoLogButton = () => {
        const btn = document.querySelector('#fg_auto_log');
        if (btn) btn.textContent = state.autoLog ? '停止自动刷新' : '自动刷新';
    };

    // ─── style ────────────────────────────────────────────────────────────────
    const ensureStyle = () => {
        if (document.getElementById(STYLE)) return;
        const s = document.createElement('style');
        s.id = STYLE;
        s.textContent = `
      #${MODAL} .fg-wrap{display:flex;flex-direction:column;gap:8px;font-size:.74rem;}
      #${MODAL} .fg-card{border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border-radius:14px;padding:10px 12px;}
      #${MODAL} .fg-row{display:flex;align-items:center;gap:6px;}
      #${MODAL} .fg-label{font-size:.65rem;opacity:.6;min-width:4.5em;flex-shrink:0;}
      #${MODAL} .fg-input{padding:5px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.18);color:inherit;font-size:.72rem;outline:none;box-sizing:border-box;width:55px;text-align:center;}
      #${MODAL} .fg-input:focus{border-color:rgba(77,219,138,.5);}
      #${MODAL} .fg-input:disabled{opacity:.35;}
      #${MODAL} .fg-unit{font-size:.6rem;opacity:.45;flex-shrink:0;}
      #${MODAL} .fg-divider{height:1px;background:rgba(255,255,255,.06);margin:6px 0;}
      #${MODAL} .fg-form-row{display:flex;align-items:center;gap:6px;min-height:28px;}
      #${MODAL} .fg-btn{border-radius:8px;padding:6px 12px;font-size:.68rem;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:inherit;transition:background .15s,opacity .15s;}
      #${MODAL} .fg-btn:hover{background:rgba(255,255,255,.14);}
      #${MODAL} .fg-btn:disabled{opacity:.35;cursor:not-allowed;}
      #${MODAL} .fg-btn-success{background:rgba(34,197,94,.22);border-color:rgba(34,197,94,.35);color:#86efac;}
      #${MODAL} .fg-btn-success:hover{background:rgba(34,197,94,.35);}
      #${MODAL} .fg-btn-stop{background:rgba(249,115,22,.22);border-color:rgba(249,115,22,.35);color:#fdba74;}
      #${MODAL} .fg-btn-stop:hover{background:rgba(249,115,22,.35);}
      #${MODAL} .fg-btn-danger{background:rgba(239,68,68,.22);border-color:rgba(239,68,68,.35);color:#fca5a5;}
      #${MODAL} .fg-btn-danger:hover{background:rgba(239,68,68,.35);}
      #${MODAL} .fg-btn-ghost{background:transparent;border-color:rgba(255,255,255,.12);opacity:.8;}
      #${MODAL} .fg-btn-ghost:hover{opacity:1;background:rgba(255,255,255,.06);}
      #${MODAL} .fg-btn-primary{background:rgba(59,130,246,.22);border-color:rgba(59,130,246,.35);color:#93c5fd;}
      #${MODAL} .fg-btn-primary:hover{background:rgba(59,130,246,.35);}
      #${MODAL} .fg-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;vertical-align:middle;}
      #${MODAL} .fg-dot-green{background:#4ade80;box-shadow:0 0 4px rgba(74,222,128,.5);}
      #${MODAL} .fg-help{font-size:.6rem;line-height:1.5;opacity:.45;padding:2px 0;}
      #${MODAL} .fg-log{border:none;box-sizing:border-box;width:100%;min-height:120px;font-size:.62rem;background:rgba(0,0,0,.3);color:#ccc;border-radius:8px;padding:6px;resize:vertical;}
      @media (max-width:720px){#${MODAL}{width:95%!important;}}
    `;
        document.head.appendChild(s);
    };

    // ─── render ───────────────────────────────────────────────────────────────
    const render = () => {
        const cfg = state.config;
        const installed = state.installed;
        const toggleCls = installed ? 'fg-btn-success' : 'fg-btn-ghost';
        const toggleTxt = installed
            ? `<span class="fg-dot fg-dot-green"></span>运行中`
            : `<span class="fg-dot" style="background:rgba(255,255,255,.3);box-shadow:none;"></span>已停止`;
        return `
      <div class="fg-wrap">
        <div class="fg-card">
          <div class="fg-row" style="justify-content:space-between;margin-bottom:4px">
            <span style="font-size:.72rem;font-weight:600">报警设置</span>
            <button class="fg-btn ${toggleCls}" data-act="toggle">${toggleTxt}</button>
          </div>
          <div class="fg-help">配置通知触发阈值，合并推送至微信</div>
          <div class="fg-divider"></div>
          
          <div class="fg-form-row">
            <span class="fg-label">当日限额</span>
            <input class="fg-input" data-field="dailyLimit" type="number" step="0.1" min="0" value="${esc(cfg.dailyLimit)}">
            <span class="fg-unit">GB 超过后通知 (0为关闭)</span>
            <button class="fg-btn ${state.needsResetFlowDay ? 'fg-btn-danger' : 'fg-btn-ghost'}" style="padding:4px 8px;font-size:0.6rem;margin-left:auto;" data-act="clear-flow-day-state">重置状态</button>
          </div>
          
          <div class="fg-form-row">
            <span class="fg-label">当月限额</span>
            <input class="fg-input" data-field="monthlyLimit" type="number" step="0.1" min="0" value="${esc(cfg.monthlyLimit)}">
            <span class="fg-unit">GB 超过后通知 (0为关闭)</span>
            <button class="fg-btn ${state.needsResetFlowMonth ? 'fg-btn-danger' : 'fg-btn-ghost'}" style="padding:4px 8px;font-size:0.6rem;margin-left:auto;" data-act="clear-flow-month-state">重置状态</button>
          </div>
          
          <div class="fg-form-row">
            <span class="fg-label">温度限额</span>
            <input class="fg-input" data-field="tempLimit" type="number" step="1" min="0" value="${esc(cfg.tempLimit)}">
            <span class="fg-unit">℃ 超过后通知 (0为关闭)</span>
            <button class="fg-btn ${state.needsResetTemp ? 'fg-btn-danger' : 'fg-btn-ghost'}" style="padding:4px 8px;font-size:0.6rem;margin-left:auto;" data-act="clear-temp-state">重置状态</button>
          </div>
          
          <div class="fg-divider"></div>
          <div class="fg-form-row">
            <span class="fg-label">PushPlus</span>
            <input class="fg-input" style="flex:1;width:auto;text-align:left;" data-field="pushPlusToken" type="text" value="${esc(cfg.pushPlusToken || '')}" placeholder="填写您的 Token">
          </div>
          <div class="fg-row" style="justify-content:flex-end;margin-top:8px;">
             <button class="fg-btn fg-btn-primary" data-act="save-config">保存配置</button>
          </div>
        </div>

        <div class="fg-card">
          <div class="fg-row" style="justify-content:space-between;margin-bottom:6px;">
            <b>运行日志</b>
            <span class="fg-row">
              <button id="fg_auto_log" class="fg-btn fg-btn-ghost" ${installed ? '' : 'disabled'}>${state.autoLog ? '停止自动刷新' : '自动刷新'}</button>
              <button data-act="clear-log" class="fg-btn fg-btn-ghost">清空</button>
              <button data-act="refresh-log" class="fg-btn fg-btn-ghost">刷新</button>
            </span>
          </div>
          <textarea id="fg_log" class="fg-log" readonly></textarea>
        </div>
      </div>
    `;
    };

    // ─── bind ─────────────────────────────────────────────────────────────────
    const syncStateFromForm = () => {
        const root = document.querySelector(`#${MODAL}`);
        if (!root) return;
        const dailyLimitInput = root.querySelector('[data-field="dailyLimit"]');
        const monthlyLimitInput = root.querySelector('[data-field="monthlyLimit"]');
        const tempLimitInput = root.querySelector('[data-field="tempLimit"]');
        const pushPlusTokenInput = root.querySelector('[data-field="pushPlusToken"]');
        
        if (dailyLimitInput) {
            const num = parseFloat(dailyLimitInput.value);
            if (!isNaN(num) && num >= 0) state.config.dailyLimit = num;
        }
        if (monthlyLimitInput) {
            const num = parseFloat(monthlyLimitInput.value);
            if (!isNaN(num) && num >= 0) state.config.monthlyLimit = num;
        }
        if (tempLimitInput) {
            const num = parseInt(tempLimitInput.value, 10);
            if (!isNaN(num) && num >= 0) state.config.tempLimit = num;
        }
        if (pushPlusTokenInput) {
            state.config.pushPlusToken = pushPlusTokenInput.value.trim();
        }
        saveToLocalStorage();
    };

    const renderIntoModal = async () => {
        const box = document.querySelector(`#${MODAL} .content`);
        if (!box) return;
        box.innerHTML = render();
        bind(document.querySelector(`#${MODAL}`));
        syncAutoLogButton();
        await loadLog();
    };

    const bind = (el) => {
        if (!el) return;
        
        // 启用 / 停用 按钮
        el.querySelector('[data-act="toggle"]').onclick = async () => {
            syncStateFromForm();
            if (state.installed) {
                await uninstall();
            } else {
                await install();
                if (state.installed) {
                    createToast('设备状态守护已启用，后台运行中');
                }
            }
            await renderIntoModal();
            if (state.installed) setAutoLog(true);
        };
        
        // 保存配置 按钮
        el.querySelector('[data-act="save-config"]').onclick = async () => {
            syncStateFromForm();
            if (state.installed) {
                await install(); // 如果已启用，则热重启应用新配置
                if (state.installed) {
                    createToast('配置已保存并生效');
                }
            } else {
                createToast('配置已保存，请手动启动');
            }
        };

        // 清空日志 按钮
        el.querySelector('[data-act="clear-log"]').onclick = async () => {
            await run(`> ${sq(LOG_FILE)}`);
            await loadLog();
            createToast('日志已清空');
        };

        // 重置当日流量报警状态 按钮
        el.querySelector('[data-act="clear-flow-day-state"]').onclick = async () => {
            await run(`rm -f ${sq(DATA_DIR + '/notified_today.txt')}`);
            state.needsResetFlowDay = false;
            updateResetButtonUI();
            createToast('当日流量报警状态已重置');
        };

        // 重置当月流量报警状态 按钮
        el.querySelector('[data-act="clear-flow-month-state"]').onclick = async () => {
            await run(`rm -f ${sq(DATA_DIR + '/notified_month.txt')}`);
            state.needsResetFlowMonth = false;
            updateResetButtonUI();
            createToast('当月流量报警状态已重置');
        };

        // 重置温度报警状态 按钮
        el.querySelector('[data-act="clear-temp-state"]').onclick = async () => {
            await run(`rm -f ${sq(DATA_DIR + '/notified_temp_today.txt')}`);
            state.needsResetTemp = false;
            updateResetButtonUI();
            createToast('温度报警状态已重置');
        };
        
        el.querySelector('[data-act="refresh-log"]').onclick = loadLog;
        el.querySelector('#fg_auto_log').onclick = () => setAutoLog(!state.autoLog);

        el.querySelectorAll('[data-field]').forEach((input) => {
            const event = input.type === 'number' ? 'input' : 'change';
            input.addEventListener(event, () => syncStateFromForm());
        });
    };

    // ─── help ──────────────────────────────────────────────────────────────
    const HELP_TEXT = `<b>功能说明</b><br>后台每 60 秒检测一次数据，当“限额”或“温度”超标时，将自动通过 PushPlus 向微信推送合并消息提醒。<br><br><b>使用配置说明</b><br>在下方填入 PushPlus 的 Token。<br>任意限额填写 <b>0</b> 即代表关闭该项的检测。<br>修改参数后请点击【保存配置】，如果当前状态是运行中的，它将自动热重启使配置生效。<br><br><b>报警锁定规则</b><br>为避免刷屏，每项报警触发后会被锁定：<br>· 当日流量/温度：次日凌晨自动重置。<br>· 当月流量：次月 1 号自动重置。<br>若某项已触发报警，其对应的按钮会变红，您可以随时点击红色的【重置状态】手动清除锁定，使其能立刻再次报警。`;

    const showHelp = () => {
        const { el, close } = createFixedToast('fg_help_toast', `
            <div style="pointer-events:all;width:80vw;max-width:300px">
                <div class="title" style="margin:0">使用说明</div>
                <div style="margin:10px 0;font-size:.68rem;line-height:1.6">${HELP_TEXT}</div>
                <div style="text-align:right">
                    <button style="font-size:.64rem" id="fg_help_dismiss">关闭</button>
                </div>
            </div>`);
        el.querySelector('#fg_help_dismiss').onclick = () => close();
    };

    const injectHelpButton = (modalEl) => {
        const titleSpan = modalEl.querySelector('.title > span');
        if (!titleSpan) return;
        const helpBtn = document.createElement('button');
        helpBtn.textContent = '?';
        helpBtn.style.cssText = 'width:16px;height:16px;border-radius:50%;padding:0;font-size:.5rem;line-height:16px;text-align:center;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);margin-left:8px;vertical-align:middle;flex-shrink:0;';
        helpBtn.onclick = (e) => { e.stopPropagation(); showHelp(); };
        titleSpan.appendChild(helpBtn);
    };

    // ─── mount ────────────────────────────────────────────────────────────────
    const openModal = async () => {
        ensureStyle();
        const { close: closeLoading } = createFixedToast('fg_loading', '初始化中...');
        document.querySelector(`#${MODAL}`)?.remove();
        await readStatus();
        await checkResetState(); // 动态检测是否需要重置
        const { id, el } = createModal({
            name: MODAL,
            title: '设备状态守护',
            maxWidth: '420px',
            contentStyle: 'max-height: 72vh;',
            showConfirm: false,
            onClose: () => {
                setAutoLog(false);
                return true;
            },
            content: render(),
        });
        bind(el);
        injectHelpButton(el);
        showModal(id);
        await loadLog();
        setAutoLog(state.installed);
        closeLoading();
    };

    const mainBtn = document.createElement('button');
    mainBtn.textContent = '设备状态守护';
    mainBtn.onclick = openModal;
    document.querySelector('.actions-buttons')?.appendChild(mainBtn);

})();
//</script>