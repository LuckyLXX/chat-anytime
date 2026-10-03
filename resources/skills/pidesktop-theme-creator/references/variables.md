# PiDesktop 主题变量

PiDesktop 主题需要在两种生效模式下定义这些变量。值可以在有明确意图时引用另一个变量，但最终的前景/背景组合必须通过对比度检查。

## 契约

| 分组 | 变量 |
| --- | --- |
| 壁纸 | `--chat-bg-image`、`--chat-bg-opacity`、`--chat-bg-size`、`--chat-bg-repeat`、`--chat-bg-position` |
| 表面 | `--surface`、`--surface-muted`、`--surface-raised`、`--surface-conversation`、`--surface-sidebar`、`--surface-sidebar-tabs`、`--surface-sidebar-hover`、`--surface-sidebar-active`、`--surface-sidebar-badge`、`--surface-input`、`--surface-footer`、`--surface-detail`、`--surface-button-hover`、`--preview-surface`、`--blockquote-surface`、`--panel-bg` |
| 文本 | `--text`、`--text-muted`、`--text-sidebar-active`、`--text-on-accent`、`--on-accent`、`--text-on-user-bubble`、`--avatar-user-text`、`--avatar-assistant-text`、`--link` |
| 边框 | `--border`、`--border-strong`、`--border-message`、`--border-assistant`、`--blockquote-border`、`--user-bubble-border`、`--accent-border` |
| 强调与焦点 | `--accent`、`--accent-hover`、`--accent-soft`、`--accent-text`、`--focus-ring`、`--selection-bg`、`--selection-text` |
| 状态 | `--success`、`--success-soft`、`--success-border`、`--completed-border`、`--warning`、`--warning-soft`、`--danger`、`--danger-soft`、`--danger-border`、`--danger-text` |
| 气泡与头像 | `--blue`、`--user-bubble`、`--ai-bubble`、`--avatar-user`、`--avatar-assistant`、`--tool-bubble-bg`、`--tool-bubble-border` |
| 代码 | `--code-surface`、`--code-text`、`--inline-code-surface`、`--inline-code-text`、`--syntax-keyword`、`--syntax-string`、`--syntax-number`、`--syntax-comment`、`--syntax-title`、`--syntax-meta` |
| Diff | `--diff-add-text`、`--diff-remove-text`、`--diff-hunk-text`、`--diff-meta-text` |
| 交互 | `--user-action-border`、`--user-action-surface`、`--overlay` |
| 阴影与滚动条 | `--shadow-sm`、`--shadow-md`、`--shadow-lg`、`--scrollbar-track`、`--scrollbar-thumb`、`--scrollbar-thumb-hover` |

`--on-accent` 是 `--text-on-accent` 的双生 token，少数控件（表单选项样式）仍在消费；两者保持一致。未知的额外自定义变量无害，但运行时不会消费。

## 对比度对

检查器会在明、暗两种模式下评估这些组合：

| 前景 | 背景 | 目标 |
| --- | --- | --- |
| `--text` | `--surface` | 4.5:1 |
| `--text-muted` | `--surface` | 4.5:1 |
| `--text-sidebar-active` | `--surface-sidebar-active` | 3:1 |
| `--text-on-accent` | `--accent` | 4.5:1 |
| `--accent-text` | `--accent-soft`、`--surface` | 4.5:1 |
| `--text-on-user-bubble` | `--user-bubble` | 4.5:1 |
| `--avatar-user-text` | `--avatar-user` | 3:1 |
| `--avatar-assistant-text` | `--avatar-assistant` | 3:1 |
| `--link` | `--surface` | 4.5:1 |
| `--inline-code-text` | `--inline-code-surface` | 4.5:1 |
| `--code-text` | `--code-surface` | 4.5:1 |
| 每个 `--syntax-*` token | `--code-surface` | 3:1 |
| `--danger-text` | `--danger-soft` | 4.5:1 |
| `--diff-add-text` | `--success-soft` | 4.5:1 |
| `--diff-remove-text` | `--danger-soft` | 4.5:1 |
| `--diff-hunk-text`、`--diff-meta-text` | `--accent-soft` | 4.5:1 |

带透明度的值会在可能时由检查器合成到相应背景上。若某个值复杂到无法解析，请换成最终颜色，而不是忽略警告。

## 结构主题

重设计布局或添加装饰（而非重定义全部调色板）的主题，应声明此头注释让检查器放宽全量覆盖要求：

```css
/* Theme Type: structural */
```

结构主题叠加在内置 token 基底之上，可以使用以下稳定钩子（类名是实现细节、可能随版本变化——绝不瞄准类名）：

以下四个钩子家族容易漏掉，先集中说清楚：

- **分屏多实例**：`conversation` / `timeline` / `composer` / `question-panel` 同页可出现多次（每格一套实例）。属性选择器本就按元素生效，多实例无需改动；但 `[data-ui-generating] [data-pane="composer"]` 这类“根状态 × 区域”的组合会作用于**所有格子**，而 `data-ui-generating` / `data-ui-chat-empty` / `data-ui-attachments` 的语义是焦点格——只想命中焦点格时叠加 `[data-pane-active]`。格头另有 `pane-maximize` / `pane-close` 两个控件钩子。分屏容器与分隔条的类名在契约之外，用颜色 token 影响配色即可。
- **侧栏折叠**：`data-ui-sidebar-collapsed` 存在即折叠为图标窄条（宽 `--layout-sidebar-collapsed-width`，48px）。**此时 `[data-pane="sidebar"]` 命中的是那条竖条，而不是整栏**——立绘偏移、内边距、伪元素装饰都要兜底，否则会被塞进 48px 里。窄条上的按钮（展开、话题、搜索、助手入口）不是契约钩子。
- **设计模式**：`data-ui-design-open` 存在即设计工作台（`design`）替换常规会话布局（与分屏、预览互斥）。内部四区 `design-toolbar` / `design-layers` / `design-canvas` / `design-inspector`，画布上方还有浮动绘图工具胶囊 `design-tools`（按钮 `design-tool-*`，`aria-pressed` 标激活）。工作台底色走 `--panel-bg-preview`（缺省 `--panel-bg`）。
- **界面微调**：`data-ui-density` / `data-ui-radius` 是用户在外观设置里的微调档位，投影到 `--ui-*` 三个量；主题可以覆盖 token，也可以完全不理会这两个属性。

| 钩子 | 取值 / 形态 | 绘制位置 |
| --- | --- | --- |
| 主要区域上的 `data-pane`（37） | `sidebar` `topbar` `workspace` `work-area` `conversation` `timeline` `composer` `task-panel` `memory-panel` `preview` `terminal` `ssh` `ssh-files` `question-panel` `settings-dialog` `permission-dialog` `landing` `turn-minimap` `markdown-outline` `design` `design-toolbar` `design-tools` `design-canvas` `design-layers` `design-inspector` `gallery-menu` `gallery-wall` `automation-settings` `automation-dialog` `agent-settings` `general-settings` `model-settings` `resource-settings` `appearance-settings` `subagent-settings` `hooks-settings` `usage-settings` | — |
| 消息条目上的 `data-role` | `user` `assistant` `extension`——只有这三个在契约内；界面里另有同属性名的内部标记（Jev 测试结果行、自动化徽标、墓碑提示等），不在契约内、检查器会拒 | — |
| 关键控件上的 `data-control`（92） | `new-session` `settings` `workspace-open` `preview-toggle` `preview-outline-toggle` `task-panel-toggle` `memory-toggle` `send` `stop` `attach` `queue-edit` `queue-send-now` `queue-remove` `access-mode` `plan-toggle` `model-select` `thinking-select` `thinking-expand` `context-usage` `browser-pick` `browser-download-toggle` `copy` `edit` `regenerate` `share` `pane-maximize` `pane-close` `automation-open` `automation-run` `automation-toggle` `automation-runs-tab` `ssh-open` `ssh-host-create` `ssh-host-save` `ssh-host-delete` `ssh-host-connect` `ssh-trust-fingerprint` `ssh-group-create` `ssh-group-save` `ssh-files-toggle` `ssh-upload` `ssh-download` `ssh-transfer-cancel` `gallery-toggle` `gallery-publish` `gallery-run` `gallery-develop` `gallery-open-wall` `gallery-remove` `computer-toggle` `design-toggle` `design-send-ai` `design-export` `design-undo` `design-redo` `design-tool-select` `design-tool-frame` `design-tool-rect` `design-tool-text` `design-layer-lock` `agent-new` `agent-save` `settings-version` `jev-test` `jev-expand` `capability-switch` `model-provider-add` `model-provider-delete` `model-save` `model-refresh` `model-add` `model-thinking-levels` `model-thinking-panel` `resource-reload` `mcp-add` `mcp-save` `command-add` `command-save` `appearance-import-css` `appearance-import-theme` `appearance-clear-css` `appearance-save-theme` `appearance-save` `subagent-add` `subagent-save` `hooks-enable` `hooks-add` `hooks-save` `hooks-trust` `hooks-run-log` `hooks-template` `usage-agent-filter` | — |
| 行级钩子（侧栏列表） | `data-row-kind`：`workspace` `session` `agent`；存在性 `data-row-active` / `data-row-expanded` | — |
| 节点级钩子（时间线） | `data-node-kind`：`thinking` `tool-call` `text`；`data-node-state`：`running` `completed` `error` `aborted`（`aborted` = 用户中止，中性色） | — |
| 输入框分区钩子 | `data-composer-zone`：`queue` `plan` `attachments` `error` `input` `footer` `stats`（会话性能行，浮在输入卡上方）、`popup`（`popup` 为绝对定位浮层，**不得改其 position**；浮层只调 `z-index`） | — |
| `<html>` 上的 `data-ui-*`（布尔存在性） | `data-ui-settings-open` `data-ui-workspace-open` `data-ui-chat-empty` `data-ui-generating` `data-ui-preview-open` `data-ui-preview-fullscreen` `data-ui-permission-pending` `data-ui-question-pending` `data-ui-attachments` `data-ui-split-open` `data-ui-design-open` `data-ui-sidebar-collapsed` `data-ui-session-multiselect` | — |
| `<html>` 上的带值状态 | `data-ui-sidebar-view`：`topics` `files` `archived`（`archived` = 已归档话题屏；`agents` 是侧栏分页、不是本属性）；`data-ui-density`：`compact` `comfortable` `relaxed`；`data-ui-radius`：`square` `small` `medium` `round`；`data-ui-motion="off"`：用户关闭界面动效（主题无需响应，不应依赖动效传达信息） | — |
| 焦点格标记 | 分屏时焦点格的 `conversation` 区域上带布尔 `data-pane-active`（存在即真） | — |
| `--pi-layer-<name>` | 完整 `background` 简写 | 壁纸之上、界面之下 |
| `--pi-overlay-<name>` | 完整 `background` 简写 | 界面之上、对话框/菜单之下 |
| 装饰层元素属性 | `data-theme-layer="<name>"` 与 `data-layer-kind="layer\|overlay"`，可加 `filter`/`opacity`/`transform`/`transition` | 层 div 本身 |
| 布局量（公开量） | `--layout-sidebar-width`（侧栏列宽）、`--layout-sidebar-collapsed-width`（折叠窄条宽，48px） | — |
| 输入框占位量（每格独立） | `--composer-space` / `--composer-height`：写在各自的 `conversation` 区域上，分屏时每格一份 | — |
| 界面微调量（公开量） | `--ui-density-scale` / `--ui-control-radius` / `--ui-container-radius`（默认值 = 当前视觉；主题可覆盖，也可忽略 `data-ui-density` / `data-ui-radius`） | — |
| 面板底色 token | `--panel-bg-sidebar/topbar/composer/dialog/preview`（默认 `var(--panel-bg)`，使用点解析） | — |

```css
:root { --pi-layer-backdrop: url(palace.webp) center / cover no-repeat; }
:root[data-theme-effective="dark"] { --pi-layer-backdrop: url(palace-dark.webp) center / cover no-repeat; }
[data-ui-generating] [data-pane="composer"] { box-shadow: 0 0 12px var(--accent); }
```

装饰层名必须是小写 `[a-z0-9-]`；按自然数字顺序叠放（`mascot-2` 在 `mascot-10` 之下），渲染为 `pointer-events: none` 的视口图层，绝不阻挡交互。层值经 CSS 级联解析，按模式分别声明即可自动切换。字体（`@font-face` 相对引用 CSS 旁的 `.woff` / `.woff2` / `.ttf` / `.otf`）与图片一起导入。

### 陷阱清单（AI 创作与人工审查必读）

1. **特异性阶梯**：应用壁纸模式基础规则为 `[data-theme-wallpaper="true"] .sidebar` 等
   （(0,2,0)，两个属性/类选择器）——主题用等特异性选择器
   （`[data-theme-wallpaper="true"] [data-pane="sidebar"]`）凭后注入胜出，**不需要
   `html` 前缀**；区域自身规则（`[data-pane="sidebar"]` 对 `.sidebar`）同 (0,1,0) 层级。
2. **`[data-pane="x"] > *` 全体抬升是雷区**：会把区域内绝对定位浮层（附件预览条、
   附件错误条、斜杠/引用/访问模式/模型/思考菜单）改为流内元素，落入网格隐式行后
   整体错位。只对排布分区（如 `[data-composer-zone="input"]`）或明确的流内子项抬层级；
   浮层只加 `z-index`。检查器会对此给出警告。
3. **输入框高度语义**：composer 网格为 `minmax(32px, 1fr) auto`——输入框是内容驱动
   的，`1fr` 行在高度不确定时按内容收敛；一旦给容器大 `min-height`（>160px），
   `1fr` 行会吃满富余空间，textarea 与工具栏之间出现大空白。**不要给 composer 设
   大 min-height**（检查器 >160px 警告）。
4. **面板底色共享 token**：壁纸模式下各面底色由 `--panel-bg-*` 分别决定（默认
   `var(--panel-bg)` 使用点解析）。对某面单独换底（如输入框瓷面、侧栏深蓝）用
   `[data-pane="composer"] { --panel-bg-composer: ... }`，不要靠区域作用域覆写全局
   `--panel-bg`（会连带对话框与预览）。
5. **三个滑块的运行时覆盖**：壁纸/气泡/面板透明度滑块在主题 CSS 之后以
   `!important` 注入 `--chat-bg-opacity` / `--bubble-alpha` / `--panel-alpha`；
   主题里直接写死的 alpha 会被滑块改变，需要固定效果请用
   `[data-theme-wallpaper="true"]` 等特异性覆盖具体规则。
6. **区域内类名是最后手段**（层级③）：`[data-pane="sidebar"] .session-list` 等。应用
   内部存在类名复用的历史坑（曾使侧栏助手列表命中设置页 `.agent-list` 规则而整块
   泛白），主题内命中区域类名时只改视觉属性，不改布局属性（position/display/order 可
   改 layout 但不能改变绝对定位子项的 position）。
7. **装饰层与角饰**：层是纯 `background` 简写，无法直接擦除/翻转单张背景——
   (a) 镜像角饰：用 `--pi-overlay-*` 层 + `[data-theme-layer]` 的 `transform: scaleX(-1)`；
   (b) 预生成素材变体（Pillow `Image.transpose` / `ImageEnhance`）随目录导入，
   二者都是官方路径。立绘压暗同理：暗色模式换预调暗素材或对层加 `filter`。
8. **`--panel-bg-*` 的 var() 联动语义**：各面 token 默认值是
   `var(--panel-bg)`，**在使用点解析**——所以"全局覆写 `--panel-bg`"（例如想让
   一个面变深蓝而在 `:root[data-theme-effective=...]` 里写 `--panel-bg: navy`）
   会连锁改变**所有未定向面**的底色（对话框、预览、面板坞标签条……）。正确做法：
   全局色彩除非明确"所有面同色"，否则只写 `--panel-bg-*`（侧栏/顶栏深蓝就只声明
   `--panel-bg-sidebar` / `--panel-bg-topbar`），`--panel-bg` 只作为"未定向面"的
   普通默认。
9. **契约版本错配（静默回退）**：主题声明了新契约 token（`--panel-bg-composer`
   等），但运行中的应用可能还是旧契约（壁纸规则读 `var(--panel-bg)`）——此时
   新的按面声明**不生效**，底色静默回落到全局 `--panel-bg`，表现为"面板色块
   大面积错误、控件本身颜色正常"。防御模式（双声明兼容，推荐在按面改底时使用）：

   ```css
   :root[data-theme-effective="light"] [data-pane="composer"] {
     --panel-bg-composer: rgb(253 252 248 / 0.9); /* 新契约 */
     --panel-bg: rgb(253 252 248 / 0.9);          /* 旧契约兼容 */
   }
   ```

   注意：区域作用域同时声明 `--panel-bg` 还会改变该区域内所有读 `--panel-bg`
   的子控件底色（如对话框内的页签条），双声明时两值必须一致。检查器会提示
   "只声明 `--panel-bg` 未按面声明"的区域规则。
10. **面 token 的边界只有五面**：壁纸模式下读 `--panel-bg-*` 的只有 `sidebar` /
    `topbar` / `composer` / `dialog`（设置、权限等对话框与其页签条）/ `preview`。
    `question-panel` / `task-panel` / `memory-panel` 以及面板坞、作品墙等由
    `--surface` / `--surface-raised` 决定底色——在这些区域里写 `--panel-bg-dialog`
    不会改变面板自身，只会影响区域内恰好读该 token 的子控件。
11. **`data-role` 只有三个契约取值**：`user` / `assistant` / `extension`。渲染器里
    还散着几个同属性名的内部标记（Jev 测试结果行、自动化徽标、墓碑提示、用量摘要），
    它们没有契约、随时会被重构，检查器也会当未知钩子拒绝——不要把它们写进主题选择器。
12. **折叠侧栏会改变 `[data-pane="sidebar"]` 的几何**：折叠态命中的是 48px 窄条
    （`data-ui-sidebar-collapsed` 就加在那个 div 上），而不是整栏——立绘偏移与
    内边距请用 `--layout-sidebar-collapsed-width` 兜底，纵向装饰/大图用
    `html:not([data-ui-sidebar-collapsed]) [data-pane="sidebar"] …` 限定，
    避免装饰被塞进窄条。

### 控件重设计要点

- 控件位于所属区域之内；用 `[data-pane="composer"] [data-control="send"]` 限定作用域，规则才能扛住标记重构。
- `send` 与 `stop` 占据同一位置并随生成状态互换——成对重设计避免视觉跳变，状态效果搭配 `[data-ui-generating]`；分屏下要只打焦点格，再叠 `[data-pane="conversation"][data-pane-active]`。
- 输入框文本域用 `[data-pane="composer"] textarea` 命中；模型/思考菜单与斜杠面板都是 composer 区域的后代。
- 设置页的 `agent-settings` / `general-settings` / `model-settings` 等页面用 `.xxx-settings` 前缀的 (0,2,x) 类名；在该页重设计 label / input / 开关时必须带同样前缀或更高特异性，否则会被 `[data-pane="settings-dialog"] label|input|select` 的全局规则压回（详见 `docs/theme-guide.md` 各设置页条目）。
- 完整创作指南在 PiDesktop 仓库的 `docs/theme-guide.md`，创意参考配方在 `references/recipes.md`。
