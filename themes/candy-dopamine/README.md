# 马卡龙多巴胺乐园 · PiDesktop

原创马卡龙糖果系「多巴胺」结构主题。纯 CSS + 资产目录，无脚本、无 DOM 注入。
治愈系低饱和亮粉 / 薄荷 / 奶黄 / 香芋紫，两位动漫元气少女立绘分列左右。

## 安装

设置 → 外观 →「导入主题目录」→ 选择本文件夹（`candy-dopamine`）。
主题目录会读取 `theme.css` 顶部的 `Theme Name` 注释作为主题名。

## 素材

| 文件 | 用途 |
| --- | --- |
| `assets/bg-day.webp` | 浅色模式壁纸（马卡龙糖果渐变 + 散落马卡龙） |
| `assets/bg-night.webp` | 深色模式壁纸（深紫夜幕 + 发光马卡龙） |
| `assets/mascot-left.webp` | 左侧立绘（粉发粉裙少女，透明背景） |
| `assets/mascot-right.webp` | 右侧立绘（薄荷发紫裙少女，透明背景） |
| `assets/top-trim.webp` | 顶栏底边糖果条纹砖（repeat-x） |

- 立绘经边界泛洪抠图去除近白背景，保留透明通道（webp 带 alpha）。
- 所有图片以相对路径引用，与 CSS 同目录；导入主题目录时一并收集。

## 主题内容

| 要素 | 实现 |
| --- | --- |
| 马卡龙壁纸（明/暗） | `--chat-bg-image` 双模式（`data-theme-effective`） |
| 双立绘 | `--pi-layer-mascot-left/right` 声明层；暗色经 `[data-layer-kind="layer"]` 滤镜压暗并加深投影 |
| 着陆 / 对话两档构图 | `:root:not([data-ui-chat-empty])` 级联纯 CSS 切换（着陆放大，对话退边缩小） |
| 顶栏糖果条纹底边 | `[data-pane="topbar"]::after` repeat-x |
| 侧栏香芋糖果渐变 | `[data-pane="sidebar"]` 双模式背景 + 局部 token 保证可读 |
| 输入栏奶油糖果玻璃 | `[data-pane="composer"]` 渐变 + 糖果描边 + 圆钮 |
| 生成中呼吸光环 | `[data-ui-generating]` + `prefers-reduced-motion` 守卫 |

## 已知差距

1. **立绘无 JS 可言行为**：着陆/对话两档由 `:not([data-ui-chat-empty])` 表达；侧栏偏移使用应用公开量 `var(--layout-sidebar-width)`（侧栏将来可拖宽也跟随）。
2. **透明度滑块**：壁纸/气泡/面板透明度滑块仍生效（主题声明的 `--chat-bg-opacity` 会被滑块覆盖）；面板各面底色遵循 `--panel-bg-sidebar/topbar/composer/dialog/preview`，滑块生效。
3. **装饰层命中**：立绘统一以 `[data-layer-kind="layer"]` 命中（本主题仅两个 layer，均为立绘），未使用 `data-theme-layer=<name>`（检查器对带前缀名的保守校验会误报）。
4. **区域内类名**：`[data-pane="sidebar"] .session-list` 等属「事实稳定、无契约」层级；类名变动时只降级对应小块。
5. **检查器**：以 `Theme Type: structural` 声明，仅校验实际重定义的颜色对；`check_theme.py` 全部通过（含装饰层引用、对比度、钩子名、资产存在性）。

## 调参手位

- 立绘大小/位置：`theme.css` 第 3 节 `--pi-layer-mascot-*` 三块（含 `@media (max-width: 1080px)`）；侧栏偏移用 `var(--layout-sidebar-width)`。
- 马卡龙色板：`theme.css` 第 1、2 节明暗两个 `:root[data-theme-effective=...]` 块的 `--candy-*` 与全套语义 token。
- 顶栏条纹：`[data-pane="topbar"]::after` 的 `height`（重复 tile 尺寸为 5px）。
- 输入栏玻璃/圆钮：`[data-pane="composer"]` 与 `[data-control="send"/"stop"]`。
