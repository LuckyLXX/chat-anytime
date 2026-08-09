import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionOrigin, ExtensionSummary, ResourceScope } from "../shared/protocol.js";
import { resourceExtensionId } from "./resource-catalog.js";

interface ResolvedExtensionPath {
  path: string;
  enabled: boolean;
  metadata: {
    source?: string;
    scope?: string;
    origin?: string;
  };
}

interface StoredApproval {
  id: string;
  path: string;
  approvedAt: number;
}

interface ApprovalFile {
  version: 1;
  extensions: StoredApproval[];
}

export interface ExtensionCandidateRecord {
  summary: ExtensionSummary;
  path: string;
}

function scopeFor(value: string | undefined, origin: ExtensionOrigin): ResourceScope {
  if (origin === "package") return "package";
  if (value === "user") return "global";
  if (value === "project") return "project";
  if (value === "temporary") return "temporary";
  return "unknown";
}

function originFor(value: string | undefined): ExtensionOrigin {
  return value === "package" ? "package" : value === "top-level" ? "local" : "unknown";
}

function sourceFor(source: string | undefined, scope: ResourceScope): string {
  if (source && /^(?:npm:|git:|https?:|ssh:)/u.test(source)) return source;
  if (scope === "project") return "当前项目";
  if (scope === "global") return "用户资源";
  if (scope === "package") return "Pi Package";
  return "PiDesktop";
}

function extensionName(path: string, source: string | undefined, origin: ExtensionOrigin): string {
  if (origin === "package" && source?.startsWith("npm:")) {
    const packageSpec = source.slice(4).trim();
    if (packageSpec) {
      if (packageSpec.startsWith("@")) {
        const versionAt = packageSpec.indexOf("@", packageSpec.indexOf("/") + 1);
        return versionAt > 0 ? packageSpec.slice(0, versionAt) : packageSpec;
      }
      return packageSpec.split("@", 1)[0] || basename(path);
    }
  }
  return basename(path);
}

export function discoverExtensionCandidates(paths: readonly ResolvedExtensionPath[], bundledPath: string): ExtensionCandidateRecord[] {
  const bundled = bundledPath.replaceAll("\\", "/").toLowerCase();
  return paths.flatMap((item) => {
    if (!item.enabled) return [];
    const normalized = item.path.replaceAll("\\", "/").toLowerCase();
    if (normalized === bundled) return [];
    const origin = originFor(item.metadata.origin);
    const scope = scopeFor(item.metadata.scope, origin);
    const id = resourceExtensionId(origin, scope, item.path);
    return [{
      path: item.path,
      summary: {
        id,
        name: extensionName(item.path, item.metadata.source, origin),
        source: sourceFor(item.metadata.source, scope),
        scope,
        origin,
        trust: "undecided",
        executionMode: "native",
        enabled: false,
        modelVisible: false,
        compatibility: "unknown",
        tools: [],
        commands: [],
        loaded: false
      }
    } satisfies ExtensionCandidateRecord];
  });
}

export class ExtensionPolicy {
  private readonly filePath: string;
  private readonly approvals = new Map<string, StoredApproval>();
  private candidates = new Map<string, ExtensionCandidateRecord>();

  constructor(agentDir: string) {
    this.filePath = join(agentDir, "pidesktop-extension-approvals.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ApprovalFile>;
      if (raw.version !== 1 || !Array.isArray(raw.extensions)) return;
      for (const item of raw.extensions) {
        if (!item || typeof item.id !== "string" || typeof item.path !== "string" || typeof item.approvedAt !== "number") continue;
        this.approvals.set(item.id, { id: item.id, path: item.path, approvedAt: item.approvedAt });
      }
    } catch {
      // A missing or corrupt approval file is fail-closed.
    }
  }

  setCandidates(candidates: ExtensionCandidateRecord[]): void {
    this.candidates = new Map(candidates.map((candidate) => [candidate.summary.id, candidate]));
  }

  candidateSummaries(): ExtensionSummary[] {
    return [...this.candidates.values()].map((candidate) => {
      const approved = this.approvals.has(candidate.summary.id);
      return { ...candidate.summary, trust: approved ? "trusted" : "undecided", enabled: approved };
    });
  }

  approvedIds(): string[] {
    return [...this.approvals.keys()].filter((id) => this.candidates.has(id));
  }

  approvedPaths(): string[] {
    return [...this.approvals.values()].flatMap((approval) => {
      const candidate = this.candidates.get(approval.id);
      return candidate && candidate.path === approval.path ? [candidate.path] : [];
    });
  }

  async approve(id: string): Promise<boolean> {
    const candidate = this.candidates.get(id);
    if (!candidate) return false;
    try {
      await access(candidate.path);
    } catch {
      throw new Error("扩展路径已不存在，请重新安装或重载资源");
    }
    this.approvals.set(id, { id, path: candidate.path, approvedAt: Date.now() });
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    const data: ApprovalFile = { version: 1, extensions: [...this.approvals.values()] };
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }
}
