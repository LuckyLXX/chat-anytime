/**
 * 预览面板（右侧）的 work-area 布局 class（2026-10-28）。
 *
 * 用户现场：收起预览面板时，面板先淡出，聊天区要等退场窗口（180ms）结束才
 * 「迟一步」跳宽，滚动条与消息跟着错位跳一下。根因是布局 class 绑在
 * `useExitPresence.rendered` 上——退场窗口内 class 不换，宽度不动，窗口一过就整块跳。
 *
 * 现在的契约：**形状**（空态 / 有标签）与**开合**解耦，收起态只是同一形状再加
 * `preview-collapsed`，栅格轨道数保持不变。宽度过渡由 styles.css 里注册属性
 * `--preview-open` 驱动（0 = 收起、1 = 展开），面板本体绝对定位、用同一个属性
 * 平移出可视区——所以过渡能逐帧插值，退场动画结束时卸载面板也落在最终布局上。
 *
 * 改动这里必须同步 styles.css「预览面板开合」一节：形状 class 必须始终存在
 *（哪怕面板已卸载），否则收起态退化成单列、下次展开没有可插值的起点。
 */
export function workAreaPreviewClasses(input: { open: boolean; tabs: boolean }): string {
  const shape = input.tabs ? "with-preview" : "with-preview-empty";
  return input.open ? shape : `${shape} preview-collapsed`;
}
