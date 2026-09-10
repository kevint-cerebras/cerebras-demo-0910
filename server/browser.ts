import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { nativeCursorScript } from "../shared/native-cursor";
import { randomUUID } from "node:crypto";
import { stores } from "../shared/catalog";
import type {
  BrowserSnapshot,
  BrowserWarmup,
  Product,
  StoreId,
} from "../shared/types";

export interface BrowserLease {
  id: string;
  context: BrowserContext;
  pages: Record<StoreId, Page>;
  warmedAt: number;
  warmup: BrowserWarmup;
  searchCache?: Map<StoreId, Map<string, Product[]>>;
}
let browser: Browser | undefined;
let warmLease: Promise<BrowserLease> | undefined;
let baseURL = "";
let warmReady = false;
let warmGeneration = 0;
export function browserStatus() {
  return {
    connected: Boolean(browser?.isConnected()),
    warm: warmReady,
    pages: warmReady ? 3 : 0,
  };
}
async function createLease(): Promise<BrowserLease> {
  const started = performance.now();
  const timings: BrowserWarmup["pages"] = [];
  if (!browser?.isConnected())
    browser = await chromium.launch({
      headless: process.env.BROWSER_HEADLESS !== "false",
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
  const context = await browser.newContext({
    viewport: { width: 1000, height: 850 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(4000);
  await context.addInitScript({ content: nativeCursorScript });
  await context.route("**/*", (route) => {
    const request = route.request();
    // Workers only need the local sandbox HTML. All third-party resources are blocked.
    if (
      !request.url().startsWith(baseURL + "/") ||
      ["image", "media", "font"].includes(request.resourceType())
    )
      return route.abort();
    return route.continue();
  });
  const entries = await Promise.all(
    stores.map(async (store) => {
      const page = await context.newPage();
      const navigationStart = performance.now();
      await page.goto(`${baseURL}/shop/${store.id}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator('#products[data-ready="true"]')
        .waitFor({ state: "attached" });
      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming;
        return {
          ttfb: nav.responseStart - nav.requestStart,
          domReady: nav.domContentLoadedEventEnd,
        };
      });
      timings.push({
        store: store.id,
        navigation: performance.now() - navigationStart,
        ...timing,
      });
      return [store.id, page] as const;
    }),
  );
  if (process.env.BROWSER_HEADLESS === "false") {
    const session = await context.newCDPSession(entries[0][1]);
    try {
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch {
      /* Some window managers do not expose minimization. */
    } finally {
      await session.detach();
    }
  }
  return {
    id: randomUUID(),
    context,
    pages: Object.fromEntries(entries) as Record<StoreId, Page>,
    warmedAt: Date.now(),
    warmup: { total: performance.now() - started, pages: timings },
  };
}
export async function warmBrowser(url?: string) {
  if (url) baseURL = url;
  if (!warmLease) {
    warmReady = false;
    const generation = ++warmGeneration;
    warmLease = createLease()
      .then((lease) => {
        if (generation === warmGeneration) warmReady = true;
        return lease;
      })
      .catch((error) => {
        warmLease = undefined;
        warmReady = false;
        throw error;
      });
  }
  return warmLease;
}
export async function acquireBrowser(): Promise<BrowserLease> {
  const pending = warmLease || warmBrowser();
  warmLease = undefined;
  warmReady = false;
  warmGeneration++;
  return pending;
}
export async function closeBrowser() {
  await browser?.close();
  browser = undefined;
  warmLease = undefined;
  warmReady = false;
}
export async function snapshot(
  page: Page,
  store: StoreId,
  label: string,
  at: number,
  selector?: string,
): Promise<BrowserSnapshot> {
  const data = await page.evaluate((selector) => {
    const target = selector ? document.querySelector(selector) : null;
    const rect = target?.getBoundingClientRect();
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll("script, #dash-native-cursor")
      .forEach((el) => el.remove());
    if (rect)
      window.dispatchEvent(
        new CustomEvent("dash:cursor", {
          detail: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        }),
      );
    clone.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes))
        if (attr.name.startsWith("on") || attr.name === "data-json")
          el.removeAttribute(attr.name);
    });
    const sourceInputs = Array.from(document.querySelectorAll("input"));
    clone.querySelectorAll("input").forEach((input, index) => {
      input.setAttribute("value", sourceInputs[index].value);
      if (sourceInputs[index].checked) input.setAttribute("checked", "");
      else input.removeAttribute("checked");
    });
    const viewportStyle = document.createElement("style");
    viewportStyle.textContent = `html{overflow:hidden}body{transform:translateY(${-window.scrollY}px);transform-origin:top left}`;
    clone.querySelector("head")!.appendChild(viewportStyle);
    return {
      html: "<!doctype html>" + clone.outerHTML,
      cursor: rect
        ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        : null,
    };
  }, selector);
  return {
    store,
    html: data.html,
    cursor: data.cursor,
    label,
    at,
    url: page.url(),
  };
}

export async function showNativePage(page: Page) {
  if (page.isClosed())
    throw new Error("This browser tab has closed. Start a new task.");
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    /* Headless benchmark sessions have no native window. */
  } finally {
    await session.detach();
  }
  await page.bringToFront();
}
