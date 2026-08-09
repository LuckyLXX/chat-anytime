import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiDialogRequest, ExtensionUiResponse } from "../shared/protocol.js";

interface PendingDialog<T> {
  defaultValue: T;
  parse(response: ExtensionUiResponse): T;
  resolve(value: T): void;
  timeout?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export interface DesktopExtensionUiBridgeOptions {
  request(request: ExtensionUiDialogRequest): void;
  dismiss(id: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

function createNeutralTheme(): Theme {
  const identity = (_style: string, text: string): string => text;
  return {
    fg: identity,
    bg: identity,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text
  } as unknown as Theme;
}

export class DesktopExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog<unknown>>();
  private readonly neutralTheme = createNeutralTheme();

  readonly context: ExtensionUIContext = {
    select: (title, options, dialogOptions) => this.createDialog(
      { id: randomUUID(), method: "select", title, options, timeout: dialogOptions?.timeout },
      undefined,
      (response) => response.cancelled ? undefined : response.value,
      dialogOptions?.signal
    ),
    confirm: (title, message, dialogOptions) => this.createDialog(
      { id: randomUUID(), method: "confirm", title, message, timeout: dialogOptions?.timeout },
      false,
      (response) => response.cancelled ? false : response.confirmed === true,
      dialogOptions?.signal
    ),
    input: (title, placeholder, dialogOptions) => this.createDialog(
      { id: randomUUID(), method: "input", title, placeholder, timeout: dialogOptions?.timeout },
      undefined,
      (response) => response.cancelled ? undefined : response.value,
      dialogOptions?.signal
    ),
    editor: (title, prefill) => this.createDialog(
      { id: randomUUID(), method: "editor", title, prefill },
      undefined,
      (response) => response.cancelled ? undefined : response.value
    ),
    notify: (message, level = "info") => this.options.notify(message, level),
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async <T>() => undefined as T,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: this.neutralTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "PiDesktop 不支持扩展切换终端主题" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined
  };

  constructor(private readonly options: DesktopExtensionUiBridgeOptions) {}

  resolve(response: ExtensionUiResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    this.cleanup(response.id, pending);
    pending.resolve(pending.parse(response));
    return true;
  }

  reset(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.cleanup(id, pending);
      pending.resolve(pending.defaultValue);
    }
  }

  private createDialog<T>(
    request: ExtensionUiDialogRequest,
    defaultValue: T,
    parse: (response: ExtensionUiResponse) => T,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    return new Promise((resolve) => {
      const pending: PendingDialog<T> = { defaultValue, parse, resolve };
      if ("timeout" in request && request.timeout) {
        pending.timeout = setTimeout(() => this.dismissWithDefault(request.id), request.timeout);
      }
      if (signal) {
        const abort = (): void => this.dismissWithDefault(request.id);
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(request.id, pending as PendingDialog<unknown>);
      this.options.request(request);
    });
  }

  private dismissWithDefault(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.cleanup(id, pending);
    pending.resolve(pending.defaultValue);
  }

  private cleanup(id: string, pending: PendingDialog<unknown>): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.removeAbortListener?.();
    this.options.dismiss(id);
  }
}
