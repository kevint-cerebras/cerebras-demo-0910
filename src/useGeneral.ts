import { useEffect, useRef, useState } from "react";
import type { AgentCallTiming } from "../server/agent";
export interface GeneralMetrics {
  total: number;
  actions: number;
  modelCalls: number;
  inferenceCalls: AgentCallTiming[];
  spans: { name: string; category: string; duration: number }[];
}
export function useGeneral() {
  const [running, setRunning] = useState(false),
    [prompt, setPrompt] = useState(""),
    [summary, setSummary] = useState(""),
    [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<{
    image: string;
    url: string;
    title: string;
    label: string;
  } | null>(null);
  const [actions, setActions] = useState<{ label: string; at: number }[]>([]);
  const [metrics, setMetrics] = useState<GeneralMetrics>({
    total: 0,
    actions: 0,
    modelCalls: 0,
    inferenceCalls: [],
    spans: [],
  });
  const [elapsed, setElapsed] = useState(0);
  const abort = useRef<AbortController | null>(null),
    start = useRef(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(
      () => setElapsed(performance.now() - start.current),
      33,
    );
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => abort.current?.abort(), []);
  const run = async (text: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    start.current = performance.now();
    setRunning(true);
    setPrompt(text);
    setSummary("");
    setError(null);
    setActions([]);
    setElapsed(0);
    setMetrics({
      total: 0,
      actions: 0,
      modelCalls: 0,
      inferenceCalls: [],
      spans: [],
    });
    let finished = false;
    try {
      const response = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("The browser task could not start.");
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"),
            line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "page")
            setPage({
              image: event.image,
              url: event.url,
              title: event.title,
              label: event.label,
            });
          else if (event.type === "action") {
            setActions((a) => [...a, { label: event.label, at: event.at }]);
            setMetrics((m) => ({ ...m, actions: event.actions }));
          } else if (event.type === "inference")
            setMetrics((m) => ({
              ...m,
              modelCalls: event.call,
              inferenceCalls: [...m.inferenceCalls, event.timing],
            }));
          else if (event.type === "done") {
            finished = true;
            setSummary(event.summary);
            setMetrics(event.metrics);
            setElapsed(event.metrics.total);
            setRunning(false);
          } else if (event.type === "error") {
            finished = true;
            setError(event.message);
            setRunning(false);
          }
        }
      }
      if (!finished)
        throw new Error(
          "The browser connection ended before the task finished.",
        );
    } catch (error) {
      setError(
        controller.signal.aborted
          ? "Stopped. No purchase was made."
          : error instanceof Error
            ? error.message
            : "The browser task failed.",
      );
      setRunning(false);
    }
  };
  const stop = () => {
    abort.current?.abort();
    setRunning(false);
  };
  const reset = () => {
    stop();
    setPrompt("");
    setSummary("");
    setError(null);
    setActions([]);
    setElapsed(0);
    setMetrics({
      total: 0,
      actions: 0,
      modelCalls: 0,
      inferenceCalls: [],
      spans: [],
    });
  };
  return {
    running,
    prompt,
    summary,
    error,
    page,
    actions,
    metrics,
    elapsed,
    run,
    stop,
    reset,
    showPreview: setPage,
  };
}
