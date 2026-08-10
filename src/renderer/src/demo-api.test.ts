import { describe, expect, it } from "vitest";
import { createDemoApi } from "./demo-api";

describe("demo session commands", () => {
  it("creates a new session in the requested workspace", async () => {
    const api = createDemoApi();

    await api.send({ type: "session.new", workspace: "D:\\Projects\\PiDesktop" });

    const bootstrap = await api.bootstrap();
    expect(bootstrap.runtime).toBeDefined();
    expect(bootstrap.runtime?.workspace).toBe("D:\\Projects\\PiDesktop");
    expect(bootstrap.runtime?.sessionId).toBe("new-demo-session");
    expect(bootstrap.runtime?.messages).toEqual([]);
  });
});
