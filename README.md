# Dash Marketplace Vision Demo

A local React + Playwright browser-agent demo for read-only Facebook Marketplace research. The live browser occupies 75% of the workspace and the Dash chat occupies 25%.

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

The launcher opens the Dash controller at [http://localhost:3100](http://localhost:3100) automatically. Before submitting the demo prompt, use the interactive browser preview or pop-out target browser to log into Facebook if needed. The target browser does not initiate a run by itself: type the request in the Dash controller and press **Run**. Do not run both provider commands at once; both use port 3100 and the same persistent browser profile.

The default embedded browser runs headlessly at the process level but is visible and interactive in Dash. To request a separate native window from a normal macOS Terminal, run with `BROWSER_HEADLESS=false`.

## Demo prompt

```text
My friend Qi is an avid collector of statues of geese. Look for all geese statues on facebook marketplace that can ship to sunnyvale, and give me the top options with geese with their mouths open
```

The fixed brief behind the composer narrows the output to two verified matches and requires the final answer to include clickable listing links, prices, locations, photo evidence, and shipping evidence.

After Dash collects plausible search-result links, it may preload up to ten Facebook Marketplace listings concurrently in tabs sharing the logged-in profile. It then switches through those tabs sequentially for screenshot-based photo verification and always calls the final-answer tool after two matches or an unavoidable blocker.

## Verification

```bash
npm run build
npm test
```

The Cerebras and Fireworks launchers share the same UI, browser profile, tool policy, vision screenshots, and stopping rule; only the inference provider changes.
