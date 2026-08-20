import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitHead, readGitBranch } from "./git-branch.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pidesktop-git-branch-"));
}

describe("parseGitHead", () => {
  it("解析普通分支引用", () => {
    expect(parseGitHead("ref: refs/heads/main\n")).toBe("main");
    expect(parseGitHead("ref: refs/heads/feature/foo")).toBe("feature/foo");
  });

  it("detached HEAD 返回提交短哈希", () => {
    const hash = "0123456789abcdef0123456789abcdef01234567";
    expect(parseGitHead(`${hash}\n`)).toBe(hash.slice(0, 7));
  });

  it("畸形内容返回 undefined", () => {
    expect(parseGitHead("")).toBeUndefined();
    expect(parseGitHead("not-a-ref")).toBeUndefined();
    expect(parseGitHead("ref: refs/tags/v1.0.0")).toBeUndefined();
  });
});

describe("readGitBranch", () => {
  it("普通仓库读取当前分支", async () => {
    const workspace = await tempWorkspace();
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await expect(readGitBranch(workspace)).resolves.toBe("main");
  });

  it("非 git 项目返回 undefined", async () => {
    const workspace = await tempWorkspace();
    await expect(readGitBranch(workspace)).resolves.toBeUndefined();
  });

  it("linked worktree 通过 .git 文件定位真实 gitdir", async () => {
    const workspace = await tempWorkspace();
    // 主仓库 .git 目录 + worktree 的 .git 文件指向其中
    await mkdir(join(workspace, "..", "main-repo", ".git"), { recursive: true });
    await writeFile(join(workspace, "..", "main-repo", ".git", "HEAD"), "ref: refs/heads/worktree-branch\n", "utf8");
    await writeFile(join(workspace, ".git"), "gitdir: ../main-repo/.git\n", "utf8");
    await expect(readGitBranch(workspace)).resolves.toBe("worktree-branch");
  });

  it("worktree 的 .git 文件支持绝对路径 gitdir", async () => {
    const workspace = await tempWorkspace();
    const gitDir = await tempWorkspace();
    await mkdir(join(gitDir, "worktrees", "main"), { recursive: true });
    await writeFile(join(gitDir, "worktrees", "main", "HEAD"), "ref: refs/heads/abs-abs\n", "utf8");
    await writeFile(join(workspace, ".git"), `gitdir: ${join(gitDir, "worktrees", "main")}\n`, "utf8");
    await expect(readGitBranch(workspace)).resolves.toBe("abs-abs");
  });

  it(".git 存在但缺少 HEAD 时返回 undefined", async () => {
    const workspace = await tempWorkspace();
    await mkdir(join(workspace, ".git"));
    await expect(readGitBranch(workspace)).resolves.toBeUndefined();
  });

  it(".git 条目存在但不是目录也不是文件时返回 undefined", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, ".git"), "not a gitdir line\n", "utf8");
    await expect(readGitBranch(workspace)).resolves.toBeUndefined();
  });
});