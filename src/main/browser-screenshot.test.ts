import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveBrowserScreenshot } from "./browser-screenshot.js";

const SCREENSHOT_PATTERN = /^browser-.*\.(png|jpg)$/u;

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pidesktop-shot-"));
}

describe("saveBrowserScreenshot", () => {
  it("writes the capture into .pidesktop/screenshots and returns a workspace-relative path", async () => {
    const root = await workspace();
    const data = Buffer.from("fake-png-bytes").toString("base64");
    const rel = await saveBrowserScreenshot(root, data, "image/png");
    expect(rel).toMatch(/^\.pidesktop\/screenshots\/browser-.*\.png$/u);
    const absolute = join(root, ...rel.split("/"));
    expect((await readFile(absolute)).toString("base64")).toBe(data);
  });

  it("uses the .jpg extension for jpeg captures", async () => {
    const root = await workspace();
    const data = Buffer.from("fake-jpeg-bytes").toString("base64");
    const rel = await saveBrowserScreenshot(root, data, "image/jpeg");
    expect(rel).toMatch(/\.jpg$/u);
  });

  it("keeps only the most recent screenshots", async () => {
    const root = await workspace();
    for (let index = 0; index < 25; index++) {
      await saveBrowserScreenshot(root, Buffer.from(`png-${index}`).toString("base64"), "image/png");
    }
    const dir = join(root, ".pidesktop", "screenshots");
    const shots = (await readdir(dir)).filter((name) => SCREENSHOT_PATTERN.test(name));
    expect(shots).toHaveLength(20);
  });
});
