import { describe, expect, it } from "vitest";
import { SessionNewClaims, sessionNewResolution } from "./session-new-claims.js";

describe("带回执的新话题请求", () => {
  it("会话已激活后取消是迟到请求，必须如实返回已创建", () => {
    expect(sessionNewResolution(true, true)).toBe("created");
    expect(sessionNewResolution(false, true)).toBe("cancelled");
    expect(sessionNewResolution(false, false)).toBe("failed");
  });
  it("取消旧请求不会取消随后注册的请求", () => {
    const claims = new SessionNewClaims();
    const first = claims.register("first");
    const second = claims.register("second");
    claims.cancel("first");
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    claims.finish("first", first);
    expect(claims.get("first")).toBeUndefined();
    expect(claims.get("second")).toBe(second);
  });

  it("迟到的完成通知不能移除同一 id 的新请求", () => {
    const claims = new SessionNewClaims();
    const old = claims.register("id");
    const next = claims.register("id");
    claims.finish("id", old);
    claims.cancel("id");
    expect(old.cancelled).toBe(false);
    expect(next.cancelled).toBe(true);
    claims.finish("id", next);
    expect(claims.get("id")).toBeUndefined();
  });
});
