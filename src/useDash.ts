import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserSnapshot,
  Metrics,
  Plan,
  PlanItem,
  Quote,
  RunEvent,
  RunResult,
  StoreId,
  TimingSpan,
} from "../shared/types";

export interface Health {
  status: string;
  mode: "local" | "cerebras";
  model: string | null;
  configurationIncomplete: boolean;
  browser: {
    connected: boolean;
    warm: boolean;
    pages: number;
    native?: boolean;
  };
}
export interface StageState {
  status: "running" | "done";
  label: string;
}
export interface ActionLog {
  store: StoreId;
  label: string;
  at: number;
  status: string;
}
const emptyMetrics = (): Metrics => ({
  actions: 0,
  modelCalls: 0,
  pages: 0,
  total: 0,
  firstAction: null,
  firstToken: null,
  inferenceStart: null,
  firstActionAfterToken: null,
  networkHeaders: null,
  tokens: null,
  tokensPerSecond: null,
  maxActionGap: 0,
  spans: [],
});
export function useDash() {
  const [health, setHealth] = useState<Health | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [meta, setMeta] = useState<Plan["meta"] | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [actions, setActions] = useState<ActionLog[]>([]);
  const [snapshots, setSnapshots] = useState<
    Partial<Record<StoreId, BrowserSnapshot>>
  >({});
  const [activeStore, setActiveStore] = useState<StoreId>("goodmarket");
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [clientTiming, setClientTiming] = useState<{
    firstEvent: number | null;
    total: number | null;
  }>({ firstEvent: null, total: null });
  const [replaying, setReplaying] = useState(false);
  const [foundKeys, setFoundKeys] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const startRef = useRef(0);
  const historyRef = useRef<BrowserSnapshot[]>([]);
  const replayRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const finalRef = useRef<Partial<Record<StoreId, BrowserSnapshot>>>({});
  const runRef = useRef<string | null>(null);
  const firstEventRef = useRef(false);
  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      if (res.ok) setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);
  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(refreshHealth, 10_000);
    return () => clearInterval(timer);
  }, [refreshHealth]);
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(
      () => setElapsed(performance.now() - startRef.current),
      33,
    );
    return () => clearInterval(interval);
  }, [running]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      replayRef.current.forEach(clearTimeout);
    },
    [],
  );
  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (!firstEventRef.current) {
        firstEventRef.current = true;
        setClientTiming((t) => ({
          ...t,
          firstEvent: performance.now() - startRef.current,
        }));
      }
      switch (event.type) {
        case "start":
          setRunId(event.id as string);
          runRef.current = event.id as string;
          setMetrics((m) => ({
            ...m,
            modelCalls: event.mode === "cerebras" ? 1 : 0,
            pages: 3,
          }));
          break;
        case "plan":
          setMeta(event.meta as Plan["meta"]);
          break;
        case "item":
          setItems((items) => [...items, event.item as PlanItem]);
          break;
        case "stage":
          setStages((stages) => ({
            ...stages,
            [event.stage as string]: {
              status: event.status as StageState["status"],
              label: event.label as string,
            },
          }));
          break;
        case "action": {
          const action = {
            store: event.store as StoreId,
            label: event.label as string,
            at: event.at,
            status: event.status as string,
          };
          if (event.status === "done") {
            setActions((a) => [...a.slice(-149), action]);
            setMetrics((m) => ({ ...m, actions: event.actions as number }));
          }
          break;
        }
        case "snapshot": {
          const shot = event.snapshot as BrowserSnapshot;
          historyRef.current.push(shot);
          finalRef.current[shot.store] = shot;
          setSnapshots((s) => ({ ...s, [shot.store]: shot }));
          break;
        }
        case "found":
          if (event.product)
            setFoundKeys(
              (keys) => new Set([...keys, (event.item as PlanItem).key]),
            );
          break;
        case "quotes":
          setQuotes(event.quotes as Quote[]);
          if (event.winner) setActiveStore(event.winner as StoreId);
          break;
        case "timing":
          setMetrics((m) => ({
            ...m,
            spans: [...m.spans, event.span as TimingSpan],
          }));
          break;
        case "result": {
          const result = event.result as RunResult;
          setResult(result);
          setMetrics(result.metrics);
          setElapsed(result.metrics.total);
          setRunning(false);
          setClientTiming((t) => ({
            ...t,
            total: performance.now() - startRef.current,
          }));
          if (["error", "cancelled"].includes(result.status))
            setError(result.warnings[0] || "This errand stopped.");
          void refreshHealth();
          break;
        }
      }
    },
    [refreshHealth],
  );
  const stopReplay = useCallback(() => {
    replayRef.current.forEach(clearTimeout);
    replayRef.current = [];
    setReplaying(false);
    setSnapshots({ ...finalRef.current });
  }, []);
  const run = useCallback(
    async (text: string, voiceSession?: string) => {
      if (text.trim().length < 3) return;
      abortRef.current?.abort();
      stopReplay();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setRunId(null);
      runRef.current = null;
      setPrompt(text);
      setResult(null);
      setError(null);
      setMeta(null);
      setItems([]);
      setStages({});
      setActions([]);
      setMetrics(emptyMetrics());
      setQuotes([]);
      setFoundKeys(new Set());
      if (!voiceSession) setSnapshots({});
      setActiveStore("goodmarket");
      historyRef.current = [];
      finalRef.current = {};
      firstEventRef.current = false;
      setClientTiming({ firstEvent: null, total: null });
      startRef.current = performance.now();
      setElapsed(0);
      let sawResult = false;
      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: text,
            ...(voiceSession ? { voiceSession } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "The shopping run could not start.");
        }
        if (!response.body)
          throw new Error("This browser cannot receive the action stream.");
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"),
              raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!raw.trim()) continue;
            const event = JSON.parse(raw) as RunEvent;
            if (event.type === "result") sawResult = true;
            handleEvent(event);
          }
        }
        if (!sawResult)
          throw new Error(
            "The connection ended before the cart was complete. Nothing was ordered.",
          );
      } catch (error) {
        if (controller.signal.aborted)
          setError("Stopped. Nothing was ordered.");
        else
          setError(
            error instanceof Error
              ? error.message
              : "Something went wrong. Please retry.",
          );
        setRunning(false);
      }
    },
    [handleEvent, stopReplay],
  );
  const stop = useCallback(async () => {
    const id = runRef.current;
    if (id)
      await fetch(`/api/runs/${id}/cancel`, { method: "POST" }).catch(() => {});
    abortRef.current?.abort();
    setRunning(false);
  }, []);
  const reset = useCallback(() => {
    stopReplay();
    setPrompt("");
    setResult(null);
    setRunId(null);
    setMeta(null);
    setItems([]);
    setActions([]);
    setStages({});
    setSnapshots({});
    setMetrics(emptyMetrics());
    setError(null);
    setElapsed(0);
    setQuotes([]);
  }, [stopReplay]);
  const replay = useCallback(() => {
    stopReplay();
    setReplaying(true);
    const shots = historyRef.current;
    let delay = 0;
    shots.forEach((shot, i) => {
      delay +=
        i === 0
          ? 0
          : Math.max(160, Math.min(450, (shot.at - shots[i - 1].at) * 3));
      replayRef.current.push(
        setTimeout(() => {
          setActiveStore(shot.store);
          setSnapshots((s) => ({ ...s, [shot.store]: shot }));
        }, delay),
      );
    });
    replayRef.current.push(setTimeout(stopReplay, delay + 500));
  }, [stopReplay]);
  const approve = useCallback(async () => {
    if (!result?.winner) throw new Error("No cart to approve.");
    const res = await fetch(`/api/runs/${result.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved: true,
        expectedTotal: result.winner.total,
      }),
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(data.error || "The order could not be confirmed.");
    setResult(data.result as RunResult);
    if (data.snapshot) {
      const shot = data.snapshot as BrowserSnapshot;
      finalRef.current[shot.store] = shot;
      historyRef.current.push(shot);
      setSnapshots((s) => ({ ...s, [shot.store]: shot }));
    }
  }, [result]);
  const showPreview = useCallback((shots: BrowserSnapshot[]) => {
    for (const shot of shots) {
      setSnapshots((s) => ({ ...s, [shot.store]: shot }));
    }
  }, []);
  return {
    health,
    running,
    runId,
    prompt,
    meta,
    items,
    stages,
    actions,
    snapshots,
    activeStore,
    setActiveStore,
    metrics,
    quotes,
    result,
    error,
    elapsed,
    clientTiming,
    replaying,
    foundKeys,
    refreshHealth,
    run,
    stop,
    reset,
    replay,
    stopReplay,
    approve,
    showPreview,
  };
}
