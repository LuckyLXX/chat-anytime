import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会话全文检索的接线契约（2026-10-19）。
 *
 * 模块本身的用例只能证明「索引与检索正确」，证明不了 pi-runtime 真的把命令接上、
 * 真的在查询变化时收手、结果真的按 requestId 分流到侧栏/命令面板。这里把接线钉死；行尾归一化
 * 是硬要求（CI 的 windows runner 会检出 CRLF，跨行断言否则本地绿、CI 红）。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

describe("session search wiring contract", () => {
  const runtime = read("pi-runtime.ts");
  const store = read("../renderer/src/store.ts");
  const app = read("../renderer/src/App.tsx");
  const pane = read("../renderer/src/ConversationPane.tsx");

  it("utility 接上 session.search 并用当前助手的会话列表扫描", () => {
    expect(runtime).toContain('case "session.search":');
    expect(runtime).toContain("const sessions = [...currentSessions];");
    expect(runtime).toContain("updateSessionTextEntry(sessionTextIndex, session.path)");
    expect(runtime).toContain("searchSessionText(sessionTextIndex, sessions, command.query)");
    expect(runtime).toContain('post({ type: "session.search-result"');
  });

  it("新查询取代旧查询：扫描途中与回推之前都检查 requestId", () => {
    expect(runtime).toContain("latestSessionSearchRequest = requestId");
    expect(runtime.split("if (latestSessionSearchRequest !== requestId) return;").length - 1).toBe(2);
  });

  it("索引落在 agentDir 且与摘要缓存同一套 mtime+size 增量纪律", () => {
    expect(runtime).toContain('join(getAgentDir(), "pidesktop-session-text-index.json")');
    expect(runtime).toContain("loadSessionTextIndex(sessionTextIndexPath())");
    expect(runtime).toContain("scheduleSessionTextIndexSave()");
    expect(runtime).toContain("pruneSessionTextIndex(sessionTextIndex, MAX_INDEX_CHARS)");
  });

  it("逐文件扫描会让出事件循环", () => {
    expect(runtime).toContain("await yieldToEventLoop();");
  });

  it("渲染端按 requestId 把结果分流给侧栏或命令面板，并丢弃无人认领的过期结果", () => {
    expect(store).toContain('case "session.search-result":');
    // 两份状态各按自己的 requestId 认领；都不匹配就整帧丢弃（查询被放弃后
    // 晚到的结果不能写进任何一份，否则侧栏会冒出与搜索框无关的命中）。
    expect(store).toContain("state.paletteSearch.requestId === message.requestId");
    expect(store).toContain("state.sessionSearch.requestId === message.requestId");
    expect(store).toContain("if (!target) return state;");
    // 侧栏与命令面板各自一条防抖查询：面板那条带 palette-search- 前缀的 requestId。
    expect(app.split('type: "session.search"').length - 1).toBe(2);
    expect(app).toContain("palette-search-");
    expect(app).toContain("setTimeout(() => {");
    expect(app).toContain("pendingReveal");
  });

  it("命中定位复用轮首锚点并真的把高亮透传到气泡", () => {
    // 时间线的 data-turn-key 只挂在轮首 user 消息上：助手命中必须换算成所属轮，
    // 否则「钉住」只实体化、不滚动（长回复是检索主力）。
    expect(pane).toContain("findRevealMessage(data.messages");
    expect(pane).toContain("findRevealTurnKey(data.messages");
    expect(pane).toContain("navigateToTurn(turnKey)");
    expect(pane).toContain("data-revealed={revealed || undefined}");
  });
});
