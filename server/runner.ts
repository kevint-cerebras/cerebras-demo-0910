import { adoptGeneralPage, executeGeneral } from "./agent";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Page } from "playwright";
import { catalogLabels, getStore, stores } from "../shared/catalog";
import type {
  CartItem,
  Metrics,
  Plan,
  PlanItem,
  Product,
  Quote,
  RunEvent,
  RunResult,
  Slot,
  StoreId,
  TimingSpan,
} from "../shared/types";
import {
  acquireBrowser,
  snapshot,
  warmBrowser,
  showNativePage,
  type BrowserLease,
} from "./browser";
import { configuration } from "./planner";

export type Emit = (event: RunEvent) => void;
export const runs = new Map<string, ShoppingRun>();
const blankMetrics = (): Metrics => ({
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
export function eligible(product: Product, diets: Plan["meta"]["diets"]) {
  return (
    product.stock &&
    diets.every((diet) => product.diets.includes(diet)) &&
    (!diets.includes("nut-free") ||
      ![...product.allergens, ...product.mayContain].some((a) =>
        /peanut|tree nut|almond|cashew|walnut|pecan|hazelnut/i.test(a),
      )) &&
    ((!diets.includes("dairy-free") && !diets.includes("vegan")) ||
      ![...product.allergens, ...product.mayContain].includes("milk")) &&
    (!diets.includes("gluten-free") ||
      ![...product.allergens, ...product.mayContain].some((a) =>
        /wheat|barley|rye/i.test(a),
      ))
  );
}
export function chooseSlot(
  slots: Slot[],
  preference: Plan["meta"]["delivery"],
) {
  return (
    slots.find(
      (s) =>
        s.available &&
        (preference === "earliest" || s.preference === preference),
    ) ?? null
  );
}
export function compareQuotes(quotes: Quote[]) {
  return (
    quotes
      .filter((q) => q.complete)
      .sort((a, b) => a.total - b.total || a.store.localeCompare(b.store))[0] ??
    null
  );
}

export class ShoppingRun {
  readonly id = randomUUID();
  readonly created = Date.now();
  readonly abort = new AbortController();
  readonly events: RunEvent[] = [];
  readonly metrics = blankMetrics();
  readonly config = configuration();
  result?: RunResult;
  lease?: BrowserLease;
  status: "running" | RunResult["status"] | "approving" = "running";
  private seq = 0;
  private actionSeq = 0;
  private start = performance.now();
  private lastAction: number | null = null;
  private emitter: Emit;
  private searched = new Map<StoreId, Map<string, Product[]>>();
  private chains = new Map<StoreId, Promise<void>>();
  private initialized: Promise<void> = Promise.resolve();
  private taskErrors: Error[] = [];
  private seenItems = new Set<string>();
  private searchJobs = new Map<string, Promise<Product[]>>();
  private itemJobs: Promise<void>[] = [];
  private deadline?: ReturnType<typeof setTimeout>;
  private handoff = false;
  plan: Plan = {
    meta: {
      type: "plan",
      title: "Your everyday essentials",
      people: 2,
      budget: null,
      diets: [],
      delivery: "earliest",
      notes: [],
    },
    items: [],
  };
  constructor(
    readonly prompt: string,
    emit: Emit,
    private adoptedLease?: BrowserLease,
    readonly conversation: {role: string; content: string}[] = [],
  ) {
    this.emitter = emit;
  }
  now() {
    return Math.round((performance.now() - this.start) * 100) / 100;
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    const event: RunEvent = { seq: ++this.seq, type, at: this.now(), ...data };
    this.events.push(event);
    this.emitter(event);
  }
  check() {
    this.abort.signal.throwIfAborted();
  }
  async timed<T>(
    name: string,
    category: TimingSpan["category"],
    fn: () => Promise<T>,
    store?: StoreId,
  ): Promise<T> {
    this.check();
    const start = this.now();
    try {
      return await fn();
    } finally {
      const span = {
        name,
        category,
        start,
        duration: Math.round((this.now() - start) * 100) / 100,
        ...(store ? { store } : {}),
      };
      this.metrics.spans.push(span);
      this.emit("timing", { span });
    }
  }
  async action<T>(
    store: StoreId,
    label: string,
    category: TimingSpan["category"],
    fn: () => Promise<T>,
    selector?: string,
    show = true,
  ): Promise<T> {
    this.check();
    const at = this.now();
    if (this.metrics.firstAction === null) {
      this.metrics.firstAction = at;
      this.metrics.firstActionAfterToken =
        this.metrics.firstToken === null ? null : at - this.metrics.firstToken;
    }
    if (
      this.metrics.firstToken !== null &&
      this.metrics.firstActionAfterToken === null
    )
      this.metrics.firstActionAfterToken = at - this.metrics.firstToken;
    if (this.lastAction !== null)
      this.metrics.maxActionGap = Math.max(
        this.metrics.maxActionGap,
        at - this.lastAction,
      );
    this.lastAction = at;
    const actionId = `${this.id}:action:${++this.actionSeq}`;
    this.emit("action", { actionId, store, label, status: "running" });
    let result: T;
    try {
      result = await this.timed(label, category, fn, store);
    } catch (error) {
      this.emit("action", {
        actionId,
        store,
        label,
        status: "error",
        error:
          error instanceof Error
            ? error.message.split("Call log:")[0].trim()
            : "Action failed",
      });
      throw error;
    }
    this.metrics.actions++;
    this.emit("action", {
      actionId,
      store,
      label,
      status: "done",
      actions: this.metrics.actions,
    });
    if (show) {
      const shot = await snapshot(
        this.lease!.pages[store],
        store,
        label,
        this.now(),
        selector,
      );
      this.emit("snapshot", { actionId, snapshot: shot });
    }
    return result;
  }
  private stage(stage: string, status: "running" | "done", label: string) {
    this.emit("stage", { stage, status, label });
  }
  private scheduleSearch(store: StoreId, key: string): Promise<Product[]> {
    const cacheKey = `${store}:${key}`;
    const existing = this.searchJobs.get(cacheKey);
    if (existing) return existing;
    const prior = this.chains.get(store) ?? this.initialized;
    const job = prior.then(async () => {
      this.check();
      const page = this.lease!.pages[store];
      const cached = this.lease!.searchCache?.get(store)?.get(key);
      if (cached) {
        this.metrics.cacheHits = (this.metrics.cacheHits ?? 0) + 1;
        this.emit("cache-hit", {
          store,
          key,
          source: "voice preview DOM extraction",
        });
        return cached;
      }
      await this.action(
        store,
        `Search ${catalogLabels[key]}`,
        "browser",
        () => page.getByRole("textbox", { name: "Search groceries" }).fill(key),
        "#search",
        false,
      );
      await this.action(
        store,
        `Find ${catalogLabels[key]}`,
        "browser",
        async () => {
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
          await page
            .locator(`#products[data-query="${key}"][data-ready="true"]`)
            .waitFor({ state: "attached" });
        },
        "#search-submit",
      );
      return this.action(
        store,
        `Read prices & labels for ${catalogLabels[key]}`,
        "dom",
        () =>
          page.locator("[data-product]").evaluateAll((els) =>
            els.map((el) => {
              const { artwork: _, ...product } = JSON.parse(
                el.getAttribute("data-json")!,
              );
              return product as Product;
            }),
          ),
        undefined,
        false,
      );
    });
    this.searchJobs.set(cacheKey, job);
    this.chains.set(
      store,
      job.then(
        () => {},
        () => {},
      ),
    );
    return job;
  }
  private enqueueItem(item: PlanItem) {
    if (this.seenItems.has(item.key))
      throw new Error(
        `The plan repeated ${catalogLabels[item.key]}. Please retry.`,
      );
    this.seenItems.add(item.key);
    this.plan.items.push(item);
    this.emit("item", { item });
    for (const store of stores) {
      const job = this.scheduleSearch(store.id, item.key)
        .then((products) => {
          this.searched.get(store.id)!.set(item.key, products);
          const valid = products
            .filter(
              (p) => p.key === item.key && eligible(p, this.plan.meta.diets),
            )
            .sort((a, b) => a.price - b.price);
          this.emit("found", {
            store: store.id,
            item,
            product: valid[0] ?? null,
            rejected:
              products.filter((p) => p.key === item.key).length - valid.length,
          });
        })
        .catch((error) => {
          if (!this.taskErrors.length)
            this.taskErrors.push(
              error instanceof Error ? error : new Error(String(error)),
            );
        });
      this.itemJobs.push(job);
    }
  }
  async execute() {
    this.emit("start", {
      id: this.id,
      mode: this.config.mode,
      model: this.config.mode === "local" ? null : this.config.model,
    });
    this.stage("task", "running", "Starting your request");
    this.deadline = setTimeout(
      () => this.cancel("The browser task exceeded its time limit. Verified partial results were preserved."),
      Number(process.env.TASK_TIMEOUT_MS || 180_000),
    );
    try {
      this.emit("browser-mode");
      {

        this.metrics.pages = 0;
        let summary = "";
        let approvedCart: Quote | null = null;
        const browserStarted = this.now();
        await executeGeneral(
          this.prompt,
          (event) => {
            if (event.type === "store-activity") {
              this.emit("store-activity", {activity: event.activity});
            } else if (event.type === "page") {
              const { type: _type, id: _id, at: _at, ...payload } = event;
              this.metrics.pages = Number(event.pages || this.metrics.pages);
              this.emit("browser-page", payload);
            } else if (event.type === "inference-start") {
              this.metrics.modelCalls = Number(event.call);
              if (this.metrics.inferenceStart === null) this.metrics.inferenceStart = this.now();
              this.emit("browser-metrics", {
                metrics: structuredClone(this.metrics),
              });
            } else if (event.type === "inference") {
              const timing = event.timing as NonNullable<Metrics["browserInferenceCalls"]>[number];
              if (this.metrics.firstToken === null && timing.ttft !== null)
                this.metrics.firstToken = this.now() - timing.total + timing.ttft;
              this.metrics.browserInferenceCalls = [
                ...(this.metrics.browserInferenceCalls || []),
                event.timing as NonNullable<
                  Metrics["browserInferenceCalls"]
                >[number],
              ];
              this.emit("browser-metrics", {
                metrics: structuredClone(this.metrics),
              });
            } else if (event.type === "action") {
              const at = this.now();
              if (this.metrics.firstAction === null) {
                this.metrics.firstAction = at;
                this.metrics.firstActionAfterToken =
                  this.metrics.firstToken === null
                    ? null
                    : at - this.metrics.firstToken;
              }
              if (this.lastAction !== null)
                this.metrics.maxActionGap = Math.max(
                  this.metrics.maxActionGap,
                  at - this.lastAction,
                );
              this.lastAction = at;
              this.metrics.actions = Number(event.actions);
              this.emit("browser-action", {
                label: event.label,
                status: event.status,
                error: event.error,
              });
              this.emit("browser-metrics", {
                metrics: structuredClone(this.metrics),
              });
            } else if (event.type === "error") {
              throw new Error(String(event.message));
            } else if (event.type === "done") {
              const metrics = event.metrics as {
                pages: number;
                modelCalls: number;
                inferenceCalls: NonNullable<Metrics["browserInferenceCalls"]>;
                spans: {
                  name: string;
                  category: string;
                  start: number;
                  duration: number;
                }[];
              };
              this.metrics.pages = metrics.pages;
              this.metrics.modelCalls = metrics.modelCalls;
              this.metrics.browserInferenceCalls = metrics.inferenceCalls;
              for (const span of metrics.spans)
                this.metrics.spans.push({
                  ...span,
                  start: browserStarted + span.start,
                  category:
                    span.category === "navigation"
                      ? "navigation"
                      : span.category === "dom"
                        ? "dom"
                        : span.category === "model"
                          ? "model"
                          : "browser",
                });
              summary = String(event.summary);
            }
          },
          this.abort.signal,
          ({lease, quote}) => { this.lease = lease; approvedCart = quote; },
          this.conversation,
        );
        this.check();
        this.status = approvedCart ? "approval" : "done";
        this.metrics.total = this.now();
        this.result = {
          id: this.id,
          status: this.status,
          mode: this.config.mode,
          model: this.config.model,
          plan: this.plan,
          quotes: approvedCart ? [approvedCart] : [],
          winner: approvedCart,
          warnings: [],
          summary,
          metrics: structuredClone(this.metrics),
        };
        this.emit("result", { result: this.result });
        return this.result;
      }
    } catch (error) {
      const cancelled = this.abort.signal.aborted;
      this.status = cancelled ? "cancelled" : "error";
      const message = cancelled
        ? String(this.abort.signal.reason || "Stopped. Nothing was ordered.")
        : error instanceof Error
          ? error.message
          : "The run failed. Please retry.";
      this.metrics.total = this.now();
      this.result = {
        id: this.id,
        status: this.status,
        mode: this.config.mode,
        model: this.config.mode === "local" ? null : this.config.model,
        plan: this.plan,
        quotes: [],
        winner: null,
        metrics: this.metrics,
        warnings: [message],
      };
      this.emit("result", { result: this.result });
      this.abort.abort(message);
      if (!this.handoff) await this.lease?.context.close().catch(() => {});
      await Promise.allSettled([
        this.initialized,
        ...this.chains.values(),
        ...this.itemJobs,
      ]);
    } finally {
      clearTimeout(this.deadline);
    }
    return this.result!;
  }
  private async buildCart(quote: Quote) {
    const store = quote.store,
      page = this.lease!.pages[store];
    if (process.env.BROWSER_HEADLESS === "false") await showNativePage(page);
    for (const item of quote.items) {
      await this.action(
        store,
        `Find ${item.product.name} for your basket`,
        "browser",
        async () => {
          // Search is a deterministic two-action batch; no model round trip.
          await page
            .getByRole("textbox", { name: "Search groceries" })
            .fill(item.product.key);
          await page
            .getByRole("button", { name: "Search", exact: true })
            .click();
        },
        "#search-submit",
        false,
      );
      // The batch contains two browser interactions; action() counts one, account for the second.
      this.metrics.actions++;
      for (let count = 0; count < item.quantity; count++) {
        await this.action(
          store,
          `Add ${item.product.name}${item.quantity > 1 ? ` · ${count + 1}/${item.quantity}` : ""}`,
          "browser",
          () => page.locator(`[data-add="${item.product.id}"]`).click(),
          `[data-add="${item.product.id}"]`,
        );
      }
      this.emit("cart-item", { item });
    }
    await this.action(
      store,
      "Open your completed basket",
      "browser",
      () => page.getByRole("button", { name: "Open cart" }).click(),
      "#open-cart",
    );
    await this.action(
      store,
      `Select ${quote.slot!.label}`,
      "browser",
      () =>
        page
          .locator(`input[name="delivery"][value="${quote.slot!.id}"]`)
          .check(),
      `[data-slot="${quote.slot!.id}"]`,
    );
    await this.verifyCart(quote);
  }
  private async verifyCart(quote: Quote) {
    const observed = await this.action(
      quote.store,
      "Verify cart quantities, total & delivery",
      "dom",
      () =>
        this.lease!.pages[quote.store].evaluate(() => ({
          total: Number(document.getElementById("total")!.dataset.cents),
          slot: (
            document.querySelector(
              'input[name="delivery"]:checked',
            ) as HTMLInputElement | null
          )?.value,
          items: Array.from(
            document.querySelectorAll<HTMLElement>("[data-cart-product]"),
          ).map((el) => ({
            id: el.dataset.cartProduct,
            quantity: Number(el.dataset.quantity),
          })),
        })),
      undefined,
      false,
    );
    if (
      observed.total !== quote.total ||
      observed.slot !== quote.slot?.id ||
      observed.items.length !== quote.items.length ||
      quote.items.some(
        (item) =>
          !observed.items.some(
            (row) =>
              row.id === item.product.id && row.quantity === item.quantity,
          ),
      )
    )
      throw new Error(
        "The browser cart changed during verification. Nothing was ordered. Please retry.",
      );
  }
  cancel(reason = "Stopped. Nothing was ordered.", handoff = false) {
    this.handoff = handoff;
    if (!["running", "approval", "blocked"].includes(this.status)) return;
    this.abort.abort(reason);
    this.status = "cancelled";
    if (this.result) this.result.status = "cancelled";
    if (!handoff) void this.lease?.context.close().catch(() => {});
  }
  async approve(expectedTotal: number) {
    if (this.status === "ordered") return this.result!;
    if (this.status !== "approval" || !this.result?.winner)
      throw new Error("This cart is not available for approval.");
    const quote = this.result.winner;
    if (expectedTotal !== quote.total)
      throw new Error(
        "The total does not match the reviewed cart. Refresh and review it again.",
      );
    this.status = "approving";
    try {
      await this.verifyCart(quote);
      await this.action(
        quote.store,
        "Place user-approved sandbox order",
        "browser",
        () =>
          this.lease!.pages[quote.store].getByRole("button", {
            name: "Place sandbox order",
            exact: true,
          }).click(),
        "#receipt",
      );
      const receiptId =
        await this.lease!.pages[quote.store].locator(
          "[data-receipt]",
        ).getAttribute("data-receipt");
      if (!receiptId)
        throw new Error("The store did not return an order receipt.");
      this.status = "ordered";
      this.result.status = "ordered";
      this.result.summary = "Your sandbox order is confirmed. No payment was taken.";
      this.result.receipt = {
        id: receiptId,
        total: quote.total,
        store: quote.store,
        slot: quote.slot!.label,
      };
      return this.result;
    } catch (error) {
      this.status = "error";
      throw error;
    }
  }
  async dispose() {
    if (this.status === "running") this.cancel();
    if (!this.handoff) await this.lease?.context.close().catch(() => {});
  }
}
