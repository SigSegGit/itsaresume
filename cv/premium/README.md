# itsaresume premium — the paid, multi-account part (demo)

Separate from the local generator: its own server, pages, add-on and tests
(`premium/`). It reuses the generator's pipeline (`src/`) and the A4 page
(`web/cv.*`) without changing them.

## What it does

- **Accounts**: e-mail + password (scrypt), a session cookie for the site, a
  bearer token for the add-on. One JSON file (`--data`), one process.
- **Credits by packs**, cheaper per CV as the pack grows (`pricing.js`). The
  demo's payment is **simulated**: the order is recorded `simulated: true`.
- **Free preview** (3 a day per account): the fit score, the requirements met
  or not, and the CV's shape as line lengths, drawn blurred behind a paywall.
  The tailored text never leaves the server.
- **Paid generation** (1 credit, refunded if it fails): the A4 page with its
  options, printable as PDF.
- **Add-on** (`premium/extension`, Chrome/Edge, load unpacked): on a click,
  reads the user's own LinkedIn profile page into a JSON Resume, or the
  offer shown; sends it with the account's token.

## Run the demo

```powershell
Set-Location D:\GitHub\itsaresume\cv
node premium/server.js --port 18791 --router http://127.0.0.1:18789 --data "$env:USERPROFILE\.itsaresume\premium"
```

Then `http://127.0.0.1:18791`. Preview and generation need the router up.

## Operating costs (worst case per CV, `pricing.js`)

3 calls × 15k input + 3k output tokens (measured on local runs: prompts
≤ 14.5k). Anthropic list prices cached 2026-11-03, per million tokens:

| Model | In / out | Per CV |
|---|---|---|
| claude-opus-5-5 | $4 / $20 | $0.36 |
| claude-sonnet-5-5 | $2 / $10 | $0.18 |
| claude-haiku-5-5 | $0.10 / $0.50 | $0.009 |

Packs (2026-11-19, the owner: an impulse buy): 1 CV €1.49, 5 €4.99, 10
€6.99, 30 €15.99, 50 €24.99, 100 €35.99. Paid model: claude-haiku-5-5.
Margin per CV after card fees (1.5 % + €0.25 per payment), API (worst case)
and hosting (€0.02), in EUR:

| Pack | Per CV | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|---|
| 1 | 1.49 | 1.19 | 1.04 | 0.89 |
| 5 | 1.00 | 0.91 | 0.76 | 0.60 |
| 10 | 0.70 | 0.64 | 0.49 | 0.33 |
| 30 | 0.53 | 0.49 | 0.34 | 0.19 |
| 50 | 0.50 | 0.46 | 0.31 | 0.16 |
| 100 | 0.36 | 0.32 | 0.18 | 0.02 |

The fixed €0.25 card fee is 17 % of the 1-CV pack; everything else is
small. Haiku 5.5 on these prompts is not measured yet: run it on the real
offers (rules-replay) before selling. Prices, fees and the exchange rate
are assumptions to confirm.

## Before going public (not done by the demo)

- **Preview on a personal subscription**: a Claude Pro/Max subscription is
  for its holder's own use; serving other people's previews with it may break
  its terms. For the public service, the preview should use the API (Haiku 5.5
  costs ~$0.01 per run) or the local model.
- **Paid mode**: the demo sends it to the router; production needs an API key
  and an adapter in `server.js` `main()` (the `analyse` dependency).
- **Real payment** (a payment provider's checkout and webhook), invoices, VAT,
  terms of sale, privacy notice (profiles are personal data: retention,
  deletion, export), rate limits, e-mail verification, password reset.
- **LinkedIn**: the add-on reads only the page the user opened, on their
  click, for their own profile; no crawling. LinkedIn's terms forbid
  automated collection: keep it a user's click, and offer LinkedIn's own data
  export (already importable) as the documented path.
