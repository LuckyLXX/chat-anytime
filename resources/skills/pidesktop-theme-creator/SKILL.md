---
name: pidesktop-theme-creator
description: 创建、审查与修复 PiDesktop 主题——明暗双模式语义 CSS 变量、无障碍对比度、结构钩子（data-pane / data-control / data-role）、状态反应式样式、视口装饰层、壁纸与字体资产包。用于设计 PiDesktop 主题、重设计输入框/按钮/面板、修复暗色模式不可读的配色、生成主题 CSS、导入主题目录或审查主题变量覆盖度。
---

# PiDesktop 主题创建器

为 PiDesktop 桌面客户端生成主题。一份主题 = 一份 CSS + 可选资产（壁纸图片、字体文件），以目录形式导入。颜色、字体、布局、动画、视口画面都是主题的领地；行为与 DOM 结构不是——主题按设计只含纯 CSS。

## 主题类型

- **调色板主题**（默认）：在明、暗两种模式下重定义全部语义 token（84 个变量）。起始模板产出的就是这一类。
- **结构主题**：通过稳定钩子契约重设计页面元素，和/或叠加装饰层与字体包，构建在内置 token 基底之上。在头注释声明 `/* Theme Type: structural */`，检查器随即放宽全量覆盖要求，只对主题实际重定义的颜色对做对比度校验。

单个主题可以两者兼得：完整调色板与结构规则随意并存。

## 工作流

1. 写 CSS 前先读 `references/variables.md`。在仓库内工作时，还应查看 `src/renderer/src/styles.css` 与 `src/renderer/src/lib/theme-presets.ts`，并把仓库指南 `docs/theme-guide.md` 交给主题使用者。
2. 明、暗两套色板独立设计。不要把浅色板简单反相当作深色文本或状态色。
3. 调色板主题：两种模式下写全所有必需变量。输出最终的 `hex` / `rgb()` / `rgba()` 值——内嵌 Chromium 必须能脱离新式 CSS 函数解析它们。
4. 运行 `scripts/check_theme.py <theme.css>`，交付前修掉所有覆盖度、对比度、钩子名、可移植性错误。
5. 资产引用保持相对路径（`url("wallpaper-dark.png")`、`url(brand.woff2)`），文件与 CSS 同目录，在 PiDesktop 中导入整个目录。绝不在可编辑 CSS 里内嵌 base64。
6. 双模式预览内容：正文、用户气泡、行内代码、围栏代码块、表格、状态块、Diff、Mermaid 图、HTML 片段。设置里的实时预览只展示 token 与气泡；装饰层、动画与状态反应只在主窗口可见。只看深色背景不构成有效验证。
7. 结构类改动只瞄准契约钩子——`data-pane` 区域、`data-control` 控件、`data-role` 消息角色、`data-ui-*` 状态属性、`--pi-layer-*` / `--pi-overlay-*` 装饰层变量——绝不使用裸类名。

## CSS 形态

在文档根上写显式的模式规则：

```css
:root[data-theme-effective="light"] {
  --surface: #ffffff;
  --text: #1e293b;
}

:root[data-theme-effective="dark"] {
  --surface: #0f172a;
  --text: #f8fafc;
}
```

用户或系统切换模式时，应用会在 `<html>` 上切换 `data-theme-effective`，两组规则始终生效、无需重载主题。裸 `:root` 规则会被导入器自动附加作用域与优先级；请用上面的显式模式选择器，不要依赖优先级技巧。用头注释命名主题——`/* Theme Name: 我的主题 */`——目录导入会自动读取。

> 旧格式导入：PiDesktop 之前模板时代的 CSS 仍可导入，运行时会自动转换其变量别名与模式选择器；请不要再用该格式创作新主题。

## 结构钩子

完整契约与取值见 `references/variables.md` → 结构主题；速览：

| 钩子 | 形态 |
| --- | --- |
| `data-pane` | 主要区域（37）：`sidebar` `topbar` `workspace` `work-area` `conversation` `timeline` `composer` `task-panel` `memory-panel` `preview` `terminal` `ssh` `ssh-files` `question-panel` `settings-dialog` `permission-dialog` `landing` `turn-minimap` `markdown-outline` `design` `design-toolbar` `design-tools` `design-canvas` `design-layers` `design-inspector` `gallery-menu` `gallery-wall` `automation-settings` `automation-dialog` `agent-settings` `general-settings` `model-settings` `resource-settings` `appearance-settings` `subagent-settings` `hooks-settings` `usage-settings` |
| `data-role` | 消息条目：`user` `assistant` `extension`——只有这三个在契约内。界面里另有同属性名的内部标记（Jev 测试结果行、自动化徽标等），不在契约内，检查器会拒绝 |
| `data-control` | 关键控件（92）：`new-session` `settings` `workspace-open` `preview-toggle` `preview-outline-toggle` `task-panel-toggle` `memory-toggle` `send` `stop` `attach` `queue-edit` `queue-send-now` `queue-remove` `access-mode` `plan-toggle` `model-select` `thinking-select` `thinking-expand` `context-usage` `browser-pick` `browser-download-toggle` `copy` `edit` `regenerate` `share` `pane-maximize` `pane-close` `automation-open` `automation-run` `automation-toggle` `automation-runs-tab` `ssh-open` `ssh-host-create` `ssh-host-save` `ssh-host-connect` `ssh-trust-fingerprint` `ssh-group-create` `ssh-group-save` `ssh-files-toggle` `ssh-upload` `ssh-download` `ssh-transfer-cancel` `ssh-host-delete` `gallery-toggle` `gallery-publish` `gallery-run` `gallery-develop` `gallery-open-wall` `gallery-remove` `computer-toggle` `design-toggle` `design-send-ai` `design-export` `design-undo` `design-redo` `design-tool-select` `design-tool-frame` `design-tool-rect` `design-tool-text` `design-layer-lock` `agent-new` `agent-save` `settings-version` `jev-test` `jev-expand` `capability-switch` `model-provider-add` `model-provider-delete` `model-save` `model-refresh` `model-add` `model-thinking-levels` `model-thinking-panel` `resource-reload` `mcp-add` `mcp-save` `command-add` `command-save` `appearance-import-css` `appearance-import-theme` `appearance-clear-css` `appearance-save-theme` `appearance-save` `subagent-add` `subagent-save` `hooks-enable` `hooks-add` `hooks-save` `hooks-trust` `hooks-run-log` `hooks-template` `usage-agent-filter` |
| `data-ui-*` | `<html>` 上的布尔状态：`settings-open` `workspace-open` `chat-empty` `generating` `preview-open` `preview-fullscreen` `permission-pending` `question-pending` `attachments` `split-open` `design-open` `sidebar-collapsed` `session-multiselect`（话题列表多选：批量归档 / 恢复 / 删除）；带值：`sidebar-view`（`topics` `files` `archived`）、`density`（`compact` `comfortable` `relaxed`）、`radius`（`square` `small` `medium` `round`）、`motion="off"`（用户关闭界面动效，主题无需响应） |
| `--pi-layer-<name>` | 视口 `background` 简写，画在壁纸之上、界面之下 |
| `--pi-overlay-<name>` | 同上，画在界面之上、对话框/菜单之下 |

装饰层名为小写 `[a-z0-9-]`，按自然数字顺序叠放（`a-2` 在 `a-10` 之下），渲染为 `pointer-events: none` 的图层，且经由 CSS 级联解析——按模式分别声明即可得到明暗两套画面。

### 多实例、折叠与模式（写规则前先看一眼）

- **分屏**：`conversation` / `timeline` / `composer` / `question-panel` 同页可出现多次（每格一套实例）；焦点格的 conversation 区域带 `data-pane-active`。`data-ui-generating` / `chat-empty` / `attachments` 的语义是**焦点格**，`[data-ui-generating] [data-pane="composer"]` 会同时命中所有格子——只想打焦点格就叠加 `[data-pane="conversation"][data-pane-active]`。`--composer-space` / `--composer-height` 每格独立（写在各自的 conversation 区域上），`data-ui-split-open` 存在即分屏；格头控件是 `pane-maximize` / `pane-close`。
- **侧栏折叠**：`data-ui-sidebar-collapsed` 存在即图标窄条，此时 `[data-pane="sidebar"]` 命中的是 48px 竖条而不是整栏——立绘偏移、内边距、伪元素装饰都要按 `--layout-sidebar-collapsed-width`（48px）兜底，否则装饰会被塞进窄条。窄条上的按钮（展开、话题、搜索、助手入口）不在契约内，别依赖。
- **设计模式**：`data-ui-design-open` 存在即设计工作台替换常规会话布局（与分屏、预览互斥）；外壳 `design`，内含 `design-toolbar` / `design-layers` / `design-canvas` / `design-inspector`，画布左上还有浮动绘图工具胶囊 `design-tools`（其按钮 `design-tool-*` 带 `aria-pressed`）。工作台底色走 `--panel-bg-preview`（缺省 `--panel-bg`）。
- **界面微调**：`data-ui-density` / `data-ui-radius` 由设置【外观 → 界面微调】写入，对应 `--ui-density-scale` / `--ui-control-radius` / `--ui-container-radius`。主题可以覆盖这三个 token，也可以完全忽略这两个属性。

## 控件与结构重设计

当主题要重设计页面元素（输入框、按钮、面板）而不只是调色时：

- 用钩子限定作用域：`[data-pane="composer"] [data-control="send"]`、`[data-pane="composer"] textarea`。裸类名是实现细节，应用升级时会悄悄失效；检查器会拒绝未知的钩子名，拼写错误立刻暴露。
- 覆盖层级：契约控件最优先；钩子区域内用元素选择器统改（`[data-pane="sidebar"] button`、`[data-pane="settings-dialog"] select`）同样跨版本安全；区域内的类名命中事实稳定但无契约；右键菜单、toast、重命名小对话框和内嵌编辑器（vditor、Mermaid）在契约之外，只受颜色 token 影响。完整表见 `references/recipes.md`。
- 表达力技法（立体按钮、clip-path 异形、霓虹描边、渐变文字、玻璃拟态、漂移网格、CRT 扫描线、状态反应等）在 `references/recipes.md` 里备有参考配方——**把它们当作起点和灵感库，混合、拆解、超越都欢迎**，创意不受其限制；每条配方附带的注意事项（而非其具体写法）仍然适用。
- `data-control="send"` 与 `data-control="stop"` 要一起重设计——它们占据同一位置、按生成状态互换。状态效果搭配 `[data-ui-generating]`，分屏下要打焦点格就再叠 `[data-pane-active]`。
- 每个交互状态必须保持可辨：hover、`:focus-visible`、`disabled`、`aria-expanded` 的样式差异不能抹掉。移除 outline 前必须给出替代焦点指示（例如用 `--focus-ring` 画 `box-shadow` 光环）。
- 控件命中目标不要缩到 28px 以下；重上色 accent 填充按钮时保证 `--text-on-accent` 可读。
- 布局随意改（尺寸、圆角、边框、定位、动画、经 `@font-face` 的字体），行为不行：无脚本、不新增元素。装饰画面放进 `--pi-layer-*` / `--pi-overlay-*` 或钩子区域的伪元素。
- 动效包进 `@media (prefers-reduced-motion: no-preference)`，尊重系统的减少动态偏好。

## 无障碍规则

- 普通文本至少 4.5:1，大字号文本与 UI 符号至少 3:1。
- 前景 token 与其底面分开定义。尤其是 `--text-on-accent`、`--text-on-user-bubble`、`--avatar-user-text`、`--avatar-assistant-text` 必须显式设置。
- 行内代码要有自己的 `--inline-code-surface` 与 `--inline-code-text`。不要把深色 accent 当作行内代码文字压在另一个深色底上。
- `--text-sidebar-active` 要对着 `--surface-sidebar-active` 校验；状态前景色对着各自的 soft 底色校验。
- 代码文本与每个语法 token 都要在 `--code-surface` 上可读；弱化的注释色也要保持可用对比度。
- 焦点、选区、链接、hover 状态的可见性不能依赖壁纸亮度。
- 不要用 `color-mix()`。输出最终的 `hex` / `rgb()` / `rgba()` 值，保证主题跨内嵌 Chromium 版本可移植。
- 不要把 `--surface` 直接当作彩色气泡、头像、按钮、徽章上的文字色，除非对比度检查证明了这一对组合。
- 覆盖层（`--pi-overlay-*`）画在内容之上：扫描线/暗角保持克制（深色线约 ≤12% 透明度），开启覆盖层后复查正文可读性。

## 壁纸规则

明暗壁纸需要不同对比度时使用两个文件。`--chat-bg-opacity` 保守取值，面板保持足够不透明以承载文字。应用会把导入的资产文件复制到 agentDir 的主题目录并改写相对 URL（`pidesktop-file://theme/…`），CSS 里保留相对 URL，文件才可移植、可编辑。导入有体积上限：单文件 8 MB / 单主题合计 32 MB / CSS 512 KB（超限中止导入，不写半个文件）；允许的扩展名 `png jpg jpeg webp gif avif svg woff2 woff ttf otf`。声明任何非 `none` 的 `--chat-bg-image` 会自动启用应用的面板半透明处理。

## 字体规则

字体文件（`.woff` / `.woff2` / `.ttf` / `.otf`）与 CSS 同目录，相对引用：

```css
@font-face { font-family: "Brand"; src: url(brand.woff2) format("woff2"); }
:root { font-family: "Brand", "Microsoft YaHei", system-ui, sans-serif; }
```

展示字体后面务必跟一个支持 CJK 的回退字体——界面文案是中英混排的。目录导入会把字体文件与图片一起收集。

## 资源

- `references/variables.md`：完整语义 token 契约、推荐对比度对、结构主题钩子契约（含分屏多实例、侧栏折叠、设计模式、界面微调四个主题域与精灵陷阱清单）。
- `references/recipes.md`：创意参考配方——覆盖层级表、立体按钮、clip-path 异形、霓虹描边、渐变文字、玻璃拟态、网格装饰层、CRT 扫描线、状态反应。
- `assets/theme-template.css`：复制并填充这份明暗双模式起始模板（内含注释掉的结构扩展块）。
- `scripts/check_theme.py`：确定性的 token 覆盖度、`color-mix()`、壁纸、装饰层名、钩子名与对比度检查器；识别 `Theme Type: structural`。
