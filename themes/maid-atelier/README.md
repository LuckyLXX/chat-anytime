# 深海女仆工坊 · PiDesktop 移植版

从 DeepSeek Harness 皮肤 **dsh-deep-whale / maid-atelier**（作者 Small-tailqwq）移植的
PiDesktop 结构主题。纯 CSS + 资产目录，无脚本、无 DOM 注入。

## 安装

设置 → 外观 →「导入主题目录」→ 选择本文件夹（`maid-atelier`）。
主题目录会读取 `theme.css` 顶部的 `Theme Name` 注释作为主题名。

## 素材来源与许可（重要）

- 本主题仅提供**结构展示层移植**，素材整体沿用原皮肤许可：
  **CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享），禁止商业使用**。
- 形象署名链（一创 上善 → 二创 zipzip → 三创 Small-tailqwq）见原皮肤仓库
  `dsh-deep-whale/maid-atelier` 的 `NOTICE` 与 `LICENSE`。
- 请不要把本目录当作 PiDesktop 仓库的一部分分发；分享时连同此 README 一起。

## 主题内容（与 dsh-deep-whale 的对应）

| 要素 | DSH 皮肤实现 | 本主题实现 |
| --- | --- | --- |
| 宫殿壁纸（亮/暗） | body 背景图 + JS 切换 | `--chat-bg-image` 双模式（`data-theme-effective`） |
| 双女仆立绘 | 注入 fixed `<img>`（含暗色 filter） | `--pi-layer-maid-left/right` 声明层；暗色用预调暗的 `*-dark.webp` 变体（背景无法 filter，故用素材变体代替） |
| 着陆/对话两档构图 | JS 投影 `data-maid-chat-active` | `:root:not([data-ui-chat-empty])` 级联切换（纯 CSS） |
| 顶栏织带 + 蝴蝶结 | 注入 trim div | `[data-pane="topbar"]` 平铺织带 + `::after` 蝴蝶结 |
| 底部饰带 + 徽章 | 注入 div，按状态位移 | `--pi-layer-bottom-band/crest`，对话时收起 |
| 侧栏画框四角 | 注入 4 个 corner（CSS 翻转） | `::before` 多背景 + 预镜像素材（CSS 背景无法翻转） |
| Q 版吉祥物 | 注入 `<img>` | `[data-pane="sidebar"]::after` |
| 蕾丝按钮（新会话/设置） | border-image 9 宫格 | 同款 `border-image-slice` 直接迁移到 `[data-control=…]` |
| 输入栏镂空画框 | border-image ::before | 同款迁移到 `[data-pane="composer"]::before` |
| 衬线字体 | Georgia / Times | `--maid-serif` 作用于标题类与侧栏按钮 |
| 生成中状态动画 | 预留钩子 | `[data-ui-generating]` + `prefers-reduced-motion` 守卫 |

## 已知差距（测试时重点看这些）

1. **无 JS 可言的行为**：favicon / 窗口标题 / 侧栏宽度逐帧联动不存在；侧栏几何偏移使用应用公开量 `--layout-sidebar-width`（侧栏将来可拖宽也跟随）。
2. **状态钩子粒度**：着陆/对话两档由 `:not([data-ui-chat-empty])` 表达；思考/工具运行的逐节点状态已随应用提供 `data-node-kind` / `data-node-state`（主题可做扫光动画，本主题暂未使用）；侧栏视图状态 `data-ui-sidebar-view` 可选用于分区重设计。
3. **画框被裁切**：输入框画框向左右各伸出约 70px，会话区宽度 < ~890px（如打开预览面板或窄窗口）时两侧会被 `overflow: hidden` 裁掉；底部被裁 1~3px 可忽略。顶部织带区与最后一条消息间距固定由 `--composer-space`（高度+40px）决定，画框上沿再高 ~52px，长对话末条贴底时蝴蝶结会浅浅压在气泡上（可接受；要更干净可给输入栏再减 `inset`）。
4. **区域内的类名命中**：`[data-pane="sidebar"] .session-list` 等属于"事实稳定、无契约"层级；应用侧已修复 `.agent-list` 类名撞车（设置页改用 `settings-agent-list`），深色主题不会再泛白。
5. **透明度滑块**：壁纸/气泡透明度滑块仍生效（主题声明的 `--chat-bg-opacity` 会被滑块覆盖）；面板透明度滑块的 `--panel-alpha` 作用于应用侧 `color-mix` 面板底色（本主题侧栏/顶栏直接覆盖 background，滑块对这两处无效；输入框/对话框/预览遵循 `--panel-bg-composer/dialog/preview`，滑块生效）。
6. **检查器说明**：以 `Theme Type: structural` 声明，仅校验实际重定义的颜色对；`check_theme.py` 全部通过（含装饰层引用、`border-image` 切片尺寸校验）。

## 调参手位

- 立绘大小/位置：`theme.css` 第 3 节四个 `--pi-layer-maid-*` 块（含 `@media (max-width: 1080px)`）；侧栏偏移用 `var(--layout-sidebar-width)`。
- 画框视觉厚度：`[data-pane="composer"]::before` 的 `border-width` / `inset`（与 `border-image-slice` 联动）。
- 蝴蝶结偏移：`[data-pane="topbar"]::after` 的 `left: calc(50% + var(--layout-sidebar-width) / 2)`。
- 侧栏画框：`[data-pane="sidebar"]::before`；吉祥物：`[data-pane="sidebar"]::after`（bottom 148px / 200×178，站在织带上方）。
- 侧栏纵列重排：`[data-pane="sidebar"] > ... { order: N }` 把「新建话题」提到品牌卡下方（还原 DSH 构图）；会话列表底部渐隐遮罩在 `[data-pane="sidebar"] .session-list` 的 `mask-image`。
