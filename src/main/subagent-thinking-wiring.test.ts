import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「子智能体思考等级」的接线契约（源码断言型测试，2026-10-09）。
 *
 * 为什么必须是源码断言：这条链路的三个环节都跑不进 vitest（pi-runtime.ts 要
 * Electron + utility 宿主、SubagentSettings.tsx 要整套 store 假件、真实委派要起
 * 一个子 AgentSession），而**每一处漏接都是静默失效**：
 *  1. `handleCommand` 是个穷举 switch 且**没有 default 分支**——协议里加了命令、
 *     渲染端照发，utility 侧没写 case 就是「点了没反应、不报错、不落盘」；
 *  2. 运行时不读定义上的档位，则设置页保存成功但子代理永远跑父会话档位；
 *  3. 委派卡片要的是**子会话自己的**档位（模型能力钳制后的实际生效值），写回
 *     请求值就会在面板上撒谎（设了 max、子模型只到 high 时显示 max）。
 * 同先例：panel-wiring.test.ts、settings-save-contract.test.ts。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const runtime = read("pi-runtime.ts");
const subagent = read("subagent.ts");
const panel = read("../renderer/src/SubagentSettings.tsx");
const demo = read("../renderer/src/demo-api.ts");
const conversation = read("../renderer/src/ConversationPane.tsx");
const transcript = read("../renderer/src/components/DelegationTranscript.tsx");

describe("子智能体思考等级的接线", () => {
  it("utility 侧有 subagent.thinking 的 case，并原样透传档位（含 undefined = 清空）", () => {
    expect(runtime).toContain('case "subagent.thinking":');
    expect(runtime).toMatch(/case "subagent\.thinking":[\s\S]{0,600}?saveSubagentThinkingOverride\(getAgentDir\(\), command\.id, command\.thinkingLevel\)/u);
    // 与 subagent.model 对称：两个旋钮都不重建会话（覆盖表在执行时经目录实读）。
    expect(runtime).toContain("saveSubagentThinkingOverride");
  });

  it("子会话真的套用定义上的档位，缺省才继承主会话", () => {
    expect(subagent).toContain("subagentDef.thinkingLevel ?? ctx.thinkingLevel");
    expect(subagent).toMatch(/const requestedThinking = subagentDef\.thinkingLevel \?\? ctx\.thinkingLevel;/u);
    expect(subagent).toMatch(/thinkingLevel: requestedThinking/u);
    // 旧写法（无条件继承）必须消失，否则上面那行只是死代码。
    expect(subagent).not.toMatch(/thinkingLevel: ctx\.thinkingLevel/u);
  });

  it("委派进度回报子会话自身（钳制后）的档位，而不是请求值", () => {
    expect(subagent).toMatch(/thinkingLevel: child\.thinkingLevel/u);
  });

  it("渲染端发得出、演示环境接得住、卡片与完整记录都显示得出来", () => {
    expect(panel).toContain('type: "subagent.thinking"');
    expect(panel).toContain("subagent.thinkingLevel");
    expect(demo).toContain('case "subagent.thinking":');
    expect(conversation).toContain("delegation.thinkingLevel");
    expect(transcript).toContain("delegation.thinkingLevel");
  });
});
