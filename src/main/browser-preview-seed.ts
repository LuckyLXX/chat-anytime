// 预置空白文档的判定（纯函数）：新建标签页时主进程会先 `loadURL("about:blank")`
// 建出一个文档，好让 CDP 的文档类命令（Page.enable / Runtime.* / DOM.* …）能正常
// 回包——在**没有任何文档**的全新 renderer 上它们永不回包（真 Electron 探针实测，
// 见 browser-preview.ts 的 createTab 注释与 docs 迭代记录）。
//
// 这次预置不是用户/AI 请求的导航，所以它引发的文档事件（did-navigate /
// did-stop-loading / page-title-updated）绝不能写进面板状态：否则面板会把「初始
// 空白」显示成真实地址、并拿空白页的视口尺寸当页面内容宽去算缩放。

/** 「预置空白文档」自身可能出现的 URL（尚未发生真实导航时的取值）。 */
export function isSeedDocumentUrl(url: string): boolean {
  const value = url.trim();
  return value === "" || value === "about:blank" || value === "about:blank/";
}

/**
 * 该标签页此刻是否仍处于「只有预置空白文档」的阶段。
 * 一旦发生真实导航（navigateTab 把 seeded 置 false），或 URL 已不是 about:blank，
 * 就不再是预置阶段——后续文档事件照常进状态。
 */
export function isSeedPhase(seeded: boolean | undefined, currentUrl: string): boolean {
  return seeded === true && isSeedDocumentUrl(currentUrl);
}

/**
 * 该操作是否会碰到页面文档（= 需要先等预置文档落定）。
 *
 * 分成两类是 2026-09-15 事故的直接教训：「不碰页面的操作依赖页面 CDP 命令」是结构性
 * 错误。tabs(list)/attach/读标签地址与标题全部由主进程状态回答，必须在毫秒级返回，
 * 不能因为目标标签的 renderer 还没准备好文档而跟着一起等。
 */
export function needsPageDocument(request: { op: string; what?: string }): boolean {
  if (request.op === "tabs" || request.op === "attach") return false;
  // get 的 url/title 读的是主进程侧标签属性；只有 what=text 才走页面求值。
  if (request.op === "get") return request.what === "text";
  return true;
}
