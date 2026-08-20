# 主题编写指南

自定义主题是一份 CSS（可选：同目录图片 / 字体资产）。导入方式：设置 → 外观 →「导入 CSS」或「导入主题目录」（目录内放 `theme.css` 与用到的资产文件）。主题 CSS 原样注入页面，不做选择器过滤——颜色、字体、布局、动画都可以改。

## 明暗模式

用 `data-theme-effective` 区分模式，应用会跟随系统/用户选择自动切换：

```css
:root[data-theme-effective="light"] { --surface: #ffffff; }
:root[data-theme-effective="dark"]  { --surface: #0f172a; }
```

旧版模板（`html.theme-light` / `--bg-primary` 等历史写法）导入时会自动转换，无需手工迁移。

## 颜色 Token

主题通过覆盖语义变量换肤（完整清单见 `pidesktop-theme-creator` skill 的 `references/variables.md`）。核心几组：

| 用途 | 变量 |
| --- | --- |
| 表面 | `--surface` `--surface-muted` `--surface-raised` `--surface-sidebar` `--surface-conversation` |
| 文本 | `--text` `--text-muted` `--text-on-accent` `--text-on-user-bubble` |
| 强调 | `--accent` `--accent-hover` `--accent-soft` `--accent-text` `--focus-ring` |
| 气泡 | `--user-bubble` `--user-bubble-border` `--ai-bubble` `--tool-bubble-bg` |
| 代码 | `--code-surface` `--code-text` `--inline-code-surface` `--syntax-*` |
| 状态 | `--success` `--danger` `--warning` 及其 `-soft` / `-text` |

## 结构钩子（公开 API）

类名属于实现细节，可能随版本变化；以下属性是稳定契约，结构化主题请只依赖它们：

**区域钩子 `data-pane`**：`sidebar` `topbar` `work-area` `conversation` `timeline` `composer` `task-panel` `memory-panel` `preview` `terminal` `question-panel` `settings-dialog` `permission-dialog`

> `terminal` 是预览面板内的嵌入式终端区域（xterm.js 宿主）。终端配色由 `--code-surface` / `--code-text` / `--selection-bg` token 驱动，主题改这三个 token 即可换终端配色；`[data-pane="terminal"]` 钩子可用于边框、内边距等容器装饰。
> `question-panel` 是 AI 提问（ask_question 工具）时从输入栏上方向上展开的应答面板，位于 `conversation` 区域内、`composer` 正上方。面板分页式逐题作答（右上角页码/箭头切换，草稿跨页保留），底部「忽略」取消提问、「继续」手动推进或提交；选择题第一个选项自动标注「（推荐）」——与工具描述约定一致（模型把最推荐的选项放第一位），单选点选/回车/空格即选中并自动进入下一题（末题自动提交，重选直接换项），多选保持勾选多个、由「继续」或输入框回车推进；面板内快捷键：Tab/上下键移动选择（单选上下键移动时同步改选但不跳页）、回车或空格确认（单选确认即跳页）。
> `memory-panel` 是会话区右上方面板坞的记忆页（待办页 `task-panel` 居前，两者合并为一个浮动面板坞，头部 tab 切换，关闭态为单个 FAB）。

```css
[data-pane="composer"] { border-image: url(frame.webp) 0 220 fill; border-radius: 0; }
[data-pane="sidebar"]  { border-right: 2px solid var(--accent); }
```

**消息角色 `data-role`**：`user` / `assistant` / `extension`（加在每条消息的 article 上）。

**控件钩子 `data-control`**（关键按钮与输入控件，同样有契约保障）：

| 控件 | 值 |
| --- | --- |
| 新建话题（侧栏） | `new-session` |
| 设置（侧栏底部） | `settings` |
| 打开工作区（顶栏 + 空态主按钮） | `workspace-open` |
| 预览面板开关（顶栏） | `preview-toggle` |
| 面板坞开关 + 待办页 tab（会话区右上方 FAB） | `task-panel-toggle` |
| 记忆页 tab（面板坞内） | `memory-toggle` |
| 发送 | `send` |
| 停止（生成中与发送互换显示） | `stop` |
| 添加附件 | `attach` |
| 待发送队列条目操作 | `queue-edit` / `queue-send-now` / `queue-remove` |
| 访问模式 | `access-mode` |
| 模型快捷切换 | `model-select` |
| 思考级别 | `thinking-select` |
| 消息操作 | `copy` / `edit` / `regenerate` / `share` |

```css
/* 圆形发送按钮，生成中换成呼吸的停止按钮 */
[data-pane="composer"] [data-control="send"],
[data-pane="composer"] [data-control="stop"] { border-radius: 50%; }
[data-ui-generating] [data-control="stop"] { animation: pulse 1.6s infinite; }
/* 重设计输入框本体 */
[data-pane="composer"] textarea { font-family: "Brand", monospace; caret-color: var(--accent); }
```

`send` / `stop` 占据同一位置、按生成状态互换；重设计时建议两个一起写，避免状态切换时跳变。模型/思考菜单、斜杠指令面板都是 `composer` 区域的子元素，用 `[data-pane="composer"]` 后代选择器即可命中。生成中回车排队的消息显示在 `composer` 区域顶部的待发送列表（条目带 `data-queue-kind="steering|followUp"`，`steering` 为“立即发送”升级后的优先形态）。

**覆盖层级**：① 契约控件（上表，跨版本安全）；② 钩子区域内用元素选择器统改（`[data-pane="sidebar"] button`、`[data-pane="settings-dialog"] select`，同样安全）；③ 区域内类名命中（事实稳定、无契约）。右键菜单、错误提示 toast、重命名小对话框和内嵌编辑器（Markdown 工具栏、Mermaid）在契约之外，只受颜色 token 影响。立体按钮、clip-path 异形容器、霓虹描边、扫描线等创意技法的可复制配方见 `pidesktop-theme-creator` skill 的 `references/recipes.md`。

**UI 状态（`<html>` 布尔属性，出现即真）**：`data-ui-settings-open` `data-ui-workspace-open` `data-ui-chat-empty` `data-ui-generating` `data-ui-preview-open` `data-ui-permission-pending` `data-ui-question-pending`

```css
/* 生成中给输入框加呼吸光晕 */
[data-ui-generating] [data-pane="composer"] { animation: glow 2s ease-in-out infinite; }
/* 空会话时隐藏侧栏装饰 */
[data-ui-chat-empty] [data-pane="sidebar"]::after { display: none; }
```

## 声明式装饰层

主题无需 JavaScript 即可声明全屏装饰图层（立绘、贴边花纹、画框等）。每个变量是一份完整的 `background` 简写：

```css
:root {
  --pi-layer-backdrop: url(palace.webp) center / cover no-repeat;
  --pi-layer-mascot:   url(mascot.webp) bottom right / 240px no-repeat;
  --pi-overlay-trim:   url(trim.webp) top / 640px repeat-x;
}
:root[data-theme-effective="dark"] { --pi-layer-backdrop: url(palace-dark.webp) center / cover no-repeat; }
```

- `--pi-layer-<name>`：画在壁纸之上、界面之下；
- `--pi-overlay-<name>`：画在界面之上、对话框 / 菜单之下（`pointer-events: none`，不挡交互）；
- 同名数字按自然顺序叠放（`mascot-2` 在 `mascot-10` 之下）；
- 值经 CSS 级联解析，按明暗模式分别声明即可自动切换。

## 字体

字体文件（`.woff` `.woff2` `.ttf` `.otf`）随主题目录导入，相对 `url()` 引用：

```css
@font-face { font-family: "Brand"; src: url(brand.woff2) format("woff2"); }
:root { font-family: "Brand", system-ui, sans-serif; }
```

## 壁纸

```css
:root {
  --chat-bg-image: url(wallpaper.png);
  --chat-bg-opacity: 0.28;   /* 设置面板的透明度滑块可在运行时覆盖此值 */
  --chat-bg-size: cover;
}
```

声明壁纸后应用会自动为面板加透明 + 毛玻璃效果。图片保持相对路径引用，应用单独存储图片数据。

## 分发

在 CSS 顶部写名称注释可被目录导入识别：`/* Theme Name: 我的主题 */`。导出功能只下载 CSS 文本（不含资产数据），完整分发请直接分享整个主题目录。
