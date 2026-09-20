// 作品（Gallery）自定义工具（自建能力，utility 进程内，暴露给 Pi 会话）。
//
// 「发布」是用户/模型把「已经做完、能跑、值得留下」的成果登记到作品墙的动作。
// 登记之后作品就有了常驻入口：顶栏下拉与空态作品墙里能一键运行、一键继续开发
// （否则成果就是一堆做完即沉底的文件）。
//
// 只有一个工具（永远激活，≈200 tokens/请求的前缀成本可接受）：工具描述是按请求
// 付前缀的地方，所以规范写全、数量压到最少。持久化/缩略图/推送都在 pi-runtime
// 侧的回调里（本模块只做参数校验与回执文案，便于独立单测）。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GalleryApp, GalleryDraft, GalleryKind } from "../shared/protocol.js";
import { GALLERY_KIND_LABELS } from "../shared/gallery.js";

export interface GalleryToolContext {
  /**
   * 发布/更新一个作品（同「工作区 + 类型 + 入口」重复发布 = 更新）。
   * 校验入口是否在工作区内由实现侧负责（这里只知道工作区根）。
   */
  publish: (draft: GalleryDraft) => Promise<{ app: GalleryApp; thumbNote: string }>;
  /** 当前作品清单（回执里给数量，让模型知道池子里有什么）。 */
  list: () => GalleryApp[];
}

const KINDS: readonly GalleryKind[] = ["file", "server"];

/**
 * 参数校验（纯函数，可单测）。
 *
 * 字段名 `path` 是有意的：权限层的越界检查（`pathLeavesWorkspace`）只读
 * `args.path` / `file_path` / `filePath`，换个名字就等于放弃「工作区外」这道门。
 */
export function validatePublishInput(raw: unknown): GalleryDraft {
  const input = (raw ?? {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path) throw new Error("path 不能为空（要发布的入口文件或项目目录）");
  const kind = (typeof input.kind === "string" ? input.kind.trim() : "") as GalleryKind;
  if (!KINDS.includes(kind)) throw new Error(`kind 必须是 file 或 server（收到 ${JSON.stringify(input.kind)}）`);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title 不能为空（作品墙上展示的名字）");
  const entry = typeof input.entry === "string" && input.entry.trim() ? input.entry.trim() : undefined;
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : undefined;
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim() : undefined;
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean) : undefined;
  const draft: GalleryDraft = { title, kind, path };
  if (entry) draft.entry = entry;
  if (command) draft.command = command;
  if (url) draft.url = url;
  if (description) draft.description = description;
  if (tags && tags.length > 0) draft.tags = tags;
  return draft;
}

/** 回执文案（简短，附下一步提示——anti-narration 纪律）。 */
export function publishReceipt(app: GalleryApp, total: number, thumbNote: string): string {
  const lines = [
    `已发布作品「${app.title}」（${GALLERY_KIND_LABELS[app.kind]}）：${app.entry === "." ? "工作区根目录" : app.entry}。`,
    `作品池现有 ${total} 个，可在顶栏「作品」下拉或空会话的作品墙里运行/继续开发。`
  ];
  if (thumbNote) lines.push(thumbNote);
  return lines.join("\n");
}

/** Build the gallery customTools（gallery_publish）. */
export function buildGalleryTools(ctx: GalleryToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "gallery_publish",
      label: "发布作品",
      description: [
        "把一个**已经做完、能运行、值得保留**的成果登记到作品墙（用户能一键运行、一键继续开发）。",
        "kind=file 时 path 指入口文件（如导出的单文件 html）；kind=server 时 path 指项目目录，并给出启动命令 command 或服务地址 url。",
        "入口必须位于当前工作区内。同「工作区+类型+入口」重复发布是更新而非新增（改了标题/命令再发一次即可）。",
        "只在成果确实完成时调用——临时脚本、中间产物不要发布，否则作品墙会被噪声塞满。"
      ].join(""),
      promptSnippet: "gallery_publish: 把完成的成果发布到作品墙",
      parameters: Type.Object({
        title: Type.String({ description: "作品名（作品墙展示名）" }),
        kind: Type.String({ description: "file = 入口文件（单文件网页）；server = 目录 + 启动命令/地址" }),
        path: Type.String({ description: "入口文件或项目目录的工作区相对路径" }),
        entry: Type.Optional(Type.String({ description: "入口（缺省 = path）；kind=file 时可指向目录内的某个页面" })),
        command: Type.Optional(Type.String({ description: "kind=server：启动命令（如 npm run dev）；用户会在终端里执行" })),
        url: Type.Optional(Type.String({ description: "kind=server：服务地址（如 http://localhost:5173）；有它就能直接打开" })),
        description: Type.Optional(Type.String({ description: "一句话说明这个作品是什么" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "可选标签" }))
      }),
      execute: async (_id, params) => {
        const draft = validatePublishInput(params);
        const { app, thumbNote } = await ctx.publish(draft);
        return {
          content: [{ type: "text" as const, text: publishReceipt(app, ctx.list().length, thumbNote) }],
          details: { id: app.id, title: app.title, kind: app.kind, entry: app.entry }
        };
      }
    })
  ];
}
