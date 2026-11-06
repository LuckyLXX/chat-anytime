// 记忆总览（v5）的接线断言：记忆中心改成跨助手的图谱后，纯组件测试全绿也可能
// 主进程没实现 memory.overview、编辑命令没带 agentId、或 UI 又退回平铺卡片。
// 这里只盯「线」，行为由 MemoryGraph.test.tsx / MemoryCenter.test.tsx /
// memory-store.v4.test.ts 覆盖。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { primaryMemoryWorkspace } from "./memory-store.js";

const root = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n?/gu, "\n");

describe("primaryMemoryWorkspace", () => {
  it("picks the workspace with the most topics and ignores global ones", () => {
    expect(primaryMemoryWorkspace([
      { workspace: "D:\\a" },
      { workspace: "D:\\b" },
      { workspace: "D:\\a" },
      {}
    ])).toBe("D:\\a");
  });

  it("returns undefined when every topic is global", () => {
    expect(primaryMemoryWorkspace([{}, { workspace: undefined }])).toBeUndefined();
  });

  it("breaks ties by the first topic (summaries are sorted with the newest first)", () => {
    expect(primaryMemoryWorkspace([{ workspace: "D:\\new" }, { workspace: "D:\\old" }])).toBe("D:\\new");
  });

  it("compares Windows paths case-insensitively", () => {
    expect(primaryMemoryWorkspace([{ workspace: "D:\\PiDesktop" }, { workspace: "d:\\pidesktop" }, { workspace: "D:\\other" }])).toBe("D:\\PiDesktop");
  });
});

describe("memory overview wiring", () => {
  it("declares the overview command/response and the optional agentId on memory commands", () => {
    const protocol = read("src/shared/protocol.ts");
    expect(protocol).toContain('| { type: "memory.overview" }');
    expect(protocol).toContain('| { type: "memory.overview"; overview: MemoryOverview }');
    expect(protocol).toContain("export interface MemoryOverviewAgent");
    expect(protocol).toContain("export interface MemoryOverview {");
    expect(protocol).toContain('| { type: "memory.update"; topic: string; description?: string; content?: string; layer?: MemoryLayer; summary?: string; triggers?: string[]; agentId?: string }');
    expect(protocol).toContain('| { type: "memory.delete"; topic: string; agentId?: string }');
    expect(protocol).toContain('| { type: "memory.read"; topicId?: string; topic?: string; agentId?: string }');
    expect(protocol).toContain('| { type: "memory.topic"; topic: MemoryTopic; agentId?: string }');
  });

  it("builds the overview in pi-runtime from each agent's memory directory", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("function buildMemoryOverview(): MemoryOverview {");
    expect(runtime).toContain("readdirSync(base, { withFileTypes: true })");
    expect(runtime).toContain("primaryMemoryWorkspace(topics)");
    expect(runtime).toContain("resolved.store.snapshotDetailed(workspace, MEMORY_SNAPSHOT_BUDGET_CHARS)");
    expect(runtime).toContain("analyzeMemoryHealth(topics, { indexChars: index.characters, indexBudget: MEMORY_SNAPSHOT_BUDGET_CHARS })");
    expect(runtime).toContain('case "memory.overview":');
    expect(runtime).toContain('post({ type: "memory.overview", overview: buildMemoryOverview() });');
  });

  it("resolves a store per agent and never writes another agent's library by accident", () => {
    const runtime = read("src/main/pi-runtime.ts");
    expect(runtime).toContain("function resolveMemoryStore(agentId: string | undefined)");
    expect(runtime).toContain("function memoryStoreOrThrow(agentId: string | undefined)");
    expect(runtime).toContain("const resolved = memoryStoreOrThrow(command.agentId);");
    expect(runtime).toContain("resolved.store.save({");
    expect(runtime).toContain("resolved.store.update(command.topic, {");
    expect(runtime).toContain("resolved.store.remove(command.topic)");
    expect(runtime).toContain("const resolved = resolveMemoryStore(command.agentId);");
    expect(runtime).toContain("post({ type: \"memory.topic\", topic, agentId: resolved.agentId });");
  });

  it("keeps the renderer store keyed by agent and wired to the overview push", () => {
    const store = read("src/renderer/src/store.ts");
    expect(store).toContain('case "memory.overview":');
    expect(store).toContain("memoryOverview: message.overview");
    expect(store).toContain("memoryOverview?: MemoryOverview;");
    expect(store).toContain("memoryCacheKey(message.agentId ?? state.snapshot.agentId, message.topic.id)");
    expect(read("src/renderer/src/lib/memory-format.ts")).toContain("export function memoryCacheKey");
  });

  it("carries agentId through preview tabs, preview content and the host callback", () => {
    const app = read("src/renderer/src/App.tsx");
    expect(app).toContain("const openMemoryTopic = useCallback((topic: MemoryTopicSummary, agentId?: string): void => {");
    expect(app).toContain("onOpenTopic={(topic, agentId) => { closeMemoryCenter(); openMemoryTopic(topic, agentId); }}");
    const tabs = read("src/renderer/src/components/ArtifactPreview.tsx");
    expect(tabs).toContain('| { type: "memory"; topicId: string; title: string; /** 主题所属助手（缺省 = 当前会话的助手）。 */ agentId?: string }');
    expect(tabs).toContain("key={`${target.agentId ?? \"\"}:${target.topicId}`}");
    const preview = read("src/renderer/src/components/MemoryPreview.tsx");
    expect(preview).toContain('void window.piDesktop.send({ type: "memory.read", topicId, ...(agentId ? { agentId } : {}) });');
    expect(preview).toContain("persistContent={(content) => window.piDesktop.send({ type: \"memory.update\", topic: summary.title, description: summary.description, content, ...(agentId ? { agentId } : {}) })}");
  });

  it("renders the graph instead of the flat card wall", () => {
    const center = read("src/renderer/src/MemoryCenter.tsx");
    expect(center).toContain('import { MemoryGraph, type MemoryGraphSelection } from "./components/MemoryGraph";');
    expect(center).toContain("<MemoryGraph");
    expect(center).not.toContain("MemoryCard");
    expect(center).toContain('void window.piDesktop.send({ type: "memory.overview" });');
    expect(center).toContain('aria-label="按助手筛选"');
    expect(center).toContain('aria-label="按归属筛选"');
  });

  it("draws the connector trunk and per-node stubs in CSS (no layout measurement)", () => {
    const css = read("src/renderer/src/styles.css");
    expect(css).toContain(".mg-agent.has-trunk .mg-lanes::before");
    expect(css).toContain(".mg-node::before");
    expect(css).toContain(".mg-node[data-layer=\"core\"] { --mg-link-color: var(--accent); }");
    expect(css).toContain(".mg-lanes-archive .mg-node::before, .mg-lanes-archive .mg-node::after { display: none; }");
  });
});
