import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.DASH_URL || "http://127.0.0.1:3100";
async function run(prompt: string) {
  await fetch(base + "/api/warm", { method: "POST" });
  const res = await fetch(base + "/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return events.find((e) => e.type === "result").result;
}
const result = await run(
  "Buy milk, cheese and yogurt for two. Everything must be vegan and dairy-free. Keep the total under $30. Deliver tomorrow morning.",
);
assert.equal(result.status, "approval", JSON.stringify(result.warnings));
assert(
  result.winner.items.every(
    (item: { product: { diets: string[] } }) =>
      item.product.diets.includes("vegan") &&
      item.product.diets.includes("dairy-free"),
  ),
);
const url = `${base}/api/runs/${result.id}/approve`;
const send = (body: object) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
assert.equal(
  (await send({ expectedTotal: result.winner.total })).status,
  400,
  "Missing explicit approval rejected",
);
assert.equal(
  (await send({ approved: true, expectedTotal: 1 })).status,
  409,
  "Changed total rejected",
);
const before = await (
  await fetch(`${base}/api/runs/${result.id}/trace`)
).json();
assert(
  !before.events.some((e: { label?: string }) =>
    e.label?.includes("Place user-approved"),
  ),
  "No purchase action before explicit approval",
);
const approved = await send({
  approved: true,
  expectedTotal: result.winner.total,
});
assert.equal(approved.status, 200);
const receipt = await approved.json();
assert.equal(receipt.result.status, "ordered");
assert(receipt.result.receipt.id.startsWith("DASH-"));
const repeat = await send({
  approved: true,
  expectedTotal: result.winner.total,
});
const repeated = await repeat.json();
assert.equal(
  repeated.result.receipt.id,
  receipt.result.receipt.id,
  "Approval is idempotent",
);
const after = await (await fetch(`${base}/api/runs/${result.id}/trace`)).json();
assert.equal(
  after.events.filter(
    (e: { type: string; label?: string; status?: string }) =>
      e.type === "action" &&
      e.status === "done" &&
      e.label === "Place user-approved sandbox order",
  ).length,
  1,
  "Exactly one sandbox order was placed",
);
mkdirSync("artifacts", { recursive: true });
const summary = {
  timestamp: new Date().toISOString(),
  checks: [
    "Dietary substitutions are vegan and dairy-free",
    "Missing approval rejected",
    "Mismatched total rejected",
    "No purchase before approval",
    "Sandbox receipt verified",
    "Repeated approval returns the same receipt",
    "Exactly one purchase action",
  ],
  receipt: receipt.result.receipt,
  metrics: result.metrics,
};
writeFileSync(
  "artifacts/checkout-verification.json",
  JSON.stringify(summary, null, 2),
);
console.log(
  JSON.stringify(
    { ...summary, metrics: { ...summary.metrics, spans: undefined } },
    null,
    2,
  ),
);
