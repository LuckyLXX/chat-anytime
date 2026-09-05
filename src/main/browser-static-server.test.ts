import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserStaticServer, detectLocalFilePath } from "./browser-static-server.js";

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
