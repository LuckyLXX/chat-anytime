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


| 用途 | 变量                                                                                          |
| ---- | --------------------------------------------------------------------------------------------- |
| 表面 | `--surface` `--surface-muted` `--surface-raised` `--surface-sidebar` `--surface-conversation` |
| 文本 | `--text` `--text-muted` `--text-on-accent` `--text-on-user-bubble`                            |
| 强调 | `--accent` `--accent-hover` `--accent-soft` `--accent-text` `--focus-ring`                    |
| 气泡 | `--user-bubble` `--user-bubble-border` `--ai-bubble` `--tool-bubble-bg`                       |
| 代码 | `--code-surface` `--code-text` `--inline-code-surface` `--syntax-*`                           |
| 状态 | `--success` `--danger` `--warning` 及其 `-soft` / `-text`                                     |

## 结构钩子（公开 API）

类名属于实现细节，可能随版本变化；以下属性是稳定契约，结构化主题请只依赖它们：

**区域钩子 `data-pane`**：`sidebar` `topbar` `workspace` `work-area` `conversation` `timeline` `composer` `task-panel` `memory-panel` `preview` `terminal` `question-panel` `settings-dialog` `permission-dialog` `landing`

> `landing` 是空态构图（未打开工作区 / 未开始对话时的居中提示块，含图标与主按钮），主题可据其做"着陆页"式重设计。

> `workspace` 是侧栏右侧的整个主工作区容器（含顶栏、会话区与预览面板），适合整体背景、圆角等容器级装饰；其内部的顶栏、会话区等各自另有更细粒度的区域钩子。

> `terminal` 是预览面板内的嵌入式终端区域（xterm.js 宿主）。终端配色由 `--code-surface` / `--code-text` / `--selection-bg` token 驱动，主题改这三个 token 即可换终端配色；`[data-pane="terminal"]` 钩子可用于边框、内边距等容器装饰。
> `question-panel` 是 AI 提问（ask_question 工具）时从输入栏上方向上展开的应答面板，位于 `conversation` 区域内、`composer` 正上方。面板分页式逐题作答（右上角页码/箭头切换，草稿跨页保留），底部「忽略」取消提问、「继续」手动推进或提交；选择题第一个选项自动标注「（推荐）」——与工具描述约定一致（模型把最推荐的选项放第一位），单选点选/回车/空格即选中并自动进入下一题（末题自动提交，重选直接换项），多选保持勾选多个、由「继续」或输入框回车推进；面板内快捷键：Tab/上下键移动选择（单选上下键移动时同步改选但不跳页）、回车或空格确认（单选确认即跳页）。
> `memory-panel` 是会话区右上方面板坞的记忆页（待办页 `task-panel` 居前，两者合并为一个浮动面板坞，头部 tab 切换，关闭态为单个 FAB）。
> `turn-minimap` 是会话时间线左缘（聊天气泡左侧空位）的「轮次缩略导航」——每个缩略块对应一轮对话（一次用户提问 + 对应 AI 回复），hover 放大成浮出卡片展示该轮摘要、点击滚动到该轮。`.turn-minimap` 窄条用 `var(--panel-bg)` 派生背景，`.turn-thumb` 缩略块、`.turn-thumb.active` 当前轮、`.turn-thumb-pop` 悬停放大的浮出卡片均可用 `[data-pane="turn-minimap"]` 后代选择器重设计。默认背景色走 `--surface`/`--accent-soft`，主题可覆盖。

> `automation-settings` 是设置页「自动化任务」tab（列表 + 搜索 + 过滤器，位于 `settings-dialog` 内）；`automation-dialog` 是「创建/编辑定时任务」弹窗。二者都随设置页/弹窗配色走，主题可用 `--panel-bg` 派生背景与 `--border`/`--surface-*` 控制排版。相关控件钩子：`data-control="automation-open"`（侧栏「新建话题」下方的「自动化」入口 + 折叠态窄条图标）、`automation-run`（行内「运行一次」）、`automation-toggle`（启停，未在控件列枚举的地方用类名 `.automation-*` 命中）。

```css
[data-pane="composer"] { border-image: url(frame.webp) 0 220 fill; border-radius: 0; }
[data-pane="sidebar"]  { border-right: 2px solid var(--accent); }
```

**消息角色 `data-role`**：`user` / `assistant` / `extension`（加在每条消息的 article 上）。

**控件钩子 `data-control`**（关键按钮与输入控件，同样有契约保障）：


| 控件                                        | 值                                               |
| ------------------------------------------- | ------------------------------------------------ |
| 新建话题（侧栏）                            | `new-session`                                    |
| 自动化任务（侧栏新建话题下方 + 折叠窄条）   | `automation-open`                               |
| 设置（侧栏底部）                            | `settings`                                       |
| 打开工作区（顶栏 + 空态主按钮）             | `workspace-open`                                 |
| 预览面板开关（顶栏）                        | `preview-toggle`                                 |
| 面板坞开关 + 待办页 tab（会话区右上方 FAB） | `task-panel-toggle`                              |
| 记忆页 tab（面板坞内）                      | `memory-toggle`                                  |
| 发送                                        | `send`                                           |
| 停止（生成中与发送互换显示）                | `stop`                                           |
| 添加附件                                    | `attach`                                         |
| 待发送队列条目操作                          | `queue-edit` / `queue-send-now` / `queue-remove` |
| 访问模式                                    | `access-mode`                                    |
| 计划模式开关（访问模式下拉内）              | `plan-toggle`                                    |
| 模型快捷切换                                | `model-select`                                   |
| 思考级别                                    | `thinking-select`                                |
| 思考块展开/收起（消息内）                   | `thinking-expand`                                |
| 上下文占用指示（顶栏）                      | `context-usage`                                  |
| 预览工具栏元素选择                          | `browser-pick`                                   |
| 消息操作                                    | `copy` / `edit` / `regenerate` / `share`         |

```css
/* 圆形发送按钮，生成中换成呼吸的停止按钮 */
[data-pane="composer"] [data-control="send"],
[data-pane="composer"] [data-control="stop"] { border-radius: 50%; }
[data-ui-generating] [data-control="stop"] { animation: pulse 1.6s infinite; }
/* 重设计输入框本体 */
[data-pane="composer"] textarea { font-family: "Brand", monospace; caret-color: var(--accent); }
```

`send` / `stop` 占据同一位置、按生成状态互换；重设计时建议两个一起写，避免状态切换时跳变。模型/思考菜单、斜杠指令面板都是 `composer` 区域的子元素，用 `[data-pane="composer"]` 后代选择器即可命中。生成中回车排队的消息显示在 `composer` 区域顶部的待发送列表（条目带 `data-queue-kind="steering|followUp"`，`steering` 为“立即发送”升级后的优先形态）。

**行级钩子（侧栏列表内部）**：`data-row-kind`（`workspace` 工作区分组头 / `session` 会话行 / `agent` 助手行）+ 布尔 `data-row-active`（选中行）+ 布尔 `data-row-expanded`（工作区分组展开）。主题可精确重设计行、牌匾、折叠与展开态。

**节点级钩子（时间线内部）**：`data-node-kind`（时间线段类型：`thinking` / `tool-call` / `text`）+ `data-node-state`（`running` / `completed` / `error`，缺失为普通态）。用于"思考中扫光""工具运行微光"等状态动画。

**输入框分区钩子 `data-composer-zone`**：`queue`（排队列表）`plan`（计划模式状态条）`attachments`（附件预览条）`error`（附件错误条）`input`（输入行）`footer`（工具栏行）`popup`（斜杠/引用/访问模式/模型/思考菜单）。

> `popup` 是绝对定位浮层：主题**不得修改其 `position`**（改成 `relative` 会落入网格隐式行并把排布打乱）；给浮层加层级请只改 `z-index`。

**覆盖层级**：① 契约控件（上表，跨版本安全）；② 钩子区域内用元素选择器统改（`[data-pane="sidebar"] button`、`[data-pane="settings-dialog"] select`，同样安全）；③ 区域内类名命中（事实稳定、无契约）。右键菜单、错误提示 toast、重命名小对话框和内嵌编辑器（Markdown 工具栏、Mermaid）在契约之外，只受颜色 token 影响。立体按钮、clip-path 异形容器、霓虹描边、扫描线等创意技法的可复制配方见 `pidesktop-theme-creator` skill 的 `references/recipes.md`。

> ⚠️ 不要对钩子区域写 `[data-pane="x"] > * { position: relative; z-index: n }` 这类"全体抬升"规则：会把区域内绝对定位的浮层（附件预览条、错误条、菜单）改为流内元素。只抬 `data-composer-zone` 排布分区与明确的流内子项。

**特异性（覆盖规则能否生效）**：应用壁纸模式的基础规则写成 `[data-theme-wallpaper="true"] .sidebar` 等（(0,2,0) 特异性，两个属性/类选择器）。主题用等特异性选择器（`[data-theme-wallpaper="true"] [data-pane="sidebar"]`）即可凭"后注入"胜出，不需要 `html` 前缀。区域自身的非壁纸规则（如 `[data-pane="sidebar"]`）与应用的 `.sidebar`（(0,1,0)）同特异性、靠后注入胜出。自定义 CSS 注入顺序在应用样式之后。

**UI 状态（`<html>` 属性，存在即真；带值状态例外）**：`data-ui-settings-open` `data-ui-workspace-open` `data-ui-chat-empty` `data-ui-generating` `data-ui-preview-open` `data-ui-permission-pending` `data-ui-question-pending` `data-ui-attachments`（输入框有附件）`data-ui-split-open`（分屏模式，会话区同时展示 ≥2 个格子）`data-ui-sidebar-collapsed`（侧栏折叠为图标窄条，存在即真）。带值状态：`data-ui-sidebar-view="topics|files|agents"`（取值匹配，如 `[data-ui-sidebar-view="files"]`）、`data-ui-density="compact|comfortable|relaxed"` 与 `data-ui-radius="square|small|medium|round"`（运行时界面微调层，由设置【外观 → 界面微调】写入；对应 `--ui-density-scale` / `--ui-control-radius` / `--ui-container-radius`，默认值=当前视觉，主题可覆盖 token 或忽略属性）。

**分屏（多实例区域，v2.1 迁移说明）**：会话区支持分屏后，`conversation` / `timeline` / `composer` / `question-panel` 区域钩子**同一页面可出现多次**（每个格子一套完整实例）。属性选择器（`[data-pane="composer"]` 等）本就按元素生效，多实例无需改动；但 `[data-ui-generating] [data-pane="composer"]` 这类“根状态 × 区域”的组合在分屏下作用于**所有格子**，而 `data-ui-generating` / `data-ui-chat-empty` / `data-ui-attachments` 的语义是**焦点格**（激活会话）的状态——只想命中焦点格时请叠加 `[data-pane-active]`（焦点格的 conversation 区域携带该属性，存在即真）：

```css
/* 只给焦点格的输入框加呼吸光晕（分屏下其他格子不闪） */
[data-ui-generating] [data-pane="conversation"][data-pane-active] [data-pane="composer"] { animation: glow 2s ease-in-out infinite; }
```

新增契约控件（分屏格头部）：`data-control="pane-maximize"`（最大化/还原该格）、`data-control="pane-close"`（关闭该格）。`--composer-space` / `--composer-height` 变量改为**每格独立**（写在各自的 conversation 区域上），用法不变。分屏容器与分隔条的类名（`.split-view` / `.split-node` / `.split-child` / `.split-pane` / `.split-divider`）在契约之外，主题用颜色 token 影响其配色即可。

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

**装饰层元素（公开契约）**：每个已声明变量有一个 `<div class="theme-layer">` 渲染节点，带 `data-theme-layer="<name>"` 与 `data-layer-kind="layer|overlay"` 属性。主题可定向访问为层施加 `filter` / `opacity` / `transform` / `transition`（例如暗色模式压暗立绘、`scaleX(-1)` 镜像角饰、状态切换位移）：

```css
:root[data-theme-effective="dark"] [data-theme-layer="maid-left"] { filter: brightness(0.84) saturate(0.92) drop-shadow(0 6px 12px rgb(0 0 0 / 0.3)); }
[data-ui-chat-empty] [data-theme-layer="side-art"] { opacity: 1; }
:root:not([data-ui-chat-empty]) [data-theme-layer="side-art"] { opacity: 0.9; transform: translateY(12px); }
```

**布局量（公开 API）**：`--layout-sidebar-width`（侧栏列宽，明暗一致，随应用布局变化联动；立绘/装饰偏移用 `calc(... + var(--layout-sidebar-width))`，不要硬编码像素）。`--layout-sidebar-collapsed-width`（折叠态窄条宽度，48px；侧栏折叠时首列改为它，立绘/装饰可一并偏移）。

## 字体

字体文件（`.woff` `.woff2` `.ttf` `.otf`）随主题目录导入，相对 `url()` 引用：

```css
@font-face { font-family: "Brand"; src: url(brand.woff2) format("woff2"); }
:root { font-family: "Brand", system-ui, sans-serif; }
```

### 字号规范

应用内置字号层级：正文 14 / 输入框与次级正文 13 / 列表主文本 12 / 辅助 meta 11 / 数字徽章·kbd·纯拉丁元信息 10（最小值）。主题自定义 CSS 请遵守：CJK 连续阅读文本最小 11px；10px 仅限短徽章、计数、kbd、路径等非连续阅读文本。主题预览缩略图（`.theme-preview-*`）是微缩模型，不受此限。

### 圆角规范

应用内置圆角四档：**4px** 非交互微元素（行内代码、kbd、缩略图、色板）/ **6px** 全部交互控件（按钮、输入框、菜单项、列表行、chip）与气泡内嵌套块 / **10px** 容器（卡片、气泡、面板、浮层菜单、对话框、代码块、预览区）/ **999px** 胶囊徽章与计数。圆形（50%）、显式 0、预览标签页单侧圆角为保留例外。主题自定义 CSS 建议对齐此分档，避免同层级控件圆角不一。

## 壁纸

```css
:root {
  --chat-bg-image: url(wallpaper.png);
  --chat-bg-opacity: 0.28;   /* 设置面板的透明度滑块可在运行时覆盖此值 */
  --chat-bg-size: cover;
}
```

声明壁纸后应用会自动为面板加透明 + 毛玻璃效果——面板底色保留比例由设置面板「外观 → 面板透明度」滑块控制；面板底色按面分解为公开 token，主题分别覆盖：

| 面 | token |
| --- | --- |
| 侧栏 / 侧栏分页条 | `--panel-bg-sidebar` |
| 顶栏 | `--panel-bg-topbar` |
| 输入框 | `--panel-bg-composer` |
| 设置/权限对话框与面板坞标签条 | `--panel-bg-dialog` |
| 预览面板 | `--panel-bg-preview` |

各 token 默认 `var(--panel-bg)`（使用点解析，明暗两板只需覆写后者即联动）；主题亦可各自覆写（如输入框瓷面、对话框瓷面而侧栏深蓝）。消息气泡及其内嵌块（代码块/引用/表格折叠项等）也会自动降为半透明底色（纯 alpha、不模糊）让壁纸透出，统一的透明程度由设置面板「外观 → 气泡透明度」滑块控制（默认 80%，可用 `appearance.bubbleOpacity` 覆盖）。若需完全自定义：在主题 CSS 里用 `[data-theme-wallpaper="true"] .message-assistant .message-body { background: ...; }` 等同特异性选择器覆盖即可（浅色/深色模式按 `:root[data-theme-effective=...]` 分别声明）。图片保持相对路径引用，应用单独存储图片数据。

## 分发

在 CSS 顶部写名称注释可被目录导入识别：`/* Theme Name: 我的主题 */`。导出功能只下载 CSS 文本（不含资产数据），完整分发请直接分享整个主题目录。
