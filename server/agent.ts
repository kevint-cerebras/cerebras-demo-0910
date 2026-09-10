import { performance } from "node:perf_hooks";
import { mkdirSync } from "node:fs";
import { showNativePage } from "./browser";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import {
  browserSystem,
  browserTools,
  consequentialLabel,
  readPageScript,
  safePublicURL,
} from "../shared/browser-tools";
import { nativeCursorScript } from "../shared/native-cursor";
import { configuration } from "./planner";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface AgentCallTiming {
  ttft: number | null;
  firstToolCall: number | null;
  generation: number | null;
  total: number;
  providerQueue: number | null;
  providerPrompt: number | null;
  providerGeneration: number | null;
  providerTotal: number | null;
  reasoningTokens: number | null;
}
export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[];
};
export async function modelStep(
  messages: ChatMessage[],
  onCall: (call: ToolCall) => void,
  signal: AbortSignal,
) {
  const config = configuration();
  if (config.mode !== "cerebras")
    throw new Error(
      "General browsing needs the Cerebras key and model in .env. The grocery demo can run locally.",
    );
  const start = performance.now();
  const timing: AgentCallTiming = {
    ttft: null,
    firstToolCall: null,
    generation: null,
    total: 0,
    providerQueue: null,
    providerPrompt: null,
    providerGeneration: null,
    providerTotal: null,
    reasoningTokens: null,
  };
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "system", content: browserSystem }, ...messages],
      tools: browserTools,
      tool_choice: "required",
      parallel_tool_calls: true,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "none",
      temperature: 0.1,
      max_completion_tokens: 1600,
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Cerebras returned HTTP ${response.status}. Check model access or try again shortly.`,
    );
  }
  const calls = new Map<
    number,
    { id: string; name: string; raw: string; dispatched: boolean }
  >();
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    lastToken = 0,
    done = false;
  const dispatch = (index: number) => {
    const call = calls.get(index)!;
    if (call.dispatched || !call.name || !call.raw) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.raw);
    } catch {
      return;
    }
    call.dispatched = true;
    if (timing.firstToolCall === null)
      timing.firstToolCall = performance.now() - start;
    onCall({ id: call.id, name: call.name, arguments: args });
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder
        .decode(chunk.value, { stream: true })
        .replace(/\r/g, "");
      while (buffer.includes("\n\n")) {
        const end = buffer.indexOf("\n\n"),
          raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          done = true;
          break;
        }
        const event = JSON.parse(data);
        if (event.error)
          throw new Error("Cerebras reported a streaming error.");
        if (event.time_info) {
          const t = event.time_info;
          timing.providerQueue = t.queue_time * 1000;
          timing.providerPrompt = t.prompt_time * 1000;
          timing.providerGeneration = t.completion_time * 1000;
          timing.providerTotal = t.total_time * 1000;
        }
        if (event.usage)
          timing.reasoningTokens =
            event.usage.completion_tokens_details?.reasoning_tokens ?? null;
        const delta = event.choices?.[0]?.delta;
        if (delta?.tool_calls?.length || delta?.content) {
          if (timing.ttft === null) timing.ttft = performance.now() - start;
          lastToken = performance.now() - start;
        }
        for (const piece of delta?.tool_calls ?? []) {
          let call = calls.get(piece.index);
          if (!call) {
            call = {
              id: piece.id || `call_${piece.index}`,
              name: "",
              raw: "",
              dispatched: false,
            };
            calls.set(piece.index, call);
          }
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name = piece.function.name;
          call.raw += piece.function?.arguments || "";
          dispatch(piece.index);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  timing.total = performance.now() - start;
  timing.generation = timing.ttft === null ? null : lastToken - timing.ttft;
  if (!calls.size)
    throw new Error("The model did not return a browser action. Try again.");
  for (const call of calls.values())
    if (!call.dispatched)
      throw new Error("The model returned an incomplete browser action.");
  return {
    calls: [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.raw },
    })),
    timing,
  };
}
let generalContext: BrowserContext | undefined;
let generalPage: Page | undefined;
let warming: Promise<Page> | undefined;
let busy = false;
let whenIdle: Promise<void> = Promise.resolve();
function routeGeneralResource(route: Route) {
  const request = route.request();
  const url = request.url();
  try {
    safePublicURL(url, `http://127.0.0.1:${process.env.PORT || 3100}`);
  } catch {
    return route.abort();
  }
  if (
    ["image", "media", "font"].includes(request.resourceType()) ||
    /doubleclick|google-analytics|googletagmanager|facebook\.net|hotjar|segment\.io/.test(
      url,
    )
  )
    return route.abort();
  return route.continue();
}
export async function warmGeneral() {
  if (generalPage && !generalPage.isClosed()) return generalPage;
  if (warming) return warming;
  if (generalContext) {
    generalPage =
      generalContext.pages().find((p) => !p.isClosed()) ||
      (await generalContext.newPage());
    return generalPage;
  }
  warming = (async () => {
    mkdirSync(".browser-profile/general", { recursive: true });
    const context = await chromium.launchPersistentContext(
      ".browser-profile/general",
      {
        headless: process.env.BROWSER_HEADLESS === "true",
        viewport: { width: 1280, height: 850 },
        reducedMotion: "reduce",
        serviceWorkers: "block",
        args: ["--window-size=1300,980"],
      },
    );
    generalContext = context;
    await context.addInitScript({ content: nativeCursorScript });
    await context.route("**/*", routeGeneralResource);
    generalPage = context.pages()[0] || (await context.newPage());
    context.on("page", (p) => {
      generalPage = p;
      p.setDefaultTimeout(4000);
    });
    generalPage.setDefaultTimeout(4000);
    return generalPage;
  })();
  try {
    return await warming;
  } finally {
    warming = undefined;
  }
}
export async function closeGeneral() {
  await generalContext?.close();
  generalPage = undefined;
  generalContext = undefined;
}
export async function executeGeneral(
  prompt: string,
  emit: (event: Record<string, unknown>) => void,
  signal: AbortSignal,
) {
  if (busy) throw new Error("Another general browser task is running.");
  busy = true;
  let releaseIdle!: () => void;
  whenIdle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  let pendingActions: Promise<void> = Promise.resolve();
  const start = performance.now(),
    id = randomUUID();
  let actions = 0;
  let summary = "";
  let page: Page | undefined;
  let pointer: { x: number; y: number } | null = null;
  const timings: AgentCallTiming[] = [];
  const spans: { name: string; duration: number; category: string }[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const send = (type: string, data: Record<string, unknown> = {}) =>
    emit({ type, id, at: performance.now() - start, ...data });
  const capture = async (label: string, toolCallId?: string) => {
    if (!page) return;
    if (pointer)
      await page.evaluate(
        (point) =>
          window.dispatchEvent(
            new CustomEvent("dash:cursor", { detail: point }),
          ),
        pointer,
      );
    const captureStart = performance.now();
    const image = await page.screenshot({
      type: "jpeg",
      quality: 65,
      timeout: 4000,
      animations: "disabled",
    });
    spans.push({
      name: "Visual preview capture",
      category: "presentation",
      duration: performance.now() - captureStart,
    });
    send("page", {
      toolCallId,
      url: page.url(),
      title: await page.title(),
      image: `data:image/jpeg;base64,${image.toString("base64")}`,
      label,
    });
  };
  const read = async () => {
    const t = performance.now();
    const state = await page!.evaluate(readPageScript);
    spans.push({
      name: "DOM extraction",
      category: "dom",
      duration: performance.now() - t,
    });
    send("action", {
      label: "Read page DOM",
      actions: ++actions,
      status: "done",
    });
    return state;
  };
  try {
    send("start", { mode: "cerebras", model: configuration().model });
    page = await warmGeneral();
    for (const candidate of page.context().pages()) {
      if (
        !candidate.isClosed() &&
        (await candidate
          .evaluate(() => document.visibilityState === "visible")
          .catch(() => false))
      ) {
        page = candidate;
        generalPage = candidate;
        break;
      }
    }
    await page.bringToFront();
    send("action", {
      label: "Browser ready",
      actions: ++actions,
      status: "done",
    });
    const explicitURL = prompt
      .match(/https?:\/\/[^\s<>]+/)?.[0]
      ?.replace(/[.,;!?]+$/, "");
    if (explicitURL) {
      const url = safePublicURL(explicitURL, "http://127.0.0.1:3100");
      const navigationStart = performance.now();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
      spans.push({
        name: "Open requested URL",
        category: "navigation",
        duration: performance.now() - navigationStart,
      });
      send("action", { label: "Opened requested website", actions: ++actions });
      await capture("Opened the requested website");
    }
    if (page.url() !== "about:blank") {
      messages.push({
        role: "user",
        content: `Current browser page: ${JSON.stringify(await read())}`,
      });
      if (!explicitURL) await capture("Reading your current browser tab");
    }
    for (let turn = 0; turn < 8 && !summary; turn++) {
      signal.throwIfAborted();
      let queue = Promise.resolve();
      const results: { call: ToolCall; result: unknown }[] = [];
      const step = await modelStep(
        messages,
        (call) => {
          queue = queue
            .then(async () => {
              signal.throwIfAborted();
              const actionStart = performance.now();
              const args = call.arguments;
              send("action-start", {
                toolCallId: call.id,
                label: call.name,
                args,
              });
              let value: unknown;
              try {
                if (call.name === "navigate") {
                  const url = safePublicURL(
                    String(args.url),
                    "http://127.0.0.1:3100",
                  );
                  await page!.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: 12000,
                  });
                  value = await read();
                  await capture(`Opened ${new URL(url).hostname}`, call.id);
                } else if (call.name === "read_page") {
                  value = await read();
                  await capture("Reading the page", call.id);
                } else if (call.name === "finish") {
                  summary = String(args.summary || "Done.");
                  value = "Task complete.";
                } else if (["click", "fill", "press"].includes(call.name)) {
                  if (
                    typeof args.id !== "string" ||
                    !/^[a-f0-9]{8}-\d{1,2}$/.test(args.id)
                  )
                    throw new Error(
                      "Copy the complete element ID from the latest page observation.",
                    );
                  const currentSnapshot = await page!.evaluate(
                    () => document.documentElement.dataset.dashSnapshotId,
                  );
                  if (currentSnapshot !== args.id.split("-")[0])
                    throw new Error(
                      "The page observation is stale. Call read_page before acting.",
                    );
                  const locator = page!.locator(
                    `[data-dash-node="${args.id}"]`,
                  );
                  const box = await locator.boundingBox();
                  pointer = box
                    ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
                    : null;
                  const label =
                    (await locator.getAttribute("aria-label")) ||
                    (await locator.textContent()) ||
                    "";
                  if (call.name === "click") {
                    if (consequentialLabel.test(label))
                      throw new Error(
                        `User approval required for “${label.trim().slice(0, 80)}”. Stop and show what is ready.`,
                      );
                    await locator.click({ timeout: 4000 });
                  } else if (call.name === "fill") {
                    const type = await locator.getAttribute("type");
                    if (type === "password")
                      throw new Error("Password entry requires the user.");
                    await locator.fill(String(args.text ?? ""));
                  } else {
                    if (
                      !["Enter", "Tab", "Escape", "ArrowDown"].includes(
                        String(args.key),
                      )
                    )
                      throw new Error("Unsupported key");
                    if (args.key === "Enter") {
                      const descriptor = [
                        label,
                        await locator.getAttribute("type"),
                        await locator.getAttribute("name"),
                        await locator.getAttribute("placeholder"),
                      ].join(" ");
                      if (!/search|find|query|\bq\b/i.test(descriptor))
                        throw new Error(
                          "Submitting this form requires user review.",
                        );
                    }
                    await locator.press(String(args.key));
                  }
                  value =
                    call.name === "fill" ? { filled: args.id } : await read();
                  await capture(
                    `${call.name === "fill" ? "Typed into" : call.name === "click" ? "Clicked" : "Used"} ${label.trim().slice(0, 50) || "the page"}`,
                    call.id,
                  );
                } else throw new Error("Unknown browser tool");
              } catch (error) {
                value = {
                  error:
                    error instanceof Error
                      ? error.message
                      : "Browser action failed",
                };
              }
              if (call.name !== "finish" && call.name !== "read_page")
                actions++;
              spans.push({
                name: call.name,
                category:
                  call.name === "finish"
                    ? "coordination"
                    : call.name === "navigate"
                      ? "navigation"
                      : "browser",
                duration: performance.now() - actionStart,
              });
              send("action", {
                toolCallId: call.id,
                label: call.name,
                actions,
                status:
                  typeof value === "object" &&
                  value !== null &&
                  "error" in value
                    ? "error"
                    : "done",
                result: call.name === "finish" ? summary : undefined,
              });
              results.push({ call, result: value });
            })
            .catch((error) => {
              results.push({
                call,
                result: {
                  error:
                    error instanceof Error ? error.message : "Action stopped",
                },
              });
            });
          pendingActions = queue;
        },
        signal,
      );
      timings.push(step.timing);
      send("inference", { call: turn + 1, timing: step.timing });
      await queue;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: step.calls,
      });
      for (const result of results)
        messages.push({
          role: "tool",
          tool_call_id: result.call.id,
          content: JSON.stringify(result.result),
        });
      // Keep recent page observations complete, compact older observations to limit prefill.
      for (let i = 0; i < messages.length - results.length - 2; i++)
        if (
          messages[i].role === "tool" &&
          (messages[i].content?.length ?? 0) > 2400
        )
          messages[i].content =
            messages[i].content!.slice(0, 2400) +
            " [Earlier page observation shortened]";
    }
    if (!summary)
      summary =
        "I reached the demo’s eight-call limit. The browser is at the last completed step.";
    send("done", {
      summary,
      metrics: {
        total: performance.now() - start,
        actions,
        modelCalls: timings.length,
        inferenceCalls: timings,
        spans,
      },
      url: page.url(),
    });
  } catch (error) {
    send("error", {
      message: signal.aborted
        ? "Stopped. No purchase was made."
        : error instanceof Error
          ? friendlyBrowserError(error.message)
          : "Browser task failed.",
    });
  } finally {
    await pendingActions.catch(() => {});
    busy = false;
    releaseIdle();
  }
}

let lastVoiceURL = "",
  lastVoiceQuery = "",
  lastSubmittedQuery = "";
export function resetVoiceNavigation() {
  lastVoiceURL = "";
  lastVoiceQuery = "";
  lastSubmittedQuery = "";
}
export async function previewPublicPage(transcript: string) {
  if (busy) return null;
  const explicit = transcript.match(
    /(?:open|visit|go to)\s+((?:https?:\/\/)?[a-z0-9.-]+\.(?:com|org|net|io)(?:\/[^\s]*)?)/i,
  )?.[1];
  const url = explicit
    ? explicit.startsWith("http")
      ? explicit
      : `https://${explicit}`
    : /(?:open|visit|go to)\s+(?:the )?wikipedia\b/i.test(transcript)
      ? "https://en.wikipedia.org/wiki/Main_Page"
      : null;
  const query = transcript
    .match(
      /(?:search for|look up)\s+(.+?)(?=\s+(?:then|and (?:tell|show|find|give|read))\b|[.!?]|$)/i,
    )?.[1]
    ?.trim();
  if (
    (!url || url === lastVoiceURL) &&
    (!query || query === lastVoiceQuery) &&
    !(
      query &&
      lastSubmittedQuery !== query &&
      /\bthen\b|\band (?:tell|show|give|read)\b/i.test(transcript)
    )
  )
    return null;
  const page = await warmGeneral();
  const started = performance.now();
  let label = "",
    actionCount = 0;
  if (url && url !== lastVoiceURL) {
    const safe = safePublicURL(url);
    lastVoiceURL = safe;
    try {
      await page.goto(safe, { waitUntil: "domcontentloaded", timeout: 10_000 });
    } catch (error) {
      lastVoiceURL = "";
      throw error;
    }
    label = `Opened ${new URL(safe).hostname} while you speak`;
    actionCount++;
  }
  if (query && query !== lastVoiceQuery && query.length < 180) {
    const field = page
      .locator(
        'input[type="search"], input[name="search"], input[name="q"], textarea[name="q"]',
      )
      .filter({ visible: true })
      .first();
    if (await field.count()) {
      await field.fill(query);
      lastVoiceQuery = query;
      actionCount++;
      const box = await field.boundingBox();
      if (box)
        await page.evaluate(
          (point) =>
            window.dispatchEvent(
              new CustomEvent("dash:cursor", { detail: point }),
            ),
          { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        );
      label = `Typing “${query}” while you speak`;
    }
  }
  if (
    query &&
    query === lastVoiceQuery &&
    lastSubmittedQuery !== query &&
    /\bthen\b|\band (?:tell|show|give|read)\b/i.test(transcript)
  ) {
    const field = page
      .locator(
        'input[type="search"], input[name="search"], input[name="q"], textarea[name="q"]',
      )
      .filter({ visible: true })
      .first();
    if (await field.count()) {
      lastSubmittedQuery = query;
      await field.press("Enter");
      actionCount++;
      label = `Searching for “${query}” while you speak`;
    }
  }
  if (!actionCount) return null;
  const image = await page.screenshot({
    type: "jpeg",
    quality: 65,
    animations: "disabled",
  });
  return {
    image: `data:image/jpeg;base64,${image.toString("base64")}`,
    url: page.url(),
    title: await page.title(),
    label,
    duration: performance.now() - started,
    actionCount,
  };
}

export async function showGeneralBrowser() {
  await whenIdle;
  const page = await warmGeneral();
  await showNativePage(page);
  return { url: page.url(), title: await page.title() };
}

export async function adoptGeneralPage(page: Page) {
  // Page routes take precedence over the shopping context's local-only route.
  // Keep the same cart tab, but permit the normal public browsing destinations.
  await page.route("**/*", routeGeneralResource);
  generalPage = page;
}

function friendlyBrowserError(message: string) {
  if (
    /profile is already in use|Opening in existing browser session/.test(
      message,
    )
  )
    return "Another demo process is using this browser profile. Stop that process and retry.";
  if (/Target page, context or browser has been closed/.test(message))
    return "The browser was closed. Start a new task to reopen it.";
  if (/Timeout.*exceeded|page.goto:.*timeout/i.test(message))
    return "The website did not become ready in time. You can open the native browser to inspect it, then retry.";
  return message
    .split("Call log:")[0]
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 350);
}
