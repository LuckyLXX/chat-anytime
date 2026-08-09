import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DefaultPackageManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionOrigin,
  ExtensionSummary,
  McpServerSummary,
  PackageSummary,
  ResourceCatalog,
  ResourceScope,
  SkillSummary
} from "../shared/protocol.js";

type ResourceLoaderCatalog = Pick<DefaultResourceLoader, "getExtensions" | "getSkills">;
type PackageManagerCatalog = Pick<DefaultPackageManager, "listConfiguredPackages">;

export interface ResourceCatalogInput {
  resourceLoader?: ResourceLoaderCatalog;
  packageManager?: PackageManagerCatalog;
  mcpServers: McpServerSummary[];
  mcpAdapterLoaded: boolean;
  extensionCandidates?: ExtensionSummary[];
  trustedExtensionIds?: string[];
}

export interface ResourceCatalogResult {
  resources: ResourceCatalog;
  mcpAdapterLoaded: boolean;
}

export const emptyResourceCatalog: ResourceCatalog = {
  skills: [],
  extensions: [],
  packages: [],
  mcpServers: [],
  mcpAdapterLoaded: false,
  diagnostics: []
};

function resourceScope(scope: string | undefined, origin: string | undefined): ResourceScope {
  if (origin === "package") return "package";
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  if (scope === "temporary") return "temporary";
  return "unknown";
}

function extensionScope(scope: string | undefined, origin: ExtensionOrigin): ResourceScope {
  if (origin === "bundled") return "bundled";
  if (origin === "package") return "package";
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  if (scope === "temporary") return "temporary";
  return "unknown";
}

function extensionOrigin(path: string, resolvedPath: string, origin: string | undefined): ExtensionOrigin {
  if (path.startsWith("<inline:") || resolvedPath.toLowerCase().includes("pi-mcp-adapter")) return "bundled";
  if (origin === "package") return "package";
  return resolvedPath ? "local" : "unknown";
}

function resourceSource(source: string | undefined, scope: ResourceScope, origin?: string): string {
  if (origin === "package" && source && /^(?:npm:|git:|https?:|ssh:)/u.test(source)) return source;
  if (source === "cli") return "临时资源";
  if (source?.startsWith("<inline:")) return "PiDesktop 内置";
  if (scope === "project") return "当前项目";
  if (scope === "global") return "用户资源";
  if (scope === "package") return "Pi Package";
  return "PiDesktop";
}

function isSafePackageSource(source: string): boolean {
  return /^(?:npm:|git:|https?:|ssh:)[^\r\n]+$/u.test(source);
}

function sanitizeResourceError(message: string): string {
  return message.replace(/[A-Za-z]:[\\/][^\r\n\s]*/gu, "[本地路径]").replace(/\\\\[^\r\n\s]+/gu, "[本地路径]");
}

function resourceExtensionDigest(identity: string): string {
  return createHash("sha256").update(identity.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 20);
}

export function resourceExtensionId(origin: ExtensionOrigin, scope: ResourceScope, identity: string): string {
  return `${origin}:${scope}:${resourceExtensionDigest(identity)}`;
}

export function buildResourceCatalog(input: ResourceCatalogInput): ResourceCatalogResult {
  if (!input.resourceLoader) {
    return {
      resources: { ...structuredClone(emptyResourceCatalog), extensions: structuredClone(input.extensionCandidates ?? []) },
      mcpAdapterLoaded: false
    };
  }

  const skillResult = input.resourceLoader.getSkills();
  const extensionResult = input.resourceLoader.getExtensions();
  let mcpAdapterLoaded = input.mcpAdapterLoaded;
  const trustedExtensionIds = new Set(input.trustedExtensionIds ?? []);
  const extensionCandidatesByDigest = new Map((input.extensionCandidates ?? []).map((candidate) => [candidate.id.split(":").at(-1), candidate]));

  const skills: SkillSummary[] = skillResult.skills.map((skill) => {
    const scope = resourceScope(skill.sourceInfo.scope, skill.sourceInfo.origin);
    return {
      name: skill.name,
      description: skill.description,
      source: resourceSource(skill.sourceInfo.source, scope, skill.sourceInfo.origin),
      scope,
      disableModelInvocation: skill.disableModelInvocation
    };
  });

  const extensions: ExtensionSummary[] = extensionResult.extensions.map((extension) => {
    const candidate = extensionCandidatesByDigest.get(resourceExtensionDigest(extension.resolvedPath || extension.path));
    const inferredOrigin = extensionOrigin(extension.path, extension.resolvedPath, extension.sourceInfo.origin);
    const origin = candidate?.origin ?? inferredOrigin;
    const scope = candidate?.scope ?? extensionScope(extension.sourceInfo.scope, origin);
    const source = candidate?.source ?? resourceSource(extension.sourceInfo.source, scope, extension.sourceInfo.origin);
    const name = candidate?.name ?? (extension.path.startsWith("<inline:") ? extension.path.slice(8, -1) : basename(extension.path));
    const tools = [...(extension.tools?.keys() ?? [])];
    const commands = [...(extension.commands?.keys() ?? [])];
    if (extension.resolvedPath.toLowerCase().includes("pi-mcp-adapter")) mcpAdapterLoaded = true;
    const id = candidate?.id ?? resourceExtensionId(origin, scope, extension.resolvedPath || extension.path);
    return {
      id,
      name,
      source,
      scope,
      origin,
      trust: origin === "bundled" || trustedExtensionIds.has(id) ? "trusted" : "undecided",
      executionMode: "native",
      enabled: origin === "bundled" || trustedExtensionIds.has(id),
      modelVisible: tools.length > 0,
      compatibility: origin === "bundled" ? "full" : "unknown",
      tools,
      commands,
      loaded: true
    };
  });

  extensionResult.errors.forEach((error, index) => {
    const name = error.path.startsWith("<inline:") ? error.path.slice(8, -1) : basename(error.path);
    extensions.push({
      id: `unknown:unknown:${name}:${index}`,
      name,
      source: "加载失败",
      scope: "unknown",
      origin: "unknown",
      trust: "undecided",
      executionMode: "native",
      enabled: true,
      modelVisible: false,
      compatibility: "unsupported",
      tools: [],
      commands: [],
      loaded: false,
      error: sanitizeResourceError(error.error)
    });
  });

  const packages: PackageSummary[] = input.packageManager?.listConfiguredPackages().map((item) => ({
    source: isSafePackageSource(item.source) ? item.source : `本地 Pi Package（${basename(item.source)}）`,
    scope: item.scope === "project" ? "project" : "global",
    installed: Boolean(item.installedPath),
    removable: isSafePackageSource(item.source)
  })) ?? [];

  if (mcpAdapterLoaded && !packages.some((item) => item.source === "pi-mcp-adapter")) {
    packages.unshift({ source: "pi-mcp-adapter", scope: "bundled", installed: true, removable: false });
  }

  const diagnostics = [
    ...skillResult.diagnostics.map((item) => sanitizeResourceError(item.message)),
    ...extensionResult.errors.map((item) => sanitizeResourceError(item.error))
  ].filter((message, index, list) => Boolean(message) && list.indexOf(message) === index);

  const loadedIds = new Set(extensions.map((extension) => extension.id));
  extensions.push(...(input.extensionCandidates ?? []).filter((extension) => !loadedIds.has(extension.id)));

  return {
    mcpAdapterLoaded,
    resources: {
      skills,
      extensions,
      packages,
      mcpServers: structuredClone(input.mcpServers),
      mcpAdapterLoaded,
      diagnostics
    }
  };
}
