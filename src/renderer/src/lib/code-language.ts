import hljs from "highlight.js/lib/common";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dos from "highlight.js/lib/languages/dos";
import http from "highlight.js/lib/languages/http";
import nginx from "highlight.js/lib/languages/nginx";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";

/**
 * 代码围栏的语言解析（标注 → hljs 语言 id）+ 无标注时的高置信度识别。
 *
 * 为什么需要这一层（2026-10-23 用户报「代码块全是 TEXT，没有语法高亮」）：
 * ① 模型写的围栏大多不带语言标注（本机会话统计：无标注围栏 928 次，带标注约 350 次），
 *    而 CodeBlock 只在拿到**已知**语言时才走 hljs，于是满屏纯文本；
 * ② 模型手写 HTML 气泡时类名还会写成 `class="lang-js"`、`class="js"`、
 *    `<pre class="language-js"><code>` 这些变体，原来的 `language-([\w-]+)` 全部漏掉；
 * ③ 模型真在用的 env / jsonc / dockerfile / http 等语言不在 common 子集里。
 *
 * 猜测（guessCodeLanguage）只做**零误判**的规则：实测 highlightAuto 在真实样本上会把
 * `Test Files 262 passed` 判成 scss、`$ grep …` 判成 perl、英文散文判成 kotlin，
 * 所以这里不做统计式自动识别，只认提示符 / JSON / diff / SQL / XML 这类铁证。
 */

// common 子集只有 36 种语法；这几个是模型实际会写、但 common 里没有的。
// 只加小体积语言（各 ~4KB），不引入全量 192 种。
const EXTRA_LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ["dockerfile", dockerfile],
  ["dos", dos],
  ["http", http],
  ["nginx", nginx],
  ["powershell", powershell],
  ["properties", properties]
];
for (const [name, language] of EXTRA_LANGUAGES) hljs.registerLanguage(name, language);

/** 语言标注别名 → hljs 语言 id（hljs 自己已认的别名不重复列）。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  // shell 家族
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ksh: "bash",
  shellscript: "bash",
  console: "bash",
  shellsession: "bash",
  terminal: "bash",
  cmdline: "bash",
  // Windows
  ps1: "powershell",
  pwsh: "powershell",
  ps: "powershell",
  bat: "dos",
  batch: "dos",
  cmd: "dos",
  // 键值配置
  env: "properties",
  dotenv: "properties",
  props: "properties",
  config: "properties",
  conf: "properties",
  // 容器 / 服务配置
  docker: "dockerfile",
  containerfile: "dockerfile",
  nginxconf: "nginx",
  "nginx.conf": "nginx",
  // 标记语言
  htm: "xml",
  html: "xml",
  xhtml: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  plist: "xml",
  // 其它常见缩写
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  json5: "json",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  nodejs: "javascript",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  kts: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cxx: "cpp",
  hpp: "cpp",
  psql: "sql",
  mysql: "sql",
  postgres: "sql",
  postgresql: "sql"
};

/** 明确表示「这就是纯文本」的标注：尊重作者，不再猜测语言。 */
const PLAIN_TEXT_LABELS = new Set(["text", "plain", "plaintext", "txt", "none", "null", "log", "logs", "output", "stdout", "stderr"]);

/** 猜测的输入上限：超长块不值得为一句正则去扫。 */
const GUESS_MAX_CHARS = 20_000;
const GUESS_CACHE_LIMIT = 100;
const guessCache = new Map<string, string>();

/** hast 属性值（string | string[] | undefined）→ 空格分隔的类名字符串。 */
export function classNameText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => classNameText(item)).join(" ");
  return typeof value === "string" ? value : "";
}

/** 语言标注 → hljs 语言 id；未知语言与纯文本返回空串（调用方按纯文本渲染）。 */
export function resolveCodeLanguage(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || PLAIN_TEXT_LABELS.has(value)) return "";
  const aliased = LANGUAGE_ALIASES[value] ?? value;
  return hljs.getLanguage(aliased) ? aliased : "";
}

/** 是否为「作者明说这是纯文本」的标注（```text / ```plaintext / ```log …）。 */
export function isPlainTextLabel(raw: string | null | undefined): boolean {
  return PLAIN_TEXT_LABELS.has(String(raw ?? "").trim().toLowerCase());
}

/**
 * 从 `<code class="…">` 的类名里取语言标注。
 * 认 `language-js` / `lang-js` / `hljs-js` / `highlight-source-js` / `brush: js`，
 * 也认本身就是语言名的裸类名（`class="js"`）。
 */
export function languageFromClassName(className: unknown): string {
  const classes = classNameText(className).split(/\s+/u).filter(Boolean);
  for (const name of classes) {
    const match = /^(?:language|lang|hljs|highlight-source|brush)[-:](.+)$/u.exec(name.toLowerCase());
    if (match?.[1]) return match[1];
  }
  for (const name of classes) {
    if (resolveCodeLanguage(name)) return name.toLowerCase();
  }
  return "";
}

/**
 * 无语言标注时的识别。只覆盖「一眼能确定」的形态，其余一律返回空串（按纯文本渲染），
 * 宁可不着色也不要给错语言——错语言会给出整块错误配色，比纯文本更干扰阅读。
 */
export function guessCodeLanguage(code: string): string {
  const text = String(code ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!text || text.length > GUESS_MAX_CHARS) return "";
  // 流式期间同一个块每帧都变，定稿后可能被反复渲染：结果按全文缓存（JSON.parse
  // 与几条正则在长文本上不该每帧重跑）。Map 的插入序即 LRU 序。
  const cached = guessCache.get(text);
  if (cached !== undefined) {
    guessCache.delete(text);
    guessCache.set(text, cached);
    return cached;
  }
  const language = detectCodeLanguage(text);
  guessCache.set(text, language);
  if (guessCache.size > GUESS_CACHE_LIMIT) {
    const oldest = guessCache.keys().next();
    if (!oldest.done) guessCache.delete(oldest.value);
  }
  return language;
}

function detectCodeLanguage(text: string): string {
  // PowerShell 提示符：`PS C:\dir>`（Windows 上模型最常贴的形态）
  if (/^PS [A-Za-z]:\\/u.test(text)) return "powershell";
  // Unix shell：shebang 或行首 `$ 命令`（要求 `$` 后有空格，避开 jQuery 的 `$(...)`）
  if (/^#!\s*\S*\/(?:env\s+\w+\s+|\S*\/)?(?:ba|z|k)?sh\b/mu.test(text)) return "bash";
  if (/^\$ \S/mu.test(text)) return "bash";
  // 统一 diff：`@@ … @@` 是它独有的结构，至少出现一次才算
  if (/^@@ /mu.test(text) && /^(?:diff --git |--- |\+\+\+ )/mu.test(text)) return "diff";
  // JSON：必须真的 parse 得过（带注释的 JSONC 解析失败，就继续留在纯文本）
  const head = text[0];
  if (head === "{" || head === "[") {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // 不是严格 JSON，往下走其它规则
    }
  }
  // SQL：语句起始关键字 + 结构关键字，两个条件都满足才算
  if (/^\s*select\b[\s\S]*\bfrom\b|^\s*insert\s+into\b|^\s*update\s+\S+\s+set\b|^\s*delete\s+from\b|^\s*create\s+(?:table|index|view|database)\b/iu.test(text)) return "sql";
  // 完整标记文档（片段式 HTML 不猜，避免把气泡里的正文判成 xml）
  if (/^(?:<\?xml\b|<!doctype html\b|<html\b)/iu.test(text)) return "xml";
  return "";
}
