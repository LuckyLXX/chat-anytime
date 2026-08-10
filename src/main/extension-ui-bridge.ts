import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionWidgetOptions, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionComposerRequest, ExtensionUiDialogRequest, ExtensionUiResponse, ExtensionUiState } from "../shared/protocol.js";

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
  stateChanged?(state: ExtensionUiState): void;
  composer?(request: ExtensionComposerRequest): void;
}

function emptyState(): ExtensionUiState {
  return { statuses: {}, widgets: [], workingVisible: true, unsupported: [] };
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
  private state = emptyState();
  private editorText = "";

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
    onTerminalInput: () => {
      this.markUnsupported("raw-terminal-input");
      return () => undefined;
    },
    setStatus: (key, text) => {
      const statuses = { ...this.state.statuses };
      if (text === undefined) delete statuses[key];
      else statuses[key] = text;
      this.updateState({ statuses });
    },
    setWorkingMessage: (workingMessage) => this.updateState({ workingMessage }),
    setWorkingVisible: (workingVisible) => this.updateState({ workingVisible }),
    setWorkingIndicator: (options?: WorkingIndicatorOptions) => {
      if (options) this.markUnsupported("working-indicator");
    },
    setHiddenThinkingLabel: (hiddenThinkingLabel) => this.updateState({ hiddenThinkingLabel }),
    setWidget: (key: string, content: string[] | ((...args: never[]) => unknown) | undefined, widgetOptions?: ExtensionWidgetOptions) => {
      if (typeof content === "function") {
        this.markUnsupported("component-widget");
        return;
      }
      const widgets = this.state.widgets.filter((widget) => widget.key !== key);
      if (content) widgets.push({ key, lines: [...content], placement: widgetOptions?.placement ?? "aboveEditor" });
      this.updateState({ widgets });
    },
    setFooter: (factory) => {
      if (factory) this.markUnsupported("custom-footer");
    },
    setHeader: (factory) => {
      if (factory) this.markUnsupported("custom-header");
    },
    setTitle: (title) => this.updateState({ title }),
    custom: async <T>() => {
      this.markUnsupported("custom-component");
      return undefined as T;
    },
    pasteToEditor: (text) => {
      this.editorText += text;
      this.options.composer?.({ id: randomUUID(), method: "pasteToEditor", text });
    },
    setEditorText: (text) => {
      this.editorText = text;
      this.options.composer?.({ id: randomUUID(), method: "setEditorText", text });
    },
    getEditorText: () => this.editorText,
    addAutocompleteProvider: () => this.markUnsupported("autocomplete-provider"),
    setEditorComponent: (factory) => {
      if (factory) this.markUnsupported("custom-editor");
    },
    getEditorComponent: () => undefined,
    theme: this.neutralTheme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => {
      this.markUnsupported("tui-theme-switching");
      return { success: false, error: "PiDesktop 不支持扩展切换终端主题" };
    },
    getToolsExpanded: () => false,
    setToolsExpanded: (expanded) => {
      if (expanded) this.markUnsupported("tool-output-expansion");
    }
  };

  constructor(private readonly options: DesktopExtensionUiBridgeOptions) {}

  snapshot(): ExtensionUiState {
    return structuredClone(this.state);
  }

  syncEditorText(text: string): void {
    this.editorText = text;
  }

  resolve(response: ExtensionUiResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    this.cleanup(response.id, pending);
    pending.resolve(pending.parse(response));
    return true;
  }

  cancelPendingDialogs(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.cleanup(id, pending);
      pending.resolve(pending.defaultValue);
    }
  }

  reset(): void {
    this.cancelPendingDialogs();
    this.editorText = "";
    this.state = emptyState();
    this.options.stateChanged?.(this.snapshot());
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

  private updateState(patch: Partial<ExtensionUiState>): void {
    this.state = { ...this.state, ...patch };
    this.options.stateChanged?.(this.snapshot());
  }

  private markUnsupported(capability: string): void {
    if (this.state.unsupported.includes(capability)) return;
    this.updateState({ unsupported: [...this.state.unsupported, capability] });
    this.options.notify(`扩展请求了 PiDesktop 暂不支持的 TUI 能力：${capability}`, "warning");
  }
}
