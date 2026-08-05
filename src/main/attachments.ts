import { isAbsolute, relative, resolve, sep } from "node:path";

export function workspaceRelativeAttachment(workspace: string, attachmentPath: string): string {
  const root = resolve(workspace);
  const candidate = resolve(attachmentPath);
  const value = relative(root, candidate);
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error("附件必须位于当前工作区内");
  return value.replaceAll(sep, "/");
}
