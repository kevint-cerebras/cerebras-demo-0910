import test from "node:test";
import assert from "node:assert/strict";
import { eligible, chooseSlot, compareQuotes } from "../server/runner";
import { productsFor, deliverySlots } from "../shared/catalog";

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
import {
  authorizedAmazonPurchaseAction,
  browserSystem,
  classifyAmazonOrderState,
  marketplaceBrowserTools,
  readPageScript,
  safePublicURL,
} from "../shared/browser-tools";
import { nativeCursorScript } from "../shared/native-cursor";
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

test("the research-mode harness is configured for the OpenTable date-night task", () => {
  assert.match(browserSystem, /OpenTable reservation agent/);
  assert.match(browserSystem, /Hayes Valley/);
  assert.match(browserSystem, /5:30 PM through 6:30 PM/);
  assert.match(browserSystem, /Reject any reservation that requires a credit card, deposit, prepayment/);
  assert.doesNotMatch(browserSystem, /Facebook|goose statue/i);
  assert(
    marketplaceBrowserTools.some((tool) => tool.function.name === "open_listing_tabs"),
  );
});

test("real order controls require an explicitly authorized Amazon session", () => {
  assert.equal(
    authorizedAmazonPurchaseAction("Place your order", "amazon", true),
    true,
  );
  assert.equal(
    authorizedAmazonPurchaseAction("Proceed to checkout", "amazon", true),
    true,
  );
  assert.equal(
    authorizedAmazonPurchaseAction("Place your order", "amazon", false),
    false,
  );
  assert.equal(
    authorizedAmazonPurchaseAction("Place your order", "marketplace", true),
    false,
  );
  assert.equal(
    authorizedAmazonPurchaseAction("Buy Now", "amazon", true),
    false,
  );
  assert.equal(
    authorizedAmazonPurchaseAction(
      "Delete",
      "amazon",
      true,
      "https://www.amazon.com/gp/cart/view.html",
    ),
    true,
  );
  assert.equal(
    authorizedAmazonPurchaseAction(
      "Delete account",
      "amazon",
      true,
      "https://www.amazon.com/your-account",
    ),
    false,
  );
  assert.equal(
    authorizedAmazonPurchaseAction(
      "Remove",
      "marketplace",
      true,
      "https://www.amazon.com/gp/cart/view.html",
    ),
    false,
  );
});

test("Amazon payment authorization is not mistaken for order confirmation", () => {
  assert.equal(
    classifyAmazonOrderState("https://www.amazon.com/checkout", "Authorizing bank…"),
    "pending",
  );
  assert.equal(
    classifyAmazonOrderState("https://www.amazon.com/gp/buy/thankyou", "Thank you"),
    "confirmed",
  );
  assert.equal(
    classifyAmazonOrderState("https://www.amazon.com/checkout", "Your payment was declined"),
    "failed",
  );
  assert.equal(
    classifyAmazonOrderState("https://www.amazon.com/checkout", "Enter the one-time passcode"),
    "manual_action",
  );
});
