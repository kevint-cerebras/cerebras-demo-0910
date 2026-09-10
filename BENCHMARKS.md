# Measured latency

Measured locally on September 9, 2026 with real Cerebras `qwen-3.8-27b` requests and Playwright browser execution. The stores are local sandboxes, so these shopping timings do not represent an external retailer's network or authentication costs.

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

The first full recording rehearsal uncovered a separate transition bug: an adopted shopping tab retained local-only network routing. The code now applies the public-browser resource policy to that tab while preserving private-address restrictions. The original rehearsal video is not a final deliverable because its public-site step failed. The transition has its own regression check in `scripts/verify-browser-transition.ts`.

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

## Screen Studio rehearsal

The live Screen Studio take completed the shopping request in 1.43 seconds with 130 actions and one model call. The public Wikipedia task then completed in 3.93 seconds with three model calls. The editable project is saved in `artifacts/Dash - live browser assistant.screenstudio`.

Frame inspection found a macOS recording-permission dialog covering the captured display. This take is a rehearsal, not a finished video. A clean retake requires the user to clear that dialog. Screen Studio export also requires an active license; no subscription was purchased.
