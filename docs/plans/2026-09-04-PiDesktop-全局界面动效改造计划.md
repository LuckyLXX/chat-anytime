# PiDesktop 全局界面动效改造计划

## 背景与目标

项目当前除零散的挂载动画（菜单 menu-pop-in、消息 message-in、面板坞 dock-slide-in 等）外，所有对话框打开/关闭、面板开关、Tab/视图切换、分组展开、Toast 都是瞬间出现/消失，交互生硬。本次为这些交互点统一补齐轻量动效。

**用户已确认的决策**：
1. 覆盖范围：核心全景（全部对话框、面板开关、Tab 切换、侧栏视图切换、会话分组展开、Toast，约 18 处点位），**不含会话切换动画**（数据整帧就位无加载感，硬加淡入有闪烁风险，后续单独评估）
2. 会话切换对话区淡入：**不做**
3. 外观设置加「界面动效」总开关（默认开启；系统 prefers-reduced-motion 时也自动关停）
4. 风格：轻快现代，120~220ms，淡入+轻微位移/缩放（8px 内），沿用现有 cubic-bezier(0.16, 1, 0.3, 1) 曲线

## 技术方案

### 核心路线
- **进入动画 = 纯 CSS 挂载 animation**（沿用现有 menu-pop-in 模式，零 JS）：元素插入 DOM 时自动播放。
- **退出动画 = 新 hook `useExitPresence` + 常驻透明包装 `ExitWrap`**：`{flag && <Dialog/>}` 改为 `{rendered && <ExitWrap exiting={exiting}><Dialog/></ExitWrap>}`。`ExitWrap` 渲染一个 `display: contents` 的 div（不参与布局、不影响 fixed 定位祖先查找、从 a11y 树消失），exiting 时加 `is-exiting` class + `inert` 属性（子树不可交互不可聚焦），CSS 用 `.ui-presence.is-exiting > .modal-backdrop { animation: ... }` 等选择器播退场动画，动画结束后 hook 真正卸载。包装 div 必须常驻（不能 exiting 时才插入，否则 React 子树重挂载会重置 SettingsDialog 的 tab 状态）。
- **hidden 属性切换重播**：PanelDock 的 `.panel-dock-pane` 用 `hidden` 切 tab，display:none→恢复时元素上的 CSS animation 自动重播，直接给类加 fade 动画即可，无需改 TSX。
- **Tab 切换重挂载重播**：设置对话框 9 个 tab、automation 子页、侧栏三视图都是三元条件渲染（mount/unmount），给容器类加 fade 挂载动画即自动重播。

### 性能红线（不可违反）
- 动画只用 opacity / transform / grid-template-rows（分组展开特例，overflow:hidden 剪裁、一次性 180ms）；绝不动 width/height/top/left。
- 时长 ≤220ms；权限弹窗（高频）≤150ms。
- 不在 `.message`、`.timeline` 直接子级、composer 及流式高频区（50ms/帧更新）加任何动画/过渡；不破坏 `.timeline > .message` 的 content-visibility 规则。
- browser/terminal 预览内容区不做切换动画（native WebContentsView/xterm 不受 CSS 控制）；预览面板关闭退场期间将其纳入 `browserSuspended`（native 视图立即隐藏，退场淡出的是 DOM 占位层）。
- 预览面板的 `.work-area` grid 列宽**不加**过渡（避免 iframe 连续 resize），只做面板内容 transform/opacity 滑入滑出。
- 主题毛玻璃（`[data-theme-wallpaper="true"] .settings-dialog` 的 backdrop-filter）与 transform 动画短时叠加可接受，实施后壁纸模式下目视验证。

## 实施步骤

### 第 1 步：新建 `src/renderer/src/components/Presence.tsx`
- `useExitPresence(open: boolean, exitMs: number): { rendered: boolean; exiting: boolean }`
  - open=true：rendered=true、exiting=false、清定时器
  - open=false：exiting=true，setTimeout(exitMs) 后 rendered=false；动效被禁（`document.documentElement.dataset.uiMotion === "off"` 或 `matchMedia("(prefers-reduced-motion: reduce)")`）时 exitMs 视为 0 立即卸载
  - close 期间重新 open 要取消卸载（竞态）；卸载时 cleanup 定时器
- `ExitWrap({ exiting, children })`：`<div className={exiting ? "ui-presence is-exiting" : "ui-presence"} inert={exiting}>{children}</div>`（React 19 支持 boolean inert）

### 第 2 步：新建 `src/renderer/src/components/Presence.test.tsx`
vitest + fake timers：
1. open=true → rendered=true
2. close 后退场窗口内 rendered=true 且 exiting=true，推进定时器后 rendered=false
3. close 期间 re-open 取消卸载
4. mock prefers-reduced-motion → close 立即卸载
5. exitMs=0 立即卸载

### 第 3 步：`src/renderer/src/styles.css` 动画基建
- 动效令牌：`--motion-ease: cubic-bezier(0.16, 1, 0.3, 1)`（注释注明与现有曲线同源）
- 新 keyframes：`backdrop-in/out`（opacity）、`dialog-in/out`（opacity + translateY(10px) scale(.985)）、`preview-panel-in/out`（opacity + translateX(18px)）、`dock-out`（dock-slide-in 反向）、`fab-in`（opacity + scale(.9)）、`flyout-out`、`toast-in`（opacity + translateY(10px)）、`soft-fade`（纯 opacity，供 tab/视图/landing/分组内容用）
- 挂载动画挂点：
  - `.modal-backdrop { animation: backdrop-in .18s ease }`（一次性覆盖全部模态：设置/权限/4 确认框/DelegationTranscript/automation modal/WorkspaceTree 2 modal/lightbox×2）
  - `.settings-dialog, .permission-dialog, .automation-dialog, .delegation-transcript-dialog { animation: dialog-in .2s var(--motion-ease) }`；`.permission-dialog` 时长降为 .15s（高频）——用单独声明覆盖
  - `.image-lightbox-content`：纯 soft-fade（大面积不用 scale）
  - `.content-preview-panel { animation: preview-panel-in .2s var(--motion-ease) }`
  - `.panel-dock-fab { animation: fab-in .15s }`
  - `.error-toast { animation: toast-in .18s var(--motion-ease) }`
  - `.settings-content { animation: soft-fade .15s ease }`（tab 切换重挂载自动重播）
  - `.agent-list, .session-list`、WorkspaceTree 根容器、`.empty-conversation, .empty-workspace`（landing）: `animation: soft-fade .13s ease`
  - `.panel-dock-pane { animation: soft-fade .13s ease }`（hidden 切换重播；实施时确认该类无显式 display 使 UA `[hidden]` 生效——当前代码 hidden 切换工作正常即证明）
  - AutomationSettings 任务/运行记录两分支容器：soft-fade .13s
  - `.sidebar-flyout { animation: flyout-in .18s var(--motion-ease) }`（新增 flyout-in keyframes：opacity + translateX(-8px)）
- 退场样式（`.ui-presence { display: contents }` + `.ui-presence.is-exiting { pointer-events: none }`）：
  - `.ui-presence.is-exiting > .modal-backdrop { animation: backdrop-out .14s ease both }`
  - `.ui-presence.is-exiting .settings-dialog/.permission-dialog/.automation-dialog/.delegation-transcript-dialog/.image-lightbox-content { animation: dialog-out .16s ease both }`（权限弹窗可共用，退场更短）
  - `.ui-presence.is-exiting > .content-preview-panel { animation: preview-panel-out .18s ease both }`
  - `.ui-presence.is-exiting > .panel-dock { animation: dock-out .16s var(--motion-ease) both }`
  - `.ui-presence.is-exiting > .sidebar-flyout { animation: flyout-out .16s ease both }`
  - 注释注明：退场 animation 时长必须与调用方 useExitPresence 传入的 exitMs 一致（列表对照）
- 会话分组展开（grid-rows 过渡，CSS 部分）：`.session-workspace-items` 作为过渡容器 `display: grid; grid-template-rows: 1fr; transition: grid-template-rows .2s var(--motion-ease), opacity .18s ease;`，`.collapsed { grid-template-rows: 0fr; opacity: 0; }`，内层 wrapper `min-height: 0; overflow: hidden`（具体结构在第 5 步 TSX 改造时对齐现有样式，实施时先读现有 `.session-workspace-items` 规则再改）
- 小额 transition 补充：`.preview-tab`、`.panel-dock-tab` 的背景/颜色过渡（active 态切换）
- **reduced-motion 清单同步扩展**：styles.css 138-143 的关停块把上述所有新增 animation 类加入列举清单；同时新增 `html[data-ui-motion="off"]` 关停块（规则同 reduced-motion，保留 `.spinning` 语义例外），两块注释互相引用
- 遵守踩坑纪律：styles.css 改动用 edit 工具按选择器锚定，改后 `git diff` 核验零误伤；不按行号 sed

### 第 4 步：App.tsx 模态与面板接入（约 2154-2214 及相关处）
- `import { useExitPresence, ExitWrap } from "./components/Presence"`
- 逐处接入（每处 = 一个 hook 调用 + ExitWrap 包裹 + 条件从 `flag` 改 `presence.rendered`）：
  - SettingsDialog（settingsOpen，exitMs 160）
  - PermissionDialog（permission，exitMs 130）
  - DelegationTranscript（transcriptTarget，exitMs 160）
  - renameSession / deleteSession / rollbackTarget / removeWorkspace 四个确认框（exitMs 160）
  - sidebar-flyout（sidebarFlyoutOpen，exitMs 160）
- 预览面板（previewOpened，exitMs 180）特殊处理：
  - `previewVisible = presence.rendered` 驱动 work-area 的 `with-preview`/`with-preview-empty` class、`--preview-split` style、PreviewDivider 渲染（保证退场期间布局不塌缩）
  - ArtifactPreview（含 empty-state 分支）用 ExitWrap 包裹
  - `browserSuspended` 条件追加 `previewPresence.exiting`（退场开始即挂起 native 视图）

### 第 5 步：App.tsx 其余点位
- 会话分组：`{!collapsed && <div className="session-workspace-items">…}` 改为常驻渲染 `<div className={`session-workspace-items${collapsed ? " collapsed" : ""}`}>`（含内层 wrapper 以支持 grid-rows 过渡；默认折叠的组子项常驻 DOM，成本可忽略）；`data-row-expanded`/`aria-expanded` 钩子语义不变
- 侧栏三视图/landing/设置 tab 的 fade 已由第 3 步 CSS 覆盖，TSX 无需改

### 第 6 步：PanelDock.tsx
- `const { rendered, exiting } = useExitPresence(open, 160)`
- `!rendered` 时返回 FAB（挂载播 fab-in）；`open || rendered` 时返回 ExitWrap 包裹的 `.panel-dock`（退场播 dock-out，退场期间 FAB 不渲染，卸载后 FAB 挂载淡入）
- dock 内部 tab 切换动画已由 CSS 覆盖，TSX 不改

### 第 7 步：组件内部模态
- AutomationSettings.tsx：`form` modal 用 useExitPresence + ExitWrap（exitMs 160）
- ConversationPane.tsx：lightbox 两处（205 行 expanded、1750 行 previewingAttachment）接入
- WorkspaceTree.tsx：重命名/新建两个 modal（141/154）接入
- DelegationTranscript.tsx / RuntimeDialogs.tsx 组件本身不改（App 层包裹已覆盖）

### 第 8 步：「界面动效」开关
- `src/shared/protocol.ts`：`AppearanceSettings` 加 `motion?: boolean`（注释：缺省/undefined = 开启；false = 整体关停过渡与动画，系统 prefers-reduced-motion 同效）
- `src/main/settings.ts`：归一化 `motion: appearanceSource.motion !== false`（照 showThinking 模式，约 399 行）
- App.tsx 外观 tab（interface-tuning-settings section，约 1066 行）：加 checkbox「界面动效」，checked={settings.appearance.motion !== false}，onChange 即时 setState（照 showThinking 预览模式），保存走既有 appearance.save / settings.save（Pick 已含 appearance，无协议命令改动）；section hint 文案补一句
- App.tsx data-ui-* effect（1388 附近）：加 `["data-ui-motion", settings.appearance.motion === false ? "off" : undefined]`，依赖数组（1403 行）同步加 `settings.appearance.motion`

### 第 9 步：主题契约五处镜像同步（踩坑纪律：新增 data-ui-* 必须全部同步）
1. 仓库 `AGENTS.md` 主题 bullet 的 data-ui-* 清单加 `data-ui-motion`（值 off，语义：关停界面动效，主题无需响应）
2. `docs/theme-guide.md` 对应章节
3. `C:\Users\li857\.agents\skills\pidesktop-theme-creator\SKILL.md`
4. 该 skill 的 `references/variables.md`
5. 该 skill 的 `scripts/check_theme.py`（若维护合法 data-ui-* 白名单则加入）

### 第 10 步：验证与收尾
- `npm test` 全绿（含新 Presence.test.tsx）；`npm run build` 全绿
- 目视自查要点（dev 模式）：设置/权限/确认框开合、预览面板开合（含 browser tab 激活时关闭）、面板坞开合与 tab 切换、侧栏三视图切换、分组展开折叠、Toast 出现、设置 tab 切换；开启动效关闭开关后全部瞬时切换无残留；壁纸毛玻璃模式下对话框动画无闪烁
- `docs/迭代记录.md`：待办如有对应项移入已完成，按现有格式写实现摘要；无则新增条目
- commit：`feat(ui): 全局界面动效——对话框/面板/切换动画与界面动效开关`（只 add 本次涉及文件，commit 前核对 git status，防并行会话改动混入）

## 动画点位清单（18 处）

| # | 点位 | 实现 | 时长(进/出) |
|---|---|---|---|
| 1 | 设置对话框 | hook+CSS | 200/160ms |
| 2 | 权限对话框 | hook+CSS | 150/130ms |
| 3 | DelegationTranscript | hook+CSS | 200/160ms |
| 4-7 | 重命名/删除/回滚/移除工作区确认框 | hook+CSS | 200/160ms |
| 8 | Automation 创建/编辑 modal | hook+CSS | 200/160ms |
| 9 | WorkspaceTree 重命名/新建 modal×2 | hook+CSS | 200/160ms |
| 10 | 图片 lightbox×2 | hook+CSS（纯 fade） | 200/160ms |
| 11 | 预览面板开合（含 browserSuspended 联动） | hook+CSS | 200/180ms |
| 12 | 面板坞关闭+FAB 淡入+tab 切换 | hook+CSS | 150-220/160ms |
| 13 | sidebar-flyout | hook+CSS | 180/160ms |
| 14 | 设置对话框 9 tab 切换 | 纯 CSS 重挂载 | 150ms |
| 15 | automation 任务/运行记录子页 | 纯 CSS 重挂载 | 130ms |
| 16 | 侧栏三视图（topics/files/agents） | 纯 CSS 重挂载 | 130ms |
| 17 | 会话分组展开/折叠 | TSX 常驻化+grid-rows 过渡 | 200ms |
| 18 | Toast（error/checkpoint/automation） | 纯 CSS 挂载 | 180ms |

跳过（明确不做）：会话切换淡入（用户确认）、预览内容区 browser/terminal tab 动画（native 视图）、消息区/composer 动画（流式性能红线）、automation 的 window.confirm（原生对话框）、分屏格子增删动画（拖拽 reflow 风险，属会话切换类）。

## 风险与假设
- **退场残留阻塞**：ExitWrap 用 inert + pointer-events:none 双保险，卸载定时器有 cleanup 与重开竞态处理，且 Presence 单测覆盖
- **exitMs 与 CSS 退场时长不一致**：以 CSS 注释对照表 + 调用点注释互指，review 时逐项核对
- **display:contents 包装层**：不参与布局/fixed 定位/a11y 树，子树不重挂载（组件 state 保留）；若个别对话框内有依赖父级结构的 CSS（如 `> header` 选择器），display:contents 的 div 位于 modal-backdrop 之外，不影响其内部结构选择器
- **grid-rows 分组过渡**：Chromium 43 完整支持 0fr/1fr 过渡；折叠组子项常驻 DOM（默认折叠态），几十会话量级成本可忽略
- **主题兼容**：现有 4 主题均未给受影响类定义 animation/transform；`--overlay` 遮罩淡入用 opacity 不改 background 值，全局通用
- 假设：应用内对话框即用户所说「窗口打开」（Electron 主窗口本身无打开动画需求）
