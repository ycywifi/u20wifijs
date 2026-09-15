#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FM_U20 (Seekwave SV6160) 蓝牙 HAL 补件提取器
=============================================
用法:
    python3 find_bt_hal.py <固件解压目录> [更多目录...]
    python3 find_bt_hal.py ~/Downloads/rom_extracted
    python3 find_bt_hal.py dir1 dir2 --out ./output

功能:
  1. 递归搜索三件套 (service / impl.so / libbt-vendor.so)
  2. 用 ELF header 判定架构 (32位 ARM / 64位 ARM64 / x86 等)
  3. 校验 libbt-vendor.so 是否含 BLUETOOTH_VENDOR_LIB_INTERFACE 特征
  4. 自动装配成 Magisk 模块目录并打包 zip

设备约束:
  FM_U20 / MN901UFI, 展锐 T158 (ums9621), Android 13
  系统为 32 位 (abilist = armeabi-v7a,armeabi)
  32 位路线: 直接可用
  64 位路线: 需先装 t158_arm64_native_runtime 模块
"""

import os
import sys
import re
import zipfile
import shutil
import struct
import argparse

# ---------------------------------------------------------------- ELF 判定
EM_ARM = 40
EM_AARCH64 = 183
EM_386 = 3
EM_X86_64 = 62

MACHINE = {
    EM_ARM: "32-bit ARM",
    EM_AARCH64: "64-bit ARM64",
    EM_386: "32-bit x86",
    EM_X86_64: "64-bit x86",
}

# 32位 ELF: class=1(ELFCLASS32); 64位 ELF: class=2(ELFCLASS64)
ELFCLASS32 = 1
ELFCLASS64 = 2

# 一些固件里 .so 会被打包进 img/apk/zip，这里先只处理普通文件
def read_elf_info(path):
    """返回 (elfclass, machine, is_elf)"""
    try:
        with open(path, "rb") as f:
            head = f.read(64)
        if len(head) < 20 or head[:4] != b"\x7fELF":
            return None, None, False
        elfclass = head[4]
        # e_machine 偏移: 32位=18, 64位=18 (同样位置，2字节 LE)
        machine = struct.unpack_from("<H", head, 18)[0]
        return elfclass, machine, True
    except Exception:
        return None, None, False


def arch_label(elfclass, machine):
    if machine in (EM_ARM, EM_AARCH64, EM_386, EM_X86_64):
        base = MACHINE[machine]
    else:
        base = "unknown(machine=%d)" % machine
    return base


def is_arm32(elfclass, machine):
    return elfclass == ELFCLASS32 and machine == EM_ARM


def is_arm64(elfclass, machine):
    return elfclass == ELFCLASS64 and machine == EM_AARCH64


# ---------------------------------------------------------------- 搜索目标
# 三件套的命名变体
PATTERNS = {
    "service": [
        r"^android\.hardware\.bluetooth@1\.[01]-service.*$",
        r"^android\.hardware\.bluetooth@1\.[01]-service$",
        r"^bluetooth@1\.[01]-service.*$",
    ],
    "impl": [
        r"^android\.hardware\.bluetooth@1\.[01]-impl.*\.so$",
        r"^android\.hardware\.bluetooth@1\.[01]-impl\.so$",
        r"^bluetooth@1\.[01]-impl.*\.so$",
    ],
    "vendorlib": [
        r"^libbt-vendor.*\.so$",
        r"^libbt_vendor.*\.so$",
        r"^libbt-sprd-vendor.*\.so$",
        r"^libbt-sprd.*\.so$",
    ],
}

# 相关的附属库（找到就一并带上，往往必需）
EXTRA_LIBS = [
    r"^libbt-.*\.so$",
    r"^libbtcore.*\.so$",
    r"^libbthost.*\.so$",
    r"^libskw.*\.so$",
    r"^libseekwave.*\.so$",
]

VENDOR_SYMBOL = b"BLUETOOTH_VENDOR_LIB_INTERFACE"


def check_vendor_symbol(path):
    """libbt-vendor.so 应含有 BLUETOOTH_VENDOR_LIB_INTERFACE 字符串"""
    try:
        with open(path, "rb") as f:
            data = f.read()
        return VENDOR_SYMBOL in data
    except Exception:
        return False


def scan_dirs(roots, verbose=True):
    found = {"service": [], "impl": [], "vendorlib": [], "extra": []}
    scanned = 0

    for root in roots:
        root = os.path.expanduser(root)
        if not os.path.exists(root):
            print("  [!] 跳过不存在的目录: %s" % root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            # 跳过明显无关的巨大目录，提速
            dirnames[:] = [
                d for d in dirnames
                if d not in (".git", "node_modules", "__pycache__")
            ]
            for fn in filenames:
                scanned += 1
                full = os.path.join(dirpath, fn)

                matched_kind = None
                for kind, pats in PATTERNS.items():
                    for p in pats:
                        if re.match(p, fn, re.IGNORECASE):
                            matched_kind = kind
                            break
                    if matched_kind:
                        break

                if matched_kind is None:
                    for p in EXTRA_LIBS:
                        if re.match(p, fn, re.IGNORECASE):
                            matched_kind = "extra"
                            break

                if matched_kind is None:
                    continue

                elfclass, machine, is_elf = read_elf_info(full)
                if not is_elf:
                    continue

                item = {
                    "path": full,
                    "name": fn,
                    "elfclass": elfclass,
                    "machine": machine,
                    "arch": arch_label(elfclass, machine),
                    "size": os.path.getsize(full),
                }

                if matched_kind == "vendorlib":
                    item["has_symbol"] = check_vendor_symbol(full)

                found[matched_kind].append(item)

    if verbose:
        print("  扫描文件数: %d" % scanned)
    return found


# ---------------------------------------------------------------- 展示
def show(title, items):
    print("\n" + "=" * 62)
    print("  " + title)
    print("=" * 62)
    if not items:
        print("  (无)")
        return
    for it in items:
        mark = ""
        if "has_symbol" in it:
            mark = "  [符号OK]" if it["has_symbol"] else "  [无特征符号-存疑]"
        print("  %-46s %-14s %8d B%s" % (it["name"], it["arch"], it["size"], mark))
        print("      %s" % it["path"])


# ---------------------------------------------------------------- 装配模块
MODULE_ID = "FMU20_BT_HALRestore"

SERVICE_RC_11 = """service vendor.bluetooth-1-1 /vendor/bin/hw/android.hardware.bluetooth@1.1-service
    class hal
    user bluetooth
    group bluetooth oem_2901 wakelock
    capabilities BLOCK_SUSPEND NET_ADMIN SYS_NICE
    interface android.hardware.bluetooth@1.1::IBluetoothHci default
"""

SERVICE_RC_10 = """service vendor.bluetooth-1-0 /vendor/bin/hw/android.hardware.bluetooth@1.0-service
    class hal
    user bluetooth
    group bluetooth oem_2901 wakelock
    capabilities BLOCK_SUSPEND NET_ADMIN SYS_NICE
    interface android.hardware.bluetooth@1.0::IBluetoothHci default
"""

SERVICE_SH = r"""#!/system/bin/sh
# FM_U20 BT HAL Restore - auto generated
MODDIR=${0%/*}
LOG=$MODDIR/bthal.log
exec >> $LOG 2>&1

echo ""
echo "######## BT HAL Restore $(date '+%F %T') ########"

i=0
while [ "$(getprop sys.boot_completed)" != "1" ] && [ "$i" -lt 40 ]; do
    i=$((i+1)); sleep 2
done
sleep 2

# 授权 Seekwave BT 字符设备
for node in /dev/BTCMD /dev/BTDATA /dev/BTAUDIO /dev/BTBOOT /dev/BTISOC; do
    [ -e "$node" ] && chmod 666 "$node" 2>/dev/null
done

# 优先 1.1，回退 1.0
for SVCTAG in vendor.bluetooth-1-1 vendor.bluetooth-1-0; do
    if [ -f "$MODDIR/service_tag" ]; then
        SVCTAG=$(cat "$MODDIR/service_tag")
    fi
    break
done

echo "target service: $SVCTAG"
setprop ctl.start "$SVCTAG" 2>/dev/null
sleep 3

# ctl.start 无效时直接执行二进制
if ! getprop init.svc."$SVCTAG" | grep -qE 'running|restarting'; then
    BIN=""
    for c in /vendor/bin/hw/android.hardware.bluetooth@1.1-service \
             /vendor/bin/hw/android.hardware.bluetooth@1.0-service; do
        [ -x "$c" ] && BIN="$c" && break
    done
    if [ -n "$BIN" ]; then
        echo "ctl.start 无效，直接执行 $BIN"
        LD_LIBRARY_PATH=/vendor/lib64:/vendor/lib:/system/lib64:/system/lib \
            nohup "$BIN" >> $LOG 2>&1 &
    fi
fi

# 等待 HAL 注册（成功判据：hwservicemanager 注册，不是 hci0）
OK=0
n=0
while [ "$n" -lt 60 ]; do
    n=$((n+1))
    if lshal list 2>/dev/null | grep -q 'bluetooth@1'; then OK=1; break; fi
    if service list 2>/dev/null | grep -qi 'bluetooth'; then
        if lshal list 2>/dev/null | grep -q 'bluetooth@1'; then OK=1; break; fi
    fi
    if ! getprop init.svc."$SVCTAG" | grep -qE 'running|restarting'; then
        setprop ctl.start "$SVCTAG" 2>/dev/null
    fi
    sleep 2
done

echo "waited $((n*2))s"
echo "init.svc.$SVCTAG = $(getprop init.svc.$SVCTAG)"
echo "lshal: $(lshal list 2>/dev/null | grep -i 'bluetooth@1' | head -3)"
echo "ps   : $(ps -A 2>/dev/null | grep -i bluetooth | head -3 | tr '\n' ';')"

if [ "$OK" = "1" ]; then
    echo "===== HAL 已注册 ====="
    echo '{"ok":true}' > $MODDIR/status
else
    echo "===== HAL 未注册，检查上面的 dlopen / 依赖错误 ====="
    echo "提示: 若日志出现 'dlopen failed' / 'cannot locate symbol', 说明缺依赖库"
    echo '{"ok":false}' > $MODDIR/status
fi
"""

POST_FS_DATA = r"""#!/system/bin/sh
MODDIR=${0%/*}
exec >> $MODDIR/bthal.log 2>&1
echo "=== post-fs-data $(date '+%F %T') ==="

for f in "$MODDIR"/system/vendor/bin/hw/* "$MODDIR"/system/vendor/lib*/*.so \
         "$MODDIR"/system/vendor/lib*/hw/*.so; do
    [ -e "$f" ] || continue
    case "$f" in *.txt) continue ;; esac
    chcon u:object_r:vendor_file:s0 "$f" 2>/dev/null
    case "$f" in
        */bin/hw/*) chmod 0755 "$f" 2>/dev/null ;;
        *)          chmod 0644 "$f" 2>/dev/null ;;
    esac
done

for node in /dev/BTCMD /dev/BTDATA /dev/BTAUDIO /dev/BTBOOT /dev/BTISOC; do
    [ -e "$node" ] && chmod 666 "$node" 2>/dev/null
done

for d in /data/misc/bluetooth /data/misc/bluetooth/logs /data/misc/bluedroid; do
    [ -d "$d" ] || mkdir -p "$d" 2>/dev/null
    chown bluetooth:bluetooth "$d" 2>/dev/null
    chmod 770 "$d" 2>/dev/null
done

setprop persist.bluetooth.btsnooplogmode full 2>/dev/null
setprop persist.bluetooth.btsnoopdefaultmode enabled 2>/dev/null
echo "=== done ==="
"""

SEPOLICY = """# auto generated
allow hal_bluetooth_default ucom_device chr_file { read write open ioctl getattr }
allow hal_bluetooth_default bt_device chr_file { read write open ioctl getattr }
allow hal_bluetooth_default device chr_file { read write open ioctl getattr }
allow hal_bluetooth_default tty_device chr_file { read write open ioctl getattr }
allow hal_bluetooth_default firmware_file dir { read open getattr search }
allow hal_bluetooth_default firmware_file file { read open getattr }
allow hal_bluetooth_default vendor_file file { read open getattr execute }
allow hal_bluetooth_default vendor_file dir { read open getattr search }
allow hal_bluetooth_default hwservicemanager hwservicemanager { add find list get }
allow hal_bluetooth_default hidl_hwservice hwservice_manager { add find }
allow hal_bluetooth_default default_service hwservice_manager { add find }
allow hal_bluetooth_default bluetooth_prop property_service set
allow hal_bluetooth_default bluetooth_prop file { read open getattr }
allow bluetooth ucom_device chr_file { read write open ioctl getattr }
allow bluetooth bt_device chr_file { read write open ioctl getattr }
allow shell hal_bluetooth_default file { read open getattr }
"""

UPDATE_BINARY = r"""#!/sbin/sh
umask 022
OUTFD=$2
ZIPFILE=$3
ui_print() {
    echo "ui_print $1" > /proc/self/fd/$OUTFD
    echo "ui_print" > /proc/self/fd/$OUTFD
}
if [ -f /data/adb/magisk/util_functions.sh ]; then
    . /data/adb/magisk/util_functions.sh
    if command -v install_module >/dev/null 2>&1; then
        install_module
        exit $?
    fi
fi
ui_print "- 兼容模式安装"
MODPATH=/data/adb/modules/MODULE_ID_PLACEHOLDER
TMPDIR=/dev/tmp/bthal_inst
rm -rf "$TMPDIR" "$MODPATH"; mkdir -p "$TMPDIR" "$MODPATH"
unzip -o "$ZIPFILE" -x 'META-INF/*' -d "$TMPDIR" >/dev/null 2>&1
SRC="$TMPDIR"
if [ "$(ls -1 "$TMPDIR" 2>/dev/null | wc -l)" = "1" ] && [ -d "$TMPDIR"/*/ ]; then
    for d in "$TMPDIR"/*/; do SRC="${d%/}"; done
fi
cp -af "$SRC"/* "$MODPATH"/ 2>/dev/null
find "$MODPATH" -type d -exec chmod 0755 {} \; 2>/dev/null
find "$MODPATH" -type f -exec chmod 0644 {} \; 2>/dev/null
for f in post-fs-data.sh service.sh uninstall.sh bt_hal_status.sh; do
    [ -f "$MODPATH/$f" ] && chmod 0755 "$MODPATH/$f"
done
chcon -R u:object_r:system_file:s0 "$MODPATH" 2>/dev/null
restorecon -R "$MODPATH" 2>/dev/null
rm -rf "$TMPDIR"
ui_print "- 完成，请重启"
exit 0
"""

STATUS_SH = r"""#!/system/bin/sh
M=/data/adb/modules/MODULE_ID_PLACEHOLDER
echo "=========== 补件在位 ==========="
find $M/system -type f 2>/dev/null | sed "s|$M/||"
echo ""
echo "=========== 运行时状态 ==========="
echo "lshal    : $(lshal list 2>/dev/null | grep -i 'bluetooth@1' | head -3)"
echo "service  : $(getprop | grep -i 'init.svc.*bluetooth' | tr '\n' ' ')"
echo "进程     : $(ps -A 2>/dev/null | grep -iE 'bluetooth' | head -5)"
echo "BT 节点  : $(ls -l /dev/BT* 2>/dev/null | tr '\n' ';')"
echo ""
echo "=========== 日志尾部 60 行 ==========="
tail -n 60 $M/bthal.log 2>/dev/null || echo "(无日志)"
"""


def build_module(found, out_dir, arch_choice):
    """arch_choice: '32' or '64'"""
    mod_root = os.path.join(out_dir, MODULE_ID)
    if os.path.exists(mod_root):
        shutil.rmtree(mod_root)

    lib_sub = "lib" if arch_choice == "32" else "lib64"
    vbin = os.path.join(mod_root, "system", "vendor", "bin", "hw")
    vlib = os.path.join(mod_root, "system", "vendor", lib_sub)
    vlib_hw = os.path.join(vlib, "hw")
    for d in (vbin, vlib, vlib_hw,
              os.path.join(mod_root, "META-INF", "com", "google", "android")):
        os.makedirs(d, exist_ok=True)

    picked = {}

    def pick(kind):
        items = found.get(kind, [])
        if not items:
            return None
        want = is_arm32 if arch_choice == "32" else is_arm64
        for it in items:
            if want(it["elfclass"], it["machine"]):
                return it
        return None

    svc = pick("service")
    impl = pick("impl")
    vlibso = pick("vendorlib")

    copied = []
    if svc:
        dst = os.path.join(vbin, svc["name"])
        shutil.copy2(svc["path"], dst)
        os.chmod(dst, 0o755)
        picked["service"] = svc["name"]
        copied.append(("service", svc["name"], dst))

    if impl:
        dst = os.path.join(vlib_hw, impl["name"])
        shutil.copy2(impl["path"], dst)
        os.chmod(dst, 0o644)
        picked["impl"] = impl["name"]
        copied.append(("impl", impl["name"], dst))

    if vlibso:
        dst = os.path.join(vlib, vlibso["name"])
        shutil.copy2(vlibso["path"], dst)
        os.chmod(dst, 0o644)
        picked["vendorlib"] = vlibso["name"]
        copied.append(("vendorlib", vlibso["name"], dst))

    # 同名附属库：只要架构匹配就带上
    want = is_arm32 if arch_choice == "32" else is_arm64
    for it in found.get("extra", []):
        if not want(it["elfclass"], it["machine"]):
            continue
        dst = os.path.join(vlib, it["name"])
        if os.path.exists(dst):
            continue
        shutil.copy2(it["path"], dst)
        os.chmod(dst, 0o644)
        copied.append(("extra", it["name"], dst))

    # ---- 生成配套文件 ----
    ver = "1.1" if (impl and "1.1" in impl["name"]) or (svc and "1.1" in svc["name"]) else "1.0"
    tag = "vendor.bluetooth-1-1" if ver == "1.1" else "vendor.bluetooth-1-0"

    with open(os.path.join(mod_root, "module.prop"), "w") as f:
        f.write(
            "id=%s\n"
            "name=FM_U20 Bluetooth HAL Restore (%s-bit)\n"
            "version=v1.2\n"
            "versionCode=120\n"
            "author=Yuanbao (auto generated)\n"
            "description=自动装配的蓝牙 HAL 三件套，架构=%s 位，HAL 版本=%s\n"
            "updateJson=\n" % (MODULE_ID, arch_choice, arch_choice, ver)
        )

    with open(os.path.join(mod_root, "service_tag"), "w") as f:
        f.write(tag + "\n")

    rc_name = "android.hardware.bluetooth@%s-service.rc" % ver
    os.makedirs(os.path.join(mod_root, "system", "vendor", "etc", "init"), exist_ok=True)
    with open(os.path.join(mod_root, "system", "vendor", "etc", "init", rc_name), "w") as f:
        f.write(SERVICE_RC_11 if ver == "1.1" else SERVICE_RC_10)

    with open(os.path.join(mod_root, "post-fs-data.sh"), "w") as f:
        f.write(POST_FS_DATA)
    with open(os.path.join(mod_root, "service.sh"), "w") as f:
        f.write(SERVICE_SH)
    with open(os.path.join(mod_root, "sepolicy.rule"), "w") as f:
        f.write(SEPOLICY)
    with open(os.path.join(mod_root, "bt_hal_status.sh"), "w") as f:
        f.write(STATUS_SH.replace("MODULE_ID_PLACEHOLDER", MODULE_ID))
    with open(os.path.join(mod_root, "uninstall.sh"), "w") as f:
        f.write("#!/system/bin/sh\nexit 0\n")

    mi = os.path.join(mod_root, "META-INF", "com", "google", "android")
    with open(os.path.join(mi, "update-binary"), "w") as f:
        f.write(UPDATE_BINARY.replace("MODULE_ID_PLACEHOLDER", MODULE_ID))
    with open(os.path.join(mi, "updater-script"), "w") as f:
        f.write("#MAGISK\n")

    for f in ("post-fs-data.sh", "service.sh", "bt_hal_status.sh",
              "uninstall.sh", os.path.join("META-INF", "com", "google", "android", "update-binary")):
        os.chmod(os.path.join(mod_root, f), 0o755)

    # ---- 打包 ----
    zip_path = os.path.join(out_dir, "%s_%sbit.zip" % (MODULE_ID, arch_choice))
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(mod_root):
            for fn in files:
                full = os.path.join(dirpath, fn)
                arc = os.path.relpath(full, out_dir)
                z.write(full, arc)

    return mod_root, zip_path, copied, ver, tag


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(
        description="FM_U20 蓝牙 HAL 补件提取器 (Seekwave SV6160)")
    ap.add_argument("dirs", nargs="+", help="固件解压目录（可多个）")
    ap.add_argument("--out", default="./bt_hal_out", help="输出目录")
    ap.add_argument("--arch", choices=["32", "64", "auto"], default="auto",
                    help="目标架构，默认 auto（优先 32）")
    args = ap.parse_args()

    print("=" * 62)
    print("  FM_U20 蓝牙 HAL 补件提取器")
    print("  设备: 展锐 T158 / Android 13 / 系统 32 位")
    print("=" * 62)

    print("\n[1/4] 搜索中...")
    found = scan_dirs(args.dirs)

    print("\n[2/4] 搜索结果")
    show("1. HAL service (android.hardware.bluetooth@1.x-service)", found["service"])
    show("2. HAL impl (android.hardware.bluetooth@1.x-impl.so)", found["impl"])
    show("3. 厂商库 (libbt-vendor.so)", found["vendorlib"])
    show("4. 相关附属库", found["extra"])

    # 架构统计
    have32 = any(is_arm32(i["elfclass"], i["machine"])
                 for k in ("service", "impl", "vendorlib") for i in found[k])
    have64 = any(is_arm64(i["elfclass"], i["machine"])
                 for k in ("service", "impl", "vendorlib") for i in found[k])

    print("\n[3/4] 架构判定")
    print("  存在 32 位 ARM 补件 : %s" % ("是" if have32 else "否"))
    print("  存在 64 位 ARM 补件 : %s" % ("是" if have64 else "否"))

    if not have32 and not have64:
        print("\n  [X] 未找到任何 ARM 架构补件。")
        print("      请确认：")
        print("        - 目录是否正确（应是固件解压后的根目录）")
        print("        - 固件是否含 vendor 分区镜像")
        print("        - 若固件是 .pac/.img，需先解包")
        return 1

    if args.arch == "auto":
        choice = "32" if have32 else "64"
    else:
        choice = args.arch
        if choice == "32" and not have32:
            print("  [!] 指定 32 位但未找到 32 位文件，改用 64 位")
            choice = "64"
        if choice == "64" and not have64:
            print("  [!] 指定 64 位但未找到 64 位文件，改用 32 位")
            choice = "32"

    print("  -> 采用架构: %s 位" % choice)

    print("\n[4/4] 装配模块")
    os.makedirs(args.out, exist_ok=True)
    mod_root, zip_path, copied, ver, tag = build_module(found, args.out, choice)

    for kind, name, dst in copied:
        print("  + [%s] %s" % (kind, name))

    print("\n" + "=" * 62)
    print("  模块目录: %s" % mod_root)
    print("  刷机包  : %s" % zip_path)
    print("  HAL 版本: %s   服务名: %s" % (ver, tag))
    print("=" * 62)

    if choice == "64":
        print("\n  [!] 重要：64 位路线需要前置模块")
        print("      必须先安装并启用: t158_arm64_native_runtime")
        print("      （提供 linker64 与 arm64 系统共享库）")
        print("      否则 HAL 服务会因缺少 linker64 无法启动")
    else:
        print("\n  32 位路线：直接刷入即可，无需额外模块")

    print("\n  刷入后查看状态:")
    print("    adb shell su -c sh /data/adb/modules/%s/bt_hal_status.sh" % MODULE_ID)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消")
        sys.exit(130)
