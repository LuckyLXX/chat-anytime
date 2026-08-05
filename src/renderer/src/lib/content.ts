export interface Artifact {
  id: string;
  title: string;
  language: string;
  content: string;
}

const artifactPattern = /```(html|svg)\s*\n([\s\S]*?)```/giu;

export function extractArtifacts(text: string, messageId: string): Artifact[] {
  return [...text.matchAll(artifactPattern)].map((match, index) => ({
    id: `${messageId}-artifact-${index}`,
    title: match[1]?.toLowerCase() === "svg" ? "SVG 预览" : "HTML 预览",
    language: match[1]?.toLowerCase() ?? "html",
    content: match[2] ?? ""
  }));
}

export function isFullArtifactDocument(artifact: Pick<Artifact, "language" | "content">): boolean {
  if (artifact.language === "svg") return false;
  const content = artifact.content.trim();
  return /^<!doctype\s/i.test(content) || /^<html\b/i.test(content) || /^<body\b/i.test(content);
}

export function buildArtifactPreviewSource(artifact: Pick<Artifact, "language" | "content">): string {
  if (artifact.language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:sans-serif;background:#fff">${artifact.content}</body></html>`;
  }
  if (isFullArtifactDocument(artifact)) return artifact.content;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;font-family:Inter,Segoe UI,Microsoft YaHei,sans-serif">${artifact.content}</body></html>`;
}

export function artifactSandbox(artifact: Pick<Artifact, "language" | "content">): string {
  return isFullArtifactDocument(artifact) ? "allow-scripts" : "allow-same-origin";
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  const duration = (completedAt ?? Date.now()) - startedAt;
  if (duration < 1000) return `${duration}ms`;
  return `${(duration / 1000).toFixed(1)}s`;
}

export function compactPath(path?: string): string {
  if (!path) return "尚未打开项目";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}
