import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Code2, Mic, Plus, Square } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useDash } from "./useDash";
import { useVoice } from "./useVoice";
import { DashMessages, DashToolContext } from "./AssistantThread";
import { BrowserView, DashMark, TimingPanel } from "./components";
import ApprovalModal from "./ApprovalModal";
import { examples, getStore, money } from "../shared/catalog";

export default function App() {
  const dash = useDash();
  const [input, setInput] = useState(examples[0].prompt);
  const voice = useVoice(setInput);
  const [details, setDetails] = useState(false);
  const [review, setReview] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const task = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const result = dash.result;
  const winner = result?.winner;
  const messageId = `${task.current}-assistant`;
  const toolId = `${task.current}-cart`;
  const elapsed = result ? result.metrics.total : dash.elapsed;
  const submit = (text: string) => {
    if (submitting.current || dash.running || text.trim().length < 3) return;
    voice.finish();
    submitting.current = true;
    task.current = crypto.randomUUID();
    setInput("");
    setReview(false);
    setApprovalError(null);
    void dash.run(text).finally(() => {
      submitting.current = false;
    });
  };
  const reset = () => {
    if (dash.running) return;
    voice.cancel();
    dash.reset();
    setInput(examples[0].prompt);
    setReview(false);
  };
  const messages: ThreadMessageLike[] = dash.prompt
    ? [
        { id: `${task.current}-user`, role: "user", content: dash.prompt },
        {
          id: messageId,
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: toolId,
              toolName: "shop_groceries",
              args: { request: dash.prompt },
              argsText: JSON.stringify({ request: dash.prompt }),
              ...(result ? { result } : {}),
              ...(result?.status === "approval" || result?.status === "ordered"
                ? {
                    approval: {
                      id: result.id,
                      prompt: `Approve sandbox order for ${money(winner!.total)}`,
                      ...(result.status === "ordered"
                        ? { approved: true }
                        : {}),
                    },
                  }
                : {}),
            },
          ],
          status: dash.running
            ? { type: "running" }
            : result?.status === "approval"
              ? { type: "requires-action", reason: "tool-calls" }
              : { type: "complete", reason: "stop" },
        },
      ]
    : [];
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: dash.running,
    isSendDisabled: voice.listening || !dash.health,
    onNew: async (message) =>
      submit(
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ),
    onCancel: async () => {
      await dash.stop();
    },
    onRespondToToolApproval: async (response) => {
      if (!result || response.approvalId !== result.id)
        throw new Error("This approval has expired.");
      if (response.approved) await dash.approve();
    },
  });
  useEffect(() => runtime.thread.composer.setText(input), [input, runtime]);
  const approve = async () => {
    if (!acknowledged || approving) return;
    setApproving(true);
    setApprovalError(null);
    try {
      await runtime.thread
        .getMessageById(messageId)
        .getMessagePartByToolCallId(toolId)
        .respondToToolApproval({ approved: true });
      setReview(false);
    } catch (error) {
      setApprovalError(
        error instanceof Error ? error.message : "Could not confirm the order.",
      );
    } finally {
      setApproving(false);
    }
  };
  const toolContent = (
    <>
      {dash.meta && (
        <div className="preferences">
          {dash.meta.diets.map((diet) => (
            <span key={diet}>{diet}</span>
          ))}
          <span>For {dash.meta.people}</span>
          {dash.meta.budget !== null && <span>Under ${dash.meta.budget}</span>}
        </div>
      )}
      {dash.quotes.length > 0 && (
        <div className="demo-comparison">
          <h3>
            Price comparison <small>including delivery</small>
          </h3>
          {dash.quotes.map((quote) => (
            <div
              key={quote.store}
              className={winner?.store === quote.store ? "selected" : ""}
            >
              <span>{getStore(quote.store).shortName}</span>
              <strong>
                {quote.complete ? money(quote.total) : "Incomplete"}
              </strong>
            </div>
          ))}
        </div>
      )}
      {dash.error && (
        <p className="inline-error" role="alert">
          {dash.error}
        </p>
      )}
      {result?.status === "blocked" && (
        <div className="inline-error" role="alert">
          {result.warnings.map((w) => (
            <p key={w}>{w.replace("UNSUPPORTED:", "")}</p>
          ))}
        </div>
      )}
      {winner && (
        <div className="demo-cart">
          <h2>
            {result?.status === "ordered"
              ? "Order confirmed"
              : "Your cart is ready"}
          </h2>
          <div className="demo-items">
            {winner.items.map((item) => (
              <div key={item.product.id}>
                <span>
                  {item.quantity} × {item.product.name}
                </span>
                <span>{money(item.product.price * item.quantity)}</span>
              </div>
            ))}
          </div>
          <div className="demo-delivery">
            <span>{winner.slot?.label}</span>
            <span>{getStore(winner.store).shortName}</span>
          </div>
          <div className="demo-total">
            <span>Total, including delivery</span>
            <strong>{money(winner.total)}</strong>
          </div>
          {result?.status === "approval" && (
            <button
              className="primary-button"
              onClick={() => {
                setAcknowledged(false);
                setApprovalError(null);
                setReview(true);
              }}
            >
              Review & approve <ArrowRight size={16} />
            </button>
          )}
          {result?.status === "ordered" && (
            <button className="primary-button" onClick={reset}>
              What’s next?
            </button>
          )}
          <p className="demo-fine">
            {result?.status === "ordered"
              ? `Sandbox receipt ${result.receipt?.id}. No payment taken.`
              : "Nothing is purchased until you approve."}
          </p>
        </div>
      )}
    </>
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DashToolContext.Provider
        value={{
          content: toolContent,
          busy: dash.running,
          label: dash.running
            ? "Working in the browser"
            : dash.error || result?.status === "blocked"
              ? "Needs attention"
              : result?.status === "ordered"
                ? "Done"
                : "Ready for your approval",
        }}
      >
        <div className="demo-app" data-assistant-ui="external-store-runtime">
          <header className="demo-header">
            <div>
              <DashMark small />
              <strong>Dash</strong>
              <span>Your browser assistant.</span>
            </div>
            <div>
              <span
                className="demo-provider"
                role="status"
                aria-label={
                  dash.health?.mode === "cerebras"
                    ? "Powered by Cerebras"
                    : "Local planner"
                }
              >
                <span className="status-dot" />
                {dash.health?.mode === "cerebras"
                  ? "Cerebras · Qwen 3.8 27B"
                  : "Local planner"}
              </span>
              <button
                className="icon-button"
                aria-label="New browser task"
                onClick={reset}
                disabled={dash.running}
              >
                <Plus size={18} />
              </button>
            </div>
          </header>
          <ThreadPrimitive.Root>
            <ComposerPrimitive.Root className="demo-composer">
              <ComposerPrimitive.Input
                aria-label="Ask Dash to use the browser"
                placeholder={dash.prompt || "What should I take care of?"}
                onChange={(e) => setInput(e.target.value)}
                submitMode={voice.listening ? "none" : "enter"}
                disabled={dash.running}
                rows={2}
                maxLength={2500}
              />
              {dash.running ? (
                <ComposerPrimitive.Cancel asChild>
                  <button className="demo-submit">
                    <Square size={14} /> Stop
                  </button>
                </ComposerPrimitive.Cancel>
              ) : (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={
                      voice.listening
                        ? "Finish dictation"
                        : "Speak your request"
                    }
                    onClick={voice.listening ? voice.finish : voice.start}
                  >
                    {voice.listening ? <Check size={18} /> : <Mic size={18} />}
                  </button>
                  <ComposerPrimitive.Send asChild>
                    <button
                      className="demo-submit"
                      disabled={
                        voice.listening ||
                        input.trim().length < 3 ||
                        !dash.health
                      }
                    >
                      Run <ArrowRight size={16} />
                    </button>
                  </ComposerPrimitive.Send>
                </>
              )}
            </ComposerPrimitive.Root>
            <div className="demo-input-note">
              {voice.listening
                ? "Listening. Finish dictation, then press Run."
                : "Execution starts only when you submit."}
              {voice.voiceError && (
                <span role="alert"> {voice.voiceError}</span>
              )}
            </div>
            <div className="demo-workspace">
              <main className="demo-browser">
                <BrowserView
                  snapshots={dash.snapshots}
                  activeStore={dash.activeStore}
                  setActiveStore={dash.setActiveStore}
                  running={dash.running}
                  replaying={false}
                  replay={() => {}}
                  stopReplay={() => {}}
                  actions={dash.actions}
                />
                <button
                  className="demo-stats"
                  aria-label="Development timing overlay"
                  onClick={() => setDetails(!details)}
                >
                  <strong data-testid="elapsed-stat">
                    {(elapsed / 1000).toFixed(2)}
                    <small>s</small>
                  </strong>
                  <span>
                    <b>{dash.metrics.actions}</b> browser actions
                  </span>
                  <span>
                    <b>{dash.metrics.modelCalls}</b> model{" "}
                    {dash.metrics.modelCalls === 1 ? "call" : "calls"}
                  </span>
                  <span>
                    <b>
                      {dash.metrics.pages ||
                        (dash.health?.browser.warm ? 3 : 0)}
                    </b>{" "}
                    pages
                  </span>
                  <Code2 size={15} />
                </button>
              </main>
              <aside className="demo-assistant">
                <div className="demo-panel-title">
                  Assistant{" "}
                  <small>
                    {dash.running
                      ? "Working"
                      : result?.status === "approval"
                        ? "Awaiting approval"
                        : result?.status === "ordered"
                          ? "Done"
                          : result
                            ? "Needs attention"
                            : "Ready"}
                  </small>
                </div>
                <ThreadPrimitive.Viewport className="demo-feed">
                  {dash.prompt ? (
                    <DashMessages />
                  ) : (
                    <div className="demo-intro">
                      <h2>What should I take care of?</h2>
                      <p>
                        Give Dash a request and watch it work in the browser.
                        Review the result before any purchase.
                      </p>
                      <p className="demo-fine">
                        This demo uses sandbox sites. No real charges.
                      </p>
                    </div>
                  )}
                </ThreadPrimitive.Viewport>
              </aside>
            </div>
          </ThreadPrimitive.Root>
          <footer className="demo-footer">
            <span>Built with assistant-ui</span>
            <span>Browser automation · Approval before purchase</span>
          </footer>
          {details && (
            <TimingPanel
              metrics={dash.metrics}
              runId={dash.runId}
              running={dash.running}
              elapsed={elapsed}
              mode={dash.health?.mode || "local"}
              clientTiming={dash.clientTiming}
              onClose={() => setDetails(false)}
            />
          )}
          {review && result?.winner && (
            <ApprovalModal
              result={result}
              acknowledged={acknowledged}
              setAcknowledged={setAcknowledged}
              approving={approving}
              error={approvalError}
              approve={approve}
              close={() => {
                if (!approving) setReview(false);
              }}
            />
          )}
        </div>
      </DashToolContext.Provider>
    </AssistantRuntimeProvider>
  );
}
