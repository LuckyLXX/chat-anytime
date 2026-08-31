# 子智能体设置：自定义子智能体（定义、管理、被 delegate_agent 使用）

## 背景与目标
当前子代理由 `delegate_agent` 工具驱动，参数只有 `goal/role/modelId`，`role` 是写死的枚举（explore/research/implement/review/custom），无法保存、复用、自定义。目标是新增一个「子智能体」设置页，让用户定义可保存的子智能体（名称/描述/颜色/模型/可用工具/系统提示词/作用域/是否注入 AGENTS.md），并让这些定义能被 `delegate_agent` 实际引用。

## 默认取舍
1. **使用方式**：自定义子智能体作为 `delegate_agent` 的可选目标——AI 委派时按名称引用；`role` 保留作兜底，`subagent` 参数优先。
2. **宿主位置**：设置对话框内新增「子智能体」tab（与现有「Agent 角色」并列）。
3. **作用域**：支持「用户（全局）/ 项目（工作区）」双作用域，项目优先——与 hooks/skills/memory 一致。
4. **内置子智能体**：第一版只做用户自定义，不引入内置；现有 `role` 枚举原样保留。

## 实施步骤

### 1. 协议层（`src/shared/protocol.ts`）
新增 `SubagentScope`、`SubagentDefinition`；`ResourceCatalog` 加 `subagents`；`RuntimeCommand` 加 `subagent.save`/`subagent.delete`。

### 2. 存储层（新文件 `src/main/subagents-store.ts`）
仿 hooks 双作用域：全局 `<agentDir>/pidesktop-subagents.json`、项目 `<workspace>/.pidesktop-subagents.json`；`normalizeSubagent`（纯函数可单测）、`readSubagents`（global+project 合并，project 覆盖）、`saveSubagent`、`deleteSubagent`。

### 3. 运行时接入（`src/main/subagent.ts` + `src/main/pi-runtime.ts`）
`delegate_agent` 增加可选参数 `subagent`；命中定义时系统提示用 `[base, 定义.systemPrompt]`、模型用 `定义.model`、工具集用 `定义.tools`（`"inherit"`=继承父会话工具，否则自定义）。主会话 `systemPromptOverride` 注入可用子智能体清单。`emitResourceCatalog` 并入 `subagents`。命令管道接 `subagent.save`/`subagent.delete`。

### 4. 渲染端（`src/renderer/src/App.tsx`）
`SettingsDialog` 的 `tab` union 加 `"subagents"`，新增 tab 按钮；子区挂 `SubagentSettings`：左侧列表 + 右侧表单（名称、颜色、模型、描述、可用工具、系统提示词、作用域、注入 AGENTS.md 开关、保存/删除）。

## 验证
- 新增 `src/main/subagents-store.test.ts`（normalize 纯函数、双作用域合并覆盖）。
- 扩展 `src/main/subagent.test.ts`（`subagent` 命中/未命中解析）。
- 全量 `npm test` + `npm run build` 全绿。
- 手动冒烟：设置 → 子智能体 → 新建定义 → AI 委派按名称用上它。

## 风险与假设
- 子智能体清单注入主会话系统提示会略增 prompt 体积；只注入启用定义且描述精简。
- `"inherit"` 工具集语义在 `runDelegation` 读父会话已启用内置工具集。
- 双作用域原子写 + 缓存刷新与 hooks 同款。
