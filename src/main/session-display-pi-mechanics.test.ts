import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSessionDisplay } from "./session-display.js";

async function withSession(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pidesktop-display-pi-"));
  try {
    const fixture = await createFixture(root);
    try {
      await run(fixture);
    } finally {
      fixture.session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root: string) {
  const manager = SessionManager.create(root, root);
  const settingsManager = SettingsManager.create(root, root);
  let auto = false;
  const model = { contextWindow: 4096, maxTokens: 256 };
  settingsManager.getCompactionSettings = () => ({ enabled: auto, reserveTokens: 2600, keepRecentTokens: 180 });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager, systemPrompt: "fixture", noExtensions: true,
    noSkills: true, noThemes: true, noContextFiles: true
  });
  await resourceLoader.reload();
  const faux = fauxProvider({ models: [{ id: "fixture", ...model }], tokensPerSecond: 1_000_000 });
  const { session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, settingsManager, resourceLoader, model: faux.getModel() });
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  const display = createSessionDisplay(manager);
  return { root, session, manager, faux, display, enableAutomaticCompaction: () => { auto = true; } };
}

async function seedTurns({ session, faux }: Awaited<ReturnType<typeof createFixture>>) {
  for (let turn = 1; turn <= 8; turn++) {
    faux.setResponses([fauxAssistantMessage(`Answer ${turn}. ${"answer ".repeat(60)}`)]);
    await session.prompt(`Question ${turn}. ${"question ".repeat(60)}`);
  }
}

describe("conversation history with the real Pi SDK", () => {
  it("publishes finalized user and assistant messages after their branch entries are appended", async () => {
    await withSession(async ({ session, manager, faux, display }) => {
      const events: Array<{ role: string; committed: boolean }> = [];
      session.subscribe((event) => {
        if (event.type !== "message_end" || (event.message.role !== "user" && event.message.role !== "assistant")) return;
        queueMicrotask(() => {
          events.push({ role: event.message.role, committed: display.committedMessages().includes(event.message) });
        });
      });
      faux.setResponses([fauxAssistantMessage("reply")]);
      await session.prompt("question");
      expect(events).toEqual([
        { role: "user", committed: true },
        { role: "assistant", committed: true }
      ]);
      expect(display.timeline().map(({ role }) => role)).toEqual(["user", "assistant"]);
      expect(manager.getBranch().filter((entry) => entry.type === "message")).toHaveLength(3); // system + one pair
    });
  }, 20_000);

  it.each(["manual", "threshold"] as const)("keeps the conversation through %s compaction and reopening", async (kind) => {
    await withSession(async (fixture) => {
      const { root, session, manager, faux, display, enableAutomaticCompaction } = fixture;
      await seedTurns(fixture);
      const history = display.timeline();
      const uncompressedMessages = session.state.messages.length;
      const completed: string[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end" && event.result) completed.push(event.reason);
        if (kind === "threshold" && event.type === "message_end" && event.message.role === "assistant") enableAutomaticCompaction();
      });
      expect(history).toHaveLength(16);
      if (kind === "manual") {
        faux.setResponses([fauxAssistantMessage("short summary of the previous turns")]);
        await session.compact();
        expect(display.timeline()).toBe(history);
      } else {
        faux.setResponses([fauxAssistantMessage("threshold reply"), fauxAssistantMessage("short summary of the previous turns")]);
        await session.prompt("trigger threshold compaction");
        expect(display.timeline()).toHaveLength(18);
        expect(display.timeline().slice(0, 16).every((message, index) => message === history[index])).toBe(true);
      }
      expect(completed).toEqual([kind]);
      expect(session.state.messages.length).toBeLessThan(uncompressedMessages);
      expect(session.state.messages.some((message) => message.role === "compactionSummary")).toBe(true);
      const reopened = SessionManager.open(manager.getSessionFile()!, root);
      expect(createSessionDisplay(reopened).timeline()).toEqual(display.timeline());

      faux.setResponses([fauxAssistantMessage("after compression")]);
      const beforeNext = display.timeline();
      await session.prompt("next question");
      const afterNext = display.timeline();
      expect(afterNext.slice(0, -2)).toEqual(beforeNext);
      expect(afterNext.at(-1)?.blocks).toEqual([{ type: "text", text: "after compression" }]);
    });
  }, 30_000);
});
