# Checkpoint 回滚：实现方案（v2，补过期清理）

## 背景与目标

AI 改坏文件后用户无法一键还原。现有基础设施：`tool_execution_start` 事件（Pi 会 `await` 扩展 handler，**在工具执行前完成快照无竞态**，已核实 agent-session.js:507 与 runner.js:588）、`changedWorkspaceFile`/`artifactCandidatesFromBashCommand` 路径解析（workspace-preview.ts）、`writeWorkspaceFile` 同款越界校验、todos/plans 的按会话存盘与会话删除清理先例、交付产物面板（ChangedFilesPanel）的按消息文件聚合。

**回滚语义（第一版边界）**：「撤销这条 AI 回复对文件的改动」——把该条回复中 write/edit 改动的文件恢复到改动前状态，AI 新建的文件删除。**不动 transcript**：AI 的认知靠回滚后重新读文件自然校正（用户可直接说「改动已回滚，请重新做」）；「回滚+截断重放」属会话分叉功能，不在本次范围。

## 核心语义规则

| 情形 | 快照行为 | 回滚行为 |
|---|---|---|
| write/edit 目标文件已存在 | 存内容（上限 5MB，超限记 `truncated`） | 恢复内容 |
| write/edit 目标不存在（AI 新建） | 记 `existed:false` | 删除该文件 |
| bash 显式输出路径（-o/--output/`>` 重定向）且文件已存在 | 存内容 | 恢复内容 |
| bash 候选文件不存在 | **不记录**（防误删用户文件） | — |
| bash 其他产物（输出文本模糊解析） | 不记录 | 回滚结果中报告「未快照」 |

- 回滚粒度 = 一条 AI 回复（消息）：主进程按请求的 toolCallIds 过滤快照 JSONL，**每文件取最早快照**（= 该回复动手前的状态）。
- 快照存储：`chatanytime-sessions/<agentId>/checkpoints/<sessionId>.jsonl`（行序即时间序）。
- 回滚是**用户操作**，不经 AI 权限门（与 Markdown 编辑器保存同语义）；read-only 访问模式不拦截。
- 总开关 `settings.checkpoint.enabled`（缺省启用，逐事件实时读，不重建会话）。

## 快照生命周期与过期清理（三层设计）

清理原则：**读路径永不过滤**（用户显式要求回滚老消息时，只要条目还在就照常回滚）；清理只发生在写路径的惰性压缩与启动清扫，参数为 checkpoint-store.ts 导出的常量（第一版不配置化，测试可注入）。

1. **会话级清理（即时）**：`session.delete` / `workspace.remove` 时随 todos/plans 先例 unlink 对应 `checkpoints/<sessionId>.jsonl`。
2. **条目级惰性压缩（写路径）**：appendCheckpoint 维护进程内行数计数（Map by sessionId）；单文件超过 `COMPRESS_THRESHOLD_LINES = 1000` 行时，在同一串行队列内重写该文件——先丢弃 `ts` 超过 `RETAIN_DAYS = 14` 天的过期条目，若仍超过 `COMPRESS_KEEP_LINES = 500` 条再保留最近 500 条；计数器与文件同步更新。回滚价值随时间衰减，14 天前的快照视为过期。
3. **全局清扫（utility 启动一次）**：`initialize` 时异步（不阻塞启动）扫描所有 `checkpoints/` 目录：删除 mtime 超过 30 天的 `.jsonl` 文件；checkpoints 总字节数超过 `GLOBAL_MAX_TOTAL_BYTES = 50MB` 时按 mtime 从旧到新删整文件直到达标；清理量走 warn 日志留痕。

## 实施步骤

### 1. `src/main/checkpoint-store.ts`（新，纯存储模块）
- `CheckpointEntry { ts, toolCallId, toolName, relativePath, existed, content?, truncated? }`
- `checkpointPathFor(agentDir, sessionId)`、`appendCheckpoint`（JSONL 追加 + 串行队列 + 行数计数，同 tool-audit 模式）、`readCheckpoints`、常量 `CHECKPOINT_FILE_LIMIT(5MB)` / `RETAIN_DAYS` / `COMPRESS_THRESHOLD_LINES` / `COMPRESS_KEEP_LINES` / `GLOBAL_MAX_TOTAL_BYTES`
- 纯函数 `selectRollbackPlan(entries, toolCallIds)`：过滤 + 每文件取最早（可直接单测）；纯函数 `compressEntries(entries)`：过期过滤 + 截尾（可直接单测）
- `sweepCheckpoints(agentDir, now)`：全局清扫（可注入 now 单测）

### 2. `src/main/runtime-checkpoint.ts`（新，builder 模式）
- `createCheckpointExtension(deps)`：第五个 app-owned 内联扩展 `pidesktop-checkpoint`，挂 `tool_execution_start`（Pi await 保证时序）
- deps：`{ workspace, sessionId, agentDir, enabled, warn }`（全函数式实时读，同 hooks/memory 模式）
- write/edit → `changedWorkspaceFile` 取路径；bash → `artifactCandidatesFromBashCommand` 取候选；异步读原文件后追加（失败仅 warn，绝不影响回合）
- 子代理不挂此扩展（extensionFactories 只在主会话，天然排除）

### 3. `src/main/pi-runtime.ts`（接线）
- extensionFactories 数组追加第五个扩展（1519 行处）
- 命令分发新增 `checkpoint.rollback { sessionId?, toolCallIds }`：resolveTargetRecord 定位 record → selectRollbackPlan → 逐项恢复（恢复走 `writeWorkspaceFile` 的 realpath 越界校验；`existed:false` 项 unlink）→ `post({ type: "checkpoint-result", ... })`
- `session.delete` / `workspace.remove` 清理分支同步 unlink checkpoints 文件（2032-2075 行 plans 先例处）
- utility `initialize` 挂一次 `sweepCheckpoints`（异步不阻塞）；settings 新增 `checkpoint?: { enabled?: boolean }` + normalize（settings.ts，缺省启用）

### 4. `src/shared/protocol.ts`（协议）
- RuntimeCommand 加 `checkpoint.rollback`；RuntimeMessage 加 `checkpoint-result { sessionId, results: { relativePath, action: "restored"|"deleted"|"skipped" }[], error? }`
- AGENTS.md 同步：内联扩展清单「四个→五个」+ 新能力条目（快照时机、回滚语义、清理策略、边界）

### 5. 渲染端
- `store.ts`：handleRuntimeMessage 加 `checkpoint-result` case（存最近结果供提示展示）
- `App.tsx`：收到 checkpoint-result 后 bump `treeRefreshSignal`（工作区树刷新）；新增回滚确认对话框状态（复用 deleteSession 的 permission-dialog 样式模式，列出将恢复/删除文件 + 「将覆盖这些文件的当前内容」警示）
- `ConversationPane.tsx`：ChangedFilesPanel summary 行加「回滚本次变更」按钮（History 图标，busy 时不显示）→ prop 链 App→ConversationPane→MessageView→ChangedFilesPanel 传 `onRollback(message)`
- `demo-api.ts`：命令 mock + 结果模拟推送同步

### 6. 测试（vitest）
- checkpoint-store.test.ts：JSONL 追加/读回往返、5MB 截断标记、selectRollbackPlan（多快照取最早、toolCallIds 过滤）、compressEntries（过期丢弃、截尾保留最近、未超阈值不动）、sweepCheckpoints（mtime 过期删文件、总容量超限从旧到新删、新文件保留）
- runtime-checkpoint.test.ts：fake-pi handler 模式（同 tool-audit.test）——write/edit 快照、existed:false、bash 仅快照已存在候选、disabled 不记录、快照失败不抛出
- 回滚执行集成测试：临时工作区真实读写——恢复内容、删除新建文件、越界路径拒绝、truncated 跳过
- settings normalize 用例

## 验证方式

`npm test` 与 `npm run build` 全绿；更新 docs/迭代记录.md；按规范 commit（`feat(checkpoint): ...`）。

## 风险与假设

1. **5MB 上限**：超大文本文件不快照，回滚结果中如实报告——不静默失败。
2. **清理代价**：压缩重写在串行队列内异步执行，单文件 ≤1000 行毫秒级；启动清扫一次性行为，不阻塞初始化。
3. **快照后用户手动改过文件**：回滚将覆盖（确认对话框已警示）。
4. **transcript 不回滚**：AI 后续若基于旧认知操作，会在读文件时看到真实状态；文档中写明建议话术。
5. bash 快照依赖命令解析，漏报仅导致不可回滚、误报仅多存快照，均不破坏正确性。
6. 清理参数为常量不配置化：与仓库其它能力（仅 enabled 开关）的风格一致，后续有真实需求再配置化。
