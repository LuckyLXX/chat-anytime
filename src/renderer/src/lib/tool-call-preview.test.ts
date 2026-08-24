import { describe, expect, it } from "vitest";
import { buildEditDiffs, diffLines, editArgsSummary, languageFromPath, parseEditCallArgs, parseReadCallArgs, parseWriteCallArgs, writeArgsSummary } from "./tool-call-preview";

describe("parseEditCallArgs", () => {
  it("parses the edits-array form", () => {
    expect(parseEditCallArgs({
      path: "src/app.ts",
      edits: [{ oldText: "foo", newText: "bar" }, { oldText: "a", newText: "b" }]
    })).toEqual({
      path: "src/app.ts",
      edits: [{ oldText: "foo", newText: "bar" }, { oldText: "a", newText: "b" }]
    });
  });

  it("parses the legacy single-edit form", () => {
    expect(parseEditCallArgs({ path: "src/runtime.ts", oldText: "status = idle", newText: "status = ready" })).toEqual({
      path: "src/runtime.ts",
      edits: [{ oldText: "status = idle", newText: "status = ready" }]
    });
  });

  it("skips malformed edit entries instead of bailing", () => {
    expect(parseEditCallArgs({ path: "a.ts", edits: [{ oldText: "x" }, { oldText: "y", newText: "z" }, null] })).toEqual({
      path: "a.ts",
      edits: [{ oldText: "y", newText: "z" }]
    });
  });

  it("returns undefined for non-edit shapes", () => {
    expect(parseEditCallArgs(undefined)).toBeUndefined();
    expect(parseEditCallArgs({ path: "a.ts", edits: [] })).toBeUndefined();
    expect(parseEditCallArgs({ path: "a.ts" })).toBeUndefined();
    expect(parseEditCallArgs("nope")).toBeUndefined();
  });
});

describe("parseWriteCallArgs", () => {
  it("parses path + content", () => {
    expect(parseWriteCallArgs({ path: "a.ts", content: "const x = 1;\n" })).toEqual({ path: "a.ts", content: "const x = 1;\n" });
  });

  it("accepts the legacy file_path field", () => {
    expect(parseWriteCallArgs({ file_path: "a.ts", content: "x" })).toEqual({ path: "a.ts", content: "x" });
  });

  it("returns undefined when content is missing", () => {
    expect(parseWriteCallArgs({ path: "a.ts" })).toBeUndefined();
    expect(parseWriteCallArgs({ content: 3 })).toBeUndefined();
  });
});

describe("diffLines", () => {
  it("reports a single-line replacement", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "x" },
      { type: "context", text: "c" }
    ]);
  });

  it("reports pure insertion", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" }
    ]);
  });

  it("reports pure deletion", () => {
    expect(diffLines("a\nb", "a")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" }
    ]);
  });

  it("keeps identical text as context only", () => {
    expect(diffLines("x\ny", "x\ny")).toEqual([
      { type: "context", text: "x" },
      { type: "context", text: "y" }
    ]);
  });

  it("treats empty sides as full add / full remove", () => {
    expect(diffLines("", "a\nb")).toEqual([{ type: "add", text: "a" }, { type: "add", text: "b" }]);
    expect(diffLines("a\nb", "")).toEqual([{ type: "remove", text: "a" }, { type: "remove", text: "b" }]);
  });

  it("handles fully different content as remove-then-add", () => {
    expect(diffLines("a", "b")).toEqual([
      { type: "remove", text: "a" },
      { type: "add", text: "b" }
    ]);
  });

  it("keeps the shared middle when both ends change", () => {
    expect(diffLines("start\na\nb\nend", "start\nc\nd\nend")).toEqual([
      { type: "context", text: "start" },
      { type: "remove", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "c" },
      { type: "add", text: "d" },
      { type: "context", text: "end" }
    ]);
  });

  it("normalizes CRLF input", () => {
    expect(diffLines("a\r\nb", "a\r\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "c" }
    ]);
  });

  it("bails on oversized regions instead of throwing", () => {
    const big = Array.from({ length: 800 }, (_, index) => `line-${index}`).join("\n");
    const changed = `${big}\nnew-line`;
    expect(diffLines(big, changed)).toBeUndefined();
    expect(diffLines(changed, big)).toBeUndefined();
  });
});

describe("parseReadCallArgs", () => {
  it("extracts path from read args", () => {
    expect(parseReadCallArgs({ path: "src/app.ts", offset: 10, limit: 20 })).toEqual({ path: "src/app.ts" });
    expect(parseReadCallArgs({ path: "a.ts" })).toEqual({ path: "a.ts" });
  });

  it("returns undefined without a string path", () => {
    expect(parseReadCallArgs(undefined)).toBeUndefined();
    expect(parseReadCallArgs({ offset: 1 })).toBeUndefined();
    expect(parseReadCallArgs({ path: 3 })).toBeUndefined();
  });
});

describe("languageFromPath", () => {
  it("maps common extensions to hljs language ids", () => {
    expect(languageFromPath("src/app.ts")).toBe("typescript");
    expect(languageFromPath("src/View.tsx")).toBe("typescript");
    expect(languageFromPath("main.js")).toBe("javascript");
    expect(languageFromPath("README.md")).toBe("markdown");
    expect(languageFromPath("webpack.config.json")).toBe("json");
    expect(languageFromPath("style.css")).toBe("css");
    expect(languageFromPath("index.html")).toBe("xml");
    expect(languageFromPath("app.py")).toBe("python");
    expect(languageFromPath("D:/日常工作区/x/src/CameraController.js")).toBe("javascript");
  });

  it("handles uppercase and Windows-style paths", () => {
    expect(languageFromPath("src\\App.TS")).toBe("typescript");
  });

  it("maps extensionless special filenames", () => {
    expect(languageFromPath("Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("subdir/Makefile")).toBe("makefile");
    expect(languageFromPath("CMakeLists.txt")).toBe("cmake");
  });

  it("returns undefined for dotfiles, unknown extensions, and empty input", () => {
    expect(languageFromPath(".gitignore")).toBeUndefined();
    expect(languageFromPath("src/.env.local")).toBeUndefined();
    expect(languageFromPath("asset.xyz")).toBeUndefined();
    expect(languageFromPath("")).toBeUndefined();
    expect(languageFromPath(undefined)).toBeUndefined();
  });
});

describe("buildEditDiffs / summaries", () => {
  it("builds one block per edit with its computed lines", () => {
    const blocks = buildEditDiffs([{ oldText: "a", newText: "b" }, { oldText: "x", newText: "x" }]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.lines).toEqual([
      { type: "remove", text: "a" },
      { type: "add", text: "b" }
    ]);
    expect(blocks[1]!.lines).toEqual([{ type: "context", text: "x" }]);
  });

  it("renders compact summaries", () => {
    expect(editArgsSummary({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] })).toBe("path: src/app.ts\nedits: 1 处");
    expect(writeArgsSummary({ path: "a.ts", content: "abc" })).toBe("path: a.ts\ncontent: 3 字符");
  });
});
