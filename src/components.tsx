import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  Code2,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  Play,
  Radio,
  RotateCcw,
  ShoppingBag,
  Square,
  X,
  Zap,
} from "lucide-react";
import { catalogLabels, getStore, money, stores } from "../shared/catalog";
import { foodArt } from "../shared/art";
import type {
  BrowserSnapshot,
  Metrics,
  PlanItem,
  Quote,
  RunResult,
  StoreId,
} from "../shared/types";
import type { ActionLog, StageState } from "./useDash";

export function DashMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`dash-mark ${small ? "small" : ""}`}>
      <Zap size={small ? 18 : 24} fill="currentColor" strokeWidth={0} />
    </span>
  );
}
export function ProductArt({
  art,
  name = "",
  color,
  accent,
}: {
  art: string;
  name?: string;
  color?: string;
  accent?: string;
}) {
  return (
    <div
      className="food-art"
      style={{ background: color }}
      dangerouslySetInnerHTML={{ __html: foodArt(art, name, accent) }}
    />
  );
}
export function StoreMark({
  store,
  size = "normal",
}: {
  store: StoreId;
  size?: string;
}) {
  const data = getStore(store);
  return (
    <span
      className={`store-mark ${size}`}
      style={{ background: data.light, color: data.color }}
    >
      {store === "goodmarket" ? (
        <span className="leaf-mark" />
      ) : store === "basket" ? (
        <ShoppingBag size={15} />
      ) : (
        <span className="sun-mark">✳</span>
      )}
    </span>
  );
}

export function BrowserView({
  snapshots,
  activeStore,
  setActiveStore,
  running,
  replaying,
  replay,
  stopReplay,
  actions,
  voiceLabel,
}: {
  snapshots: Partial<Record<StoreId, BrowserSnapshot>>;
  activeStore: StoreId;
  setActiveStore: (s: StoreId) => void;
  running: boolean;
  replaying: boolean;
  replay: () => void;
  stopReplay: () => void;
  actions: ActionLog[];
  voiceLabel?: string;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const cursorTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const selectedStoreRef = useRef(activeStore);
  selectedStoreRef.current = activeStore;
  const shot = snapshots[activeStore];
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    const node = wrapper.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) =>
      setScale(entries[0].contentRect.width / 1000),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (selectedStoreRef.current === shot?.store) setCursor(shot.cursor);
    }, 100);
    cursorTimers.current.push(timeout);
  }, [shot]);
  useEffect(() => () => cursorTimers.current.forEach(clearTimeout), []);
  const latest = [...actions].reverse().find((a) => a.store === activeStore);
  return (
    <section className="browser-window" aria-label="Agent browser">
      <div className="address-row">
        <div className="browser-nav-icons" aria-hidden="true">
          <ArrowLeft size={14} />
          <ArrowRight size={14} />
          <RotateCcw size={13} />
        </div>
        <div className="address">
          <LockKeyhole size={10} />
          <span>
            {getStore(activeStore).shortName} · localhost /{" "}
            {shot?.label.includes("basket") || shot?.label.includes("Select")
              ? "basket"
              : "groceries"}
          </span>
        </div>
        <span className="dom-pill">DOM LIVE</span>
      </div>
      <div
        className="browser-page"
        ref={wrapper}
        style={{ height: 850 * scale }}
      >
        {shot ? (
          <>
            <iframe
              title={`${getStore(activeStore).shortName} live read-only browser snapshot`}
              sandbox=""
              srcDoc={shot.html}
              style={{ width: 1000, height: 850, transform: `scale(${scale})` }}
              tabIndex={-1}
            />
            {cursor && (
              <div
                className={`agent-cursor ${running || replaying || voiceLabel ? "moving" : ""}`}
                style={{
                  left: cursor.x * scale,
                  top: Math.min(cursor.y, 815) * scale,
                }}
              >
                <MousePointer2
                  size={25}
                  fill="#ef7150"
                  stroke="#fff"
                  strokeWidth={1.5}
                />
                <span>dash</span>
              </div>
            )}
          </>
        ) : (
          <div className="browser-placeholder">
            <div className="placeholder-orbit">
              <Globe2 size={37} strokeWidth={1} />
              <span>
                <DashMark small />
              </span>
            </div>
            <h3>{running ? "Already on it." : "Your browser is ready."}</h3>
            <p>
              {running
                ? "Working in the browser."
                : "Watch Dash navigate and take action here."}
            </p>
            <div className="placeholder-stores">
              {stores.map((s) => (
                <StoreMark store={s.id} key={s.id} />
              ))}
            </div>
          </div>
        )}
        {replaying && (
          <div className="replay-badge">
            <Play size={11} fill="currentColor" /> Slow replay · recorded DOM
            actions
          </div>
        )}
      </div>
      <div className="browser-status">
        <span
          className={`status-dot ${running || voiceLabel ? "pulsing" : ""}`}
        />
        <span className="action-caption">
          {voiceLabel ||
            (replaying ? shot?.label : latest?.label) ||
            (running
              ? "Connecting to the warm browser…"
              : "Read-only view of the agent’s browser")}
        </span>
        <button
          className="icon-button log-toggle"
          title="Show browser action log"
          aria-label="Show browser action log"
          onClick={() => setShowLog(!showLog)}
        >
          <Code2 size={15} />
        </button>
        {!running && actions.length > 0 && (
          <button
            className="replay-button"
            onClick={replaying ? stopReplay : replay}
          >
            {replaying ? <Square size={10} /> : <Play size={10} />}{" "}
            {replaying ? "Stop" : "Replay"}
          </button>
        )}
      </div>
      {showLog && (
        <div className="browser-log">
          <div className="log-heading">
            <span>Actual browser actions</span>
            <button
              className="icon-button"
              onClick={() => setShowLog(false)}
              aria-label="Close browser action log"
            >
              <X size={14} />
            </button>
          </div>
          {actions
            .slice(-40)
            .reverse()
            .map((action, i) => (
              <div className="log-row" key={`${action.at}-${i}`}>
                <span>{(action.at / 1000).toFixed(2)}s</span>
                <StoreMark store={action.store} size="tiny" />
                <p>{action.label}</p>
                <Check size={12} />
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
const steps = [
  ["plan", "Make a shopping list"],
  ["search", "Search three stores"],
  ["validate", "Check dietary needs"],
  ["compare", "Compare basket prices"],
  ["cart", "Build your cart"],
  ["delivery", "Choose a delivery slot"],
  ["approval", "Your final say"],
];
export function TaskSteps({
  stages,
  result,
}: {
  stages: Record<string, StageState>;
  result: RunResult | null;
}) {
  return (
    <ol className="task-steps">
      {steps.map(([id, label], index) => {
        const state =
          id === "approval"
            ? result?.status === "ordered"
              ? "done"
              : result?.status === "approval"
                ? "approval"
                : ""
            : stages[id]?.status;
        return (
          <li key={id} className={state || ""}>
            <span className="step-icon">
              {state === "done" ? (
                <Check size={12} strokeWidth={2.5} />
              ) : state === "running" ? (
                <LoaderCircle size={14} className="spin" />
              ) : state === "approval" ? (
                <LockKeyhole size={12} />
              ) : (
                <span>{index + 1}</span>
              )}
            </span>
            <span>{label}</span>
            {state === "running" && <span className="working-dots">···</span>}
          </li>
        );
      })}
    </ol>
  );
}
export function ShoppingList({
  items,
  foundKeys,
}: {
  items: PlanItem[];
  foundKeys: Set<string>;
}) {
  return (
    <div className="shopping-list">
      {items.map((item) => (
        <div key={item.key} className={foundKeys.has(item.key) ? "found" : ""}>
          <span>
            {foundKeys.has(item.key) ? (
              <Check size={12} />
            ) : (
              <Circle size={10} />
            )}
          </span>
          <p>{catalogLabels[item.key]}</p>
          <small>×{item.quantity}</small>
        </div>
      ))}
    </div>
  );
}
export function Quotes({
  quotes,
  winner,
}: {
  quotes: Quote[];
  winner?: StoreId;
}) {
  return (
    <div className="quotes">
      {[...quotes]
        .sort((a, b) => a.total - b.total)
        .map((quote) => (
          <div
            className={`quote ${quote.store === winner ? "best" : ""}`}
            key={quote.store}
          >
            <StoreMark store={quote.store} />
            <div>
              <strong>{getStore(quote.store).shortName}</strong>
              <span>
                {quote.complete
                  ? `Includes ${money(quote.delivery)} delivery`
                  : `${quote.missing.length} unavailable`}
              </span>
            </div>
            <div className="quote-price">
              <strong>{money(quote.total)}</strong>
              {quote.store === winner && <span>BEST BASKET</span>}
            </div>
          </div>
        ))}
    </div>
  );
}

export function CartReview({
  result,
  onReview,
  onNew,
}: {
  result: RunResult;
  onReview: () => void;
  onNew: () => void;
}) {
  const quote = result.winner;
  if (!quote) return null;
  const saving =
    result.quotes.filter((q) => q.complete).sort((a, b) => b.total - a.total)[0]
      ?.total - quote.total;
  return (
    <section className="cart-review">
      <div className="cart-review-top">
        <div className="ready-check">
          <Check size={20} />
        </div>
        <div>
          <h2>
            {result.status === "ordered"
              ? "Consider it handled."
              : "Your basket is ready."}
          </h2>
          <p>
            {result.status === "ordered"
              ? `Sandbox order ${result.receipt?.id}`
              : `${quote.items.length} items. One less thing to do.`}
          </p>
        </div>
        <span className="time-sticker">
          <Zap size={12} fill="currentColor" />
          {(result.metrics.total / 1000).toFixed(2)}s
        </span>
      </div>
      <div className="cart-contents">
        {quote.items.map((item) => (
          <div className="review-item" key={item.product.id}>
            <ProductArt
              art={item.product.art}
              name={item.product.name}
              color={item.product.color}
            />
            <div>
              <strong>{item.product.name}</strong>
              <span>
                {item.product.size} · Qty {item.quantity}
              </span>
            </div>
            <strong>{money(item.product.price * item.quantity)}</strong>
          </div>
        ))}
      </div>
      <div className="cart-review-bottom">
        <div className="delivery-summary">
          <StoreMark store={quote.store} />
          <div>
            <strong>{getStore(quote.store).shortName}</strong>
            <span>{quote.slot?.label}</span>
          </div>
          {saving > 0 && <span className="saving">Saved {money(saving)}</span>}
        </div>
        <div className="bill-line">
          <span>Groceries</span>
          <span>{money(quote.subtotal)}</span>
        </div>
        <div className="bill-line">
          <span>Delivery · tax $0 in sandbox</span>
          <span>{money(quote.delivery)}</span>
        </div>
        <div className="bill-total">
          <span>Total</span>
          <strong>{money(quote.total)}</strong>
        </div>
        {result.plan.meta.budget !== null && (
          <div
            className={`budget-line ${quote.total > result.plan.meta.budget * 100 ? "over" : ""}`}
          >
            {quote.total <= result.plan.meta.budget * 100 ? (
              <Check size={12} />
            ) : (
              <Circle size={12} />
            )}{" "}
            {quote.total <= result.plan.meta.budget * 100
              ? `${money(result.plan.meta.budget * 100 - quote.total)} under your budget`
              : "Over your requested budget"}
          </div>
        )}
        {result.status === "approval" && (
          <button className="primary-button purchase-review" onClick={onReview}>
            Review & approve <ArrowRight size={16} />
          </button>
        )}
        {result.status === "ordered" && (
          <button className="primary-button purchase-review" onClick={onNew}>
            What’s next? <ArrowRight size={16} />
          </button>
        )}
        <p className="approval-note">
          <LockKeyhole size={11} />
          {result.status === "ordered"
            ? "Sandbox order only. No charge or real delivery."
            : "Nothing is ordered until you approve."}
        </p>
      </div>
    </section>
  );
}

export function TimingPanel({
  metrics,
  runId,
  running,
  elapsed,
  mode,
  clientTiming,
  onClose,
}: {
  metrics: Metrics;
  runId: string | null;
  running: boolean;
  elapsed: number;
  mode: "local" | "cerebras";
  clientTiming: { firstEvent: number | null; total: number | null };
  onClose: () => void;
}) {
  const fmt = (value: number | null) =>
    value === null ? "—" : `${Math.round(value)} ms`;
  const categories = [
    "navigation",
    "dom",
    "browser",
    "model",
    "planning",
    "validation",
  ] as const;
  return (
    <section className="timing-panel" aria-label="Development timing overlay">
      <div className="timing-header">
        <div>
          <Code2 size={17} />
          <strong>Under the hood</strong>
          <span>MEASURED LIVE</span>
        </div>
        <button
          className="icon-button"
          aria-label="Close timing overlay"
          onClick={onClose}
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
          <strong>{metrics.pages}</strong>
          <span>pages visited</span>
        </div>
        <div>
          <strong>
            {((running ? elapsed : metrics.total) / 1000).toFixed(2)}
            <small>s</small>
          </strong>
          <span>task time</span>
        </div>
      </div>
      {metrics.inference && (
        <>
          <div className="latency-section-title">
            INFERENCE · INITIAL PLAN / ROUTE
          </div>
          <div className="timing-grid">
            <div>
              <span>Time to first token · from request</span>
              <strong>{fmt(metrics.inference.ttft)}</strong>
            </div>
            <div>
              <span>Time to first executable action</span>
              <strong>{fmt(metrics.inference.firstExecutableAction)}</strong>
            </div>
            <div>
              <span>Generation · received token stream</span>
              <strong>{fmt(metrics.inference.generationStream)}</strong>
            </div>
            <div>
              <span>Actual generation · provider measured</span>
              <strong>{fmt(metrics.inference.providerGeneration)}</strong>
            </div>
            <div>
              <span>Thinking</span>
              <strong>
                Disabled · {metrics.inference.reasoningTokens ?? 0} tokens
              </strong>
            </div>
            <div>
              <span>Provider queue</span>
              <strong>{fmt(metrics.inference.providerQueue)}</strong>
            </div>
            <div>
              <span>Prompt processing / prefill</span>
              <strong>{fmt(metrics.inference.providerPrompt)}</strong>
            </div>
            <div>
              <span>Transport & client residual</span>
              <strong>{fmt(metrics.inference.transportAndClient)}</strong>
            </div>
            <div>
              <span>Full inference request</span>
              <strong>{fmt(metrics.inference.requestTotal)}</strong>
            </div>
          </div>
        </>
      )}
      {metrics.browserInferenceCalls?.map((call, index) => (
        <div key={index}>
          <div className="latency-section-title">
            BROWSER INFERENCE · CALL {index + 1}
          </div>
          <div className="timing-grid">
            <div>
              <span>Time to first token</span>
              <strong>{fmt(call.ttft)}</strong>
            </div>
            <div>
              <span>Time to executable tool call</span>
              <strong>{fmt(call.firstToolCall)}</strong>
            </div>
            <div>
              <span>Generation · received stream</span>
              <strong>{fmt(call.generation)}</strong>
            </div>
            <div>
              <span>Generation · provider</span>
              <strong>{fmt(call.providerGeneration)}</strong>
            </div>
            <div>
              <span>Thinking · disabled</span>
              <strong>{call.reasoningTokens ?? 0} tokens</strong>
            </div>
            <div>
              <span>Provider prefill</span>
              <strong>{fmt(call.providerPrompt)}</strong>
            </div>
            <div>
              <span>Provider queue</span>
              <strong>{fmt(call.providerQueue)}</strong>
            </div>
            <div>
              <span>Transport & client residual</span>
              <strong>
                {fmt(
                  call.providerTotal === null
                    ? null
                    : Math.max(0, call.total - call.providerTotal),
                )}
              </strong>
            </div>
            <div>
              <span>Full inference request</span>
              <strong>{fmt(call.total)}</strong>
            </div>
          </div>
        </div>
      ))}
      <div className="latency-section-title">BROWSER & END-TO-END RESPONSE</div>
      <div className="timing-grid">
        <div>
          <span>Prompt → inference request</span>
          <strong>{fmt(metrics.inferenceStart)}</strong>
        </div>
        <div>
          <span>Prompt → first model token</span>
          <strong>{fmt(metrics.firstToken)}</strong>
        </div>
        <div>
          <span>Prompt → first browser action</span>
          <strong>{fmt(metrics.firstAction)}</strong>
        </div>
        <div>
          <span>First token → next browser action</span>
          <strong>{fmt(metrics.firstActionAfterToken)}</strong>
        </div>
        <div>
          <span>Provider response headers</span>
          <strong>{fmt(metrics.networkHeaders)}</strong>
        </div>
        <div>
          <span>Longest gap between actions</span>
          <strong className={metrics.maxActionGap > 500 ? "slow" : ""}>
            {fmt(metrics.maxActionGap)}
          </strong>
        </div>
        <div>
          <span>Client → first stream event</span>
          <strong>{fmt(clientTiming.firstEvent)}</strong>
        </div>
        <div>
          <span>Client → completed result</span>
          <strong>{fmt(clientTiming.total)}</strong>
        </div>
        {metrics.tokens !== null && (
          <div>
            <span>Completion tokens / received per second</span>
            <strong>
              {metrics.tokens} / {metrics.tokensPerSecond ?? "—"}
            </strong>
          </div>
        )}
      </div>
      {metrics.warmup && (
        <details className="span-details">
          <summary>
            Browser prewarm · before submission
            <span>{fmt(metrics.warmup.total)}</span>
          </summary>
          <div className="timing-grid">
            {metrics.warmup.pages.map((page) => (
              <div key={page.store}>
                <span>{getStore(page.store).shortName} · HTML / DOM ready</span>
                <strong>
                  {fmt(page.ttfb)} / {fmt(page.domReady)}
                </strong>
              </div>
            ))}
          </div>
          <p className="timing-footnote">
            Browser startup and page loading happen before the prompt. A warm
            session reuses these pages. {metrics.cacheHits ?? 0} cached DOM
            searches reused during this task.
          </p>
        </details>
      )}
      <details className="span-details">
        <summary>
          Stage profile <ChevronDown size={13} />
        </summary>
        <div className="category-totals">
          {categories.map((category) => {
            const spans = metrics.spans.filter((s) => s.category === category);
            return (
              <div key={category}>
                <span>{category === "dom" ? "DOM extraction" : category}</span>
                <strong>
                  {Math.round(spans.reduce((sum, s) => sum + s.duration, 0))} ms
                </strong>
                <small>{spans.length} spans</small>
              </div>
            );
          })}
        </div>
        <p className="timing-footnote">
          Parallel spans overlap. Category totals are work time, not elapsed
          time.
        </p>
      </details>
      <details className="span-details">
        <summary>
          Investigate waits over 100 ms{" "}
          <span>{metrics.spans.filter((s) => s.duration > 100).length}</span>
        </summary>
        <div className="slow-spans">
          {metrics.spans
            .filter((s) => s.duration > 100)
            .sort((a, b) => b.duration - a.duration)
            .map((span, i) => (
              <div key={i}>
                <span>
                  {span.name}
                  {span.store && (
                    <small>{getStore(span.store).shortName}</small>
                  )}
                </span>
                <strong>{Math.round(span.duration)} ms</strong>
              </div>
            ))}
          {!metrics.spans.some((s) => s.duration > 100) && (
            <p>No measured span exceeded 100 ms.</p>
          )}
        </div>
      </details>
      <p className="timing-footnote">
        {mode === "local"
          ? "Local deterministic planner. These numbers do not measure Cerebras inference."
          : "First executable action is the first complete validated action object. Generation and prefill come from provider time_info when available. Transport/client residual is total request time minus provider total, not a pure network RTT."}{" "}
        Prewarmed browser startup is excluded from prompt-to-cart time. Cursor
        follows about 100 ms behind; execution never waits for animation.
      </p>
      {runId && (
        <a
          className="trace-download"
          href={`/api/runs/${runId}/trace`}
          download
        >
          <ArrowDownToLine size={13} /> Download timing trace
        </a>
      )}
    </section>
  );
}
