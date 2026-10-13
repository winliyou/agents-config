---
name: svelte-testing-pitfalls
description: Svelte 5 组件测试踩坑：全局 runes store 响应式串扰与断言技巧。触发：组件测试中切换 store 状态后断言 DOM；@testing-library/svelte 多次 render 对比；Svelte $derived 读全局 store 的组件。
---

# Svelte 5 组件测试：全局 runes store 串扰坑

（2026-10-08 实测于 hotspot 前端 MapPinMarker/MapHeatDot 测试）

## 坑：切 store 后「旧实例」的 DOM 被同步改写

组件内 `$derived` 读取全局 runes store（如 `mapSourceStore.source`）时，测试里
`render()` 出的实例是**活着的**——在同一个 `it` 内 `setMapSource('osm')` 会触发
**第一个实例**的 derived 重算与 DOM 更新。表现为：先 render 读值、再切 store、
再 render 第二个实例对比，两者**恒等**，断言 `not.toBe` 必挂。

## 正确写法

```ts
setMapSource('amap');
const a = render(Comp, { props });
const aLeft = a.container.querySelector('button')!.style.left; // ① 先快照
a.unmount();                                                    // ② 再卸载
setMapSource('osm');
const b = render(Comp, { props });
expect(aLeft).not.toBe(b.container.querySelector('button')!.style.left);
```

快照字符串 + unmount，二者缺一不可（只快照不卸载，响应式仍会改实例内部状态）。

## 附带坑：`as never` 不能 spread

测试工厂函数返回 `{...} as never` 后，`{ ...factory(), extra }` 直接 TS 报错
"Spread types may only be created from object types"。修法：工厂返回具体对象类型，
在使用点（传给强类型 props 处）再 `as never` 收敛。

## DSH 环境注意（2026-10-08 实测）

- 多个 edit 用 `Promise.all` 并发改**同一文件**会静默丢失部分 edit——同文件多处修改
  串行执行，或一次 node 脚本完成；
- edit 工具 old_string 报 not found 但文本肉眼可见存在时，直接 node 正则替换更快；
- bun install 在沙盒内报 `unable to write files to tempdir: EPERM`：`TMPDIR` 单独
  重定向无效——真因是包缓存 `~/.bun/install/cache` 不可写，bun 的错误文案有误导
  （bun 本身读 TMPDIR，不要被「bun 不读它」之类的错误归因带偏），用
  `bun install --cache-dir <workspace 内目录>` 即可过；权威解法（TMPDIR + 缓存变量
  全部落 workspace）见 `sandbox-adaptation` skill「bun install 报 tempdir EPERM」一节。

## 测试替身掩盖传参类型错误 → NaN 传染（2026-10-08，fft_cover 实测）

**症状**：重写 `scheduleAmbient` 后，"稀疏性"测试失败显示平均间隔异常小；
插桩发现游标 `nextAt` 第一轮就变 `NaN`，循环只走一轮——但所有 rnd 序列、
手动复算全部正常，极易误判成随机数或循环条件问题。

**根因**：把回调传成了函数本身——`nextNoteDelay(rnd, intensity)`（少写 `()`），
而 `nextNoteDelay(rnd: number, ...)` 内部 `Math.min(1, rnd)` 对函数返回 `NaN`，
NaN 一路传染进 `state.nextAt`。`while (x < NaN)` 恒 false，循环静默退出、不抛错。

**为什么编译器/测试没拦住**：测试里 AudioContext 全是
`fakeAc() as unknown as BaseAudioContext`，`as unknown as` 双重断言关掉了
整个参数面的类型检查；NaN 比较（`<`、`>`）全部返回 false，不抛异常。

**排障套路**：
1. 循环"只跑一轮"先打印循环变量的**每个分量**（gap、delay 各自打印），
   而不是打印总和——总和 NaN 无法定位来源；
2. 确认每个分量非 NaN 后，怀疑**传参对象/类型**：打印 `typeof rnd`；
3. `Math.min/max` 收到非 number 会静默返 NaN——凡"收窄到 [0,1]"的代码都值得查实参。

**预防**：测试替身避免 `as unknown as` 双重断言，至少给关键方法保留签名；
数值游标出现 NaN 时尽早 fail-fast（`console.assert(Number.isFinite(nextAt))`）。
