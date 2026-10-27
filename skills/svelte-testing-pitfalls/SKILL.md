---
name: svelte-testing-pitfalls
description: Svelte 5 编译/样式作用域与组件测试踩坑：注释里的标签字面量让编译器误报脚本块未闭合、@keyframes 被重命名导致内联 animation 与 animationend 失效、全局 runes store 响应式串扰与断言技巧、模板引用未导入标识符导致应用挂载崩溃且 vite build 不报错、模块导出 $derived 报 derived_invalid_export。触发：svelte-check 报 `<script>` was left open / element_unclosed；组件动画不播放或 animationend 不触发；内联 style 里写 animation；组件测试中切换 store 状态后断言 DOM；@testing-library/svelte 多次 render 对比；页面空白且控制台 ReferenceError；build 通过但界面不渲染。
---

# Svelte 5 组件测试：全局 runes store 串扰坑

（2026-10-08 实测于 Svelte 前端组件测试）

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
- bun install 在沙盒内报 `unable to write files to tempdir: EPERM`：错误文案有误导，真因是包缓存目录
  不可写；把该目录加进 sandbox-extra-roots 配置即可（见 `sandbox-adaptation`），不要重定向 `TMPDIR`（无效）。

## 测试替身掩盖传参类型错误 → NaN 传染（2026-10-08，某项目 实测）

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
## 坑：<script> 注释里写标签字面量 → 编译器报脚本块未闭合（2026-10-16 实测于 workwork admin UI）

在组件 `<script>` 块的 `//` 注释里出现 `<style>`（或任何标签字面量）时，
`svelte-check` 会报 **`<script>` was left open`**（`element_unclosed`），且**报错位置指向文件末尾/样式块**，
与真正出错的那行注释相隔上百行，极易误判成样式块或模板问题。

排查结论（二分验证）：把该文件拆成「只 markup / 只 CSS / markup+CSS / 原文件」四份副本逐个跑 `bun run check`，
前三份全绿、原文件报错；再 `diff` 隔离出唯一差异就是注释文本 → 注释里的 `<style>` 才是触发点。
**修法**：注释改用中文描述（"组件样式块"、"标签字面量"），不要在内联注释里写 `<xxx>` 形式的标签。

## 坑：内联 style 里写 animation + 组件内 @keyframes = 动画永不生效（同日实测）

Svelte 会给组件样式块里的 `@keyframes` **加作用域前缀**（`toastIn` → `svelte-1abc2de-toastIn`），
而内联 `style="animation: toastIn ..."` 里的名称是**字面量字符串**，永远不会被改写 ⇒：
动画不播放、`animationend` 永不触发（依赖它做 dismiss/清理的逻辑静默失效，只有 setTimeout 兜底才"看起来正常"）。

- 修法：动画声明放进组件样式块（如 `.toast-timed { animation: toastIn .25s, toastOut .3s var(--x) forwards; }`），
  用 `class:` 切换、用 CSS 自定义属性（`--toast-out-delay`）传每条数据的差异参数；
- `onanimationend` 里比较名字**不要用全等**（`e.animationName === 'toastOut'`），实际值是带前缀的
  `svelte-xxxx-toastOut`，要用 `e.animationName.endsWith('toastOut')`；
- `@media (prefers-reduced-motion: reduce)` 里 `animation: none` 会连 `animationend` 一起抑制，
  必须保留 JS 定时器兜底（注释里写明这一点）。


# Svelte 5 模板引用未导入标识符 → 整个应用挂载崩溃，构建不报错

（2026-10-18 实测于 某项目 Svelte 迁移；svelte@5.57.2 + vite@8.3.4）

## 症状

页面只渲染 CSS 背景色，`#app` 为空；控制台一条
`Uncaught ReferenceError: fetchPeers is not defined`（来源为构建产物 JS）。
**vite build 全程成功、无任何警告**——编译器把模板里的未导入标识符当作
全局引用合法输出，运行时组件初始化求值（如 `onclick={fetchPeers}` 在
创建 props 时就求值）即抛错，`mount(App)` 整体失败。

## 根因与排障

- 组件模板引用了既未 `import` 也未在组件内声明的标识符。本例是刷新按钮
  写了 `onclick={fetchPeers}` 而 import 清单漏了它。
- `vite build`（rolldown + svelte 插件）与 `svelte-check` 默认都不拦
  （未定义全局是合法 JS）。**只有真实浏览器运行才暴露**。
- 排障套路（无需任何测试框架）：
  ```bash
  chrome --headless --user-data-dir=<workspace 内目录> \
    --enable-logging=stderr --v=0 --virtual-time-budget=12000 \
    --dump-dom http://127.0.0.1:PORT/ 2>err.log
  grep -i CONSOLE err.log          # 直接看到 ReferenceError 与出错文件
  ```
  配合 `--screenshot` 前后对比（空白背景色 vs 完整 UI）确认修复。
  截图字节数也是快速信号：空白页仅 ~5KB，正常渲染 100KB+。

## 预防

- 组件写完后核对 import 清单与模板标识符一一对应；提取子组件时最容易漏。
- **UI 改动的完成验证必须包含真实浏览器渲染检查**（headless 截图 +
  console 抓取即可），构建通过不等于能跑。
