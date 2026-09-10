import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { showNativePage } from "./browser";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type Browser,
  type Page,
  type Route,
} from "playwright";
import {
  browserSystem,
  consequentialLabel,
  marketplaceBrowserTools,
  readPageScript,
  safePublicURL,
} from "../shared/browser-tools";
import { nativeCursorScript } from "../shared/native-cursor";
import { configuration } from "./planner";
import { GroceryTools } from "./grocery-tools";
import type { Quote, StoreId } from "../shared/types";

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
  content?:
    | string
    | null
    | (
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail: 'low' | 'high' | 'auto' } }
      )[];
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
  finishOnly = false,
  options: {
    system?: string;
    tools?: readonly unknown[];
    maxCompletionTokens?: number;
  } = {},
) {
  const config = configuration();
  if (config.mode === 'local')
    throw new Error(
      `Agent execution needs the ${config.provider} key and model in .env.`,
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
      messages: [{ role: 'system', content: options.system || browserSystem }, ...messages],
      tools: options.tools || (finishOnly
        ? marketplaceBrowserTools.filter((tool) => tool.function.name === 'finish')
        : marketplaceBrowserTools),
      tool_choice: "required",
      // Marketplace photo decisions need the screenshot produced after each action.
      parallel_tool_calls: false,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "none",
      temperature: 0.1,
      max_completion_tokens: options.maxCompletionTokens || 4000,
    }),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `${config.provider === 'cerebras' ? 'Cerebras' : 'Fireworks'} returned HTTP ${response.status}. Check model access or try again shortly.`,
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
          throw new Error(`${config.provider === 'cerebras' ? 'Cerebras' : 'Fireworks'} reported a streaming error.`);
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

const candidateWorkerTools = [
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Read the current listing DOM and current gallery controls.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click a photo-gallery control from the latest observation. Messaging, offers, saves, and purchases are blocked.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press",
      description: "Press ArrowRight or Escape on an observed gallery control.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          key: { type: "string", enum: ["ArrowRight", "Escape"] },
        },
        required: ["id", "key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll down or up to find shipping and listing details.",
      parameters: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down"] } },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_candidate",
      description: "Return the final evidence-backed verdict for this listing after inspecting its first photo and shipping details, or when blocked.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["match", "no_match", "blocked"] },
          title: { type: "string" },
          price: { type: "string" },
          location: { type: "string" },
          url: { type: "string" },
          photoEvidence: { type: "string" },
          shippingEvidence: { type: "string" },
          reason: { type: "string" },
        },
        required: ["status", "title", "price", "location", "url", "photoEvidence", "shippingEvidence", "reason"],
      },
    },
  },
] as const;

const candidateWorkerSystem = `You are one worker in a parallel Facebook Marketplace inspection pool. Inspect only the listing already open in your assigned tab. For minimum latency, judge ONLY the supplied first listing screenshot; do not request or inspect additional gallery photos. Use image pixels—not titles, DOM text, alt text, or thumbnails—to decide whether the goose statue has a visibly open beak with a clear gap between upper and lower beak. Separately verify visible listing text says the item can ship or be delivered to Sunnyvale, CA 94085; pickup-only or unclear shipping is not a match. Do not navigate away from this listing.

This is strictly read-only. Never message/contact the seller, make an offer, save, buy, enter personal information, or operate authentication controls. If login, CAPTCHA, OTP, passkey, or another blocker prevents inspection, return blocked. Always end by calling finish_candidate with concise structured evidence. A match requires BOTH pixel-visible open-beak proof and explicit Sunnyvale shipping proof.`;

type CandidateVerdict = {
  status: "match" | "no_match" | "blocked";
  title: string;
  price: string;
  location: string;
  url: string;
  photoEvidence: string;
  shippingEvidence: string;
  reason: string;
};

async function inspectMarketplaceListing(
  candidatePage: Page,
  signal: AbortSignal,
  reportInference: (timing: AgentCallTiming) => void,
  reportAction: (label: string) => Promise<void>,
): Promise<CandidateVerdict> {
  const canonicalURL = candidatePage.url();
  const observations: unknown[] = [await candidatePage.evaluate(readPageScript)];
  signal.throwIfAborted();
  const firstPhoto = await candidatePage.screenshot({
    type: "jpeg",
    quality: 64,
    animations: "disabled",
    timeout: 5000,
  });
  await reportAction("captured first listing photo");

  const evidence: (
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string; detail: "low" } }
  )[] = [{
    type: "text",
    text: `Return the final verdict for this listing using only its first photo. Listing URL: ${canonicalURL}\nDOM observation: ${JSON.stringify(observations).slice(0, 14000)}`,
  }];
  evidence.push({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${firstPhoto.toString("base64")}`, detail: "low" },
  });
  const calls: ToolCall[] = [];
  const step = await modelStep(
    [{ role: "user", content: evidence }],
    (call) => calls.push(call),
    signal,
    false,
    {
      system: candidateWorkerSystem,
      tools: candidateWorkerTools.filter((tool) => tool.function.name === "finish_candidate"),
      maxCompletionTokens: 1200,
    },
  );
  reportInference(step.timing);
  const call = calls.find((candidate) => candidate.name === "finish_candidate");
  if (!call) throw new Error("Candidate worker did not return a verdict.");
  const args = call.arguments;
  const status = String(args.status);
  if (!["match", "no_match", "blocked"].includes(status))
    throw new Error("Invalid candidate status.");
  const verdict: CandidateVerdict = {
    status: status as CandidateVerdict["status"],
    title: String(args.title || await candidatePage.title().catch(() => "Unknown listing")),
    price: String(args.price || "Unknown price"),
    location: String(args.location || "Unknown location"),
    url: candidatePage.url() || canonicalURL,
    photoEvidence: String(args.photoEvidence || "No visual evidence recorded."),
    shippingEvidence: String(args.shippingEvidence || "No shipping evidence recorded."),
    reason: String(args.reason || "No reason recorded."),
  };
  await reportAction(`finished: ${verdict.title}`);
  return verdict;
}
let generalContext: BrowserContext | undefined;
let generalPage: Page | undefined;
const tabPages = new Map<string, Page>();
const tabWork = new Map<Page, "loading" | "reading" | "ready" | "error">();
let remoteBrowser: Browser | undefined;
let remoteWarming: Promise<void> | undefined;
const remotePages: Page[] = [];
const openedPages = new Map<string, Page>();
export async function warmRemoteWorkers() {
  if (remoteWarming) return remoteWarming;
  remoteWarming = (async()=>{
    if (!remoteBrowser?.isConnected()) remoteBrowser=await chromium.launch({headless:process.env.BROWSER_HEADLESS!=="false"});
    const available=remotePages.filter(page=>!page.isClosed());
    await Promise.all(Array.from({length:Math.max(0,4-available.length)},async()=>{
      const context=await remoteBrowser!.newContext({viewport:{width:1280,height:850},reducedMotion:"reduce",serviceWorkers:"block"});
      await context.route("**/*",routeGeneralResource);
      await context.addInitScript({content:nativeCursorScript});
      const page=await context.newPage();page.setDefaultTimeout(4000);remotePages.push(page);
    }));
  })();
  try {await remoteWarming;} finally {remoteWarming=undefined;}
}
async function remotePage(url: string) {
  const cached=openedPages.get(url);
  if(cached && !cached.isClosed()) {
    const current=new URL(cached.url()), requested=new URL(url);
    if(current.origin===requested.origin && current.pathname===requested.pathname && [...requested.searchParams].every(([key,value])=>current.searchParams.get(key)===value)) return {page:cached,reused:true};
  }
  await warmRemoteWorkers();
  let page=remotePages.find(p=>!p.isClosed() && p.url()==="about:blank" && ![...openedPages.values()].includes(p));
  if(!page){
    const context=await remoteBrowser!.newContext({viewport:{width:1280,height:850},reducedMotion:"reduce",serviceWorkers:"block"});
    await context.route("**/*",routeGeneralResource);page=await context.newPage();page.setDefaultTimeout(4000);remotePages.push(page);
  }
  openedPages.set(url,page);registerTabs(page);
  return {page,reused:false};
}
async function inspectRemotePages(urls: string[], report: (page: Page, label: string, duration: number, category: string)=>Promise<void>, signal?: AbortSignal) {
  if(!Array.isArray(urls)||urls.length<1||urls.length>6)throw new Error("Choose 1–6 URLs.");
  const validated=[...new Set(urls.map(url=>safePublicURL(url)))];
  return Promise.all(validated.map(async url=>{
    signal?.throwIfAborted();
    const {page,reused}=await remotePage(url);
    registerTabs(page);
    const cancelled=()=>{void page.close().catch(()=>{});};
    signal?.addEventListener("abort",cancelled,{once:true});
    try {
      tabWork.set(page,reused?"reading":"loading");
      await report(page,reused?"Reading already-open page":"Opening page",0,"coordination");
      let navigation=0;
      if(!reused){
        const start=performance.now();await page.goto(url,{waitUntil:"domcontentloaded",timeout:12000});navigation=performance.now()-start;
        await page.locator("body").waitFor({state:"attached",timeout:3000});
        await report(page,"Page loaded",navigation,"navigation");
      }
      if(new URL(page.url()).hostname.endsWith("google.com") && new URL(page.url()).pathname.startsWith("/maps/")) {
        await page.waitForFunction(()=>Boolean(document.querySelector('[role="feed"] a[href*="/maps/place/"]')) || Boolean(document.querySelector('h1')?.textContent?.trim() && /Website|Directions|Address/i.test(document.body.innerText)) || /unusual traffic|Before you continue/i.test(document.body.innerText), {}, {timeout:5000}).catch(()=>{});
      }
      signal?.throwIfAborted();tabWork.set(page,"reading");
      const start=performance.now();const observation=await page.evaluate(readPageScript) as {url:string;title:string;text:string;elements:unknown[]};
      const dom=performance.now()-start;tabWork.set(page,"ready");
      await report(page,"Read live page DOM",dom,"dom");
      return {requestedURL:url,reused,navigation,dom,...observation};
    } catch(error){
      tabWork.set(page,"error");
      if(!page.isClosed())await report(page,"Page unavailable",0,"coordination");
      return {requestedURL:url,error:error instanceof Error?error.message:"Page failed"};
    } finally {signal?.removeEventListener("abort",cancelled);}
  }));
}
let viewedPage: Page | undefined;
function registerTabs(page: Page) {
  for (const tab of page.context().pages())
    if (![...tabPages.values()].includes(tab)) tabPages.set(randomUUID(), tab);
}
async function browserTabs(active: Page) {
  registerTabs(active);
  return Promise.all([...tabPages.entries()].filter(([,p])=>!p.isClosed()).map(async ([id,p])=>({id,url:p.url(),title:await p.title().catch(()=>p.url()),active:p===active,work:tabWork.get(p)})));
}
export async function selectBrowserTab(id: string) {
  const page=tabPages.get(id);
  if(!page || page.isClosed()) throw new Error("This tab is closed.");
  viewedPage=page;
  generalPage=page;
  return generalPreview();
}
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
  const parsedURL = new URL(url);
  if (/\/(?:recaptcha|sorry)\//.test(parsedURL.pathname) && /(^|\.)(google\.com|gstatic\.com)$/.test(parsedURL.hostname)) return route.continue();
  if (
    ["font"].includes(request.resourceType()) ||
    /doubleclick|google-analytics|googletagmanager|hotjar|segment\.io/.test(
      url,
    )
  )
    return route.abort();
  return route.continue();
}
export async function warmGeneral() {
  if (warming) return warming;
  if (generalPage && !generalPage.isClosed()) return generalPage;
  if (generalContext) {
    generalPage =
      generalContext.pages().find((p) => !p.isClosed()) ||
      (await generalContext.newPage());
    return generalPage;
  }
  warming = (async () => {
    mkdirSync(".browser-profile/marketplace", { recursive: true });
    const headless = process.env.BROWSER_HEADLESS !== "false";
    const installedChromium = join(
      homedir(),
      headless
        ? "Library/Caches/ms-playwright/chromium_headless_shell-1187/chrome-mac/headless_shell"
        : "Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    );
    const executablePath =
      process.env.BROWSER_EXECUTABLE_PATH ||
      (existsSync(installedChromium) ? installedChromium : undefined);
    const context = await chromium.launchPersistentContext(
      ".browser-profile/marketplace",
      {
        ...(executablePath
          ? { executablePath }
          : { channel: process.env.BROWSER_CHANNEL || "chrome" }),
        headless,
        viewport: { width: 1280, height: 850 },
        reducedMotion: "reduce",
        serviceWorkers: "allow",
        args: [
          "--window-size=1300,980",
          "--disable-crash-reporter",
          "--disable-crashpad",
        ],
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
    await generalPage.goto("https://www.facebook.com/marketplace/", {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    return generalPage;
  })();
  try {
    return await warming;
  } finally {
    warming = undefined;
  }
}
export async function closeGeneral() {
  await remoteBrowser?.close();
  await generalContext?.close();
  generalPage = undefined;
  generalContext = undefined;
}
export async function executeGeneral(
  prompt: string,
  emit: (event: Record<string, unknown>) => void,
  signal: AbortSignal,
  onApproval?: (approval: {lease: import("./browser").BrowserLease; quote: Quote}) => void,
  conversation: ChatMessage[] = [],
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
  const spans: {
    name: string;
    start: number;
    duration: number;
    category: string;
  }[] = [];
  const recordSpan = (span: {
    name: string;
    duration: number;
    category: string;
  }) =>
    spans.push({ ...span, start: performance.now() - start - span.duration });
  const visited = new Set<string>();
  const messages: ChatMessage[] = [...conversation, { role: "user", content: prompt }];
  const send = (type: string, data: Record<string, unknown> = {}) =>
    emit({ type, id, at: performance.now() - start, ...data });
  const capturePage = async (
    capturedPage: Page,
    label: string,
    toolCallId?: string,
    showPointer = false,
  ) => {
    registerTabs(capturedPage);
    if (showPointer && pointer)
      await capturedPage.evaluate(
        (point) =>
          window.dispatchEvent(
            new CustomEvent("dash:cursor", { detail: point }),
          ),
        pointer,
      );
    visited.add(capturedPage.url());
    const captureStart = performance.now();
    const image = await capturedPage.screenshot({
      type: "jpeg",
      quality: 65,
      timeout: 4000,
      animations: "disabled",
    });
    recordSpan({
      name: "Visual preview capture",
      category: "presentation",
      duration: performance.now() - captureStart,
    });
    send("page", {
      toolCallId,
      url: capturedPage.url(),
      title: await capturedPage.title(),
      image: `data:image/jpeg;base64,${image.toString("base64")}`,
      label,
      pages: visited.size,
      tabs: await browserTabs(capturedPage),
    });
  };
  const capture = async (label: string, toolCallId?: string) => {
    if (page) registerTabs(page);
    const capturedPage = viewedPage && !viewedPage.isClosed() ? viewedPage : page;
    if (capturedPage) await capturePage(capturedPage, label, toolCallId, true);
  };
  // Workers continue concurrently, while these short presentation updates are
  // serialized so the native window and embedded preview show one real worker.
  let livePreviewQueue = Promise.resolve();
  const showWorkerProgress = async (
    workerPage: Page,
    label: string,
    toolCallId?: string,
  ) => {
    livePreviewQueue = livePreviewQueue
      .catch(() => {})
      .then(async () => {
        if (workerPage.isClosed()) return;
        await workerPage.bringToFront();
        generalPage = workerPage;
        await capturePage(workerPage, label, toolCallId);
      });
    await livePreviewQueue.catch(() => {});
  };
  let lastGroceryPreview = 0;
  const groceries = new GroceryTools(signal, async (activePage, label, duration, category) => {
    visited.add(activePage.url());
    recordSpan({name: label, duration, category});
    send("action", {label, actions: ++actions, status: "done"});
    if (performance.now() - lastGroceryPreview > 150 || label.startsWith("Cart verified")) {
      lastGroceryPreview = performance.now();
      page = activePage;
      generalPage = activePage;
      await capture(label);
    }
  }, activity => send("store-activity", {activity}));
  const read = async () => {
    const t = performance.now();
    const state = await page!.evaluate(readPageScript);
    recordSpan({
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
    send("start", { mode: configuration().mode, model: configuration().model });
    if (viewedPage && !viewedPage.isClosed()) generalPage = viewedPage;
    page = await warmGeneral();
    // Headless pages all report visible; keep the adopted cart tab in that mode.
    const takeoverCandidates =
      process.env.BROWSER_HEADLESS !== "false" ? [] : page.context().pages();
    for (const candidate of takeoverCandidates) {
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

    if (page.url() !== "about:blank") {
      messages.push({
        role: "user",
        content: `Current browser page: ${JSON.stringify(await read())}`,
      });
      await capture("Reading your current browser tab");
    }
    for (let turn = 0; !summary; turn++) {
      signal.throwIfAborted();
      send("inference-start", { call: turn + 1 });
      let queue = Promise.resolve();
      const results: { call: ToolCall; result: unknown }[] = [];
      const visionImage = await page.screenshot({
        type: 'jpeg',
        quality: 72,
        animations: 'disabled',
        timeout: 4000,
      });
      const step = await modelStep(
        [
          ...messages,
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Current browser screenshot. Use its pixels for every visual claim; use the latest DOM observation for element IDs.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${visionImage.toString('base64')}`,
                  detail: 'low',
                },
              },
            ],
          },
        ],
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
                if (groceries.approval && call.name !== "finish") {
                  value = {error: "A cart is already verified and awaiting approval. Call finish with its total and delivery. Do not build more carts."};
                } else if (call.name === "search_groceries") {
                  value = await groceries.search(args.queries as string[]);
                } else if (call.name === "build_grocery_cart") {
                  value = await groceries.cart(args.store as StoreId, args.items as {id: string; quantity: number}[], String(args.slot));
                  if (groceries.approval) onApproval?.(groceries.approval);
                } else if (call.name === "parallel_browse") {
                  value = await inspectRemotePages(args.urls as string[], async (remote, label, duration, category)=>{
                    visited.add(remote.url());recordSpan({name:`${label}: ${new URL(remote.url()==="about:blank"?"https://pending.invalid":remote.url()).hostname}`,duration,category});
                    send("action",{label:`${label}: ${remote.url()}`,actions:++actions,status:tabWork.get(remote)==="error"?"error":"done"});
                    page=remote;generalPage=remote;await capture(label,call.id);
                  }, signal);
                } else if (call.name === "open_listing_tabs") {
                  const supplied = args.urls;
                  if (!Array.isArray(supplied) || supplied.length < 2 || supplied.length > 10)
                    throw new Error("Choose 2–10 Marketplace listing URLs.");
                  const urls = [...new Set(supplied.map((raw) => {
                    const url = new URL(safePublicURL(String(raw)));
                    if (
                      !/(^|\.)facebook\.com$/i.test(url.hostname) ||
                      !url.pathname.startsWith("/marketplace/item/")
                    )
                      throw new Error("Only Facebook Marketplace listing URLs can be preloaded.");
                    url.hash = "";
                    return url.href;
                  }))];
                  if (urls.length < 2)
                    throw new Error("Choose at least two unique Marketplace listings.");
                  const existingTabs = generalContext!.pages().filter((tab) => !tab.isClosed());
                  const loaded = await Promise.all(urls.map(async (url, workerIndex) => {
                    const requested = new URL(url);
                    let tab = existingTabs.find((candidate) => {
                      try {
                        const current = new URL(candidate.url());
                        return current.origin === requested.origin && current.pathname === requested.pathname;
                      } catch {
                        return false;
                      }
                    });
                    const reused = Boolean(tab);
                    tab ||= await generalContext!.newPage();
                    registerTabs(tab);
                    tab.setDefaultTimeout(4000);
                    tabWork.set(tab, "loading");
                    try {
                      await showWorkerProgress(tab, `Worker ${workerIndex + 1} tab opened`, call.id);
                      if (!reused)
                        await tab.goto(url, {
                          waitUntil: "domcontentloaded",
                          timeout: 12000,
                        });
                      await tab.locator("body").waitFor({ state: "attached", timeout: 3000 });
                      tabWork.set(tab, "reading");
                      const workerTitle = (await tab.title().catch(() => "Marketplace listing")).slice(0, 70);
                      await showWorkerProgress(tab, `Worker ${workerIndex + 1} loaded: ${workerTitle}`, call.id);
                      const verdict = await inspectMarketplaceListing(
                        tab,
                        signal,
                        (timing) => {
                          timings.push(timing);
                          send("inference", { call: timings.length, timing });
                        },
                        async (label) => {
                          send("action", {
                            label: `Worker ${workerIndex + 1}: ${label}`,
                            actions: ++actions,
                            status: "done",
                          });
                          await showWorkerProgress(tab, `Worker ${workerIndex + 1}: ${label}`, call.id);
                        },
                      );
                      tabWork.set(tab, verdict.status === "blocked" ? "error" : "ready");
                      return {
                        reused,
                        ...verdict,
                      };
                    } catch (error) {
                      tabWork.set(tab, "error");
                      return {
                        url,
                        reused,
                        error: error instanceof Error ? friendlyBrowserError(error.message) : "Listing failed to load.",
                      };
                    }
                  }));
                  value = {
                    candidates: loaded,
                    matchCount: loaded.filter((candidate) => "status" in candidate && candidate.status === "match").length,
                    next: "The candidates were fully processed by parallel vision workers. If at least two matched, immediately call finish with the best two; do not inspect them again serially.",
                  };
                  await capture(`Processed ${urls.length} listing tabs in parallel`, call.id);
                } else if (call.name === "navigate") {
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
                } else if (call.name === "scroll") {
                  if (!["up", "down"].includes(String(args.direction)))
                    throw new Error("Choose up or down.");
                  await page!.evaluate(
                    (direction) =>
                      window.scrollBy({
                        top: (direction === "up" ? -1 : 1) * innerHeight * 0.8,
                        behavior: "instant",
                      }),
                    String(args.direction),
                  );
                  value = await read();
                  await capture("Scrolled the page", call.id);
                } else if (call.name === "go_back") {
                  await page!.goBack({
                    waitUntil: "domcontentloaded",
                    timeout: 12000,
                  });
                  value = await read();
                  await capture("Went back", call.id);
                } else if (call.name === "list_tabs") {
                  value = await Promise.all(
                    [...tabPages.values()].filter(tab=>!tab.isClosed())
                      .map(async (tab, id) => ({
                        id,
                        url: tab.url(),
                        title: await tab.title(),
                      })),
                  );
                } else if (call.name === "switch_tab") {
                  const tab = [...tabPages.values()].filter(tab=>!tab.isClosed())[Number(args.id)];
                  if (!Number.isInteger(args.id) || !tab || tab.isClosed())
                    throw new Error("Unknown tab. Call list_tabs again.");
                  page = tab;
                  generalPage = tab;
                  await page.bringToFront();
                  value = await read();
                  await capture("Switched tab", call.id);
                } else if (call.name === "finish") {
                  summary = String(args.summary || "Done.");
                  value = "Task complete.";
                } else if (
                  ["click", "fill", "press", "select"].includes(call.name)
                ) {
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
                  } else if (call.name === "select") {
                    await locator.selectOption(String(args.value));
                  } else if (call.name === "fill") {
                    const type = await locator.getAttribute("type");
                    if (type === "password")
                      throw new Error("Password entry requires the user.");
                    await locator.fill(String(args.text ?? ""));
                  } else {
                    if (
                      !["Enter", "Tab", "Escape", "ArrowDown", "ArrowRight"].includes(
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
              recordSpan({
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
                error: typeof value === "object" && value !== null && "error" in value ? friendlyBrowserError(String(value.error)) : undefined,
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
        Boolean(groceries.approval),
      );
      timings.push(step.timing);
      recordSpan({
        name: `Browser inference ${turn + 1}`,
        category: "model",
        duration: step.timing.total,
      });
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
      for (let i = 0; i < messages.length - results.length - 2; i++) {
        const content = messages[i].content;
        if (
          messages[i].role === "tool" &&
          typeof content === "string" &&
          content.length > 2400
        )
          try {
            messages[i].content = JSON.stringify(JSON.parse(content, (key,value)=>{
              if(key === "elements" && Array.isArray(value)) return value.filter(item=>item.href && item.href.length<1000).map(item=>({label:item.label,href:item.href})).slice(0,30);
              if(key === "snapshotId") return undefined;
              return value;
            }));
          } catch { /* Keep non-JSON tool responses intact. */ }
      }
    }
    send("done", {
      summary,
      metrics: {
        total: performance.now() - start,
        actions,
        modelCalls: timings.length,
        pages: visited.size,
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

export async function generalPreview() {
  const page = viewedPage && !viewedPage.isClosed() ? viewedPage : await warmGeneral();
  const image = await page.screenshot({
    type: "jpeg",
    quality: 65,
    animations: "disabled",
    timeout: 4000,
  });
  return {
    image: `data:image/jpeg;base64,${image.toString("base64")}`,
    url: page.url(),
    title: await page.title(),
    label: "Browser ready",
    tabs: await browserTabs(page),
  };
}

async function resetBrowserView() {
  await warmGeneral();
  const page = generalContext!.pages().find(p=>!p.isClosed()) || await generalContext!.newPage();
  const contexts = new Set([...tabPages.values()].filter(p=>!p.isClosed()).map(p=>p.context()));
  await Promise.all([...contexts].filter(context=>context!==generalContext).map(context=>context.close()));
  await Promise.all(generalContext!.pages().filter(tab=>tab!==page).map(tab=>tab.close()));
  tabPages.clear();tabWork.clear();openedPages.clear();
  viewedPage = undefined;generalPage = page;
  await page.route("**/*", routeGeneralResource);
  if(!page.url().startsWith("https://www.facebook.com/marketplace")) await page.goto("https://www.facebook.com/marketplace/",{waitUntil:"domcontentloaded",timeout:12000});
}
export async function resetGeneralBrowser() {
  if (busy) throw new Error("Wait for the current browser action to finish.");
  busy=true;
  try {await resetBrowserView();return await generalPreview();}
  finally {busy=false;}
}

export async function interactGeneralBrowser(input: {type: string; x?: number; y?: number; deltaX?: number; deltaY?: number; key?: string; text?: string}) {
  if (busy) throw new Error("Wait for the agent to finish before interacting.");
  busy = true;
  try {
    const page = viewedPage && !viewedPage.isClosed() ? viewedPage : await warmGeneral();
    if (input.type === "click") await page.mouse.click(input.x!, input.y!);
    else if (input.type === "scroll") {
      await page.mouse.move(input.x!, input.y!);
      await page.mouse.wheel(input.deltaX!, input.deltaY!);
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    } else if (input.type === "key") await page.keyboard.press(input.key!);
    else if (input.type === "text") await page.keyboard.insertText(input.text!);
    await page.waitForLoadState("domcontentloaded", {timeout: 12000});
    return await generalPreview();
  } finally { busy = false; }
}
