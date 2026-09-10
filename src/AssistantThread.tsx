import { createContext, useContext, type ReactNode } from "react";
import {
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { LoaderCircle } from "lucide-react";
import { DashMark } from "./components";

export const DashToolContext = createContext<{
  content: ReactNode;
  busy: boolean;
  label: string;
}>({ content: null, busy: false, label: "" });
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
function ToolCard(_props: ToolCallMessagePartProps) {
  return (
    <div className="aui-browser-tool" data-testid="aui-browser-tool">
      {useContext(DashToolContext).content}
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
        <DashMark small />
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
