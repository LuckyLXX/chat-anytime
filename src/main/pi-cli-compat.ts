import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import type { AccessMode, ExecutionPrincipal, PermissionDecision, ProviderSettings, ThinkingLevel } from "../shared/protocol.js";

export const PI_CLI_BROKER_ENV = "PI_DESKTOP_CLI_BROKER";
export const PI_CLI_SHIM_ENV = "PI_DESKTOP_CLI_SHIM";
export const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";

export interface PiCliHostConfig {
  agentDir: string;
  model?: { provider: string; id: string };
  thinkingLevel: ThinkingLevel;
  accessMode: AccessMode;
  parentSessionId?: string;
  providers: Array<Pick<ProviderSettings, "id" | "name" | "baseUrl" | "models">>;
  apiKeys: Record<string, string>;
}

export interface PiCliPermissionRequest {
  accessMode: AccessMode;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  risk: "write" | "command" | "outside-workspace";
  principal: ExecutionPrincipal;
}

export interface PiCliRunRequest {
  argv: string[];
  cwd: string;
}

export type PiCliRunEventSink = (event: unknown) => void;
export type PiCliRunErrorSink = (message: string) => void;

export type PiCliRunHandler = (
  request: PiCliRunRequest,
  emit: PiCliRunEventSink,
  signal: AbortSignal,
  reportError: PiCliRunErrorSink
) => Promise<number>;

type BrokerRequest =
  | {
      type: "config";
      token: string;
    }
  | {
      type: "permission";
      token: string;
      request: PiCliPermissionRequest;
    }
  | {
      type: "run";
      token: string;
      request: PiCliRunRequest;
    };

interface BrokerResponse {
  ok: boolean;
  config?: PiCliHostConfig;
  decision?: PermissionDecision;
  error?: string;
}

type BrokerStreamFrame =
  | { type: "event"; event: unknown }
  | { type: "error"; error: string }
  | { type: "exit"; code: number };

interface BrokerAddress {
  host: string;
  port: number;
  token: string;
}

const MAX_BROKER_REQUEST_BYTES = 2 * 1024 * 1024;
const PI_CLI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

let cliShimLaunchPath: { entryPath: string; launchPath: string } | undefined;

function parseBrokerAddress(value: string | undefined): BrokerAddress | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<BrokerAddress>;
    if (typeof parsed.host !== "string" || !parsed.host || typeof parsed.port !== "number" || !Number.isInteger(parsed.port) || parsed.port < 1 || typeof parsed.token !== "string" || !parsed.token) return undefined;
    return { host: parsed.host, port: parsed.port, token: parsed.token };
  } catch {
    return undefined;
  }
}

function randomToken(): string {
  return `${randomUUID()}-${randomBytes(16).toString("hex")}`;
}

function writeBrokerResponse(socket: Socket, response: BrokerResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function writeBrokerFrame(socket: Socket, frame: BrokerStreamFrame): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Keeps provider configuration in the utility process and exposes it to the
 * short-lived CLI shim over a loopback socket. The broker address contains no
 * provider secret; the secret only crosses the authenticated in-memory hop.
 */
export class PiCliHostBroker {
  private server?: Server;
  private address?: BrokerAddress;

  constructor(
    private readonly getConfig: () => PiCliHostConfig,
    private readonly requestPermission?: (request: PiCliPermissionRequest) => Promise<PermissionDecision>,
    private readonly runCli?: PiCliRunHandler
  ) {}

  async start(): Promise<void> {
    if (this.server && this.address) return;

    const token = randomToken();
    const server = createServer((socket) => this.handleConnection(socket, token));
    await new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    const rawAddress = server.address();
    if (!rawAddress || typeof rawAddress === "string") {
      server.close();
      throw new Error("无法建立 Pi CLI 兼容宿主的本地通道");
    }
    const address = rawAddress as AddressInfo;
    this.server = server;
    this.address = { host: "127.0.0.1", port: address.port, token };
  }

  environment(): Record<string, string> {
    if (!this.address) throw new Error("Pi CLI 兼容宿主尚未启动");
    return {
      [PI_CLI_BROKER_ENV]: JSON.stringify(this.address),
      [PI_CLI_SHIM_ENV]: "1",
      [ELECTRON_RUN_AS_NODE_ENV]: "1"
    };
  }

  dispose(): void {
    this.address = undefined;
    this.server?.close();
    this.server = undefined;
  }

  private handleConnection(socket: Socket, token: string): void {
    let buffer = "";
    let handled = false;
    const close = (): void => { socket.destroy(); };
    socket.setEncoding("utf8");
    socket.setTimeout(5000, close);
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (buffer.length > MAX_BROKER_REQUEST_BYTES) close();
        return;
      }
      if (newline > MAX_BROKER_REQUEST_BYTES) {
        close();
        return;
      }
      socket.removeListener("timeout", close);
      const line = buffer.slice(0, newline).trim();
      handled = true;
      try {
        const request = JSON.parse(line) as BrokerRequest;
        if (request.token !== token) {
          writeBrokerResponse(socket, { ok: false, error: "Pi CLI 兼容宿主鉴权失败" });
          return;
        }
        if (request.type === "permission") {
          if (!this.requestPermission) {
            writeBrokerResponse(socket, { ok: false, error: "Pi CLI 兼容宿主未连接权限 Broker" });
            return;
          }
          void this.requestPermission(request.request)
            .then((decision) => writeBrokerResponse(socket, { ok: true, decision }))
            .catch((error: unknown) => writeBrokerResponse(socket, { ok: false, error: error instanceof Error ? error.message : String(error) }));
          return;
        }
        if (request.type === "run") {
          if (!this.runCli) {
            writeBrokerResponse(socket, { ok: false, error: "Pi CLI 兼容宿主未连接运行时" });
            return;
          }
          socket.setTimeout(0);
          const controller = new AbortController();
          const onClose = (): void => controller.abort();
          socket.once("close", onClose);
          void this.runCli(
            request.request,
            (event) => writeBrokerFrame(socket, { type: "event", event }),
            controller.signal,
            (error) => writeBrokerFrame(socket, { type: "error", error })
          )
            .then((code) => {
              socket.off("close", onClose);
              writeBrokerFrame(socket, { type: "exit", code });
              if (!socket.destroyed) socket.end();
            })
            .catch((error: unknown) => {
              socket.off("close", onClose);
              writeBrokerFrame(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
              writeBrokerFrame(socket, { type: "exit", code: 1 });
              if (!socket.destroyed) socket.end();
            });
          return;
        }
        writeBrokerResponse(socket, { ok: true, config: this.getConfig() });
      } catch {
        writeBrokerResponse(socket, { ok: false, error: "Pi CLI 兼容宿主请求无效" });
      }
    });
    socket.on("error", () => undefined);
  }
}

export function configurePiCliShim(entryPath: string, broker: PiCliHostBroker): void {
  const resolvedEntryPath = resolve(entryPath);
  // The official subagent extension derives its child command from
  // process.argv[1]. Its current resolver only accepts an entry below the
  // Pi coding-agent package root, so the real bundled entry needs a tiny
  // package-shaped launcher. The launcher imports this app's entry and keeps
  // the child on the authenticated broker path instead of falling back to a
  // separately installed `pi` executable.
  if (!cliShimLaunchPath || cliShimLaunchPath.entryPath !== resolvedEntryPath) {
    const packageDir = join(tmpdir(), `pidesktop-pi-cli-${process.pid}-${randomUUID()}`);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({
      name: PI_CLI_PACKAGE_NAME,
      private: true,
      type: "module",
      piConfig: { configDir: ".pi" }
    }), "utf8");
    const launchPath = join(packageDir, "pi-cli-host.js");
    writeFileSync(launchPath, `import ${JSON.stringify(pathToFileURL(resolvedEntryPath).href)};\n`, "utf8");
    cliShimLaunchPath = { entryPath: resolvedEntryPath, launchPath };
  }
  process.argv[1] = cliShimLaunchPath.launchPath;
  Object.assign(process.env, broker.environment());
}

export function resolvePiCliShimPath(runtimeScriptPath: string | undefined, fallbackUrl: string): string {
  const basePath = runtimeScriptPath ? resolve(runtimeScriptPath) : resolve(new URL(fallbackUrl).pathname);
  return resolve(dirname(basePath), "pi-cli-host.js");
}

export async function requestPiCliHostConfig(): Promise<PiCliHostConfig> {
  const address = parseBrokerAddress(process.env[PI_CLI_BROKER_ENV]);
  if (!address) throw new Error("Pi CLI 兼容宿主未提供有效的运行时通道");

  return new Promise((resolveConfig, reject) => {
    const socket = createConnection({ host: address.host, port: address.port });
    let buffer = "";
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("Pi CLI 兼容宿主响应超时")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "config", token: address.token } satisfies BrokerRequest)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        if (!response.ok || !response.config) throw new Error(response.error ?? "Pi CLI 兼容宿主没有返回配置");
        settle(() => resolveConfig(response.config!));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      } finally {
        socket.end();
      }
    });
    socket.on("error", (error) => settle(() => reject(error)));
  });
}

export async function requestPiCliPermission(request: PiCliPermissionRequest): Promise<PermissionDecision> {
  const address = parseBrokerAddress(process.env[PI_CLI_BROKER_ENV]);
  if (!address) throw new Error("Pi CLI 兼容宿主未提供有效的权限通道");

  return new Promise((resolveDecision, reject) => {
    const socket = createConnection({ host: address.host, port: address.port });
    let buffer = "";
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(5 * 60 * 1000, () => socket.destroy(new Error("Pi CLI 权限请求超时")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "permission", token: address.token, request } satisfies BrokerRequest)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as BrokerResponse;
        if (!response.ok || !response.decision) throw new Error(response.error ?? "Pi CLI 权限 Broker 没有返回决定");
        settle(() => resolveDecision(response.decision!));
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      } finally {
        socket.end();
      }
    });
    socket.on("error", (error) => settle(() => reject(error)));
  });
}

export async function requestPiCliRun(
  request: PiCliRunRequest,
  emit: PiCliRunEventSink,
  onError: (message: string) => void = () => undefined
): Promise<number> {
  const address = parseBrokerAddress(process.env[PI_CLI_BROKER_ENV]);
  if (!address) throw new Error("Pi CLI 兼容宿主未提供有效的运行时通道");

  return new Promise((resolveRun, reject) => {
    const socket = createConnection({ host: address.host, port: address.port });
    let buffer = "";
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };
    const fail = (error: unknown): void => settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    socket.setEncoding("utf8");
    socket.setTimeout(5 * 60 * 1000, () => socket.destroy(new Error("Pi CLI 兼容宿主运行超时")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "run", token: address.token, request } satisfies BrokerRequest)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as BrokerStreamFrame;
          if (frame.type === "event") {
            emit(frame.event);
          } else if (frame.type === "error") {
            onError(frame.error);
          } else if (frame.type === "exit") {
            settle(() => resolveRun(frame.code));
            socket.end();
            return;
          }
        } catch (error) {
          fail(error);
          return;
        }
      }
    });
    socket.on("end", () => {
      if (!settled) fail(new Error("Pi CLI 兼容宿主在运行完成前断开连接"));
    });
    socket.on("error", fail);
  });
}

export function isPiCliShimProcess(): boolean {
  return process.env[PI_CLI_SHIM_ENV] === "1";
}
