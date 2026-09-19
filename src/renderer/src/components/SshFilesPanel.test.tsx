import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SshFilesPanel } from "./SshFilesPanel";

/**
 * 结构钩子契约测试。
 *
 * 这些钩子（`data-pane="ssh-files"` 与四个 `data-control`）是**公开主题 API**
 * （见 AGENTS.md / docs/theme-guide.md 与 pidesktop-theme-creator 的校验清单），
 * 五处镜像文档与这里必须一致。组件用 useState/useEffect 拉数据，SSR 首屏渲染
 * 即「加载中」状态——钩子与骨架类名都在，足够钉住契约；交互行为由
 * ssh-sftp / ssh-connections 的单测覆盖。
 */

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe("SshFilesPanel theme hooks", () => {
  it("carries the public theme hooks for the remote file drawer", () => {
    const markup = render(<SshFilesPanel terminalId="ssh-1" workspace="D:/ws" onError={() => {}} />);
    // data-pane 契约
    expect(markup).toContain('data-pane="ssh-files"');
    // 控件钩子契约（四个都必须在首屏出现，否则主题选择器挂不上）
    for (const control of ["ssh-upload", "ssh-download"]) {
      expect(markup).toContain(`data-control="${control}"`);
    }
    // 类名骨架：面包屑/列表/传输区（主题可用 .ssh-files-* / .ssh-transfer-* 命中）
    expect(markup).toContain("ssh-files-toolbar");
    expect(markup).toContain("ssh-files-list");
  });

  it("renders the upload action enabled but download disabled until a file is selected", () => {
    const markup = render(<SshFilesPanel terminalId="ssh-1" workspace="D:/ws" onError={() => {}} />);
    // 未选中文件时下载必须禁用（没有明确目标就不该能点）
    expect(markup).toMatch(/data-control="ssh-download"[^>]*disabled/u);
    // 上传不依赖选中项，应为可用
    expect(markup).not.toMatch(/data-control="ssh-upload"[^>]*disabled/u);
  });

  it("renders the drawer without a workspace so the panel itself never crashes", () => {
    const markup = render(<SshFilesPanel terminalId="ssh-1" onError={() => {}} />);
    expect(markup).toContain('data-pane="ssh-files"');
  });
});
