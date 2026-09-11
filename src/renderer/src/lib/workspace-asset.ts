import { workspaceFilePreviewUrl } from "../../../shared/protocol.js";

/**
 * 把气泡 / Markdown 里的图片地址解析成渲染端可加载的 URL。
 *
 * 渲染端页面 origin 是应用自身（打包 file://、dev http://localhost），既不是
 * 工作区也不是可映射的相对根，所以 `outputs/fox.png` 这种工作区相对路径在
 * <img> 里天然 404。这里把它映射成 pidesktop-file:// 协议 URL：主进程流式读取
 * 且只允许工作区内文件（越界返回 403），比 file:// 绝对路径更稳、也不暴露
 * 用户目录结构。
 *
 * 保持原样返回的情况（不做映射）：
 * - 带协议的绝对地址（http/https/data/blob/file/pidesktop-file…）；
 * - 协议相对地址（//host/x.png）与页内锚点（#x）；
 * - 根相对 / 上跳 ../ 与含 `..` 的路径（无法安全定位，交给浏览器按原样失败）；
 * - 没有工作区上下文（预览面板、主题预览等无会话场景）。
 */
export function resolveWorkspaceAssetUrl(src: string | undefined, workspace: string | undefined): string | undefined {
  if (!src || !workspace) return src;
  const value = src.trim();
  if (!value || value.startsWith("//") || value.startsWith("#")) return src;
  // 任何 `scheme:` 前缀（含 Windows 盘符 `D:/x` 的单字母 scheme）都视为绝对地址，
  // 不参与工作区相对路径映射。
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return src;

  const [pathPart = "", suffix = ""] = /^([^?#]*)([?#][\s\S]*)?$/u.exec(value)?.slice(1) ?? [];
  const relative = pathPart.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) return src;
  return `${workspaceFilePreviewUrl(workspace, relative)}${suffix}`;
}

/**
 * 以「markdown 文件所在目录」为基准做 POSIX 归一化（处理 `.` / `..`）。
 * 越出工作区根（`..` 冒顶）返回 undefined——调用方据此拒绝映射。
 */
export function resolveWorkspaceRelativePath(markdownPath: string, src: string): string | undefined {
  const directory = markdownPath.replaceAll("\\", "/").split("/").slice(0, -1);
  const stack = directory.filter((segment) => segment && segment !== ".");
  for (const segment of src.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.length ? stack.join("/") : undefined;
}

/**
 * 预览面板里的图片 / 媒体地址解析：先按「md 文件所在目录」解析相对路径，再回退
 * 到工作区根相对路径。
 *
 * 为什么需要它：`resolveWorkspaceAssetUrl` 把一切相对路径都当成「工作区根」相对
 * 路径，并且显式拒绝含 `..` 的地址，于是 `docs/note.md` 里的 `../assets/x.png`
 * 与 `./x.png`（真实含义是 `docs/x.png`）都加载不出来。这里按 dock-markdown 的
 * 优先级（md 目录 → 工作区根）先做纯字符串归一化，再交给同一个协议 URL 映射。
 *
 * 安全边界与渲染端保持一致：**不做文件系统探测**（那需要新 IPC 通道且放宽越权面），
 * 越出工作区根的 `..` 与根相对 `/x` 一律返回原值交给浏览器按原样失败；工作区外
 * （仓库根等）的解析明确不做——`readWorkspaceFilePreview` 同样拒绝工作区外路径。
 */
export function resolveMarkdownAssetUrl(src: string | undefined, options: { markdownPath?: string; workspace?: string } = {}): string | undefined {
  const { markdownPath, workspace } = options;
  if (!src || !workspace || !markdownPath) return resolveWorkspaceAssetUrl(src, workspace);
  const value = src.trim();
  if (!value || value.startsWith("//") || value.startsWith("#")) return src;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return src;

  const [pathPart = "", suffix = ""] = /^([^?#]*)([?#][\s\S]*)?$/u.exec(value)?.slice(1) ?? [];
  const normalized = pathPart.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/")) return src;
  const relative = resolveWorkspaceRelativePath(markdownPath, normalized);
  if (!relative) return src;
  return `${workspaceFilePreviewUrl(workspace, relative)}${suffix}`;
}
