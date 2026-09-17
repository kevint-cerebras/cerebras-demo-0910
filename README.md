# Cerebras OpenTable and Amazon Demos

A local React + Playwright browser-agent harness with OpenTable reservation and Amazon shopping modes. Both retain the Cerebras interface, with the live browser occupying 75% of the workspace and Cerebras chat occupying 25%.

## Setup

```bash
npm ci
npm run build
```

Copy `.env.example` to `.env`, add the provider keys, and keep `.env` private. OpenTable cookies are stored under the ignored `.browser-profile/opentable-chrome` directory; Amazon uses `.browser-profile/amazon`.

## OpenTable date-night demo

Launch with Cerebras:

```bash
npm run opentable:cerebras
```

The legacy `npm run marketplace:cerebras` command remains as an alias so existing demo scripts continue to work. A Fireworks launcher is also available as `npm run opentable:fireworks`.

Use this prompt:

```text
Use OpenTable to find and book a dinner reservation for 2 people tonight at 6:00 PM at a cute, date-night Italian restaurant in Hayes Valley, San Francisco. Budget ~$30–$50/person; Italian; cute/romantic; Hayes Valley; available around 6:00; no card/deposit/prepayment; closest within 30 min; prioritize well-rated.
```

The harness opens the live Hayes Valley Italian search, gathers restaurant links from that page, and fans them out in batches of eight. Each visible restaurant tab gets an independent Cerebras call that verifies cuisine, neighborhood, price tier, date-night evidence, rating, and live availability. The coordinator ranks exact or nearest-to-6:00 times first and rating second.

The booking stage rejects any flow that requires a card, deposit, prepayment, paid package, or prepaid experience. It can use already-present session details, but it never enters credentials, contact information, card data, or verification codes. It stops on the exact page if login, CAPTCHA, identity verification, or missing contact details require manual action. A final submission is made at most once and is not repeated while confirmation is pending.

## Amazon shopping demo

The Amazon mode searches, inspects product tabs concurrently, adds selected products, verifies the live cart, and returns product links, prices, quantities, and the subtotal. Real ordering remains disabled unless the ignored local environment explicitly sets `AMAZON_PURCHASE_AUTHORIZED=true`.

```bash
npm run amazon:cerebras
```

## Browser presentation

The launcher opens the Cerebras controller at [http://localhost:3100](http://localhost:3100). The browser is embedded in the 75%-width side by default. To explicitly request a separate native window, run with `BROWSER_VIEW=native`.

Do not run two demo commands at once; they share port 3100. The submitted request remains pinned at the top of the assistant panel while the worker tabs run.

## Verification

```bash
npm run build
npm test
```
