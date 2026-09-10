import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let agentRequests = 0;
let partialRequests = 0;
page.on("request", (request) => {
  if (request.url().endsWith("/api/run")) agentRequests++;
  if (
    request.url().includes("/api/voice") ||
    request.url().includes("/api/agent")
  )
    partialRequests++;
});
await page.addInitScript({
  content: `
  let active;
  class Speech {
    start(){ active=this; }
    stop(){ active=undefined; queueMicrotask(()=>this.onend?.()); }
    abort(){ this.stop(); }
  }
  Object.assign(window,{SpeechRecognition:Speech,emitSpeech:text=>active.onresult({results:[{0:{transcript:text}}]})});
`,
});
const prompt =
  "Get ingredients for dairy-free vegetarian tacos for four, under $35, delivered tomorrow evening.";
try {
  await page.goto("http://localhost:3100", { waitUntil: "domcontentloaded" });
  assert(
    await page
      .getByRole("button", { name: "Development timing overlay" })
      .isVisible(),
  );
  await page
    .getByRole("textbox", { name: "Ask Dash to use the browser" })
    .fill("Get groceries for dinner");
  await page.getByRole("button", { name: "Speak your request" }).click();
  const words = prompt.split(" ");
  for (let i = 1; i <= words.length; i++) {
    await page.evaluate(
      (text) => (window as any).emitSpeech(text),
      words.slice(0, i).join(" "),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(agentRequests, 0, "No model request during typing or dictation");
  assert.equal(partialRequests, 0, "No partial-input API calls");
  await page.getByRole("button", { name: "Finish dictation" }).click();
  assert.equal(agentRequests, 0, "Finishing dictation must not submit");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Ask Dash to use the browser" })
      .inputValue(),
    prompt,
  );
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .getByRole("button", { name: "Review & approve" })
    .waitFor({ timeout: 30000 });
  assert.equal(agentRequests, 1, "One submitted request");
  assert.equal(partialRequests, 0);
  await page
    .getByRole("button", { name: "Development timing overlay" })
    .click();
  const href = await page
    .getByRole("link", { name: "Download timing trace" })
    .getAttribute("href");
  const { result } = await (
    await fetch(new URL(href!, "http://localhost:3100"))
  ).json();
  assert.equal(
    result.metrics.modelCalls,
    1,
    "One streamed inference after submission",
  );
  assert.equal(result.status, "approval");
  writeFileSync(
    "artifacts/submission-only-verification.json",
    JSON.stringify(
      {
        status: "passed",
        agentRequests,
        partialRequests,
        modelCalls: result.metrics.modelCalls,
        cartMs: result.metrics.total,
        firstBrowserActionMs: result.metrics.firstAction,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      agentRequests,
      partialRequests,
      modelCalls: result.metrics.modelCalls,
      cartMs: result.metrics.total,
    }),
  );
} finally {
  await browser.close();
}
