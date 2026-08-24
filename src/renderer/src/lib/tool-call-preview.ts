/**
 * 工具调用参数的可读化预览（纯函数，无 React）。
 *
 * 目标：气泡里的工具调用节点不再整段展示 `\n` 转义的原始 JSON——
 * - `edit`（编辑文件）：把 edits[].oldText → newText 计算成行级 diff 展示，
 *   有工具返回的统一 patch（execution.patch）时优先用 patch（带文件头/@@ 行号/上下文）；
 * - `write`（写入文件）：展示解码后的人类可读内容；
 * - 调用指令区改为紧凑摘要（path + 块数/字符数），不再淹没原始 JSON。
 */

export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface EditPreviewPair {
  oldText: string;
  newText: string;
}

export interface EditCallPreview {
  path?: string;
  edits: EditPreviewPair[];
}

export interface WriteCallPreview {
  path?: string;
  content: string;
}

export interface ReadCallPreview {
  path?: string;
}

/** 文件扩展名 → highlight.js 语言 id（未登记的扩展名由 CodeBlock 自动识别兜底）。 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", xhtml: "xml",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", pyw: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", rb: "ruby", php: "php", lua: "lua", pl: "perl", r: "r",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "dos", cmd: "dos",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", conf: "ini", cfg: "ini", properties: "properties",
  sql: "sql", graphql: "graphql", gql: "graphql", diff: "diff", patch: "diff",
  gradle: "gradle", dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake"
};

/** 文件名（不含路径）→ 语言 id，处理 Dockerfile/Makefile 这类无扩展名文件。 */
const SPECIAL_FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  cmakelists: "cmake",
  "cmakelists.txt": "cmake"
};

/** 从文件路径推断高亮语言；未知返回 undefined（渲染端走自动识别）。 */
export function languageFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (!name) return undefined;
  const special = SPECIAL_FILENAME_LANGUAGES[name];
  if (special) return special;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined; // 点号在首位（.gitignore 等 dotfile）或无扩展名
  return EXTENSION_LANGUAGES[name.slice(dot + 1)];
}

/** 解析 `read` 工具参数：`{ path, offset?, limit? }`，只需要 path 用于语言推断。 */
export function parseReadCallArgs(args: unknown): ReadCallPreview | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  return typeof record.path === "string" ? { path: record.path } : undefined;
}

export interface EditDiffBlock {
  oldText: string;
  newText: string;
  /** undefined = 变更区域过大，无法安全计算（上层回退到原始指令）。 */
  lines: DiffLine[] | undefined;
}

/** 行级 diff 的安全上限（两段文本合计行数）；超过则放弃计算。 */
const MAX_DIFF_LINES = 1500;

/**
 * 解析 `edit` 工具参数：现代形态 `{ path, edits: [{oldText, newText}] }`
 * 与旧形态 `{ path, oldText, newText }` 都支持；形状不符返回 undefined。
 */
export function parseEditCallArgs(args: unknown): EditCallPreview | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  if (Array.isArray(record.edits)) {
    const edits: EditPreviewPair[] = [];
    for (const item of record.edits) {
      if (!item || typeof item !== "object") continue;
      const { oldText, newText } = item as Record<string, unknown>;
      if (typeof oldText !== "string" || typeof newText !== "string") continue;
      edits.push({ oldText, newText });
    }
    return edits.length > 0 ? { path, edits } : undefined;
  }
  if (typeof record.oldText === "string" && typeof record.newText === "string") {
    return { path, edits: [{ oldText: record.oldText, newText: record.newText }] };
  }
  return undefined;
}

/** 解析 `write` 工具参数：`{ path, content }`（兼容旧字段 file_path）。 */
export function parseWriteCallArgs(args: unknown): WriteCallPreview | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string"
    ? record.path
    : typeof record.file_path === "string"
      ? record.file_path
      : undefined;
  if (typeof record.content !== "string") return undefined;
  return { path, content: record.content };
}

/**
 * 行级 Myers diff（O(ND)，经典算法）。返回按原顺序排列的行编辑序列：
 * remove（删除的旧行）在前、add（新增的新行）在后、context 为上下文行。
 * 区域过大返回 undefined（调用方回退），不会抛错。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] | undefined {
  // 空串视为零行（纯插入/纯删除）；非空串按行切分（保留末尾换行产生的空行）。
  const a = oldText === "" ? [] : oldText.split(/\r?\n/u);
  const b = newText === "" ? [] : newText.split(/\r?\n/u);
  if (a.length + b.length > MAX_DIFF_LINES) return undefined;
  if (a.length === 0) return b.map((text) => ({ type: "add", text }));
  if (b.length === 0) return a.map((text) => ({ type: "remove", text }));

  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= max && foundD < 0; d++) {
    // trace[d] = 第 d 轮开头的 V（即 V_{d-1}），回溯时按步反向读取。
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1]! < v[idx + 1]!)) {
        x = v[idx + 1]!;
      } else {
        x = v[idx - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
  }
  if (foundD < 0) return undefined; // 防御：理论上不可达（d ≤ n + m 必收敛）

  const result: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      result.push({ type: "context", text: a[x - 1]! });
      x--;
      y--;
    }
    if (x === prevX) {
      result.push({ type: "add", text: b[y - 1]! });
      y--;
    } else {
      result.push({ type: "remove", text: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    result.push({ type: "context", text: a[x - 1]! });
    x--;
    y--;
  }
  while (x > 0) {
    result.push({ type: "remove", text: a[x - 1]! });
    x--;
  }
  while (y > 0) {
    result.push({ type: "add", text: b[y - 1]! });
    y--;
  }
  return result.reverse();
}

/** 为每个编辑块计算行级 diff（区域过大时 lines 为 undefined）。 */
export function buildEditDiffs(edits: readonly EditPreviewPair[]): EditDiffBlock[] {
  return edits.map(({ oldText, newText }) => ({ oldText, newText, lines: diffLines(oldText, newText) }));
}

/** `edit` 调用指令的紧凑摘要（取代原始 JSON）。 */
export function editArgsSummary(preview: EditCallPreview): string {
  const lines: string[] = [];
  if (preview.path) lines.push(`path: ${preview.path}`);
  lines.push(`edits: ${preview.edits.length} 处`);
  return lines.join("\n");
}

/** `write` 调用指令的紧凑摘要（取代原始 JSON）。 */
export function writeArgsSummary(preview: WriteCallPreview): string {
  const lines: string[] = [];
  if (preview.path) lines.push(`path: ${preview.path}`);
  lines.push(`content: ${preview.content.length} 字符`);
  return lines.join("\n");
}
