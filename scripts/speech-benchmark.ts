/**
 * Drives the same SpeechRecognition.onresult boundary as browser speech.
 * This is transcript injection, not a microphone/STT accuracy benchmark.
 * Run against a running Dash server: npm run benchmark:speech
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { RunEvent, RunResult } from "../shared/types";
const base = process.env.DASH_URL || "http://127.0.0.1:3100";
const wpm = Math.max(60, Math.min(240, Number(process.env.WPM || 150)));
const sentence =
  process.env.SPEECH_TEXT ||
  "Open the browser and get bananas, oat milk, blueberries, oats and yogurt for two people. Make everything gluten free, keep it under forty dollars, and deliver tomorrow morning.";
const interval = 60_000 / wpm;
mkdirSync("artifacts", { recursive: true });
await fetch(`${base}/api/warm`, { method: "POST" });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript({
  content: `
  let activeRecognition = null;
  class TestSpeechRecognition {
    continuous = true; interimResults = true; lang = 'en-US';
    start() { activeRecognition = this; }
    stop() { activeRecognition = null; queueMicrotask(() => this.onend?.()); }
    abort() { activeRecognition = null; queueMicrotask(() => this.onend?.()); }
  }
  Object.defineProperty(window, 'SpeechRecognition', { value: TestSpeechRecognition, configurable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: TestSpeechRecognition, configurable: true });
  window.__speechTest = {
    emit(text, final = false) {
      if (!activeRecognition) throw new Error('Speech recognition was not started through the microphone button.');
      activeRecognition.onresult?.({resultIndex:0,results:[{0:{transcript:text,confidence:.99},length:1,isFinal:final}]});
    },
    active: () => Boolean(activeRecognition)
  };
`,
});
const networkEvents: { type: string; at: number; [key: string]: unknown }[] =
  [];
const previewResponses: Promise<void>[] = [];
let started = 0;
let finalRunEvents: RunEvent[] = [];
let firstResultClient: number | null = null;
let requestAt: number | null = null;
page.on("response", (response) => {
  const url = response.url();
  if (url.includes("/api/voice/") || url.endsWith("/api/run")) {
    const receivedAt = performance.now() - started;
    if (url.endsWith("/preview"))
      previewResponses.push(
        response
          .json()
          .then((data) => {
            if (!data.snapshots?.length) return;
            networkEvents.push({
              type: "browser-preview",
              at: receivedAt,
              actions: data.actions,
              label: data.snapshots[0].label,
              stores: data.snapshots.map((s: { store: string }) => s.store),
              transcript: JSON.parse(response.request().postData() || "{}")
                .transcript,
            });
          })
          .catch(() => {}),
      );
    else if (url.endsWith("/prepare"))
      previewResponses.push(
        response
          .json()
          .then((data) =>
            networkEvents.push({
              type: "browser-prepared",
              at: receivedAt,
              store: data.snapshot?.store,
            }),
          )
          .then(() => {})
          .catch(() => {}),
      );
    else if (url.endsWith("/api/run"))
      previewResponses.push(
        response
          .text()
          .then((text) => {
            finalRunEvents = text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            firstResultClient = performance.now() - started;
          })
          .catch(() => {}),
      );
  }
});
page.on("request", (request) => {
  if (request.url().endsWith("/api/run"))
    requestAt = performance.now() - started;
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Powered by Cerebras" }).waitFor();
  started = performance.now();
  await page.getByRole("button", { name: "Speak your request" }).click();
  await page
    .getByRole("heading", { name: "Keep talking. I’m on it." })
    .waitFor();
  const words = sentence.split(/\s+/);
  const spoken: { text: string; at: number }[] = [];
  const speechStart = performance.now();
  for (let i = 0; i < words.length; i++) {
    const target = speechStart + i * interval;
    const remaining = target - performance.now();
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, remaining));
    const text = words.slice(0, i + 1).join(" ");
    spoken.push({ text, at: performance.now() - started });
    await page.evaluate(
      ({ text, final }) =>
        (
          window as unknown as {
            __speechTest: { emit: (text: string, final: boolean) => void };
          }
        ).__speechTest.emit(text, final),
      { text, final: i === words.length - 1 },
    );
    if (i === Math.floor(words.length / 2))
      await page.screenshot({
        path: `artifacts/speech-${wpm}wpm-listening.png`,
        fullPage: true,
      });
  }
  const utteranceEnd = performance.now() - started;
  await page.getByRole("button", { name: "Finish speaking" }).click();
  await page
    .getByRole("button", { name: "Review & approve" })
    .waitFor({ timeout: 45_000 });
  await Promise.all(previewResponses);
  const result = finalRunEvents.find((e) => e.type === "result")
    ?.result as RunResult;
  assert(result, "Must receive a final run result");
  assert.equal(result.status, "approval");
  assert.equal(result.plan.meta.people, 2);
  assert.equal(result.plan.meta.budget, 40);
  assert(result.plan.meta.diets.includes("gluten-free"));
  assert.equal(result.plan.meta.delivery, "tomorrow-morning");
  const previews = networkEvents.filter((e) => e.type === "browser-preview");
  assert(
    previews.length > 0,
    "Browser searches must begin before the utterance ends",
  );
  assert(
    previews[0].at < utteranceEnd,
    "First preview must arrive while the user is speaking",
  );
  assert.equal(result.metrics.pages, 3);
  assert.equal(result.metrics.modelCalls, 1);
  assert(
    (result.metrics.cacheHits ?? 0) >= 3,
    "Speech DOM searches are reused by the final run",
  );
  const previewLatency = previews.map((preview) => {
    const emitted = spoken.find((s) => s.text === preview.transcript);
    return {
      label: preview.label,
      spokenAt: emitted?.at,
      responseAt: preview.at,
      transcriptToPreviewMs: emitted
        ? Math.round(preview.at - emitted.at)
        : null,
      actions: preview.actions,
    };
  });
  const actionEvents = finalRunEvents.filter(
    (e) => e.type === "action" && e.status === "done",
  );
  const gaps = actionEvents
    .slice(1)
    .map((e, i) => e.at - actionEvents[i].at)
    .sort((a, b) => a - b);
  const summary = {
    test: "Injected Web Speech interim results through the real microphone-button lifecycle",
    nativeAudioTest: false,
    wpm,
    wordCount: words.length,
    utteranceDurationMs: Math.round(utteranceEnd),
    firstPreparedMs: networkEvents.find((e) => e.type === "browser-prepared")
      ?.at,
    firstSpeculativeSearchMs: previews[0].at,
    previewLatency,
    requestAfterUtteranceMs:
      requestAt === null ? null : Math.round(requestAt - utteranceEnd),
    completedCartAfterUtteranceMs:
      firstResultClient === null
        ? null
        : Math.round(firstResultClient - utteranceEnd),
    cartRunMs: result.metrics.total,
    firstBrowserActionMs: result.metrics.firstAction,
    firstTokenMs: result.metrics.firstToken,
    maxCompletedActionGapMs: Math.max(...gaps),
    p95ActionGapMs: gaps[Math.floor(gaps.length * 0.95)],
    actions: result.metrics.actions,
    modelCalls: result.metrics.modelCalls,
    cacheHits: result.metrics.cacheHits,
    inference: result.metrics.inference,
    browserPrewarm: result.metrics.warmup,
    status: result.status,
    totalCents: result.winner?.total,
    assertions: "passed",
    pageErrors: errors,
  };
  assert.equal(errors.length, 0, "No browser JavaScript exceptions");
  await page.screenshot({
    path: `artifacts/speech-${wpm}wpm-result.png`,
    fullPage: true,
  });
  writeFileSync(
    `artifacts/speech-${wpm}wpm.json`,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary,
        spoken,
        networkEvents,
        result,
        events: finalRunEvents.filter((e) => e.type !== "snapshot"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(summary, null, 2));
  await fetch(`${base}/api/runs/${result.id}/cancel`, { method: "POST" });
} finally {
  await browser.close();
}
