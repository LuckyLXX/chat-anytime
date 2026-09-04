# 支持 /v1/responses：模型级/服务商级 API 模式与 baseUrl 覆盖

## 背景与目标

PiDesktop 目前只能把自定义「OpenAI 兼容服务」以 `openai-completions` 硬编码注册，内置服务商（如 opencode-go）的 API 模式与 baseUrl 由 pi-ai 目录决定且不可改。有些供应商支持 `/v1/responses` 调用（含 opencode-go 目录内混排的 gpt-5.6-luna / grok-4.6 等已标 `openai-responses` 的模型，以及用户自定义中转站），但用户无法配置。

目标（用户已确认的取舍）：
1. **模型级 + 服务商级兜底**：每个模型可单独选择 API（跟随默认 / chat/completions / responses）；自定义服务商额外提供「默认 API」下拉兜底。
2. **顺手开放内置服务商 baseUrl 覆盖**：自定义与内置都能改接口地址（空 = 跟随目录默认）。
3. **UI 交互**：模型行加「API」徽标，点击展开行内选择（复用现有限额行内编辑模式），行不常驻控件。

## 技术依据（已探明）

- pi-ai `ProviderConfigInput`：provider 级 `api`/`baseUrl` 与**模型级** `api`/`baseUrl` 均存在；`registerProvider` 与内置定义合并覆盖（`composeModelProvider`）；`applyExtension` 中模型 api 解析顺序 `definition.api ?? config.api ?? defaults.api`；请求按**模型级 api** 定位 API 实现（`getApiProvider(model.api)`）。
- 自定义服务商落位通道：`modelRuntime.registerProvider`（model-runtime.js 中 extension 注册，与 `builtins` 分开存储）。
- 内置服务商落位通道：models-store 覆盖层（`~/.pi/agent/models-store.json` + `runtime.refresh({allowNetwork:false, force:true})`），PiDesktop 已有先例 `refreshBuiltinModelsFallback`（pi-runtime.ts:1787-1834）：覆盖层模型带完整元数据（api/baseUrl/价格/input 等），新模型克隆模板。
- **注意 `applyExtension` 的 models 数组是整体替换语义**（传入的列表即 provider 全部模型）——这就是内置服务商必须走覆盖层而非 registerProvider 的原因：内置目录模型是全量的，不能只传覆盖的那几个。

## 实施步骤

### 1. 协议层（src/shared/protocol.ts + demo-api.ts 同步）

- 新增类型：`export type ProviderApiMode = "openai-completions" | "openai-responses";`
- `ProviderModelSettings` 加 `api?: ProviderApiMode`（模型级覆盖，undefined = 跟随服务商/目录默认）
- `ProviderSettings` 加 `api?: ProviderApiMode`（服务商级），并更新 `baseUrl` 注释：内置条目（custom:false）也可携带 = 接口地址覆盖（空/缺省 = 目录默认，不再恒为空串）
- `ModelOption` 加 `api?: ProviderApiMode`（目录「生效 API」展示用，来自 catalog model.api）
- 按 AGENTS.md 约定同步 `src/renderer/src/demo-api.ts`（新旧字段均为可选，补类型引用/注释一致性即可）

### 2. 主进程注册逻辑（src/main/）

**src/main/custom-provider.ts**
- `customProviderModelDefinition`：透传模型级 `api` 与 `baseUrl`（保留现有 reasoning/input/compat 等字段）
- `resolveCustomProviderRegistration`：返回结构增加 `api?: ProviderApiMode`（服务商级，缺省解析为 `"openai-completions"` 保持现状）；模型级 api 从 settings 透传；内置条目（custom:false）仍返回 null（其覆盖走覆盖层）

**src/main/pi-runtime.ts**
- `registerCustomProvider`（约 1640 行）：`api` 改为 `registration.api ?? "openai-completions"`，不再硬编码
- 新增纯函数 `builtinProviderOverlay(providerId, currentModels, settingsEntry)`（放 custom-provider.ts 以便单测）：以 `runtime.getModels(providerId)` 当前目录为基线，应用设置覆盖——条目 `baseUrl` 非空 → 全部模型 baseUrl 覆盖；条目 `api` 非空 → 全部模型 api 覆盖；条目模型级 `api` 非空 → 对应模型 api 覆盖；返回覆盖后的完整模型列表（保留原对象引用不变则返回 undefined 表示无需写覆盖层）
- 新增 `syncBuiltinProviderOverlays()`：遍历 `settings.providers` 中 `custom === false` 的条目，对**存在覆盖**的条目写 `~/.pi/agent/models-store.json`（结构同 `writeRemoteCatalogOverlay`：`{ [providerId]: { models, checkedAt, lastModified: Date.now(), etag: undefined } }`，时间戳保证 SDK 门控放行），全部完成后一次 `runtime.refresh({ allowNetwork: false, force: true })` + `refreshCatalog()`；无覆盖条目不写文件
- 调用时机：
  - initialize（约 2331 行循环后）：注册完自定义服务商后调用一次
  - `provider.save` 与 `provider.models.save`：保存后调用（与 registerCustomProvider 并列）
  - `provider.models.refresh` 的 `refreshBuiltinModelsFallback` 成功后：重新调用，把设置的 api/baseUrl 覆盖叠加到刚拉取的最新目录上

### 3. 设置 UI（src/renderer/src/）

**src/renderer/src/App.tsx**
- `providerModels` 构造（内置分支，约 636 行）：增加 `api: stored?.api ?? model.api ?? undefined`（显示生效 API）
- 自定义服务商「默认 API」下拉：表单区新增 select（OpenAI 兼容 chat/completions / Responses），保存时写入 `providerConfig.api`
- 内置服务商「接口地址」输入框（可选覆盖，placeholder「留空 = 跟随目录」），值来自 `selectedProvider?.baseUrl`
- 模型行「API」徽标 + 行内选择：新增 `editingModelApi` 状态，复用限额编辑交互模式（点击徽标展开：跟随默认 / chat/completions / responses，选「跟随默认」= 写 `api: undefined`）；`updateProviderModel(model.id, { api })` 钩子已现成
- 保存分支：内置分支构造 `builtinEntry` 时带上 baseUrl/api（走现有 `provider.models.save` 命令，结构不变）；自定义分支 `providerConfig` 加 `api`
- `prompt`/校验：`formBlocker` 不变（内置 baseUrl 仍非必填；自定义「默认 API」保底 completions 无需校验）
- UI 文案用现有中文风格（「API 协议」「跟随默认」等）

**src/renderer/src/lib/model-list.ts**
- `buildBuiltinProviderEntry`：透传 `existing?.baseUrl`（替代现在的恒 `""`）与 `existing?.api`

### 4. 测试

- `src/main/custom-provider.test.ts`：服务商级 api 缺省解析 completions、模型级 api 透传、baseUrl 校验不变、内置条目（custom:false）仍返回 null
- 新增 `builtinProviderOverlay` 单测（custom-provider.test.ts 或独立文件）：无覆盖不产生新列表、baseUrl 整组覆盖、模型级 api 覆盖、保留原模型字段
- `src/renderer/src/lib/model-list.test.ts`：`buildBuiltinProviderEntry` 带 baseUrl/api 透传
- 运行 `npm test` 全绿

### 5. 文档与提交

- `docs/迭代记录.md`：待办移入已完成，写实现摘要
- 按提交纪律 commit（徒本地 add/commit，不 push 不发版）

## 验证方式

1. `npm test` 全绿（协议/主进程纯函数/UI lib 三层单测覆盖新增行为）
2. `npm run build` 通过
3. 用户重启应用后：设置页可对内置服务商（如 opencode-go）单个模型选择 Responses API、可覆盖接口地址；自定义服务商有「默认 API」下拉；会话请求按配置走 `/v1/responses`（由 pi-ai `getApiProvider(model.api)` 分发，不做供应商支持性强校验）

## 风险与假设

- 模型级 api 覆盖不做供应商可用性校验：把 completions-only 的模型切到 responses 会得到上游 404/报错，属用户自行配置，UI 下拉已表达含义
- anthropic-messages 模型（opencode-go 的 minimax-m3/qwen3.8-flash）只有「跟随默认 / chat/completions / responses」三档选项；切到非默认档若不支持会报错，预期行为
- 覆盖层写入沿用 `refreshBuiltinModelsFallback` 的本地单文件写先例；无覆盖条目不写文件、不动目录，避免无谓 IO
- 远程目录（pi.dev）与覆盖层共存沿用现有 lastModified 门控机制，不引入新同步模型
- 本次不新增协议命令、不改 AGENTS.md 公共钩子/主题契约；`ProviderSettings` 字段均为可选新增，存量 settings.json 免迁移
