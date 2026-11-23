import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Codex 接入的接线契约：这些点漏一条就是「单测全绿、真机静默失败」——
 * 进程没人拉起/没人回收、utility 消息被排进命令队列、团队工具没有 backend 参数、
 * 设置关着却仍然能派活。用源码断言钉住，改结构时测试会红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n?/g, "\n");

const protocolSource = read("../shared/protocol.ts");
const mainSource = read("index.ts");
const runtimeSource = read("pi-runtime.ts");
const teamRuntimeSource = read("team-runtime.ts");
const teamContractSource = read("team-contract.ts");
const teamStoreSource = read("team-store.ts");
const runtimeTeamSource = read("runtime-team.ts");
const processSource = read("codex-process.ts");
const appServerSource = read("codex-app-server.ts");
const processClientSource = read("codex-process-client.ts");
const childSource = read("codex-team-child.ts");
const runtimeCodexSource = read("runtime-codex.ts");

describe("codex wiring", () => {
  it("declares a restricted process bridge in the shared protocol", () => {
    // utility → main 的请求（RuntimeMessage）与 main → utility 的回执/事件（RuntimeCommand）。
    expect(protocolSource).toMatch(/\| \{ type: "codex\.process\.start"; requestId: string; handle: string; options: CodexProcessStartOptions \}/u);
    expect(protocolSource).toMatch(/\| \{ type: "codex\.process\.write"; handle: string; data: string \}/u);
    expect(protocolSource).toMatch(/\| \{ type: "codex\.process\.stop"; handle: string; reason\?: string \}/u);
    expect(protocolSource).toMatch(/\| \{ type: "codex\.process\.start-result"; requestId: string; ok: true; pid\?: number \}/u);
    expect(protocolSource).toMatch(/\| \{ type: "codex\.process\.event"; handle: string; event: CodexProcessEvent \}/u);
    expect(protocolSource).toMatch(/export type CodexProcessEvent =/u);
    expect(protocolSource).toMatch(/export interface CodexProcessStartOptions/u);
    // 看板要能标出运行来源。
    expect(protocolSource).toMatch(/backend\?: "codex"/u);
  });

  it("supervises the process tree in main (spawn, stdio relay, reclaim on utility exit and app quit)", () => {
    expect(mainSource).toMatch(/import \{ CodexProcessSupervisor \} from "\.\/codex-process\.js";/u);
    expect(mainSource).toMatch(/let codexSupervisor: CodexProcessSupervisor \| undefined;/u);
    expect(mainSource).toMatch(/codexSupervisor = new CodexProcessSupervisor\(\{/u);
    expect(mainSource).toMatch(/if \(message\.type === "codex\.process\.start"\)/u);
    expect(mainSource).toMatch(/codexSupervisor\?\.write\(message\.handle, message\.data\);/u);
    expect(mainSource).toMatch(/codexSupervisor\?\.stop\(message\.handle, message\.reason\);/u);
    // utility 退出与用户退出各兜一次（不留孤儿进程）。
    expect(mainSource.match(/codexSupervisor\?\.shutdown\(\);/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps utility-side semantics off the serial command queue", () => {
    expect(runtimeSource).toMatch(/const codexBridge = new CodexProcessBridge\(\{ post \}\);/u);
    expect(runtimeSource).toMatch(/if \(codexBridge\.handleMessage\(event\.data\)\) return;/u);
    expect(runtimeSource).toMatch(/codexBridge\.shutdown\(\);/u);
    expect(runtimeSource).toMatch(/codex: new CodexTeamBackend\(\{/u);
    expect(runtimeSource).toMatch(/readConfig: readCodexCliConfig,/u);
    expect(runtimeSource).toMatch(/startProcess: \(options\) => codexBridge\.start\(options\),/u);
    expect(runtimeSource).toMatch(/backends: \(\) => get\(\)\.backends\(\),/u);
  });

  it("only accepts Codex executables and whitelisted arguments, never a shell", () => {
    expect(processSource).toMatch(/export function validateCodexArgs/u);
    expect(processSource).toMatch(/if \(head !== "app-server"\) throw new Error\("只允许启动 Codex 的 app-server/u);
    expect(processSource).toMatch(/export function validateCodexExecutable/u);
    expect(processSource).toMatch(/if \(base !== "codex"\) throw new Error/u);
    expect(protocolSource).toMatch(/\| \{ kind: "exit"; code: number \| null; signal\?: string; error\?: string \}/u);
    expect(processSource).toMatch(/export function resolveCodexLaunch/u);
    // 不经过任何 shell：直接 spawn 文件 + argv（Windows 的 .cmd 也解析成 node 入口）。
    expect(processSource).toMatch(/spawn\(launch\.file, launch\.args, \{/u);
    expect(processSource).not.toMatch(/shell:\s*true/u);
    expect(processSource).toMatch(/stdio: \["pipe", "pipe", "pipe"\]/u);
    // 一次性结算与进程树回收。
    expect(processSource).toMatch(/private settle\(entry: ProcessEntry/u);
    expect(processSource).toMatch(/this\.killTree\(pid\)/u);
  });

  it("parses JSONL defensively and denies server requests by default", () => {
    expect(appServerSource).toMatch(/export const CODEX_MAX_FRAME_CHARS/u);
    expect(appServerSource).toMatch(/private discardingOversizedFrame = false;/u);
    expect(appServerSource).toMatch(/bufferedNotifications/u);
    expect(appServerSource).toMatch(/refreshToken: false/u);
    expect(appServerSource).toMatch(/export function defaultServerRequestDecision/u);
    expect(appServerSource).toMatch(/PiDesktop 尚未接入 Codex 审批/u);
    // 服务端请求处理器挂在客户端的构造参数上（child 层的同名 option 从未接线，已删除）。
    expect(runtimeCodexSource).toMatch(/this\.options\.handleServerRequest/u);
  });

  it("routes team members by backend and preflights before occupying the name", () => {
    expect(teamContractSource).toMatch(/backend\?: "codex"/u);
    expect(teamContractSource).toMatch(/backends\(\): TeamBackendView\[\];/u);
    expect(teamRuntimeSource).toMatch(/backendOfMemberConfig/mu);
    expect(teamRuntimeSource).toMatch(/private codexConfigFor\(name: string, subagentKey: string \| undefined\): TeamMemberConfig/u);
    expect(teamRuntimeSource).toMatch(/created = await this\.createChildFor\(reservation\.member, reservation\.manager, signal\);/u);
    expect(teamRuntimeSource).toMatch(/const created = await this\.createChildFor\(member\.record, manager, signal\);/u);
    // 预检必须在 replaceMember（占用名字）之前。
    const prepare = teamRuntimeSource.slice(teamRuntimeSource.indexOf("private prepareSpawn("), teamRuntimeSource.indexOf("private settleSpawn("));
    expect(prepare.indexOf("this.codexConfigFor(")).toBeGreaterThan(-1);
    expect(prepare.indexOf("this.codexConfigFor(")).toBeLessThan(prepare.indexOf("this.replaceMember(member);"));
    // 窄失败契约接进 attach（Codex 的 failed 不能被记成 completed）。
    expect(teamRuntimeSource).toMatch(/if \(event\.type === "pidesktop_run_failed"\) \{/u);
    expect(teamRuntimeSource).toMatch(/type TeamChildEvent = AgentSessionEvent \| TeamChildRunFailedEvent;/u);
  });

  it("persists the Codex thread binding atomically next to the member transcript", () => {
    expect(teamStoreSource).toMatch(/export function codexThreadBindingPath\(memberDir: string, memberId: string\): string/u);
    expect(teamStoreSource).toMatch(/export function readCodexThreadBinding/u);
    expect(teamStoreSource).toMatch(/export function writeCodexThreadBinding/u);
    expect(teamStoreSource).toMatch(/renameSync\(temporary, path\);/u);
    // 绑定必须校验成员与工作区（不能把两个项目的线程混用）。
    expect(teamStoreSource).toMatch(/parsed\.memberId !== expected\.memberId \|\| parsed\.workspace !== expected\.workspace/u);
    // 旧 Pi 记录没有 mode/codex 时照旧按 Pi 读。
    expect(teamStoreSource).toMatch(/return config\.mode === "codex" \? "codex" : "pi";/u);
  });

  it("exposes the backend on the Lead tool surface within the schema budget", () => {
    expect(runtimeTeamSource).toMatch(/backend: Type\.Optional\(Type\.Literal\("codex"/u);
    expect(runtimeTeamSource).toMatch(/\.\.\.\(args\.backend === undefined \? \{\} : \{ backend: args\.backend \}\)/u);
    expect(runtimeTeamSource).toMatch(/const backends = service\.backends\(\);/u);
  });

  it("wires the per-turn permission policy (C) — sandbox capability gate, live lead mode, round approval", () => {
    // 沙箱能力拿不到就拒绝写入（不再靠「策略没接入」这句临时判定）。
    expect(runtimeCodexSource).toMatch(/if \(access === "workspace-write"\) \{/u);
    expect(runtimeCodexSource).toMatch(/defaultCodexSandboxCapability/u);
    expect(runtimeCodexSource).toMatch(/成员「\$\{request\.memberName\}」需要「当前工作区可写」/u);
    expect(runtimeCodexSource).toMatch(/export function normalizeCodexCliConfig/u);
    expect(runtimeCodexSource).toMatch(/export async function probeCodexConnection/u);
    // 逐轮实时读 Lead 模式 + ask 的逐轮确认（一张卡一轮）。
    expect(runtimeCodexSource).toMatch(/leadMode: this\.options\.leadAccessMode\?\.\(\) \?\? "ask"/u);
    expect(runtimeCodexSource).toMatch(/requiresRoundApproval/u);
    expect(runtimeCodexSource).toMatch(/本轮没有获得工作区写入授权/u);
    // 配置加固是默认参数（不是可选项，漏传就漏关）。
    expect(runtimeCodexSource).toMatch(/\?\? buildCodexLaunchArgs\(\)/u);
    expect(runtimeCodexSource).not.toMatch(/args: \["app-server"\]/u);
    // 服务端请求缺省走方法对应拒绝。
    expect(runtimeCodexSource).toMatch(/decideCodexServerRequest\(serverRequest, \{ workspace: request\.workspace \}\)/u);
    // 连接测试只握手 + account/read，不建线程。
    expect(runtimeCodexSource).not.toMatch(/probeCodexConnection[\s\S]{0,2000}thread\/start/u);
  });

  it("enforces the boundary at the last moment (resolved policy must match the frozen cap)", () => {
    // 策略层导入：逐轮裁决 + 运行时隔离闸门（Windows readiness / 生效配置）同源。
    expect(childSource).toMatch(/import \{[\s\S]*?assertCodexTurnPolicy,[\s\S]*?\} from "\.\/codex-policy\.js";/u);
    expect(childSource).toMatch(/inspectCodexEffectiveConfig/u);
    expect(childSource).toMatch(/decideCodexWindowsSandboxReadiness/u);
    expect(childSource).toMatch(/assertCodexTurnPolicy\(policy, \{ access, workspace: this\.options\.workspace \}\)/u);
    expect(childSource).toMatch(/本轮不能以工作区写入执行/u);
    // 线程**永远**只读 + never；写入只经每轮的显式 sandboxPolicy。
    expect(childSource).toMatch(/sandbox: "read-only" as const/u);
    expect(childSource).toMatch(/approvalPolicy: "never" as const/u);
  });

  it("cancels running Codex turns when the settings disable it or tighten permissions", () => {
    expect(runtimeSource).toMatch(/leadAccessMode: \(\) => \(record\.permissionDeps \? record\.permissionDeps\.accessMode\(\) : accessMode\)/u);
    // 一轮一张卡：toolName 带逐轮序号，broker 的 allow-session 缓存命中不到下一轮。
    expect(runtimeSource).toMatch(/codexApprovalSeq \+= 1;/u);
    expect(runtimeSource).toMatch(/const toolName = `codex_round_\$\{codexApprovalSeq\}`;/u);
    expect(runtimeSource).toMatch(/accessMode: "ask",/u);
    expect(runtimeSource).toMatch(/timeoutMs: TEAM_PERMISSION_TIMEOUT_MS/u);
    // 审批登记/收场必须用 broker 的真实请求 id（与 settlement.id 同键），否则团队面板会留一张永不清的卡。
    expect(runtimeSource).toMatch(/onPending: \(id\) => \{/u);
    expect(runtimeSource).toMatch(/noteCodexApprovalPending\(input\.memberId, notice, id\)/u);
    expect(runtimeSource).toMatch(/noteCodexApprovalSettled\(input\.memberId, id\)/u);
    // 关闭接入 / 收紧访问上限 / 全局模式收紧为只读，都要停掉正在跑的 Codex 回合。
    expect(runtimeSource.match(/stopCodexMembers\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(teamRuntimeSource).toMatch(/stopCodexMembers\(reason: string\): number/u);
    expect(teamRuntimeSource).toMatch(/backendOfMemberConfig\(member\.record\.config\) !== "codex"/u);
  });

  it("bridges handle lifecycles with per-handle isolation", () => {
    expect(processClientSource).toMatch(/export class CodexProcessBridge/u);
    expect(processClientSource).toMatch(/if \(!live\) return true; \/\/ 已回收句柄的迟到事件/u);
    expect(processClientSource).toMatch(/this\.handles\.delete\(live\.handle\);/u);
    expect(processClientSource).toMatch(/live\.buffer\.push\(event\);/u);
  });
});
