# AOSP 蓝牙 HAL 地址回退补丁规格

> 用途：把这份文档转交给云服务器上的编译 Agent。它不需要了解排查过程，照着做即可。
> 目标设备：FM_U20 / MN901UFI，展锐 T158 (ums9621)，Android 13 (API 33)，**32 位 ARM**
> 目标模块：`android.hardware.bluetooth@1.1-service` 与 `android.hardware.bluetooth@1.0-impl`

---

## 0. 环境约束（务必先确认）

```bash
# 必须是 32 位 ARM target，换成 aosp_arm64 就全废了
lunch aosp_arm-userdebug        # 或 aosp_arm-eng

# 源码早已经同步过，只需增量重编单模块，不需要重新 repo sync
```

**架构验证（编完必做）**：
```bash
file out/target/product/generic_arm/vendor/bin/hw/android.hardware.bluetooth@1.1-service
# 期望输出包含：ELF 32-bit LSB ... ARM
```

---

## 1. 问题根因

设备上蓝牙 HAL 启动时打印：

```
Open: No Bluetooth Address!
```

然后**主动退出**（不是崩溃、不是被杀）。

### 1.1 直接原因

部署的 `libbt-vendor.so`（Seekwave SV6160 vendor 库，32 位）**来自 Rockchip 固件**。
该库在初始化时会打开：

```
/dev/vendor_storage
```

这是 **Rockchip 平台专属**的分区节点，用于存放 WiFi/BT MAC、SN、密钥等信息。
RK 的 `libbt-vendor` 类库都从这里读 BD_ADDR。

### 1.2 为什么失败

目标设备 FM_U20 是 **展锐 T158 / ums9621** 平台，**没有 `/dev/vendor_storage` 节点**。

于是：
1. vendor 库打开该节点失败
2. 无法填充 BD_ADDR（6 字节缓冲区保持为 0）
3. AOSP 侧检测到地址无效
4. 打印 `Open: No Bluetooth Address!`
5. `initialize()` 返回失败 → 进程退出

### 1.3 已排除的其他可能

| 怀疑项 | 结论 |
|---|---|
| HAL 架构错误 | 已排除，ELF32/ARM，与系统一致 |
| 依赖库缺失 | 已排除，NEEDED 全部可解析 |
| 被 su 会话清理 / setsid 失效 | 已排除，进程是主动 exit |
| HAL 崩溃 | 已排除，无 HAL tombstone（tombstone 都是 `com.android.bluetooth` 的） |
| 换成展锐自带 `libbt-sprd_suite.so` | **已实测失败**，仍报同样错误 |

### 1.4 补充：芯片确认是 Seekwave（方向没错）

- `/dev/BTCMD` 主设备号 472，同族节点 ATC/LOG/BTDATA/BTCMD/BTAUDIO/LOOPCHECK/BTBOOT
- sysfs 存在 `btsdio` 与 `skw_sdio`
- platform driver 有 `skw_ucom`
- 内核模块 `skw`(544KB) / `skw_sdio` 已加载，`cfg80211` 挂在 `skw` 上
- dmesg 中 `SKWSDIO` / `SKWIFI` 日志刷屏 —— **WiFi 已通过 skw 正常工作**

SV6160 是 WiFi+BT 二合一芯片，WiFi 已通说明 SDIO 总线与 combo 芯片均正常，BT 仅缺一个合法 MAC 地址。

---

## 2. 修复方案

在 AOSP 源码中，当从 vendor 库获取的地址无效（全 0 或全 F）时，**不要直接报错退出**，而是按三级回退：

1. 读取系统属性 `persist.vendor.bluetooth.bdaddr`
2. 读取 `ro.bt.bdaddr_path` 指向的文件
3. 使用编译期硬编码的回退地址 `62:74:86:98:9A:BC`

### 2.1 回退 MAC 地址的来源（不是随意编造）

从设备自身的 NV 文件中解出。设备上存在两个 NV 文件，在**相同偏移处**内容一致：

```
sv6160.nvbin:
  0000000  4e 56 44 53 01 | 06 06 | 62 74 86 98 9a bc | 02 06 f8
                                     ^^^^^^^^^^^^^^^
sv6316.nvbin:
  0000000  4e 56 44 53 01 | 06 06 | 62 74 86 98 9a bc | 05 06 06
                                     ^^^^^^^^^^^^^^^
```

解析：
- `4e 56 44 53` = ASCII `NVDS`（NV Data Storage 魔数）
- `01` = 版本
- `06 06` = TLV tag=0x06, len=0x06（即 6 字节 BD_ADDR）
- **`62 74 86 98 9a bc`** = 蓝牙 MAC 地址

合法性校验：`0x62 & 0x02 = 0x02` → U/L 位为 1，属于**本地管理地址（Locally Administered Address）**，可自由使用，不会与公网设备 OUI 冲突。

---

## 3. 定位要改的文件（先 grep，不要凭记忆）

```bash
cd ~/aosp
grep -rn "No Bluetooth Address" hardware/interfaces/bluetooth/
```

在 Android 13 中，该字符串通常出现在以下两个位置之一（**以 grep 实际结果为准**）：

| 候选 | 路径 | 说明 |
|---|---|---|
| A（主） | `hardware/interfaces/bluetooth/1.0/default/bluetooth_hci.cc` | `BluetoothHci::initialize()` 中获取地址处 |
| B（备选） | `hardware/interfaces/bluetooth/1.1/default/bluetooth_hci.cc` | 若 1.1 目录也有同名文件 |

> 若两处都存在，两处都改。
> 若只在 `1.0/default/` 存在 —— 这是最常见情况，因为 1.1 service 复用 1.0 的 impl。

---

## 4. 补丁代码

### 4.1 新增辅助函数

在报错所在文件的**文件作用域**（匿名 namespace 内，或所有函数之前）插入：

```cpp
#include <android-base/properties.h>
#include <cutils/properties.h>
#include <fstream>
#include <sstream>
#include <vector>

namespace {

// 判断地址是否无效（全 0 或全 0xFF）
bool IsBdAddrInvalid(const uint8_t* addr) {
  if (addr == nullptr) return true;
  bool all_zero = true;
  bool all_ff   = true;
  for (int i = 0; i < 6; i++) {
    if (addr[i] != 0x00) all_zero = false;
    if (addr[i] != 0xFF) all_ff   = false;
  }
  return all_zero || all_ff;
}

// 解析 "XX:XX:XX:XX:XX:XX" 形式的字符串
bool ParseBdAddrString(const std::string& s, uint8_t out[6]) {
  if (s.size() < 17) return false;
  unsigned int v[6];
  if (sscanf(s.c_str(), "%2x:%2x:%2x:%2x:%2x:%2x",
             &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) {
    return false;
  }
  for (int i = 0; i < 6; i++) out[i] = static_cast<uint8_t>(v[i]);
  return true;
}

// 读取 ro.bt.bdaddr_path 指向的文件，取前 17 字节
bool ReadBdAddrFromFile(const std::string& path, uint8_t out[6]) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  std::string line;
  if (!std::getline(f, line)) return false;
  // 去掉可能的空白
  while (!line.empty() && isspace(line.back())) line.pop_back();
  return ParseBdAddrString(line, out);
}

// 三级回退获取地址
bool GetFallbackBdAddr(uint8_t out[6]) {
  // 1) 属性
  std::string prop = android::base::GetProperty("persist.vendor.bluetooth.bdaddr", "");
  if (!prop.empty() && ParseBdAddrString(prop, out)) {
    ALOGW("BD_ADDR fallback: from property = %s", prop.c_str());
    return true;
  }

  // 2) ro.bt.bdaddr_path 指向的文件
  std::string path = android::base::GetProperty("ro.bt.bdaddr_path", "");
  if (!path.empty() && ReadBdAddrFromFile(path, out)) {
    ALOGW("BD_ADDR fallback: from file %s", path.c_str());
    return true;
  }

  // 3) 硬编码回退（来自设备自身 NV：62:74:86:98:9A:BC，本地管理地址）
  static const uint8_t kDefaultAddr[6] = {0x62, 0x74, 0x86, 0x98, 0x9A, 0xBC};
  memcpy(out, kDefaultAddr, 6);
  ALOGW("BD_ADDR fallback: using built-in default 62:74:86:98:9A:BC");
  return true;
}

}  // namespace
```

### 4.2 在报错处插入回退逻辑

找到类似这样的代码（**以实际 grep 到的为准**）：

```cpp
  ALOGE("Open: No Bluetooth Address!");
```

或：

```cpp
  if (addr_is_invalid) {
    ALOGE("Open: No Bluetooth Address!");
    return;   // 或 return Void();
  }
```

在其**之前**插入回退。示例：

```cpp
  // ---- BEGIN PATCH: BD_ADDR fallback ----
  if (IsBdAddrInvalid(bdaddr)) {
    uint8_t fallback[6] = {0};
    if (GetFallbackBdAddr(fallback)) {
      memcpy(bdaddr, fallback, 6);
      ALOGW("Open: vendor provided invalid BD_ADDR, using fallback "
            "%02X:%02X:%02X:%02X:%02X:%02X",
            bdaddr[0], bdaddr[1], bdaddr[2],
            bdaddr[3], bdaddr[4], bdaddr[5]);
    }
  }
  // ---- END PATCH ----

  ALOGE("Open: No Bluetooth Address!");   // 原有代码保留
```

> **注意变量名**：实际代码里地址缓冲区的名字可能不是 `bdaddr`，
> 可能是 `addr`、`local_addr`、`bt_addr`、`mBdAddr` 等。
> **请按实际代码里的变量名替换**，不要照抄。

### 4.3 更容易的备选方案（若 4.2 改动复杂）

如果地址是通过回调/结构体返回的、难以在报错点拦截，可以直接在**报错点附近**做最小改动：

```cpp
  // ---- BEGIN PATCH: minimal BD_ADDR fallback ----
  {
    static const uint8_t kDefaultAddr[6] = {0x62, 0x74, 0x86, 0x98, 0x9A, 0xBC};
    ALOGW("Open: forcing fallback BD_ADDR 62:74:86:98:9A:BC");
    memcpy(<实际地址变量名>, kDefaultAddr, 6);
  }
  // ---- END PATCH ----
```

把 `<实际地址变量名>` 替换成真实变量名，并**跳过原有的 return / 错误分支**。
（最简单做法：把 `ALOGE(...); return;` 两行注释掉，改成上面的强制赋值 + 继续往下走。）

---

## 5. 编译

```bash
cd ~/aosp
source build/envsetup.sh
lunch aosp_arm-userdebug          # 32 位！不要 aosp_arm64

# 两个都编（地址逻辑可能在 impl 里，只编 service 可能不生效）
m android.hardware.bluetooth@1.0-impl
m android.hardware.bluetooth@1.1-service
```

### 5.1 产物路径

```
out/target/product/generic_arm/vendor/bin/hw/android.hardware.bluetooth@1.1-service
out/target/product/generic_arm/vendor/lib/hw/android.hardware.bluetooth@1.0-impl.so
```

### 5.2 架构自检（必须做）

```bash
file out/target/product/generic_arm/vendor/bin/hw/android.hardware.bluetooth@1.1-service
file out/target/product/generic_arm/vendor/lib/hw/android.hardware.bluetooth@1.0-impl.so
```

两者都必须输出包含 **`ELF 32-bit`** 和 **`ARM`**。
若出现 `ELF 64-bit` 或 `AArch64`，说明 lunch 选错了，必须改用 `aosp_arm` 重编。

---

## 6. 交付

把这两个文件拷贝出来，覆盖到用户部署目录中（用户已有组装脚本会自动处理打包）：

```
android.hardware.bluetooth@1.1-service    -> 替换旧的
android.hardware.bluetooth@1.0-impl.so    -> 替换旧的
```

用户侧的验证工具会检查：
- ELF32 / ARM 架构
- NEEDED 依赖完整性

---

## 7. 验收标准

部署后在设备上：

```bash
adb shell pidof android.hardware.bluetooth@1.1-service    # 应返回 PID，且持续存在
adb shell lshal | grep -i bluetooth                       # 应显示 @1.1::IBluetoothHci/default 已注册
adb shell ls /sys/class/bluetooth/                        # 应出现 hci0
adb shell cat /data/local/tmp/bt_addr.log                 # 不应再有 "No Bluetooth Address"
```

**成功标志：`/sys/class/bluetooth/hci0` 出现，且 HAL 进程不再退出。**

---

## 8. 已知次要问题（本次可不处理）

设备上 `skwbt.conf` 声明了 4 个节点：

```
BtDeviceNode=/dev/BTCMD     -> 存在
BtDeviceNode=/dev/BTDATA    -> 存在
BtDeviceNode=/dev/BTAUDIO   -> 存在
BtDeviceNode=/dev/BTISOC    -> 不存在
```

若补丁后仍失败，下一步是通过模块覆盖一份**删掉 `/dev/BTISOC` 那行**的 `skwbt.conf`。
本次先不处理，等地址问题解决后再看是否仍有影响。

---

## 9. 一句话总结给执行者

> 设备上没有 `/dev/vendor_storage`（RK 专属），导致从 RK 固件提取的 Seekwave vendor 库拿不到 BD_ADDR。
> 请在 AOSP 蓝牙 HAL 源码中 `Open: No Bluetooth Address!` 报错点之前，加入地址回退逻辑：
> 属性 -> `ro.bt.bdaddr_path` 文件 -> 硬编码 `62:74:86:98:9A:BC`。
> 用 `aosp_arm`（32 位）重编 `1.0-impl` 与 `1.1-service` 两个模块即可。
