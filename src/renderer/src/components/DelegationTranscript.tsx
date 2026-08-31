import { AlertCircle, Bot, ChevronDown, Code2, LoaderCircle, ScrollText, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { ChatMessage, DelegationProgress, DelegationRole, MessageBlock } from "../../../shared/protocol";
import { delegationRoleLabels, toolLabel } from "../../../shared/locale";
import { useDesktopStore } from "../store";
import { RichContent } from "./RichContent";
import { parseDelegateCallArgs } from "../lib/tool-call-preview";
import type { Artifact } from "../lib/content";

/**
 * 子代理完整记录查看（只读弹窗）：请求 subagent.transcript 把 delegations/*.jsonl
 * 转成 ChatMessage[]，按 goal 气泡 + assistant 文本/思考 + 工具调用行的时间线展示。
 * 无 composer/无再生成；markdown 走 RichContent 同一渲染管线。
 */
export function DelegationTranscript({ delegation, onClose, onOpenArtifact }: {
  delegation: DelegationProgress;
  onClose(): void;
  onOpenArtifact(artifact: Artifact): void;
}): ReactNode {
  const childSessionId = delegation.childSessionId;
  const transcript = useDesktopStore((state) => state.transcripts[childSessionId]);
  const transcriptError = useDesktopStore((state) => state.transcriptErrors[childSessionId]);

  useEffect(() => {
    // 打开即请求，且先清掉旧缓存（上次打开的结果/错误），保证本次总是从
    // 「正在读取」起步、不展示陈旧内容；结果按 childSessionId 对齐写入 store。
    useDesktopStore.setState((state) => {
      if (!state.transcripts[childSessionId] && !state.transcriptErrors[childSessionId]) return state;
      const transcripts = { ...state.transcripts };
      delete transcripts[childSessionId];
      const transcriptErrors = { ...state.transcriptErrors };
      delete transcriptErrors[childSessionId];
      return { transcripts, transcriptErrors };
    });
    void window.piDesktop.send({ type: "subagent.transcript", childSessionId, path: delegation.childSessionFile });
  }, [childSessionId, delegation.childSessionFile]);

  const titleParts = [
    delegation.subagentName ? `自定义子智能体「${delegation.subagentName}」` : delegationRoleLabels[delegation.role] ?? delegation.role,
    delegation.model ? `${delegation.model.provider}/${delegation.model.id}` : undefined
  ].filter(Boolean);

  return (
    <div className="modal-backdrop permission-backdrop" onClick={onClose}>
      <div className="delegation-transcript-dialog" data-pane="settings-dialog" role="dialog" aria-modal="true" aria-label="子代理完整记录" onClick={(event) => event.stopPropagation()}>
        <header>
          <div className={`risk-icon ${delegation.subagentColor ? "subagent" : "command"}`}><ScrollText size={20} /></div>
          <div>
            <h2>子代理完整记录</h2>
            <p>{titleParts.join(" · ")}</p>
          </div>
          <button className="icon-button" type="button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="delegation-transcript-body">
          {transcriptError
            ? <div className="delegation-transcript-placeholder"><AlertCircle size={18} /><span>{transcriptError}</span></div>
            : transcript === undefined
              ? <div className="delegation-transcript-placeholder"><LoaderCircle size={18} className="spinning" /><span>正在读取子代理记录…</span></div>
              : transcript.length === 0
                ? <div className="delegation-transcript-placeholder"><span>该子代理会话没有可展示的消息。</span></div>
                : <Timeline messages={transcript} onOpenArtifact={onOpenArtifact} />}
        </div>
      </div>
    </div>
  );
}

function Timeline({ messages, onOpenArtifact }: { messages: ChatMessage[]; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  return (
    <div className="delegation-transcript-timeline">
      {messages.map((message) => (
        <article className={`delegation-transcript-message ${message.role}`} data-role={message.role} key={message.id}>
          <div className="message-avatar pi-avatar">{message.role === "user" ? "委" : <Bot size={15} />}</div>
          <div className="message-body message-bubble">
            {message.blocks.map((block, blockIndex) => (
              <TranscriptBlock key={`${message.id}-${blockIndex}`} block={block} artifactPrefix={`delegation-${message.id}-${blockIndex}`} onOpenArtifact={onOpenArtifact} />
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function TranscriptBlock({ block, artifactPrefix, onOpenArtifact }: { block: MessageBlock; artifactPrefix: string; onOpenArtifact(artifact: Artifact): void }): ReactNode {
  switch (block.type) {
    case "text":
      return block.text ? <RichContent streaming={false} artifactPrefix={artifactPrefix} onOpenArtifact={onOpenArtifact}>{block.text}</RichContent> : null;
    case "thinking":
      return (
        <details className="delegation-transcript-thinking">
          <summary><Bot size={13} /><span>思考过程</span><ChevronDown size={12} /></summary>
          <pre>{block.text}</pre>
        </details>
      );
    case "tool-call": {
      const summary = toolCallRowSummary(block.name, block.arguments);
      return (
        <div className="delegation-transcript-tool">
          <Code2 size={13} />
          <strong>{toolLabel(block.name)}</strong>
          {summary && <span title={summary}>{summary}</span>}
        </div>
      );
    }
    default:
      return null;
  }
}

/** 工具调用行的紧凑摘要：delegate_agent 用 goal 首行，路径型工具用 path，命令型用命令文本。 */
function toolCallRowSummary(name: string, args: unknown): string {
  if (name === "delegate_agent") {
    const preview = parseDelegateCallArgs(args);
    if (preview) {
      const actor = preview.subagent ?? delegationRoleLabels[preview.role as DelegationRole] ?? preview.role;
      return `委派${actor}：${preview.goal}`;
    }
  }
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (typeof record.path === "string") return record.path;
  if (typeof record.command === "string") return record.command.length > 80 ? `${record.command.slice(0, 79)}…` : record.command;
  return "";
}