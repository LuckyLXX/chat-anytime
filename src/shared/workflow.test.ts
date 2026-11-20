import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_ATTEMPTS,
  createWorkflowDraft,
  collectTemplateReferences,
  normalizeWorkflowDraft,
  parseGateDecision,
  renderWorkflowTemplate,
  stableTopologicalOrder,
  validateWorkflowForRun,
  type WorkflowDefinition,
  type WorkflowNode
} from "./workflow.js";

function node(id: string, kind: WorkflowNode["kind"] = "task", prompt = id): WorkflowNode {
  return {
    id,
    title: id,
    kind,
    prompt,
    position: { x: 0, y: 0 },
    exec: { kind: "agent" }
  };
}

function definition(nodes: WorkflowNode[], edges: Array<[string, string]>, rework?: WorkflowDefinition["rework"]): WorkflowDefinition {
  return {
    version: 1,
    id: "wf-test",
    name: "测试工作流",
    nodes,
    edges: edges.map(([from, to], index) => ({ id: `e${index + 1}`, from, to })),
    ...(rework ? { rework } : {}),
    revision: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

describe("workflow drafts", () => {
  it("allows an incomplete empty draft but rejects it for running", () => {
    const draft = createWorkflowDraft(10, "wf-empty");
    expect(normalizeWorkflowDraft(draft).ok).toBe(true);
    const result = validateWorkflowForRun(draft);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "entry-count")).toBe(true);
  });

  it("keeps prompt whitespace and normalizes only structural data", () => {
    const input = {
      ...createWorkflowDraft(10, "wf-spacing"),
      name: "有缩进",
      nodes: [node("n1", "task", "  first line\n  second line  ")],
      edges: []
    };
    const result = normalizeWorkflowDraft(input);
    expect(result.ok).toBe(true);
    expect(result.definition?.nodes[0]?.prompt).toBe("  first line\n  second line  ");
  });

  it("rejects legacy loop edges instead of silently changing their meaning", () => {
    const value = definition([node("a"), node("out", "output")], [["a", "out"]]);
    const legacy = { ...value, edges: [{ ...value.edges[0], kind: "loop" }] };
    expect(normalizeWorkflowDraft(legacy).errors.some((error) => error.code === "unsupported-edge-kind")).toBe(true);
  });

  it("allows an unfinished rework selection in a saved draft but not at run time", () => {
    const value = { ...createWorkflowDraft(), rework: { entryNodeId: "", gateNodeId: "", maxAttempts: 3 } };
    expect(normalizeWorkflowDraft(value).ok).toBe(true);
    expect(validateWorkflowForRun(value).ok).toBe(false);
  });

  it("rejects malformed permission caps rather than reading inherited object properties", () => {
    const value = { ...createWorkflowDraft(), nodes: [{ ...node("n"), exec: { kind: "agent", accessModeCap: "toString" } }] };
    expect(normalizeWorkflowDraft(value).errors.some((error) => error.code === "invalid-access-cap")).toBe(true);
  });

  it("keeps explicit layout in normalization and preserves the missing legacy field", () => {
    const old = definition([node("n1", "output")], []);
    expect(normalizeWorkflowDraft(old).definition).not.toHaveProperty("layout");
    expect(normalizeWorkflowDraft({ ...old, layout: "auto" }).definition?.layout).toBe("auto");
    expect(normalizeWorkflowDraft({ ...old, layout: "manual" }).definition?.layout).toBe("manual");
    expect(normalizeWorkflowDraft({ ...old, layout: "fixed" }).errors.map((issue) => issue.code)).toContain("invalid-layout");
  });

  it("keeps semantic order stable when only positions change", () => {
    const before = definition([node("a"), node("b", "output"), node("c")], [["a", "b"], ["a", "c"]]);
    const after = { ...before, nodes: before.nodes.map((item, index) => ({ ...item, position: { x: index * 100, y: index * -50 } })) };
    expect(stableTopologicalOrder(before)).toEqual(stableTopologicalOrder(after));
  });
});

describe("workflow graph validation", () => {
  it("rejects cycles, self edges, duplicate edges, and disconnected nodes", () => {
    const cycle = definition([node("a"), node("b", "output")], [["a", "b"], ["b", "a"]]);
    expect(validateWorkflowForRun(cycle).errors.some((error) => error.code === "cycle")).toBe(true);

    const disconnected = definition([node("a"), node("b", "output"), node("c")], [["a", "b"], ["a", "b"]]);
    const result = validateWorkflowForRun(disconnected);
    expect(result.errors.some((error) => error.code === "duplicate-edge")).toBe(true);
    expect(result.errors.some((error) => error.code === "unreachable-node")).toBe(true);
  });

  it("accepts a true ancestor reference and rejects a parallel branch reference", () => {
    const ancestor = definition([node("a"), node("b", "output", "Use {{a}}")], [["a", "b"]]);
    expect(validateWorkflowForRun(ancestor).ok).toBe(true);

    const parallel = definition([
      node("start"),
      node("a"),
      node("b"),
      node("c", "task", "Use {{b}}"),
      node("out", "output")
    ], [["start", "a"], ["start", "b"], ["a", "c"], ["c", "out"], ["b", "out"]]);
    const result = validateWorkflowForRun(parallel);
    expect(result.errors.some((error) => error.code === "non-ancestor-template-reference")).toBe(true);
  });

  it("compiles prefix, rework region, and suffix without adding a loop edge", () => {
    const workflow = definition(
      [node("plan"), node("implement"), node("review", "review"), node("gate", "gate"), node("result", "output")],
      [["plan", "implement"], ["implement", "review"], ["review", "gate"], ["gate", "result"]],
      { entryNodeId: "implement", gateNodeId: "gate", maxAttempts: 3 }
    );
    const result = validateWorkflowForRun(workflow);
    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({ prefixNodeIds: ["plan"], regionNodeIds: ["implement", "review", "gate"], suffixNodeIds: ["result"] });
    expect(result.plan?.rework?.maxAttempts).toBe(3);
  });

  it("rejects a gate that cannot be reached from the configured rework entry", () => {
    const workflow = definition(
      [node("start"), node("entry"), node("gate", "gate"), node("result", "output")],
      [["start", "entry"], ["start", "gate"], ["entry", "result"], ["gate", "result"]],
      { entryNodeId: "entry", gateNodeId: "gate", maxAttempts: 3 }
    );
    const result = validateWorkflowForRun(workflow);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "rework-disconnected")).toBe(true);
  });

  it("rejects a rework bypass and multiple gates", () => {
    const workflow = definition(
      [node("plan"), node("implement"), node("gate", "gate"), node("gate2", "gate"), node("result", "output")],
      [["plan", "implement"], ["implement", "gate"], ["gate", "result"], ["plan", "result"], ["gate", "gate2"]],
      { entryNodeId: "implement", gateNodeId: "gate", maxAttempts: DEFAULT_WORKFLOW_ATTEMPTS }
    );
    const result = validateWorkflowForRun(workflow);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "gate-count")).toBe(true);
    expect(result.errors.some((error) => error.code === "rework-bypass")).toBe(true);
  });
});

describe("workflow templates and gate decisions", () => {
  it("collects and renders bounded template values", () => {
    expect(collectTemplateReferences("{{input}}/{{attempt}}/{{retry_feedback}}/{{n3}}"))
      .toMatchObject([{ kind: "input" }, { kind: "attempt" }, { kind: "retry_feedback" }, { kind: "node", nodeId: "n3" }]);
    expect(renderWorkflowTemplate("{{input}} #{{attempt}} {{n3}}", { input: "task", attempt: 2, nodes: { n3: "artifact" } }))
      .toBe("task #2 artifact");
  });

  it("accepts strict JSON and exactly one complete json fence", () => {
    expect(parseGateDecision('{"verdict":"pass","reason":"done"}')).toEqual({ ok: true, decision: { verdict: "pass", reason: "done" } });
    expect(parseGateDecision("```json\n{\"verdict\":\"retry\",\"reason\":\"fix\"}\n```")).toEqual({ ok: true, decision: { verdict: "retry", reason: "fix" } });
    expect(parseGateDecision("done {\"verdict\":\"pass\",\"reason\":\"x\"}").ok).toBe(false);
    expect(parseGateDecision('{"verdict":"PASS","reason":"x"}').ok).toBe(false);
    expect(parseGateDecision("").ok).toBe(false);
  });
});
