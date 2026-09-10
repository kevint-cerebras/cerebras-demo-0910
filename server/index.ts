import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { stores } from "../shared/catalog";
import type { StoreId } from "../shared/types";
import {
  browserStatus,
  closeBrowser,
  warmBrowser,
  showNativePage,
} from "./browser";
import { configuration } from "./planner";
import {
  executeGeneral,
  warmGeneral,
  closeGeneral,
  showGeneralBrowser,
} from "./agent";
import { runs, ShoppingRun } from "./runner";
import { shopHTML } from "./shop";
import {
  claimVoice,
  cleanupVoice,
  discardVoice,
  prepareVoice,
  previewVoice,
} from "./voice";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
const port = Number(process.env.PORT || 3100);
const hostname = "127.0.0.1";
app.disable("x-powered-by");
app.use(express.json({ limit: "24kb" }));
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const origin = req.headers.origin;
  if (
    origin &&
    ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)
  )
    return res
      .status(403)
      .json({ error: "This demo accepts same-origin requests only." });
  next();
});
app.get("/api/health", (_req, res) => {
  const config = configuration();
  res.json({
    status: "ok",
    mode: config.mode,
    model: config.mode === "cerebras" ? config.model : null,
    configurationIncomplete: config.incomplete,
    browser: {
      ...browserStatus(),
      native: process.env.BROWSER_HEADLESS !== "true",
    },
    stores: stores.map((s) => s.shortName),
  });
});
app.post("/api/browser/show", async (req, res) => {
  const run =
    typeof req.body?.runId === "string" ? runs.get(req.body.runId) : undefined;
  if (run?.lease) {
    if (run.status === "running")
      run.cancel("You took control. Nothing was ordered.", true);
    const store = run.result?.winner?.store || "goodmarket";
    await showNativePage(run.lease.pages[store]);
    return res.json({
      url: run.lease.pages[store].url(),
      native: process.env.BROWSER_HEADLESS !== "true",
    });
  }
  res.json({
    ...(await showGeneralBrowser()),
    native: process.env.BROWSER_HEADLESS !== "true",
  });
});
app.post("/api/warm", async (_req, res) => {
  await warmBrowser();
  res.json(browserStatus());
});
const runInput = z.object({
  prompt: z.string().trim().min(3).max(2500),
  voiceSession: z.string().uuid().optional(),
});
app.post("/api/agent/run", async (req, res) => {
  const input = runInput.safeParse(req.body);
  if (!input.success)
    return res
      .status(400)
      .json({
        error: "Enter a browser request between 3 and 2,500 characters.",
      });
  const controller = new AbortController();
  res
    .status(200)
    .set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
  res.flushHeaders();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const deadline = setTimeout(() => controller.abort(), 60_000);
  try {
    await executeGeneral(
      input.data.prompt,
      (event) => {
        if (!res.destroyed && !res.writableEnded)
          res.write(JSON.stringify(event) + "\n");
      },
      controller.signal,
    );
  } catch (error) {
    if (!res.destroyed)
      res.write(
        JSON.stringify({
          type: "error",
          message:
            error instanceof Error ? error.message : "Browser task failed.",
        }) + "\n",
      );
  } finally {
    clearTimeout(deadline);
    res.end();
  }
});
app.post("/api/run", async (req, res) => {
  const input = runInput.safeParse(req.body);
  if (!input.success)
    return res
      .status(400)
      .json({
        error: "Enter a grocery request between 3 and 2,500 characters.",
      });
  if (
    [...runs.values()].filter(
      (run) => run.status === "running" || run.status === "approving",
    ).length >= 2
  )
    return res
      .status(429)
      .json({
        error: "Two errands are already running. Try again in a moment.",
      });
  const lease = input.data.voiceSession
    ? await claimVoice(input.data.voiceSession)
    : undefined;
  res
    .status(200)
    .set({
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
  res.flushHeaders();
  const run = new ShoppingRun(
    input.data.prompt,
    (event) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(JSON.stringify(event) + "\n");
    },
    lease,
  );
  runs.set(run.id, run);
  res.on("close", () => {
    if (!res.writableEnded && run.status === "running") run.cancel();
  });
  await run.execute();
  res.end();
});
app.post("/api/runs/:id/cancel", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "This errand has expired." });
  run.cancel();
  res.json({ status: run.status });
});
app.post("/api/runs/:id/approve", async (req, res) => {
  const input = z
    .object({
      approved: z.literal(true),
      expectedTotal: z.number().int().positive(),
    })
    .safeParse(req.body);
  if (!input.success)
    return res
      .status(400)
      .json({
        error: "Explicit approval and the reviewed total are required.",
      });
  const run = runs.get(req.params.id);
  if (!run)
    return res
      .status(404)
      .json({
        error: "This errand has expired. Run it again to refresh your basket.",
      });
  try {
    const result = await run.approve(input.data.expectedTotal);
    res.json({
      result,
      snapshot: run.events.filter((e) => e.type === "snapshot").at(-1)
        ?.snapshot,
    });
  } catch (error) {
    res
      .status(409)
      .json({
        error:
          error instanceof Error
            ? error.message
            : "The order could not be confirmed.",
      });
  }
});
app.get("/api/runs/:id/trace", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "This trace has expired." });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="dash-${run.id.slice(0, 8)}.json"`,
  );
  res.json({
    version: 1,
    prompt: run.prompt,
    result: run.result,
    events: run.events.filter((e) => e.type !== "snapshot"),
    note: "All timings are measured server wall-clock milliseconds. Parallel spans overlap. Local mode is not a Cerebras benchmark. Browser snapshots omitted from export.",
  });
});
app.post("/api/voice/prepare", async (_req, res) => {
  res.json(await prepareVoice());
});
app.post("/api/voice/:id/preview", async (req, res) => {
  const input = z
    .object({ transcript: z.string().max(2500) })
    .safeParse(req.body);
  if (!input.success)
    return res.status(400).json({ error: "Invalid transcript." });
  res.json(await previewVoice(req.params.id, input.data.transcript));
});
app.delete("/api/voice/:id", async (req, res) => {
  await discardVoice(req.params.id);
  res.json({ status: "closed" });
});
app.get("/shop/:store", (req, res) => {
  if (!stores.some((s) => s.id === req.params.store))
    return res.status(404).send("Store not found");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
  res.type("html").send(shopHTML(req.params.store as StoreId));
});
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) return res.end();
    console.error("Request failed:", error.message);
    res
      .status(500)
      .json({
        error: "Something went wrong preparing the browser. Please retry.",
      });
  },
);
const server = app.listen(port, hostname, () => {
  console.log(`Dash is running at http://localhost:${port}`);
  void warmGeneral().catch((error) =>
    console.error("General browser warmup failed:", error.message),
  );
  void warmBrowser(`http://${hostname}:${port}`)
    .then(() => console.log("Three browser tabs are warm and ready."))
    .catch((error) =>
      console.error(
        "Browser warmup failed. Run npm run browser:install.",
        error.message,
      ),
    );
});
const cleanup = setInterval(async () => {
  await cleanupVoice();
  for (const [id, run] of runs)
    if (
      Date.now() - run.created > 30 * 60_000 ||
      (runs.size > 12 && run.status !== "running")
    ) {
      runs.delete(id);
      await run.dispose();
    }
}, 60_000);
cleanup.unref();
async function shutdown() {
  clearInterval(cleanup);
  server.close();
  await Promise.all([closeBrowser(), closeGeneral()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
