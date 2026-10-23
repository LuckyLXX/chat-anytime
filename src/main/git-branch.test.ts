import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitHead, readGitBranch, watchGitBranch } from "./git-branch.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pidesktop-git-branch-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error("等待条件超时");
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

describe("watchGitBranch", () => {
  it("git checkout 式 rename 覆盖 HEAD 后触发回调", async () => {
    const workspace = await tempWorkspace();
    const gitDir = join(workspace, ".git");
    await mkdir(gitDir);
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");

    let changes = 0;
    const handle = await watchGitBranch(workspace, () => {
      changes++;
    });
    expect(handle).toBeDefined();
    try {
      // 给 fs.watch 一点挂载余量（部分平台是异步就绪的）。
      await sleep(100);
      // git 换分支的真实写法：写 HEAD.lock 再 rename 覆盖 HEAD（inode 被替换）。
      await writeFile(join(gitDir, "HEAD.lock"), "ref: refs/heads/feature/foo\n", "utf8");
      await rename(join(gitDir, "HEAD.lock"), join(gitDir, "HEAD"));
      await waitFor(() => changes > 0);
      await expect(readGitBranch(workspace)).resolves.toBe("feature/foo");
    } finally {
      handle?.close();
    }
  });

  it("close 后不再触发回调", async () => {
    const workspace = await tempWorkspace();
    const gitDir = join(workspace, ".git");
    await mkdir(gitDir);
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");

    let changes = 0;
    const handle = await watchGitBranch(workspace, () => {
      changes++;
    });
    expect(handle).toBeDefined();
    await sleep(100);
    handle!.close();
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/other\n", "utf8");
    await sleep(500);
    expect(changes).toBe(0);
  });

  it("非 git 工作区返回 undefined（调用方可在 git init 后重试挂载）", async () => {
    const workspace = await tempWorkspace();
    await expect(watchGitBranch(workspace, () => {
      throw new Error("非 git 工作区不应触发分支回调");
    })).resolves.toBeUndefined();
  });
});