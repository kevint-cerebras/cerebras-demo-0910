import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { examples } from "../shared/catalog";
const base = process.env.DASH_URL || "http://127.0.0.1:3100";
mkdirSync("artifacts/recordings", { recursive: true });
await fetch(base + "/api/warm", { method: "POST" });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  recordVideo: {
    dir: "artifacts/recordings",
    size: { width: 1440, height: 960 },
  },
});
const page = await context.newPage();
const recording = page.video()!;
const errors: string[] = [];
const runs: unknown[] = [];
const captures: Promise<void>[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (/\/api\/(?:agent\/)?run$/.test(response.url()))
    captures.push(
      response.text().then((text) => {
        const events = text
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        const result =
          events.find((e) => e.type === "result")?.result ||
          events.find((e) => e.type === "done");
        const failure = events.find((e) => e.type === "error");
        if (failure) errors.push(failure.message);
        if (!result)
          errors.push("Browser run ended without a successful result.");
        runs.push(result);
      }),
    );
});
// These pauses pace the human demonstration; no backend action waits for them.
const hold = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("status", { name: "Powered by Cerebras" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await hold(1200);
  const composer = page.getByLabel("Ask Dash to use the browser");
  await composer.pressSequentially(examples[0].prompt, { delay: 26 });
  await hold(450);
  await composer.press("Enter");
  await page
    .getByRole("button", { name: "Review & approve" })
    .waitFor({ timeout: 30_000 });
  await hold(1400);
  await page.getByRole("button", { name: "Review & approve" }).click();
  await hold(1800);
  await page.getByRole("checkbox").check();
  await hold(650);
  await page.getByRole("button", { name: /Approve sandbox order/ }).click();
  await page
    .getByRole("button", { name: "What’s next?" })
    .waitFor({ timeout: 15_000 });
  await hold(1800);
  await page
    .getByRole("button", { name: "Development timing overlay" })
    .click();
  await hold(2600);
  await page.screenshot({
    path: "artifacts/demo-cover.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close timing overlay" }).click();
  await page
    .getByRole("button", { name: "New browser task", exact: true })
    .click();
  await hold(800);
  await Promise.all(captures);
  if (errors.length) throw new Error(errors.join("\n"));
  await page.screenshot({
    path: "artifacts/public-browser-demo.png",
    animations: "disabled",
  });
} finally {
  await context.close();
  await recording.saveAs("artifacts/dash-live-demo.webm");
  await browser.close();
}
writeFileSync(
  "artifacts/recording-provenance.json",
  JSON.stringify(
    {
      created: new Date().toISOString(),
      file: "dash-live-demo.webm",
      source:
        "Continuous Playwright video of the actual Dash frontend, live Cerebras requests and browser execution",
      playbackSpeed: 1,
      input:
        "Typed text through the Assistant UI composer. No simulated speech in this recording.",
      checkout: "Explicitly approved sandbox order. No real charge.",
      runs,
      pageErrors: errors,
    },
    null,
    2,
  ),
);
console.log(
  "Saved artifacts/dash-live-demo.webm and recording-provenance.json",
);
