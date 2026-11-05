/**
 * `scripts/rm-guard.mjs` 的类型声明：脚本本体必须保持纯 JS（钩子命令用 `node` 直接跑，
 * 不经过构建），测试与 `tsc --noEmit` 通过这份声明拿到类型。
 */

export interface RmGuardInput {
  command?: string;
  workspace?: string;
  remote?: boolean;
}

export interface RmGuardVerdict {
  block: boolean;
  reason?: string;
  note?: string;
}

export type TargetVerdict =
  | { kind: "root"; display: string }
  | { kind: "remote-root"; display: string }
  | { kind: "outside"; display: string }
  | { kind: "opaque"; display: string }
  | { kind: "inside"; rel: string; display: string };

/** 按 shell 词法切段：返回「命令段」数组，每段是去引号后的 token 数组。 */
export function tokenize(command: string): string[][];
/** 裸文本目标是否等于「整台机器」（`.` `..` `*` `~` `/` 盘符根 等）。 */
export function isRootLikeText(value: string): boolean;
/** 工作区相对路径是否属于白名单（构建/临时产物目录）。 */
export function isAllowlistedRelative(relPath: string): boolean;
/** 判定单个删除目标（工作区内 / 外 / 根 / 远端根 / 无法判定）。 */
export function classifyTarget(target: string, context?: { workspace?: string; remote?: boolean }): TargetVerdict;
/** 主判定：block=true 表示拦，note 表示放行但留痕。 */
export function evaluateDeletion(input?: RmGuardInput): RmGuardVerdict;
