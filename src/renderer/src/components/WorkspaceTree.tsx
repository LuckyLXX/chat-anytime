import { AlertCircle, ChevronRight, FileCode2, File as FileIcon, FileText, Folder, FolderOpen, Image as ImageIcon, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { WorkspaceDirectoryEntry } from "../../../shared/protocol";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"];
const CODE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "cjs", "mjs", "json", "jsonc", "css", "scss", "less", "html", "htm", "py", "go", "rs", "java", "c", "cpp", "cc", "h", "hpp", "cs", "rb", "php", "sh", "bash", "zsh", "yml", "yaml", "toml", "sql", "xml"];

function entryIcon(name: string): ReactNode {
  const ext = name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
  if (IMAGE_EXTENSIONS.includes(ext)) return <ImageIcon size={14} />;
  if (ext === "md" || ext === "markdown" || ext === "mdx") return <FileText size={14} />;
  if (CODE_EXTENSIONS.includes(ext)) return <FileCode2 size={14} />;
  return <FileIcon size={14} />;
}

interface DirectoryRowProps {
  workspace: string;
  relativePath: string;
  name: string;
  depth: number;
  onOpenFile(relativePath: string): void;
}

function DirectoryRow({ workspace, relativePath, name, depth, onOpenFile }: DirectoryRowProps): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = useCallback(async (): Promise<void> => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (entries) return;
    setLoading(true);
    setError(undefined);
    try {
      const listing = await window.piDesktop.listWorkspaceDirectory(workspace, relativePath || undefined);
      setEntries(listing.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取目录");
    } finally {
      setLoading(false);
    }
  }, [expanded, entries, relativePath, workspace]);

  return (
    <div>
      <button className={`workspace-tree-row${expanded ? " expanded" : ""}`} type="button" style={{ paddingLeft: 6 + depth * 13 }} onClick={() => void toggle()} aria-expanded={expanded}>
        <ChevronRight size={13} className={expanded ? "rotated" : ""} />
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{name}</span>
        {loading && <LoaderCircle size={12} className="spinning" />}
      </button>
      {expanded && (
        <div className="workspace-tree-children">
          {error
            ? <div className="workspace-tree-status">读取失败：{error}</div>
            : !entries
              ? null
              : entries.length === 0
                ? <div className="workspace-tree-status">空目录</div>
                : entries.map((entry) => entry.kind === "directory"
                  ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={depth + 1} onOpenFile={onOpenFile} />
                  : <button key={entry.relativePath} className="workspace-tree-row file" type="button" title={entry.relativePath} style={{ paddingLeft: 6 + (depth + 1) * 13 + 13 }} onClick={() => onOpenFile(entry.relativePath)}>
                    {entryIcon(entry.name)}
                    <span>{entry.name}</span>
                  </button>)}
        </div>
      )}
    </div>
  );
}

export function WorkspaceTree({ workspace, onOpenFile }: { workspace: string; onOpenFile(relativePath: string): void }): ReactNode {
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setEntries(undefined);
    window.piDesktop
      .listWorkspaceDirectory(workspace)
      .then((listing) => { if (!cancelled) { setEntries(listing.entries); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : "无法读取目录"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [workspace]);

  return (
    <nav className="workspace-tree" aria-label="工作区文件">
      {error
        ? <div className="workspace-tree-status error"><AlertCircle size={14} />读取失败：{error}</div>
        : loading
          ? <div className="workspace-tree-status"><LoaderCircle size={14} className="spinning" />正在读取工作区…</div>
          : !entries || entries.length === 0
            ? <div className="workspace-tree-status">工作区为空</div>
            : entries.map((entry) => entry.kind === "directory"
              ? <DirectoryRow key={entry.relativePath} workspace={workspace} relativePath={entry.relativePath} name={entry.name} depth={0} onOpenFile={onOpenFile} />
              : <button key={entry.relativePath} className="workspace-tree-row file" type="button" title={entry.relativePath} style={{ paddingLeft: 19 }} onClick={() => onOpenFile(entry.relativePath)}>
                {entryIcon(entry.name)}
                <span>{entry.name}</span>
              </button>)}
    </nav>
  );
}
