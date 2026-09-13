import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_DIR_SEGMENTS,
  MAX_DOWNLOAD_NAME_CHARS,
  downloadDirFor,
  downloadRelativePath,
  sanitizeDownloadName
} from "./browser-downloads.js";

describe("sanitizeDownloadName", () => {
  it("keeps an ordinary name untouched", () => {
    expect(sanitizeDownloadName("report-2026.csv")).toBe("report-2026.csv");
    expect(sanitizeDownloadName(" 月度 报表 （最终）.xlsx ")).toBe("月度 报表 （最终）.xlsx");
  });

  it("strips directory components (path traversal)", () => {
    expect(sanitizeDownloadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeDownloadName("a/b.txt")).toBe("b.txt");
    expect(sanitizeDownloadName("..\\..\\windows\\win.ini")).toBe("win.ini");
    expect(sanitizeDownloadName("..\\../mixed/path/evil.sh")).toBe("evil.sh");
    expect(sanitizeDownloadName("....//....//etc/hosts")).toBe("hosts");
  });

  it("drops dot-only and separator-only names to the timestamp fallback", () => {
    const fallback = sanitizeDownloadName("..");
    expect(fallback).toMatch(/^download-\d{8}-\d{6}-\d{3}$/u);
    expect(sanitizeDownloadName(".../...")).toMatch(/^download-/u);
    expect(sanitizeDownloadName("")).toMatch(/^download-/u);
    expect(sanitizeDownloadName("   ")).toMatch(/^download-/u);
    expect(sanitizeDownloadName(".hidden")).toBe("hidden");
    expect(sanitizeDownloadName("trailing.")).toBe("trailing");
  });

  it("removes control characters and Windows-forbidden characters", () => {
    expect(sanitizeDownloadName("a\u0000b\u001fc.txt")).toBe("a_b_c.txt");
    expect(sanitizeDownloadName('q"uote:pipe|star*.csv')).toBe("q_uote_pipe_star_.csv");
    expect(sanitizeDownloadName("tab\tname.csv")).toBe("tab_name.csv");
  });

  it("escapes Windows reserved device names", () => {
    expect(sanitizeDownloadName("CON")).toBe("_CON");
    expect(sanitizeDownloadName("nul")).toBe("_nul");
    expect(sanitizeDownloadName("LPT1.txt")).toBe("_LPT1.txt");
    expect(sanitizeDownloadName("console.csv")).toBe("console.csv");
  });

  it("truncates overlong names on the extension boundary", () => {
    const long = `${"x".repeat(400)}.csv`;
    const sanitized = sanitizeDownloadName(long);
    expect(sanitized.length).toBeLessThanOrEqual(MAX_DOWNLOAD_NAME_CHARS);
    expect(sanitized.endsWith(".csv")).toBe(true);
    const extless = sanitizeDownloadName("y".repeat(400));
    expect(extless.length).toBeLessThanOrEqual(MAX_DOWNLOAD_NAME_CHARS);
    expect(extless).not.toMatch(/\.$/u);
  });

  it("never returns a path separator or a parent reference", () => {
    for (const raw of ["../../etc/passwd", "a/b.txt", "C:\\Windows\\evil.dll", "..\\..\\..\\x", "/etc/shadow"]) {
      const sanitized = sanitizeDownloadName(raw);
      expect(sanitized).not.toContain("/");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toContain("..");
    }
  });
});

describe("download drop directory", () => {
  it("lives under the workspace's .pidesktop data dir", () => {
    expect(DOWNLOAD_DIR_SEGMENTS.join("/")).toBe(".pidesktop/downloads");
    expect(downloadRelativePath("a.csv")).toBe(".pidesktop/downloads/a.csv");
    expect(downloadDirFor("D:\\ws").replaceAll("\\", "/")).toBe("D:/ws/.pidesktop/downloads");
  });
});
