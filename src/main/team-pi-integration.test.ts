import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentProfile, ThinkingLevel } from "../shared/protocol.js";
import type { PersistedSessionEntry } from "./session-history.js";
import { TEAM_ENTRY_TYPE } from "./team-store.js";
import { TeamRuntime } from "./team-runtime.js";

/**
 * 真实 AgentSession 上的团队链路冒烟（零网络 faux provider）：
 * defaultCreateChild 的 createAgentSession/bindExtensions/资源加载器选项、首条
 * prompt 的 preflight、成员子会话落盘、dispose 后重新构造运行时的冷恢复。
 * fake child 的单测只能证明编排逻辑；Pi 的字段名/事件时序漂移只有这条能发现。
 */

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function agentProfile(): AgentProfile {
  return {
    id: "agent-1",
    name: "测试助手",
    description: "",
    systemPrompt: "你是测试助手",
    divMode: "auto",
    defaultThinkingLevel: "medium",
    tools: { read: true, bash: true, edit: true, write: true, powershell: false } as AgentProfile["tools"]
  };
}

async function makeLead(): Promise<{ lead: AgentSession; faux: ReturnType<typeof fauxProvider>; agentDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-team-real-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const { session: lead } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    customTools: [],
    model: faux.getModel(),
    sessionManager: SessionManager.create(root, join(root, "sessions"))
  });
  await lead.bindExtensions({ onError: () => {} });
  lead.modelRuntime.registerNativeProvider(faux.provider);
  await lead.modelRuntime.refresh({ allowNetwork: false });
  return { lead, faux, agentDir, root };
}

function makeRuntime(lead: AgentSession, root: string, agentDir: string): TeamRuntime {
  return new TeamRuntime({
    leadSession: lead,
    workspace: root,
    agentDir,
    agent: agentProfile(),
    modelRuntime: lead.modelRuntime,
    getThinkingLevel: () => "medium" as ThinkingLevel,
    requestPermission: () => Promise.resolve("allow-once"),
    onChange: () => undefined
  });
}

function activeMemberFile(lead: AgentSession): string {
  const entries = lead.sessionManager.getBranch() as unknown as PersistedSessionEntry[];
  const entry = entries.find((candidate) =>
    candidate.type === "custom"
    && candidate.customType === TEAM_ENTRY_TYPE
    && (candidate.data as { kind?: string } | undefined)?.kind === "member"
    && ((candidate.data as { member?: { phase?: string } }).member?.phase === "active"));
  const file = (entry?.data as { member?: { sessionFile?: string } } | undefined)?.member?.sessionFile;
  if (!file) throw new Error("active member entry not found");
  return file;
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("team MVP over a real AgentSession", () => {
  it("spawns a real child session, persists it, and cold-resumes it after runtime disposal", async () => {
    const { lead, faux, agentDir, root } = await makeLead();
    const runtime = makeRuntime(lead, root, agentDir);
    try {
      faux.setResponses([fauxAssistantMessage("已完成审查")]);
      const member = await runtime.spawn(
        { role: "lead", name: "lead" },
        { name: "reviewer", description: "审查改动", prompt: "看一下 src/a.ts 的改动" }
      );
      expect(member).toMatchObject({ target: "reviewer", role: "teammate" });

      const file = activeMemberFile(lead);
      await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("看一下 src/a.ts 的改动"));
      await waitFor(() => runtime.list({ role: "lead", name: "lead" }).find((row) => row.target === "reviewer")?.status === "inactive");
      expect(readFileSync(file, "utf8")).toContain('"role":"user"');
    } finally {
      runtime.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      lead.dispose();
    }

    // 重新构造运行时：roster 从 Lead 分支折叠，send 走 SessionManager.open 冷恢复。
    const { lead: lead2, faux: faux2, agentDir: agentDir2, root: root2 } = await makeLead();
    const runtime2 = makeRuntime(lead2, root2, agentDir2);
    try {
      faux2.setResponses([fauxAssistantMessage("第一轮")]);
      await runtime2.spawn({ role: "lead", name: "lead" }, { name: "reviewer", description: "审查", prompt: "第一轮任务" });
      const file = activeMemberFile(lead2);
      await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("第一轮任务"));
      runtime2.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const runtime3 = makeRuntime(lead2, root2, agentDir2);
      faux2.setResponses([fauxAssistantMessage("第二轮")]);
      await runtime3.send({ role: "lead", name: "lead" }, "reviewer", "继续第二轮");
      await waitFor(() => readFileSync(file, "utf8").includes("继续第二轮"));
      await waitFor(() => runtime3.list({ role: "lead", name: "lead" }).find((row) => row.target === "reviewer")?.status === "inactive");
      runtime3.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      runtime2.dispose();
      lead2.dispose();
    }
  }, 20_000);
});
