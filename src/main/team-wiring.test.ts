import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 团队 MVP 的接线契约：纯逻辑单测全绿但主进程没接线是这类功能最典型的静默失败
 * （工具永远不激活、快照永远不带成员、dispose 不停止成员）。这里用源码断言把
 * 关键接线点一次性钉住；改动这些结构时测试会红，而不是等用户在真机上发现。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8");

const runtimeSource = read("pi-runtime.ts");
const teamRuntimeSource = read("team-runtime.ts");
const protocolSource = read("../shared/protocol.ts");
const storeSource = read("../renderer/src/store.ts");
const appSource = read("../renderer/src/App.tsx");
const paneSource = read("../renderer/src/ConversationPane.tsx");
const stripSource = read("../renderer/src/components/TeamStrip.tsx");
const boardSource = read("../renderer/src/components/TeamBoard.tsx");
const formationSource = read("../renderer/src/components/TeamFormation.tsx");
const localeSource = read("../shared/locale.ts");
const cssSource = read("../renderer/src/styles.css");

describe("team wiring", () => {
  it("declares the protocol surface (snapshot fields + commands)", () => {
    expect(protocolSource).toMatch(/export interface TeamSnapshot/u);
    expect(protocolSource).toMatch(/export interface TeamMemberSummary/u);
    expect(protocolSource).toMatch(/team\?: TeamSnapshot/u);
    expect(protocolSource).toMatch(/teamMode\?: boolean/u);
    expect(protocolSource).toMatch(/\{ type: "session\.teamMode"; enabled: boolean; sessionId\?: string \}/u);
    expect(protocolSource).toMatch(/\{ type: "team\.stopAll"; sessionId\?: string \}/u);
    expect(protocolSource).toMatch(/\{ type: "team\.send"; target: string; text: string; sessionId\?: string \}/u);
    expect(protocolSource).toMatch(/\{ type: "team\.interrupt"; name: string; sessionId\?: string \}/u);
    expect(protocolSource).toMatch(/kind\?: "subagent" \| "team"/u);
    expect(protocolSource).toMatch(/toolCallId\?: string/u);
    expect(protocolSource).toMatch(/export interface TeamMessageSummary/u);
    expect(protocolSource).toMatch(/export interface TeamLeadSummary/u);
    expect(protocolSource).toMatch(/lastReport\?: TeamMemberReport/u);
    expect(protocolSource).toMatch(/messages\?: TeamMessageSummary\[\]/u);
  });

  it("activates team tools only when the session team mode is on", () => {
    expect(runtimeSource).toMatch(/record\.teamMode\.enabled \? record\.teamTools\.map/u);
    expect(runtimeSource).toMatch(/"teamMode" \| "teamTools"/u);
    expect(runtimeSource).toMatch(/const teamTools = buildTeamTools\(teamRef\);/u);
    expect(runtimeSource).toMatch(/\.\.\.teamTools\]/u);
  });

  it("creates the per-session runtime after the record and reads/writes the session toggle", () => {
    expect(runtimeSource).toMatch(/teamRef\.runtime = new TeamRuntime\(\{/u);
    expect(runtimeSource).toMatch(/record\.teamRuntime = teamRef\.runtime;/u);
    expect(runtimeSource).toMatch(/readTeamMode\(sessionTeamModePath\(/u);
    expect(runtimeSource).toMatch(/writeTeamMode\(sessionTeamModePath\(/u);
    expect(runtimeSource).toMatch(/inheritTeamMode: activeRuntime\?\.teamMode\.enabled === true/u);
  });

  it("pushes team state through both snapshot channels", () => {
    expect(runtimeSource).toMatch(/teamMode: record\.teamMode\.enabled,/u);
    expect(runtimeSource).toMatch(/\.\.\.\(record\.teamRuntime \? \{ team: record\.teamRuntime\.snapshot\(\) \} : \{\}\)/u);
    expect(runtimeSource).toMatch(/teamMode: pane\?\.teamMode \?\? false,/u);
    expect(runtimeSource).toMatch(/team: pane\?\.team,/u);
    // 激活通道（case "state"）与分屏通道都必须比 teamMode/team；团队快照走内容
    // 比较（IPC 结构化克隆后引用必不相等），两处各一次。
    expect(storeSource).toMatch(/teamSnapshotEqual\(previous\.team, incoming\.team\) &&\s+previous\.sessionId === incoming\.sessionId/u);
    expect(storeSource.match(/teamSnapshotEqual\(previous\.team, incoming\.team\)/gu) ?? []).toHaveLength(2);
    expect(storeSource).toMatch(/export function teamSnapshotEqual/u);
  });

  it("stops members on record disposal, exempts running teams from idle eviction, and cleans files on delete", () => {
    expect(runtimeSource).toMatch(/record\.teamRuntime\?\.dispose\(\);\n  record\.unsubscribe\(\);/u);
    expect(runtimeSource).toMatch(/!record\.teamRuntime\?\.hasRunningMembers\(\)/u);
    expect(runtimeSource).toMatch(/team-mode", `\$\{teamLeadId\}\.json`/u);
    expect(runtimeSource).toMatch(/"delegations", "teams", teamLeadId/u);
  });

  it("handles the commands", () => {
    expect(runtimeSource).toMatch(/case "session\.teamMode": \{\n      setTeamMode\(resolveTargetRecord\(command\.sessionId\), command\.enabled\);/u);
    expect(runtimeSource).toMatch(/case "team\.stopAll": \{/u);
    expect(runtimeSource).toMatch(/record\.teamRuntime\?\.stopAll\(\);/u);
    expect(runtimeSource).toMatch(/case "team\.send": \{/u);
    expect(runtimeSource).toMatch(/case "team\.interrupt": \{/u);
    expect(runtimeSource).toMatch(/command\.kind === "team"/u);
  });

  it("keeps activity frames separate from team_wait and closes steps by toolCallId", () => {
    expect(teamRuntimeSource).toMatch(/private notifyActivity\(\): void/u);
    expect(teamRuntimeSource).toMatch(/event\.toolCallId/u);
    expect(teamRuntimeSource).toMatch(/notifyActivity\(\);/u);
  });

  it("renders the minimal UI and the callout title", () => {
    expect(appSource).toMatch(/data-control="team-toggle"/u);
    expect(appSource).toMatch(/id: "mode\.team"/u);
    expect(paneSource).toMatch(/import \{ TeamStrip \} from "\.\/components\/TeamStrip";/u);
    expect(paneSource).toMatch(/\{ trigger: "\/team"/u);
    expect(paneSource).toMatch(/<TeamStrip snapshot=\{data\.team\} onStopAll=\{stopTeam\} onOpenBoard=/u);
    expect(paneSource).toMatch(/import \{ TeamBoard \} from "\.\/components\/TeamBoard";/u);
    expect(paneSource).toMatch(/<TeamBoard/u);
    expect(stripSource).toMatch(/data-control="team-stop-all"/u);
    expect(stripSource).toMatch(/data-control="team-open-board"/u);
    expect(cssSource).toMatch(/\.team-board \{/u);
    expect(cssSource).toMatch(/\.team-formation-main \{/u);
    expect(cssSource).toMatch(/\.team-rail \{/u);
    expect(boardSource).toMatch(/import \{ TeamFormation \} from "\.\/TeamFormation";/u);
    expect(formationSource).toMatch(/<TeamGraph/u);
    expect(formationSource).toMatch(/TeamMemberDetail/u);
    expect(storeSource).toMatch(/memberActivityEqual/u);
    expect(localeSource).toMatch(/pidesktop-team-message/u);
    expect(cssSource).toMatch(/\.composer\.has-team \{/u);
    expect(cssSource).toMatch(/\.composer-team-strip \{/u);
  });
});
