# 图片请求体积治理（413 / payload_too_large 防护）实施方案

> 日期：2026-09-18 · 状态：待批准 · 规模：M
> 完整设计文档已写入仓库：`docs/plans/2026-09-18-图片请求体积治理（413-防护）设计方案.md`（本计划为其自包含摘要+实施版）

## 一、背景与目标

### 问题
上游中转网关对请求体有 **8MB 字节上限**，图片任务超过后返回：
```
413: {"message":"请求体超过 8 MB 上限：请压缩内容（精简上下文或附件）…","code":"payload_too_large"}
```
支持图片输入的会话里，历史中的**所有图片 base64 随每次请求全量上送**，随轮次线性膨胀直到撞线。用户实测：11 分钟的任务在第 9 次工具调用后失败。

### 真机证据（已量化，`~/.pi/agent/chatanytime-sessions/**/*.jsonl`）
3 个会话共 9 次真实失败：

| 会话 | 失败次数 | 失败时前缀内图片 |
|---|---|---|
| 有解App 原型图（09-15） | 4 | 首次 59 张/6.5MB → 123 张/24MB（全场 148 张图全部来自 AI `read` 自己生成的截图） |
| 贴纸生成 ①（09-17） | 3 | 18 张/7.9MB；两次 /compact 后 9 张/9.9MB、8 张/7.9MB **仍被拒** |
| 贴纸生成 ②（09-17） | 2 | **5 张/7.9MB**（1 张用户图 3.3MB + 4 张 AI 读图）；/compact 后仍被拒 |

三个决定性结论：
1. **图片主因不是用户附图，而是 AI 在同一轮反复 `read` 自己生成的图**（会话 C：用户 20 条消息 0 张图，会话里却有 148 张图）。
2. **单图上限形同虚设**：Pi 内建压缩只保证单张 ≤4.5MB/≤2000px（`utils/image-resize-core.js`），没有总量概念。
3. **自动压缩救不了**：Pi 对每张图只按 4800 字符折算 token（`ESTIMATED_IMAGE_CHARS`），18 张图 ≈ 2.2 万 token，远低于压缩阈值；/compact 后保留窗口里仍有 8~9 张图。

### 目标
1. 发往上游前做**字节预算裁剪**：图片总量超预算时从最旧图片开始降级为**稳定占位符文本**，请求体不再滚雪球。
2. 单图先降采样（≤1.5MB / ≤1600px）。
3. 占位符**字节稳定**（同一张图每次渲染同一串），前缀缓存每图最多失效一次。
4. 占位符**可恢复**：带工作区相对路径，模型可 `read`/`recognize_images` 回看。
5. 只改上送副本，**不动**转录 / JSONL / 界面渲染。

### 非目标
- 不做「413 后自动裁剪重试」自愈（用户已定：先预防）。
- 不改 Pi 内建 read/压缩行为；不做相似度去重；不加设置项 UI。

## 二、方案（关键决策与理由）

在**唯一请求咽喉** `streamSimple` 包装（`pi-runtime.ts` 的 `wrapModelRuntimeForVision`，主会话与子代理共用）叠加三层：

```
模型不支持图片 → 既有 stripContextImages（不变）
模型支持图片   → applyImageBudget：
   2a 单图 >1.5MB → resizeImage 压到 ≤1.5MB/≤1600px（确定性，可缓存）
   2b 从最新往旧累加，超 6MB 的图片替换为占位符文本
   任何失败 → fail-open 原样发送
```

**为什么放这里**：扩展 `context` 事件不可用——Pi 的 `emitContext` 会先 `structuredClone(messages)`（`core/extensions/runner.js:793`），对 12MB 请求做整树深拷贝，内存/延迟不可接受；`streamSimple` 的 context 是引用，逐条替换不触发整包复制。

**为什么按预算而不是按轮次保留**（对用户所提"当前轮全保留"方案的修正）：AI 一轮里可能读十几张图，当前轮本身就会超限；必须以字节预算为准。

参数（模块常量，暂不进设置页）：
| 常量 | 值 |
|---|---|
| 图片总量预算 `IMAGE_TOTAL_BUDGET_BYTES` | 6MB（网关 8MB 留 2MB 给文本） |
| 单图目标 `IMAGE_PER_IMAGE_BYTES` | 1.5MB |
| 长边上限 `IMAGE_MAX_DIMENSION` | 1600px |
| 压缩触发阈值 `IMAGE_DOWNSAMPLE_MIN_BYTES` | 1.5MB |

占位符格式（稳定、可恢复）：
```
〔图片已省略（历史图片，共 N 张被省略）· 1586×992 · .pidesktop/downloads/xxx.png · 如需查看请 read 该文件或调用 recognize_images〕
```
路径解析优先序：`toolResult.details.savedPath`（截图工具已带，实测存在）→ 同 Context 中配对 `toolCall.arguments.path`（按 toolCallId 匹配）→ 兜底用 `sha256` 前 8 位短哈希。尺寸从 PNG IHDR / JPEG SOF 头解析。

## 三、实施步骤

### 步骤 1：新建 `src/main/request-image-budget.ts`
- 导出常量、`base64Bytes()`、像素解析、`placeholderText()`、`applyImageBudget(context, deps)`。
- `applyImageBudget` 算法：收集图片引用 `(messageIndex, partIndex, toolCallId, image)` → 算 base64 总量 → **未超预算直接原样返回（同一引用，零拷贝热路径）** → 超预算则从新到旧：先压缩（带 LRU 缓存，key=`sha256(原图)`），再从新到旧累加预算，超出的图片替换为 text part；只对变化的 message 造新对象。
- 依赖注入 `downsample` / `pathForImage` / `warn`，单测不跑真实 photon。

### 步骤 2：单图压缩实现 + 缓存
- 缺省 `downsample`：`resizeImage`（Pi 包根导出，`@earendil-works/pi-coding-agent`）参数 `{ maxWidth: 1600, maxHeight: 1600, maxBytes: 1.5MB }`。
- 实测：2.28MB PNG → 850ms / 386KB / **两次调用输出字节完全一致**（sha256 相同）→ 缓存安全；3.9KB 小图 77ms 短路。
- LRU 缓存（64 项或 32MB）避免每轮重复压缩。

### 步骤 3：接线 `pi-runtime.ts`（`wrapModelRuntimeForVision`）
- `streamSimple` 多模态分支改为：`lazyStream(effectiveModel, async () => target.streamSimple(effectiveModel, await cappedContext(context), options))`——`lazyStream` 是 `@earendil-works/pi-ai` 包根导出（与 Pi 内部 ModelRuntime 同款），保持「同步返回流」契约。
- `cappedContext` 内 catch 一切异常 → warn → 返回原 context（fail-open）。
- `completeSimple` 分支**保持不动**（视觉识别不能被裁剪）。
- 裁剪发生时记一条 warn 日志（含前/后体积、压缩/省略数）。

### 步骤 4：测试 `src/main/request-image-budget.test.ts`
1. 热路径：未超预算返回同一引用，downsample 零调用。
2. 单图超限触发压缩。
3. 总量超预算：保留最新 N 张（6MB 内），旧图占位符；顺序断言。
4. 占位符稳定性：同输入两次逐字节相同；不同图不同（含短哈希）。
5. 路径解析优先序；无路径用哈希。
6. fail-open：downsample 抛错不炸、按原样保留。
7. 接线层：`completeSimple` 的 context 未被裁剪（仿 `runtime-shell-kill.test.ts` 的 vi.mock 模式）。
8. 非图片消息与未受影响图片保持原引用（`toBe`）。
9. PNG/JPEG 头解析 3~4 例（含失败兜底）。

### 步骤 5：验证
- `npm test` + `npm run build` 全绿。
- 真机探针（`outputs/probe/`，不入库）：用真实会话 JSONL 重建「18 张图/12.3MB」Context 跑 `applyImageBudget`，断言输出 <8MB、两次运行字节一致、耗时 <2s；再跑会话 A（20 张图/12.6MB 文件）回归。
- 用户真机验证留到发版后。

### 步骤 6：记录与提交
- 更新 `docs/迭代记录.md`「最新进展」（该文件在 .gitignore 中，本地文档不入库）。
- 提交源码 + 测试 + 计划文件（`docs/plans/` 入库）；仓库纪律：`type(scope): 中文描述`，只 local commit，不 push。

## 四、风险与缓解

| 风险 | 缓解 |
|---|---|
| 模型看不到历史图片细节 | 占位符带路径 + recognize_images 提示；比现状（直接失败）好 |
| 极端情况文本 1.5MB + 图片 6MB 顶到 8MB 边缘 | 常量集中定义，必要时下调到 5MB |
| 压缩耗时叠加 | LRU 缓存 + 只对 >1.5MB 的图触发（实测 18 张里仅 2 张） |
| 缓存失效 | 每图最多一次（稳定占位符）；未超预算零影响 |

## 五、缓存影响（如实告知）
- 保留图片：压缩确定性，字节一致，不影响缓存。
- 降级图片：替换发生在「从保留转省略」那一次，此后稳定 → 每图最多破坏一次缓存。
- 未超预算：零改动零影响。

## 六、假设
- 网关 8MB 是用户当前环境的硬限（报错文本确认）；其他网关更小时可调常量。
- `resizeImage` 在打包版可用（photon-node 的 wasm 已随 asar 打包，已核实 asar 内含 photon 文件）。
- `lazyStream` 与 `resizeImage` 的导出是稳定公开 API（已核实 package exports 与 dist 导出）。
