import { createReadStream } from "node:fs";
import { cp, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin, ViteDevServer } from "vite";

// Vditor 的动态子资源（lute、i18n、icons、content-theme、各类图表渲染器）默认从 CDN
// 拉取，桌面端必须本地化。node_modules 在 renderer root 之外，vite-plugin-static-copy
// 会把绝对路径规范化时丢掉 ".." 段，因此用自定义插件：dev 用中间件把
// node_modules/vditor/dist 暴露在 /lib/vditor/dist；build 用 fs.cp 复制到
// out/<renderer>/lib/vditor/dist。运行时 cdn 指向 lib/vditor（包根），资源走 ${cdn}/dist/...。
const vditorDist = resolve("node_modules/vditor/dist");
const VDITOR_MIME: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".html": "text/html", ".map": "application/json"
};

function copyVditorAssets(): Plugin {
  return {
    name: "copy-vditor-assets",
    configureServer(server: ViteDevServer) {
      const prefix = "/lib/vditor/dist/";
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = ((req.url ?? "").split("?")[0]) ?? "";
        if (!url.startsWith(prefix)) return next();
        const rel = decodeURIComponent(url.slice(prefix.length));
        if (!rel || rel.includes("..")) return next();
        const file = resolve(vditorDist, rel);
        if (!file.startsWith(vditorDist)) return next();
        stat(file).then((info) => {
          if (!info.isFile()) return next();
          res.setHeader("Content-Type", VDITOR_MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-cache");
          createReadStream(file).pipe(res);
        }).catch(() => next());
      });
    },
    async writeBundle(options, _bundle): Promise<void> {
      const outDir = options.dir;
      if (outDir) await cp(vditorDist, resolve(outDir, "lib/vditor/dist"), { recursive: true });
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "pi-runtime": resolve("src/main/pi-runtime.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          // 内置浏览器 WebContentsView 的手动元素选择桥（与 app 渲染端 preload 分开）。
          "browser-pick": resolve("src/preload/browser-pick.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react(), copyVditorAssets()]
  }
});
