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
import { applyDesignOps, countNodes, createDesignDoc, findNode, makeNodeId, sanitizeDesignName, type DesignDoc, type DesignNode, type DesignOp } from "../shared/design-schema.js";
import { exportDesignHtml } from "../shared/design-export.js";
import { designFilePath, exportDesignFile, listDesigns, readDesign, writeExportFile, DESIGN_FILE_SUFFIX } from "./design-store.js";

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
}

const DISABLED_TEXT = "设计模式已在设置中停用（settings.design.enabled），请在设置中开启后再试。";

const CANVAS_HINT = "提示：可在界面顶部「设计」按钮打开设计画布查看与手动微调。";

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
  text: Type.Optional(Type.String({ description: "text 节点内容" })),
  fontSize: Type.Optional(Type.Number()), fontWeight: Type.Optional(Type.Number()), color: Type.Optional(Type.String({ description: "text 颜色" })),
  align: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")])),
  src: Type.Optional(Type.String({ description: "image：http(s)/data URL" })),
  layout: Type.Optional(Type.Object({}, { additionalProperties: true, description: "frame auto-layout: {direction:'row'|'column', gap?, padding?, justify?, align?}；声明后子节点按 flex 排布（x/y 忽略）" })),
  children: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "仅 frame：子节点（坐标相对父节点）" }))
}, { additionalProperties: true });

/** design_update 的单条 op（宽松 schema；语义详见工具 description）。 */
const designOpSchema = Type.Object({
  op: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("move"), Type.Literal("replace")], { description: "create 新建 / update 改属性 / delete 删除 / move 换父排序 / replace 整树替换" }),
  id: Type.Optional(Type.String({ description: "update/delete/move：目标节点 id" })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "create/move：目标父节点 id（必须是 frame）；null/缺省=文档根" })),
  index: Type.Optional(Type.Integer({ description: "create/move：在父 children 中的插入位置，缺省追加尾部" })),
  node: Type.Optional(designNodeSchema),
  patch: Type.Optional(Type.Object({}, { additionalProperties: true, description: "update：字段→新值映射（不允许改 id/type/children）" })),
  nodes: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { description: "replace：整棵新节点树" }))
}, { additionalProperties: true });

function formatDocSummary(doc: DesignDoc): string {
  return `「${doc.name}」 画布 ${doc.canvas.width}×${doc.canvas.height}，${countNodes(doc.nodes)} 个节点，revision ${doc.revision}`;
}

/** Build the design_* customTools (one set per session record). */
export function buildDesignTools(deps: DesignToolDeps): ToolDefinition[] {
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
        return { content: [{ type: "text" as const, text: summaries.length > 0 ? `工作区设计文档：\n${lines.join("\n")}\n${currentLine}` : `工作区还没有设计文档。${currentLine}` }], details: { count: summaries.length } };
      }
    }),
    defineTool({
      name: "design_create",
      label: "新建设计文档",
      description: "新建设计文档并绑定为当前文档（同名文档已存在时直接打开它）。随后用 design_update 的 create op 添加节点搭建页面；每个节点都起 name。",
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
        return { content: [{ type: "text" as const, text: `已创建并打开「${name}」（${doc.canvas.width}×${doc.canvas.height}，id ${doc.id}）。用 design_update 添加节点开始搭建。${CANVAS_HINT}` }], details: { docId: doc.id, name, existed: false } };
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
        return { content: [{ type: "text" as const, text: `已打开 ${formatDocSummary(doc)}。\n${docJson(doc)}` }], details: { docId: doc.id, nodes: countNodes(doc.nodes) } };
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
        const text = found ? docJson(doc, found.node) : `${formatDocSummary(doc)}\n${docJson(doc)}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { docId: doc.id, ...(found ? { nodeId: found.node.id } : {}), nodes: countNodes(found ? [found.node] : doc.nodes), revision: doc.revision }
        };
      }
    }),
    defineTool({
      name: "design_update",
      label: "更新设计文档",
      description: [
        "对当前设计文档批量应用结构化操作（原子：任一失败整批拒绝，文档不变）。坐标系相对父节点；frame 声明 layout 后子节点按 flex 排布。",
        "ops 形态：{op:'create', parentId?, index?, node} 新建（parentId 缺省=根）；{op:'update', id, patch} 改属性（patch 不允许改 id/type/children）；{op:'delete', id} 删除子树；{op:'move', id, parentId?, index?} 换父/排序（不能移入自身子树）；{op:'replace', nodes} 整树替换（慎用）。",
        "节点字段：type(frame/rect/text/image)、name（每个节点都起）、x/y/w/h、fill/stroke/strokeWidth/radius/opacity/shadow、text 节点加 text/fontSize/fontWeight/color/align、image 加 src(http/data)、frame 加 layout({direction:'row'|'column',gap,padding,justify,align}) 与 children。",
        "建议：一次调用完成一组相关修改（多个 ops），先 read 后改；自起 id 便于后续定位，缺省自动生成并在回执给出映射。"
      ].join("\n"),
      promptSnippet: "design_update: 批量应用设计 ops",
      parameters: Type.Object({
        ops: Type.Array(designOpSchema, { description: "按顺序应用的批量操作" })
      }),
      execute: async (_id, params) => {
        checkEnabled(deps);
        const workspace = requireWorkspace(deps);
        const doc = requireDoc(deps);
        const rawOps = Array.isArray(params?.ops) ? params.ops as unknown[] : [];
        if (rawOps.length === 0) throw new Error("ops 不能为空");
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
        const mapText = idMap.length > 0 ? `\n新建节点 id：${idMap.map((entry) => `${entry.name}→${entry.id}`).join("、")}` : "";
        return {
          content: [{ type: "text" as const, text: `已应用 ${ops.length} 项操作到「${next.name}」（revision ${next.revision}）。${mapText}\n${CANVAS_HINT}` }],
          details: { applied: ops.length, revision: next.revision, fileName, ...(idMap.length > 0 ? { newIds: idMap } : {}) }
        };
      }
    }),
    defineTool({
      name: "design_export",
      label: "导出设计 HTML",
      description: "把当前设计文档导出为内联样式的 HTML 单文件（HTML+CSS，可直接在浏览器打开）。path 缺省写到 designs/exports/<文档名>.html。",
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
        return {
          content: [{ type: "text" as const, text: `已导出「${doc.name}」到 ${relativePath}。可用 browser_navigate 打开该文件预览效果。${CANVAS_HINT}` }],
          details: { relativePath, revision: doc.revision }
        };
      }
    })
  ];
}
