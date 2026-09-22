# gam-verify

Behaviour tests for the Google Ad Manager ad slots. They drive a real Chrome against a
real build and assert on what GPT was actually asked to do, because the things that go
wrong here — a second `display()` being silently ignored, a slot refreshed while
`display: none`, a refresh with no user behind it — are all invisible to a unit test.

Background, root causes and every measurement these cases came from:
[`GAM_AD_REFRESH_ANALYSIS.md`](../../GAM_AD_REFRESH_ANALYSIS.md) and
[`GAM_AD_REFRESH_TODO.md`](../../GAM_AD_REFRESH_TODO.md).

## Running

```bash
npm run build                        # the suite serves dist/, not the dev server
node tools/gam-verify/run.js         # all cases
node tools/gam-verify/run.js mobile  # only cases whose name contains "mobile"
```

Needs Google Chrome installed (it uses `channel: 'chrome'`, so no browser download)
and runs headed — ad code behaves differently headless.

Exit code is non-zero if any case reports REVIEW.

## What it does and does not touch

Content comes from the **production** WordPress backend, because the staging host
(`nepaper.dailysangram.com`) does not answer. That is deliberate but bounded:

- `dist/` is served locally, so the code under test is always your build.
- `GET /ads/config` is answered from [`fixtures/ads-config.json`](fixtures/ads-config.json),
  so admin state cannot change a verdict.
- **Any non-GET to `/ads/config` is aborted.** Nothing is ever written to the live site.
- **Ad requests are answered locally by default**, so a run costs no live impressions.
  Pass `noBill: false` on a case that genuinely needs a real creative — that spends real
  impressions on the publisher's network, so only do it deliberately.
- Because those local answers are empty, **every slot renders no-fill in every run**. The
  fixture therefore sets `no_fill_retries: 0`: with the production default of 2, the
  §8.2 retry would fire for every slot in every case and no case could assert a refresh
  count again. `no-fill-retry` turns the budget back on for itself, which is also what
  makes that case deterministic — the one place the harness's permanent no-fill is the
  point rather than a nuisance.

Note that dev `wpBaseUrl` points at production too, so `ng serve` and the local admin
panel already edit the live site. Unrelated to this suite, but worth knowing.

**Which backend a run talks to** is whatever the build baked in, because the suite serves
`dist/`. `npm run build` uses `environment.prod.ts` → `epaper.dailysangram.com`, so a
default run reads content from **production**, not staging. Build with
`--configuration staging` first if you want a run to read from `nepaper` instead.
(`src/app/config.ts`'s header comment claims the production build points at `nepaper`;
`environment.prod.ts` says `epaper`. The environment file is the one that takes effect.)

## Measuring fill

`run.js` can never measure fill — it answers every ad request locally. When the question is
"do these slots actually get creatives", use:

```bash
node tools/gam-verify/measure-fill.js --spend-impressions [opens]
    --legacy-top-sizes   # Post_Top on its pre-§8.4 sizes, for an A/B
    --no-preview         # right-panel slots off, to test contention
```

**It bills real impressions to the publisher's network** — hence the mandatory flag, and why
it is not a case and not in `CASES`. It reports per-slot renders, fills and creative sizes
from `slotRenderEnded`. See §8.6 for what the first three runs found.

## Verdicts

- **PASS** / **REVIEW** — as expected, or not.
- **INCONCLUSIVE (environment)** — the app booted with no content, i.e. the backend was
  unreachable. Not a failure, and must not be read as one. Re-run the case alone.

Fill is **not** deterministic: whether GAM returns a creative varies run to run and some
units have no inventory booked at all. No case asserts that an ad filled — they assert on
lifecycle (defined / displayed / refreshed / destroyed / visible), which is what this
codebase controls.

That distinction matters most for the modal. `modal-reopen` proves the slot is re-created and
re-fetched on every open, which is the defect RC-3 described. It does **not** prove an ad
appears: `desktop_post_top_image` and `mobile_post_top` sit on units that return empty far
more often than the rest, however correct the lifecycle is. See §1.7 and Phase 8 — that half
is a GAM inventory task, not a code one. What the code owns is what happens *after* an empty
response, and `no-fill-retry` asserts that.

## Cases

| Case | Asserts |
|---|---|
| `ads-off` | Ads off in admin is a complete kill switch: no `gpt.js`, no slots, no requests, layout intact |
| `pagination` | Each page change refreshes the persistent right-rail slot exactly once |
| `burst` | Six rapid clicks coalesce into at most one refresh |
| `hidden-tab` | `document.hidden` suppresses refresh entirely (GAM policy) |
| `mobile-placement` | The two mobile slots are the only ones **placed** on mobile, once each, no duplicate divs. "Placed" means visible with the §8.1 no-fill collapse lifted — see `PLACEMENT` |
| `mobile-no-refresh` | A hidden slot is never refreshed |
| `no-hidden-define` | A slot the viewport cannot show is never defined or fetched |
| `poll-gate` | The 5-minute content poll does **not** refresh ads — no user action, no refresh |
| `deferred-refresh` | A navigation blocked by the 5 s floor is **held and fired**, not discarded |
| `mobile-toggle` | The modal's mobile image/text toggle refreshes `mobile_post_top`, and leaves the now-hidden `mobile_post_middle` alone |
| `modal-reopen` | RC-3: opening an article, closing it and opening another defines, displays **and destroys** each time, and every open costs a real ad request |
| `no-fill-retry` | §8.1/§8.2: an empty response collapses the slot to zero height, retries exactly as many times as `/ads/config` allows, spaced not bursted, then stops |

`poll-gate` waits out the real 300 s poll, so it takes about six minutes. It also asserts
that the poll actually fired and reloaded, so it cannot pass by the poll never running.
`no-fill-retry` waits out both retry backoffs and takes about a minute.

## Adding a case

Add a function to `run.js` and an entry in `CASES`. Use `boot()` for a loaded app and
`report(name, pass, extra)` for the verdict. Two rules worth keeping:

- **Assert, don't just print.** A number that is logged but not compared is not a test —
  a real container-height defect was nearly missed that way.
- **Write the failing measurement first.** Every case here was confirmed to REVIEW before
  its fix and PASS after; otherwise you cannot tell a working test from a vacuous one.
