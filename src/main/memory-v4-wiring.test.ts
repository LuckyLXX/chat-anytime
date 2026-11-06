// 记忆中心 + v4 命令的接线断言：纯组件测试与 store 测试全绿，也可能 App 根本没渲染
// MemoryCenter、面板没把入口接出去、pi-runtime 没处理 memory.indexPreview。
// 这里只盯「线」，行为由 MemoryCenter.test.tsx / memory-store.v4.test.ts 覆盖。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8").replace(/\r\n?/gu, "\n");

describe("memory v4 wiring", () => {
  it("renders the memory center from App and gives the panel an entry", () => {
    const app = read("src/renderer/src/App.tsx");
    expect(app).toContain('import { MemoryCenter } from "./MemoryCenter";');
    expect(app).toContain("const [memoryCenterOpen, setMemoryCenterOpen] = useState(false);");
    expect(app).toContain("const memoryCenterPresence = useExitPresence(memoryCenterOpen, 160);");
    expect(app).toContain("<MemoryCenter");
    expect(app).toContain("onClose={closeMemoryCenter}");
    expect(app).toContain("onOpenTopic={(topic, agentId) => { closeMemoryCenter(); openMemoryTopic(topic, agentId); }}");
    expect(app).toContain("onOpenMemoryCenter={openMemoryCenter}");
    expect(app).toContain("memory-center-open-nav");
    expect(app).toContain('id: "view.memory"');
  });

  it("forwards the center entry from the pane dock to the memory panel", () => {
    const pane = read("src/renderer/src/ConversationPane.tsx");
    expect(pane).toContain("onOpenMemoryCenter?(): void;");
    expect(pane).toContain("onOpenMemoryCenter={onOpenMemoryCenter}");
    const dock = read("src/renderer/src/PanelDock.tsx");
    expect(dock).toContain("onOpenMemoryCenter?: () => void");
    expect(dock).toContain("onOpenCenter={onOpenMemoryCenter}");
    const panel = read("src/renderer/src/MemoryPanel.tsx");
    expect(panel).toContain('data-control="memory-center-open"');
  });

  it("serves the index preview from pi-runtime with the same snapshot function", () => {
    expect(read("src/main/pi-runtime.ts")).toContain('case "memory.indexPreview":');
    expect(read("src/main/pi-runtime.ts")).toContain("memoryStore.snapshotMarkdown(workspace, MEMORY_SNAPSHOT_BUDGET_CHARS)");
    expect(read("src/main/pi-runtime.ts")).toContain("resolved.store.update(command.topic, {");
    expect(read("src/main/pi-runtime.ts")).toContain('case "memory.health":');
    expect(read("src/main/pi-runtime.ts")).toContain("analyzeMemoryHealth(summaries");
  });

  it("keeps the memory center store state wired to the runtime message", () => {
    const store = read("src/renderer/src/store.ts");
    expect(store).toContain('case "memory.index-preview":');
    expect(store).toContain("memoryIndexPreview:");
    expect(store).toContain('case "memory.health":');
    expect(read("src/renderer/src/MemoryCenter.tsx")).toContain("MemoryHealthPane");
    expect(read("src/renderer/src/MemoryCenter.tsx")).toContain('setDetailTab("health")');
  });
});
