import type { PermissionRequest } from "../shared/protocol.js";

/** bootstrap 权限镜像的单项参数显示上限（不改变 utility broker 的原始参数）。 */
export const MAX_PERMISSION_PREVIEW_BYTES = 8 * 1024;

export function previewPermissionRequest(request: PermissionRequest): PermissionRequest {
  let serialized: string;
  try { serialized = JSON.stringify(request.args) ?? "null"; }
  catch { return { ...request, args: "（参数无法序列化）" }; }
  const bytes = Buffer.from(serialized, "utf8");
  const args = bytes.byteLength > MAX_PERMISSION_PREVIEW_BYTES
    ? `${bytes.subarray(0, MAX_PERMISSION_PREVIEW_BYTES).toString("utf8")}\n（参数预览已截断）`
    : JSON.parse(serialized) as unknown;
  return { ...request, args };
}

/** main 只镜像待决展示，不参与 broker 的真实裁决。 */
export class PendingPermissionMirror {
  private requests: PermissionRequest[] = [];

  record(request: PermissionRequest): void {
    this.requests = [...this.requests.filter((item) => item.id !== request.id), previewPermissionRequest(request)];
  }

  dismiss(id: string): void {
    this.requests = this.requests.filter((item) => item.id !== id);
  }

  list(): PermissionRequest[] {
    return structuredClone(this.requests);
  }

  clear(): void {
    this.requests = [];
  }
}
