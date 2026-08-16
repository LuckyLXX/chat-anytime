# 主题编写指南

自定义主题是一份 CSS（可选：同目录图片 / 字体资产）。导入方式：设置 → 外观 →「导入 CSS」或「导入主题目录」（目录内放 `theme.css` 与用到的资产文件）。主题 CSS 原样注入页面，不做选择器过滤——颜色、字体、布局、动画都可以改。

## 明暗模式

用 `data-theme-effective` 区分模式，应用会跟随系统/用户选择自动切换：

```css
:root[data-theme-effective="light"] { --surface: #ffffff; }
:root[data-theme-effective="dark"]  { --surface: #0f172a; }
```

ChatAnyTime 的 `html.theme-light` / `html.theme-dark` / `--bg-primary` 等旧写法会自动转换，旧模板可直接导入。

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

**区域钩子 `data-pane`**：`sidebar` `topbar` `work-area` `conversation` `timeline` `composer` `task-panel` `preview` `settings-dialog` `permission-dialog`

```css
[data-pane="composer"] { border-image: url(frame.webp) 0 220 fill; border-radius: 0; }
[data-pane="sidebar"]  { border-right: 2px solid var(--accent); }
```

**消息角色 `data-role`**：`user` / `assistant` / `extension`（加在每条消息的 article 上）。

**UI 状态（`<html>` 布尔属性，出现即真）**：`data-ui-settings-open` `data-ui-workspace-open` `data-ui-chat-empty` `data-ui-generating` `data-ui-preview-open` `data-ui-permission-pending`

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
