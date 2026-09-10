import test from "node:test";
import assert from "node:assert/strict";
import { localPlan, mentionedKeys, parsePlanLine } from "../server/planner";
import { eligible, chooseSlot, compareQuotes } from "../server/runner";
import { productsFor, deliverySlots } from "../shared/catalog";

test("taco plan preserves dietary, budget, servings and delivery constraints", () => {
  const plan = localPlan(
    "Get everything for dairy-free veggie tacos for 4, under $35. Deliver tomorrow evening.",
  );
  assert.equal(plan.meta.budget, 35);
  assert.equal(plan.meta.people, 4);
  assert.deepEqual(plan.meta.diets, ["vegetarian", "dairy-free"]);
  assert.equal(plan.meta.delivery, "tomorrow-evening");
  assert.equal(plan.items.find((i) => i.key === "black-beans")?.quantity, 2);
});
test("a weekly breakfast plan includes enough perishable packages", () => {
  const plan = localPlan(
    "Stock up on gluten-free breakfasts for 2 for the week: oats, oat milk, bananas, blueberries and yogurt. Under $40, tomorrow morning.",
  );
  assert.equal(plan.meta.delivery, "tomorrow-morning");
  assert(plan.meta.diets.includes("gluten-free"));
  assert.equal(plan.items.find((i) => i.key === "banana")?.quantity, 2);
  assert(!plan.items.some((i) => i.key === "milk"));
});
test("schema rejects arbitrary browser commands, invalid quantities and late-shaped plans", () => {
  assert.throws(() =>
    parsePlanLine('{"type":"purchase","url":"https://example.com"}'),
  );
  assert.throws(() =>
    parsePlanLine(
      '{"type":"item","key":"banana","quantity":0,"reason":"test"}',
    ),
  );
  assert.throws(() =>
    parsePlanLine(
      '{"type":"item","key":"unlisted-product","quantity":1,"reason":"test"}',
    ),
  );
});
test("unrelated tasks and unsupported dietary claims do not silently create a cart", () => {
  assert.throws(() => localPlan("Book a flight to Paris"));
  assert.throws(() => localPlan("Buy a soy-free tofu dinner"));
});
test("allergy and diet checks select the correct variants", () => {
  const products = productsFor("goodmarket");
  assert(
    !eligible(products.find((p) => p.id === "goodmarket-pasta")!, [
      "gluten-free",
    ]),
  );
  assert(
    eligible(products.find((p) => p.id === "goodmarket-pasta-alternative")!, [
      "gluten-free",
    ]),
  );
  assert(
    !eligible(products.find((p) => p.id === "goodmarket-milk")!, [
      "dairy-free",
    ]),
  );
  assert(
    eligible(products.find((p) => p.id === "goodmarket-milk-alternative")!, [
      "vegan",
      "dairy-free",
    ]),
  );
  assert(
    !eligible(products.find((p) => p.key === "peanut-butter")!, ["nut-free"]),
  );
  const contaminated = {
    ...products.find((p) => p.key === "oats")!,
    mayContain: ["milk"],
  };
  assert(!eligible(contaminated, ["dairy-free"]));
});
test("full slots are never selected and incomplete quotes never win", () => {
  assert.equal(
    chooseSlot(deliverySlots(), "tomorrow-evening")?.id,
    "tomorrow-eve",
  );
  assert.equal(
    chooseSlot(
      deliverySlots().map((s) => ({ ...s, available: false })),
      "earliest",
    ),
    null,
  );
  const base = {
    subtotal: 100,
    delivery: 10,
    total: 110,
    complete: true,
    missing: [],
    items: [],
    slot: null,
  };
  const winner = compareQuotes([
    { ...base, store: "goodmarket" },
    { ...base, total: 50, store: "basket", complete: false, missing: ["milk"] },
  ]);
  assert.equal(winner?.store, "goodmarket");
});
test("post-submission product hints recognize grocery names", () => {
  assert.deepEqual(
    mentionedKeys("Open the browser and get bananas and oat milk"),
    ["oat-milk", "banana"],
  );
  assert.deepEqual(mentionedKeys("Open the browser"), []);
});

import { enforceExplicitConstraints } from "../server/planner";
import { readPageScript, safePublicURL } from "../shared/browser-tools";
import { nativeCursorScript } from "../shared/native-cursor";
test("explicit budget and dietary limits survive incorrect model metadata", () => {
  const meta = localPlan("Buy milk").meta;
  const checked = enforceExplicitConstraints(
    { ...meta, budget: 100, diets: [] },
    "Buy milk. Dairy-free, gluten-free and under $20.",
  );
  assert.equal(checked.budget, 20);
  assert(checked.diets.includes("dairy-free"));
  assert(checked.diets.includes("gluten-free"));
});
test("browser helper scripts are valid JavaScript and private destinations are blocked", () => {
  assert.doesNotThrow(() => new Function(readPageScript));
  assert.doesNotThrow(() => new Function(nativeCursorScript));
  assert.throws(() => safePublicURL("http://127.0.0.1/admin"));
  assert.throws(() => safePublicURL("file:///etc/passwd"));
  assert.equal(
    safePublicURL("https://en.wikipedia.org/wiki/Porto"),
    "https://en.wikipedia.org/wiki/Porto",
  );
});
