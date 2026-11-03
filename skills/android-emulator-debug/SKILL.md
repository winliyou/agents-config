---
name: android-emulator-debug
description: Android 模拟器/真机的 CLI 自动调试流程（emulator + adb + jdb）：启动模拟器、安装 APK、拉起 Activity、截图与 UI 层级、模拟按键点击、logcat 排查、JDWP 附加调试。触发：需要让 dsh 自动在模拟器/真机里安装、运行、调试 Android app；adb install 报 INSTALL_FAILED_VERSION_DOWNGRADE / UPDATE_INCOMPATIBLE 或装成功却起不来；模拟器启动与 boot 完成检测；uiautomator dump / screencap / input tap；抓 logcat 或崩溃；jdb attach JDWP、run-as 读应用私有数据。
---

# Android 模拟器 / 真机自动调试（CLI）

dsh 没有 Android 专用集成，也没有 GUI 调试器；**全部能力由 shell 驱动 emulator / adb / jdb 提供**。安装、运行、截图、UI 层级、模拟输入、日志、断点调试都能自动完成，等价于「用命令行按 Android Studio 的 Run / Debug」。

本机 SDK/JDK 路径见 `local-environment` skill；Gradle/JDK 环境变量与构建偏好见 `toolchain-setup` skill；项目专属部分（包名、构建脚本、版本规则、部署流程）见项目自己的 skill。Gradle 构建与 `connectedDebugAndroidTest` 不在本流程内，按 `toolchain-setup` 的 Gradle 规程执行。

## 一、起模拟器（headless）并确认 boot

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
"$ANDROID_HOME/emulator/emulator" -list-avds                 # 取实例名
# 后台启动；-no-snapshot-save 保证调试改动不写回用户 AVD 快照
"$ANDROID_HOME/emulator/emulator" -avd <AVD> \
  -no-window -no-audio -no-boot-anim -no-snapshot-save &
```

- `adb wait-for-device` 只表示 adbd 起来，**不等于系统可用**；要轮询 `adb -s emulator-5554 shell getprop sys.boot_completed` 到 `1`。冷启动实测约 20s。
- 启动日志出现 `Failed to load snapshot ... different renderer configured` 是**快照与命令行 `-gpu` 不一致、回退冷启动**，不是故障，只是慢 20–30s；日志里 `Boot completed in N ms` 是真实启动耗时。
- **收尾必须 `adb -s emulator-5554 emu kill`**，并确认 `adb devices` 里 emulator 已消失；配合 `-no-snapshot-save` 不污染用户实例。同一条命令里别把 emulator 放前台等它退出。
- 内存：guest 按 AVD `config.ini` 的 `hw.ramSize`，host 侧再加约 3GB QEMU/图形开销；16GB 机器上不要与 OrbStack、多浏览器、多个 Electron 应用并行，否则触发 jetsam 整批杀进程（见 `local-environment` skill 的内存耗尽节）。

## 二、装 APK：先核对、再装、再确认

1. **核对产物**（同一仓库常有多个同 `versionCode` 的不同变体；装错会「install Success 但启动报 Activity does not exist」）：
   ```bash
   "$ANDROID_HOME/build-tools/<ver>/aapt2" dump badging <apk> | grep -E "^package:|sdkVersion|targetSdkVersion|launchable-activity"
   ```
   用 `launchable-activity`、`targetSdkVersion`、`minSdkVersion` 判断是当前分支产物还是旧版客户端变体（新旧 App 可能共用 applicationId 与 versionCode）。
2. **安装**：`adb -s <serial> install -r -t <apk>`。可加 `-d` 降级，但 **`-d` 只在已安装包是 debuggable 时生效**，否则仍报 `INSTALL_FAILED_VERSION_DOWNGRADE` → 只能先 `adb uninstall <pkg>` 再装。`INSTALL_FAILED_UPDATE_INCOMPATIBLE` = 签名不一致，同样只能先卸载。
3. **确认**：`adb -s <serial> shell dumpsys package <pkg> | grep -E "versionCode|versionName"`，并用 `minSdk/targetSdk` 交叉验证装的是预期变体。
4. **卸载会清应用数据**：在用户已有 AVD 上做试验要预判这一点；若卸载过，收尾装回原版本（从 build 产物目录选对变体），并说明数据已无法恢复。

## 三、启动与「看得见」的验证

```bash
adb -s <serial> shell cmd package resolve-activity --brief <pkg>   # 取真实入口，别猜 .MainActivity
adb -s <serial> shell am start -W -n <pkg>/<Activity>
adb -s <serial> shell pidof <pkg>
adb -s <serial> shell dumpsys activity activities | grep mResumedActivity
adb -s <serial> exec-out screencap -p > screen.png
adb -s <serial> shell uiautomator dump /sdcard/ui.xml && adb -s <serial> pull /sdcard/ui.xml ui.xml
```

- `uiautomator dump` 的 XML 含每个节点的 `text` 与 `bounds`；`input tap <x> <y>` 点击（TV 模拟器同样生效），`input keyevent <KEYCODE>` 发按键（`KEYCODE_DPAD_UP/DOWN/ENTER/BACK` 等）。坐标取 `bounds` 中心。
- 不同 App / 控件的触摸支持不一致：实测同一 TV App 里标准对话框按钮、顶栏图标按钮 `input tap` 有效，而主界面 Hero 自绘按钮对 tap 无响应（只认遥控器焦点）——tap 不生效时改用 `input keyevent 20/22/66`（DPAD 移动 + ENTER 激活），以截图/UI 层级变化判定是否点中。
- `uiautomator dump` 导出的 XML 是**单行**长文本，DSH `read` 会按单行长度上限截断 → 用 `python3` 的 ElementTree 解析（或先 `sed 's/></>\\n</g'` 拆行）再取坐标。
- 判定「真的跑起来了」要**截图 + 前台 Activity + 进程 PID 三者交叉**，不能只看 `am start` 返回 `Status: ok`。
- `uiautomator dump` 偶发耗时较长（数秒到十几秒），单条命令给足 30s；它也能用来点掉启动时的更新弹窗/权限弹窗。

## 四、日志、崩溃与私有数据

```bash
PID=$(adb -s <serial> shell pidof <pkg> | tr -d '\r')
adb -s <serial> logcat -d --pid=$PID -v time | tail -50
adb -s <serial> logcat -d -s AndroidRuntime | tail -50        # Java/Kotlin 崩溃栈
adb -s <serial> shell run-as <pkg> ls -la                     # 仅 debuggable(debug) build 可用
```

`run-as` 可进 `/data/user/0/<pkg>` 读私有文件与 SQLite；release（非 debuggable）包会报 `package not debuggable`。

## 五、命令行断点调试（JDWP + jdb）

Android 的可调试进程通过 JDWP 暴露，没有 GUI 也能挂调试器：

```bash
timeout 5 adb -s <serial> jdwp                 # 列出可调试 pid；该命令是流式的，必须加 timeout，否则挂住
adb -s <serial> forward tcp:8700 jdwp:<pid>
printf 'threads\nquit\n' | "$JAVA_HOME/bin/jdb" -attach localhost:8700
# 脚本化命令：stop in/at 下断点、next/step 单步、print/locals 看变量、suspend/resume 控制 VM、where all 看栈
adb -s <serial> forward --remove tcp:8700
```

- `jdb` 在 JDK 内，Android Studio 自带 JBR 里就有（`$JAVA_HOME/bin/jdb`）；连上后能列线程栈、挂起/恢复 VM、下断点、单步——等价于 attach 式调试，只是没有图形界面。
- 只能调试 **debuggable** 包；`adb jdwp` 里没有 pid = 包不可调试或进程未起。
- 调试完 `forward --remove`，别留端口转发。

## 六、真机

`adb devices -l` 显示 `unauthorized` = 设备未授权，**必须在设备屏幕上点「允许 USB 调试」**，AI 无法代点；不要反复 unplug / restart adb 试图绕过。授权后流程与模拟器完全一致，只把 `-s` 换成真机序列号。
