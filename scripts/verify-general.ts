import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const reports: unknown[] = [];
try {
  await page.goto("http://localhost:3100", { waitUntil: "domcontentloaded" });
  for (const prompt of [
    "Open Wikipedia and find the article about sea otters. Tell me their scientific name.",
    "Open https://example.org and tell me what this page is for.",
  ]) {
    await page
      .getByRole("textbox", { name: "Ask Dash to use the browser" })
      .fill(prompt);
    const responsePromise = page.waitForResponse(
      (r) => r.url().endsWith("/api/run") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const response = await responsePromise;
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = events.find((e) => e.type === "result")?.result;
    assert(result, "A final result must arrive");
    assert.equal(result.status, "done", JSON.stringify(result.warnings));
    assert(events.some((e) => e.type === "browser-mode"));
    assert(events.some((e) => e.type === "browser-page"));
    assert(
      !events.some((e) => e.type === "plan" || e.type === "item"),
      "Public tasks must not generate shopping plans",
    );
    assert(result.metrics.modelCalls >= 2);
    assert(
      result.metrics.browserInferenceCalls.length ===
        result.metrics.modelCalls - 1,
    );
    assert(await page.locator(".general-preview").isVisible());
    assert(
      await page
        .getByRole("button", { name: "Development timing overlay" })
        .isVisible(),
    );
    assert(result.summary.length > 10);
    await page.screenshot({
      path: reports.length
        ? "artifacts/general-example.png"
        : "artifacts/general-wikipedia.png",
      animations: "disabled",
    });
    reports.push({
      prompt,
      status: result.status,
      summary: result.summary,
      metrics: result.metrics,
    });
    console.log(
      JSON.stringify({
        prompt,
        summary: result.summary,
        total: result.metrics.total,
        modelCalls: result.metrics.modelCalls,
      }),
    );
  }
  writeFileSync(
    "artifacts/general-verification.json",
    JSON.stringify(reports, null, 2),
  );
} finally {
  await browser.close();
}
