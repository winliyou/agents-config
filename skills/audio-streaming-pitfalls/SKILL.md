---
name: audio-streaming-pitfalls
description: 跨设备实时音频流（采集→传输→播放）的正确架构与做法：WASAPI Loopback 捕获要点、float 全链防削波、AudioWorklet 环形缓冲播放、协议版本防呆、CDP 抓包分析方法。触发：Windows 系统声音捕获/映射、WASAPI Loopback、miniaudio 音频、Web Audio 播放破音/断续/电流声、音频串流实现或排查、实时音频 PCM 传输。
---

# 跨设备实时音频流：采集 → 传输 → 播放

实测架构（桌面端串流：Windows 游戏音频 → macOS 播放，2026-10-18 用户确认声音正常）：

## Windows 系统声捕获（WASAPI Loopback / miniaudio）

- 用设备**默认周期**与默认缓冲，不要手动指定毫秒周期（与设备实际周期错配会产生交替性空数据）。
- **SILENT 标志必须处理**：`AUDCLNT_BUFFERFLAGS_SILENT`(0x2) 时缓冲数据未定义，当音频播 = 电流声。
  miniaudio 0.11.25/26 不处理，需 patch：fork 模块后在 capture 分支补
  `ma_zero_memory_64(pMappedBufferCapture, cap * ma_get_bytes_per_frame(fmt, ch))`
  （函数名是 `ma_zero_memory_64`，不存在 `ma_zero_memory`）。
- **DATA_DISCONTINUITY**(0x1) 包丢弃并输出静音帧（撕裂/丢弃的数据不可播，静音帧维持时间轴）。
- 捕获缓冲给足（200ms）+ 捕获线程注册 **MMCSS "Audio"** 任务
  （avrt.dll `AvSetMmThreadCharacteristicsW`）：游戏满载 CPU 时音频线程不被饿出调度。
- 捕获线程的回调/统计必须无锁或 atomic——音频实时线程阻塞会与初始化路径互等死锁。
- float32 共享模式混音样本可 >1.0（混音域不削波），解码为归一化 float 时**保留原值不钳位**。

## float 全链（防削波破音）

- 采集、传输、缓冲、播放**全程 float32**。任何 float→int16 的提前转换 = 破音源头
  （超界硬钳位不可逆）。带宽代价（48kHz 立体声约 384KB/s）局域网可接受。
- 软限幅放最后，**只衰减永不放大**：`if peak > 0.95 { gain = 0.95/peak }`，随后缓慢恢复到 1。

## AudioWorklet 环形缓冲（播放端标准架构）

- worklet 内 ring buffer：主线程 postMessage 写入、音频线程顺序读取（天然无缝无重叠）。
- **100ms 预缓冲**吸收网络抖动；欠载后重新 priming（恢复无碎音）；溢出丢最旧（延迟恒定）。
- 系统声/麦克风**各持独立 ring**，共用时间轴会互相推挤产生杂音。
- 静音帧也要写入 ring 推进时间轴（直接丢弃会导致时间轴漂移 → 调度重置爆音）。

## 协议版本防呆

- PCM 格式升级必须两端同时生效。能力广播携带 `audio_format`（如 "f32le-48000-stereo"），
  前端检测不一致时**禁用映射 + 明确提示两端更新**（防呆优先于容错）。

## 排障方法

- 两端版本一致性先确认（/api/self 的 build_time），再看数据。
- 抓前端实收 PCM（浏览器实例的启动与 CDP 连接按 `browser-automation-safety` skill 红线：不得自行 spawn Chrome、
  不写自研 CDP 管线）→ CDP `Network.enable` → `Network.webSocketFrameReceived`（payloadData 为 base64，
  opcode 2 是二进制）→ numpy 分析削波/超界样本/跳变分布/重复块/静音段/频谱。
- node 的 WebSocket 二进制帧默认是 Blob，必须显式 `ws.binaryType = 'arraybuffer'`（否则统计恒 0）。
- 音频特征判断：真实音频为多频成分连续波形；恒定幅度周期信号或大量 DC 分量 = 非音频内容。

## 播放端解码能力差异（WebCodecs 并非全平台）

- **Chrome/Edge/WebView2 有 `AudioDecoder`；Safari 与 WKWebView 没有**：2026-10-21 实测 macOS 15.8 的
  WKWebView 里 `typeof AudioDecoder === 'undefined'`（`VideoDecoder` 存在）。Safari 浏览器同理。
- 危险的自检陷阱：这类 WebView 里 `isSecureContext === true`、AudioWorklet 可用，于是
  "Web Audio 能跑"会被误判成"Opus 能解码"；表现为**WS 有音频字节流入（码率正常）但完全无声**。
- 不要假设所有客户端能解 Opus。正确做法是按客户端能力分流：
  1. 客户端连接时声明能力（如信令里带 `pcm: typeof AudioDecoder === 'undefined'`）；
  2. 源端仍只传 Opus（带宽约 PCM 的 1/24）；
  3. **接收端中继进程**把 Opus 用 libopus 解码成 float32 PCM，只发给声明 pcm 的客户端；
     有解码器的客户端继续收 Opus。可加 `/api/status` 的"pcm 客户端数"做诊断。
  4. 不要为图省事给所有客户端统一下发 PCM：手机/局域网带宽会膨胀约 24 倍。
- 服务端解码器要**按音频流各持一个实例**（Opus 解码器有状态，系统声/麦克风混用会状态错乱）；
  解码失败回退只发 Opus，保证有解码能力的客户端不受影响。
- 自绘 scheme 页面（如 `wails://wails/`）里 `location.host` 是 scheme 主机名（`wails`），
  用 `协议//location.host` 拼 WebSocket 地址会得到 `ws://wails/ws` 并必然 1006 失败；
  桌面壳内必须显式连 `ws://127.0.0.1:<port>`，端口从自有 HTTP API 读取（不要写死）。
