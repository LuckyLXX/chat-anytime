import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserStaticServer, detectLocalFilePath } from "./browser-static-server.js";
import type { PanelRequest } from "../shared/panel.js";

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pidesktop-static-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>root</h1>");
  await writeFile(join(root, "app.js"), "console.log(1)");
  await writeFile(join(root, "sub", "page.html"), "<p>sub</p>");
  return root;
}

function pathToken(url: string): string {
  return /\/w\/([0-9a-f]{16})\//u.exec(url)![1]!;
}

describe("detectLocalFilePath", () => {
  it("parses file:// URLs into platform paths", () => {
    expect(detectLocalFilePath("file:///D:/ws/index.html")).toBe("D:\\ws\\index.html");
  });

  it("accepts bare Windows absolute paths", () => {
    expect(detectLocalFilePath("D:\\ws\\index.html")).toBe("D:\\ws\\index.html");
    expect(detectLocalFilePath("D:/ws/index.html")).toBe("D:/ws/index.html");
  });

  it("leaves http(s), localhost and host:port targets alone", () => {
    expect(detectLocalFilePath("https://example.com")).toBeUndefined();
    expect(detectLocalFilePath("http://localhost:3000/app")).toBeUndefined();
    expect(detectLocalFilePath("localhost:3000")).toBeUndefined();
  });
});

describe("BrowserStaticServer", () => {
  it("serves workspace files over a tokenized loopback URL", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    try {
      const url = await server.urlForFile(join(root, "sub", "page.html"), root);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/w\/[0-9a-f]{16}\/1\/sub\/page\.html$/u);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toBe("<p>sub</p>");
    } finally {
      server.dispose();
    }
  });

  it("maps a directory target to its index.html", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    try {
      const response = await fetch(await server.urlForFile(root, root));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>root</h1>");
    } finally {
      server.dispose();
    }
  });

  it("serves 404 for missing files and wrong tokens", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    try {
      const missing = await fetch(await server.urlForFile(join(root, "nope.html"), root));
      expect(missing.status).toBe(404);

      const url = await server.urlForFile(join(root, "index.html"), root);
      const forged = await fetch(url.replace(pathToken(url), "0".repeat(16)));
      expect(forged.status).toBe(404);
    } finally {
      server.dispose();
    }
  });

  it("rejects path escapes (.. and other-drive absolute paths)", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    try {
      const base = new URL(await server.urlForFile(join(root, "index.html"), root));
      const escape = await fetch(new URL("/w/" + pathToken(base.toString()) + "/1/..%2F..%2Foutside.html", base));
      expect(escape.status).toBe(403);
      // path.join neutralizes the drive-letter segment, so this lands inside
      // the root as a (missing) nested dir → 404, never served.
      const absolute = await fetch(new URL("/w/" + pathToken(base.toString()) + "/1/C:%5CWindows%5Cwin.ini", base));
      expect([403, 404]).toContain(absolute.status);
    } finally {
      server.dispose();
    }
  });

  it("does not follow symlinks out of the mount root", async (ctx) => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "pidesktop-static-out-"));
    await writeFile(join(outside, "secret.txt"), "secret");
    try {
      await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    } catch {
      ctx.skip(); // Windows without symlink privilege
    }
    const server = new BrowserStaticServer();
    try {
      const response = await fetch(await server.urlForFile(join(root, "leak.txt"), root));
      expect(response.status).toBe(403);
    } finally {
      server.dispose();
    }
  });

  it("mounts a file outside the preferred root under its own directory", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "pidesktop-static-out-"));
    await writeFile(join(outside, "draft.html"), "<p>draft</p>");
    const server = new BrowserStaticServer();
    try {
      const url = await server.urlForFile(join(outside, "draft.html"), root);
      // Only the file's own directory gets mounted (the workspace root is not).
      expect(url).toContain("/1/");
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<p>draft</p>");
    } finally {
      server.dispose();
    }
  });
});

/** 面板状态端点的地址：与某个已挂载文件同目录、同 token（面板页就是这么解析的）。 */
function endpointUrl(fileUrl: string): string {
  return fileUrl.replace(/[^/]*$/u, "__pidesktop_state.json");
}

describe("BrowserStaticServer 的面板虚拟端点", () => {
  it("未注册端点时按普通缺失文件处理（不泄露这个地址意味着什么）", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    try {
      const response = await fetch(endpointUrl(await server.urlForFile(join(root, "index.html"), root)));
      expect(response.status).toBe(404);
    } finally {
      server.dispose();
    }
  });

  it("GET 返回 JSON 且禁止缓存（面板每秒轮询，缓存会给出过期状态）", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    server.setEndpoint({ state: () => ({ generatedAt: 123, live: [{ sessionId: "s1" }] }), action: () => true });
    try {
      const response = await fetch(endpointUrl(await server.urlForFile(join(root, "sub", "page.html"), root)));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ generatedAt: 123, live: [{ sessionId: "s1" }] });
    } finally {
      server.dispose();
    }
  });

  it("POST 白名单动作被转发；白名单之外一律 403 且不触发处理函数", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    const seen: PanelRequest[] = [];
    server.setEndpoint({
      state: () => ({}),
      action: (panelRequest) => {
        seen.push(panelRequest);
        return true;
      }
    });
    try {
      const url = endpointUrl(await server.urlForFile(join(root, "index.html"), root));
      const ok = await fetch(url, { method: "POST", body: JSON.stringify({ action: "show-main" }) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, action: "show-main" });
      expect(seen).toEqual([{ action: "show-main" }]);

      const denied = await fetch(url, { method: "POST", body: JSON.stringify({ action: "abort-session" }) });
      expect(denied.status).toBe(403);
      const broken = await fetch(url, { method: "POST", body: "not json" });
      expect(broken.status).toBe(403);
      expect(seen).toEqual([{ action: "show-main" }]);
    } finally {
      server.dispose();
    }
  });

  it("resize 带参数送达端点（尺寸是请求的一部分，不是另一个动作）", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    const seen: PanelRequest[] = [];
    server.setEndpoint({
      state: () => ({}),
      action: (panelRequest) => {
        seen.push(panelRequest);
        return true;
      }
    });
    try {
      const url = endpointUrl(await server.urlForFile(join(root, "index.html"), root));
      const ok = await fetch(url, { method: "POST", body: JSON.stringify({ action: "resize", width: 376, height: 334 }) });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, action: "resize" });
      // 缺尺寸的 resize 不落地（免得主进程猜一个尺寸）
      const missing = await fetch(url, { method: "POST", body: JSON.stringify({ action: "resize", width: 376 }) });
      expect(missing.status).toBe(403);
      expect(seen).toEqual([{ action: "resize", width: 376, height: 334 }]);
    } finally {
      server.dispose();
    }
  });

  it("超大请求体被拒（端点不是上传通道）", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    server.setEndpoint({ state: () => ({}), action: () => true });
    try {
      const url = endpointUrl(await server.urlForFile(join(root, "index.html"), root));
      const response = await fetch(url, { method: "POST", body: `{"action":"show-main","pad":"${"x".repeat(8192)}"}` });
      expect(response.status).toBe(403);
    } finally {
      server.dispose();
    }
  });

  it("非 GET/POST 方法 405；token 不对 404（端点同样受 token 保护）", async () => {
    const root = await workspace();
    const server = new BrowserStaticServer();
    server.setEndpoint({ state: () => ({ ok: true }), action: () => true });
    try {
      const url = endpointUrl(await server.urlForFile(join(root, "index.html"), root));
      expect((await fetch(url, { method: "PUT", body: "{}" })).status).toBe(405);
      const token = pathToken(url);
      const forged = url.replace(token, "0".repeat(16));
      expect((await fetch(forged)).status).toBe(404);
    } finally {
      server.dispose();
    }
  });

  it("端点不劫持同名前缀的真实文件，也不影响文件分支", async () => {
    const root = await workspace();
    await writeFile(join(root, "__pidesktop_state.json.bak"), "backup");
    const server = new BrowserStaticServer();
    server.setEndpoint({ state: () => ({ ok: true }), action: () => true });
    try {
      const fileUrl = await server.urlForFile(join(root, "index.html"), root);
      expect(await (await fetch(await server.urlForFile(join(root, "__pidesktop_state.json.bak"), root))).text()).toBe("backup");
      expect(await (await fetch(fileUrl)).text()).toBe("<h1>root</h1>");
    } finally {
      server.dispose();
    }
  });
});
