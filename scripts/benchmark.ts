import { mkdirSync, writeFileSync } from "node:fs";
import { examples } from "../shared/catalog";
import type { RunEvent, RunResult } from "../shared/types";
const base = process.env.DASH_URL || "http://127.0.0.1:3100";
const repeats = Math.max(1, Math.min(10, Number(process.env.REPEATS || 1)));
const scenarios = process.argv.includes("--edge")
  ? [
      {
        title: "Budget too low",
        prompt: "Buy avocados, blueberries and coffee. My total budget is $5.",
        expected: "blocked",
      },
      {
        title: "Dietary substitution",
        prompt:
          "Buy milk, cheese and yogurt for 2. Everything must be vegan and dairy-free. Budget $30, tomorrow morning.",
        expected: "approval",
      },
      {
        title: "Unsupported task",
        prompt: "Book me a flight to Paris tomorrow.",
        expected: "error",
      },
    ]
  : examples.map((e) => ({ ...e, expected: "approval" }));
mkdirSync("artifacts", { recursive: true });
const results: object[] = [];
for (let repeat = 0; repeat < repeats; repeat++)
  for (const scenario of scenarios) {
    await fetch(`${base}/api/warm`, { method: "POST" });
    const start = performance.now();
    const events: RunEvent[] = [];
    let firstClientEvent: number | null = null;
    const response = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: scenario.prompt }),
    });
    if (!response.ok) throw new Error(await response.text());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line) {
          if (firstClientEvent === null)
            firstClientEvent = performance.now() - start;
          events.push(JSON.parse(line));
        }
      }
    }
    const result = events.find((e) => e.type === "result")?.result as RunResult;
    if (!result) throw new Error("No final result");
    const client = performance.now() - start;
    const completed = events.filter(
      (e) => e.type === "action" && e.status === "done",
    );
    const gaps = completed
      .slice(1)
      .map((e, i) => e.at - completed[i].at)
      .sort((a, b) => a - b);
    const snapshots = events.filter((e) => e.type === "snapshot");
    const visualGaps = snapshots
      .slice(1)
      .map((e, i) => e.at - snapshots[i].at)
      .sort((a, b) => a - b);
    const modelSpan = result.metrics.spans.find((s) => s.category === "model");
    const firstSearchStarted = events.find(
      (e) =>
        e.type === "action" &&
        e.status === "running" &&
        String(e.label).startsWith("Search "),
    );
    const browserExecutionBeforeModelDone = Boolean(
      modelSpan &&
        firstSearchStarted &&
        firstSearchStarted.at < modelSpan.start + modelSpan.duration,
    );
    const searchBeforeModelDone = Boolean(
      modelSpan &&
        events.some(
          (e) =>
            e.type === "found" && e.at < modelSpan.start + modelSpan.duration,
        ),
    );
    const summary = {
      title: scenario.title,
      repeat: repeat + 1,
      mode: result.mode,
      model: result.model,
      status: result.status,
      expected: scenario.expected,
      totalMs: result.metrics.total,
      clientMs: Math.round(client),
      firstClientEventMs: Math.round(firstClientEvent!),
      firstActionMs: result.metrics.firstAction,
      firstTokenMs: result.metrics.firstToken,
      actions: result.metrics.actions,
      modelCalls: result.metrics.modelCalls,
      pages: result.metrics.pages,
      maxCompletedActionGapMs: Math.max(...gaps),
      p95ActionGapMs: gaps[Math.floor(gaps.length * 0.95)],
      maxVisualSnapshotGapMs: Math.max(...visualGaps),
      browserExecutionBeforeModelDone,
      searchBeforeModelDone,
      winner: result.winner?.store,
      totalCents: result.winner?.total,
      itemCount: result.plan.items.length,
      warnings: result.warnings,
    };
    results.push(summary);
    console.log(JSON.stringify(summary));
    writeFileSync(
      `artifacts/trace-${result.id}.json`,
      JSON.stringify(
        { result, events: events.filter((e) => e.type !== "snapshot") },
        null,
        2,
      ),
    );
    if (result.status !== scenario.expected) process.exitCode = 1;
    // Dispose of the test cart; the benchmark never approves purchases.
    await fetch(`${base}/api/runs/${result.id}/cancel`, { method: "POST" });
  }
writeFileSync(
  `artifacts/benchmark${process.argv.includes("--edge") ? "-edge" : ""}.json`,
  JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
);
