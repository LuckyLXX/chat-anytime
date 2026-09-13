# A2 browser_eval 大结果落盘而非硬切（P0）

> 来源：`docs/GenericAgent借鉴分析.md` 第六节 A2；本条已登记在 `docs/迭代记录.md` 待办区。
> 优先级 P0（静默错误：模型拿到语法不完整的片段）。规模 S。

## 背景与目标

`browser_eval` 是模型抓取「快照覆盖不到的数据」的主要手段（canvas 内容、复杂 JSON、
SPA 动态状态）。当前实现：

- `browser-automation.ts` 的 `evaluateJs()` 最终调用
  `truncate(serialized, MAX_EVAL_RESULT_CHARS)`（`MAX_EVAL_RESULT_CHARS = 8000`，见文件顶部常量）；
- `truncate` 是**从头截断**（保留前 N 字符），于是模型拿到的是
  `[{"id":1,"name":"a"},{"id":2,"na`——**语法不完整的 JSON**。

后果有两层：
1. **白轮**：模型发现数据断了，往往重新执行一次更窄的表达式；
2. **更危险的是误判**：模型可能把残缺片段当完整结果处理，得出错误结论
   （本项目已有同源纪律：「面向模型的文本截断不能切在 token 中间」，见
   `memory` 主题「PiDesktop 踩坑记录」2026-09-11 条）。

**目标**：大结果**先落盘再回执**——模型拿到「前 8000 字符预览 + 完整文件路径」，
可以按需用 `read` 工具分段读取，而不是猜自己被截了多少。

## 关键事实（已核实）

| 事实 | 位置 |
|---|---|
| `MAX_EVAL_RESULT_CHARS = 8000`（文件顶部常量群） | `browser-automation.ts:31` 附近 |
| 截断点：`truncate(serialized, MAX_EVAL_RESULT_CHARS)` | `browser-automation.ts:993`（legacy 版）、`evaluateJs` 新版同处 |
| `BrowserAutomationData` 的 eval 载荷：`{ kind: "eval"; value: string }` | `src/shared/protocol.ts:739` |
| 结果在 utility 侧组装成回执文案 | `runtime-browser.ts` 的 `browser_eval` execute：`text: 执行结果（${mode}）：\n${result.data.value}` |
| **现成的落盘范式**（realpath 校验 + 工作区边界 + 保留策略） | `src/main/browser-screenshot.ts`（`saveBrowserScreenshot`，64 行起） |
| 依赖注入范式：`BrowserToolDeps.saveScreenshot` 由 `pi-runtime.ts:2550` 注入 | `runtime-browser.ts:23-31` + `pi-runtime.ts:2550` |
| 截图落盘目录 `.pidesktop/screenshots`，保留 20 个（模式可复用） | `browser-screenshot.ts:17-22` |

## 实施步骤

### 步骤 1：新建结果落盘模块

文件：**新建** `src/main/browser-eval-result.ts`（与 `browser-screenshot.ts` 同规格同风格）

```ts
// Persist oversized browser_eval results so the model can read them back in
// full instead of receiving a JSON fragment cut mid-token. Mirrors
// browser-screenshot.ts: workspace-bounded dir, timestamped unique name,
// best-effort retention, never throws for the caller's critical path.

const EVAL_DIR_NAME = ".pidesktop/eval";
const EVAL_KEEP = 20;
const EVAL_FILE_PATTERN = /^eval-.*\.(json|txt)$/u;

/** Save one eval result and return the workspace-relative path (forward slashes). */
export async function saveBrowserEvalResult(workspace: string, text: string, isJson: boolean): Promise<string>
```

要点（照抄截图模块的既有纪律，不要另创）：
- `realpath(resolve(workspace))` 取根，目录 `<root>/.pidesktop/eval`，`mkdir recursive`；
- 文件名 `eval-<yyyyMMdd-HHmmss-mmm>.<json|txt>`，`writeFile(..., { flag: "wx" })` +
  同毫秒冲突时 `-${attempt}` 重试（截图模块已有此循环，直接复用思路）；
- 保留策略 `EVAL_KEEP = 20`，按文件名排序删最旧（时间戳前缀保证字典序 = 时间序）；
- 返回 `relative(rootReal, target).replaceAll(sep, "/")`。

`isJson` 由调用方判断（`serialized` 首字符是 `{`/`[` 即视为 JSON，决定扩展名）。
**扩展名影响可读性但不影响正确性**，判断失败退化为 `.txt`。

### 步骤 2：主进程侧落盘

文件：`src/main/browser-automation.ts`

1. 注入一个「落盘函数」依赖（与截图同模式），**避免 main 里直接依赖 workspace 解析逻辑**：

```ts
/** 大 eval 结果落盘（缺省不落盘：测试与无工作区场景退化为纯截断）。 */
saveEvalResult?: (text: string, isJson: boolean) => Promise<string>;
```

   注：`BrowserAutomationController` 的构造参数是
   `(window, publish, onTabLifecycle?, onPickResult?)`（`browser-preview.ts:48-55` 是预览控制器的；
   自动化控制器在 `browser-automation.ts` 内，构造签名由实施者按现状确认后加一个可选 deps 参数）。

2. 在 `evaluateJs` 的返回处改为：

```ts
const needsSpill = serialized.length > MAX_EVAL_RESULT_CHARS;
let savedPath: string | undefined;
if (needsSpill && this.saveEvalResult) {
  try { savedPath = await this.saveEvalResult(serialized, isJsonLike(serialized)); } catch { /* 降级 */ }
}
return {
  ok: true,
  data: {
    kind: "eval",
    value: truncate(serialized, MAX_EVAL_RESULT_CHARS),
    ...(needsSpill ? { totalChars: serialized.length } : {}),
    ...(savedPath ? { savedPath } : {})
  }
};
```

3. 协议（`src/shared/protocol.ts:739`）：

```ts
| { kind: "eval"; value: string; totalChars?: number; savedPath?: string }
```

### 步骤 3：utility 侧回执文案

文件：`src/main/runtime-browser.ts`

`browser_eval` 的 execute 改为：

```ts
const { value, totalChars, savedPath } = result.data;
const head = `执行结果（${mode}）：\n${value}`;
const tail = totalChars
  ? savedPath
    ? `\n\n（结果共 ${totalChars} 字符，已完整保存到 \`${savedPath}\`；上为前 ${value.length} 字符预览，完整内容请用 read 工具分段读取，或调整表达式只取需要的字段）`
    : `\n\n（结果共 ${totalChars} 字符，超出单次返回上限且未能保存到工作区；上为前 ${value.length} 字符预览，请调整表达式缩小返回量）`
  : "";
return { content: [{ type: "text", text: head + tail }], details: { mode, ...(savedPath ? { savedPath } : {}) } };
```

**文案三要素**（缺一不可）：
- 告诉模型**总量**（`totalChars`）——否则它不知道自己缺了多少；
- 给出**路径**——否则它不知道能读；
- 给出**两个可行动动作**（read 分段 / 缩小表达式）。

### 步骤 4：接线与注入

文件：`src/main/pi-runtime.ts`（对齐已有 `saveScreenshot: (data, mimeType) => saveBrowserScreenshot(recordWorkspace, data, mimeType)` 的写法，约 2550 行处）

```ts
saveEvalResult: (text, isJson) => saveBrowserEvalResult(recordWorkspace, text, isJson)
```

**无工作区时**（`recordWorkspace` 为空）应返回 undefined 类型或抛错被捕获 →
走步骤 3 的「未能保存」分支，**不阻塞 eval 本身**。

### 步骤 5：工具描述更新（谨慎）

`browser_eval` 的 description 现含「返回值序列化为文本、上限约 8000 字符，请返回紧凑 JSON」。
建议改为：

> 「返回值序列化为文本；超过约 8000 字符时会**自动保存到工作区**并在结果里给出路径（可用 read 分段读取），回执只带前 8000 字符预览。」

**注意**：description 是**每请求前缀**（工具数组成本），本次仅改一句话，长度基本持平；
不要顺手加别的说明（`AGENTS.md` 的 prompt-diet 纪律）。

### 步骤 6：测试

文件：**新建** `src/main/browser-eval-result.test.ts`（对齐 `browser-screenshot.test.ts`）

用例（≥6 例）：
1. 正常写入并返回工作区相对路径（正斜杠）；
2. 工作区越界（`..`）拒绝/规范化到工作区内；
3. 同毫秒连续两次写入不覆盖（`-1` 后缀）；
4. 保留策略：写入 25 个后仅剩 20 个，且保留的是最新的；
5. `.json` / `.txt` 扩展名按 `isJson` 决定；
6. 目录不存在时自动创建。

`src/main/browser-automation.test.ts` 补 2 例（纯逻辑）：
- 超阈值 + 有 `saveEvalResult` → 结果带 `totalChars` 与 `savedPath`；
- 超阈值 + **无** `saveEvalResult` → 只带 `totalChars`，`value` 仍被截断，不抛错。

`src/main/runtime-browser.test.ts` 补 2 例：三种文案分支（无溢出 / 有路径 / 无路径）。

## 验证方式

1. `npm test` 全绿（新增约 10 例）。
2. `npm run build` 全绿。
3. 真机冒烟：
   - `browser_eval` 执行 `JSON.stringify(Array.from({length:2000},(_,i)=>({id:i,name:'item'+i})))`
     → 回执含「结果共 N 字符，已完整保存到 `.pidesktop/eval/eval-*.json`」；
   - 用 `read` 工具按该路径读取 → 内容为完整合法 JSON（可 `JSON.parse` 验证）；
   - 小结果（< 8000 字符）→ 回执与现状逐字一致，无新增文案。
4. 边界：工作区未打开时调同样的大结果 → 走「未能保存」文案，**不报错**。

## 风险与假设

| 风险 | 对策 |
|---|---|
| 磁盘增长 | 保留 20 个 + 文件名时间序裁剪（复用截图纪律）；`.pidesktop/` 已在 `.gitignore` |
| 落盘失败影响主流程 | **必须** try/catch 降级为纯截断；落盘是增强不是前置条件 |
| 预览仍可能切在 JSON 中间 | **这是可接受的**——因为模型现在知道了总量与完整路径，可自行决定是否读全。若要更友好，可把预览切在最后一个完整 `}`/`]`，但那是额外复杂度，**本轮不做** |
| `totalChars` 语义 | 是**字符数**不是 token 数。文案已写「字符」，不要写成 token |
| 与 A1（弹窗）同改 `protocol.ts` | 两项都要改 `BrowserAutomationData` 的相邻行，**建议 A2 先做**（A2 只改 eval 分支，A1 改结果外壳），冲突面小 |

## 完成后收尾

1. `docs/迭代记录.md`：待办移入已完成，写实现摘要（含测试数、build、冒烟结论）。
2. 提交：`feat(browser): browser_eval 大结果落盘——回执带总量与完整路径`。
3. `AGENTS.md` 的 Browser automation 段落补一句（该段落是本项目架构文档的唯一权威描述，
   现有段落已描述截图落盘，同规格追加 eval 落盘一句）。
