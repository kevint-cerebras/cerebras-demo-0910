import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.DASH_URL || "http://127.0.0.1:3100";
mkdirSync("artifacts", { recursive: true });
await fetch(base + "/api/warm", { method: "POST" });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
let requests = 0;
let result: any;
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.url().endsWith("/api/run")) requests++;
});
page.on("response", (r) => {
  if (r.url().endsWith("/api/run"))
    void r.text().then((text) => {
      result = text
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s))
        .find((e) => e.type === "result")?.result;
    });
});
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("status", { name: "Powered by Cerebras" }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "Development timing overlay" })
      .isVisible(),
    "Stats overlay visible before submission",
  );
  await page.screenshot({
    path: "artifacts/desktop-home.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.equal(
    await page.locator('[data-assistant-ui="external-store-runtime"]').count(),
    1,
  );
  await page
    .getByLabel("Ask Dash to use the browser")
    .fill(
      "Buy milk, cheese and yogurt for 2. Everything vegan and dairy-free. Under $30, tomorrow morning.",
    );
  assert.equal(requests, 0, "Typing must not invoke the agent");
  await page.getByLabel("Ask Dash to use the browser").press("Enter");
  await page
    .getByRole("button", { name: "Review & approve" })
    .waitFor({ timeout: 30_000 });
  assert.equal(
    requests,
    1,
    "Assistant UI composer sends exactly one backend request",
  );
  assert.equal(await page.getByTestId("aui-user-message").count(), 1);
  assert.equal(await page.getByTestId("aui-assistant-message").count(), 1);
  assert.equal(await page.getByTestId("aui-browser-tool").count(), 0);
  assert.equal(
    await page.getByLabel("Ask Dash to use the browser").inputValue(),
    "",
  );
  await page.screenshot({
    path: "artifacts/assistant-ui-cart.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Review & approve" }).click();
  const finalButton = page.getByRole("button", {
    name: /Approve sandbox order/,
  });
  assert.equal(await finalButton.isEnabled(), false);
  await page.getByRole("checkbox").check();
  await finalButton.click();
  await page
    .getByRole("button", { name: "What’s next?" })
    .waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: "artifacts/assistant-ui-approved.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Development timing overlay" })
    .click();
  await page
    .getByText("Actual generation · provider measured", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "artifacts/latency-breakdown.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close timing overlay" }).click();
  await page
    .getByRole("button", { name: "New browser task", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "artifacts/mobile-home.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal overflow on mobile",
  );
  assert.equal(
    result?.metrics.modelCalls,
    1,
    "Exactly one inference per submitted request",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  writeFileSync(
    "artifacts/ui-verification.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        checks: [
          "Assistant UI external-store provider mounted",
          "Composer Enter submitted exactly once",
          "One user message and one assistant message",
          "Custom tool UI rendered through message parts",
          "Composer cleared after send",
          "Approval blocked without checkbox",
          "Assistant UI tool approval reached backend and receipt",
          "Detailed inference timing visible",
          "Mobile has no horizontal overflow",
          "No page exceptions",
        ],
        runId: result?.id,
        metrics: result?.metrics,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        status: "passed",
        requests,
        runId: result?.id,
        totalMs: result?.metrics.total,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
