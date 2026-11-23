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

## Markets (6.4b, 6.7)

Four markets (6.7, the owner, 2026-11-20): EUR and CHF in French, GBP and
USD in English. One grid per currency: EUR price × exchange rate × market
factor, cut to a charm price (.49/.99). The visitor's language picks the
market (en-GB → GBP, fr-CH → CHF, any other English → USD, the rest → EUR),
a selector changes it. Rates are assumptions of 2026-11.

| | 1 | 5 | 10 | 30 | 50 | 100 |
|---|---|---|---|---|---|---|
| EUR | 1.49 | 4.99 | 6.99 | 15.99 | 24.99 | 35.99 |
| GBP | 0.99 | 3.99 | 5.99 | 13.49 | 21.49 | 30.99 |
| USD | 1.49 | 5.49 | 7.99 | 18.49 | 28.49 | 41.49 |
| CHF | 1.49 | 4.99 | 6.99 | 16.49 | 25.49 | 36.99 |

Checkout: `/checkout.html` (summary, terms box, simulated payment, receipt).

## Personal data (6.4c)

`/privacy.html` (a draft to have checked), accepted at registration (its
version recorded). "My data": export everything as JSON, delete the
profile, delete the account (password asked again). Retention applied by a
daily purge: sessions 30 days, CVs 12 months, accounts without login 24
months, orders 10 years without the address once the account is erased. No
card is ever stored here: a saved card stays at the payment provider.

## Paid features and recovery (6.4d)

- Saving a profile needs a purchase (402 with the market's packs); a visitor
  previews free with a profile sent along, never stored.
- Profile chat: 20 messages with the first pack, then 1 credit = 20
  messages. It suggests and asks; it never writes the profile.
- Password recovery: a one-time link by mail, valid an hour; it closes the
  old sessions; the same answer whether the address exists or not.
- Contact on the privacy page: `--contact` or `PREMIUM_CONTACT`.
- `test/premium-e2e.test.js` runs a whole customer journey in CI.

## Database (6.4f)

SQLite through Node's own `node:sqlite` (Node 22.13+), no dependency: one
file, `premium.db`, in the premium container's data folder. Tables: users,
sessions, resets, orders, jobs, chat. `secure_delete` so an erased account
leaves no trace in the file. Every hour a consistent snapshot (`VACUUM
INTO`) goes to `snapshots/`, the last 48 kept: sync those (ITSaNAS, 6.4g),
never the live file, which a copy can catch half-written.

**Off the machine (6.4g)**: `deploy/vm-generator/itsanas-premium.sh`, run on
the VM, gives the snapshots folder an ITSaNAS account of its own
(`itsaresume`, port 9800); the owner types its passphrase and keeps its 24
words. On any other machine of that account,
`node premium/restore-check.js <premium-*.db> [premium.db]` opens a copy,
runs SQLite's integrity check and compares the counts.

## Admin (6.8)

`admin.html`: counts per table and integrity, revenue per currency, the
snapshots (the newest opened and checked), the accounts (searchable; never a
hash, salt or profile), credit changes (a reason required, never below
zero, each one in `admin_log`). Admins are the addresses in
`PREMIUM_ADMINS` (comma-separated, in `$DATA/.env` on the VM, never in the
repository); with none, nobody is one. Their API answers 401 without a
session, 403 to anyone else.

## Attempts limited (6.9)

`limits.js`, in memory (a restart forgets: one window more at worst): 5
failed logins per address and 30 per network address in 15 minutes (then
even the right password waits, with `Retry-After`); 3 recovery mails per
address and 10 per network address an hour (unknown addresses alike: no
oracle); 5 new accounts per network address an hour. The network address is
the socket's, or, from the machine itself (Caddy), the entry the proxy
appended to `X-Forwarded-For`. The server's messages are English; a French
page shows them in French (`i18n.serverText`).

## Address confirmed (6.10)

Sign-up mails a one-time link (`#verify=…`, a day); until it is followed,
buying and generating answer 403 "confirm your e-mail address first" and the
account page shows a banner with "send the link again" (3 an hour). An
erased account's links go with it, so an address signed up again is never
confirmed by an old link. On by itself once a real mailer is set (below;
`PREMIUM_REQUIRE_VERIFIED=0` turns it off, `=1` forces it): the demo's
mailer only writes the links to the console and the outbox, and would lock
every visitor out.

### Mail (6.11)

`premium/smtp.js`, no dependency. In `$DATA/.env`, never the repository:

```
PREMIUM_SMTP_URL=smtps://user%40example.org:password@smtp.example.org:465
PREMIUM_MAIL_FROM=itsaresume <noreply@example.org>
```

`smtps://` is TLS from the start (465); `smtp://` (587) must offer STARTTLS
before the password is sent, unless the relay is on this machine
(127.0.0.1, localhost). One plain-text UTF-8 mail per link; an address with
a line break is refused, the subject is encoded. Unset: the demo outbox.

## Languages (6.7)

French and English on every page (`web/i18n.js`, shared with the generator):
`?lang=en|fr`, then the stored choice, then the browser; French by default.
The English privacy notice says the French one prevails.

## Before going public (not done by the demo)

- **Preview on a personal subscription**: a Claude Pro/Max subscription is
  for its holder's own use; serving other people's previews with it may break
  its terms. For the public service, the preview should use the API (Haiku 5.5
  costs ~$0.01 per run) or the local model.
- **Paid mode**: the demo sends it to the router; production needs an API key
  and an adapter in `server.js` `main()` (the `analyse` dependency).
- **Real payment** (a payment provider's checkout and webhook), invoices, VAT,
  terms of sale, the SMTP account (6.11, which turns the address check on) (privacy
  notice, export, deletion, retention, password reset, rate limits and the
  address confirmation are done: 6.4c, 6.4d, 6.9, 6.10).
- **LinkedIn**: the add-on reads only the page the user opened, on their
  click, for their own profile; no crawling. LinkedIn's terms forbid
  automated collection: keep it a user's click, and offer LinkedIn's own data
  export (already importable) as the documented path.
