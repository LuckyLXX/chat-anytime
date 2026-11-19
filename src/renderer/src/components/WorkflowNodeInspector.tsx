import { AlertTriangle, FileCode2, LoaderCircle, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { AccessMode, BuiltinToolName, ModelOption, ProviderOption, SubagentDefinition, ThinkingLevel } from "../../../shared/protocol";
import { thinkingLevelLabels, toolLabel } from "../../../shared/locale";
import {
  DEFAULT_WORKFLOW_ATTEMPTS,
  MAX_WORKFLOW_ATTEMPTS,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_WORKFLOW_NODE_TITLE_LENGTH,
  MAX_WORKFLOW_PROMPT_LENGTH,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowExecution,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRework
} from "../../../shared/workflow";
import { selectableCatalogModels } from "../lib/model-list";
import {
  WORKFLOW_ACCESS_MODE_LABELS,
  WORKFLOW_ACCESS_MODE_ORDER,
  WORKFLOW_EXECUTION_STATUS_LABELS,
  WORKFLOW_NODE_KIND_LABELS,
  attemptText,
  clampText,
  executionsForNode,
  workflowIssueText
} from "../lib/workflow-canvas";
import { ModelSelect } from "./ModelSelect";

const BUILTIN_TOOL_ORDER: BuiltinToolName[] = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 节点产物预览（中心页按需拉取后传进来；组件只负责有界展示）。 */
export interface WorkflowArtifactView {
  executionId: string;
  loading?: boolean;
  text?: string;
  error?: string;
  truncated?: boolean;
}

export interface WorkflowNodeInspectorProps {
  definition: WorkflowDefinition;
  /** 选中的节点；未选中时检查器停在「工作流」页。 */
  nodeId?: string;
  models: ModelOption[];
  providers: ProviderOption[];
  subagents: SubagentDefinition[];
  /** 本地校验 + 服务端回读的运行问题（同一形状）。 */
  issues: readonly WorkflowDiagnostic[];
  planExecutions?: number;
  readOnly?: boolean;
  /** 当前运行里这个节点的历史执行（按轮号排序）。 */
  executions?: readonly WorkflowExecution[];
  selectedExecutionId?: string;
  artifact?: WorkflowArtifactView;
  /** 本次运行冻结解析出来的「实际生效模型」（停用回落之后真正用的那个）。 */
  resolvedModel?: { provider: string; id: string };
  onChangeNode(patch: Partial<Omit<WorkflowNode, "id">>): void;
  onChangeDefinition(patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "whenToUse" | "inputHint">>): void;
  onChangeRework(rework: WorkflowRework | undefined): void;
  onDeleteNode(): void;
  /** 回到工作流设置（取消节点选中）。 */
  onDeselectNode?(): void;
  onSelectExecution?(executionId: string): void;
  onOpenRunDetails?(): void;
}

/**
 * 右侧检查器：节点属性（来源 / prompt / 模型 / 工具白名单 / 访问上限）+ 返工结构。
 *
 * 口径与方案 §9 对齐：
 * - 模型选择**统一复用 `ModelSelect`**（同目录分组、已停用值有兜底 option），
 *   不另造下拉；节点没写模型时明确写「跟随来源」，运行时预检会把实际值展示出来。
 * - 工具白名单只能从**来源工具集**里收窄（agent 来源 = 角色已启用工具；子智能体
 *   来源 = 该定义的 tools 表），不会因为没写 tools 就凭空启用 write/edit。
 * - 访问上限只收紧不提权，文案直说「跟随 owner」。
 * - 返工区间是结构字段（entry / gate / maxAttempts），不是画布上的连线。
 * - 历史轮次按 `attempt` 列出，产物预览有界（>8KiB 由后端给文件引用）。
 */
export function WorkflowNodeInspector(props: WorkflowNodeInspectorProps): ReactNode {
  const { definition, nodeId, models, providers, subagents, issues, readOnly = false } = props;
  const node = nodeId ? definition.nodes.find((item) => item.id === nodeId) : undefined;
  const nodeIssues = nodeId ? issues.filter((issue) => issue.nodeId === nodeId) : [];
  const generalIssues = issues.filter((issue) => !issue.nodeId && !issue.edgeId);
  const selectableModels = useMemo(() => selectableCatalogModels(models).filter((model) => model.configured), [models]);
  const executions = node ? props.executions ?? [] : [];
  const nodeExecutions = useMemo(() => executionsForNode(executions, node?.id ?? ""), [executions, node?.id]);
  const selectedExecution = nodeExecutions.find((execution) => execution.executionId === props.selectedExecutionId) ?? nodeExecutions.at(-1);
  const gateNodes = definition.nodes.filter((item) => item.kind === "gate");
  const rework = definition.rework;
  const sourceTools = useMemo(() => node ? sourceToolSet(node, subagents) : BUILTIN_TOOL_ORDER, [node, subagents]);

  return (
    <aside className="workflow-inspector" data-pane="workflow-inspector">
      <div className="workflow-inspector-tabs">
        {node ? (
          <>
            <span className="workflow-inspector-tab active" role="tab" aria-selected="true">节点：{node.title || "未命名"}</span>
            {props.onDeselectNode && (
              <button type="button" className="workflow-inspector-tab-link" data-control="workflow-inspector-workflow-tab" onClick={props.onDeselectNode}>
                工作流设置
              </button>
            )}
          </>
        ) : (
          <span className="workflow-inspector-tab active" role="tab" aria-selected="true">工作流设置</span>
        )}
      </div>

      <div className="workflow-inspector-body">
        {node ? (
          <>
            {nodeIssues.length > 0 && (
              <ul className="workflow-inspector-issues" aria-label="该节点的运行问题">
                {nodeIssues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}><AlertTriangle size={11} />{workflowIssueText(issue)}</li>
                ))}
              </ul>
            )}

            <label className="workflow-field">
              <span>标题（≤{MAX_WORKFLOW_NODE_TITLE_LENGTH} 字）</span>
              <input
                value={node.title}
                maxLength={MAX_WORKFLOW_NODE_TITLE_LENGTH}
                disabled={readOnly}
                aria-label="节点标题"
                onChange={(event) => props.onChangeNode({ title: clampText(event.target.value, MAX_WORKFLOW_NODE_TITLE_LENGTH) })}
              />
            </label>
            <div className="workflow-field-row">
              <label className="workflow-field">
                <span>类型</span>
                <select
                  value={node.kind}
                  data-control="workflow-node-kind"
                  disabled={readOnly}
                  aria-label="节点类型"
                  onChange={(event) => props.onChangeNode({ kind: event.target.value as WorkflowNodeKind })}
                >
                  {(Object.keys(WORKFLOW_NODE_KIND_LABELS) as WorkflowNodeKind[]).map((kind) => (
                    <option key={kind} value={kind}>{WORKFLOW_NODE_KIND_LABELS[kind]}</option>
                  ))}
                </select>
              </label>
              <label className="workflow-field">
                <span>职责标签（可选）</span>
                <input
                  value={node.role ?? ""}
                  disabled={readOnly}
                  aria-label="节点职责标签"
                  placeholder="例如：开发"
                  onChange={(event) => props.onChangeNode({ role: event.target.value.trim() ? clampText(event.target.value, 128) : undefined })}
                />
              </label>
            </div>

            <label className="workflow-field">
              <span>Prompt（≤{MAX_WORKFLOW_PROMPT_LENGTH} 字，保留换行；可用 {"{{input}}"} {"{{attempt}}"} {"{{retry_feedback}}"} {"{{节点 id}}"}）</span>
              <textarea
                className="workflow-prompt"
                value={node.prompt}
                rows={8}
                maxLength={MAX_WORKFLOW_PROMPT_LENGTH}
                disabled={readOnly}
                aria-label="节点 prompt"
                placeholder="这个节点要做什么。引用上游产物用 {{n1}} 这样的祖先节点 id。"
                onChange={(event) => props.onChangeNode({ prompt: clampText(event.target.value, MAX_WORKFLOW_PROMPT_LENGTH) })}
              />
              <em className="workflow-field-count">{node.prompt.length}/{MAX_WORKFLOW_PROMPT_LENGTH}</em>
            </label>

            <label className="workflow-field">
              <span>来源</span>
              <select
                value={node.exec.kind}
                data-control="workflow-node-source"
                disabled={readOnly}
                aria-label="节点执行来源"
                onChange={(event) => {
                  const kind = event.target.value === "subagent" ? "subagent" : "agent";
                  // 切回 agent 时清掉子智能体与它带来的工具白名单，避免残留一个来源里不存在的工具。
                  props.onChangeNode(kind === "agent" ? { exec: { ...node.exec, kind, subagent: undefined } } : { exec: { ...node.exec, kind } });
                }}
              >
                <option value="agent">当前角色（owner 的角色与模型）</option>
                <option value="subagent">自定义子智能体</option>
              </select>
            </label>

            {node.exec.kind === "subagent" && (
              <label className="workflow-field">
                <span>子智能体</span>
                <select
                  value={node.exec.subagent ?? ""}
                  data-control="workflow-node-subagent"
                  disabled={readOnly}
                  aria-label="子智能体"
                  onChange={(event) => props.onChangeNode({ exec: { ...node.exec, subagent: event.target.value || undefined } })}
                >
                  <option value="">（未选择，运行时会被拒绝）</option>
                  {subagents.map((subagent) => (
                    <option key={subagent.id} value={subagent.id}>{subagent.name}{subagent.builtin ? "（内置）" : ""}</option>
                  ))}
                  {node.exec.subagent && !subagents.some((subagent) => subagent.id === node.exec.subagent) && (
                    <option value={node.exec.subagent}>{node.exec.subagent}（找不到定义）</option>
                  )}
                </select>
              </label>
            )}

            <label className="workflow-field">
              <span>模型</span>
              <ModelSelect
                models={selectableModels}
                providers={providers}
                value={node.exec.model ? `${node.exec.model.provider}/${node.exec.model.id}` : ""}
                placeholder={node.exec.kind === "subagent" ? "跟随子智能体定义 → owner 模型" : "跟随 owner 当前模型"}
                emptyMessage="暂无已配置的模型"
                disabled={readOnly}
                className="workflow-model-select"
                onChange={(value) => {
                  if (!value) {
                    props.onChangeNode({ exec: { ...node.exec, model: undefined } });
                    return;
                  }
                  const index = value.indexOf("/");
                  props.onChangeNode({ exec: { ...node.exec, model: { provider: value.slice(0, index), id: value.slice(index + 1) } } });
                }}
              />
              <em className="workflow-field-note">
                {node.exec.model && !selectableModels.some((model) => `${model.provider}/${model.id}` === `${node.exec.model?.provider}/${node.exec.model?.id}`)
                  ? "该模型当前已停用或未配置：运行前会按既有委派回落规则解析，并在受理时显示实际模型。"
                  : "运行前预检会把实际生效的模型/思考等级冻结进本次运行，运行中改这里不影响已受理的运行。"}
              </em>
              {props.resolvedModel && (
                <em className="workflow-field-note" data-resolved-model={`${props.resolvedModel.provider}/${props.resolvedModel.id}`}>
                  本次运行实际生效：{props.resolvedModel.provider}/{props.resolvedModel.id}
                </em>
              )}
            </label>

            <label className="workflow-field">
              <span>思考等级</span>
              <select
                value={node.exec.thinkingLevel ?? ""}
                data-control="workflow-node-thinking"
                disabled={readOnly}
                aria-label="思考等级"
                onChange={(event) => props.onChangeNode({ exec: { ...node.exec, thinkingLevel: (event.target.value || undefined) as ThinkingLevel | undefined } })}
              >
                <option value="">跟随来源</option>
                {THINKING_LEVELS.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}
              </select>
            </label>

            <div className="workflow-field">
              <span>工具白名单（只能从来源工具集里收窄）</span>
              <label className="workflow-check">
                <input
                  type="checkbox"
                  checked={node.exec.tools === undefined}
                  disabled={readOnly}
                  data-control="workflow-node-tools-inherit"
                  onChange={(event) => props.onChangeNode({ exec: { ...node.exec, tools: event.target.checked ? undefined : [...sourceTools] } })}
                />
                按来源继承全部工具
              </label>
              {node.exec.tools !== undefined && (
                <div className="workflow-tool-list" role="group" aria-label="节点可用工具">
                  {BUILTIN_TOOL_ORDER.map((tool) => {
                    const fromSource = sourceTools.includes(tool);
                    const checked = node.exec.tools?.includes(tool) ?? false;
                    return (
                      <label key={tool} className={`workflow-check${fromSource ? "" : " is-disabled"}`} title={fromSource ? toolLabel(tool) : "来源未启用这个工具，节点不能自行开启"}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={readOnly || !fromSource}
                          data-control="workflow-node-tool"
                          data-tool={tool}
                          onChange={(event) => {
                            const current = new Set(node.exec.tools ?? []);
                            if (event.target.checked) current.add(tool);
                            else current.delete(tool);
                            props.onChangeNode({ exec: { ...node.exec, tools: BUILTIN_TOOL_ORDER.filter((item) => current.has(item)) } });
                          }}
                        />
                        {toolLabel(tool)}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <label className="workflow-field">
              <span>访问上限（只收紧，不提权）</span>
              <select
                value={node.exec.accessModeCap ?? ""}
                data-control="workflow-node-access"
                disabled={readOnly}
                aria-label="节点访问上限"
                onChange={(event) => props.onChangeNode({ exec: { ...node.exec, accessModeCap: (event.target.value || undefined) as AccessMode | undefined } })}
              >
                <option value="">跟随 owner 当前访问权限</option>
                {WORKFLOW_ACCESS_MODE_ORDER.map((mode) => <option key={mode} value={mode}>{WORKFLOW_ACCESS_MODE_LABELS[mode]}</option>)}
              </select>
            </label>

            {nodeExecutions.length > 0 && (
              <div className="workflow-field">
                <span>历史轮次</span>
                <div className="workflow-attempt-list" role="group" aria-label="节点历史轮次">
                  {nodeExecutions.map((execution) => (
                    <button
                      key={execution.executionId}
                      type="button"
                      className={execution.executionId === selectedExecution?.executionId ? "workflow-attempt active" : "workflow-attempt"}
                      data-control="workflow-node-execution"
                      onClick={() => props.onSelectExecution?.(execution.executionId)}
                    >
                      <b>{attemptText(execution.attempt, definition.rework?.maxAttempts ?? 1)}</b>
                      <span className={`workflow-attempt-status state-${execution.status}`}>{WORKFLOW_EXECUTION_STATUS_LABELS[execution.status]}</span>
                    </button>
                  ))}
                </div>
                {selectedExecution && (
                  <div className="workflow-artifact">
                    {props.artifact && props.artifact.executionId !== selectedExecution.executionId && props.artifact.loading === undefined
                      ? <button type="button" className="workflow-link" data-control="workflow-node-artifact-load" onClick={() => props.onSelectExecution?.(selectedExecution.executionId)}>读取产物</button>
                      : null}
                    {props.artifact?.executionId === selectedExecution.executionId && props.artifact.loading ? (
                      <p className="workflow-artifact-placeholder"><LoaderCircle size={12} className="spinning" />正在读取产物…</p>
                    ) : props.artifact?.executionId === selectedExecution.executionId && props.artifact.error ? (
                      <p className="workflow-artifact-placeholder is-error"><AlertTriangle size={12} />{props.artifact.error}</p>
                    ) : props.artifact?.executionId === selectedExecution.executionId && props.artifact.text !== undefined ? (
                      <>
                        <pre className="workflow-artifact-text">{props.artifact.text || "（空产物）"}</pre>
                        {props.artifact.truncated && <em className="workflow-field-note">产物较大：这里只显示前 8 KiB，完整内容见运行详情里的文件引用。</em>}
                      </>
                    ) : null}
                  </div>
                )}
                {props.onOpenRunDetails && (
                  <button type="button" className="workflow-link" data-control="workflow-node-run-details" onClick={props.onOpenRunDetails}>
                    <FileCode2 size={12} />在运行详情里查看完整记录
                  </button>
                )}
              </div>
            )}

            {!readOnly && (
              <div className="workflow-inspector-actions">
                <button type="button" className="danger ghost" data-control="workflow-node-delete" onClick={props.onDeleteNode}>
                  <Trash2 size={12} />删除节点
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <label className="workflow-field">
              <span>名称（≤{MAX_WORKFLOW_NAME_LENGTH} 字）</span>
              <input
                value={definition.name}
                maxLength={MAX_WORKFLOW_NAME_LENGTH}
                disabled={readOnly}
                data-control="workflow-name"
                aria-label="工作流名称"
                onChange={(event) => props.onChangeDefinition({ name: clampText(event.target.value, MAX_WORKFLOW_NAME_LENGTH) })}
              />
            </label>
            <label className="workflow-field">
              <span>用途描述</span>
              <textarea
                value={definition.description ?? ""}
                rows={2}
                disabled={readOnly}
                aria-label="工作流描述"
                placeholder="一句话说明这个流程做什么。"
                onChange={(event) => props.onChangeDefinition({ description: event.target.value.slice(0, 2_000) })}
              />
            </label>
            <label className="workflow-field">
              <span>何时使用（给模型看的触发说明）</span>
              <textarea
                value={definition.whenToUse ?? ""}
                rows={2}
                disabled={readOnly}
                aria-label="何时使用"
                onChange={(event) => props.onChangeDefinition({ whenToUse: event.target.value.slice(0, 2_000) })}
              />
            </label>
            <label className="workflow-field">
              <span>输入提示（运行时弹出的输入框说明）</span>
              <textarea
                value={definition.inputHint ?? ""}
                rows={2}
                disabled={readOnly}
                aria-label="输入提示"
                onChange={(event) => props.onChangeDefinition({ inputHint: event.target.value.slice(0, 2_000) })}
              />
            </label>
            <p className="workflow-field-note">在画布上点一个节点可编辑它的 prompt、来源、模型与权限上限。</p>
          </>
        )}

        <section className="workflow-rework">
          <header>
            <strong>返工区间</strong>
            <label className="workflow-check">
              <input
                type="checkbox"
                checked={Boolean(rework)}
                disabled={readOnly}
                data-control="workflow-rework-toggle"
                aria-label="启用返工区间"
                onChange={(event) => {
                  if (!event.target.checked) {
                    props.onChangeRework(undefined);
                    return;
                  }
                  // 首版区间只能有一个 gate：默认取第一个 gate 节点，入口取 gate 的上游第一个节点。
                  const gate = gateNodes[0]?.id ?? "";
                  const entry = defaultReworkEntry(definition, gate);
                  props.onChangeRework({ entryNodeId: entry, gateNodeId: gate, maxAttempts: DEFAULT_WORKFLOW_ATTEMPTS });
                }}
              />
              启用
            </label>
          </header>
          {rework ? (
            <>
              <label className="workflow-field">
                <span>区间入口（轮次重跑从这里开始）</span>
                <select
                  value={rework.entryNodeId}
                  data-control="workflow-rework-entry"
                  disabled={readOnly}
                  aria-label="返工区间入口"
                  onChange={(event) => props.onChangeRework({ ...rework, entryNodeId: event.target.value })}
                >
                  <option value="">（未选择）</option>
                  {definition.nodes.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}（{item.id}）</option>)}
                </select>
              </label>
              <label className="workflow-field">
                <span>验收 gate（区间出口，必须恰好一个）</span>
                <select
                  value={rework.gateNodeId}
                  data-control="workflow-rework-gate"
                  disabled={readOnly}
                  aria-label="返工区间 gate"
                  onChange={(event) => props.onChangeRework({ ...rework, gateNodeId: event.target.value })}
                >
                  <option value="">（未选择）</option>
                  {gateNodes.map((item) => <option key={item.id} value={item.id}>{item.title || item.id}（{item.id}）</option>)}
                </select>
                {gateNodes.length === 0 && <em className="workflow-field-note">还没有 gate 节点：把某个节点的类型改成「验收 gate」。</em>}
              </label>
              <label className="workflow-field">
                <span>总执行轮数（1–{MAX_WORKFLOW_ATTEMPTS}，= 最多返工 {Math.max(0, rework.maxAttempts - 1)} 次）</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_WORKFLOW_ATTEMPTS}
                  value={rework.maxAttempts}
                  disabled={readOnly}
                  data-control="workflow-rework-attempts"
                  aria-label="总执行轮数"
                  onChange={(event) => props.onChangeRework({ ...rework, maxAttempts: Number(event.target.value) || DEFAULT_WORKFLOW_ATTEMPTS })}
                />
              </label>
              <p className="workflow-field-note">
                gate 必须输出 {"{\"verdict\":\"pass|retry\",\"reason\":\"…\"}"}；达到轮数仍未通过时运行记为「未通过」，不会误报成功。
              </p>
            </>
          ) : (
            <p className="workflow-field-note">不启用时不允许存在可执行 gate；规划一次、全部节点各跑一次。</p>
          )}
          {props.planExecutions !== undefined && (
            <p className="workflow-field-note">最多 {props.planExecutions} 次节点执行（不是模型调用数，也不是 token 预算）。</p>
          )}
        </section>

        {generalIssues.length > 0 && (
          <ul className="workflow-inspector-issues" aria-label="整体运行问题">
            {generalIssues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}><AlertTriangle size={11} />{workflowIssueText(issue)}</li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** 来源工具集：子智能体给了明确 tools 表就用它，否则按「继承 owner 已启用工具」看待。 */
function sourceToolSet(node: WorkflowNode, subagents: readonly SubagentDefinition[]): BuiltinToolName[] {
  if (node.exec.kind !== "subagent" || !node.exec.subagent) return [...BUILTIN_TOOL_ORDER];
  const definition = subagents.find((subagent) => subagent.id === node.exec.subagent);
  if (!definition || definition.tools === "inherit") return [...BUILTIN_TOOL_ORDER];
  return BUILTIN_TOOL_ORDER.filter((tool) => definition.tools !== undefined && (definition.tools as Record<string, boolean>)[tool] === true);
}

/** 启用返工时给一个合理默认入口：gate 的直接前驱（没有就用第一个非 gate 节点）。 */
function defaultReworkEntry(definition: WorkflowDefinition, gateNodeId: string): string {
  const incoming = definition.edges.filter((edge) => edge.to === gateNodeId).map((edge) => edge.from);
  if (incoming.length > 0) return incoming[0]!;
  return definition.nodes.find((node) => node.kind !== "gate")?.id ?? "";
}
