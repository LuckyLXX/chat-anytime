import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExtensionSummary, ResourceScope } from "../../../shared/protocol.js";
import { ExtensionResourceList } from "./ExtensionResourceList";

const scopeLabels: Record<ResourceScope, string> = {
  global: "全局",
  project: "当前项目",
  package: "扩展包",
  bundled: "内置",
  temporary: "临时",
  unknown: "未知"
};

function extension(overrides: Partial<ExtensionSummary>): ExtensionSummary {
  return {
    id: "extension",
    name: "extension.ts",
    source: "用户资源",
    scope: "global",
    origin: "local",
    trust: "undecided",
    executionMode: "native",
    enabled: false,
    modelVisible: false,
    compatibility: "unknown",
    tools: [],
    commands: [],
    loaded: false,
    ...overrides
  };
}

describe("ExtensionResourceList", () => {
  it("hides PiDesktop internals and presents pi-subagents as a user action", () => {
    const markup = renderToStaticMarkup(
      <ExtensionResourceList
        extensions={[
          extension({ id: "builtin", name: "chat-anytime-permissions", source: "PiDesktop", scope: "bundled", origin: "bundled", trust: "trusted", enabled: true, loaded: true }),
          extension({ id: "subagents", name: "pi-subagents", source: "npm:pi-subagents", scope: "package", origin: "package" })
        ]}
        scopeLabels={scopeLabels}
        onApprove={() => undefined}
      />
    );

    expect(markup).toContain("子代理（pi-subagents）");
    expect(markup).toContain("启用子代理");
    expect(markup).not.toContain("chat-anytime-permissions");
    expect(markup).not.toContain("原生运行");
  });
});
