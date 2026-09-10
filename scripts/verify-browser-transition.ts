import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { warmBrowser, acquireBrowser, closeBrowser } from "../server/browser";
import {
  adoptGeneralPage,
  warmGeneral,
  closeGeneral,
  executeGeneral,
} from "../server/agent";

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
  const events: Record<string, unknown>[] = [];
  await executeGeneral(
    "Open https://en.wikipedia.org/wiki/Lisbon and briefly identify the city.",
    (event) => events.push(event),
    new AbortController().signal,
  );
  assert(
    !events.some((event) => event.type === "error"),
    "Full agent loop must preserve the adopted tab",
  );
  assert(
    events.some((event) => event.type === "done"),
    "Agent must finish the public-page request",
  );
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
