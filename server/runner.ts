import { adoptGeneralPage } from "./agent";
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
import {
  configuration,
  enforceExplicitConstraints,
  localPlan,
  mentionedKeys,
  streamCerebrasPlan,
} from "./planner";

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
    if (this.metrics.firstAction === null) this.metrics.firstAction = at;
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
      model: this.config.mode === "cerebras" ? this.config.model : null,
    });
    this.stage("plan", "running", "Making your shopping list");
    this.stage("search", "running", "Opening three stores in parallel");
    this.deadline = setTimeout(
      () => this.cancel("The run exceeded the 45-second limit. Please retry."),
      45_000,
    );
    try {
      this.initialized = this.timed(
        "Acquire warm browser session",
        "navigation",
        async () => {
          this.lease = this.adoptedLease ?? (await acquireBrowser());
          if (this.abort.signal.aborted) {
            await this.lease.context.close();
            this.check();
          }
          this.metrics.pages = 3;
          this.metrics.warmup = this.lease.warmup;
          if (process.env.BROWSER_HEADLESS !== "true")
            await showNativePage(this.lease.pages.goodmarket);
          for (const store of stores) this.searched.set(store.id, new Map());
          await Promise.all(
            stores.map((store) =>
              this.action(
                store.id,
                `Open ${store.shortName}`,
                "dom",
                async () => {
                  await this.lease!.pages[store.id].getByRole("textbox", {
                    name: "Search groceries",
                  }).focus();
                },
                "#search",
              ),
            ),
          );
        },
      );
      // Install a handler immediately; item chains await the same initialization promise.
      this.initialized.catch(() => {});
      if (this.config.mode === "local") {
        const plan = await this.timed(
          "Local recipe & grocery planner",
          "planning",
          async () => localPlan(this.prompt),
        );
        this.plan.meta = plan.meta;
        this.emit("plan", { meta: plan.meta });
        for (const item of plan.items) this.enqueueItem(item);
      } else {
        // Read-only speculative searches start immediately from deterministic grocery/recipe hints.
        // Model output still defines the final list. Each requested key reuses its search promise.
        let prefetchKeys = mentionedKeys(this.prompt);
        try {
          prefetchKeys = localPlan(this.prompt).items.map((item) => item.key);
        } catch {
          /* Unknown requests wait for the model. */
        }
        for (const key of prefetchKeys.slice(0, 12))
          for (const store of stores)
            this.scheduleSearch(store.id, key).catch(() => {});
        this.metrics.modelCalls = 1;
        this.metrics.inferenceStart = this.now();
        this.metrics.inference = {
          ttft: null,
          firstExecutableAction: null,
          generationStream: null,
          requestTotal: null,
          reasoningEnabled: false,
          reasoningTokens: null,
          providerQueue: null,
          providerPrompt: null,
          providerGeneration: null,
          providerTotal: null,
          transportAndClient: null,
        };
        let lastContent = 0;
        await this.timed("Cerebras streaming plan", "model", async () =>
          streamCerebrasPlan(
            this.prompt,
            {
              onLine: (line) => {
                if (line.type === "plan") {
                  this.plan.meta = enforceExplicitConstraints(
                    line,
                    this.prompt,
                  );
                  this.emit("plan", { meta: this.plan.meta });
                } else {
                  if (this.metrics.inference!.firstExecutableAction === null)
                    this.metrics.inference!.firstExecutableAction =
                      this.now() - this.metrics.inferenceStart!;
                  this.enqueueItem(line);
                }
              },
              onFirstToken: () => {
                this.metrics.firstToken = this.now();
                this.metrics.inference!.ttft =
                  this.metrics.firstToken - this.metrics.inferenceStart!;
                this.emit("first-token", { at: this.metrics.firstToken });
              },
              onHeaders: () => {
                this.metrics.networkHeaders =
                  this.now() - this.metrics.inferenceStart!;
                this.emit("network", { headers: this.metrics.networkHeaders });
              },
              onContent: () => {
                lastContent = this.now();
              },
              onUsage: (tokens, reasoningTokens) => {
                this.metrics.tokens = tokens;
                this.metrics.inference!.reasoningTokens = reasoningTokens;
              },
              onProviderTiming: (timing) => {
                const info = this.metrics.inference!;
                info.providerQueue =
                  timing.queue_time == null ? null : timing.queue_time * 1000;
                info.providerPrompt =
                  timing.prompt_time == null ? null : timing.prompt_time * 1000;
                info.providerGeneration =
                  timing.completion_time == null
                    ? null
                    : timing.completion_time * 1000;
                info.providerTotal =
                  timing.total_time == null ? null : timing.total_time * 1000;
              },
            },
            this.abort.signal,
          ),
        );
        this.metrics.inference.requestTotal =
          this.now() - this.metrics.inferenceStart!;
        this.metrics.inference.generationStream =
          this.metrics.firstToken === null
            ? null
            : lastContent - this.metrics.firstToken;
        if (this.metrics.inference.providerTotal !== null)
          this.metrics.inference.transportAndClient = Math.max(
            0,
            this.metrics.inference.requestTotal -
              this.metrics.inference.providerTotal,
          );
        if (this.metrics.tokens !== null && this.metrics.firstToken !== null)
          this.metrics.tokensPerSecond = Math.round(
            this.metrics.tokens /
              Math.max(0.001, (this.now() - this.metrics.firstToken) / 1000),
          );
      }
      this.stage(
        "plan",
        "done",
        `${this.plan.items.length} things on your list`,
      );
      await this.initialized;
      await Promise.all(this.chains.values());
      await Promise.all(this.itemJobs);
      this.check();
      if (this.taskErrors.length) throw this.taskErrors[0];
      if (!this.plan.items.length)
        throw new Error(
          this.plan.meta.notes.join(" ") ||
            "No groceries were found in this request.",
        );
      this.stage("search", "done", "Searched all three stores");
      this.stage(
        "validate",
        "running",
        "Checking ingredients & dietary labels",
      );
      const quotes = await this.timed(
        "Validate labels & compare complete baskets",
        "validation",
        async () => {
          return Promise.all(
            stores.map(async (store) => {
              const items: CartItem[] = [],
                missing: string[] = [];
              for (const item of this.plan.items) {
                const options =
                  this.searched.get(store.id)!.get(item.key) ?? [];
                const product = options
                  .filter(
                    (p) =>
                      p.key === item.key && eligible(p, this.plan.meta.diets),
                  )
                  .sort((a, b) => a.price - b.price)[0];
                if (product)
                  items.push({
                    product,
                    quantity: item.quantity,
                    reason: item.reason,
                    checked: true,
                  });
                else missing.push(catalogLabels[item.key]);
              }
              const slots = await this.action(
                store.id,
                "Read available delivery windows",
                "dom",
                () =>
                  this.lease!.pages[store.id].locator(
                    "[data-slot]",
                  ).evaluateAll((els) =>
                    els.map(
                      (el) => JSON.parse(el.getAttribute("data-json")!) as Slot,
                    ),
                  ),
                undefined,
                false,
              );
              const slot = chooseSlot(slots, this.plan.meta.delivery);
              if (!slot) missing.push("Requested delivery window");
              const subtotal = items.reduce(
                (sum, item) => sum + item.product.price * item.quantity,
                0,
              );
              const delivery =
                Math.round(store.deliveryFee * 100) + (slot?.fee ?? 0);
              return {
                store: store.id,
                subtotal,
                delivery,
                total: subtotal + delivery,
                complete: !missing.length,
                missing,
                items,
                slot,
              } satisfies Quote;
            }),
          );
        },
      );
      const winner = compareQuotes(quotes);
      this.emit("quotes", { quotes, winner: winner?.store ?? null });
      this.stage(
        "validate",
        "done",
        this.plan.meta.diets.length
          ? "Dietary labels checked on every item"
          : "Stock & ingredient labels checked",
      );
      this.stage(
        "compare",
        "done",
        winner
          ? `${getStore(winner.store).shortName} has the best complete basket`
          : "No store can complete this basket",
      );
      const warnings = this.plan.meta.notes.filter((n) =>
        n.startsWith("UNSUPPORTED:"),
      );
      if (!winner)
        warnings.push(
          "No store can fulfill every item and the requested delivery window. Try adjusting your list.",
        );
      if (
        winner &&
        this.plan.meta.budget !== null &&
        winner.total > Math.round(this.plan.meta.budget * 100)
      )
        warnings.push(
          `The lowest complete basket is over your $${this.plan.meta.budget} budget. Try a smaller list or a higher budget.`,
        );
      if (winner) {
        this.stage(
          "cart",
          "running",
          `Filling your ${getStore(winner.store).shortName} basket`,
        );
        await this.buildCart(winner);
        this.stage(
          "cart",
          "done",
          `${winner.items.reduce((n, i) => n + i.quantity, 0)} packages in your basket`,
        );
        this.stage("delivery", "done", winner.slot!.label);
        await adoptGeneralPage(this.lease!.pages[winner.store]);
      }
      this.metrics.total = this.now();
      this.status = warnings.length ? "blocked" : "approval";
      this.result = {
        id: this.id,
        status: this.status,
        mode: this.config.mode,
        model: this.config.mode === "cerebras" ? this.config.model : null,
        plan: this.plan,
        quotes,
        winner,
        metrics: structuredClone(this.metrics),
        warnings,
      };
      this.emit("result", { result: this.result });
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
        model: this.config.mode === "cerebras" ? this.config.model : null,
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
      void warmBrowser().catch((error) =>
        console.error("Browser warmup failed:", error.message),
      );
    }
    return this.result!;
  }
  private async buildCart(quote: Quote) {
    const store = quote.store,
      page = this.lease!.pages[store];
    if (process.env.BROWSER_HEADLESS !== "true") await showNativePage(page);
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
