import { createContext, useContext, type ReactNode } from "react";
import {
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

export const DashToolContext = createContext<{
  approvalContent: ReactNode;
  archivedTools: Map<string, ReactNode>;
}>({ approvalContent: null, archivedTools: new Map() });
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
  if (!review) return null;
  return (
    <div className="aui-approval-tool" data-testid="aui-approval-tool">
      {context.archivedTools.has(props.toolCallId)
        ? context.archivedTools.get(props.toolCallId)
        : context.approvalContent}
    </div>
  );
}
function Markdown() {
  return <MarkdownTextPrimitive className="answer-text" />;
}
function AssistantMessage() {
  return (
    <MessagePrimitive.Root data-testid="aui-assistant-message">
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
