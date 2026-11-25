---
name: harmony-device-debug
description: HarmonyOS / 鸿蒙真机与模拟器调试通用流程（hdc）：真机优先的设备选择与判定、设备自动发现、无线调试连接、tconn 陷阱与僵尸连接清场、模拟器启动、uitest 布局与截图验证。触发：装 HAP 到鸿蒙真机或模拟器；判断当前该用真机还是模拟器；hdc 相关操作；无线调试连不上、hdc list targets 为空或显示 Offline/Unknown；tconn 超时或 hang；需要查设备 IP 端口；uitest dumpLayout 或 uinput 验证界面；DevEco 模拟器启动；签名构建安装失败。
---

# HarmonyOS 真机 / 模拟器调试（hdc 通用流程）

**目标：用户不需要提供 IP:端口，AI 每次自己找到设备并装上验证。** 无线调试端口是 30000+ 且每次重开会变，手机 IP 也可能变（DHCP/随机 MAC），**禁止写死任何地址**。

**设备选择规则：先找符合条件的真机；没有才启动模拟器。** 判定流程见第一节；后文命令对真机与模拟器通用，差异单独标注。

项目专属部分（包名、入口 Ability、构建脚本、签名材料位置）见各项目自己的 skill；本文件只记跨项目通用的 hdc 行为与流程。

## 一、选设备：真机优先，模拟器兜底

**测试 HarmonyOS app 一律先枚举已连接设备，优先使用「符合条件的真机」；只有没有合格真机时才启动模拟器。** 不得因为模拟器已开、坐标已标定或签名只绑了模拟器而跳过可用真机。

1. **枚举**：`hdc list targets -v`。
   - **真机候选**：状态 `Connected`，且不是模拟器。模拟器实测特征（本机 DevEco 模拟器）：target 为 `127.0.0.1:5555`，`hdc shell param get const.product.model` 返回 `emulator`。真机 target 形态以输出为准（USB 直连显示设备序列号，无线调试显示 `IP:端口`）。
   - `Offline` / `Unknown` 一律不算；先用 `hdc kill -r` 清僵尸（见「hdc 常见坑」）。
   - 同时连了真机和模拟器时，**所有命令必须带 `-t <target>`**，否则会落到默认设备。

2. **真机连接方式**（按成功率从高到低）：
   - **USB 调试**：开发者选项 → USB 调试，插线后设备弹「允许调试」需在屏幕上点同意；`hdc list targets -v` 出现 `Connected` 即可用。
   - **无线调试**：开发者选项 → 无线调试 → 打开，取屏幕上的 `IP:端口`；`timeout 15 hdc tconn <IP>:<端口>` 后以 `list targets -v` 出现 `Connected` 为准。端口每次重开会变，禁止写死；完整发现/重连流程见「真机自动发现」。

3. **核验「符合条件」四项（全部满足才用真机）**：
   - **可安装**：项目 `compatibleSdkVersion` / `targetSdkVersion` ≤ 设备 API；设备 API 用 `hdc -t <target> shell param get const.ohos.apiversion` 现查（本机模拟器实测 26），系统版本用 `param get const.product.software.version`，ABI 用 `param get const.product.cpu.abilist`。
   - **签名绑定**：debug 签名 profile 绑定设备 UDID，真机未绑定会装失败；项目签名脚本的 `install` 模式会校验设备绑定（如 music_app 的 `tools/auto_sign.sh install`）。真机拒装 unsigned HAP；签名不一致时 `install sign info inconsistent`，需先 `hdc uninstall`（**会清应用数据**，先确认）。
   - **形态与能力匹配本次测试目标**：定位、地图、输入法、系统分享、相机、传感器、音频等需要真实硬件/系统服务的验收项，有真机必须真机（这些恰是模拟器的已知受限项）；纯布局/交互走查用手机真机即可。
   - **数据安全**：不擅自卸载/清数据/改系统设置；在用户日常真机上执行这些操作前先征得同意，测试结束恢复原状态。

4. **命中** → 锁定 target，所有 hdc 命令带 `-t <target>`；走查记录与 PR 证据写明**型号 + 系统版本 + API + target**（型号用 `param get const.product.model`，不要靠外观猜）。

5. **未命中** → 启动/使用模拟器，并记录原因：未连接、未授权、版本不符、签名未绑定、需要隔离数据、必须有真机能力等。

**结论隔离**：模拟器专属限制不得当作 app 缺陷或真机结论——系统地理编码无数据、系统分享无接收方、无真实定位/传感器、首次输入弹小艺输入法向导、性能与耗电无参考价值等；真机也不套用模拟器的坐标基线（分辨率/密度/状态栏随设备变化，坐标一律现场 dump）。

## 工具链（本机路径）

- hdc：`/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc`
- 模拟器：`/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator -list|-start <name>|-stop <name>`
- 构建/安装脚本按项目约定（如用仓库根的签名脚本，不带参数只构建，`install` 构建+安装+启动）

## 模拟器内存占用与实例配置

- **为什么占内存大**（来源：`Emulator -help` 与实例 config.ini）：每个实例是一台完整 QEMU 虚拟机（实例目录 `~/.Huawei/Emulator/deployed/<名称>/`，含 `hardware-qemu.ini`），预置机型 profile（`/Applications/DevEco-Studio.app/Contents/tools/emulator/emulator.json`）的 `memoryRamSize` 模板默认是 **4096**（4 GB）；另 4 vCPU（`Emulator -list -details` 与实例 `hardware-qemu.ini` 可查；`Emulator -create` 的 `-memory` 默认值同样是 4 GB）；系统镜像 HarmonyOS 7.0.0 的 system.img 有 3.6 GB。跑起来后 guest 内存大部分被真实占用，再加高分辨率图形缓冲，单实例进程 RSS 可达 4–6 GB；同时开多个实例乘倍。**本机实例的实际内存档位与配置见 `local-environment` 的「DevEco 模拟器限内存」**。
- **预置实例的内存「官方界面改不了，但手工能改」**：Device Manager UI 与 CLI 对 `isCustomize=false` 的预置实例都禁改内存；要改就**直接编辑实例目录下的 `config.ini`（`hw.ramSize`）+ `lists.json`**，不要在 UI 里找入口。另：CLI 建新实例可自定内存：
  ```bash
  # -memory 取值 2~32 GB，默认 4；-storage 取值 2~1023 GB，默认 6
  Emulator -create LowMem -deviceType Phone \
    -osVersion "HarmonyOS 7.0.0(26.0.0)" -memory 2 -screen "1080 2340 480 6.5"
  ```
  `-osVersion` 格式 `HarmonyOS <version>(<api_version>)`，须与已下载镜像一致（`Emulator -imageList` 查）。`-screen` 的字段语义 `Emulator -help` 未给出（该示例串未在本地创建实例验证，用前先对照已下载实例 `config.ini` 的 resolution/density 字段）。仅验证到 help/参数面，实际创建未跑过（避免在用户机上留实例）。
- 其他相关参数：`-bootMode coldboot|reset|snapshot`（默认 Quick Boot 快照恢复会把 guest 状态整块拉回内存）、`-hotBoot <true/false>`、`-noWindow`。
- 省内存优先级：**有合格真机用真机（USB/无线）** > UI 静态开发用 Previewer > 必须模拟器时只开一个、用完 `Emulator -stop <name>` > CLI 建 2 GB 低配实例。

## 沙盒下构建

`~/.hvigor`、`~/.ohpm`、`~/.npm` 已由 sandbox-extra-roots 放行，沙盒内直接构建即可。若报 `EPERM ... ~/.hvigor` / `~/.npm`，把报错目录加进插件配置（见 `sandbox-adaptation`），**不要再 export `HVIGOR_USER_HOME`/`npm_config_cache` 重定向**。

## 真机自动发现（无线，用户不提供 IP:端口）

1. **`hdc list targets -v`**：已有符合条件真机（`Connected` 且非模拟器）直接用，并把 `ip:port` 记入状态文件。
2. **状态文件**：`.workwork/hdc-known`（gitignore，不入库），内容为上次成功的 `ip:port`，逐行 `timeout 15 hdc tconn <addr>` 试连。
   > **跨 worktree 共享例外**：设备状态属于"本机设备事实"，不应随 worktree 隔离。在 worktree 内工作时取主仓那份：`git worktree list | head -1 | awk '{print $1}'`。这是对「`.workwork/` 按工作树隔离」的有意例外（设备只有一台，按工作树各存一份会导致重复全端口扫描）。
3. **局域网扫描**（状态文件失效时）：`arp -a` 取同网段候选（排除网关/本机/组播）→ `ping -c2` 确认存活 → asyncio 全端口扫描（1–65535，并发 1000，超时 0.6s，局域网约 1–2 分钟）→ 对每个开放端口 `timeout 12 hdc tconn ip:port` 试握手。**不要装 nmap**（没装也不需要）。
4. **判定标准只有一条**：`hdc list targets -v` 出现 `Connected`。其他一律不算成功。
5. **全部失败 = 手机端无线调试没开**（典型表现：端口通但握手全挂、tconn 反复超时）。**停下来请用户开**（开发者选项 → 无线调试 → 打开，把屏幕上的 IP:port 发来），不要死循环重扫。拿到后同样记入状态文件。

## 启动模拟器（仅无合格真机时）

```bash
EMU=/Applications/DevEco-Studio.app/Contents/tools/emulator/Emulator
"$EMU" -list                       # 实例名现查，不写死
"$EMU" -start "<实例名>"            # 后台启动；-start 本身会返回，不要在前台等它退出
```

- 就绪判据：`hdc list targets -v` 出现 `127.0.0.1:5555` 且状态 `Connected`（模拟器 target 固定为本机回环地址，实测）；未出现时先 `hdc kill -r` 清僵尸，再 `timeout 15 hdc tconn 127.0.0.1:5555` 手动连一次（实测端口已监听但 hdc 不自动发现时需要这一步）。
- 模拟器身份可用 `hdc shell param get const.product.model` 复核（本机实测返回 `emulator`），避免把模拟器当成真机记录结论。
- 冷启动耗时随实例/缓存差异大，不固定等待时间；`-stop` 可能 hang，清场用 `pkill -9 -f Emulator`（确认只杀自己的实例）。
- 实例目录 `~/.Huawei/Emulator/deployed` 已由 DSH sandbox-extra-roots 插件放行；报 `EPERM ... Operation not permitted` 时把报错路径加进 `extraWritableRoots`（见 `sandbox-adaptation`），**不要把实例克隆到 `.workwork/` 或改 `config.ini` 重定向路径**。

## hdc 常见坑（以实测为准，不要凭记忆假设）

- **`tconn` 退出码不可靠**：hang 住时要靠外层 `timeout` 杀（exit=124）；成功时无输出（或 `Connect OK`）；`[Fail]Xxx failed` 才是明确失败。一律用 `list targets -v` 复核。
- **`tconn <裸IP>`（不带端口）会秒失败**，必须用 `ip:port` 全地址。
- **僵尸条目**：失败/超时会留下 `Offline`/`Unknown` 条目，会误导后续设备预检。动手前/失败后用 `hdc kill -r`（必要时 `start -r`）重启 server 清掉，等 `list targets` 回到 `[Empty]` 再继续。
- **server 被卡住**：挂起的 `tconn` 可能把 server 卡住（表现为之前秒失败的地址也开始 hang），同样靠 `kill -r` 恢复。
- `tconn` 单次超时设 12–15s（局域网足够）；`tconn -remove` 清僵尸**实测不可用**，清场一律 `hdc kill -r`。
- **手机息屏会断开无线调试**：重连成功后立刻跑安装；提醒用户装机期间别锁屏。
- 沙盒 `workspace-write` 下 LAN 直连与端口扫描**均可正常执行**（已验证）。

## 安装与验证

- **安装**：按项目脚本（如 `tools/auto_sign.sh install` → 重建签名 HAP + `hdc install -r` + `aa start`）。真机必须装 signed HAP，unsigned 会被拒。
- **存活检查**：`hdc -t <target> shell "pidof <包名>; bm dump -n <包名>" | head`
- **UI 验证**：
  - `hdc -t <target> shell uitest dumpLayout` 取布局树（应用 root 在 `children[0]`；`children` 为空 = 白屏未渲染）
  - `hdc -t <target> shell uinput -T -c <x> <y>` 模拟点击
  - `hdc -t <target> shell snapshot_display` 截图（落盘后用 read_image 查看）
- 具体包名与入口 Ability 见项目 skill。

## 自动化输入与 dump 陷阱

- **`uitest uiInput inputText x y text` 只进当前焦点框**：坐标参数只是辅助定位（实际行为近「点击后输入」），跨多个输入框填表必须逐框「先点击聚焦 → inputText」；键盘弹出时第二个输入框常被顶出可视区（dump 里消失），此时输入会串框。
- **`uinput -K -d 2 -u 2`（BACK）在键盘未弹出时 = 页面返回导航**：收键盘前先用 dump 确认键盘确实在弹（焦点框 bounds 位移）；键盘未弹时按 BACK 会把页面导航走（从登录页退回 Tab 页）。
- **软键盘收起后布局恢复有过程**：BACK 后立即 dump 拿到的 bounds 可能是恢复中状态，点击必偏。收键盘 → sleep 2s → dump → 再点击。
- **dumpLayout 落盘有延迟**：dump 命令返回后立即 cat 可能读到上一次落盘的文件（极端时为空数组），间隔 ≥600ms 再读。
- **滚动后 dump 坐标点击易无效**：fling 之后等 2s 让滚动动画结束再 dump+click；点击「确认类」按钮（弹窗按钮）若 dump 坐标点击无效，可能是页面滚动位置未稳定。
- **设备→宿主机端口转发（`hdc rport tcp:<端口> tcp:<端口>`）**：模拟器内 app 直连 `127.0.0.1:<端口>` 即可到达宿主机服务。设置后用 `hdc fport ls` 确认出现 `[Reverse]` 条目；**具体端口、app 侧服务地址常量、日志域关键词属项目事实，见对应项目 skill**。验证方式：app 内触发一次请求，用 `hilog -x` 抓 HTTP 状态/响应码确认。
- **hilog 抓取用 `hilog -r` 清缓冲 + 操作 + `hilog -x` 导出**，避免后台流式抓取的进程管理麻烦。
- **真机与模拟器的输入/系统面板行为不同**：真机通常有可用输入法、定位、系统分享接收方；模拟器首次输入可能弹输入法配置向导、系统分享常因无接收应用而失败——这是环境差异，不是 app bug。