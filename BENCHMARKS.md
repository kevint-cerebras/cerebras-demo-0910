# Measured latency

The current demo executes only after submission. Partial-transcript execution is disabled. General browsing is available again through the submitted-request router. Historical speech and Screen Studio results below describe earlier builds. Current submission-only verification is recorded in `artifacts/submission-only-verification.json`; it measured zero partial requests and one model call, with a cart ready in 1,593 ms.

With the general router restored, the submission-only grocery test reached a cart in 1,437 ms with one model call and zero partial requests. Public browsing tests reached the Wikipedia sea otter article and answered the request in 2,345 ms with three calls including routing; example.org completed in 666 ms with two calls. These are individual local runs, not percentile guarantees. Details are in `artifacts/general-verification.json`.

Before restoring the general task router, the 1600 × 900 clip check reached a cart in 1,401 ms with 131 browser actions, one model call, and three pages. Its largest action gap was 54 ms; approval and the compact stats were visible without scrolling. A separate UI run took 2,547 ms, including 1,851 ms of provider prefill, so sub-500 ms action gaps are not guaranteed on every run.

Historical runs below were measured locally on September 9, 2026 with real Cerebras `qwen-3.8-27b` requests and Playwright browser execution. The stores are local sandboxes, so these shopping timings do not represent an external retailer's network or authentication costs.

## Warm shopping runs

Six sequential runs across three prompts reached a completed, verified cart awaiting approval. Every run used one model call and three store pages. Browser searches began before model generation finished.

| Prompt                | Run | Cart ready | Actions | Largest gap between completed actions |
| --------------------- | --- | ---------- | ------- | ------------------------------------- |
| Vegetarian tacos      | 1   | 1,558 ms   | 119     | 192 ms                                |
| Gluten-free breakfast | 1   | 798 ms     | 69      | 72 ms                                 |
| Vegan pasta           | 1   | 874 ms     | 91      | 60 ms                                 |
| Vegetarian tacos      | 2   | 1,452 ms   | 131     | 161 ms                                |
| Gluten-free breakfast | 2   | 729 ms     | 69      | 55 ms                                 |
| Vegan pasta           | 2   | 3,291 ms   | 91      | 2,396 ms                              |

All six finished under five seconds. Five of six kept every completed-action gap below 500 ms. The slow pasta run spent 2,406 ms in provider-reported prefill, 126 ms generating, and about 143 ms in transport/client overhead. Its pause was an inference delay. Later UI checks also showed occasional waits above 500 ms while acquiring a browser session. The 500 ms target is not a guarantee.

Source: `artifacts/benchmark.json` and individual `artifacts/trace-*.json` files.

## Speech-speed transcript tests

A 28-word request arrived one word at a time through injected Web Speech recognition events. The test clicked the actual microphone button, delivered interim results, submitted through the voice control, and asserted the final budget, dietary constraint, delivery slot, and cart.

| Speaking rate    | Transcript to product preview | Submission to cart | End of utterance to cart |
| ---------------- | ----------------------------- | ------------------ | ------------------------ |
| 120 words/minute | 269 to 334 ms                 | 1,066 ms           | 1,153 ms                 |
| 150 words/minute | 274 to 598 ms                 | 794 ms             | 873 ms                   |
| 180 words/minute | 272 to 350 ms                 | 1,075 ms           | 1,145 ms                 |

Each test performed 45 browser actions while speech was arriving, reused 15 cached DOM search results, then completed the cart with 24 additional actions and one model call. The first 150-word/minute preview overlapped another benchmark and browser allocation; the remaining previews were 274 to 289 ms. These tests exclude native microphone and speech-service latency.

For the 180-word/minute run, time to first token was 433 ms, the first executable action arrived at 464 ms, and the observed generation stream lasted 63 ms. Provider timing reported 16 ms prefill, 66 ms generation, and less than 1 ms queue time. The remaining 414 ms was transport and client overhead, not an isolated network measurement. Thinking was disabled.

Source: `artifacts/speech-120wpm.json`, `speech-150wpm.json`, and `speech-180wpm.json`.

## Public browsing and human takeover

A real BBC Good Food recipe lookup completed in 2,584 ms with one model call. In a separate native takeover test, a person-controlled navigation changed the browser from Lisbon to Porto on Wikipedia. The next agent request read the same Porto tab and answered in 920 ms with one model call.

The first full recording rehearsal uncovered a separate transition bug: an adopted shopping tab retained local-only network routing. The code now applies the public-browser resource policy to that tab while preserving private-address restrictions. The original rehearsal video is not a final deliverable because its public-site step failed. That transition check was removed with the general-browsing execution path.

## Measurement boundaries

- Task time begins at server request handling and ends at verified cart readiness, before human approval.
- Warmup reports browser launch and page loading separately. A depleted warm pool can still add acquisition time inside a task.
- Browser navigation includes the wait for the requested DOM readiness condition. DOM extraction and browser action spans are recorded independently.
- Time to first token starts when an inference request begins. Time to first executable action includes enough streamed arguments to dispatch it, which is later than merely seeing a tool name.
- Observed stream duration can be nearly zero when a provider delivers a complete tool call in one chunk. Provider generation timing gives a separate view.
- The transport/client residual includes network transfer, buffering, and parsing. It does not isolate every network hop.
- Action counters include DOM reads, searches, and cart interactions, not just mouse clicks. Speech prework is counted separately from final-run work.
- Concurrent spans overlap. Their sum can exceed elapsed task time. The decorative cursor delay is presentation timing, not browser execution latency.

The functional checks cover dietary substitutions, missing approval, mismatched totals, idempotent checkout, Assistant UI submission and approval, mobile overflow, and page exceptions. Raw results remain in `artifacts/` for inspection.

## Screen Studio recording

The finished editable recording is `artifacts/Dash-demo.screenstudio`. Screen Studio captured the actual Chrome window and live Cerebras execution. The edit is 56 seconds at normal speed, with the setup and stopping footage trimmed and browser controls cropped out.

In this take the cart completed in 1.23 seconds with 107 actions and one model call. The subsequent Wikipedia task completed in 3.63 seconds with three model calls. Source frames at 8, 30, and 60 seconds show the opening, purchase approval, and public-site result without a permission dialog covering them. Screen Studio reopened the edited project and displayed a 56-second clip at 1x.

Export is pending Screen Studio activation. No subscription was purchased. Earlier takes remain as rehearsals; `Dash-demo.screenstudio` is the selected take. Verification details and the source hash are in `artifacts/screen-studio-verification.json`.


## Live batched grocery runs, September 10

Prompt: “Get ingredients for dairy-free vegetarian tacos for four, under $35, delivered tomorrow evening.” Cerebras selected the searches and products. Three warm stores were searched concurrently through DOM forms; cart controls and delivery selection were executed live. No recording or replay was used.

| Run | Verified cart | Final answer | Model calls | Largest action gap |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.661 s | 3.195 s | 3 | 1.247 s |
| 2 | 2.125 s | 2.749 s | 3 | 0.696 s |
| UI | 2.223 s | 3.496 s | 3 | 1.260 s |

All three carts stayed under $35 and selected tomorrow evening. No purchase was submitted. The UI check verified tool activity precedes the final response and the page does not scroll. The 500 ms action-gap target is not consistently met: model calls account for the longest pauses. Inference request totals were 1.846–2.494 s per task; DOM extraction totaled 88–136 ms and preview captures 126–172 ms. Concurrent spans overlap and must not be summed as wall time. Evidence: `artifacts/tacos-batched-1.ndjson`, `artifacts/tacos-batched-2.ndjson`, and `artifacts/tacos-batched-ui.ndjson`.


## Real restaurant sites, September 10

Known-query preparation used four operator-selected official pages: True Food Kitchen Palo Alto, Wildseed Palo Alto menus, Asian Box menus, and Asian Box Palo Alto location. Each page loaded in an independent browser context. Preparation is explicitly shown outside the request timer; no model answer is precomputed.

- Initial live run: 1.475 s preparation, 3.004 s request, 2 model calls.
- UI verification: 1.258 s preparation, 2.977 s request, 2 calls. At least three tabs displayed concurrent activity; menu/location links and ingredient uncertainty were visible.
- Recorded take: 1.341 s preparation, 4.975 s request, 3 calls. The model additionally opened four live pages after submission, including three menu-category pages concurrently. Those navigation spans were about 0.52–0.81 s. The final answer identified a provisional candidate and explicitly left ingredient confirmation unresolved.

The silent 12.64-second recording is `artifacts/recordings/restaurant-live.mp4`, at normal speed. It was fully decoded and visually inspected, including a frame showing three simultaneous orange loading tabs. SHA-256: `da49d7b26a0584f8885c0a981cb6c34da1225894fa981953f6c6e7ea5731ff03`. Trace and provenance are beside the video and excluded from Git.


## No-preload Maps trials

Starting on Google with no prepared query results or restaurant pages, live Maps discovery returned restaurants without a CAPTCHA. It opened place pages and official menus in parallel, but did not finish the ingredient comparison. The initial trial timed out at 45.002 s with 32 model calls. After preserving complete page evidence during conversation compaction and waiting for Maps details to render, a second trial still timed out at 45.016 s with 19 calls. This is not a successful end-to-end benchmark. The full normal-speed second recording is `artifacts/recordings/maps-live-v2.mp4` (52.68 s); its trace and provenance are stored beside it. Browser processes were warm, but no search results or restaurant pages were preloaded.


## Completed live Maps take, no preloading

After removing page preparation and adding an explicit stop-on-first-supported-candidate instruction, the restaurant request completed in 10.305 s with six model calls. Maps discovery, place-page inspection, and official menu reads all occurred after submission. The model returned World Wrapps' Satay Wrapp, which the official menu labels gluten-free, and explicitly asked for confirmation of sauce ingredients. It did not claim guaranteed absence of onion or tomato. This meets the finished-flow requirement but is slightly above the original ten-second task target.

The normal-speed recording is `artifacts/recordings/maps-finished.mp4` (17.84 s, 1600×900). The complete trace is `artifacts/recordings/maps-finished-take1.ndjson`; no model responses, search results, or menus were precomputed. The preload button, banner, dialog, and preparation endpoint have been removed.
