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
  const [storeActivity, setStoreActivity] = useState<Record<string, import("../shared/types").StoreActivity>>({});
  const [browserMode, setBrowserMode] = useState(true);
  const [browserPage, setBrowserPage] = useState<{
    image: string;
    preparation?: {count:number;duration:number;at:string} | null;
    tabs?: import("../shared/types").BrowserTab[];
    url: string;
    title: string;
    label: string;
  } | null>(null);
  const [browserActions, setBrowserActions] = useState<
    { label: string; status: string; error?: string }[]
  >([]);
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
  useEffect(() => {
    let active = true;
    void fetch("/api/browser/preload")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active || !data || startRef.current) return;
        setBrowserPage(data.page);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
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
        case "browser-mode":
          setBrowserMode(true);
          setMetrics((m) => ({ ...m, pages: 0 }));
          break;
        case "store-activity": {
          const activity = event.activity as import("../shared/types").StoreActivity;
          setStoreActivity(previous=>({...previous,[activity.store]:activity}));
          break;
        }
        case "browser-page":
          setBrowserPage({
            image: String(event.image),
            url: String(event.url),
            title: String(event.title),
            label: String(event.label),
            preparation: event.preparation as {count:number;duration:number;at:string} | null,
            tabs: event.tabs as import("../shared/types").BrowserTab[] | undefined,
          });
          break;
        case "browser-action":
          setBrowserActions((a) => [
            ...a,
            { label: String(event.label), status: String(event.status), error: event.error ? String(event.error) : undefined },
          ]);
          break;
        case "browser-metrics":
          setMetrics(event.metrics as Metrics);
          break;
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
          setBrowserMode(false);
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
    async (text: string, previousRunId?: string | null) => {
      if (text.trim().length < 3) return;
      abortRef.current?.abort();
      if (replaying) stopReplay();
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setRunId(null);
      runRef.current = null;
      setPrompt(text);
      setBrowserActions([]);
      setStoreActivity({});
      setResult(null);
      setError(null);
      setMeta(null);
      setItems([]);
      setStages({});
      setActions([]);
      setMetrics(emptyMetrics());
      setQuotes([]);
      setFoundKeys(new Set());
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
            ...(previousRunId ? {previousRunId} : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "The browser task could not start.");
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
          throw new Error("The connection ended before the task was complete.");
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
    [handleEvent, stopReplay, replaying],
  );
  const stop = useCallback(async () => {
    const id = runRef.current;
    if (id)
      await fetch(`/api/runs/${id}/cancel`, { method: "POST" }).catch(() => {});
    abortRef.current?.abort();
    setRunning(false);
  }, []);
  const preparePages = useCallback(async (urls: string[])=>{
    const response=await fetch("/api/browser/prepare",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({urls})});
    const data=await response.json();if(!response.ok)throw new Error(data.error || "Preload failed");
    setBrowserPage(data.page);return data;
  },[]);
  const selectTab = useCallback(async (id: string) => {
    const response=await fetch("/api/browser/tab", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
    const data=await response.json();
    if(!response.ok) {setError(data.error);return;}
    setBrowserPage(data.page);
  }, []);
  const interactBrowser = useCallback(async (input: import("./InteractivePreview").BrowserInput) => {
    const response = await fetch("/api/browser/input", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(input)});
    const data = await response.json();
    if (!response.ok) { setError(data.error || "Browser interaction failed."); return; }
    setBrowserPage(data.page);
  }, []);
  const [resetting, setResetting] = useState(false);
  const reset = useCallback(async () => {
    setResetting(true);
    setBrowserPage(null);
    stopReplay();
    setPrompt("");
    setBrowserMode(true);
    setBrowserActions([]);
    setStoreActivity({});
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
    startRef.current = 0;
    try {
      const response = await fetch("/api/browser/reset", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not return to Google.");
      setBrowserPage(data.page);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not return to Google.");
    } finally {
      setResetting(false);
    }
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
    if (data.page) setBrowserPage(data.page);
    if (data.snapshot) {
      const shot = data.snapshot as BrowserSnapshot;
      finalRef.current[shot.store] = shot;
      historyRef.current.push(shot);
      setSnapshots((s) => ({ ...s, [shot.store]: shot }));
    }
  }, [result]);
  const showPreview = useCallback((shots: BrowserSnapshot[]) => {
    if (shots.length === 1) setActiveStore(shots[0].store);
    for (const shot of shots) {
      setSnapshots((s) => ({ ...s, [shot.store]: shot }));
    }
  }, []);
  return {
    resetting,
    interactBrowser,
    selectTab,
    preparePages,
    storeActivity,
    browserMode,
    browserPage,
    browserActions,
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
