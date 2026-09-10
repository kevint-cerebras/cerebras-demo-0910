# Dash Marketplace and Amazon Demos

A local React + Playwright browser-agent harness with separate Facebook Marketplace research and Amazon cart-preparation modes. The live browser occupies 75% of the workspace and the Dash chat occupies 25%.

The hidden Marketplace brief asks the model to inspect every photo for plausible goose-statue listings, verify a pixel-visible open beak, verify shipping to Sunnyvale, CA 94085, and stop immediately after two qualified listings. The visible composer is intentionally blank and accepts the presenter’s natural-language request.

The agent cannot message sellers, make offers, save listings, enter credentials, or purchase anything. Those controls are blocked in code as well as in the model instructions.

## Setup

```bash
npm ci
npm run build
```

Copy `.env.example` to `.env`, add the provider keys, and keep `.env` private. Browser cookies are stored under the ignored `.browser-profile/marketplace` directory, so a Facebook login can persist across runs.

## Launch with Cerebras

```bash
npm run marketplace:cerebras
```

## Launch with Fireworks

```bash
npm run marketplace:fireworks
```

## Amazon party-favor demo

The Amazon mode uses a separate ignored persistent profile at `.browser-profile/amazon`, so Amazon and Facebook sessions do not mix. It is optimized for a request where 12 children should each receive three distinct favors costing less than $5 per individual favor. Dash searches, adds sufficient quantities to the Amazon cart, verifies the live cart, and returns product links and quantity math. Checkout, ordering, credentials, addresses, and payment are blocked in code and instructions.

Launch with Cerebras:

```bash
npm run amazon:cerebras
```

Launch with Fireworks:

```bash
npm run amazon:fireworks
```

Suggested prompt:

```text
I'm shopping for my niece's birthday party. I need three party favors each for 12 girls under five years old. Each item must cost less than $5. Build and verify the Amazon cart, but do not place an order.
```

The launcher opens the Dash controller at [http://localhost:3100](http://localhost:3100) automatically. Before submitting the demo prompt, use the interactive browser preview or pop-out target browser to log into Facebook if needed. The target browser does not initiate a run by itself: type the request in the Dash controller and press **Run**. Do not run both provider commands at once; both use port 3100 and the same persistent browser profile.

The default embedded browser runs headlessly at the process level but is visible and interactive in Dash. To request a separate native window from a normal macOS Terminal, run with `BROWSER_HEADLESS=false`.

## Demo prompt

```text
My friend Qi is an avid collector of statues of geese. Look for all geese statues on facebook marketplace that can ship to sunnyvale, and give me the top options with geese with their mouths open
```

The fixed brief behind the composer narrows the output to two verified matches and requires the final answer to include clickable listing links, prices, locations, photo evidence, and shipping evidence.

After Dash collects plausible search-result links, it fans out up to ten independent Qwen workers concurrently. Each worker owns one Facebook Marketplace tab in the shared logged-in context, evaluates only the first listing screenshot, verifies open-beak pixels and Sunnyvale shipping, and returns a structured verdict with a single vision call. This deliberately trades gallery coverage for minimum demo latency. The parent coordinator gathers every verdict and always calls the final-answer tool with the best two matches or an explicit blocker result.

Worker tabs appear in the Dash tab strip as soon as they are created. While processing continues concurrently, the pop-out browser and embedded preview rotate through individual worker tabs as their first photos are captured and judged; the status line identifies the worker currently on screen. The always-visible elapsed-time counter is omitted from the presentation UI.

The submitted request remains pinned at the top of the assistant panel throughout processing and after the final answer, so the demo audience can always see the task the workers are executing.

## Verification

```bash
npm run build
npm test
```

The Cerebras and Fireworks launchers share the same UI, browser profile, tool policy, vision screenshots, and stopping rule; only the inference provider changes.
