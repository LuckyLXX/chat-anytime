/**
 * 分屏布局树：递归二叉分割（tmux 式）。叶子 = 一个会话格子；split 节点带
 * 方向（row = 左右，column = 上下）与首个子树的比例（0..1）。所有操作都是
 * 纯函数、返回新树（不可变更新），供 App 的 useState 直接驱动。
 */
export type SplitDirection = "row" | "column";

export type SplitNode =
  | { kind: "leaf"; sessionId: string }
  | { kind: "split"; direction: SplitDirection; ratio: number; children: [SplitNode, SplitNode] };

/** 分屏格子上限（与主进程 MAX_PARKED_SESSIONS 对齐：全部格子常驻不回收）。 */
export const MAX_SPLIT_PANES = 4;

export const SPLIT_RATIO_MIN = 0.15;
export const SPLIT_RATIO_MAX = 0.85;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

export function leafIds(node: SplitNode): string[] {
  if (node.kind === "leaf") return [node.sessionId];
  return [...leafIds(node.children[0]), ...leafIds(node.children[1])];
}

export function countLeaves(node: SplitNode): number {
  return leafIds(node).length;
}

export function firstLeafId(node: SplitNode): string {
  return node.kind === "leaf" ? node.sessionId : firstLeafId(node.children[0]);
}

/**
 * 对焦点叶再分割：新会话固定放在分割方向的第二格（右侧/下方）。焦点会话
 * 不在树中（焦点瞬时错位）时回退到首个叶子，保证操作总有确定落点。
 */
export function addPane(tree: SplitNode | null, focusedSessionId: string | undefined, newSessionId: string, direction: SplitDirection): SplitNode {
  const newLeaf: SplitNode = { kind: "leaf", sessionId: newSessionId };
  if (!tree) {
    const anchor = focusedSessionId ?? newSessionId;
    if (anchor === newSessionId) return newLeaf;
    return { kind: "split", direction, ratio: 0.5, children: [{ kind: "leaf", sessionId: anchor }, newLeaf] };
  }
  const anchorId = focusedSessionId !== undefined && leafIds(tree).includes(focusedSessionId) ? focusedSessionId : firstLeafId(tree);
  return replaceLeaf(tree, anchorId, { kind: "split", direction, ratio: 0.5, children: [{ kind: "leaf", sessionId: anchorId }, newLeaf] } as SplitNode);
}

/** 单子树塌缩：剪掉一个叶子后，只剩单子的 split 节点被其子树取代；剩一个叶子返回 null（退出分屏）。 */
export function removePane(tree: SplitNode, sessionId: string): SplitNode | null {
  if (tree.kind === "leaf") return tree.sessionId === sessionId ? null : tree;
  const left = removePane(tree.children[0], sessionId);
  const right = removePane(tree.children[1], sessionId);
  if (!left) return right;
  if (!right) return left;
  return { ...tree, children: [left, right] };
}

export function replaceLeaf(tree: SplitNode, sessionId: string, next: SplitNode): SplitNode {
  if (tree.kind === "leaf") return tree.sessionId === sessionId ? next : tree;
  return { ...tree, children: [replaceLeaf(tree.children[0], sessionId, next), replaceLeaf(tree.children[1], sessionId, next)] as [SplitNode, SplitNode] };
}

/** 按 split 节点路径（0/1 序列）更新比例；路径越界返回原树。 */
export function updateRatio(tree: SplitNode, path: readonly number[], ratio: number): SplitNode {
  if (tree.kind === "leaf" || path.length === 0) return tree;
  const [head, ...rest] = path;
  if (head !== 0 && head !== 1) return tree;
  if (rest.length === 0) return { ...tree, ratio: clampRatio(ratio) };
  return { ...tree, children: [head === 0 ? updateRatio(tree.children[0], rest, ratio) : tree.children[0], head === 1 ? updateRatio(tree.children[1], rest, ratio) : tree.children[1]] as [SplitNode, SplitNode] };
}

/**
 * 会话消失（删除/换助手）后的修剪：逐个移除失效叶子。全部失效 → null；
 * 返回被移除的 sessionId 列表供调用方注销 watch。
 */
export function pruneToIds(tree: SplitNode | null, validIds: ReadonlySet<string>): { tree: SplitNode | null; removed: string[] } {
  if (!tree) return { tree: null, removed: [] };
  const invalid = leafIds(tree).filter((id) => !validIds.has(id));
  let next: SplitNode | null = tree;
  for (const id of invalid) {
    if (!next) break;
    next = removePane(next, id);
  }
  if (next && next.kind === "leaf") next = null; // 只剩一格即退出分屏
  return { tree: next, removed: invalid };
}

export interface StoredSplitLayout {
  tree: SplitNode;
  focusedPane?: string;
}

/** localStorage 持久化（pidesktop.split-layout）；损坏/超限数据静默丢弃。 */
export function parseStoredSplitLayout(raw: string | null): StoredSplitLayout | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredSplitLayout;
    if (!parsed || typeof parsed !== "object" || !isSplitNode(parsed.tree)) return undefined;
    if (countLeaves(parsed.tree) > MAX_SPLIT_PANES) return undefined;
    if (new Set(leafIds(parsed.tree)).size !== leafIds(parsed.tree).length) return undefined;
    return { tree: parsed.tree, focusedPane: typeof parsed.focusedPane === "string" ? parsed.focusedPane : firstLeafId(parsed.tree) };
  } catch {
    return undefined;
  }
}

function isSplitNode(value: unknown): value is SplitNode {
  if (!value || typeof value !== "object") return false;
  const node = value as SplitNode;
  if (node.kind === "leaf") return typeof node.sessionId === "string" && node.sessionId.length > 0;
  if (node.kind !== "split") return false;
  if (node.direction !== "row" && node.direction !== "column") return false;
  if (typeof node.ratio !== "number" || !Number.isFinite(node.ratio)) return false;
  return Array.isArray(node.children) && node.children.length === 2 && isSplitNode(node.children[0]) && isSplitNode(node.children[1]);
}
