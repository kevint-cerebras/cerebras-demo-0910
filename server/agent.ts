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
  amazonBrowserSystem,
  amazonBrowserTools,
  authorizedAmazonPurchaseAction,
  browserSystem,
  classifyAmazonOrderState,
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

function isPlaywrightTimeout(error: unknown) {
  return error instanceof Error && /Timeout.*exceeded|timed out/i.test(error.message);
}

async function navigateWhenUsable(page: Page, url: string, timeout = 12_000) {
  const previousURL = page.url();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  } catch (error) {
    // Amazon frequently keeps ad/service-worker requests alive past Playwright's
    // navigation deadline even though the document is already usable.
    const usable =
      isPlaywrightTimeout(error) &&
      page.url() !== "about:blank" &&
      (page.url() !== previousURL || previousURL === url) &&
      (await page.locator("body").count().catch(() => 0)) > 0;
    if (!usable) throw error;
    await page.evaluate(() => window.stop()).catch(() => {});
  }
}

const lastStableScreenshot = new WeakMap<Page, Buffer>();
async function screenshotWhenStable(page: Page, quality: number) {
  try {
    const image = await page.screenshot({
      type: "jpeg",
      quality,
      animations: "disabled",
      timeout: 7_000,
    });
    lastStableScreenshot.set(page, image);
    return image;
  } catch (error) {
    if (!isPlaywrightTimeout(error)) throw error;
    // Stop lingering ad frames and retry once. A preview timeout must not abort
    // an otherwise healthy shopping run.
    await page.evaluate(() => window.stop()).catch(() => {});
    try {
      const image = await page.screenshot({
        type: "jpeg",
        quality,
        animations: "disabled",
        timeout: 7_000,
      });
      lastStableScreenshot.set(page, image);
      return image;
    } catch (retryError) {
      const cached = lastStableScreenshot.get(page);
      if (cached && isPlaywrightTimeout(retryError)) return cached;
      throw retryError;
    }
  }
}
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
  const defaultSystem =
    config.demo === "amazon" ? amazonBrowserSystem : browserSystem;
  const defaultTools =
    config.demo === "amazon" ? amazonBrowserTools : marketplaceBrowserTools;
  const privateAmazonBrief =
    config.demo === "amazon" && config.amazonBrief.trim()
      ? `\n\nPRIVATE SESSION BRIEF\n${config.amazonBrief.trim()}\nTreat this as private runtime context. Never quote, display, or mention the delivery address in tool summaries or the final answer.`
      : "";
  const privatePurchaseAuthorization =
    config.demo === "amazon" && config.amazonPurchaseAuthorized
      ? "\n\nPURCHASE AUTHORIZATION\nAMAZON_PURCHASE_AUTHORIZED=true for this local session. After all cart and final-review checks pass, you are explicitly authorized to click Amazon's final Place your order control and verify the confirmation page."
      : "";
  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: `${options.system || defaultSystem}${privateAmazonBrief}${privatePurchaseAuthorization}` }, ...messages],
      tools: options.tools || (finishOnly
        ? defaultTools.filter((tool) => tool.function.name === 'finish')
        : defaultTools),
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
  const firstPhoto = await screenshotWhenStable(candidatePage, 64);
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

type AmazonProductVerdict = {
  status: "eligible" | "no_match" | "blocked";
  title: string;
  price: string;
  availability: string;
  delivery: string;
  url: string;
  evidence: string;
  reason: string;
};

function compactAmazonObservation(raw: unknown) {
  const observation = raw && typeof raw === "object"
    ? raw as { url?: unknown; title?: unknown; text?: unknown; elements?: unknown }
    : {};
  const lines = String(observation.text || "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const relevant = lines.filter((line) =>
    /\b(?:llama|alpaca|price|in stock|available|unavailable|delivery|deliver|ships?|sold by|one-time|subscription|add to cart|buy now)\b|\$\s*\d/i.test(line),
  );
  const text = [...new Set([...lines.slice(0, 24), ...relevant])]
    .join("\n")
    .slice(0, 2_400);
  const elements = Array.isArray(observation.elements)
    ? observation.elements.filter((element) =>
        /add to cart|buy now|one-time|subscription/i.test(JSON.stringify(element)),
      ).slice(0, 8)
    : [];
  return {
    url: String(observation.url || ""),
    title: String(observation.title || ""),
    text,
    elements,
  };
}

async function inspectAmazonProductName(productPage: Page): Promise<AmazonProductVerdict> {
  const canonicalURL = productPage.url();
  const asin = amazonASIN(canonicalURL);
  const cached = asin ? amazonProductSnapshots.get(asin) : undefined;
  const freshCache = cached && Date.now() - cached.createdAt < 30 * 60_000 ? cached : undefined;
  const observation = compactAmazonObservation(
    freshCache?.observation || await productPage.evaluate(readPageScript),
  );
  const title = observation.title || await productPage.title().catch(() => "Unknown product");
  const priceMatch = observation.text.match(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
  const priceValue = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null;
  const nameMatches = /\b(?:llama|alpaca)\b/i.test(title);
  const unavailable = /currently unavailable|temporarily out of stock/i.test(observation.text);
  const addable = /add to cart/i.test(JSON.stringify(observation.elements));
  const priceAllowed = priceValue === null || (priceValue >= 5 && priceValue <= 50);
  const eligible = nameMatches && !unavailable && addable && priceAllowed;
  const delivery = observation.text.split("\n").find((line) => /deliver|ships?/i.test(line)) || "Delivery checked in cart";
  return {
    status: eligible ? "eligible" : "no_match",
    title,
    price: priceMatch?.[0]?.replace(/\s+/g, "") || "Verified in cart",
    availability: unavailable ? "Unavailable" : addable ? "Add to Cart available" : "No Add to Cart control",
    delivery,
    url: productPage.url() || canonicalURL,
    evidence: `Mechanical name match: ${nameMatches ? "yes" : "no"}; Add to Cart: ${addable ? "yes" : "no"}.`,
    reason: eligible ? "Selected by name and basic commerce constraints." : "Failed name, price, availability, or Add-to-Cart check.",
  };
}
let generalContext: BrowserContext | undefined;
let generalPage: Page | undefined;
const tabPages = new Map<string, Page>();
const tabWork = new Map<Page, "loading" | "reading" | "ready" | "error">();
const disclosedTabs = new Set<Page>();
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
        const start=performance.now();await navigateWhenUsable(page,url);navigation=performance.now()-start;
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
  return Promise.all([...tabPages.entries()]
    .filter(([,p])=>!p.isClosed() && (p === active || disclosedTabs.has(p)))
    .map(async ([id,p])=>({id,url:p.url(),title:await p.title().catch(()=>p.url()),active:p===active,work:tabWork.get(p)})));
}
export async function selectBrowserTab(id: string) {
  const page=tabPages.get(id);
  if(!page || page.isClosed()) throw new Error("This tab is closed.");
  viewedPage=page;
  generalPage=page;
  return generalPreview();
}
let warming: Promise<Page> | undefined;
let amazonWarming: Promise<void> | undefined;
let busy = false;
let whenIdle: Promise<void> = Promise.resolve();
const amazonWarmQueries = [
  "llama plush",
  "llama shirt",
  "llama mug",
  "llama decor",
  "llama socks",
  "llama keychain",
];
const amazonProductSnapshots = new Map<string, {
  createdAt: number;
  observation: unknown;
}>();

function amazonSearchURL(query: string) {
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
}

function amazonASIN(raw: string) {
  return raw.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]?.toUpperCase();
}

async function amazonProductLinks(searchPage: Page) {
  return searchPage
    .locator('a[href*="/dp/"], a[href*="/gp/product/"]')
    .evaluateAll((anchors) =>
      anchors.slice(0, 80).map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        title: (anchor.getAttribute("aria-label") || anchor.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 180),
      })),
    );
}
async function routeGeneralResource(route: Route) {
  const request = route.request();
  const url = request.url();
  try {
    safePublicURL(url, `http://127.0.0.1:${process.env.PORT || 3100}`);
  } catch {
    await route.abort().catch(() => {});
    return;
  }
  try {
    const parsedURL = new URL(url);
    let frameURL = "";
    if (!request.serviceWorker()) {
      try {
        frameURL = request.frame().url();
      } catch {
        // Early navigation requests can arrive before Playwright exposes a frame.
      }
    }
    if (/\/(?:recaptcha|sorry)\//.test(parsedURL.pathname) && /(^|\.)(google\.com|gstatic\.com)$/.test(parsedURL.hostname)) {
      await route.continue();
      return;
    }
    if (
      ["font", "media"].includes(request.resourceType()) ||
      (request.resourceType() === "image" && /amazon\.com\/s(?:[?#]|$)/i.test(frameURL)) ||
      /doubleclick|google-analytics|googletagmanager|hotjar|segment\.io/.test(
        url,
      )
    )
      await route.abort();
    else
      await route.continue();
  } catch {
    // Resource filtering is an optimization. It must never take down a run.
    await route.continue().catch(() => {});
  }
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
    const demo = configuration().demo;
    const profileDirectory = `.browser-profile/${demo}`;
    const startURL = demo === "amazon"
      ? "https://www.amazon.com/"
      : "https://www.facebook.com/marketplace/";
    mkdirSync(profileDirectory, { recursive: true });
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
      profileDirectory,
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
    await navigateWhenUsable(generalPage, startURL);
    return generalPage;
  })();
  try {
    return await warming;
  } finally {
    warming = undefined;
  }
}

export async function warmAmazonPages() {
  if (configuration().demo !== "amazon") return;
  if (amazonWarming) return amazonWarming;
  amazonWarming = (async () => {
    const home = await warmGeneral();
    const context = generalContext!;
    // Cookies and the cart live in the persistent context, not its old tabs.
    // Start each presentation with one clean home tab so previous product/cart
    // documents do not compete with the new parallel preload wave.
    await Promise.all(
      context.pages()
        .filter((tab) => tab !== home)
        .map((tab) => tab.close().catch(() => {})),
    );
    const searchPages = await Promise.all(
      amazonWarmQueries.map(async (query) => {
        const existing = context.pages().find((candidate) => {
          try {
            const url = new URL(candidate.url());
            return /(^|\.)amazon\.com$/i.test(url.hostname) && url.pathname === "/s" && url.searchParams.get("k") === query;
          } catch {
            return false;
          }
        });
        const tab = existing || (await context.newPage());
        registerTabs(tab);
        tab.setDefaultTimeout(5000);
        try {
          if (!existing) {
            tabWork.set(tab, "loading");
            await navigateWhenUsable(tab, amazonSearchURL(query), 15_000);
          }
          await tab.locator("body").waitFor({ state: "attached", timeout: 4000 });
          await tab.locator('a[href*="/dp/"], a[href*="/gp/product/"]').first().waitFor({ state: "attached", timeout: 2500 }).catch(() => {});
          await tab.evaluate(() => window.stop()).catch(() => {});
          tabWork.set(tab, "ready");
          return tab;
        } catch {
          tabWork.set(tab, "error");
          return null;
        }
      }),
    );
    const uniqueProducts = new Map<string, string>();
    const productsBySearch = await Promise.all(
      searchPages.map((searchPage) =>
        searchPage ? amazonProductLinks(searchPage).catch(() => []) : [],
      ),
    );
    // Round-robin across categories so speculative product tabs are diverse
    // instead of consuming all ten slots from the first (usually plush) page.
    for (let productIndex = 0; productIndex < 10 && uniqueProducts.size < 6; productIndex++) {
      for (const products of productsBySearch) {
        const product = products[productIndex];
        if (!product) continue;
        const asin = amazonASIN(product.href);
        if (asin && !uniqueProducts.has(asin)) {
          uniqueProducts.set(asin, `https://www.amazon.com/dp/${asin}`);
          if (uniqueProducts.size === 6) break;
        }
      }
    }
    await Promise.all(
      [...uniqueProducts.values()].slice(0, 6).map(async (url) => {
        const pathname = new URL(url).pathname;
        const existing = context.pages().find((candidate) => {
          try {
            return new URL(candidate.url()).pathname === pathname;
          } catch {
            return false;
          }
        });
        if (existing) return;
        const tab = await context.newPage();
        registerTabs(tab);
        tab.setDefaultTimeout(5000);
        tabWork.set(tab, "loading");
        try {
          await navigateWhenUsable(tab, url, 15_000);
          await tab.locator("body").waitFor({ state: "attached", timeout: 4000 });
          const asin = amazonASIN(tab.url());
          if (asin) {
            const observation = compactAmazonObservation(await tab.evaluate(readPageScript));
            amazonProductSnapshots.set(asin, { createdAt: Date.now(), observation });
          }
          await tab.evaluate(() => window.stop()).catch(() => {});
          tabWork.set(tab, "ready");
        } catch {
          tabWork.set(tab, "error");
        }
      }),
    );
    generalPage = home;
    viewedPage = undefined;
    await home.bringToFront();
  })();
  try {
    await amazonWarming;
  } finally {
    amazonWarming = undefined;
  }
}
export async function closeGeneral() {
  await remoteBrowser?.close();
  await generalContext?.close();
  generalPage = undefined;
  generalContext = undefined;
  amazonWarming = undefined;
  amazonProductSnapshots.clear();
  disclosedTabs.clear();
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
  let modelCallsStarted = 0;
  let summary = "";
  let backgroundCoordinator: Promise<string | undefined> | undefined;
  let orderSubmissionPending = false;
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
  const runCoordinationCall = async (
    label: string,
    system: string,
    content: string,
    maxCompletionTokens = 180,
  ) => {
    const callNumber = ++modelCallsStarted;
    send("inference-start", { call: callNumber });
    try {
      const step = await modelStep(
        [{ role: "user", content }],
        () => {},
        signal,
        true,
        { system, maxCompletionTokens },
      );
      timings.push(step.timing);
      recordSpan({ name: label, category: "model", duration: step.timing.total });
      send("inference", { call: callNumber, timing: step.timing });
      const finish = step.calls.find((call) => call.function.name === "finish");
      if (!finish) return undefined;
      const args = JSON.parse(finish.function.arguments) as { summary?: unknown };
      return typeof args.summary === "string" ? args.summary.trim() : undefined;
    } catch (error) {
      if (!signal.aborted)
        send("action", {
          label: `${label} skipped: ${friendlyBrowserError(error instanceof Error ? error.message : "provider error")}`,
          actions,
          status: "error",
        });
      return undefined;
    }
  };
  const capturePage = async (
    capturedPage: Page,
    label: string,
    toolCallId?: string,
    showPointer = false,
  ) => {
    registerTabs(capturedPage);
    disclosedTabs.add(capturedPage);
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
    const image = await screenshotWhenStable(capturedPage, 65);
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
  // They never sit on the execution critical path.
  let livePreviewQueue = Promise.resolve();
  let lastWorkerPreview = 0;
  const showWorkerProgress = (
    workerPage: Page,
    label: string,
    toolCallId?: string,
  ) => {
    disclosedTabs.add(workerPage);
    const now = performance.now();
    if (now - lastWorkerPreview < 180) return Promise.resolve();
    lastWorkerPreview = now;
    livePreviewQueue = livePreviewQueue
      .catch(() => {})
      .then(async () => {
        if (workerPage.isClosed()) return;
        await workerPage.bringToFront();
        generalPage = workerPage;
        await capturePage(workerPage, label, toolCallId);
      });
    return Promise.resolve();
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
  const inspectAmazonURLs = async (urls: string[], toolCallId: string) => {
    const existingTabs = generalContext!.pages().filter((tab) => !tab.isClosed());
    return Promise.all(urls.map(async (url, workerIndex) => {
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
      disclosedTabs.add(tab);
      tab.setDefaultTimeout(4000);
      tabWork.set(tab, reused ? "reading" : "loading");
      try {
        await showWorkerProgress(tab, `Amazon worker ${workerIndex + 1} tab ${reused ? "reused" : "opened"}`, toolCallId);
        if (!reused)
          await navigateWhenUsable(tab, url);
        await tab.locator("body").waitFor({ state: "attached", timeout: 3000 });
        tabWork.set(tab, "reading");
        const title = (await tab.title().catch(() => "Amazon product")).slice(0, 70);
        await showWorkerProgress(tab, `Amazon worker ${workerIndex + 1} loaded: ${title}`, toolCallId);
        const verdict = await inspectAmazonProductName(tab);
        send("action", {
          label: `Amazon worker ${workerIndex + 1}: matched product name`,
          actions: ++actions,
          status: "done",
        });
        await showWorkerProgress(tab, `Amazon worker ${workerIndex + 1}: matched ${verdict.title.slice(0, 55)}`, toolCallId);
        tabWork.set(tab, verdict.status === "blocked" ? "error" : "ready");
        return { reused, ...verdict };
      } catch (error) {
        tabWork.set(tab, "error");
        return {
          url,
          reused,
          status: "blocked" as const,
          error: error instanceof Error ? friendlyBrowserError(error.message) : "Product failed to load.",
        };
      }
    }));
  };
  const addAmazonURLs = async (urls: string[], toolCallId: string) => {
    const addResults: { url: string; added: boolean; error?: string }[] = [];
    // Amazon's cart is one shared server-side object. Concurrent POSTs race and
    // can overwrite one another, causing expensive discovery/retry loops. Keep
    // product reads parallel, but commit the five already-selected items as one
    // tight inference-free sequence.
    for (const [workerIndex, url] of urls.entries()) {
      const requested = new URL(url);
      const tab = generalContext!.pages().find((candidate) => {
        try {
          const current = new URL(candidate.url());
          return current.origin === requested.origin && current.pathname === requested.pathname;
        } catch {
          return false;
        }
      });
      if (!tab) {
        addResults.push({ url, added: false, error: "Preloaded product tab is no longer open." });
        continue;
      }
      try {
        const button = tab.locator(
          '#add-to-cart-button, input[name="submit.add-to-cart"], button[name="submit.add-to-cart"]',
        ).first();
        if (!await button.isVisible().catch(() => false))
          throw new Error("No visible one-time Add to Cart control was found.");
        const cartWrite = tab.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            /(?:add-to-cart|\/cart\/|\/gp\/cart)/i.test(response.url()),
          { timeout: 5000 },
        ).catch(() => null);
        await button.click({ timeout: 5000, noWaitAfter: true });
        // Wait for Amazon to accept this write before starting the next one.
        // Five acknowledged writes are faster than parallel writes followed by
        // missing-item discovery and retries.
        await cartWrite;
        await showWorkerProgress(tab, `Amazon cart worker ${workerIndex + 1}: added product`, toolCallId);
        send("action", {
          label: `Cart batch ${workerIndex + 1}/${urls.length}: added product`,
          actions: ++actions,
          status: "done",
        });
        addResults.push({ url, added: true });
      } catch (error) {
        tabWork.set(tab, "error");
        addResults.push({ url, added: false, error: error instanceof Error ? friendlyBrowserError(error.message) : "Add to Cart failed." });
      }
    }
    const cartPage = await generalContext!.newPage();
    registerTabs(cartPage);
    tabWork.set(cartPage, "loading");
    await navigateWhenUsable(cartPage, "https://www.amazon.com/gp/cart/view.html");
    page = cartPage;
    generalPage = cartPage;
    tabWork.set(cartPage, "ready");
    const expectedASINs = new Set(urls.map(amazonASIN).filter((asin): asin is string => Boolean(asin)));
    const cartItems = cartPage.locator(
      '.sc-list-item[data-asin]:not([data-asin=""]), [data-name="Active Items"] [data-asin]:not([data-asin=""])',
    );
    // Remove stale test items and normalize selected products to quantity one.
    // This is part of the already-authorized cart operation and prevents an old
    // persistent-profile cart from leaking into a real checkout.
    const initialCartASINs = await cartItems.evaluateAll((items) => [
      ...new Set(items.map((item) => (item.getAttribute("data-asin") || "").toUpperCase()).filter(Boolean)),
    ]);
    for (const asin of initialCartASINs) {
      const item = cartPage.locator(
        `.sc-list-item[data-asin="${asin}"], [data-name="Active Items"] [data-asin="${asin}"]`,
      ).first();
      if (!expectedASINs.has(asin)) {
        const remove = item.locator(
          'input[value="Delete"], input[data-action="delete"], button[aria-label*="Delete" i], button:has-text("Delete")',
        ).first();
        if (await remove.isVisible().catch(() => false)) {
          const mutation = cartPage.waitForResponse(
            (response) => response.request().method() === "POST" && /cart/i.test(response.url()),
            { timeout: 4000 },
          ).catch(() => null);
          await remove.click({ timeout: 4000, noWaitAfter: true });
          await mutation;
        }
        continue;
      }
      const quantity = item.locator('select[name^="quantity"], select[aria-label*="Quantity" i]').first();
      if (await quantity.count()) {
        const current = await quantity.inputValue().catch(() => "1");
        if (current !== "1") {
          await quantity.selectOption("1").catch(() => {});
          await cartPage.waitForTimeout(250);
        }
      }
    }
    await cartPage.waitForTimeout(350);
    const normalizedCart = await cartPage.locator(
      '.sc-list-item[data-asin]:not([data-asin=""]), [data-name="Active Items"] [data-asin]:not([data-asin=""])',
    ).evaluateAll((items) => {
      const unique = new Map<string, string>();
      for (const item of items) {
        const asin = (item.getAttribute("data-asin") || "").toUpperCase();
        if (!asin || unique.has(asin)) continue;
        const select = item.querySelector('select[name^="quantity"], select[aria-label*="Quantity" i]') as HTMLSelectElement | null;
        unique.set(asin, select?.value || "1");
      }
      return [...unique.entries()].map(([asin, quantity]) => ({ asin, quantity }));
    });
    const cartVerified =
      normalizedCart.length === expectedASINs.size &&
      [...expectedASINs].every((asin) => normalizedCart.some((item) => item.asin === asin && item.quantity === "1"));
    const cart = await read();
    await capturePage(cartPage, "Amazon cart verification", toolCallId);
    await Promise.all(
      generalContext!.pages()
        .filter((tab) => tab !== cartPage && /\/cart\/(?:add-to-cart|smart-wagon)/i.test(tab.url()))
        .map((tab) => tab.close().catch(() => {})),
    );
    return {
      additions: addResults,
      addedCount: addResults.filter((result) => result.added).length,
      cartVerified,
      normalizedCart,
      cart,
    };
  };
  const fastAmazonCheckout = async (activePage: Page) => {
    let submitted = false;
    const control = async (patterns: RegExp[]) => {
      const candidates = activePage.locator('button, input[type="submit"], [role="button"], a');
      const count = Math.min(await candidates.count(), 140);
      for (const pattern of patterns) {
        for (let index = 0; index < count; index++) {
          const candidate = candidates.nth(index);
          if (!await candidate.isVisible().catch(() => false)) continue;
          const label = [
            await candidate.getAttribute("aria-label"),
            await candidate.getAttribute("value"),
            await candidate.textContent(),
          ].filter(Boolean).join(" ").trim().replace(/\s+/g, " ");
          if (pattern.test(label)) return { candidate, label };
        }
      }
      return null;
    };
    const checkoutDeadline = Date.now() + 120_000;
    for (let step = 0; step < 12; step++) {
      signal.throwIfAborted();
      const url = activePage.url();
      const text = await activePage.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      if (/\/gp\/buy\/thankyou|order (?:has been|is) (?:placed|confirmed)|thank you.*order/i.test(`${url}\n${text}`))
        {
          orderSubmissionPending = false;
          return { status: "confirmed" as const, page: activePage, detail: "Amazon order confirmation is visible." };
        }
      if (/\/ap\/signin|captcha|enter (?:the )?(?:one-time|verification) code|\botp\b|passkey|approve.*bank app/i.test(`${url}\n${text}`))
        {
          orderSubmissionPending = false;
          return { status: "manual_action" as const, page: activePage, detail: "Amazon requires login, CAPTCHA, OTP, passkey, or bank approval." };
        }
      if (submitted) {
        const state = classifyAmazonOrderState(url, text);
        if (state !== "pending") {
          orderSubmissionPending = false;
          await capturePage(activePage, `Amazon order ${state.replace("_", " ")}`, id).catch(() => {});
          return { status: state, page: activePage, detail: `Amazon order state: ${state}.` };
        }
        if (Date.now() >= checkoutDeadline)
          return { status: "pending" as const, page: activePage, detail: "Amazon is still processing payment authorization." };
        // Payment authorization is external latency. Poll the page directly;
        // no model call or screenshot loop is needed while it is pending.
        await activePage.waitForTimeout(750);
        step--;
        continue;
      }
      let next: Awaited<ReturnType<typeof control>> = null;
      let label = "";
      // Inspect the real final-submit control before generic section text. A
      // review page contains address and payment headings too.
      const finalOrder = await control([/^place your order/i, /^confirm order/i, /^submit order/i]);
      if (finalOrder) {
        if (!/sunnyvale|94085/i.test(text))
          return { status: "manual_action" as const, page: activePage, detail: "The final-review delivery destination could not be verified as Sunnyvale." };
        next = finalOrder;
        label = "Placing authorized order";
        submitted = true;
        orderSubmissionPending = true;
      } else if (/\/cart(?:\/|\?|$)|\/gp\/cart/i.test(url)) {
        next = await control([/proceed to checkout/i]);
        label = "Proceeding to checkout";
      } else if (/shipping address|choose.*address|deliver to this address|use this address/i.test(text)) {
        if (!/sunnyvale|94085/i.test(text))
          return { status: "manual_action" as const, page: activePage, detail: "The saved delivery address could not be verified as Sunnyvale." };
        next = await control([/use this address/i, /deliver to this address/i, /ship to this address/i]);
        label = "Using verified saved address";
      } else if (/payment method|select a payment|your payment/i.test(text)) {
        if (/add a (?:credit|debit) card|enter.*card number/i.test(text) && !/ending in|card on file|saved payment/i.test(text))
          return { status: "manual_action" as const, page: activePage, detail: "No usable saved payment method was visible." };
        next = await control([/use this payment method/i, /^continue$/i, /continue to review/i]);
        label = "Using saved payment method";
      } else {
        next = await control([/use this delivery option/i, /^continue$/i, /continue to (?:payment|review)/i]);
        label = "Advancing checkout";
      }
      if (!next)
        return { status: "manual_action" as const, page: activePage, detail: "Checkout did not expose a recognized safe next control." };
      send("action", { label, actions: ++actions, status: "done" });
      try {
        await next.candidate.click({ timeout: 5000, noWaitAfter: true });
      } catch (error) {
        // A final-submit click may navigate quickly enough to detach its
        // original control. Treat that as submitted and classify the new page.
        if (!submitted) throw error;
      }
      await activePage.waitForTimeout(350);
      await activePage.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      // The visible Chromium window already reflects each action in real time.
      // Avoid blocking checkout on screenshot work; capture only terminal state.
    }
    return { status: "pending" as const, page: activePage, detail: "Checkout is still processing." };
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

    if (page.url() !== "about:blank" && configuration().demo === "marketplace") {
      messages.push({
        role: "user",
        content: `Current browser page: ${JSON.stringify(await read())}`,
      });
      await capture("Reading your current browser tab");
    } else if (configuration().demo === "amazon") {
      send("action", {
        label: "Using preloaded Amazon catalog",
        actions: ++actions,
        status: "done",
      });
      const config = configuration();
      const fixedLlamaRun = /\b(?:llama|alpaca)\b/i.test(`${prompt}\n${config.amazonBrief}`);
      const preloadedProductURLs = generalContext!.pages()
        .map((tab) => tab.url())
        .filter((url) => Boolean(amazonASIN(url)))
        .slice(0, 6);
      if (fixedLlamaRun && preloadedProductURLs.length >= 5) {
        // Three small, real model calls make the reasoning visible without
        // returning to an open-ended, many-turn browser loop. Intent inference
        // overlaps the parallel product inspection below.
        backgroundCoordinator = runCoordinationCall(
          "Intent and constraint inference",
          "You are the request-planning stage of a fast Amazon shopping agent. Call finish immediately with one concise sentence describing the requested item category, quantity, price constraints, and whether checkout is authorized. Never expose private address or payment details and do not claim completion.",
          prompt,
          160,
        );
        for (const tab of generalContext!.pages()) {
          if (!preloadedProductURLs.includes(tab.url())) continue;
          registerTabs(tab);
          disclosedTabs.add(tab);
          tabWork.set(tab, "ready");
        }
        send("action", {
          label: "Analyzing preloaded product tabs in parallel",
          actions: ++actions,
          status: "done",
        });
        const inspected = await inspectAmazonURLs(preloadedProductURLs, id);
        const eligible = inspected.filter((candidate) => candidate.status === "eligible");
        const selection = await runCoordinationCall(
          "Product selection inference",
          "You are the product-selection stage of a fast Amazon shopping agent. Review the supplied structured candidates, choose exactly five distinct eligible products that best match the user's request, and call finish with only a JSON array containing their canonical URLs. Do not request more browsing and do not include commentary.",
          JSON.stringify({ request: prompt, candidates: inspected }),
          260,
        );
        const eligibleURLs = new Set<string>(eligible.map((candidate) => String(candidate.url)));
        const modelURLs: string[] = selection?.match(/https:\/\/www\.amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[^"\s,\]]*)?/gi) || [];
        const selectedURLs: string[] = [...new Set<string>(modelURLs)]
          .filter((url) => eligibleURLs.has(url));
        for (const candidate of eligible)
          if (selectedURLs.length < 5 && !selectedURLs.includes(String(candidate.url)))
            selectedURLs.push(String(candidate.url));
        if (selectedURLs.length < 5) {
          summary = `The product-selection pass found only ${selectedURLs.length} eligible distinct products, so checkout did not start.`;
        } else {
          const fastCart = await addAmazonURLs(selectedURLs.slice(0, 5), id);
          if (config.amazonPurchaseAuthorized && fastCart.addedCount === 5 && fastCart.cartVerified) {
            const checkout = await fastAmazonCheckout(page!);
            if (checkout.status === "confirmed")
              summary = "Order confirmed. Five selected llama products were added through the streamlined cart batch and Amazon displayed its order-confirmation page.";
            else if (checkout.status === "manual_action")
              summary = `Five selected llama products were added, but checkout stopped safely: ${checkout.detail}`;
            else if (checkout.status === "failed")
              summary = "Five selected llama products were added, but Amazon reported that payment or order submission failed.";
            else
              summary = "Five selected llama products were added. Amazon is still processing payment authorization; the order state remains pending.";
            page = checkout.page;
            generalPage = checkout.page;
          } else {
            summary = fastCart.addedCount !== 5
              ? `The streamlined cart batch completed ${fastCart.addedCount} of 5 additions, so checkout did not start.`
              : "The live cart could not be verified as exactly the five selected products at quantity one, so checkout did not start.";
          }
        }
        await backgroundCoordinator;
        const narrated = await runCoordinationCall(
          "Final checkout-state inference",
          "You are the final response stage of an Amazon shopping agent. Restate the supplied verified browser result in one concise sentence. Preserve whether the order was confirmed, failed, remained pending, or stopped for manual action. Do not add facts or expose any address, payment, credential, or private session detail.",
          summary,
          180,
        );
        if (narrated && !/1237|arques|94085|csk-|fw_/i.test(narrated)) summary = narrated;
      }
    }
    for (let turn = 0; !summary; turn++) {
      signal.throwIfAborted();
      send("inference-start", { call: ++modelCallsStarted });
      let queue = Promise.resolve();
      const results: { call: ToolCall; result: unknown }[] = [];
      const visionImage = configuration().demo === "marketplace"
        ? await screenshotWhenStable(page, 72)
        : undefined;
      const step = await modelStep(
        visionImage
          ? [
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
            ]
          : messages,
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
                } else if (call.name === "discover_amazon_products") {
                  const supplied = args.queries;
                  if (!Array.isArray(supplied) || supplied.length < 2 || supplied.length > 8)
                    throw new Error("Choose 2–8 targeted Amazon search queries.");
                  const queries = [...new Set(supplied.map((query) => String(query).trim()).filter(Boolean))];
                  if (queries.length < 2)
                    throw new Error("Choose at least two distinct Amazon search queries.");
                  const searches = await Promise.all(queries.map(async (query, workerIndex) => {
                    const existing = generalContext!.pages().find((candidate) => {
                      try {
                        const url = new URL(candidate.url());
                        return /(^|\.)amazon\.com$/i.test(url.hostname) && url.pathname === "/s" && url.searchParams.get("k") === query;
                      } catch {
                        return false;
                      }
                    });
                    const tab = existing || await generalContext!.newPage();
                    registerTabs(tab);
                    disclosedTabs.add(tab);
                    tab.setDefaultTimeout(5000);
                    tabWork.set(tab, existing ? "reading" : "loading");
                    try {
                      await showWorkerProgress(tab, `${existing ? "Reusing" : "Opening"} Amazon search ${workerIndex + 1}: ${query}`, call.id);
                      if (!existing)
                        await navigateWhenUsable(tab, amazonSearchURL(query), 15_000);
                      await tab.locator("body").waitFor({ state: "attached", timeout: 4000 });
                      tabWork.set(tab, "reading");
                      const products = await amazonProductLinks(tab);
                      tabWork.set(tab, "ready");
                      await showWorkerProgress(tab, `Amazon search ${workerIndex + 1}: found candidates`, call.id);
                      return { query, products, reused: Boolean(existing) };
                    } catch (error) {
                      tabWork.set(tab, "error");
                      return {
                        query,
                        products: [] as { href: string; title: string }[],
                        error: error instanceof Error ? friendlyBrowserError(error.message) : "Search failed.",
                      };
                    }
                  }));
                  const unique = new Map<string, { asin: string; url: string; title: string; query: string }>();
                  for (let productIndex = 0; productIndex < 30 && unique.size < 30; productIndex++) {
                    for (const search of searches) {
                      const product = search.products[productIndex];
                      if (!product) continue;
                      const match = product.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
                      if (!match) continue;
                      const asin = match[1].toUpperCase();
                      if (!unique.has(asin))
                        unique.set(asin, {
                          asin,
                          url: `https://www.amazon.com/dp/${asin}`,
                          title: product.title || "Amazon product",
                          query: search.query,
                        });
                      if (unique.size === 30) break;
                    }
                  }
                  const products = [...unique.values()].slice(0, 30);
                  const inspected = products.length >= 5
                    ? await inspectAmazonURLs(products.slice(0, 6).map((product) => product.url), call.id)
                    : [];
                  const eligible = inspected.filter((candidate) => candidate.status === "eligible");
                  const fastCart = eligible.length >= 5
                    ? await addAmazonURLs(eligible.slice(0, 5).map((candidate) => candidate.url), call.id)
                    : undefined;
                  value = {
                    products: inspected.length ? products.slice(0, 10) : products,
                    uniqueCount: products.length,
                    candidates: inspected,
                    eligibleCount: eligible.length,
                    searches: searches.map(({ query, products, ...rest }) => ({ query, candidateCount: products.length, ...rest })),
                    ...(fastCart ? { fastCart } : {}),
                    next: fastCart?.addedCount === 5
                      ? "Five eligible distinct products were already added concurrently. Verify them from fastCart.cart, clean up any stale extras, and proceed directly to authorized checkout; do not call add_amazon_products."
                      : eligible.length >= 5
                        ? "Automatic parallel cart construction was incomplete. Re-read the live cart, then add only the missing eligible products; do not duplicate successful additions."
                      : products.length >= 5
                        ? "Fewer than five inspected candidates qualified. Immediately run another discovery wave with different category queries and accumulate the eligible results."
                      : "Immediately run another discovery wave with broader, different merchandise-category queries. Do not finish or ask the user for permission.",
                  };
                  await capture(`Discovered ${products.length} unique Amazon products`, call.id);
                } else if (call.name === "open_amazon_product_tabs") {
                  const supplied = args.urls;
                  if (!Array.isArray(supplied) || supplied.length < 5 || supplied.length > 10)
                    throw new Error("Choose 5–10 Amazon product URLs.");
                  const urls = [...new Set(supplied.map((raw) => {
                    const url = new URL(safePublicURL(String(raw)));
                    if (
                      !/(^|\.)amazon\.com$/i.test(url.hostname) ||
                      !/(?:\/dp\/|\/gp\/product\/)/i.test(url.pathname)
                    )
                      throw new Error("Only canonical Amazon product URLs can be inspected.");
                    url.hash = "";
                    return url.href;
                  }))];
                  if (urls.length < 5)
                    throw new Error("Choose at least five unique Amazon products.");
                  const inspected = await inspectAmazonURLs(urls, call.id);
                  value = {
                    candidates: inspected,
                    eligibleCount: inspected.filter((candidate) => candidate.status === "eligible").length,
                    next: "Choose exactly five eligible distinct products and call add_amazon_products once with their URLs.",
                  };
                  send("action", {
                    label: `Processed ${urls.length} Amazon products in parallel`,
                    actions: ++actions,
                    status: "done",
                  });
                } else if (call.name === "add_amazon_products") {
                  const supplied = args.urls;
                  if (!Array.isArray(supplied) || supplied.length !== 5)
                    throw new Error("Choose exactly five eligible Amazon product URLs.");
                  const urls = [...new Set(supplied.map((raw) => {
                    const url = new URL(safePublicURL(String(raw)));
                    if (!/(^|\.)amazon\.com$/i.test(url.hostname) || !/(?:\/dp\/|\/gp\/product\/)/i.test(url.pathname))
                      throw new Error("Only canonical Amazon product URLs can be added.");
                    return url.href;
                  }))];
                  if (urls.length !== 5) throw new Error("Choose five unique Amazon products.");
                  const cartResult = await addAmazonURLs(urls, call.id);
                  value = {
                    ...cartResult,
                    next: configuration().amazonPurchaseAuthorized
                      ? "Verify all five products and price constraints, then proceed through checkout with the matching saved destination/payment, place the order from final review, verify confirmation, and call finish."
                      : "Verify all five selected products in this live cart observation, then call finish with links, prices, subtotal, and any limitation.",
                  };
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
                        await navigateWhenUsable(tab, url);
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
                  const target = new URL(url);
                  const demo = configuration().demo;
                  if (
                    (demo === "amazon" && !/(^|\.)amazon\.com$/i.test(target.hostname)) ||
                    (demo === "marketplace" && !/(^|\.)facebook\.com$/i.test(target.hostname))
                  )
                    throw new Error(`This run is restricted to ${demo === "amazon" ? "Amazon.com" : "Facebook Marketplace"}.`);
                  await navigateWhenUsable(page!, url);
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
                  try {
                    await page!.goBack({
                      waitUntil: "domcontentloaded",
                      timeout: 12000,
                    });
                  } catch (error) {
                    if (!isPlaywrightTimeout(error) || !(await page!.locator("body").count().catch(() => 0)))
                      throw error;
                    await page!.evaluate(() => window.stop()).catch(() => {});
                  }
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
                } else if (call.name === "wait_for_order_confirmation") {
                  if (configuration().demo !== "amazon" || !configuration().amazonPurchaseAuthorized)
                    throw new Error("Order confirmation waiting is available only in an authorized Amazon session.");
                  if (!orderSubmissionPending)
                    throw new Error("No submitted Amazon order is awaiting confirmation.");
                  const deadline = Date.now() + 45_000;
                  let state = classifyAmazonOrderState(
                    page!.url(),
                    await page!.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
                  );
                  while (state === "pending" && Date.now() < deadline) {
                    await page!.waitForTimeout(2000);
                    state = classifyAmazonOrderState(
                      page!.url(),
                      await page!.locator("body").innerText({ timeout: 5000 }).catch(() => ""),
                    );
                    await capture("Waiting for payment authorization", call.id);
                  }
                  if (state !== "pending") orderSubmissionPending = false;
                  value = {
                    status: state,
                    page: await read(),
                    next:
                      state === "pending"
                        ? "Payment authorization is still pending. Call wait_for_order_confirmation again; do not call finish."
                        : state === "confirmed"
                          ? "Order confirmation is visible. Call finish with the confirmed status and non-sensitive confirmation identifier."
                          : state === "manual_action"
                            ? "Manual authentication or approval is required. Call finish and identify the blocker without exposing private information."
                            : "Payment or order submission definitively failed. Call finish with the failure state; do not retry the purchase automatically.",
                  };
                  await capture(`Amazon order ${state.replace("_", " ")}`, call.id);
                } else if (call.name === "finish") {
                  if (orderSubmissionPending) {
                    value = {
                      error: "The submitted order is still awaiting bank/payment authorization. Call wait_for_order_confirmation instead of finishing.",
                    };
                  } else {
                    summary = String(args.summary || "Done.");
                    value = "Task complete.";
                  }
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
                    const config = configuration();
                    const authorizedAmazonPurchase =
                      authorizedAmazonPurchaseAction(
                        label,
                        config.demo,
                        config.amazonPurchaseAuthorized,
                        page!.url(),
                      );
                    if (consequentialLabel.test(label) && !authorizedAmazonPurchase)
                      throw new Error(
                        `User approval required for “${label.trim().slice(0, 80)}”. Stop and show what is ready.`,
                      );
                    if (
                      authorizedAmazonPurchase &&
                      /\b(?:place (?:your )?order|confirm order|submit order)\b/i.test(label)
                    )
                      orderSubmissionPending = true;
                    await locator.click({ timeout: 7000, noWaitAfter: true });
                    await page!.waitForTimeout(250);
                  } else if (call.name === "select") {
                    await locator.selectOption(String(args.value));
                  } else if (call.name === "fill") {
                    const type = await locator.getAttribute("type");
                    const descriptor = [
                      label,
                      type,
                      await locator.getAttribute("name"),
                      await locator.getAttribute("placeholder"),
                      await locator.getAttribute("autocomplete"),
                    ].join(" ");
                    if (/password|passcode|otp|one.?time|address|street|city|zip|postal|phone|email|card|payment|cvv|cvc/i.test(descriptor))
                      throw new Error("Credentials, address, and payment fields require the user.");
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
    await backgroundCoordinator;
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
        ? orderSubmissionPending
          ? "The order was submitted, but confirmation is still pending. Check the visible Amazon page before retrying; do not submit a duplicate order."
          : "Stopped before order submission."
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
  if (/page\.(?:goto|goBack):.*Timeout|Navigation timeout/i.test(message))
    return process.env.BROWSER_HEADLESS === "false"
      ? "The site did not return a usable page after two attempts. Inspect the open browser for a CAPTCHA or error page, then retry."
      : "The site did not return a usable page after two attempts. Reset the embedded browser and retry; a CAPTCHA or Amazon error page may be blocking it.";
  if (/page\.screenshot:.*Timeout/i.test(message))
    return "The live browser preview could not refresh, but the page may still be usable. Retry the action without resetting the cart.";
  if (/locator\.(?:click|fill|press|selectOption):.*Timeout|waiting for locator/i.test(message))
    return "The requested Amazon control did not become actionable. The agent should reread the current page and retry the control once.";
  return message
    .split("Call log:")[0]
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim()
    .slice(0, 350);
}

export async function generalPreview() {
  const page = viewedPage && !viewedPage.isClosed() ? viewedPage : await warmGeneral();
  const image = await screenshotWhenStable(page, 65);
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
  disclosedTabs.clear();
  amazonWarming = undefined;
  viewedPage = undefined;generalPage = page;
  await page.route("**/*", routeGeneralResource);
  const demo = configuration().demo;
  const startURL = demo === "amazon" ? "https://www.amazon.com/" : "https://www.facebook.com/marketplace/";
  if(!page.url().startsWith(startURL)) await navigateWhenUsable(page,startURL);
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
    await page.waitForLoadState("domcontentloaded", {timeout: 12000}).catch((error) => {
      if (!isPlaywrightTimeout(error)) throw error;
    });
    return await generalPreview();
  } finally { busy = false; }
}
