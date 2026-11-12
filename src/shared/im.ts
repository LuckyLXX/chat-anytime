import type { AccessMode, ImChannelConfig, ImChannelKind, ImCustomHost, ImSettings } from "./protocol.js";

/**
 * IM 通道的共享纯逻辑（2026-11-12，飞书长连接 P1）。
 *
 * 这一层不碰 Node/Electron、不做 I/O：主进程（网关/设置落盘）与渲染端（设置页
 * 草稿校验、白名单解析）必须用同一套口径，否则「面板能存、主进程不认」这类
 * 漂移会变成线上静默失效。协议层的形状在 protocol.ts，这里只放判定与格式化。
 */

/** 通道类型（共享判定：主进程、渲染端、脚本文档都以这两个取值为准）。新增平台在这一层加，不另起一套。 */
export const IM_CHANNEL_KINDS = ["feishu", "custom"] as const;

/** 自定义通道的监听地址候选：只本机是安全默认，0.0.0.0 需要用户显式选择。 */
export const IM_CUSTOM_HOSTS = ["127.0.0.1", "0.0.0.0"] as const;
export const IM_CUSTOM_DEFAULT_HOST = "127.0.0.1";
/** 端口 0 = 随机（状态里回报实际端口）；设置页缺省给一个固定端口方便脚本写死。 */
export const IM_CUSTOM_DEFAULT_PORT = 0;
export const IM_CUSTOM_MAX_PORT = 65_535;

/** 缺省开放平台域名（Lark 国际版用 open.larksuite.com，可在通道配置里覆盖）。 */
export const IM_DEFAULT_DOMAIN = "open.feishu.cn";

/** IM 会话审批超时缺省 10 分钟：手机没看到也能结束，不至于把工具永久挂住。 */
export const IM_DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/** 审批超时的合法区间（30 秒 ~ 1 小时）：低于 30 秒用户来不及看，高于 1 小时等于挂死。 */
export const IM_MIN_APPROVAL_TIMEOUT_MS = 30_000;
export const IM_MAX_APPROVAL_TIMEOUT_MS = 3_600_000;

/** 单条飞书卡片正文上限 30KB（官方文档），答案超长时按 markdown 边界切片。 */
export const IM_MAX_CARD_BYTES = 30 * 1024;

/** 一条答案最多写多少字符就切片（留出卡片 JSON 包装的余量）。 */
export const IM_MAX_ANSWER_CHARS = 20_000;

/** `seen` 去重表每个通道保留的 message_id 条数（LRU）。 */
export const IM_SEEN_LIMIT = 500;

/** 审批码长度：8 位大写、去掉易混字符（0/O/1/I）。 */
export const IM_APPROVAL_CODE_LENGTH = 8;
export const IM_APPROVAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 白名单条目净化：去空白、去重、截断超长；空列表 = 不服务任何消息（拒绝优先）。 */
export function normalizeImAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = trimmed(item);
    if (!id || id.length > 120) continue;
    seen.add(id);
    if (seen.size >= 200) break;
  }
  return [...seen];
}

/**
 * 单条通道配置净化。字段级回落而不是整条丢弃：用户在设置页改了一项不该把
 * 其它项清零（与 normalizeJev 同款纪律）。只有 id 不合法或 kind 不认识时才
 * 返回 undefined——那两条是「这条配置根本指不到任何通道」。
 */
export function normalizeImChannel(value: unknown): ImChannelConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = trimmed(raw.id);
  if (!id || !CHANNEL_ID_RE.test(id)) return undefined;
  const kind: ImChannelKind | undefined = raw.kind === "feishu" || raw.kind === "custom" ? raw.kind : undefined;
  if (!kind) return undefined;

  const allowFrom = normalizeImAllowFrom(raw.allowFrom);
  const accessMode: AccessMode = raw.accessMode === "read-only" || raw.accessMode === "workspace" || raw.accessMode === "full" || raw.accessMode === "ask"
    ? raw.accessMode
    : "workspace";
  const timeoutRaw = typeof raw.approvalTimeoutMs === "number" && Number.isFinite(raw.approvalTimeoutMs)
    ? Math.round(raw.approvalTimeoutMs)
    : typeof raw.approvalTimeoutMs === "string" && raw.approvalTimeoutMs.trim()
      ? Math.round(Number(raw.approvalTimeoutMs))
      : Number.NaN;
  const approvalTimeoutMs = Number.isFinite(timeoutRaw)
    ? Math.min(IM_MAX_APPROVAL_TIMEOUT_MS, Math.max(IM_MIN_APPROVAL_TIMEOUT_MS, timeoutRaw))
    : undefined;
  // 两种 kind 共用的字段：字段级回落而不是整条丢弃。
  const shared = {
    enabled: raw.enabled === true,
    ...(trimmed(raw.label) ? { label: trimmed(raw.label)!.slice(0, 60) } : {}),
    ...(raw.appSecretConfigured === true ? { appSecretConfigured: true } : {}),
    allowFrom,
    accessMode,
    ...(trimmed(raw.workspace) ? { workspace: trimmed(raw.workspace)! } : {}),
    ...(trimmed(raw.agentId) ? { agentId: trimmed(raw.agentId)! } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    // 回执缺省开启：只有显式 false 才落盘，settings.json 保持干净（自定义通道面板缺省关）。
    ...(raw.ack === false ? { ack: false } : {})
  };

  if (kind === "custom") {
    // 监听地址只接受两个取值：缺省/非法值一律按「只本机」——安全默认不能靠用户选对。
    const host: ImCustomHost = raw.host === "0.0.0.0" ? "0.0.0.0" : IM_CUSTOM_DEFAULT_HOST;
    const portRaw = typeof raw.port === "number" && Number.isFinite(raw.port)
      ? Math.round(raw.port)
      : typeof raw.port === "string" && raw.port.trim()
        ? Math.round(Number(raw.port))
        : Number.NaN;
    const port = Number.isFinite(portRaw) && portRaw >= 0 && portRaw <= IM_CUSTOM_MAX_PORT ? portRaw : IM_CUSTOM_DEFAULT_PORT;
    return {
      id,
      kind,
      appId: "",
      host,
      ...(port !== undefined ? { port } : {}),
      ...shared
    };
  }

  const domainRaw = trimmed(raw.domain);
  // 域名只接受主机名（允许自带 https:// 前缀与尾部斜杠，统一剥掉）。
  const domain = domainRaw
    ? domainRaw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").slice(0, 120)
    : undefined;
  return {
    id,
    kind,
    appId: trimmed(raw.appId)?.slice(0, 120) ?? "",
    ...(domain ? { domain } : {}),
    ...shared
  };
}

/**
 * `settings.im` 的净化入口（主进程 normalizeIm 与渲染端草稿校验共用）。
 * 总闸缺省关闭：未配置的安装不建任何连接（安全默认）。
 */
export function parseImSettings(value: unknown): ImSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const source = Array.isArray(raw.channels) ? raw.channels : [];
  const channels: ImChannelConfig[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const channel = normalizeImChannel(item);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    channels.push(channel);
  }
  // 一条通道都没有、总闸也没开：视为未配置（settings.json 不落空壳）。
  if (channels.length === 0 && raw.enabled !== true) return undefined;
  return { enabled: raw.enabled === true, channels };
}

/** 会话键：`feishu:<channelId>:p2p:<open_id>`。绑定与去重都以它为主键。 */
export function imSessionKey(input: { kind?: ImChannelKind; channelId: string; peerId: string }): string {
  return `${input.kind ?? "feishu"}:${input.channelId}:p2p:${input.peerId}`;
}

/** 反向解析会话键；形状不符返回 undefined（坏绑定不参与路由）。 */
export function parseImSessionKey(key: string): { kind: ImChannelKind; channelId: string; peerId: string } | undefined {
  const parts = key.split(":");
  if (parts.length !== 4 || parts[2] !== "p2p") return undefined;
  const [kind, channelId, , peerId] = parts;
  if (!kind || !(IM_CHANNEL_KINDS as readonly string[]).includes(kind)) return undefined;
  if (!channelId || !peerId) return undefined;
  return { kind: kind as ImChannelKind, channelId, peerId };
}

/** 审批卡正文里的回退指令（卡片按钮点不动时让用户手打这一行）。 */
export function formatImApprovalCode(code: string): string {
  return `/allow ${code}`;
}

export function formatImDenyCode(code: string): string {
  return `/deny ${code}`;
}

/** 生成本轮审批码（crypto 由调用方注入，本模块保持纯净可测）。 */
export function createImApprovalCode(randomByte: () => number): string {
  let code = "";
  for (let index = 0; index < IM_APPROVAL_CODE_LENGTH; index += 1) {
    code += IM_APPROVAL_CODE_ALPHABET[randomByte() % IM_APPROVAL_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * 按 markdown 边界把长答案切片（飞书卡片正文 ≤30KB，且一条消息读起来太长）。
 *
 * 优先级：空行（段落）> 单行 > 硬切；**围栏代码块内部不切**——把 ``` 切成两截
 * 会让后半段整块按纯文本渲染。整段围栏本身超过上限时，退回到「围栏起点之前」
 * 切；连围栏起点都不可用（围栏从第一个字符开始且整块超长）时，在切点处**补一个
 * 收尾围栏、下一片补一个开启围栏**，两片各自都是合法 markdown。
 */
export function splitMarkdown(text: string, max: number): string[] {
  if (!Number.isFinite(max) || max <= 0) return [text];
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const point = findMarkdownSplitPoint(rest, max);
    let head = rest.slice(0, point.index).replace(/\s+$/u, "");
    let tail = rest.slice(point.index).replace(/^\n+/u, "");
    if (point.openFence) {
      // 切点在围栏内部：补收尾围栏 / 重开围栏，避免两片各自一半。
      head = `${head}\n${point.closeFence}`;
      tail = `${point.openFenceMark}\n${tail}`;
    }
    if (head) chunks.push(head);
    rest = tail;
  }
  const last = rest.replace(/\s+$/u, "");
  if (last) chunks.push(last);
  return chunks.length > 0 ? chunks : [text];
}

interface MarkdownSplitPoint {
  /** 切点（切在这一下标之前）。 */
  index: number;
  /** 切点是否落在未闭合的围栏内部（需要补收尾/重开围栏）。 */
  openFence: boolean;
  openFenceMark: string;
  closeFence: string;
}

function findMarkdownSplitPoint(text: string, max: number): MarkdownSplitPoint {
  let offset = 0;
  let inFence = false;
  let fenceStart = -1;
  let fenceMark = "```";
  let lineCandidate = 0;
  let paragraphCandidate = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    const fenceMatch = /^\s*(```|~~~)/u.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        fenceStart = offset;
        fenceMark = line.trim();
      }
      inFence = !inFence;
    }
    const nextOffset = newline === -1 ? text.length : newline + 1;
    if (!inFence) {
      if (nextOffset <= max) {
        lineCandidate = nextOffset;
        if (!line.trim()) paragraphCandidate = nextOffset;
      } else if (line.trim() && offset <= max) {
        // 这一行跨过上限：切在这一行之前（行首是安全边界）。
        lineCandidate = Math.max(lineCandidate, offset);
        break;
      } else {
        break;
      }
    } else if (nextOffset > max) {
      break;
    }
    offset = nextOffset;
  }
  const safe = { openFence: false, openFenceMark: fenceMark, closeFence: "```" };
  if (paragraphCandidate > 0) return { index: paragraphCandidate, ...safe };
  if (lineCandidate > 0) return { index: lineCandidate, ...safe };
  if (inFence && fenceStart > 0) return { index: fenceStart, ...safe };
  // 只能切在围栏内部（或根本没有可用边界）：补围栏收尾/重开。
  return { index: max, openFence: inFence, openFenceMark: fenceMark, closeFence: "```" };
}

/**
 * 再按**字节**上限切一刀：字符数不等于卡片体积（中日韩 3 字节/字、emoji 4 字节），
 * 飞书的 30KB 是字节上限。优先在换行处切，否则按码点边界硬切（不劈开代理对）。
 */
export function splitByBytes(text: string, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes <= 4) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (utf8Length(rest) > maxBytes) {
    let bytes = 0;
    let index = 0;
    let lastNewline = -1;
    while (index < rest.length) {
      const codePoint = rest.codePointAt(index) ?? 0;
      const size = utf8Size(codePoint);
      if (bytes + size > maxBytes) break;
      bytes += size;
      index += codePoint > 0xffff ? 2 : 1;
      if (codePoint === 10) lastNewline = index;
    }
    if (index === 0) break; // 单个码点就超过上限：无法再切
    // 把换行留在上一片末尾更自然；只在它不算太靠前（≥50%）时采用。
    const cut = lastNewline > 0 && lastNewline >= index * 0.5 ? lastNewline : index;
    chunks.push(rest.slice(0, cut).replace(/\s+$/u, ""));
    rest = rest.slice(cut).replace(/^\n+/u, "");
  }
  const lastTail = rest.replace(/\s+$/u, "");
  if (lastTail) chunks.push(lastTail);
  return chunks.filter((chunk) => chunk.length > 0);
}

function utf8Size(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function utf8Length(text: string): number {
  let total = 0;
  for (const char of text) total += utf8Size(char.codePointAt(0) ?? 0);
  return total;
}
