import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  Globe2,
  History,
  Info,
  LoaderCircle,
  Mic,
  MousePointer2,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Square,
  X,
  Zap,
} from "lucide-react";
import { examples, money, stores } from "../shared/catalog";
import {
  BrowserView,
  CartReview,
  DashMark,
  ProductArt,
  Quotes,
  StoreMark,
  TaskSteps,
  TimingPanel,
} from "./components";
import ApprovalModal from "./ApprovalModal";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { DashMessages, DashToolContext } from "./AssistantThread";
import { useDash } from "./useDash";
import { useGeneral } from "./useGeneral";
import { useVoice } from "./useVoice";
import type { AgentCallTiming } from "../server/agent";
import "./browser-assistant.css";

const suggestions = [
  {
    title: "Take care of dinner",
    label: "Shop & compare",
    icon: "avocado",
    prompt: examples[0].prompt,
  },
  {
    title: "Explore somewhere new",
    label: "Browse & discover",
    icon: "travel",
    prompt:
      "Open https://en.wikipedia.org/wiki/Lisbon and find three interesting sights for a first-time visitor.",
  },
  {
    title: "Find something good",
    label: "Search & research",
    icon: "recipe",
    prompt:
      "Open https://www.bbcgoodfood.com/recipes/collection/easy-dinner-recipes and find an easy dinner idea.",
  },
];
interface Recent {
  prompt: string;
  at: number;
}
function getRecent(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("dash-browser-history") || "[]");
  } catch {
    return [];
  }
}
function shoppingRequest(text: string) {
  return (
    /\b(?:groceries|grocery|shop|buy|stock up|cart|deliver|ingredients|everything for)\b/i.test(
      text,
    ) &&
    !/https?:|www\.|\.com\b|\b(?:amazon|walmart|instacart|target|costco)\b/i.test(
      text,
    ) &&
    !/\b(?:find|look up|search for|read)\b.*\b(?:recipe|review|article)\b/i.test(
      text,
    )
  );
}
export default function App() {
  const dash = useDash(),
    general = useGeneral();
  const [input, setInput] = useState(""),
    [workflow, setWorkflow] = useState<"shopping" | "general" | null>(null),
    [urlInput, setUrlInput] = useState("");
  const [devOpen, setDevOpen] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [approvalOpen, setApprovalOpen] = useState(false);
  const [approving, setApproving] = useState(false),
    [acknowledged, setAcknowledged] = useState(false),
    [approvalError, setApprovalError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>(getRecent),
    [showPlan, setShowPlan] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    feedRef = useRef<HTMLDivElement>(null);
  const taskKey = useRef("initial");
  const busy = dash.running || general.running;
  const submit = (text = input, session?: string) => {
    if (text.trim().length < 3 || busy) return;
    taskKey.current = crypto.randomUUID();
    setInput("");
    setHistoryOpen(false);
    setApprovalOpen(false);
    const next = [
      { prompt: text, at: Date.now() },
      ...recent.filter((r) => r.prompt !== text),
    ].slice(0, 8);
    setRecent(next);
    localStorage.setItem("dash-browser-history", JSON.stringify(next));
    if (shoppingRequest(text)) {
      setWorkflow("shopping");
      void dash.run(text, session);
    } else {
      setWorkflow("general");
      void (async () => {
        if (session) await fetch(`/api/voice/${session}`, { method: "DELETE" });
        await general.run(text);
      })();
    }
  };
  const voice = useVoice(
    setInput,
    dash.showPreview,
    submit,
    general.showPreview,
  );
  const shopping =
    workflow === "shopping" ||
    (voice.listening && Object.keys(dash.snapshots).length > 0);
  const prompt = shopping ? dash.prompt : general.prompt;
  const result = shopping ? dash.result : null;
  const elapsed = shopping
    ? result && !dash.running
      ? result.metrics.total
      : dash.elapsed
    : general.summary
      ? general.metrics.total
      : general.elapsed;
  const metrics = shopping ? dash.metrics : general.metrics;
  const error = shopping ? dash.error : general.error;
  const mode = dash.health?.mode ?? "local";
  const currentURL = shopping
    ? dash.snapshots[dash.activeStore]?.url
    : general.page?.url;
  const isFresh = !workflow && !voice.listening;
  useEffect(() => setUrlInput(currentURL || ""), [currentURL]);
  useEffect(() => {
    if (feedRef.current && busy)
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [general.actions.length, dash.items.length, busy]);
  const reset = () => {
    if (busy) return;
    voice.cancel();
    dash.reset();
    general.reset();
    setWorkflow(null);
    setInput("");
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const openNative = async () => {
    if (general.running) general.stop();
    try {
      const response = await fetch("/api/browser/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: workflow === "shopping" ? dash.runId : undefined,
        }),
      });
      if (!response.ok)
        throw new Error("This browser has closed. Start a new task.");
    } catch (error) {
      setApprovalError(
        error instanceof Error ? error.message : "Could not show the browser.",
      );
    }
  };
  const stop = () => {
    if (dash.running) void dash.stop();
    if (general.running) general.stop();
    if (voice.listening) voice.cancel();
  };
  const messageId = `${taskKey.current}-assistant`;
  const toolCallId = `${taskKey.current}-browser`;
  const auiMessages = useMemo<ThreadMessageLike[]>(() => {
    if (!prompt || voice.listening) return [];
    const tool = {
      type: "tool-call" as const,
      toolCallId,
      toolName: shopping ? "shop_groceries" : "browse_web",
      args: { request: prompt },
      argsText: JSON.stringify({ request: prompt }),
      ...(result
        ? { result }
        : !shopping && general.summary
          ? { result: { summary: general.summary, metrics: general.metrics } }
          : {}),
      ...(result?.status === "approval" || result?.status === "ordered"
        ? {
            approval: {
              id: result.id,
              prompt: `Approve sandbox order for ${money(result.winner!.total)}`,
              ...(result.status === "ordered" ? { approved: true } : {}),
            },
          }
        : {}),
      ...(error ? { isError: true, result: { error } } : {}),
    };
    return [
      { id: `${taskKey.current}-user`, role: "user", content: prompt },
      {
        id: messageId,
        role: "assistant",
        content: [
          tool,
          ...(!shopping && general.summary
            ? [{ type: "text" as const, text: general.summary }]
            : []),
        ],
        status: busy
          ? { type: "running" }
          : result?.status === "approval"
            ? { type: "requires-action", reason: "tool-calls" }
            : error
              ? { type: "incomplete", reason: "error", error }
              : { type: "complete", reason: "stop" },
        metadata: { custom: { browserMetrics: metrics, nativeBrowser: true } },
      },
    ];
  }, [
    prompt,
    voice.listening,
    shopping,
    result,
    general.summary,
    general.metrics,
    busy,
    error,
    messageId,
    toolCallId,
    metrics,
  ]);
  const runtime = useExternalStoreRuntime({
    messages: auiMessages,
    convertMessage: (message) => message,
    isRunning: busy,
    isSendDisabled: voice.listening || !dash.health,
    onNew: async (message) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      submit(text);
    },
    onCancel: async () => {
      stop();
    },
    onRespondToToolApproval: async (response) => {
      if (!result || response.approvalId !== result.id)
        throw new Error("This approval has expired.");
      if (response.approved) await dash.approve();
    },
  });
  useEffect(() => {
    runtime.thread.composer.setText(input);
  }, [input, runtime]);
  const toolContent = (
    <>
      {shopping && dash.meta && (
        <>
          <div className="task-title-row">
            <h3>{dash.meta.title}</h3>
            <button
              className="icon-button"
              onClick={() => setShowPlan(!showPlan)}
              aria-label="Toggle task steps"
            >
              <ChevronDown size={14} />
            </button>
          </div>
          {showPlan && <TaskSteps stages={dash.stages} result={result} />}
          <div className="preferences">
            {dash.meta.diets.map((d) => (
              <span key={d}>{d}</span>
            ))}
            {dash.meta.budget !== null && (
              <span>Under ${dash.meta.budget}</span>
            )}
            <span>For {dash.meta.people}</span>
          </div>
        </>
      )}
      {!shopping && general.actions.length > 0 && (
        <div className="general-actions">
          {general.actions.slice(-6).map((a, i) => (
            <div key={`${a.at}-${i}`}>
              <Check size={11} />
              <span>
                {a.label === "navigate"
                  ? "Opened a page"
                  : a.label === "read_page"
                    ? "Read the page"
                    : a.label === "click"
                      ? "Followed a page control"
                      : a.label === "fill"
                        ? "Filled in a field"
                        : a.label === "press"
                          ? "Submitted the search"
                          : a.label === "finish"
                            ? "Finished"
                            : a.label}
              </span>
              <small>{(a.at / 1000).toFixed(2)}s</small>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="assistant-error" role="alert">
          <Info size={15} />
          <p>{error}</p>
          <button onClick={() => submit(prompt)}>Try again</button>
        </div>
      )}
      {result?.status === "blocked" && (
        <div className="assistant-error" role="alert">
          <Info size={15} />
          <div>
            <strong>This needs an adjustment.</strong>
            {result.warnings.map((w) => (
              <p key={w}>{w.replace("UNSUPPORTED:", "")}</p>
            ))}
          </div>
        </div>
      )}
      {shopping && dash.quotes.length > 0 && (
        <details className="assistant-comparison">
          <summary>
            Compared 3 stores <span>Including delivery</span>
          </summary>
          <Quotes quotes={dash.quotes} winner={result?.winner?.store} />
        </details>
      )}
      {result?.winner && (
        <CartReview
          result={result}
          onReview={() => {
            setAcknowledged(false);
            setApprovalError(null);
            setApprovalOpen(true);
          }}
          onNew={reset}
        />
      )}
    </>
  );
  const approve = async () => {
    if (!acknowledged || approving) return;
    setApproving(true);
    setApprovalError(null);
    try {
      await runtime.thread
        .getMessageById(messageId)
        .getMessagePartByToolCallId(toolCallId)
        .respondToToolApproval({ approved: true });
      setApprovalOpen(false);
    } catch (error) {
      setApprovalError(
        error instanceof Error
          ? error.message
          : "The order could not be confirmed.",
      );
    } finally {
      setApproving(false);
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (voice.listening) voice.finish();
        else submit();
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setHistoryOpen(false);
        if (!approving) setApprovalOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DashToolContext.Provider
        value={{
          content: toolContent,
          busy,
          label: busy
            ? "On it."
            : result?.status === "ordered"
              ? "Consider it handled."
              : "Here’s where we landed.",
        }}
      >
        <div className="browser-app" data-assistant-ui="external-store-runtime">
          <aside className="browser-rail">
            <button
              className="brand-button"
              onClick={reset}
              disabled={busy}
              aria-label="New browser task"
            >
              <DashMark />
            </button>
            <button
              className="side-button active"
              onClick={reset}
              disabled={busy}
              aria-label="New task"
              title="New task"
            >
              <Plus size={19} />
            </button>
            <button
              className="side-button"
              onClick={() => setHistoryOpen(!historyOpen)}
              aria-label="Recent tasks"
              title="Recent tasks"
            >
              <History size={19} />
            </button>
            <div className="rail-bottom">
              <button
                className={`side-button ${devOpen ? "active" : ""}`}
                onClick={() => setDevOpen(!devOpen)}
                aria-label="Development timing overlay"
                title="Timing breakdown"
              >
                <Code2 size={19} />
              </button>
              <button
                className="side-button"
                onClick={() => setSettingsOpen(true)}
                aria-label="Assistant settings"
                title="Assistant settings"
              >
                <Settings2 size={19} />
              </button>
              <span className="avatar">S</span>
            </div>
          </aside>
          <div className="browser-app-main">
            <header className="universal-header">
              <div className="wordmark">
                dash<span>your browser, with a helping hand</span>
              </div>
              <div className="universal-header-right">
                <button
                  className="native-browser-button"
                  onClick={() => void openNative()}
                >
                  <MousePointer2 size={12} />
                  {busy ? "Take control" : "Open native browser"}
                  <ExternalLink size={10} />
                </button>
                <button
                  className="engine-badge"
                  onClick={() => {
                    setSettingsOpen(true);
                    void dash.refreshHealth();
                  }}
                >
                  <span className="status-dot" />
                  {mode === "cerebras"
                    ? "Powered by Cerebras"
                    : "Local demo mode"}
                  <ChevronDown size={11} />
                </button>
              </div>
            </header>
            <div className="universal-layout">
              <main className="web-surface">
                <div className="universal-toolbar">
                  <div className="toolbar-buttons">
                    <button
                      className="icon-button"
                      aria-label="Start a new browser task"
                      onClick={reset}
                      disabled={busy}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const url = /^https?:\/\//i.test(urlInput)
                        ? urlInput
                        : `https://${urlInput}`;
                      submit(`Open ${url}`);
                    }}
                    className="universal-address"
                  >
                    <Globe2 size={12} />
                    <input
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="Enter a URL, or ask Dash to take you somewhere"
                      aria-label="Browser address"
                      disabled={busy}
                    />
                    {currentURL && (
                      <a
                        href={currentURL}
                        target="_blank"
                        rel="noreferrer"
                        title="Open this page in a separate tab"
                      >
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </form>
                  <span className="warm-pill">
                    <span className="status-dot" />
                    {busy ? "WORKING" : "READY"}
                  </span>
                </div>
                {isFresh ? (
                  <div className="new-tab">
                    <div className="new-tab-emblem">
                      <Globe2 size={37} strokeWidth={1.1} />
                      <DashMark small />
                    </div>
                    <div className="eyebrow">LESS CLICKING. MORE LIVING.</div>
                    <h1>
                      The internet,
                      <br />
                      <em>a little easier.</em>
                    </h1>
                    <p>
                      A helping hand across your browser.
                      <br />
                      Tell Dash what you need. Watch it take care of the tabs.
                    </p>
                    <div className="destination-grid">
                      {suggestions.map((s, i) => (
                        <button
                          key={s.title}
                          className="destination-card"
                          onClick={() => submit(s.prompt)}
                          disabled={!dash.health}
                        >
                          <div className={`destination-art destination-${i}`}>
                            {i === 0 ? (
                              <ProductArt art="avocado" />
                            ) : i === 1 ? (
                              <svg viewBox="0 0 100 100" aria-hidden="true">
                                <path
                                  d="m13 30 26-10 24 11 24-10v53L63 85 39 73 13 83z"
                                  fill="#e7d6b8"
                                />
                                <path
                                  d="M39 20v53m24-42v54"
                                  stroke="#b9a486"
                                  strokeWidth="2"
                                />
                                <path
                                  d="m25 56 17-8 19 12 13-9"
                                  fill="none"
                                  stroke="#a5ad83"
                                  strokeWidth="4"
                                  strokeDasharray="3 3"
                                />
                                <path
                                  d="M67 24c-17 0-20 19 0 37 20-18 17-37 0-37"
                                  fill="#ca7858"
                                />
                                <circle cx="67" cy="37" r="5" fill="#faecd5" />
                              </svg>
                            ) : (
                              <ProductArt art="pasta" name="Dinner ideas" />
                            )}
                          </div>
                          <span>{s.label}</span>
                          <strong>{s.title}</strong>
                          <ArrowRight size={14} />
                        </button>
                      ))}
                    </div>
                    <div className="new-tab-note">
                      <ShieldCheck size={12} /> You’re always in control of the
                      final step.
                    </div>
                  </div>
                ) : shopping ? (
                  <div className="shopping-browser-wrap">
                    <BrowserView
                      snapshots={dash.snapshots}
                      activeStore={dash.activeStore}
                      setActiveStore={dash.setActiveStore}
                      running={dash.running}
                      replaying={dash.replaying}
                      replay={dash.replay}
                      stopReplay={dash.stopReplay}
                      actions={dash.actions}
                      voiceLabel={
                        voice.listening ? voice.previewLabel : undefined
                      }
                    />
                    <div className="site-disclosure">
                      Shopping demo · fictional stores, real DOM interactions ·
                      no real charges
                    </div>
                  </div>
                ) : (
                  <div className="general-browser-view">
                    {general.page ? (
                      <>
                        <img
                          src={general.page.image}
                          alt={`Live controlled browser: ${general.page.title}`}
                        />
                        <div className="general-page-caption">
                          <span className="status-dot" />
                          {general.page.label}
                          <span>DOM-driven · visual preview only</span>
                        </div>
                      </>
                    ) : (
                      <div className="general-loading">
                        <div className="new-tab-emblem">
                          <Globe2 size={35} strokeWidth={1} />
                          <DashMark small />
                        </div>
                        <h2>
                          {general.running
                            ? "Already on the way."
                            : "Your browser is ready."}
                        </h2>
                        <p>
                          {general.running
                            ? "Opening the web and finding what you asked for."
                            : "Give Dash a destination or an everyday request."}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </main>
              <ThreadPrimitive.Root asChild>
                <aside className="assistant-panel">
                  <div className="assistant-panel-header">
                    <div>
                      <DashMark small />
                      <strong>Dash</strong>
                      <span>Browser assistant</span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={reset}
                      disabled={busy}
                      aria-label="Start new task"
                      title="Start new task"
                    >
                      <Plus size={17} />
                    </button>
                  </div>
                  <ThreadPrimitive.Viewport
                    className="assistant-feed"
                    ref={feedRef}
                  >
                    {isFresh ? (
                      <div className="assistant-intro">
                        <div className="intro-status">
                          <span className="status-dot" /> Here when you need a
                          hand
                        </div>
                        <h2>
                          You say the thing.
                          <br />I do the clicking.
                        </h2>
                        <p>
                          I can browse, find information, compare options, and
                          put a shopping list in a cart.
                        </p>
                        <div className="assistant-capabilities">
                          <span>
                            <Globe2 size={13} /> Across websites
                          </span>
                          <span>
                            <Zap size={13} /> Actions as you speak
                          </span>
                          <span>
                            <ShieldCheck size={13} /> Approval before purchase
                          </span>
                        </div>
                        <div className="voice-hint">
                          <Mic size={15} />
                          <p>
                            Try speaking your request.
                            <br />
                            <span>I can start before you finish.</span>
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        {voice.listening && (
                          <div className="voice-live">
                            <div className="voice-indicator">
                              <span />
                              <span />
                              <span />
                              <span />
                              <span />
                            </div>
                            <h3>Keep talking. I’m on it.</h3>
                            <p>{input || "Tell me what you need…"}</p>
                            <small>{voice.previewLabel}</small>
                            {voice.previewActions > 0 && (
                              <span>
                                {voice.previewActions} browser actions while you
                                speak
                              </span>
                            )}
                          </div>
                        )}
                        {!voice.listening && <DashMessages />}
                      </>
                    )}
                  </ThreadPrimitive.Viewport>
                  {(busy || result || general.summary) && (
                    <button
                      className="assistant-timing-strip"
                      onClick={() => setDevOpen(!devOpen)}
                    >
                      <Zap size={12} />
                      <strong>{(elapsed / 1000).toFixed(2)}s</strong>
                      <span>
                        {metrics.actions} actions · {metrics.modelCalls} model
                        call{metrics.modelCalls !== 1 ? "s" : ""}
                      </span>
                      <Code2 size={13} />
                    </button>
                  )}
                  <ComposerPrimitive.Root
                    className={`universal-composer ${voice.listening ? "listening" : ""}`}
                  >
                    <ComposerPrimitive.Input
                      ref={inputRef}
                      submitMode={voice.listening ? "none" : "enter"}
                      addAttachmentOnPaste={false}
                      onChange={(e) => setInput(e.target.value)}
                      maxLength={2500}
                      aria-label="Ask Dash to use the browser"
                      placeholder={
                        voice.listening
                          ? "Listening…"
                          : "Ask anything. I’ll use the browser."
                      }
                      disabled={busy}
                      rows={3}
                    />
                    <div>
                      <span>
                        {voice.listening
                          ? "Listening · live actions"
                          : busy
                            ? "Working in your browser"
                            : "↵ Send · ⇧↵ New line"}
                      </span>
                      <div>
                        {busy ? (
                          <ComposerPrimitive.Cancel asChild>
                            <button
                              type="button"
                              className="stop-control"
                              aria-label="Stop task"
                            >
                              <Square size={12} fill="currentColor" />
                            </button>
                          </ComposerPrimitive.Cancel>
                        ) : voice.listening ? (
                          <>
                            <button
                              type="button"
                              className="icon-button"
                              onClick={voice.cancel}
                              aria-label="Cancel voice"
                            >
                              <X size={16} />
                            </button>
                            <button
                              type="button"
                              className="send-control"
                              onClick={voice.finish}
                              disabled={input.trim().length < 3}
                              aria-label="Finish speaking"
                            >
                              <Check size={18} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="mic-button"
                              onClick={() => {
                                setWorkflow(null);
                                dash.reset();
                                general.reset();
                                void voice.start();
                              }}
                              aria-label="Speak your request"
                              title="Speak your request"
                            >
                              <Mic size={16} />
                            </button>
                            <ComposerPrimitive.Send asChild>
                              <button
                                type="button"
                                className="send-control"
                                disabled={
                                  input.trim().length < 3 || !dash.health
                                }
                                aria-label="Send request"
                              >
                                <ArrowRight size={17} />
                              </button>
                            </ComposerPrimitive.Send>
                          </>
                        )}
                      </div>
                    </div>
                  </ComposerPrimitive.Root>
                  {voice.voiceError && (
                    <div className="voice-error" role="alert">
                      {voice.voiceError}
                    </div>
                  )}
                  <div className="assistant-panel-footer">
                    <ShieldCheck size={10} />
                    <span>
                      Open native browser to click, type, or take over.
                    </span>
                  </div>
                </aside>
              </ThreadPrimitive.Root>
            </div>
            <footer className="universal-footer">
              <span>
                dash · Built with{" "}
                <a
                  href="https://www.assistant-ui.com"
                  target="_blank"
                  rel="noreferrer"
                >
                  assistant-ui
                </a>
              </span>
              <span>
                {mode === "cerebras"
                  ? dash.health?.model
                  : "Local recipe planner"}{" "}
                · DOM & accessibility control
              </span>
            </footer>
          </div>
          {devOpen &&
            (shopping ? (
              <TimingPanel
                metrics={dash.metrics}
                runId={dash.runId}
                running={dash.running}
                elapsed={dash.elapsed}
                mode={mode}
                clientTiming={dash.clientTiming}
                onClose={() => setDevOpen(false)}
              />
            ) : (
              <GeneralTiming
                metrics={general.metrics}
                elapsed={general.elapsed}
                running={general.running}
                close={() => setDevOpen(false)}
              />
            ))}
          {historyOpen && (
            <div className="history-drawer universal-history">
              <div className="drawer-heading">
                <h2>Recent tasks</h2>
                <button
                  className="icon-button"
                  aria-label="Close history"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="drawer-intro">Pick up another browser task.</p>
              {recent.map((r) => (
                <button
                  className="recent-item"
                  disabled={busy}
                  key={r.at}
                  onClick={() => submit(r.prompt)}
                >
                  <p>{r.prompt}</p>
                  <small>
                    {new Date(r.at).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </small>
                </button>
              ))}
              {!recent.length && (
                <p className="drawer-intro">Your requests will appear here.</p>
              )}
              <button
                className="text-button"
                onClick={() => {
                  setRecent([]);
                  localStorage.removeItem("dash-browser-history");
                }}
              >
                Clear local history
              </button>
            </div>
          )}
          {settingsOpen && (
            <div
              className="modal-backdrop"
              onClick={() => setSettingsOpen(false)}
            >
              <section
                className="modal settings-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Assistant settings"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modal-heading">
                  <DashMark />
                  <button
                    className="icon-button"
                    aria-label="Close settings"
                    onClick={() => setSettingsOpen(false)}
                  >
                    <X size={19} />
                  </button>
                </div>
                <div className="eyebrow">
                  YOUR ASSISTANT. ACROSS THE BROWSER.
                </div>
                <h2>
                  A helping hand,
                  <br />
                  outside the webpage.
                </h2>
                <p>
                  Dash controls a visible Chromium browser using the DOM. You
                  can use that same browser yourself. The assistant stays here
                  while the websites change.
                </p>
                <div className="settings-rows">
                  <div>
                    <span>Inference</span>
                    <strong>
                      {dash.health?.model || "Local demo planner"}
                    </strong>
                  </div>
                  <div>
                    <span>Control</span>
                    <strong>Playwright / CDP</strong>
                  </div>
                  <div>
                    <span>Session</span>
                    <strong>Shared with you · separate profile</strong>
                  </div>
                  <div>
                    <span>Voice</span>
                    <strong>Browser Web Speech API</strong>
                  </div>
                  <div>
                    <span>Thinking</span>
                    <strong>Disabled for lower latency</strong>
                  </div>
                  <div>
                    <span>Shopping demo</span>
                    <strong>3 fictional stores · real DOM actions</strong>
                  </div>
                </div>
                <p className="settings-fine">
                  General browsing uses real public websites. The grocery
                  workflow uses a commerce sandbox with no charges. Voice sends
                  audio to your browser’s speech service when you enable the
                  microphone. No API keys are sent to the frontend.
                </p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    void fetch("/api/warm", { method: "POST" }).then(
                      dash.refreshHealth,
                    );
                  }}
                >
                  Warm shopping tabs & refresh connection
                </button>
              </section>
            </div>
          )}
          {approvalOpen && result?.winner && (
            <ApprovalModal
              result={result}
              acknowledged={acknowledged}
              setAcknowledged={setAcknowledged}
              approving={approving}
              error={approvalError}
              approve={approve}
              close={() => !approving && setApprovalOpen(false)}
            />
          )}
        </div>
      </DashToolContext.Provider>
    </AssistantRuntimeProvider>
  );
}
function GeneralTiming({
  metrics,
  elapsed,
  running,
  close,
}: {
  metrics: ReturnType<typeof useGeneral>["metrics"];
  elapsed: number;
  running: boolean;
  close: () => void;
}) {
  const fmt = (n: number | null | undefined) =>
    n == null ? "—" : `${Math.round(n)} ms`;
  return (
    <section className="timing-panel">
      <div className="timing-header">
        <div>
          <Code2 size={17} />
          <strong>Latency breakdown</strong>
        </div>
        <button
          className="icon-button"
          aria-label="Close timing overlay"
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <div className="big-metrics">
        <div>
          <strong>{metrics.actions}</strong>
          <span>browser actions</span>
        </div>
        <div>
          <strong>{metrics.modelCalls}</strong>
          <span>model calls</span>
        </div>
        <div>
          <strong>
            {((running ? elapsed : metrics.total) / 1000).toFixed(2)}
            <small>s</small>
          </strong>
          <span>task elapsed</span>
        </div>
      </div>
      <div className="latency-section-title">INFERENCE</div>
      {metrics.inferenceCalls.map((call: AgentCallTiming, i) => (
        <details
          className="span-details"
          key={i}
          open={i === metrics.inferenceCalls.length - 1}
        >
          <summary>
            Model call {i + 1}
            <span>{fmt(call.total)}</span>
          </summary>
          <div className="timing-grid">
            <div>
              <span>Time to first token</span>
              <strong>{fmt(call.ttft)}</strong>
            </div>
            <div>
              <span>Time to complete tool call</span>
              <strong>{fmt(call.firstToolCall)}</strong>
            </div>
            <div>
              <span>Generation · received token stream</span>
              <strong>{fmt(call.generation)}</strong>
            </div>
            <div>
              <span>Actual generation · provider measured</span>
              <strong>{fmt(call.providerGeneration)}</strong>
            </div>
            <div>
              <span>Thinking</span>
              <strong>Disabled · {call.reasoningTokens ?? 0} tokens</strong>
            </div>
            <div>
              <span>Provider queue</span>
              <strong>{fmt(call.providerQueue)}</strong>
            </div>
            <div>
              <span>Prompt processing / prefill</span>
              <strong>{fmt(call.providerPrompt)}</strong>
            </div>
            <div>
              <span>Transport & client residual</span>
              <strong>
                {call.providerTotal === null
                  ? "—"
                  : fmt(Math.max(0, call.total - call.providerTotal))}
              </strong>
            </div>
          </div>
        </details>
      ))}
      <div className="latency-section-title">BROWSER</div>
      <div className="timing-grid">
        {["navigation", "dom", "browser", "presentation"].map((category) => (
          <div key={category}>
            <span>
              {category === "navigation"
                ? "Page navigation & loading"
                : category === "dom"
                  ? "DOM extraction"
                  : category === "presentation"
                    ? "Visual preview capture"
                    : "Clicks, typing & action execution"}
            </span>
            <strong>
              {fmt(
                metrics.spans
                  .filter((s) => s.category === category)
                  .reduce((sum, s) => sum + s.duration, 0),
              )}
            </strong>
          </div>
        ))}
      </div>
      <p className="timing-footnote">
        Tool-call timing ends when complete, parseable arguments arrive.
        Navigation waits for DOMContentLoaded, never network idle. Nested spans
        overlap. Thinking is explicitly disabled. Provider timings are read from
        Cerebras time_info when returned.
      </p>
    </section>
  );
}
