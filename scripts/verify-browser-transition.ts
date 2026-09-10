import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { warmBrowser, acquireBrowser, closeBrowser } from "../server/browser";
import { adoptGeneralPage, warmGeneral, closeGeneral } from "../server/agent";

process.env.BROWSER_HEADLESS = "true";
try {
  await warmBrowser("http://127.0.0.1:3100");
  const lease = await acquireBrowser();
  const page = lease.pages.basket;
  await adoptGeneralPage(page);
  assert.equal(
    await warmGeneral(),
    page,
    "Adoption must preserve the exact cart tab",
  );
  await page.goto("https://en.wikipedia.org/wiki/Lisbon", {
    waitUntil: "domcontentloaded",
  });
  assert.match(await page.locator("h1").innerText(), /Lisbon/);
  let privateBlocked = false;
  try {
    await page.goto("http://127.0.0.1:3100/api/health", { timeout: 3000 });
  } catch {
    privateBlocked = true;
  }
  assert(privateBlocked, "Adoption must retain private endpoint restrictions");
  writeFileSync(
    "artifacts/browser-transition-verification.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        status: "passed",
        checks: [
          "Same cart tab retained",
          "Public Wikipedia navigation succeeded",
          "Private API destination blocked",
        ],
      },
      null,
      2,
    ),
  );
  console.log("Browser transition checks passed");
} finally {
  await closeGeneral();
  await closeBrowser();
}
