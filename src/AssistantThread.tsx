import { createContext, useContext, type ReactNode } from "react";
import {
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { LoaderCircle } from "lucide-react";
import { MuseAvatar } from "./components";

export const DashToolContext = createContext<{
  content: ReactNode;
  approvalContent: ReactNode;
  archivedTools: Map<string, ReactNode>;
  busy: boolean;
  label: string;
}>({ content: null, approvalContent: null, archivedTools: new Map(), busy: false, label: "" });
function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="user-request"
      data-testid="aui-user-message"
    >
      <span>You</span>
      <div className="aui-user-text">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
function ToolCard(props: ToolCallMessagePartProps) {
  const context = useContext(DashToolContext);
  const review = props.toolName === "review_and_confirm";
  return (
    <div className={review ? "aui-approval-tool" : "aui-browser-tool"} data-testid={review ? "aui-approval-tool" : "aui-browser-tool"}>
      {context.archivedTools.has(props.toolCallId) ? context.archivedTools.get(props.toolCallId) : review ? context.approvalContent : context.content}
    </div>
  );
}
function Markdown() {
  return <MarkdownTextPrimitive className="answer-text" />;
}
function AssistantMessage() {
  const { busy, label } = useContext(DashToolContext);
  return (
    <MessagePrimitive.Root data-testid="aui-assistant-message">
      <div className="assistant-response-label">
        <MuseAvatar />
        <span>{label}</span>
        {busy && <LoaderCircle size={12} className="spin" />}
      </div>
      <MessagePrimitive.Parts
        components={{ Text: Markdown, tools: { Override: ToolCard } }}
      />
    </MessagePrimitive.Root>
  );
}
export function DashMessages() {
  return (
    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
  );
}
