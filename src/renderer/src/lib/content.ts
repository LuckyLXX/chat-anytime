export interface Artifact {
  id: string;
  title: string;
  language: string;
  content: string;
  dynamic?: boolean;
}

export const DYNAMIC_PREVIEW_ACTIONS = {
  pause: "pidesktop-preview-pause",
  resume: "pidesktop-preview-resume",
  destroy: "pidesktop-preview-destroy"
} as const;

export type DynamicPreviewAction = typeof DYNAMIC_PREVIEW_ACTIONS[keyof typeof DYNAMIC_PREVIEW_ACTIONS];

const artifactPattern = /```(html|svg)\s*\n([\s\S]*?)```/giu;
const dynamicArtifactSignalPattern = /<script\b|<canvas\b|<video\b|<audio\b|\b(?:requestAnimationFrame|cancelAnimationFrame|setInterval|setTimeout)\s*\(|\b(?:THREE|WebGLRenderer|OrbitControls)\b|\banime(?:\.min)?\.js\b|\banime\s*\(|\bElement\.prototype\.animate\b|\.(?:animate|play)\s*\(|@keyframes\b|\banimation(?:-name)?\s*:|\btransition\s*:/iu;

const dynamicPreviewRuntime = `
(() => {
  const ACTIONS = {
    pause: '${DYNAMIC_PREVIEW_ACTIONS.pause}',
    resume: '${DYNAMIC_PREVIEW_ACTIONS.resume}',
    destroy: '${DYNAMIC_PREVIEW_ACTIONS.destroy}'
  };
  const nativeRequestAnimationFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (callback) => window.setTimeout(() => callback(performance.now()), 16);
  const nativeCancelAnimationFrame = window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : window.clearTimeout.bind(window);
  const nativeAnimate = typeof Element !== 'undefined' && Element.prototype.animate
    ? Element.prototype.animate
    : null;
  const rafEntries = new Map();
  const pendingRafCallbacks = new Map();
  const animations = new Set();
  const pausedAnimations = new Set();
  let nextRafId = 1;
  let paused = false;
  let destroyed = false;

  function showError(error) {
    try {
      let box = document.getElementById('pidesktop-preview-runtime-error');
      if (!box) {
        box = document.createElement('div');
        box.id = 'pidesktop-preview-runtime-error';
        box.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;z-index:2147483647;padding:9px 11px;border-radius:8px;background:rgba(127,29,29,.94);color:#fff;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap;box-shadow:0 8px 24px rgba(0,0,0,.22)';
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent = '预览脚本错误：' + String(error && error.message ? error.message : error);
    } catch {}
  }

  function trackAnimation(animation) {
    if (!animation || animations.has(animation)) return animation;
    animations.add(animation);
    try {
      animation.addEventListener?.('finish', () => {
        animations.delete(animation);
        pausedAnimations.delete(animation);
      }, { once: true });
      animation.addEventListener?.('cancel', () => {
        animations.delete(animation);
        pausedAnimations.delete(animation);
      }, { once: true });
    } catch {}
    if (paused) {
      try {
        animation.pause?.();
        pausedAnimations.add(animation);
      } catch {}
    }
    return animation;
  }

  if (nativeAnimate) {
    try {
      Element.prototype.animate = function(...args) {
        return trackAnimation(nativeAnimate.apply(this, args));
      };
    } catch {}
  }

  function collectAnimations() {
    try {
      document.getAnimations?.({ subtree: true }).forEach(trackAnimation);
    } catch {}
  }

  function scheduleRaf(id, callback) {
    const nativeId = nativeRequestAnimationFrame((timestamp) => {
      const entry = rafEntries.get(id);
      if (!entry || destroyed) return;
      if (paused) {
        entry.nativeId = null;
        pendingRafCallbacks.set(id, callback);
        return;
      }
      rafEntries.delete(id);
      try {
        callback(timestamp);
      } catch (error) {
        showError(error);
      }
    });
    rafEntries.set(id, { nativeId, callback });
  }

  window.requestAnimationFrame = (callback) => {
    const id = nextRafId++;
    if (destroyed) return id;
    if (paused) {
      rafEntries.set(id, { nativeId: null, callback });
      pendingRafCallbacks.set(id, callback);
    } else {
      scheduleRaf(id, callback);
    }
    return id;
  };

  window.cancelAnimationFrame = (id) => {
    const entry = rafEntries.get(id);
    if (entry && entry.nativeId !== null) nativeCancelAnimationFrame(entry.nativeId);
    rafEntries.delete(id);
    pendingRafCallbacks.delete(id);
  };

  function installPauseStyle() {
    if (document.getElementById('pidesktop-preview-pause-style')) return;
    const style = document.createElement('style');
    style.id = 'pidesktop-preview-pause-style';
    style.textContent = 'html.pidesktop-preview-paused *, html.pidesktop-preview-paused *::before, html.pidesktop-preview-paused *::after { animation-play-state: paused !important; }';
    (document.head || document.documentElement).appendChild(style);
  }

  function pause() {
    if (destroyed || paused) return;
    paused = true;
    installPauseStyle();
    document.documentElement?.classList.add('pidesktop-preview-paused');
    collectAnimations();
    animations.forEach((animation) => {
      try {
        if (animation.playState === 'running' || animation.playState === 'pending') {
          animation.pause();
          pausedAnimations.add(animation);
        }
      } catch {}
    });
  }

  function resume() {
    if (destroyed || !paused) return;
    paused = false;
    document.documentElement?.classList.remove('pidesktop-preview-paused');
    pausedAnimations.forEach((animation) => {
      try { animation.play?.(); } catch {}
    });
    pausedAnimations.clear();
    const pending = Array.from(pendingRafCallbacks.entries());
    pendingRafCallbacks.clear();
    pending.forEach(([id, callback]) => {
      if (rafEntries.has(id)) scheduleRaf(id, callback);
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    rafEntries.forEach((entry) => {
      if (entry && entry.nativeId !== null) nativeCancelAnimationFrame(entry.nativeId);
    });
    rafEntries.clear();
    pendingRafCallbacks.clear();
    collectAnimations();
    animations.forEach((animation) => {
      try { animation.cancel?.(); } catch {}
    });
    animations.clear();
    pausedAnimations.clear();
    if (nativeAnimate) {
      try { Element.prototype.animate = nativeAnimate; } catch {}
    }
    document.querySelectorAll('video, audio').forEach((media) => {
      try { media.pause(); media.removeAttribute('src'); media.load?.(); } catch {}
    });
  }

  window.addEventListener('message', (event) => {
    const action = event?.data?.action;
    if (action === ACTIONS.pause) pause();
    if (action === ACTIONS.resume) resume();
    if (action === ACTIONS.destroy) destroy();
  });
  window.addEventListener('pagehide', destroy);
  window.addEventListener('error', (event) => showError(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => showError(event.reason));
})();`;

export function isDynamicArtifact(artifact: Pick<Artifact, "language" | "content"> & { dynamic?: boolean }): boolean {
  if (artifact.dynamic === true) return true;
  const language = artifact.language.toLowerCase();
  if (language !== "html" && language !== "svg") return false;
  return dynamicArtifactSignalPattern.test(artifact.content);
}

export function withDynamicArtifactFlag<T extends { language: string; content: string }>(artifact: T): T & { dynamic?: boolean } {
  return isDynamicArtifact(artifact) ? { ...artifact, dynamic: true } : artifact;
}

function injectDynamicPreviewRuntime(source: string): string {
  const runtime = `<script>${dynamicPreviewRuntime}</script>`;
  if (/<head\b[^>]*>/iu.test(source)) {
    return source.replace(/<head\b[^>]*>/iu, (match) => `${match}\n${runtime}`);
  }
  if (/<html\b[^>]*>/iu.test(source)) {
    return source.replace(/<html\b[^>]*>/iu, (match) => `${match}\n<head>${runtime}</head>`);
  }
  if (/<body\b[^>]*>/iu.test(source)) {
    return `<!doctype html><html><head>${runtime}</head>${source}</html>`;
  }
  return `${runtime}\n${source}`;
}

export function extractArtifacts(text: string, messageId: string): Artifact[] {
  return [...text.matchAll(artifactPattern)].map((match, index) => {
    const language = match[1]?.toLowerCase() ?? "html";
    const metadata = withDynamicArtifactFlag({
      id: `${messageId}-artifact-${index}`,
      title: language === "svg" ? "SVG 预览" : "HTML 预览",
      language,
      content: match[2] ?? ""
    });
    return metadata;
  });
}

export function isFullArtifactDocument(artifact: Pick<Artifact, "language" | "content">): boolean {
  if (artifact.language === "svg") return false;
  const content = artifact.content.trim();
  return /^<!doctype\s/i.test(content) || /^<html\b/i.test(content) || /^<body\b/i.test(content);
}

export function buildArtifactPreviewSource(artifact: Pick<Artifact, "language" | "content">): string {
  let source: string;
  if (artifact.language === "svg") {
    source = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:sans-serif;background:#fff">${artifact.content}</body></html>`;
  } else if (isFullArtifactDocument(artifact)) {
    source = artifact.content;
  } else {
    source = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;font-family:Inter,Segoe UI,Microsoft YaHei,sans-serif">${artifact.content}</body></html>`;
  }
  return isDynamicArtifact(artifact) ? injectDynamicPreviewRuntime(source) : source;
}

export function artifactSandbox(artifact: Pick<Artifact, "language" | "content">): string {
  return isDynamicArtifact(artifact) || isFullArtifactDocument(artifact) ? "allow-scripts" : "allow-same-origin";
}

export function formatDuration(startedAt: number, completedAt?: number): string {
  const duration = (completedAt ?? Date.now()) - startedAt;
  if (duration < 1000) return `${duration}ms`;
  const seconds = duration / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

export function compactPath(path?: string): string {
  if (!path) return "尚未打开项目";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}

// @ 文件引用与 Skill 不同，没有结构化字段——只在文本里以 @相对路径 存在。
// 渲染时把符合“路径形态”的 @token 摘出来单独渲染成 chip 行，正文保持干净；
// 复制/编辑仍用原始全文，重新发送后同样回环成 chip。
// token 限行首/空白后的 @ 开头，字符限字母数字点横杠斜杠，且必须含 . 或 /
// （拦截 @Component 这类纯单词注解与邮箱中缀 @）。
const mentionTokenPattern = /(?:^|\s)@([\p{L}\p{N}._\-/\\]+)/gu;

export function extractMentionTokens(text: string): { mentions: string[]; body: string } {
  const mentions: string[] = [];
  let body = text.replace(mentionTokenPattern, (match, token: string) => {
    if (token.includes(".") || token.includes("/") || token.includes("\\")) {
      mentions.push(token);
      return " ";
    }
    return match;
  });
  if (mentions.length > 0) body = body.replace(/[ \t]+/gu, " ").replace(/^[ \t]+|[ \t]+$/gmu, "");
  return { mentions, body };
}
