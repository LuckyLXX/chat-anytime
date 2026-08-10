import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  fingerprint: string;
  enabled: boolean;
}

interface ApprovalFile {
  version: 2;
  extensions: StoredApproval[];
}

export interface ExtensionCandidateRecord {
  summary: ExtensionSummary;
  path: string;
  fingerprint?: string;
}

async function fingerprint(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
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
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as { version?: number; extensions?: Array<Partial<StoredApproval>> };
      if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.extensions)) return;
      for (const item of raw.extensions) {
        if (!item || typeof item.id !== "string" || typeof item.path !== "string" || typeof item.approvedAt !== "number") continue;
        const stored = item as Partial<StoredApproval>;
        this.approvals.set(item.id, {
          id: item.id,
          path: item.path,
          approvedAt: item.approvedAt,
          fingerprint: typeof stored.fingerprint === "string" ? stored.fingerprint : "",
          enabled: stored.enabled !== false
        });
      }
    } catch {
      // A missing or corrupt approval file is fail-closed.
    }
  }

  setCandidates(candidates: ExtensionCandidateRecord[]): void {
    this.candidates = new Map(candidates.map((candidate) => [candidate.summary.id, candidate]));
  }

  async refreshFingerprints(): Promise<void> {
    await Promise.all([...this.candidates.values()].map(async (candidate) => {
      candidate.fingerprint = await fingerprint(candidate.path);
    }));
  }

  private validApproval(candidate: ExtensionCandidateRecord): StoredApproval | undefined {
    const approval = this.approvals.get(candidate.summary.id);
    if (!approval || approval.path !== candidate.path || !candidate.fingerprint || approval.fingerprint !== candidate.fingerprint) return undefined;
    return approval;
  }

  candidateSummaries(): ExtensionSummary[] {
    return [...this.candidates.values()].map((candidate) => {
      const storedApproval = this.approvals.get(candidate.summary.id);
      const approval = this.validApproval(candidate);
      return {
        ...candidate.summary,
        trust: approval ? "trusted" : "undecided",
        enabled: approval?.enabled === true,
        approvalChanged: Boolean(storedApproval && !approval)
      };
    });
  }

  approvedIds(): string[] {
    return [...this.candidates.values()].filter((candidate) => Boolean(this.validApproval(candidate))).map((candidate) => candidate.summary.id);
  }

  approvedPaths(): string[] {
    return [...this.candidates.values()].flatMap((candidate) => this.validApproval(candidate)?.enabled ? [candidate.path] : []);
  }

  async approve(id: string): Promise<boolean> {
    const candidate = this.candidates.get(id);
    if (!candidate) return false;
    const digest = await fingerprint(candidate.path);
    if (!digest) throw new Error("扩展路径已不存在或无法读取，请重新安装或重载资源");
    candidate.fingerprint = digest;
    this.approvals.set(id, { id, path: candidate.path, approvedAt: Date.now(), fingerprint: digest, enabled: true });
    await this.save();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const candidate = this.candidates.get(id);
    const approval = candidate ? this.validApproval(candidate) : undefined;
    if (!approval) return false;
    approval.enabled = enabled;
    await this.save();
    return true;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.approvals.delete(id)) return false;
    await this.save();
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    const data: ApprovalFile = { version: 2, extensions: [...this.approvals.values()] };
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }
}
