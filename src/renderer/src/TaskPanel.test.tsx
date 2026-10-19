// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Todo } from "../../shared/protocol";
import { TaskPanelContent } from "./TaskPanel";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useDesktopStore.setState({ todos: [] });
});

async function render(todos: Todo[]): Promise<string> {
  useDesktopStore.setState({ todos });
  await act(async () => {
    root.render(<TaskPanelContent />);
  });
  return container.textContent ?? "";
}

describe("TaskPanel verification states", () => {
  it("shows the verify command and the pending state before any run", async () => {
    const text = await render([{ content: "跑测试", status: "in_progress", verify: "npm test" }]);

    expect(text).toContain("跑测试");
    expect(text).toContain("npm test");
    expect(text).toContain("待验收");
    expect(text).not.toContain("验收通过");
  });

  it("shows a passed verification", async () => {
    const text = await render([
      { content: "跑测试", status: "completed", verify: "npm test", verifiedAt: 1_700_000_000_000, verifyOk: true }
    ]);

    expect(text).toContain("验收通过");
    expect(text).not.toContain("待验收");
  });

  it("shows a failed verification while the item is back in progress", async () => {
    const text = await render([
      { content: "跑测试", status: "in_progress", verify: "npm run build", verifiedAt: 1_700_000_000_000, verifyOk: false }
    ]);

    expect(text).toContain("验收失败");
    expect(text).toContain("进行中");
    expect(text).toContain("npm run build");
  });

  it("renders no verification row for items without verify", async () => {
    const text = await render([{ content: "读代码", status: "completed" }]);

    expect(text).toContain("读代码");
    expect(text).not.toContain("验收");
  });
});
