import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { classifyTarget, evaluateDeletion, isAllowlistedRelative, tokenize } from "../../scripts/rm-guard.mjs";

/**
 * 危险删除守卫（`scripts/rm-guard.mjs`）的回归网。
 *
 * 两条同样重要的验收轴：
 *   ① 拦得住「不可挽回的一击」——包括旧正则时代的四个绕道口子（`sh -c` 引号、
 *      `sudo` 前缀、`find -delete`、node 的 fs.rmSync）；
 *   ② 不误伤——`echo "…&& rm -rf…"`、带收窄条件的 find、白名单清理都必须放行，
 *      否则这条守卫会被模型/用户当成噪音关掉。
 */

const execFileAsync = promisify(execFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/rm-guard.mjs");
/** 用临时目录当工作区：断言只依赖相对关系，不依赖本机真实路径。 */
const workspace = join(tmpdir(), "rm-guard-workspace");

describe("rm guard · 脚本自身", () => {
  it("首行不能是 shebang（CRLF 检出下会被 Vite 搬到文件中间）", () => {
    // 2026-11-10 CI 全红：GitHub Actions 的 Windows runner 用 CRLF 检出，Vite/vitest 的
    // shebang 剥离把 `#!/usr/bin/env node` 移到了 import 语句之后，于是运行时
    // `SyntaxError: Invalid or unexpected token`（本地 LF 全绿，难以在本地复现）。
    // 钩子与测试一律用 `node <脚本>` 调用，不需要 shebang —— 别再加回来。
    const source = readFileSync(scriptPath, "utf8");
    expect(source.startsWith("#!")).toBe(false);
  });
});

describe("rm guard · 拦", () => {
  it.each([
    ["当前目录", "rm -rf ."],
    ["当前目录带斜杠", "rm -rf ./"],
    ["全通配", "rm -rf *"],
    ["当前目录全通配", "rm -rf ./*"],
    ["家目录", "rm -rf ~"],
    ["$HOME", "rm -rf $HOME"],
    ["根", "rm -rf /"],
    ["盘符根", "rm -rf C:/"],
    ["工作区根（绝对路径）", `rm -rf ${workspace}`],
    ["工作区父级", `rm -rf ${dirname(workspace)}`],
    ["上一级", "rm -rf ../"],
    [".git", "rm -rf .git"],
    ["引号包一层（旧正则的绕道口）", 'sh -c "rm -rf ."'],
    ["bash -lc", "bash -lc 'rm -rf .'"],
    ["sudo 前缀", "sudo rm -rf ."],
    ["子 shell", "(rm -rf .)"],
    ["分号串联", "cd /tmp; rm -rf ."],
    ["find -delete 无收窄", "find . -delete"],
    ["git clean 整仓", "git clean -fdx"],
    ["git -C 后整仓 clean", "git -C .pidesktop clean -fdx"],
    ["node fs.rmSync 递归删当前目录", 'node -e "require(\'fs\').rmSync(\'.\',{recursive:true})"'],
    ["cmd rd /s", 'cmd /c "rd /s /q ."'],
    ["PowerShell 递归删当前目录", "Remove-Item -Recurse -Force ."],
    ["PowerShell 删盘符根", 'powershell -Command "Remove-Item -Recurse -Force C:\\\\"']
  ])("%s", (_label, command) => {
    const verdict = evaluateDeletion({ command, workspace });
    expect(verdict.block, command).toBe(true);
    expect(verdict.reason ?? "").toContain("危险删除拦截");
  });

  it("远端主机上删根类路径同样拦（ssh_exec 走 remote）", () => {
    for (const command of ["rm -rf /", "rm -rf ~", "rm -rf /etc", "rm -rf /*"]) {
      expect(evaluateDeletion({ command, workspace, remote: true }).block, command).toBe(true);
    }
  });

  it("reason 里给出可执行的下一条命令提示", () => {
    const verdict = evaluateDeletion({ command: "rm -rf .", workspace });
    expect(verdict.reason ?? "").toContain("子目录");
  });
});

describe("rm guard · 放", () => {
  it.each([
    ["普通单文件删除", "rm -f one.txt"],
    ["带选项的单文件删除", "rm --interactive one.txt"],
    ["非递归 rm", "rm one.txt"],
    ["工作区内的具体目录（放行 + 留痕）", "rm -rf src/legacy"],
    ["工作区外的具体目录", `rm -rf ${join(tmpdir(), "some-other-project", "dist")}`],
    ["变量目标无法判定（放行 + 留痕）", "rm -rf $BUILD_DIR"],
    ["管道目标无法判定（放行 + 留痕）", "find . -print0 | xargs -0 rm -rf"],
    ["带收窄条件的 find", "find . -name '*.log' -delete"],
    ["非强制 git clean（git 自己会拒）", "git clean -n"],
    ["重定向不被当成删除", "npm test 2>&1 | tail -20"]
  ])("%s", (_label, command) => {
    expect(evaluateDeletion({ command, workspace }).block, command).toBe(false);
  });

  it("白名单目录静默放行（不留痕）", () => {
    for (const command of [
      "rm -rf node_modules",
      "rm -rf dist && npm run build",
      "rm -rf ./node_modules/react",
      "rm -rf .pidesktop/smoke-1.14.0",
      "rm -rf .pidesktop/downloads",
      "find node_modules -delete",
      "git clean -fd node_modules",
      "Remove-Item -Recurse -Force node_modules",
      "node -e \"require('fs').rmSync('dist',{recursive:true})\""
    ]) {
      const verdict = evaluateDeletion({ command, workspace });
      expect(verdict.block, command).toBe(false);
      expect(verdict.note, command).toBeUndefined();
    }
  });

  it("不把「文本里出现的删除命令」当删除（旧正则的误报点）", () => {
    for (const command of ['echo "a && rm -rf ."', "echo rm -rf .", "git commit -m 'note: && rm -rf dist'", "grep -rn 'rm -rf' docs"]) {
      const verdict = evaluateDeletion({ command, workspace });
      expect(verdict.block, command).toBe(false);
      expect(verdict.note, command).toBeUndefined();
    }
  });

  it("空命令 / 空目标不产生裁决", () => {
    expect(evaluateDeletion({})).toEqual({ block: false });
    expect(evaluateDeletion({ command: "   " })).toEqual({ block: false });
    expect(evaluateDeletion({ command: "rm -rf" })).toMatchObject({ block: false });
  });
});

describe("rm guard · 目标分类", () => {
  it("工作区内/外/根三类判定", () => {
    expect(classifyTarget("dist", { workspace })).toMatchObject({ kind: "inside", rel: "dist" });
    expect(classifyTarget("../sibling", { workspace })).toMatchObject({ kind: "outside" });
    expect(classifyTarget(".", { workspace })).toMatchObject({ kind: "root" });
    expect(classifyTarget("$DIR", { workspace })).toMatchObject({ kind: "opaque" });
  });

  it("工作区根、父级、家目录、.git 都算根", () => {
    for (const target of [workspace, dirname(workspace), join(workspace, ".git"), join(workspace, ".git", "objects")]) {
      expect(classifyTarget(target, { workspace }).kind, target).toBe("root");
    }
  });

  it("白名单只认首段目录与 .pidesktop 下的产物子目录", () => {
    for (const rel of ["node_modules", "node_modules/react/index.js", "dist", "build/x", ".tmp-design/x", ".pidesktop/smoke-1.14.0", ".pidesktop/downloads/a.png"]) {
      expect(isAllowlistedRelative(rel), rel).toBe(true);
    }
    for (const rel of [".pidesktop", "src/legacy", "docs", "package.json"]) {
      expect(isAllowlistedRelative(rel), rel).toBe(false);
    }
  });

  it("引号内的分隔符不切段，sh -c 的字符串仍能被递归解析", () => {
    expect(tokenize('echo "a && b"')).toEqual([["echo", "a && b"]]);
    expect(tokenize('sh -c "rm -rf ." && ls')).toEqual([["sh", "-c", "rm -rf ."], ["ls"]]);
  });
});

describe("rm guard · 钩子协议（CLI）", () => {
  async function runHook(payload: Record<string, unknown>): Promise<string> {
    // execFile/exec 不支持 options.input（那是 spawnSync 的），必须自己写 stdin 再 close，
    // 否则脚本的 `for await (const chunk of process.stdin)` 永远等不到 EOF。
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", rejectPromise);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else rejectPromise(new Error(`rm-guard 退出码 ${String(code)}：${stderr}`));
      });
      child.stdin.end(JSON.stringify(payload), "utf8");
    });
  }

  it("拦截时输出 block JSON", async () => {
    const stdout = await runHook({ toolName: "bash", toolInput: { command: "rm -rf ." }, workspace });
    expect(JSON.parse(stdout)).toMatchObject({ block: true });
  });

  it("留痕时输出 additionalContext", async () => {
    const stdout = await runHook({ toolName: "bash", toolInput: { command: "rm -rf src/legacy" }, workspace });
    expect(JSON.parse(stdout).additionalContext).toContain("删除守卫");
  });

  it("白名单 / 非命令类工具 / 坏输入都静默放行（fail-open）", async () => {
    expect(await runHook({ toolName: "bash", toolInput: { command: "rm -rf node_modules" }, workspace })).toBe("");
    expect(await runHook({ toolName: "write", toolInput: { command: "rm -rf ." }, workspace })).toBe("");
    expect(await runHook({ toolName: "bash", toolInput: {}, workspace })).toBe("");
  });

  it("脚本被 node 直接跑时以 --check 返回裁决（人工排查口）", async () => {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--check", JSON.stringify({ command: "rm -rf .", workspace })]);
    expect(JSON.parse(stdout)).toMatchObject({ block: true });
  });
});
