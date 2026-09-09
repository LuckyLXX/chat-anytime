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
