---
name: harmony-device-debug
description: HarmonyOS / 鸿蒙真机与模拟器调试通用流程（hdc）：设备自动发现、无线调试连接、tconn 陷阱与僵尸连接清场、uitest 布局与截图验证。触发：装 HAP 到鸿蒙真机或模拟器；hdc 相关操作；无线调试连不上、hdc list targets 为空或显示 Offline/Unknown；tconn 超时或 hang；需要查设备 IP 端口；uitest dumpLayout 或 uinput 验证界面；DevEco 模拟器启动；签名构建安装失败。
---

# HarmonyOS 真机 / 模拟器调试（hdc 通用流程）

**目标：用户不需要提供 IP:端口，AI 每次自己找到设备并装上验证。** 无线调试端口是 30000+ 且每次重开会变，手机 IP 也可能变（DHCP/随机 MAC），**禁止写死任何地址**。

项目专属部分（包名、入口 Ability、构建脚本、签名材料位置）见各项目自己的 skill；本文件只记跨项目通用的 hdc 行为与流程。

## 工具链（本机路径）

- hdc：`/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc`
- 模拟器：`/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator -list|-start <name>|-stop <name>`
- 构建/安装脚本按项目约定（如用仓库根的签名脚本，不带参数只构建，`install` 构建+安装+启动）

## 模拟器内存占用与实例配置

- **为什么占内存大**（2026-10-23 实测，来源：`Emulator -help` 与实例 config.ini）：每个实例是一台完整 QEMU 虚拟机（实例目录 `~/.Huawei/Emulator/deployed/<名称>/`，含 `hardware-qemu.ini`），预置机型 profile（`/Applications/DevEco-Studio.app/Contents/tools/emulator/emulator.json`）的 `memoryRamSize` 模板默认是 **4096**（4 GB）；**本机现有实例已被手工改成 `hw.ramSize=2048`**（2 GB，2026-10-31 复核：模板 4096、5 个实例 config.ini 均 2048），另 4 vCPU（`Emulator -list -details` 与实例 `hardware-qemu.ini`；`Emulator -create` 的 `-memory` 默认值同样是 4 GB）；系统镜像 HarmonyOS 7.0.0 的 system.img 有 3.6 GB。跑起来后 guest 内存大部分被真实占用，再加高分辨率图形缓冲，单实例进程 RSS 轻松 4–6 GB；同时开多个实例乘倍。
- **预置实例的内存改不了**（`isCustomize=false`，UI 里也不能改），但 CLI 建新实例可自定内存：
  ```bash
  # -memory 取值 2~32 GB，默认 4；-storage 取值 2~1023 GB，默认 6
  Emulator -create LowMem -deviceType Phone \
    -osVersion "HarmonyOS 7.0.0(26.0.0)" -memory 2 -screen "1080 2340 480 6.5"
  ```
  `-osVersion` 格式 `HarmonyOS <version>(<api_version>)`，须与已下载镜像一致（`Emulator -imageList` 查）。`-screen` 的字段语义 `Emulator -help` 未给出（该示例串未在本地创建实例验证，用前先对照已下载实例 `config.ini` 的 resolution/density 字段）。仅验证到 help/参数面，实际创建未跑过（避免在用户机上留实例）。
- 其他相关参数：`-bootMode coldboot|reset|snapshot`（默认 Quick Boot 快照恢复会把 guest 状态整块拉回内存）、`-hotBoot <true/false>`、`-noWindow`。
- 省内存优先级：UI 开发用 Previewer > 有真机用无线调试 > 只开一个实例用完 `Emulator -stop <name>` > CLI 建 2 GB 低配实例。

## 沙盒下构建

`~/.hvigor`、`~/.ohpm`、`~/.npm` 已由 sandbox-extra-roots 放行，沙盒内直接构建即可。若报 `EPERM ... ~/.hvigor` / `~/.npm`，把报错目录加进插件配置（见 `sandbox-adaptation`），**不要再 export `HVIGOR_USER_HOME`/`npm_config_cache` 重定向**。

## 设备自动发现（按序执行，命中即停）

1. **`hdc list targets -v`**：已有 `Connected` 设备直接用，并把 `ip:port` 记入状态文件。
2. **状态文件**：`.workwork/hdc-known`（gitignore，不入库），内容为上次成功的 `ip:port`，逐行 `timeout 15 hdc tconn <addr>` 试连。
   > **跨 worktree 共享例外**：设备状态属于"本机设备事实"，不应随 worktree 隔离。在 worktree 内工作时取主仓那份：`git worktree list | head -1 | awk '{print $1}'`。这是对「`.workwork/` 按工作树隔离」的有意例外（设备只有一台，按工作树各存一份会导致重复全端口扫描）。
3. **局域网扫描**（状态文件失效时）：`arp -a` 取同网段候选（排除网关/本机/组播）→ `ping -c2` 确认存活 → asyncio 全端口扫描（1–65535，并发 1000，超时 0.6s，局域网约 1–2 分钟）→ 对每个开放端口 `timeout 12 hdc tconn ip:port` 试握手。**不要装 nmap**（没装也不需要）。
4. **判定标准只有一条**：`hdc list targets -v` 出现 `Connected`。其他一律不算成功。
5. **全部失败 = 手机端无线调试没开**（典型表现：端口通但握手全挂、tconn 反复超时）。**停下来请用户开**（开发者选项 → 无线调试 → 打开，把屏幕上的 IP:port 发来），不要死循环重扫。拿到后同样记入状态文件。

## hdc 已踩坑（以实测为准，不要凭记忆假设）

- **`tconn` 退出码不可靠**：hang 住时要靠外层 `timeout` 杀（exit=124）；成功时无输出；`[Fail]Xxx failed` 才是明确失败。一律用 `list targets -v` 复核。
- **`tconn <裸IP>`（不带端口）会秒失败**，必须用 `ip:port` 全地址。
- **僵尸条目**：失败/超时会留下 `Offline`/`Unknown` 条目，会误导后续设备预检。动手前/失败后用 `hdc kill -r`（必要时 `start -r`）重启 server 清掉，等 `list targets` 回到 `[Empty]` 再继续。
- **server 被卡住**：早前挂起的 `tconn` 可能把 server 卡住（表现为之前秒失败的地址也开始 hang），同样靠 `kill -r` 恢复。
- `tconn` 单次超时设 12–15s（局域网足够）；`tconn -remove` 清僵尸**实测不可用**，清场一律 `hdc kill -r`。
- **手机息屏会断开无线调试**：重连成功后立刻跑安装；提醒用户装机期间别锁屏。
- 沙盒 `workspace-write` 下 LAN 直连与端口扫描**均可正常执行**（已验证）。

## 安装与验证

- **安装**：按项目脚本（如 `tools/auto_sign.sh install` → 重建签名 HAP + `hdc install -r` + `aa start`）。
- **存活检查**：`hdc shell "pidof <包名>; bm dump -n <包名>" | head`
- **UI 验证**：
  - `hdc shell uitest dumpLayout` 取布局树（应用 root 在 `children[0]`；`children` 为空 = 白屏未渲染）
  - `hdc shell uinput -T -c <x> <y>` 模拟点击
  - `hdc shell snapshot_display` 截图（落盘后用 read_image 查看）
- 具体包名与入口 Ability 见项目 skill。

## 自动化输入与 dump 陷阱

- **`uitest uiInput inputText x y text` 只进当前焦点框**（2026-10-16 实测）：坐标参数只是辅助定位（实际行为近「点击后输入」），跨多个输入框填表必须逐框「先点击聚焦 → inputText」；键盘弹出时第二个输入框常被顶出可视区（dump 里消失），此时输入会串框。
- **`uinput -K -d 2 -u 2`（BACK）在键盘未弹出时 = 页面返回导航**：收键盘前先用 dump 确认键盘确实在弹（焦点框 bounds 位移）；键盘未弹时按 BACK 会把页面导航走（实测从登录页退回 Tab 页）。
- **软键盘收起后布局恢复有过程**：BACK 后立即 dump 拿到的 bounds 可能是恢复中状态，点击必偏。收键盘 → sleep 2s → dump → 再点击。
- **dumpLayout 落盘有延迟**：dump 命令返回后立即 cat 可能读到上一次的旧文件（极端时为空数组），间隔 ≥600ms 再读。
- **滚动后 dump 坐标点击易无效**：fling 之后等 2s 让滚动动画结束再 dump+click；点击「确认类」按钮（弹窗按钮）若 dump 坐标点击无效，可能是页面滚动位置未稳定。
- **设备→宿主机端口转发（`hdc rport tcp:<端口> tcp:<端口>`）**：模拟器内 app 直连 `127.0.0.1:<端口>` 即可到达宿主机服务。设置后用 `hdc fport ls` 确认出现 `[Reverse]` 条目；**具体端口、app 侧服务地址常量、日志域关键词属项目事实，见对应项目 skill**。验证方式：app 内触发一次请求，用 `hilog -x` 抓 HTTP 状态/响应码确认。
- **hilog 抓取用 `hilog -r` 清缓冲 + 操作 + `hilog -x` 导出**，避免后台流式抓取的进程管理麻烦。
