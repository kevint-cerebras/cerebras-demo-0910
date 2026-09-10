# cerebras-demo-0910

Dash is a consumer browser assistant powered by Cerebras and built with assistant-ui.

A consumer browser-agent demo with a general browser and preloaded grocery sandbox. Ask Dash to open a website, search, read, or interact with page controls. For a local grocery request, Cerebras chooses ingredients, compares observed prices and dietary labels, and selects a cart. Batch DOM tools search three stores concurrently, build the selected cart, verify its contents, and choose delivery. The final purchase requires explicit approval.

## Run

```sh
npm ci
npm run browser:install
cp .env.example .env
# Set CEREBRAS_API_KEY and CEREBRAS_MODEL=qwen-3.8-27b in .env.
npm run dev
```

Open http://localhost:3100. The assistant shell is task-neutral; shopping details appear in the tool result. The grocery request is prefilled for a short recording. Press Run once. A compact overlay stays visible by default and shows elapsed time, browser actions, model calls, and pages. Click it for the detailed stage timings.

The preview starts on Google, with no store selector. The server preloads the general browser and three grocery tabs in the background. Browser processes persist across tasks, and spare grocery pages are replenished in the background as soon as a task takes a warm session. Workers run headless by default. Set `BROWSER_HEADLESS=false` for visible worker windows. The browser belongs to the demo and does not inherit the user's Chrome credentials. The fictional stores need no authentication.

Goodmarket, Basket & Co., and Daybreak are functional commerce sandboxes. Their search forms, labels, prices, cart quantities, delivery selectors, and receipts are real DOM elements with working interactions. Products and prices are fictional, and no money is charged.

## Execution

Typing does not invoke the agent. The optional microphone uses the browser's Web Speech API to fill the draft. Finishing dictation does not submit it. There are no partial-transcript model calls; all tasks go through the same submission endpoint.

After submission, Cerebras uses the DOM browser loop for every request. Browser execution starts as soon as a complete tool call is available. Tools support navigation, reading, clicking, filling, selecting, scrolling, tabs, and search. The loop has no fixed model-call cap; runs still have a 45-second timeout and can be stopped by the user. Follow-up requests can act on the current page. Login, CAPTCHA, access restrictions, and consequential actions can require user intervention.

The browser uses DOM controls, blocks unnecessary resources, and waits for specific DOM conditions rather than network idle. The UI displays DOM snapshots for the local stores and screenshots for general websites. Screenshots are presentation only; the model receives DOM text and observed element IDs. Its decorative cursor does not delay execution. Warmup and task timing are separate.

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
npm run verify:general
npm run verify:checkout
npm run benchmark
```

`verify:voice` is a legacy rehearsal script from the earlier single-inference implementation; its post-submission expectations need updating for the current batch tools. `verify:ui` checks the always-visible stats, assistant-ui integration, approval gate, and mobile layout. Artifacts and traces are saved locally under `artifacts/` and ignored by Git, along with `.env` and browser profiles.

`npm run build` followed by `npm start` serves the production frontend. Live tasks require a configured Cerebras API key and model. There is no local inference fallback.


The browser tab strip shows actual open tabs. Click a tab to inspect it; orange outlines indicate live work. After checkout, “What’s next?” opens a follow-up composer in the assistant panel and preserves the current page and conversation. The plus button closes task tabs and starts a new task with one Google tab.
