import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentProfile, SessionSummary } from "../shared/protocol.js";
import { listSessionScopes, pickRecentSession, resolveSessionOwner, summarizeAllSessions, type SessionScope, type WorkspaceExistsEntry } from "./session-catalog.js";
import { sessionPathKey } from "./session-scope.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pidesktop-session-catalog-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function makeAgent(id: string, options: { name?: string; archived?: boolean } = {}): AgentProfile {
  return {
    id,
    name: options.name ?? id,
    description: "",
    systemPrompt: "",
    divMode: "off",
    defaultThinkingLevel: "medium",
    tools: { read: false, bash: false, powershell: false, edit: false, write: false, grep: false, find: false, ls: false },
    archived: options.archived
  };
}

function makeScope(id: string, dirs: string[], archived = false): SessionScope {
  return { agentId: id, agentName: id, agentArchived: archived, dirs };
}

interface SessionFixture {
  id: string;
  cwd: string;
  timestamp: string;
  name?: string;
  userText?: string;
}

/** 手写最小合法 Pi 会话文件：真实走 listSessionSummaries 的解析路径。 */
function writeSession(dir: string, fixture: SessionFixture): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fixture.id}.jsonl`);
  const lines: unknown[] = [
    { type: "session", version: 3, id: fixture.id, timestamp: fixture.timestamp, cwd: fixture.cwd }
  ];
  if (fixture.userText !== undefined) {
    lines.push({
      type: "message",
      id: `${fixture.id}-m1`,
      parentId: null,
      timestamp: fixture.timestamp,
      message: { role: "user", content: fixture.userText }
    });
  }
  if (fixture.name !== undefined) {
    lines.push({ type: "session_info", id: `${fixture.id}-info`, parentId: null, timestamp: fixture.timestamp, name: fixture.name });
  }
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return path;
}

function makeSession(
  input: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path" | "workspace" | "modifiedAt" | "agentId">
): SessionSummary {
  return { title: `会话 ${input.id}`, messageCount: 1, ...input };
}

describe("listSessionScopes", () => {
  it("scans active/archived/orphan agents and only keeps workspace subdirectories", async () => {
    const agentDir = tempDir("scopes");
    const sessionsRoot = join(agentDir, "chatanytime-sessions");
    const alphaRoot = join(sessionsRoot, "alpha");
    const alphaWorkspace = join(alphaRoot, "ws-alpha");
    mkdirSync(alphaWorkspace, { recursive: true });
    // 所有已知 sidecar 都不是工作区；文件也不是。
    for (const sidecar of ["delegations", "todos", "plans", "design-mode", "computer-mode", "team-mode", "checkpoints"]) {
      mkdirSync(join(alphaRoot, sidecar), { recursive: true });
    }
    writeFileSync(join(alphaRoot, "notes.txt"), "不是目录", "utf8");
    const betaWorkspace = join(sessionsRoot, "beta", "ws-beta");
    mkdirSync(betaWorkspace, { recursive: true });
    const ghostWorkspace = join(sessionsRoot, "ghost", "ws-ghost");
    mkdirSync(ghostWorkspace, { recursive: true });

    const scopes = await listSessionScopes(agentDir, [
      makeAgent("alpha", { name: "Alpha" }),
      makeAgent("beta", { name: "Beta", archived: true }),
      makeAgent("gamma", { name: "Gamma" })
    ]);

    expect(scopes.map((scope) => scope.agentId)).toEqual(["alpha", "beta", "gamma", "ghost"]);

    const alpha = scopes.find((scope) => scope.agentId === "alpha")!;
    expect(alpha.agentName).toBe("Alpha");
    expect(alpha.agentArchived).toBe(false);
    expect(alpha.dirs).toEqual([alphaWorkspace]);

    const beta = scopes.find((scope) => scope.agentId === "beta")!;
    expect(beta.agentName).toBe("Beta");
    expect(beta.agentArchived).toBe(true);
    expect(beta.dirs).toEqual([betaWorkspace]);

    // settings 有、磁盘没有：仍产出 scope，dirs 为空。
    const gamma = scopes.find((scope) => scope.agentId === "gamma")!;
    expect(gamma.agentName).toBe("Gamma");
    expect(gamma.dirs).toEqual([]);

    // 磁盘有、settings 没有：孤儿目录照常产出，显示名/归档态用安全默认值。
    const ghost = scopes.find((scope) => scope.agentId === "ghost")!;
    expect(ghost.agentName).toBe("ghost");
    expect(ghost.agentArchived).toBe(false);
    expect(ghost.dirs).toEqual([ghostWorkspace]);
  });

  it("still returns settings agents when chatanytime-sessions does not exist", async () => {
    const agentDir = tempDir("no-root");
    const scopes = await listSessionScopes(agentDir, [makeAgent("only", { name: "唯一助手" })]);
    expect(scopes).toEqual([{ agentId: "only", agentName: "唯一助手", agentArchived: false, dirs: [] }]);
  });
});

describe("summarizeAllSessions", () => {
  it("maps agentId/workspace/title and flags missing or non-directory workspaces", async () => {
    const root = tempDir("summarize");
    const liveWorkspace = join(root, "workspaces", "live");
    const missingWorkspace = join(root, "workspaces", "deleted");
    const fileWorkspace = join(root, "workspaces", "file.txt");
    mkdirSync(liveWorkspace, { recursive: true });
    writeFileSync(fileWorkspace, "不是目录", "utf8");

    const alphaDir = join(root, "chatanytime-sessions", "alpha");
    const pinnedPath = writeSession(alphaDir, {
      id: "pinned",
      cwd: liveWorkspace,
      timestamp: "2026-01-01T00:00:00.000Z",
      name: "置顶标题"
    });
    const missingPath = writeSession(alphaDir, {
      id: "missing",
      cwd: missingWorkspace,
      timestamp: "2026-02-01T00:00:00.000Z",
      userText: "缺失工作区会话"
    });
    const betaDir = join(root, "chatanytime-sessions", "beta");
    const filePath = writeSession(betaDir, {
      id: "file",
      cwd: fileWorkspace,
      timestamp: "2026-03-01T00:00:00.000Z",
      name: "文件工作区"
    });

    const scopes = [makeScope("alpha", [alphaDir]), makeScope("beta", [betaDir], true)];
    const sessions = await summarizeAllSessions(scopes, {
      cache: new Map(),
      // 置顶/归档按 sessionPathKey 匹配：故意换大小写与分隔符验证口径一致。
      pinnedPaths: [pinnedPath.replaceAll("\\", "/").toUpperCase()],
      archivedPaths: [filePath]
    });

    expect(sessions.map((session) => session.id)).toEqual(["pinned", "file", "missing"]);
    const byId = new Map(sessions.map((session) => [session.id, session]));

    const pinned = byId.get("pinned")!;
    expect(pinned.agentId).toBe("alpha");
    expect(pinned.workspace).toBe(liveWorkspace);
    expect(pinned.title).toBe("置顶标题");
    expect(pinned.pinned).toBe(true);
    expect(pinned.workspaceMissing).toBeUndefined();

    const missing = byId.get("missing")!;
    expect(missing.agentId).toBe("alpha");
    expect(missing.workspace).toBe(missingWorkspace);
    expect(missing.title).toBe("缺失工作区会话");
    expect(missing.workspaceMissing).toBe(true);

    const file = byId.get("file")!;
    expect(file.agentId).toBe("beta");
    expect(file.title).toBe("文件工作区");
    expect(file.archived).toBe(true);
    expect(file.workspaceMissing).toBe(true);
    expect(missingPath).not.toBe(filePath);
  });

  it("probes each unique workspace once until the TTL expires", async () => {
    const root = tempDir("ttl");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const scopeDir = join(root, "chatanytime-sessions", "alpha", "ws");
    writeSession(scopeDir, { id: "a", cwd: workspace, timestamp: "2026-04-01T00:00:00.000Z" });
    writeSession(scopeDir, { id: "b", cwd: workspace, timestamp: "2026-04-02T00:00:00.000Z" });

    let now = 1_000;
    let calls = 0;
    const workspaceExistsCache = new Map<string, WorkspaceExistsEntry>();
    const options = {
      cache: new Map(),
      workspaceExistsCache,
      now: () => now,
      workspaceExistsTtlMs: 10_000,
      isDirectory: (path: string) => {
        calls += 1;
        return path === workspace;
      }
    };

    const first = await summarizeAllSessions([makeScope("alpha", [scopeDir])], options);
    expect(first).toHaveLength(2);
    expect(first.every((session) => session.workspaceMissing === undefined)).toBe(true);
    expect(calls).toBe(1);
    expect(workspaceExistsCache.get(sessionPathKey(workspace))).toEqual({ exists: true, checkedAt: 1_000 });

    now = 10_999;
    await summarizeAllSessions([makeScope("alpha", [scopeDir])], options);
    expect(calls).toBe(1);

    now = 11_000;
    await summarizeAllSessions([makeScope("alpha", [scopeDir])], options);
    expect(calls).toBe(2);
    expect(workspaceExistsCache.get(sessionPathKey(workspace))?.checkedAt).toBe(11_000);
  });
});

describe("resolveSessionOwner", () => {
  it("prefers summary, then live hints, then a boundary-safe directory prefix", () => {
    const root = tempDir("owner");
    const alphaDir = join(root, "a");
    const betaDir = join(root, "b");
    const targetUnderBeta = join(betaDir, "session.jsonl");
    const targetUnderAlpha = join(alphaDir, "session.jsonl");
    const alpha = makeScope("alpha", [alphaDir]);
    const beta = makeScope("beta", [betaDir]);

    // 摘要带 agentId，优先于物理目录前缀。
    const summary = makeSession({ id: "s", path: targetUnderBeta, workspace: betaDir, modifiedAt: 1, agentId: "alpha" });
    expect(resolveSessionOwner(targetUnderBeta, [alpha, beta], { summaries: [summary] })?.agentId).toBe("alpha");

    // 无摘要时 live 记录优先于前缀。
    expect(resolveSessionOwner(targetUnderBeta, [alpha, beta], { live: [{ path: targetUnderBeta, agentId: "alpha" }] })?.agentId).toBe("alpha");

    // 都没有时按目录前缀归属。
    expect(resolveSessionOwner(targetUnderBeta, [alpha, beta])?.agentId).toBe("beta");

    // 边界：C:\a 不能误匹配 C:\ab（在临时根下用 a / ab 复现同一形态）。
    const shortDir = join(root, "boundary", "a");
    const lookalike = join(root, "boundary", "ab", "session.jsonl");
    expect(resolveSessionOwner(lookalike, [makeScope("alpha", [shortDir])])).toBeUndefined();
    expect(resolveSessionOwner(join(shortDir, "nested", "session.jsonl"), [makeScope("alpha", [shortDir])])?.agentId).toBe("alpha");
    // 等于目录本身也算归属（rename/delete 可能收到目录路径做校验）。
    expect(resolveSessionOwner(shortDir, [makeScope("alpha", [shortDir])])?.agentId).toBe("alpha");
    // 直接锁定需求里的字面量形态。
    expect(resolveSessionOwner("C:\\ab\\session.jsonl", [makeScope("alpha", ["C:\\a"])])).toBeUndefined();
    expect(resolveSessionOwner("C:\\a\\session.jsonl", [makeScope("alpha", ["C:\\a"])])?.agentId).toBe("alpha");

    // 大小写/分隔符归一后仍能命中。
    expect(resolveSessionOwner(targetUnderAlpha.replaceAll("\\", "/").toUpperCase(), [alpha])?.agentId).toBe("alpha");
    expect(resolveSessionOwner(join(root, "elsewhere", "session.jsonl"), [alpha, beta])).toBeUndefined();
  });
});

describe("pickRecentSession", () => {
  it("matches workspace across assistants, skipping archived sessions and archived agents", () => {
    const root = tempDir("pick");
    const workspace = join(root, "Work", "Project");
    const archivedSession = makeSession({
      id: "archived-session",
      path: join(root, "sessions", "archived.jsonl"),
      workspace: workspace.replaceAll("\\", "/").toUpperCase(),
      modifiedAt: 600,
      agentId: "alpha",
      archived: true
    });
    const betaNewest = makeSession({
      id: "beta-newest",
      path: join(root, "sessions", "beta.jsonl"),
      workspace: workspace.toLowerCase(),
      modifiedAt: 700,
      agentId: "beta"
    });
    const alphaNewest = makeSession({
      id: "alpha-newest",
      path: join(root, "sessions", "alpha-new.jsonl"),
      workspace,
      modifiedAt: 500,
      agentId: "alpha"
    });
    const alphaOlder = makeSession({
      id: "alpha-older",
      path: join(root, "sessions", "alpha-old.jsonl"),
      workspace,
      modifiedAt: 300,
      agentId: "alpha"
    });
    const all = [alphaOlder, betaNewest, archivedSession, alphaNewest];
    const agents = [makeAgent("alpha", { name: "Alpha" }), makeAgent("beta", { name: "Beta", archived: true })];

    // 默认：跳过归档会话和归档助手的会话，取未归档里最新的。
    expect(pickRecentSession(all, workspace, { agents })?.id).toBe("alpha-newest");
    // includeArchived 只解除会话归档，不解除归档助手。
    expect(pickRecentSession(all, workspace, { agents, includeArchived: true })?.id).toBe("archived-session");
    // 两个开关都放开才轮到归档助手的最新会话。
    expect(
      pickRecentSession(all, workspace, { agents, includeArchived: true, excludeArchivedAgents: false })?.id
    ).toBe("beta-newest");
    // 缺 agents 时无法判断助手归档态，视为未归档（不能因此隐藏会话）。
    expect(pickRecentSession(all, workspace)?.id).toBe("beta-newest");
    expect(pickRecentSession(all, join(root, "Other"), { agents })).toBeUndefined();
  });
});
