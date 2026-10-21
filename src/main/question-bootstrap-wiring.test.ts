import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 待决提问的渲染端重载恢复契约（2026-10-21 计划审查卡死事故）。
 *
 * 事故链：`exit_plan_mode` 提交后，开发态 Vite HMR 因另一个会话修改
 * `store.ts` 重载渲染端 → React 内存里的 questions 被清空 → 面板消失 →
 * QuestionBroker 永远等不到答案 → 工具挂起、停止按钮无效。
 *
 * 修复的接线点都在依赖 Electron/大组件的文件里，单测环境跑不起来，
 * 这里沿用 browser-tabs-bootstrap-wiring 的源断言方式钉住关键三处。
 */
describe("pending questions bootstrap wiring contract", () => {
  const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(new RegExp("\r\n", "gu"), "\n");
  const mainIndex = read("index.ts");
  const store = read("../renderer/src/store.ts");
  const protocol = read("../shared/protocol.ts");

  it("协议 bootstrap 携带待决提问镜像", () => {
    const block = protocol.slice(protocol.indexOf("export interface DesktopBootstrap"));
    expect(block.slice(0, block.indexOf("export interface DesktopApi"))).toContain("questions?: QuestionRequest[]");
  });

  it("主进程镜像 question / question.dismiss，并在 bootstrap 回传", () => {
    expect(mainIndex).toContain("const pendingQuestions = new PendingQuestionMirror()");
    expect(mainIndex).toContain('if (message.type === "question") pendingQuestions.record(message.request)');
    expect(mainIndex).toContain('if (message.type === "question.dismiss") pendingQuestions.dismiss(message.id)');
    expect(mainIndex).toContain("questions: pendingQuestions.list()");
  });

  it("渲染端 initialize 用 bootstrap.questions 与运行期请求按 id 合并", () => {
    const block = store.slice(store.indexOf("async initialize()"));
    expect(block).toContain("questions: mergeQuestionRequests(bootstrap.questions ?? [], get().questions)");
  });

  it("utility 退出时清空镜像，避免把已随进程消失的提问恢复出来", () => {
    const block = mainIndex.slice(mainIndex.indexOf('runtimeProcess.on("exit"'));
    expect(block).toContain("pendingQuestions.clear()");
  });
});
