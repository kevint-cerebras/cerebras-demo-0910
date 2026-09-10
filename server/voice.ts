import { previewPublicPage, warmGeneral, resetVoiceNavigation } from "./agent";
import { randomUUID } from "node:crypto";
import {
  acquireBrowser,
  snapshot,
  warmBrowser,
  type BrowserLease,
} from "./browser";
import { mentionedKeys } from "./planner";
import type { Product } from "../shared/types";
import { catalogLabels, stores } from "../shared/catalog";

interface Preview {
  lease?: BrowserLease;
  queue: Promise<unknown>;
  seen: Set<string>;
  created: number;
  actions: number;
  claimed: boolean;
}
const previews = new Map<string, Preview>();
export async function prepareVoice() {
  if (previews.size >= 3)
    throw new Error(
      "Too many voice sessions. Finish an existing session first.",
    );
  resetVoiceNavigation();
  await warmGeneral();
  const lease = await acquireBrowser();
  lease.searchCache = new Map(stores.map((s) => [s.id, new Map()]));
  const id = randomUUID();
  previews.set(id, {
    lease,
    queue: Promise.resolve(),
    seen: new Set(),
    created: Date.now(),
    actions: 0,
    claimed: false,
  });
  return { id, ready: true };
}
export async function previewVoice(id: string, transcript: string) {
  const preview = previews.get(id);
  if (!preview || preview.claimed)
    throw new Error("Voice session expired. Start listening again.");
  const key = mentionedKeys(transcript)
    .filter((key) => !preview.seen.has(key))
    .at(-1);
  if (
    !key ||
    /https?:|\b(?:wikipedia|search for|look up)\b/i.test(transcript)
  ) {
    const job = preview.queue.then(async () => {
      const general = await previewPublicPage(transcript);
      if (general) preview.actions += general.actionCount;
      return {
        searched: [...preview.seen],
        actions: preview.actions,
        snapshots: [],
        general,
      };
    });
    preview.queue = job.catch(() => {});
    return job;
  }
  preview.seen.add(key);
  const job = preview.queue.then(async () => {
    if (!preview.lease) {
      preview.lease = await acquireBrowser();
      preview.lease.searchCache = new Map(stores.map((s) => [s.id, new Map()]));
    }
    const start = performance.now();
    const snapshots = await Promise.all(
      stores.map(async (store) => {
        const page = preview.lease!.pages[store.id];
        await page.getByRole("textbox", { name: "Search groceries" }).fill(key);
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const products = await page
          .locator("[data-product]")
          .evaluateAll((els) =>
            els.map((el) => {
              const { artwork: _, ...product } = JSON.parse(
                el.getAttribute("data-json")!,
              );
              return product as Product;
            }),
          );
        preview.lease!.searchCache!.get(store.id)!.set(key, products);
        preview.actions += 3;
        return snapshot(
          page,
          store.id,
          `Looking up ${catalogLabels[key]} while you speak`,
          Math.round(performance.now() - start),
          "#search-submit",
        );
      }),
    );
    return { searched: [...preview.seen], actions: preview.actions, snapshots };
  });
  preview.queue = job.catch(() => {});
  return job;
}
export async function claimVoice(id: string) {
  const preview = previews.get(id);
  if (!preview || preview.claimed) return undefined;
  preview.claimed = true;
  await preview.queue;
  previews.delete(id);
  return preview.lease;
}
export async function discardVoice(id: string) {
  const preview = previews.get(id);
  if (!preview) return;
  preview.claimed = true;
  previews.delete(id);
  await preview.queue;
  await preview.lease?.context.close().catch(() => {});
  void warmBrowser().catch(() => {});
}
export async function cleanupVoice() {
  await Promise.all(
    [...previews]
      .filter(([, p]) => Date.now() - p.created > 120_000)
      .map(([id]) => discardVoice(id)),
  );
}
