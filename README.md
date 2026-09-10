# Dash

A consumer browser assistant demo powered by Cerebras and assistant-ui. Ask for an everyday errand, watch browser work begin, and approve the final cart.

## Run locally

Requires Node 22 or newer.

```sh
npm ci
npm run browser:install
cp .env.example .env
# Add your Cerebras key and qwen-3.8-27b model to .env.
npm run dev
```

Open http://localhost:3100. Wait for the browser to warm before presenting. The server binds to localhost. Credentials stay on the server; `.env`, browser profiles, and test artifacts are ignored by Git.

For a production frontend build, run `npm run build`, then `npm start`. To keep worker windows out of a recording, start with `BROWSER_HEADLESS=true npm run dev`. Native takeover requires the default headed mode.

## Demo flow

1. Ask for dairy-free vegetarian tacos for four under $35, delivered tomorrow evening.
2. Watch three stores searched concurrently while the model streams the shopping list.
3. Expand the price comparison, inspect the cart and delivery slot, then review and approve the sandbox order.
4. Start another task and ask Dash to open a public URL, read the page, or find information.
5. Open the timing overlay to inspect browser work and individual inference calls.

Goodmarket, Basket & Co., and Daybreak are functional local commerce sandboxes. Their search controls, cart buttons, quantities, delivery selectors, and receipts work as ordinary web pages. Product information and prices are fictional. There is no real charge.

## Browser ownership

Dash is a separate web application controlling its own Chromium browser. The assistant panel belongs to Dash, not the grocery websites. In headed mode, **Open native browser** lets a person use the real browser tab and continue from that state.

The general browser has its own persistent profile in `.browser-profile/general`. It does not inherit the user's Google Chrome cookies, logins, extensions, or history. Shopping runs use isolated contexts; their cart can continue into general browsing in the same tab. This demo is a browser assistant, not a desktop-wide assistant or installed extension.

## What uses assistant-ui

The public `@assistant-ui/react` package provides the external-store runtime, composer, message list, tool-call rendering, cancellation, and tool-approval callback. `@assistant-ui/react-markdown` renders answers. Rich shopping and browser progress are real message tool parts. Approval reaches the backend through the assistant-ui runtime. No unpublished Assistant UI packages are included.

## Voice

Dash uses the browser's Web Speech API with interim results. Use Chrome and allow microphone access when prompted. While speech arrives, deterministic code opens destinations and searches recognized products. These read-only results are reused when the request is submitted. The final list and constraints still pass through Cerebras before cart construction.

The automated speech test injects transcript events at 120, 150, and 180 words per minute through the same recognition lifecycle. It measures transcript-to-browser latency. It does not measure microphone transcription accuracy or audio-to-text latency.

## Execution and timing

The shopping path uses one streamed inference to produce multiple structured actions. Independent store work runs concurrently; dependent actions stay ordered. Browser sessions are warm, unnecessary resources are blocked, and execution waits for specific DOM states rather than `networkidle`. The decorative cursor follows completed actions after about 100 ms and does not gate execution.

General browsing uses streamed native tool calls with versioned DOM element IDs. Actions target observed elements. Sensitive input values are redacted, private destinations are restricted, and consequential website actions stop for human review. This is a bounded demo, not a security-hardened general-purpose browser service.

The overlay separates navigation, DOM extraction, browser execution, model calls, and presentation capture. Inference includes time to first token, time to first executable action, observed streaming duration, provider prefill and generation, queue time, and a transport/client residual. Reasoning is disabled with `reasoning_effort: "none"`. Overlapping measurements should not be added together.

Cerebras is connected directly. Stagehand PR #2907 was reviewed for browser execution and evidence design; Stagehand is not a dependency and its removed Cerebras integration is not used.

## Verification

Run the server first for browser checks.

```sh
npm test
npm run build
npm run verify:ui
npm run verify:checkout
npm run verify:transition
npm run benchmark
WPM=180 npm run benchmark:speech
```

See [BENCHMARKS.md](BENCHMARKS.md) for measured results and limitations. Raw traces and screenshots are written to `artifacts/`. `npm run record` is a developer capture script using Playwright, distinct from the requested final Screen Studio recording.

Without a configured Cerebras key and model, the supported grocery examples can use a clearly labeled deterministic local planner. General browsing requires Cerebras. Performance claims in the report use real Cerebras calls.
