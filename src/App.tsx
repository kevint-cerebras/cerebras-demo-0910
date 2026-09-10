import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, Code2, Mic, Plus, Square } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { InteractivePreview } from "./InteractivePreview";
import { useDash } from "./useDash";
import { useVoice } from "./useVoice";
import { DashMessages, DashToolContext } from "./AssistantThread";
import { BrowserView, DashMark, TimingPanel } from "./components";
import ApprovalModal from "./ApprovalModal";
import { examples, getStore, money } from "../shared/catalog";

function browserPageLabel(page: { url: string; title: string } | null) {
  if (!page) return "Loading homepage…";
  try {
    const url = new URL(page.url);
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      return `${page.title || "Local site"} · localhost`;
  } catch { /* The page can be opening its first URL. */ }
  return page.url;
}

export default function App() {
  const dash = useDash();
  const initialPrompt = new URLSearchParams(window.location.search).get("prompt") || examples[0].prompt;
  const [input, setInput] = useState(initialPrompt);
  const [draftUpdate, setDraftUpdate] = useState({ text: initialPrompt });
  const appliedDraft = useRef<typeof draftUpdate | null>(null);
  const replaceDraft = (text: string) => {
    setInput(text);
    setDraftUpdate({ text });
  };
  const voice = useVoice(replaceDraft);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const followUpInput = useRef<HTMLTextAreaElement>(null);
  const [pastMessages, setPastMessages] = useState<ThreadMessageLike[]>([]);
  const archivedTools = useRef(new Map<string, ReactNode>());
  useEffect(() => { if (followUpOpen) followUpInput.current?.focus(); }, [followUpOpen]);
  const [details, setDetails] = useState(false);
  const [review, setReview] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const task = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const result = dash.result;
  const winner = result?.winner;
  const messageId = `${task.current}-assistant`;
  const toolId = `${task.current}-cart`;
  const elapsed = result ? result.metrics.total : dash.elapsed;
  const submit = (text: string, continuation = false) => {
    if (submitting.current || dash.running || dash.resetting || text.trim().length < 3) return;
    voice.finish();
    if (continuation && result) {
      archivedTools.current.set(toolId, toolContent);
      archivedTools.current.set(`${toolId}-approval`, approvalContent);
      setPastMessages(messages);
    }
    setFollowUp("");
    submitting.current = true;
    task.current = crypto.randomUUID();
    replaceDraft("");
    setReview(false);
    setApprovalError(null);
    void dash.run(text, continuation ? dash.runId : undefined).finally(() => {
      submitting.current = false;
    });
  };
  const reset = () => {
    if (dash.running || dash.resetting) return;
    voice.cancel();
    dash.reset();
    setFollowUpOpen(false);
    setFollowUp("");
    setPastMessages([]);
    archivedTools.current.clear();
    replaceDraft(initialPrompt);
    setReview(false);
  };
  const continueTask = () => {
    voice.cancel();
    replaceDraft("");
    setReview(false);
    setFollowUpOpen(true);
    followUpInput.current?.focus();
  };
  const messages: ThreadMessageLike[] = dash.prompt
    ? [
        ...pastMessages,
        { id: `${task.current}-user`, role: "user", content: dash.prompt },
        {
          id: messageId,
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: toolId,
              toolName: dash.browserMode ? "browse_web" : "shop_groceries",
              args: { request: dash.prompt },
              argsText: JSON.stringify({ request: dash.prompt }),
              ...(result ? { result } : {}),

            },
            ...(result?.summary
              ? [{ type: "text" as const, text: result.summary }]
              : []),
            ...(winner && result ? [{
              type: "tool-call" as const,
              toolCallId: `${toolId}-approval`,
              toolName: "review_and_confirm",
              args: { total: winner.total, store: winner.store },
              argsText: JSON.stringify({ total: winner.total, store: winner.store }),
              ...(result.status === "ordered" ? { result: result.receipt } : {}),
              approval: {
                id: result.id,
                prompt: `Approve sandbox order for ${money(winner.total)}`,
                ...(result.status === "ordered" ? { approved: true } : {}),
              },
            }] : []),
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
    isSendDisabled: voice.listening || dash.resetting || !dash.health,
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
  useEffect(() => {
    if (appliedDraft.current === draftUpdate) return;
    appliedDraft.current = draftUpdate;
    runtime.thread.composer.setText(draftUpdate.text);
  }, [draftUpdate, runtime]);
  const approve = async () => {
    if (!acknowledged || approving) return;
    setApproving(true);
    setApprovalError(null);
    try {
      await runtime.thread
        .getMessageById(messageId)
        .getMessagePartByToolCallId(`${toolId}-approval`)
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
      {dash.browserMode && dash.browserActions.length > 0 && (
        <div className="browser-activity" aria-label="Browser activity">
          {dash.browserActions.map((action, index) => (
            <div key={index}>
              <span>{action.status === "error" ? "!" : "✓"}</span>{" "}
              {action.label}
              {action.error && <span className="inline-error"> — {action.error}</span>}
            </div>
          ))}
        </div>
      )}
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

    </>
  );
  const approvalContent = <>
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
            <button className="primary-button" onClick={continueTask}>
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
  </>;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DashToolContext.Provider
        value={{
          content: toolContent,
          approvalContent,
          archivedTools: archivedTools.current,
          busy: dash.running,
          label: dash.running
            ? "Working in the browser"
            : dash.error || result?.status === "blocked"
              ? "Needs attention"
              : ["ordered", "done"].includes(result?.status || "")
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
                        (!dash.browserMode && dash.health?.browser.warm
                          ? 3
                          : 0)}
                    </b>{" "}
                    pages
                  </span>
                  <Code2 size={15} />
                </button>
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
                disabled={dash.running || dash.resetting}
              >
                <Plus size={18} />
              </button>
            </div>
          </header>
          <ThreadPrimitive.Root className="demo-thread">
            <ComposerPrimitive.Root className="demo-composer">
              <ComposerPrimitive.Input
                ref={composerInput}
                aria-label="Ask Dash to use the browser"
                placeholder="What should I take care of?"
                onChange={(e) => {
                  const text = e.target.value;
                  queueMicrotask(() => setInput(text));
                }}
                submitMode={voice.listening ? "none" : "enter"}
                disabled={dash.running || dash.resetting}
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
                        dash.resetting ||
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
                {dash.browserMode ? (
                  <section
                    className="general-browser"
                    aria-label="Agent browser"
                  >
                    <div className="browser-tab-strip" role="tablist" aria-label="Browser tabs">
                      {dash.browserPage?.tabs?.map(tab => {
                        const activity = Object.values(dash.storeActivity).find(s=>tab.url.endsWith(`/shop/${s.store}`));
                        const activeWork = (dash.running) && (activity ? ["searching","cart"].includes(activity.status) : tab.work ? ["loading","reading"].includes(tab.work) : tab.active);
                        return <button key={tab.id} role="tab" aria-selected={tab.active} className={`browser-tab ${activeWork ? "working" : ""}`} onClick={()=>void dash.selectTab(tab.id)} title={tab.url}>
                          <span>{tab.title.replace(/ · Grocery sandbox$/, "") || "New tab"}</span>
                          {!activity && tab.work && <small>{tab.work === "ready" ? "Page read" : tab.work === "error" ? "Unavailable" : tab.work === "loading" ? "Loading" : "Reading"}</small>}
                          {activity && <small>{activity.status==="searching" ? "Searching prices" : activity.status==="cart" ? "Building cart" : activity.status==="ready" ? `Cart · ${money(activity.total!)}` : activity.status==="checked" ? "Prices checked" : "Interrupted"}</small>}
                        </button>;
                      })}

                    </div>

                    <div className="general-address">
                      {browserPageLabel(dash.browserPage)}
                    </div>
                    {dash.browserPage ? (
                      <InteractivePreview
                        image={dash.browserPage.image}
                        title={dash.browserPage.title || "Browser preview"}
                        disabled={dash.running || dash.resetting}
                        interact={dash.interactBrowser}
                      />
                    ) : (
                      <div className="browser-placeholder">
                        <h3>Opening the browser</h3>
                      </div>
                    )}
                    <div className="general-status">
                      {dash.browserPage?.label || "Preparing your request"}
                    </div>
                  </section>
                ) : (
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
                )}

              </main>
              <aside className="demo-assistant">
                <div className="demo-panel-title">
                  Assistant{" "}
                  <small>
                    {dash.running
                      ? "Working"
                      : result?.status === "approval"
                        ? "Awaiting approval"
                        : ["ordered", "done"].includes(result?.status || "")
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
                        Search, compare, and explore real websites. You can
                        take over the browser whenever the agent is idle.
                      </p>
                    </div>
                  )}
                  {followUpOpen && (
                    <form className="follow-up-composer" onSubmit={e => {e.preventDefault(); submit(followUp, true);}}>
                      <textarea ref={followUpInput} aria-label="Send a follow-up" placeholder="What would you like to do next?" value={followUp} onChange={e=>setFollowUp(e.target.value)} rows={3} maxLength={2500} disabled={dash.running || dash.resetting}
                        onKeyDown={e=>{if(e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing){e.preventDefault();submit(followUp,true)}}}/>
                      <button className="primary-button" type="submit" disabled={dash.running || dash.resetting || followUp.trim().length<3}>Send follow-up <ArrowRight size={16}/></button>
                    </form>
                  )}
                </ThreadPrimitive.Viewport>
              </aside>
            </div>
          </ThreadPrimitive.Root>
          <footer className="demo-footer">
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
