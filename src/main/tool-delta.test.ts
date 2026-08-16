import { describe, expect, it } from "vitest";
import { diffToolNames } from "./tool-delta.js";

describe("diffToolNames", () => {
  it("reports additions and removals, preserving input order", () => {
    expect(diffToolNames(["a", "b"], ["b", "c", "d"])).toEqual({ added: ["c", "d"], removed: ["a"] });
  });

  it("returns empty delta for identical sets regardless of order", () => {
    expect(diffToolNames(["x", "y"], ["y", "x"])).toEqual({ added: [], removed: [] });
  });

  it("handles full replacement in both directions", () => {
    expect(diffToolNames([], ["mcp__s__t"])).toEqual({ added: ["mcp__s__t"], removed: [] });
    expect(diffToolNames(["mcp__s__t"], [])).toEqual({ added: [], removed: ["mcp__s__t"] });
  });
});
