# 创意参考配方

以下是可抄、可拆、可混的参考配方——它们是起点与灵感库，不是天花板，真正的约束只有 SKILL.md 的无障碍规则。所有配方只使用契约钩子（`data-pane` / `data-control` / `data-role` / `data-ui-*` / `--pi-layer-*` / `--pi-overlay-*`）或元素型后代选择器，规则因此能跨应用版本存活。

## 覆盖层级

主题能触达的范围，保障从强到弱：

| 层级 | 写法 | 保障 |
| --- | --- | --- |
| ① 契约控件 | `[data-pane="composer"] [data-control="send"]` | 公开 API，跨版本安全 |
| ② 区域内元素选择器 | `[data-pane="sidebar"] button`、`[data-pane="settings-dialog"] select` | 钩子有契约，元素选择器天然安全 |
| ③ 区域内类名 | `[data-pane="composer"] .composer-select-menu button` | 事实稳定，无契约——应用升级后需复查 |
| 契约之外 | 右键菜单、错误 toast、重命名/移除小对话框、内嵌编辑器（vditor 工具栏、Mermaid）、沙箱 HTML artifact | 仅 token 颜色或不可改——不要把主题的识别度建立在这层 |

## 立体按钮

多层渐变 + 内阴影伪造实体边缘；`:active` 完成按压手感。

```css
[data-pane="composer"] [data-control="send"],
[data-pane="composer"] [data-control="stop"] {
  border-radius: 9px;
  background: linear-gradient(180deg, #8ff0ff, var(--accent) 45%, #0098b8);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 45%),   /* 顶部高光 */
              inset 0 -3px 5px rgb(0 0 0 / 28%),       /* 底部内阴影 = 侧壁 */
              0 4px 0 #00687f,                          /* 实体厚度 */
              0 7px 14px rgb(0 0 0 / 35%);              /* 投影 */
  transition: transform .08s, box-shadow .08s; /* 应用全局过渡不含 transform——需自带 */
}
[data-pane="composer"] [data-control="send"]:active,
[data-pane="composer"] [data-control="stop"]:active {
  transform: translateY(3px);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), 0 1px 0 #00687f, 0 2px 5px rgb(0 0 0 / 30%);
}
```

`send` 与 `stop` 成对设计（生成状态互换占位）；保留可见的 `:disabled` 态（变暗、不下沉）。

## 异形容器

`clip-path` 把输入卡（或任意区域）切成任意多边形。边框不会跟着切角走，所以用一个略放大的同形伪元素垫在后面画边：

```css
[data-pane="composer"] {
  border: none; border-radius: 0;
  clip-path: polygon(18px 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%, 0 18px);
}
[data-pane="composer"]::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  background: var(--accent);
  clip-path: polygon(18px 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%, 0 18px);
  transform: scale(1.012);
}
```

输入卡本身就是绝对定位，直接可用；其他区域需补 `position: relative`。文字内边距避开切角。文本域本身也可异形：`[data-pane="composer"] textarea`。

## 霓虹描边

单边 `border-image` 渐变沿区域边缘发光：

```css
[data-pane="sidebar"] { border-right: 1px solid; border-image: linear-gradient(to bottom, var(--accent), #ff2d95 55%, var(--accent)) 1; }
[data-pane="topbar"] { border-bottom: 1px solid; border-image: linear-gradient(to right, var(--accent), #ff2d95 60%, transparent) 1; }
```

## 渐变大字

用于空态与标题——透明文字叠渐变，光晕用 `filter`（text-shadow 会从透明字形里透出来）：

```css
[data-ui-chat-empty] [data-pane="timeline"] h1 {
  background: linear-gradient(90deg, var(--accent), #ff2d95, var(--accent));
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 0 12px rgb(0 240 255 / 35%));
}
```

## 玻璃拟态

半透明面板叠在装饰层上，按模式分档：

```css
[data-theme-effective="dark"] [data-pane="sidebar"] { background: rgb(7 10 20 / 86%); backdrop-filter: blur(14px) saturate(120%); }
[data-theme-effective="dark"] [data-pane="topbar"] { background: rgb(9 13 26 / 82%); backdrop-filter: blur(12px); }
```

搭配 `--pi-layer-*` 背景才有内容可糊。对比度要对着合成后的实际底色复核，而不是裸 token。

## 漂移网格层

纯 CSS 动画背景——渐变层周期对齐即可无缝循环：

```css
:root {
  --pi-layer-neon-grid:
    radial-gradient(ellipse 120% 55% at 50% 108%, rgb(255 45 149 / 16%), transparent 62%),
    repeating-linear-gradient(to right, rgb(0 240 255 / 7%) 0 1px, transparent 1px 56px),
    repeating-linear-gradient(to bottom, rgb(0 240 255 / 5%) 0 1px, transparent 1px 56px);
}
@media (prefers-reduced-motion: no-preference) {
  [data-theme-layer="neon-grid"] { animation: grid-drift 14s linear infinite; }
}
@keyframes grid-drift { to { background-position: 0 0, 0 0, 0 56px; } }
```

在 `:root[data-theme-effective="light"]` 里对同一变量声明不同的值，即得零 JavaScript 的明暗双画面。

## CRT 扫描线

位于全部界面之上、对话框之下——保持轻：

```css
:root {
  --pi-overlay-crt:
    repeating-linear-gradient(to bottom, rgb(2 6 16 / 11%) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse at center, transparent 58%, rgb(4 8 20 / 38%) 100%);
}
```

深色线约 ≤12% 透明度；开启后复查正文可读性。浅色模式取深色值的大约三分之一。

## 状态反应

`<html>` 上的布尔 `data-ui-*` 属性驱动反应式样式：

```css
@media (prefers-reduced-motion: no-preference) {
  [data-ui-generating] [data-pane="composer"] { animation: hum 2.6s ease-in-out infinite; }
  [data-ui-generating] [data-pane="composer"] [data-control="stop"] { animation: pulse 1.2s infinite; }
}
[data-ui-settings-open] [data-pane="work-area"] { filter: saturate(.85) brightness(.92); }
[data-ui-chat-empty] [data-pane="sidebar"]::after { content: "STANDBY"; opacity: .4; }
```

值得反应的状态：`data-ui-generating`（生成中）、`data-ui-chat-empty`、`data-ui-settings-open`、`data-ui-preview-open`、`data-ui-workspace-open`、`data-ui-permission-pending`、`data-ui-split-open`、`data-ui-design-open`、`data-ui-sidebar-collapsed`。

## 实战配方（含真实样张）

以下技法经一个真实的结构主题（外部皮肤移植，素材与许可说明见当时的主题 README）逐项落地验证。
该主题已不在仓库 `themes/` 内（只在 git 历史里），配方本身与具体素材无关，可直接套用。

### 九宫格镂空画框（按钮 / 输入框）

素材是一张"空心画框"（如 1800×588：顶部蝴蝶结+蕾丝、金边、瓷面中空），
`border-image-slice` 切出四边，中间镂空——控件本体放在镂空处，画框用
伪元素悬于控件之外一圈：

```css
[data-pane="composer"]::before {
  content: ""; position: absolute; box-sizing: border-box;
  inset: -22px -16px -14px; z-index: 1; pointer-events: none;
  border-style: solid;
  border-width: 72px 54px 52px 54px;               /* 视觉厚度 */
  border-image-source: url(assets/composer-frame.webp);
  border-image-slice: 170 120 115 120;             /* 素材坐标切分 */
  border-image-width: 72px 54px 52px 54px;
  border-image-repeat: stretch;
  filter: drop-shadow(0 9px 18px rgb(5 13 38 / 22%));
}
[data-pane="composer"] > .composer-footer,
[data-pane="composer"] > .composer-input-row { position: relative; z-index: 2; }
```

注意：slice 数值必须 ≤ 素材尺寸（检查器会校验）；控件侧容器要内容驱动，
不要大 `min-height`（见 variables.md 陷阱 #3）。

### 实心横幅按钮（`fill` 九宫格）

`border-image-slice` 加 `fill` 时，中央 1px 区域平铺填充整块按钮：
素材"两端金饰 + 中央瓷面/深蓝"的横幅可整体作为按钮皮肤：

```css
[data-pane="sidebar"] [data-control="new-session"] {
  color: #152246;                 /* 与填充色成对比 */
  border-style: solid; border-width: 0 40px;
  border-image-source: url(assets/new-session.webp);
  border-image-slice: 0 210 0 210 fill;
  border-image-width: 0 40px; border-image-repeat: stretch;
  border-radius: 0; background: none;
}
```

### 多背景四角画框（侧栏金边）

一个伪元素叠四张角饰 + 四段渐变直边（角饰素材居中留白，只画一个花角）。
背景图无法翻转——四种角用预镜像素材（`Pillow.transpose(FLIP_LEFT_RIGHT /
FLIP_TOP_BOTTOM / ROTATE_180)` 生成 `*-tl/-bl/-br.webp`），或改用
`--pi-overlay-corner` 层 + `[data-theme-layer]` 的 `transform: scaleX(-1)`：

```css
[data-pane="sidebar"]::before {
  content: ""; position: absolute; inset: 0; z-index: 4; pointer-events: none;
  background:
    url(assets/sidebar-corner.webp)   right 1px top 1px / 130px 130px no-repeat,
    url(assets/sidebar-corner-tl.webp) left 1px top 1px / 130px 130px no-repeat,
    url(assets/sidebar-corner-bl.webp) left 1px bottom 1px / 130px 130px no-repeat,
    url(assets/sidebar-corner-br.webp) right 1px bottom 1px / 130px 130px no-repeat,
    linear-gradient(90deg, #eecE99, #be914b, #eecE99) left 62px top 8.875px / calc(100% - 124px) 1.35px no-repeat,
    /* …另外三段对称渐变边 */
}
```

### 视口立绘层 + 暗色变体

立绘与装饰放 `--pi-layer-*`（壁纸之上、界面之下），按明暗模式与 `<html>` 状态
分别声明；暗色压暗用预调暗素材（Pillow `ImageEnhance.Brightness(0.84)` +
`Color(0.92)`）或 `[data-theme-layer]` 的 `filter`：

```css
:root[data-theme-effective="light"] {
  --pi-layer-maid-left: url(assets/maid-left.webp) left calc(var(--layout-sidebar-width) + 8px) bottom / auto 96vh no-repeat;
}
:root[data-theme-effective="dark"] {
  --pi-layer-maid-left: url(assets/maid-left-dark.webp) left calc(var(--layout-sidebar-width) + 8px) bottom / auto 96vh no-repeat;
}
:root[data-theme-effective="light"]:not([data-ui-chat-empty]) { --pi-layer-maid-left: /* 对话态：缩小 */ }
```

### 列表底部渐隐（为装饰舞台让位）

滚动容器上挂 mask 渐变，末屏内容淡出——吉祥物/饰带区自然留空：

```css
[data-pane="sidebar"] .session-list {
  -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 200px), rgb(0 0 0 / 45%) calc(100% - 140px), transparent calc(100% - 96px));
  mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 200px), rgb(0 0 0 / 45%) calc(100% - 140px), transparent calc(100% - 96px));
}
```

### 纵列重排（`order`，不改 DOM）

布局与 JSX 顺序不一致时用 flex `order` 重排（如把"新建话题"从列表下方
移到品牌卡下方）：

```css
[data-pane="sidebar"] > .brand-row { order: 1; }
[data-pane="sidebar"] > [data-control="new-session"] { order: 2; }
/* …其余子项按需排序 */
```

注意 `:last-child` 等 DOM 位置选择器不受 `order` 影响；重排后子项间的默认
边距需要手动补齐。

## 折叠侧栏

折叠态下 `[data-pane="sidebar"]` 命中的是 48px 窄条（`data-ui-sidebar-collapsed`
就加在那个 div 上），整栏装饰会一并被塞进窄条。分写两态即可：

```css
/* 展开态专属：整栏立绘/边饰/纵向排布 */
html:not([data-ui-sidebar-collapsed]) [data-pane="sidebar"] {
  background: linear-gradient(180deg, rgb(255 255 255 / 92%), rgb(246 249 255 / 96%));
}
html:not([data-ui-sidebar-collapsed]) [data-pane="sidebar"]::before { /* 角饰 */ }

/* 折叠态专属：窄条自己的底色与发光，宽度基准用公开量 */
[data-ui-sidebar-collapsed] [data-pane="sidebar"] {
  width: var(--layout-sidebar-collapsed-width);
  background: linear-gradient(180deg, rgb(12 18 32 / 92%), rgb(18 26 44 / 96%));
  border-right: 1px solid var(--accent-border);
}
```

注意：折叠态下展开飞出层（侧栏面板）仍是带 `[data-pane="sidebar"]` 的整栏，
所以展开态规则必须用 `html:not([data-ui-sidebar-collapsed])` 限定（而不是反过来
只给窄条写样式）。窄条上的按钮不是契约钩子，不要依赖。

## 分屏与多实例

分屏下 `conversation` / `timeline` / `composer` / `question-panel` 各出现多次，
而根上的 `data-ui-generating` / `data-ui-chat-empty` / `data-ui-attachments` 只描述
**焦点格**——根状态与区域组合的规则默认会打到所有格子，需要叠加
`[data-pane-active]`（焦点格的 `conversation` 区域带这个布尔属性）：

```css
/* 只给焦点格的输入框加呼吸光晕（分屏下其他格子不闪） */
[data-ui-generating] [data-pane="conversation"][data-pane-active] [data-pane="composer"] {
  animation: glow 2s ease-in-out infinite;
}
/* 失焦格降饱和度，视觉上分层 */
[data-pane="conversation"]:not([data-pane-active]) { filter: saturate(.9); }
```

分屏格头另有 `[data-control="pane-maximize"]` / `[data-control="pane-close"]`，
可以用 `[data-ui-split-open]` 只在分屏时显示额外装饰。`--composer-space` /
`--composer-height` 是每格独立的（写在各自的 conversation 区域上），
高度类装饰请引用它们而不是写死像素。

## 设计模式工作台

`data-ui-design-open` 时常规会话布局被画布工作台（`[data-pane="design"]`）替换，
内部四区分别是 `design-toolbar` / `design-layers` / `design-canvas` /
`design-inspector`，画布上方还有浮动工具胶囊 `design-tools`
（按钮 `[data-control="design-tool-*"]`，`aria-pressed` 标激活）：

```css
[data-ui-design-open] [data-pane="design-canvas"] {
  background:
    radial-gradient(circle at 50% 0%, rgb(56 189 248 / 8%), transparent 60%),
    var(--panel-bg-preview, var(--panel-bg));
}
[data-ui-design-open] [data-pane="design-tools"] {
  border-radius: 999px; border: 1px solid var(--accent-border);
  box-shadow: var(--shadow-lg);
}
[data-ui-design-open] [data-pane="design-tools"] [aria-pressed="true"] {
  color: var(--text-on-accent); background: var(--accent);
}
```

画布的点阵、参考线、选择框由 `--border` / `--accent` 派生（不在契约内的类名），
换这两个 token 就能整体换调，不另写规则也可以。

## 界面微调对齐

用户在【设置 → 外观 → 界面微调】选密度/圆角时，应用会写
`data-ui-density` / `data-ui-radius` 并投影成 `--ui-density-scale` /
`--ui-control-radius` / `--ui-container-radius`。主题有两种搞法：

```css
/* A. 什么都不做——主题的固定尺寸不受用户偏好影响 */
/* B. 让主题尺寸跟着跑（推荐给尺寸敏感的主题） */
:root { --card-radius: calc(12px * var(--ui-density-scale, 1)); }
[data-pane="sidebar"] [data-row-kind="session"] { border-radius: var(--ui-control-radius, 6px); }
```

只覆写 `--ui-*` 三个量本身也可以（相当于给用户档位换一套尺度），
但别把它们写成非数值/百分比，计算式会崩。
