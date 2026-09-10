import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
try {
  await page.goto("http://localhost:3100", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Run", exact: true }).click();
  const approve = page.getByRole("button", { name: "Review & approve" });
  await approve.waitFor({ timeout: 30000 });
  const rect = await approve.boundingBox();
  assert(
    rect && rect.y >= 0 && rect.y + rect.height <= 900,
    "Approval must be visible without scrolling",
  );
  assert(
    await page
      .getByRole("button", { name: "Development timing overlay" })
      .isVisible(),
  );
  await page.screenshot({
    path: "artifacts/clip-ready.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Development timing overlay" })
    .click();
  const href = await page
    .getByRole("link", { name: "Download timing trace" })
    .getAttribute("href");
  const { result } = await (
    await fetch(new URL(href!, "http://localhost:3100"))
  ).json();
  assert.equal(result.metrics.modelCalls, 1);
  writeFileSync(
    "artifacts/clip-verification.json",
    JSON.stringify(
      {
        status: "passed",
        viewport: [1600, 900],
        approvalVisible: true,
        metrics: result.metrics,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      cartMs: result.metrics.total,
      modelCalls: result.metrics.modelCalls,
      approvalVisible: true,
    }),
  );
} finally {
  await browser.close();
}
