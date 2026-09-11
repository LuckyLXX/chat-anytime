// Design Studio capability cluster (utility process): the design_* customTools
// let the model read/write the structured design document (Design-as-Code) —
// data-level ops on the JSON node tree, no CDP. Storage is the workspace file
// layer (design-store.ts); the "currently open document" is bound per session
// record (see pi-runtime). All semantics live in shared/design-schema.ts so AI
// edits and renderer canvas edits go through the same pure functions.
//
// Cache discipline (mirrors browser/vision clusters): tool definitions are
// byte-stable (no dynamic state in description or schema — the model pulls
// fresh document state via design_read/design_list, whose results land at the
// conversation tail). Tools stay registered/active regardless of the settings
// switch; `enabled` is read live per call (no session rebuild). Subagents do
// not get design tools. design_update/design_export carry the "write" risk
// (permissions.ts), so workspace access mode auto-allows them.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve } from "node:path";
import { applyDesignOps, countNodes, createDesignDoc, findNode, makeNodeId, sanitizeDesignName, type DesignDoc, type DesignNode, type DesignOp } from "../shared/design-schema.js";
import { inspectDesignQuality, summarizeDesignLayout } from "../shared/design-quality.js";
import { exportBounds, exportDesignHtml } from "../shared/design-export.js";
import type { DesignSnapshotRequest, DesignSnapshotResult } from "../shared/protocol.js";
import { designFilePath, exportDesignFile, listDesigns, readDesign, writeExportFile, DESIGN_FILE_SUFFIX } from "./design-store.js";

/** 单次 design_update 的 ops 数上限：逼模型分批（先第一屏/一个区域），超限的批
 *  失败回滚也更可控（借鉴 dsh-openpencil 的两批视口预算）。 */
const MAX_OPS_PER_UPDATE = 64;

export interface DesignToolDeps {
  /** 总开关，实时读（settings.design?.enabled !== false），关闭时工具保留注册。 */
  enabled: () => boolean;
  /** 记录工作区（landing 态无工作区时工具给可读错误）。 */
  workspace: () => string | undefined;
  /** 当前会话绑定的文档（record.designDoc.doc）；未绑定返回 undefined。 */
  getDoc: () => DesignDoc | undefined;
  /** 当前绑定文档的磁盘文件名（改名写盘时清理旧文件）。 */
  getDocFileName: () => string | undefined;
  /** 绑定/替换当前文档并推送 design.state（design_create / design_open 成功后调用）。 */
  bindDoc: (doc: DesignDoc, fileName: string) => void;
  /** 持久化：写盘（revision 已由工具推进）+ design.state 推送；返回落盘文件名。 */
  persistDoc: (doc: DesignDoc, previousFileName: string | undefined) => string;
  /** 离屏渲染导出 HTML 并截图（main 进程）；缺省时 design_export 不附缩略图。永不 reject（RPC 层已兜底 ok:false）。 */
  renderSnapshot?: (request: DesignSnapshotRequest) => Promise<DesignSnapshotResult>;
}

const DISABLED_TEXT = "设计模式已在设置中停用（settings.design.enabled），请在设置中开启后再试。";

const CANVAS_HINT = "提示：可在界面顶部「设计」按钮打开设计画布查看与手动微调。";

/** 首次 design_create/design_update 成功回执附带一次的用法要点。教学内容不进
 *  description（tools 数组每请求常驻、破坏前缀缓存即全量重算），落回执尾部
 *  只花一次尾部 token——与 todo/memory 的尾部注入同一纪律。 */
const FIRST_USE_GUIDANCE = [
  "用法要点（本会话仅提示一次）：",
  "- 整套原型：一屏 = 一个顶层命名 frame，并排放置（间隔 ≥80px）；画布放不下先发 {op:'resize'} 扩画布。一次 ≤64 条 ops，先完成一屏/一个区域，成功后再继续下一屏。",
  "- 每个节点都起 name；自起语义化 id 便于后续定位（缺省自动生成并在回执给出映射）。",
  "- 每个 text 节点都显式声明 fontFamily（如 'Inter, system-ui, sans-serif'，中文稿带上中文字体），字号/字重与字距按层级递进；缺省会用内置默认栈，但显式声明才能与选定风格一致。",
  "- 全稿只用一套标尺：圆角、间距、字号都取自固定档位（如圆角 0/2/4/6/8/10/12/16/20/24/9999，间距 2/4/6/8/12/16/20/24/32/40/48/64，字号 11/12/13/14/16/18/20/24/28/32/40/48），不要逐节点微调 0.5px 级别的「差不多」值——这是稿子看着碎的根因，质量门会报 off-scale-* 并给出吸附修复。",
  "- 半透明直接写进 fill/stroke（rgba/hex8）；不要用元素级 opacity 压淡有子内容的容器——子内容会一起变淡，质量门会拦截。",
  "- 回执带「修复 ops」时，把它原样作为下一条 design_update 的 ops 传入，先修复再继续新内容。"
].join("\n");

function checkEnabled(deps: DesignToolDeps): void {
  if (!deps.enabled()) throw new Error(DISABLED_TEXT);
}

function requireWorkspace(deps: DesignToolDeps): string {
  const workspace = deps.workspace();
  if (!workspace) throw new Error("当前没有可用工作区，请先打开一个项目文件夹");
  return workspace;
}

function requireDoc(deps: DesignToolDeps): DesignDoc {
  const doc = deps.getDoc();
  if (!doc) throw new Error("当前会话没有打开的设计文档。请先 design_list 查看已有文档并用 design_open 打开，或用 design_create 新建。");
  return doc;
}

/** 紧凑整树 JSON（模型回读用；字段已 normalize，无冗余）。 */
function docJson(doc: DesignDoc, node?: DesignNode): string {
  const payload = node ?? { id: doc.id, name: doc.name, canvas: doc.canvas, nodes: doc.nodes, revision: doc.revision };
  return JSON.stringify(payload);
}

/** design_node 的宽松 schema：type 必填，其余字段容错（normalizeDesignNode 兜底）。 */
const designNodeSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "节点 id（建议自起语义化 id 便于后续 update/move；缺省自动生成，回执会给映射）" })),
  type: Type.Union([Type.Literal("frame"), Type.Literal("rect"), Type.Literal("text"), Type.Literal("image")], { description: "frame=容器(可嵌套/auto-layout) rect=色块 text=文本 image=图片" }),
  name: Type.Optional(Type.String({ description: "图层名（每个节点都起 name，画布图层树可读）" })),
  x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), w: Type.Optional(Type.Number()), h: Type.Optional(Type.Number()),
  fill: Type.Optional(Type.String({ description: "背景色（CSS color）" })),
  stroke: Type.Optional(Type.String()), strokeWidth: Type.Optional(Type.Number()), radius: Type.Optional(Type.Number()),
  opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  visible: Type.Optional(Type.Boolean({ description: "false=隐藏（画布与导出都不渲染）" })),
  locked: Type.Optional(Type.Boolean({ description: "true=画布上不可拖动/删除；AI 与检查器仍可改" })),
  shadow: Type.Optional(Type.String({ description: "CSS box-shadow 值" })),
  text: Type.Optional(Type.String({ description: "text 节点内容" })),
  fontSize: Type.Optional(Type.Number()), fontWeight: Type.Optional(Type.Number()), color: Type.Optional(Type.String({ description: "text 颜色" })), lineHeight: Type.Optional(Type.Number({ description: "text 行高（字号倍数）" })),
  fontFamily: Type.Optional(Type.String({ description: "text 字体栈（CSS font-family，如 'Inter, system-ui, sans-serif'）；每个 text 节点都建议显式声明，缺省用内置默认栈" })),
  letterSpacing: Type.Optional(Type.Number({ description: "text 字距（px，-10..20）：大标题略负收紧，全大写小标签略正放开" })),
  align: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")])),
  src: Type.Optional(Type.String({ description: "image：http(s)/data URL" })),
  layout: Type.Optional(Type.Object({}, { additionalProperties: true, description: "frame auto-layout: {direction:'row'|'column', gap?, padding?, justify?, align?}；声明后子节点按 flex 排布（x/y 忽略）" })),
  children: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "仅 frame：子节点（坐标相对父节点）" }))
}, { additionalProperties: true });

/** design_update 的单条 op（宽松 schema；语义详见工具 description）。 */
const designOpSchema = Type.Object({
  op: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("move"), Type.Literal("resize"), Type.Literal("replace")], { description: "create 新建 / update 改属性 / delete 删除 / move 换父排序 / resize 调画布尺寸 / replace 整树替换" }),
  id: Type.Optional(Type.String({ description: "update/delete/move：目标节点 id" })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "create/move：目标父节点 id（必须是 frame）；null/缺省=文档根" })),
  index: Type.Optional(Type.Integer({ description: "create/move：在父 children 中的插入位置，缺省追加尾部" })),
  dx: Type.Optional(Type.Number({ description: "move：整树水平平移 px（多画板重排一 op 搞定）" })),
  dy: Type.Optional(Type.Number({ description: "move：整树垂直平移 px" })),
  width: Type.Optional(Type.Integer({ description: "resize：画布宽 px" })),
  height: Type.Optional(Type.Integer({ description: "resize：画布高 px" })),
  background: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "resize：画布背景色（null 清除）" })),
  node: Type.Optional(designNodeSchema),
  patch: Type.Optional(Type.Object({}, { additionalProperties: true, description: "update：字段→新值映射（不允许改 id/type/children；未知字段会整批拒绝）" })),
  nodes: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "replace：整棵新节点树" }))
}, { additionalProperties: true });

function formatDocSummary(doc: DesignDoc): string {
  return `「${doc.name}」 画布 ${doc.canvas.width}×${doc.canvas.height}，${countNodes(doc.nodes)} 个节点，revision ${doc.revision}`;
}

/** Build the design_* customTools (one set per session record). */
export function buildDesignTools(deps: DesignToolDeps): ToolDefinition[] {
  // 教学只在首个 create/update 成功回执出现一次（restore 后的会话重建会再提示一次，可接受）。
  let guidanceShown = false;
  const guidanceOnce = () => {
    if (guidanceShown) return "";
    guidanceShown = true;
    return `\n${FIRST_USE_GUIDANCE}`;
  };
  return [
    defineTool({
      name: "design_list",
      label: "列出设计文档",
      description: "列出当前工作区 designs/ 目录下的设计文档（名称/尺寸/节点数）。打开某个文档用 design_open，新建用 design_create。",
      promptSnippet: "design_list: 列出工作区设计文档",
      parameters: Type.Object({}),
      execute: async () => {
        checkEnabled(deps);
        const workspace = requireWorkspace(deps);
        const summaries = listDesigns(workspace);
        const current = deps.getDoc();
        const lines = summaries.map((summary) => `- ${summary.name}（${summary.width}×${summary.height}，${summary.nodeCount} 节点）`);
        const currentLine = current ? `当前会话已打开：${formatDocSummary(current)}` : "当前会话未打开文档（design_update 前需先 design_open 或 design_create）。";
        // 一个文档 = 一块画布：发现多文档时补一条防拆分提示（跨文档合并没有工具路径，只能重建）。
        const multiDocHint = summaries.length > 1
          ? "\n提示：一个文档 = 一块画布；整套原型请放进同一个文档（一屏 = 一个顶层命名 frame 并排，画布放不下先 resize）。已拆成多文档的，建议逐屏重建合并，或分别导出 HTML 交付。"
          : "";
        return { content: [{ type: "text" as const, text: summaries.length > 0 ? `工作区设计文档：\n${lines.join("\n")}\n${currentLine}${multiDocHint}` : `工作区还没有设计文档。${currentLine}` }], details: { count: summaries.length } };
      }
    }),
    defineTool({
      name: "design_create",
      label: "新建设计文档",
      description: "新建设计文档并绑定为当前文档（同名已存在则直接打开），随后用 design_update 添加节点搭建页面。",
      promptSnippet: "design_create: 新建并绑定设计文档",
      parameters: Type.Object({
        name: Type.String({ description: "文档名（同时是文件名，如「登录页」）" }),
        width: Type.Optional(Type.Integer({ description: "画布宽 px，缺省 1440" })),
        height: Type.Optional(Type.Integer({ description: "画布高 px，缺省 1024" }))
      }),
      execute: async (_id, params) => {
        checkEnabled(deps);
        const workspace = requireWorkspace(deps);
        const name = sanitizeDesignName(params?.name);
        if (!name) throw new Error("请提供有效的文档名");
        const filePath = designFilePath(workspace, name);
        const existing = readDesign(filePath);
        if (existing) {
          const fileName = `${name}${DESIGN_FILE_SUFFIX}`;
          deps.bindDoc(existing, fileName);
          return { content: [{ type: "text" as const, text: `文档已存在，已直接打开 ${formatDocSummary(existing)}（id ${existing.id}）。${CANVAS_HINT}` }], details: { docId: existing.id, name: existing.name, existed: true } };
        }
        const width = typeof params?.width === "number" ? params.width : 1440;
        const height = typeof params?.height === "number" ? params.height : 1024;
        const doc = createDesignDoc(name, width, height);
        const fileName = deps.persistDoc(doc, undefined);
        deps.bindDoc(doc, fileName);
        return { content: [{ type: "text" as const, text: `已创建并打开「${name}」（${doc.canvas.width}×${doc.canvas.height}，id ${doc.id}）。下一步：用 design_update 搭建第一个屏幕。${guidanceOnce()}${CANVAS_HINT}` }], details: { docId: doc.id, name, existed: false } };
      }
    }),
    defineTool({
      name: "design_open",
      label: "打开设计文档",
      description: "打开工作区的设计文档并绑定为当前文档，返回整棵节点树 JSON。name 与 docId 至少提供一个。",
      promptSnippet: "design_open: 打开设计文档并返回整树",
      parameters: Type.Object({
        name: Type.Optional(Type.String({ description: "文档名（design_list 列出的名称）" })),
        docId: Type.Optional(Type.String({ description: "文档 id（二选一）" }))
      }),
      execute: async (_id, params) => {
        checkEnabled(deps);
        const workspace = requireWorkspace(deps);
        const name = typeof params?.name === "string" ? params.name.trim() : "";
        const docId = typeof params?.docId === "string" ? params.docId.trim() : "";
        if (!name && !docId) throw new Error("请提供 name 或 docId");
        let doc = name ? readDesign(designFilePath(workspace, name)) : undefined;
        if (!doc && docId) {
          doc = listDesigns(workspace)
            .map((summary) => readDesign(designFilePath(workspace, summary.name)))
            .find((candidate) => candidate?.id === docId);
        }
        if (!doc) throw new Error(`找不到设计文档（${name || docId}）。用 design_list 查看可用文档。`);
        const fileName = `${sanitizeDesignName(doc.name)}${DESIGN_FILE_SUFFIX}`;
        deps.bindDoc(doc, fileName);
        return { content: [{ type: "text" as const, text: `已打开 ${formatDocSummary(doc)}。\n布局摘要：\n${summarizeDesignLayout(doc)}\n${docJson(doc)}` }], details: { docId: doc.id, nodes: countNodes(doc.nodes) } };
      }
    }),
    defineTool({
      name: "design_read",
      label: "读取设计文档",
      description: "读取当前绑定文档的最新整树（或指定子树）JSON。长对话后写操作前建议先读一次刷新记忆；传 nodeId 只读该子树。",
      promptSnippet: "design_read: 读取当前文档（子）树",
      parameters: Type.Object({
        nodeId: Type.Optional(Type.String({ description: "缺省读整树；提供则只读该节点子树" }))
      }),
      execute: async (_id, params) => {
        checkEnabled(deps);
        const doc = requireDoc(deps);
        const nodeId = typeof params?.nodeId === "string" ? params.nodeId.trim() : "";
        const found = nodeId ? findNode(doc.nodes, nodeId) : undefined;
        if (nodeId && !found) throw new Error(`节点不存在：${nodeId}`);
        const text = found ? docJson(doc, found.node) : `${formatDocSummary(doc)}\n布局摘要：\n${summarizeDesignLayout(doc)}\n${docJson(doc)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { docId: doc.id, ...(found ? { nodeId: found.node.id } : {}), nodes: countNodes(found ? [found.node] : doc.nodes), revision: doc.revision }
        };
      }
    }),
    defineTool({
      name: "design_update",
      label: "更新设计文档",
      description: "对当前设计文档批量应用结构化操作：原子（任一 op 失败整批拒绝、文档不变），坐标相对父节点，frame 声明 layout 后子节点按 flex 排布（x/y 忽略）。op 与节点字段语义见参数 schema；回执带质量检查与可直接套用的修复 ops。",
      promptSnippet: "design_update: 批量应用设计 ops",
      parameters: Type.Object({
        ops: Type.Array(designOpSchema, { description: "按顺序应用的批量操作" })
      }),
      execute: async (_id, params) => {
        checkEnabled(deps);
        // 顶层参数设防：幻觉参数（如 edits:[]）直接报错而不是静默忽略。
        const unknownArgs = Object.keys(params ?? {}).filter((key) => key !== "ops");
        if (unknownArgs.length > 0) throw new Error(`design_update 不支持参数：${unknownArgs.join("、")}（只接受 ops 数组）`);
        const workspace = requireWorkspace(deps);
        const doc = requireDoc(deps);
        const rawOps = Array.isArray(params?.ops) ? params.ops as unknown[] : [];
        if (rawOps.length === 0) throw new Error("ops 不能为空");
        if (rawOps.length > MAX_OPS_PER_UPDATE) throw new Error(`一次 design_update 最多 ${MAX_OPS_PER_UPDATE} 条 ops（当前 ${rawOps.length}）。分批提交：先完成第一个屏幕/一个区域，成功后继续下一批。`);
        // create 无 id 时预生成并记录映射，回执告知模型（后续 op 可直接引用）。
        const idMap: { name: string; id: string }[] = [];
        const ops: DesignOp[] = rawOps.map((raw) => {
          const op = raw as Record<string, unknown>;
          if (op.op !== "create" || !op.node || typeof op.node !== "object") return raw as DesignOp;
          const node = op.node as Record<string, unknown>;
          if (typeof node.id === "string" && node.id.trim()) return raw as DesignOp;
          const assigned = makeNodeId();
          const label = typeof node.name === "string" && node.name.trim() ? node.name.trim() : (typeof node.type === "string" ? node.type : "node");
          idMap.push({ name: label, id: assigned });
          return { ...(raw as DesignOp), node: { ...node, id: assigned } } as DesignOp;
        });
        const applied = applyDesignOps(doc, ops);
        if (!applied.ok) throw new Error(`${applied.error}（整批未应用；可 design_read 后修正重试）`);
        const next: DesignDoc = { ...applied.doc, revision: applied.doc.revision + 1 };
        const fileName = deps.persistDoc(next, deps.getDocFileName());
        // 质量门：结构/对比度/出界的确定性检查；修复建议产成可直接套用的 DesignOp[]。
        const quality = inspectDesignQuality(next);
        const mapText = idMap.length > 0 ? `\n新建节点 id：${idMap.map((entry) => `${entry.name}→${entry.id}`).join("、")}` : "";
        const qualityText = quality.diagnostics.length > 0
          ? `\n质量检查 ${quality.diagnostics.length} 项${quality.omitted > 0 ? `（另 ${quality.omitted} 项省略）` : ""}：\n${quality.diagnostics.slice(0, 8).map((line) => `- ${line}`).join("\n")}`
          : "";
        const repairText = quality.repairTargets.length > 0
          ? `\n修复 ops（下一条 design_update 的 ops 参数原样传入）：${JSON.stringify(quality.repairTargets.slice(0, 24))}${quality.repairTargets.length > 24 ? `（共 ${quality.repairTargets.length} 条，先套用这 24 条，剩余数量已按同一标尺吸附，可自行改完）` : ""}`
          : "";
        const nextText = quality.repairTargets.length > 0 ? "先套用上述修复 ops，再继续新内容" : "继续搭建其余屏幕/区域";
        return {
          content: [{ type: "text" as const, text: `已应用 ${ops.length} 项操作到「${next.name}」（revision ${next.revision}）。${mapText}${qualityText}${repairText}\n下一步：${nextText}，无需向用户转述本回执。${guidanceOnce()}${CANVAS_HINT}` }],
          details: { applied: ops.length, revision: next.revision, fileName, ...(idMap.length > 0 ? { newIds: idMap } : {}), ...(quality.diagnostics.length > 0 ? { quality: { diagnostics: quality.diagnostics, repairCount: quality.repairTargets.length, suggestCanvas: quality.suggestCanvas } } : {}) }
        };
      }
    }),
    defineTool({
      name: "design_export",
      label: "导出设计 HTML",
      description: "把当前设计文档导出为内联样式 HTML 单文件。path 缺省写 designs/exports/<文档名>.html。回执自动附渲染缩略图：多模态模型直接查看，文本模型把回执里的路径交给 recognize_images——无需再走浏览器截图验证。",
      promptSnippet: "design_export: 导出 HTML 单文件",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "工作区相对路径（缺省 designs/exports/<名称>.html）" }))
      })
      ,
      execute: async (_id, params) => {
        checkEnabled(deps);
        const workspace = requireWorkspace(deps);
        const doc = requireDoc(deps);
        const customPath = typeof params?.path === "string" ? params.path.trim() : "";
        const html = exportDesignHtml(doc);
        const relativePath = customPath ? writeExportFile(workspace, html, customPath) : exportDesignFile(workspace, doc, html);
        const details: Record<string, unknown> = { relativePath, revision: doc.revision };
        const textLines = [`已导出「${doc.name}」到 ${relativePath}。`];
        let imagePart: { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" } | undefined;
        // 缩略图：离屏渲染导出产物并截图，随回执回传——省掉 export→navigate→wait→
        // screenshot→recognize 的五步视觉验证回路（真实会话里这条回路占了 1/3 调用量）。
        if (deps.renderSnapshot) {
          const bounds = exportBounds(doc);
          const outcome = await deps.renderSnapshot({
            htmlPath: resolve(workspace, relativePath),
            contentWidth: bounds.width,
            contentHeight: bounds.height,
            workspace
          });
          if (outcome.ok) {
            textLines.push(`缩略图（${outcome.width}×${outcome.height}）已生成并附在本回执：${outcome.savedPath}。多模态模型直接查看图像做视觉复核；文本模型可把该工作区相对路径交给 recognize_images。无需再用 browser_navigate + browser_screenshot 验证本次导出。`);
            details.thumbnail = { relativePath: outcome.savedPath, width: outcome.width, height: outcome.height };
            imagePart = { type: "image", data: outcome.data, mimeType: outcome.mimeType };
          } else {
            textLines.push(`缩略图生成失败（${outcome.error}）；如需视觉验证可用 browser_navigate 打开该文件后截图。`);
          }
        }
        textLines.push(CANVAS_HINT);
        return {
          content: [
            { type: "text" as const, text: textLines.join("\n") },
            ...(imagePart ? [imagePart] : [])
          ],
          details
        };
      }
    })
  ];
}
