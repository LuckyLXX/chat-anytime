# PiDesktop 设计模式（Design Studio）实施计划

## 背景与目标

新增「设计模式」：类似 OpenPencil 的 AI 原生前端页面设计工作台。核心理念 **Design-as-Code**——设计稿是结构化 JSON 节点树，AI 通过 `design_*` 工具集直接读写（数据级操作，非 CDP），画布实时渲染，用户可轻量手动编辑并「选中元素发给 AI」迭代，最终导出 HTML+CSS 单文件。

用户已确认的三项决策：
1. **界面形态**：设计工作台式——画布占主体、图层/属性面板齐全，AI 对话收窄为侧栏（复用现有 ConversationPane，绝不复制第二套 composer）
2. **手动编辑深度**：轻量编辑——选中/拖动/手柄缩放/属性面板改颜色文字尺寸 +「选中元素发给 AI 修改」
3. **导出格式**：HTML + CSS 单文件（内联样式）

## 总体架构

```
AI 工具（utility）                     用户（renderer）
runtime-design.ts                      DesignStudio（画布/图层/属性）
    │ design_* customTools                 │ design.edit / design.save 等命令
    ▼                                      ▼
design-store.ts（utility，权威数据源）◄── RuntimeCommand（泛型通道，现成）
    │ 读写 <workspace>/designs/*.design.json
    ▼
design.state 推送（RuntimeMessage 泛型通道，经 main 转发）→ renderer store → 画布重渲
```

- **不走 CDP / browser-automation**：画布是 renderer 内 React 组件，数据驱动，比 RPC 稳定且零新依赖（DOM/CSS 渲染，无 Fabric/Skia）。
- **变更单管道**：AI 与用户的编辑都走同一 `applyDesignOps(doc, ops)` 纯函数（放 shared，两端共用），保证语义一致。
- **乐观更新**：用户拖动中纯本地渲染，mouseup 才发 `design.edit`；utility 应用后 revision+1 回推 `design.state`，renderer 收到 revision ≤ 已见的推送直接跳过（防回环重渲）。

## 提示词注入与缓存纪律（专门设计）

对照仓库既有 cache discipline（工具 schema 字节稳定、动态状态只进对话尾部、不碰 system prompt / per-turn 注入），design 工具集的注入设计：

1. **唯一注入点 = 工具定义本身（静态、字节稳定）**：6 个工具的 description + typebox schema 全部静态写死，不含任何会话/文档动态状态；节点类型/属性表/坐标系/auto-layout 语义/「每个节点起 name」惯例都压缩进 description，一次进前缀缓存。**字数预算：全部 6 个工具定义合计控制在 ~1.5K token 内**，description 写紧凑（要点式，不写长篇教程）。
2. **当前文档状态永不注入请求前缀**：不进 system prompt、不做 session_start / per-turn 注入、不进工具 schema。模型需要上下文时主动调 `design_list` / `design_read` 拉取——结果落在**对话尾部**（对前缀缓存零破坏，这也是模型最新鲜的记忆位置）。
3. **工具执行结果带轻量回执**：`design_update` 返回「成功 N 项 + 新建 id 映射 + 当前 revision + 当前文档名」；未打开文档时 `design_update`/`design_read` 返回可读错误并提示先 `design_list`/`design_open`（模型自纠路径）。回执文本 = 尾部内容，安全。
4. **工具激活策略避免缓存抖动**：design 工具**常驻激活**（不随 UI 设计模式开关切换 `setActiveToolsByName`——切换工具集会使前缀缓存整体失效，是比多 6 个工具定义更贵的成本；对照 browser 11 工具常驻先例）。`settings.design.enabled` 只在 execute 内实时判断，注册与激活不变。
5. **画布入口提示走尾部**：AI 在用户未开设计模式时使用工具，结果文本附一句「可在界面顶部『设计』按钮打开设计画布查看」（静态文案，非状态注入）。

## 分支策略（不污染主分支）

- 实施前从当前 HEAD 新建本地分支 `feat/design-studio`，全部提交落在此分支。
- 计划内所有 commit（按步骤分次提交，格式 `feat(design): …` / `test(design): …` / `docs(design): …`）均提交到该分支。
- **不执行 merge / push**：完成后主分支保持不动，由用户审查后决定合并方式（本地 merge 或继续在分支迭代）。

## 数据模型（新建 `src/shared/design-schema.ts`）

```ts
interface DesignDoc { version: 1; id: string; name: string; canvas: { width: number; height: number; background?: string }; nodes: DesignNode[]; revision: number }
interface DesignNode {
  id: string; type: "frame" | "rect" | "text" | "image";
  name?: string; x: number; y: number; w: number; h: number; visible?: boolean;
  fill?: string; stroke?: string; strokeWidth?: number; radius?: number; opacity?: number;
  shadow?: string;                       // CSS box-shadow 值
  text?: string; fontSize?: number; fontWeight?: number; color?: string; lineHeight?: number; align?: "left"|"center"|"right"; // text 节点
  src?: string;                          // image：http(s)/data URL（v1 不做本地文件路径）
  layout?: { direction: "row"|"column"; gap?: number; padding?: number|{top?,right?,bottom?,left?}; justify?: string; align?: string }; // frame auto-layout（flex）
  children?: DesignNode[];
}
type DesignOp =
  | { op: "create"; parentId?: string | null; index?: number; node: DesignNode }
  | { op: "update"; id: string; patch: Partial<DesignNode> }   // 不允许经 patch 改 children（用 move）
  | { op: "delete"; id: string }
  | { op: "move"; id: string; parentId?: string | null; index?: number }
  | { op: "replace"; nodes: DesignNode[] };                    // 整树替换（undo / 大改）
```

纯函数（全部单测）：`normalizeDesignDoc`（容错归一化：clamp 几何、丢非法类型、补 id）、`findNode`、`applyDesignOps`（原子批量应用，任一 op 失败整批拒绝并返回错误，防止半应用状态）、`cloneNodeWithNewIds`（Ctrl+D / AI 复制用）。

坐标系：x/y/w/h 相对父节点。frame 可声明 `layout`——有 layout 的 frame 子节点按 flex 排布（x/y 忽略），无 layout 则绝对定位。

## 实施步骤

### 第 0 步：建分支
`git checkout -b feat/design-studio`（从当前 HEAD），后续全部提交在此分支。

### 第 1 步：shared 层（schema + 导出）
- 新建 `src/shared/design-schema.ts`：上述类型 + 纯函数。
- 新建 `src/shared/design-export.ts`：`exportDesignHtml(doc): string`——节点树 → HTML 单文件：绝对定位 div（left/top/width/height 内联）；layout frame → `display:flex` + gap/padding；文本节点带字体样式；image → `<img>`；body margin 0、画布背景。纯函数无 DOM 依赖（utility 可直接用）。
- 新建 `src/shared/design-schema.test.ts`、`design-export.test.ts`（嵌套/布局/文本/非法输入容错）。

### 第 2 步：utility 存储（新建 `src/main/design-store.ts`）
- 参照 todo-store / plan-store 范式：文档文件 `<workspace>/designs/<name>.design.json`，原子写（mkdir → tmp → rename，`safeRelativePath` 防穿越）；`listDesigns`（扫描目录）、`readDesign`、`writeDesign`。
- 会话绑定：`SessionRuntimeRecord.designDoc?: { docId; path; doc: DesignDoc; dirty: boolean }`（内存态，跨会话文档在文件系统不丢，v1 不做会话恢复）。
- 变更后推 `{type:"design.state", ...doc, dirty}`（revision 单调递增）。

### 第 3 步：AI 工具（新建 `src/main/runtime-design.ts`）
- `buildDesignTools(deps)` 产出 `ToolDefinition[]`（typebox schema，注入设计遵循上文「提示词注入与缓存纪律」小节）：
  - `design_list`（免权限）：列出 workspace 设计文档
  - `design_create {name, width?, height?}`：新建并绑定为当前文档
  - `design_open {name | docId}`：打开并返回整树
  - `design_read {nodeId?}`：读当前文档整树或子树（长对话后刷新）
  - `design_update {ops: DesignOp[]}`：批量应用，返回「成功 N 项 + 新建节点 id 映射 + revision」；改的是 workspace 文件 → 权限门按 write 风险（workspace 模式自动放行）
  - `design_export {path?}`：导出 HTML 到 workspace（默认 `designs/exports/<name>.html`）→ write 风险
- 注册四处登记（参照 browser 簇）：`SessionRuntimeRecord.designTools` + `buildRecordTools` + `toolNamesFor` + `createSession` 构造 deps 并入 `recordCustomTools`。**子代理不给**（browser 先例）。
- 开关：`settings.design.enabled`（缺省启用，execute 实时读）。**顺带补齐 `settings.save` 在 utility 的镜像**（当前只镜像 5 个字段，browser 已有 live 滞后缺口——同一处补上 `browser` 与 `design`，否则新开关 live 语义落空）。
- 权限：`permissions.ts toolRisk` 加 design_update/design_export → `"write"`；`runtime-permissions.ts summarizeArgs` 加文案。

### 第 4 步：协议（`src/shared/protocol.ts`）
- `RuntimeCommand` 增加：`design.list / design.new / design.open / design.edit {ops} / design.save / design.export {path?} / design.close / design.query`（均带可选 sessionId 走 `resolveTargetRecord`）。
- `RuntimeMessage` 增加：`{type:"design.state", revision, docId, name, canvas, nodes, dirty}` 与 `{type:"design.docs", docs: [...]}`（list 结果）。
- `DesktopSettings` 增加 `design?: { enabled?: boolean }`（main `updateSettings` 持久化镜像 + 第 3 步的 utility 镜像）。
- `pi-runtime.ts handleCommand` 加各 case；`design.query` 在会话激活/创建后也主动推一次（切会话画布跟上）。

### 第 5 步：渲染端 store（`src/renderer/src/store.ts`）
- `handleRuntimeMessage` 加 `design.state` / `design.docs` case：revision ≤ 已见跳过；存 `designDoc`、`designDocs`、`seenRevision`。

### 第 6 步：画布组件（新建 `src/renderer/src/design/`）
- `DesignStudio.tsx`：工作台外壳 `data-pane="design"`——顶部工具栏（文档名/保存状态、缩放控件、undo/redo、导出、发给 AI）+ 左侧图层树（`DesignLayers.tsx`：显隐 toggle、点选联动）+ 画布区 + 右侧属性检查器（`DesignInspector.tsx`：几何数字输入、填充/描边/圆角/透明度、文本内容与字号颜色、节点 name）。
- `DesignCanvas.tsx`：无限画布——滚轮缩放（5%–400%）、空格/中键平移、fit 按钮、点阵背景；节点递归渲染 `DesignNodeView.tsx`（div + CSS；layout frame 用 flex）；选中框 + 8 手柄（角/边，Shift 等比）；拖动（含子树，移动时对兄弟节点边缘/中心 6px 吸附 + 参考线）；双击 text 行内编辑；Delete 删除、Ctrl+D 复制。
- 编辑流：本地乐观应用 `applyDesignOps` → 变更收敛时机（mouseup / 属性输入防抖 300ms）发 `design.edit`。
- undo/redo：renderer 侧快照栈（上限 50，AI 的 design.state 推送同样入栈），undo 用 `{op:"replace"}` 整树回写——AI 与用户的改动都可撤销。
- 「发给 AI」：工具栏按钮（`data-control="design-send-ai"`）把选中节点（含子树）JSON 摘要经 `composerBridge` 注入焦点格输入框（复用 browser-pick 的注入模式）。
- 空态：中央「新建设计 / 打开文档列表 / 用 AI 生成」（后者往 composer 注入引导句）。

### 第 7 步：工作台形态接入（`App.tsx` + `styles.css`）
- App 状态 `designMode`（localStorage `pidesktop.design-mode` 持久化）；topbar 加切换按钮 `data-control="design-toggle"`（Palette 图标）。
- work-area 渲染分支：designMode 时渲染 `[DesignStudio flex:1] [可拖分隔条] [ConversationPane 侧栏 minmax(300px, 26%)]`——**ConversationPane 完整复用**（焦点格语义不变）；splitTree 保留但暂不渲染（退出设计模式即恢复分屏）；预览面板 JSX 不挂载（天然互斥）。窄窗 <900px 时上下堆叠。
- `<html>` 加 `data-ui-design-open` 布尔属性；新 data-control 系列同步进 AGENTS.md 契约与 `docs/theme-guide.md`；工作台配色用现有 `--panel-bg-*` token 跟随主题。
- 分屏与设计模式互斥：设计模式下右键分屏入口置灰/忽略。

### 第 8 步：测试与文档
- 新增测试：schema 纯函数、export 转换、design-store CRUD（临时目录）、runtime-design 参数与 ops 应用校验、`DesignCanvas.test.tsx`（happy-dom 冒烟：节点渲染/选中回调）。
- `AGENTS.md` 加 Design 条目（工具簇/store/协议/渲染/契约/边界：子代理无、免 CDP、单管道、缓存纪律）。
- `docs/theme-guide.md` 补新钩子；`docs/迭代记录.md` 加完成条目。
- 全部提交到 `feat/design-studio` 分支（`feat(design): 设计模式——AI 原生前端页面设计工作台`，按步骤分次提交）。

## 验证方式

1. `npm test` 全绿（新增约 5 个测试文件）。
2. `npm run build`（双 tsconfig + electron-vite）全绿。
3. `git log --oneline main..feat/design-studio` 确认提交全在分支、主分支零污染。
4. 手动冒烟（用户重启应用后）：开设计模式 → 空态新建 → 对话让 AI「设计一个登录页」→ 画布出现节点树 → 选中拖动/属性面板改色 → 「发给 AI」改按钮文案 → Ctrl+Z 撤销 → 导出 HTML → 打开导出文件核对与画布一致 → 退出设计模式分屏恢复正常。

## 风险与假设

- **ConversationPane 窄侧栏适配**：分屏格子已验证窄格可用，风险低；CSS 打磨在实现时处理。
- **推送体积**：几百节点整树 JSON 数十 KB，变更收敛时机发送 + revision 去重可控；不达预期再加 50ms 节流。
- **AI 写出非法节点**：normalize + applyDesignOps 原子拒绝兜底，工具返回可读错误让模型自纠。
- **并发写冲突**：v1 最后写赢（revision 丢弃过期推送），可接受。
- **image 本地路径 / icon 节点 / 多选框选 / 吸附开关**：列为 v2 候选，不在本次范围。
- 假设：不引入任何新 npm 依赖（画布 DOM/CSS 自绘，图标沿用 lucide-react）。
