import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DefaultPackageManager, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { buildResourceCatalog, resourceExtensionId } from "./resource-catalog.js";

function resourceLoaderFixture(): Pick<DefaultResourceLoader, "getExtensions" | "getSkills"> {
  return {
    getSkills() {
      return {
        skills: [{
          name: "review",
          description: "Review code",
          filePath: "C:/Users/test/.pi/skills/review/SKILL.md",
          baseDir: "C:/Users/test/.pi/skills/review",
          sourceInfo: { source: "auto", scope: "user", origin: "top-level", path: "C:/Users/test/.pi/skills/review/SKILL.md" },
          disableModelInvocation: false
        }],
        diagnostics: []
      } as ReturnType<DefaultResourceLoader["getSkills"]>;
    },
    getExtensions() {
      return {
        extensions: [{
          path: "<inline:permissions>",
          resolvedPath: "<inline:permissions>",
          sourceInfo: { source: "<inline:permissions>", scope: "temporary", origin: "top-level" },
          tools: new Map(),
          commands: new Map()
        }, {
          path: "index.ts",
          resolvedPath: "C:/Users/test/.pi/agent/extensions/sample/index.ts",
          sourceInfo: { source: "auto", scope: "user", origin: "top-level" },
          tools: new Map([["sample", {}]]),
          commands: new Map([["sample-command", {}]])
        }],
        errors: [{ path: "C:/secret/extensions/broken.ts", error: "Cannot load C:/secret/extensions/broken.ts" }]
      } as ReturnType<DefaultResourceLoader["getExtensions"]>;
    }
  };
}

function packageManagerFixture(): Pick<DefaultPackageManager, "listConfiguredPackages"> {
  return {
    listConfiguredPackages() {
      return [{ source: "npm:sample-extension", scope: "user", installedPath: "C:/packages/sample-extension" }];
    }
  } as Pick<DefaultPackageManager, "listConfiguredPackages">;
}

describe("buildResourceCatalog", () => {
  it("keeps disabled Skills visible and toggleable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-disabled-skill-"));
    const skillDirectory = join(root, "skills", "review");
    const skillPath = join(skillDirectory, "SKILL.md");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(skillPath, "---\nname: review\ndescription: Review code\n---\n\nReview the current changes.\n", "utf8");

    const result = buildResourceCatalog({
      resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) as never, getExtensions: () => ({ extensions: [], errors: [] }) as never },
      skillResources: [{ path: skillPath, enabled: false, metadata: { source: "auto", scope: "user", origin: "top-level", baseDir: root } }],
      workspace: root,
      agentDir: root,
      mcpServers: [],
      mcpAdapterLoaded: false
    });

    expect(result.resources.skills).toEqual([expect.objectContaining({
      name: "review",
      description: "Review code",
      defaultEnabled: false,
      enabled: false,
      toggleable: true
    })]);
  });

  it("keeps discovered extensions as candidates until approval", () => {
    const candidate = {
      id: "local:global:candidate",
      name: "candidate.ts",
      source: "用户资源",
      scope: "global" as const,
      origin: "local" as const,
      trust: "undecided" as const,
      executionMode: "native" as const,
      enabled: false,
      modelVisible: false,
      compatibility: "unknown" as const,
      tools: [],
      commands: [],
      loaded: false
    };

    const result = buildResourceCatalog({
      resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) as never, getExtensions: () => ({ extensions: [], errors: [] }) as never },
      mcpServers: [],
      mcpAdapterLoaded: false,
      extensionCandidates: [candidate]
    });

    expect(result.resources.extensions).toEqual([candidate]);
  });

  it("separates extension origin, trust and runtime state", () => {
    const result = buildResourceCatalog({
      resourceLoader: resourceLoaderFixture(),
      packageManager: packageManagerFixture(),
      mcpServers: [],
      mcpAdapterLoaded: false
    });

    expect(result.resources.extensions[0]).toMatchObject({
      name: "permissions",
      origin: "bundled",
      trust: "trusted",
      executionMode: "native",
      enabled: true,
      modelVisible: false,
      compatibility: "full",
      tools: [],
      commands: [],
      loaded: true
    });
    expect(result.resources.extensions[1]).toMatchObject({
      name: "index.ts",
      scope: "global",
      origin: "local",
      trust: "undecided",
      compatibility: "unknown",
      modelVisible: true,
      tools: ["sample"],
      commands: ["sample-command"]
    });
  });

  it("sanitizes extension errors and retains package metadata", () => {
    const result = buildResourceCatalog({
      resourceLoader: resourceLoaderFixture(),
      packageManager: packageManagerFixture(),
      mcpServers: [],
      mcpAdapterLoaded: false
    });

    expect(result.resources.extensions[2]).toMatchObject({
      loaded: false,
      modelVisible: false,
      compatibility: "unsupported",
      error: "Cannot load [本地路径]"
    });
    expect(result.resources.packages).toEqual([{
      source: "npm:sample-extension",
      scope: "global",
      installed: true,
      removable: true
    }]);
  });

  it("marks configured packages with available updates", () => {
    const result = buildResourceCatalog({
      resourceLoader: resourceLoaderFixture(),
      packageManager: packageManagerFixture(),
      mcpServers: [],
      mcpAdapterLoaded: false,
      availablePackageUpdates: ["npm:sample-extension"]
    });

    expect(result.resources.packages[0]).toMatchObject({ source: "npm:sample-extension", updateAvailable: true });
  });

  it("keeps approved Pi Package extensions in the package scope", () => {
    const resolvedPath = "C:/Users/test/.pi/npm/sample-extension/index.ts";
    const result = buildResourceCatalog({
      resourceLoader: {
        getSkills: () => ({ skills: [], diagnostics: [] }) as never,
        getExtensions: () => ({ extensions: [{
          path: "index.ts",
          resolvedPath,
          sourceInfo: { source: "npm:sample-extension", scope: "package", origin: "package" },
          tools: new Map(),
          commands: new Map()
        }], errors: [] }) as never
      },
      mcpServers: [],
      mcpAdapterLoaded: false,
      trustedExtensionIds: [resourceExtensionId("package", "package", resolvedPath)]
    });

    expect(result.resources.extensions[0]).toMatchObject({ origin: "package", scope: "package", trust: "trusted", enabled: true });
  });

  it("matches an approved package candidate to its CLI-loaded extension without duplicating it", () => {
    const resolvedPath = "C:/Users/test/.pi/npm/pi-subagents/index.ts";
    const id = resourceExtensionId("package", "package", resolvedPath);
    const candidate = {
      id,
      name: "pi-subagents",
      source: "npm:pi-subagents",
      scope: "package" as const,
      origin: "package" as const,
      trust: "trusted" as const,
      executionMode: "native" as const,
      enabled: true,
      modelVisible: false,
      compatibility: "unknown" as const,
      tools: [],
      commands: [],
      loaded: false
    };
    const result = buildResourceCatalog({
      resourceLoader: {
        getSkills: () => ({ skills: [], diagnostics: [] }) as never,
        getExtensions: () => ({ extensions: [{
          path: resolvedPath,
          resolvedPath,
          sourceInfo: { source: "cli", scope: "temporary", origin: "top-level" },
          tools: new Map([["subagent", {}], ["subagent_wait", {}]]),
          commands: new Map()
        }], errors: [] }) as never
      },
      mcpServers: [],
      mcpAdapterLoaded: false,
      extensionCandidates: [candidate],
      trustedExtensionIds: [id]
    });

    expect(result.resources.extensions).toHaveLength(1);
    expect(result.resources.extensions[0]).toMatchObject({
      id,
      name: "pi-subagents",
      source: "npm:pi-subagents",
      origin: "package",
      scope: "package",
      trust: "trusted",
      tools: ["subagent", "subagent_wait"],
      loaded: true
    });
  });
});
