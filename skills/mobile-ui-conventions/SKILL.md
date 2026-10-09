---
name: mobile-ui-conventions
description: 移动端与 TV 端 UI 通用约定（跨 ArkUI / Compose / Android）：触控热区下限、长文本不挤压操作区、图标不用 Unicode 字符、纯图标元素必备无障碍文本、系统级返回与焦点、优先系统原生菜单而非自绘。触发：写或改移动端/TV 界面；新增按钮、chip、图标按钮、列表项、卡片；文本溢出或截断、大字体下布局错乱；控件点不中或热区过小；图标风格不一致；返回键/系统返回行为异常；TV 焦点框或选中态；弹出菜单、对话框、底部弹层样式与系统不一致；无障碍 / accessibilityText / contentDescription。
---

# 移动端与 TV 端 UI 通用约定

跨项目、跨技术栈通用的界面约束（ArkUI/ArkTS、Jetpack Compose、Android TV、HarmonyOS）。
**具体 token 名、档位表、组件与主题体系见各项目自己的 skill**，本文件只记与项目无关的硬性约束。

这些约束在 `media_app`（Kotlin/Compose，TV）与 `music_app`（ArkTS/ArkUI，手机）两个不同仓库、不同技术栈中被**独立重复验证过**——属平台级常识，故上提到用户级。

## 1. 可操作面积不能小于触控下限

- 可聚焦/可点击控件（按钮、chip、图标按钮、列表行）必须保证足够热区，**用约束最小尺寸而非固定高度**，避免被父布局压缩：
  - ArkUI：`constraintSize({ minHeight })`，图标按钮用 padding 补足；官方底线 ≥40vp（推荐 46）
  - Compose/TV：`requiredHeight` / `requiredSize`（`required*` 不被父级压缩），**不要**用普通 `height` / `size`
- 图标按钮尤其容易踩：视觉尺寸可以小，但**热区必须补够**。

## 2. 长文本不得挤压操作区

- 所有可能过长的文本（标题、简介、错误文案、分类名、按钮文案）必须设 `maxLines` + 省略：
  - ArkUI：`maxLines` + `textOverflow({ overflow: TextOverflow.Ellipsis })`
  - Compose：`maxLines` + `TextOverflow.Ellipsis`
- 「文案 + 主操作」布局中**主操作区优先保留空间**；长简介先折叠，超出后用「查看详情」进入独立弹层阅读，**不要在页面原布局里无限撑开**。
- 固定高度容器（搜索框、菜单行、pill）改用最小尺寸约束，**系统大字体时要能随内容撑高而不是截断**。

## 3. 图标不用 Unicode 字符代替

播放、暂停、搜索、清除、箭头等图标一律用矢量/组件绘制（Canvas、vector、系统 symbol）。
**禁止把 `▶`、`⏸`、emoji 等 Unicode 字符拼进 `Text` 当图标**——不同平台字体 fallback 会导致风格不一致、基线错位、颜色无法随状态变化。

## 4. 纯图标元素必须有无障碍文本

纯图标可点元素（无可见文字）必须提供无障碍描述：
- ArkUI：`accessibilityText`
- Compose：`contentDescription`
- **动态状态**（播放/暂停、喜欢/取消、开/关）的文案要随状态变化，而不是固定一句。

## 5. 返回与焦点走系统机制

- **屏幕级返回**用系统机制：Compose/TV 用 `BackHandler`；**不要**依赖子组件焦点或 `onPreviewKeyEvent` 捕获 Back。
- **焦点切换**走明确 API（如 `FocusRequester` / `focusProperties`），**不要依赖空间位置猜测**。
- TV 焦点态与选中态语义要分开：焦点 = 当前操作位置，选中 = 当前选项；**选中态不应强过焦点态**。

## 6. 弹层与菜单优先用系统原生组件

- 弹出菜单一律用系统原生 `Menu`/`MenuItem`/`MenuItemGroup`（ArkUI）或 Material 菜单，**不要自绘菜单卡片**：磨砂/圆角/行高/字号/按压反馈/分组分隔线由系统托管，深浅色自动适配。
- 自绘的典型症状：实心底 + 描边 + 重投影 = 与系统割裂的「Android 风格」；自绘玻璃（背景模糊）易出现**浅色模式浅底浅字**（已踩坑）。
- 破坏性操作（删除等）在原生菜单里没有红色危险项语义时，**用二次确认对话框**承接。
- **文本与开关必须显式指定前景/选中色**，不要依赖系统默认：默认色随系统主题变化，在自定义底色上会出现深底深字不可见（ArkUI 的 `TextInput` 需显式设 `fontColor`/`placeholderColor`，`Toggle` 需显式 `selectedColor`）。

## 7. 深浅色与主题一致性

- 强调色全项目唯一，不新增不一致的强调色；文字层级用固定的灰阶分级。
- accent 底色上的前景元素用固定的 `on_accent` 类色，不要复用 ink 底色。

## 8. 跨端通用：窄视口卡片文本逐字竖排（Web/CSS 实测，2026-09 CNM 项目）

> 本节虽是 Web/CSS 案例，但坑位在「窄视口（手机真机尺寸）」才暴露，故暂寄本 skill；纯 Web 项目读到此节同样适用。

- 现象：桌面正常的横排中文卡片，在 390px 真机尺寸下逐字竖排；排查时 DevTools
  计算值全正常（flex/padding/换行属性无一异常），属隐蔽布局债。
- 根因（两条，独立叠加）：
  1. 一条高特异度通配按钮规则（如 `.panel button`）覆盖了卡片自身的 padding，
     把卡片内容压到十几 px 宽，CJK 逐字断行（ASCII 无断点则整段溢出——两者并存
     即确诊）；桌面靠卡片宽度遮羞，窄屏全碎。解法：通配规则收敛到直接子级
     （如 `.panel > button`），嵌套按钮组各自写全样式。
  2. 容器偏窄时 flex-shrink 把卡片压到 CJK min-content（≈单字宽）才换行——换行
     永远等不到。解法：卡片 `flex-shrink: 0`（窄屏换行而非压字）或显式 min-width。
- 验证：真机尺寸 Playwright 截图 + 卡片高度断言（坏味道：卡高数倍于正常）；
  注意 flex column 卡片高度阈值要留字体差异余量。
