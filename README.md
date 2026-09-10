# Dash

A focused consumer browser-agent demo. Submit one grocery request; Dash makes a list, searches three stores, validates dietary needs, compares prices, builds a cart, and chooses delivery. The final purchase requires explicit approval.

## Run

```sh
npm ci
npm run browser:install
cp .env.example .env
# Set CEREBRAS_API_KEY and CEREBRAS_MODEL=qwen-3.8-27b in .env.
npm run dev
```

Open http://localhost:3100. The assistant shell is task-neutral; shopping details appear in the tool result. The grocery request is prefilled for a short recording. Press Run once. A compact overlay stays visible by default and shows elapsed time, browser actions, model calls, and pages. Click it for the detailed stage timings.

The server starts three warm Chromium pages. Workers run headless by default. Set `BROWSER_HEADLESS=false` for visible worker windows. The browser belongs to the demo and does not inherit the user's Chrome credentials. The fictional stores need no authentication.

Goodmarket, Basket & Co., and Daybreak are functional commerce sandboxes. Their search forms, labels, prices, cart quantities, delivery selectors, and receipts are real DOM elements with working interactions. Products and prices are fictional, and no money is charged.

## Execution

Typing does not invoke the agent. The optional microphone uses the browser's Web Speech API to fill the draft. Finishing dictation does not submit it. There are no partial-transcript model calls; the old live-dictation and general-agent endpoints are disabled.

After submission, one Cerebras inference streams a structured plan and multiple item actions. Code executes independent searches across the three stores concurrently and uses deterministic price, dietary, stock, cart, and delivery logic. Browser execution starts as soon as a complete action is available. Read-only speculative searches may start from obvious grocery hints immediately after submission.

The browser uses DOM controls, blocks unnecessary resources, and waits for specific DOM conditions rather than network idle. The UI displays actual DOM snapshots. Its decorative cursor does not delay execution. Warmup and task timing are separate.

The assistant-ui external-store runtime provides the composer, messages, tool cards, cancellation, and purchase-approval callback. Only public packages are used.

## Timing

The detailed overlay records prompt-to-inference, first-token-to-browser-action, navigation, DOM extraction, browser execution, and total task time. Inference includes time to first token, first executable action, provider queue, prefill, generation, and transport/client residual. Thinking is disabled. The residual includes buffering and parsing, so it is not a pure network RTT. Parallel spans overlap and should not be summed as elapsed time.

See [BENCHMARKS.md](BENCHMARKS.md) for measured results. The targets are under 500 ms between visible actions and under ten seconds from submission to cart. Provider latency can cause outliers; the overlay exposes those waits.

## Verify

Run the server before the browser checks.

```sh
npm test
npm run build
npm run verify:voice
npm run verify:ui
npm run verify:clip
npm run verify:checkout
npm run benchmark
```

`verify:voice` verifies zero agent calls while typing and dictating, then exactly one inference after submission. `verify:ui` checks the always-visible stats, assistant-ui integration, approval gate, and mobile layout. Artifacts and traces are saved locally under `artifacts/` and ignored by Git, along with `.env` and browser profiles.

`npm run build` followed by `npm start` serves the production frontend. Without a configured key and model, supported examples use a clearly labeled local planner. Cerebras measurements require real credentials.
