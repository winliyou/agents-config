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
- 构建/安装脚本按项目约定（如 music_app 用仓库根 `tools/auto_sign.sh`，不带参数只构建，`install` 构建+安装+启动）

## 沙盒下构建必须先重定向缓存

不重定向会报 `EPERM ~/.hvigor` / `~/.npm`：

```bash
HVIGOR_USER_HOME=$PWD/.workwork/hvigor-home \
npm_config_cache=$PWD/.workwork/npm-cache \
<项目构建脚本> install
```

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
