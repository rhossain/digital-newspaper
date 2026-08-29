# GAM Ad Refresh — Sequential Implementation TODO

**Date:** 2026-08-29
**Companion document:** [GAM_AD_REFRESH_ANALYSIS.md](GAM_AD_REFRESH_ANALYSIS.md) (diagnosis, root causes RC-1 … RC-10)
**Branch:** `daily-sangram`
**Guiding constraint:** no existing feature, functionality, or UI may change. Ads are the
only observable behaviour that should differ.

---

## How to use this document

Phases are **strictly sequential** — each one leaves the app in a shippable state, and each
depends on the previous. Do not start Phase 2 before Phase 1's regression checklist passes.

Within a phase, steps are ordered so the code compiles at every step where possible.

Legend:
- `[ ]` task
- **Must not break** — the specific existing behaviour this step is most likely to regress
- **Verify** — the concrete check that proves it didn't

---

## Pre-flight: four corrections to the analysis document

Corrections 1–2 were verified during implementation planning; corrections 3–4 came out of the
live browser measurement in step 0.3. All four **strengthen** the case for the plan but change
the details, so record them before starting.

### Correction 1 — `selectPage()` is the single choke point for all page navigation

Every page navigation funnels through one method. Confirmed call sites of
`onPageClick()` ([`newspaper.component.ts:781`](src/app/newspaper.component.ts#L781)):
the prev button, every pagination number button, the next button
([`newspaper.component.html:569-602`](src/app/newspaper.component.html#L569-L602)), and every
thumbnail ([`newspaper.component.html:387`](src/app/newspaper.component.html#L387)). All call
`selectPage()` ([`newspaper.component.ts:825`](src/app/newspaper.component.ts#L825)), which is
also called directly on initial load (lines 630, 635), deep-link resolution (line 691), and
linked-section jumps (line 1843).

**Impact:** the trigger surface is **2 methods, not 7** — `selectPage()` and
`selectSection()`. This is simpler and much less likely to miss a path.

### Correction 2 — the preview slots *are* destroyed on thumbnail/pagination clicks

The analysis document's lifecycle table says `desktop_post_preview_top` / `_middle`
"survive article and page switches." That is only true when navigating **with** a target
section. `selectPage(page)` called with **no** `targetSectionId` — which is exactly what
`onPageClick()` does — sets `selectedSection = null`
([`newspaper.component.ts:855-870`](src/app/newspaper.component.ts#L855-L870)), which
destroys the `@if (selectedSection)` block.

Corrected behaviour per scenario:

| User action | `desktop_page_left` | `desktop_post_preview_*` | `desktop_page_right` |
|---|---|---|---|
| Thumbnail / pagination click | persists → **frozen** (RC-1/2) | **unmounted**, then remounted on next article select → **blank forever** (RC-3) | **mounted** → blank after first cycle (RC-3) |
| Center-panel article select (same page) | persists → **frozen** (RC-1/2) | persists → **frozen** (RC-1/2) | unmounted |
| Linked-section jump | persists → **frozen** | persists → **frozen** | unmounted |

**Impact:** Scenario 1 and Scenario 2 are affected by **both** failure modes, not just the
frozen-ad one. Phase 1 (lifecycle) is therefore not optional groundwork — it fixes real,
currently-lost impressions on the two most common navigation paths.

### Correction 3 — SRA is enabled, and `AdService._initGpt` is its **only** owner in the SPA

The measurement showed `setConfig({ singleRequest: true })` is active in production. My first
attribution of that to the PHP head script was **wrong**, and the distinction is load-bearing:

[`inject_gam_head_script`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L704-L735)
runs on `wp_head`, which **never fires in this headless SPA** — exactly as
[`ad.service.ts:108-118`](src/app/services/ad.service.ts#L108-L118) documents. The PHP is live
only for WordPress-rendered pages under `/wp`. In the Angular app, SRA comes from
[`ad.service.ts:166-167`](src/app/services/ad.service.ts#L166-L167).

`grep -rn 'googletag|securepubads|gpt\.js' src` confirms `_initGpt` is the sole GPT bootstrap.
Three consequences:

- **`_bootGpt()` must keep `setConfig({ singleRequest: true })` and `enableServices()`.**
  Nothing else supplies them. Dropping them would break every slot. Only the `defineSlot`
  loop moves out.
- **There is no duplicate-div-id hazard.** Because `_initGpt` is the only definer today, once
  its `defineSlot` loop is removed the component becomes the *sole* definer. Step 1.1.3 can
  call `defineSlot` unconditionally — no need to adopt pre-existing head-defined slots.
- **`refresh()` must always be called with an explicit slot array** — `pubads().refresh([slot])`,
  never a bare `pubads().refresh()`. Under SRA a bare call re-requests every defined slot,
  which on mobile would re-request the four hidden desktop slots and multiply the RC-8 waste.

**The `collapseEmptyDivs(false)` call proposed in step 1.2.2 was deliberately dropped from
Phase 1.** It is not the no-op it looks like: per the GPT API, `collapseEmptyDivs(false)`
*enables* collapsing after an empty ad response (only the `true` variant collapses *before*
fetch). Adding it would therefore collapse slots that currently hold reserved space — a real
layout change, and one that would have shifted the Phase 1 before/after baseline. Collapse
behaviour is evaluated deliberately in Phase 4 instead.

### Correction 4 — an anchor unit exists that this repo does not manage; exclude it

Production serves `TDSEV2_Bottom_Anchor` (desktop) and `TDSEV2_Mobile_Bottom_Anchor` (mobile).
These are on the **V2** ad-unit path, are absent from `gam_ad_slots()`, and `grep -rniE
'anchor|TDSEV2'` over `wordpress-plugin/` and `src/` returns nothing — so they come from
GAM-side configuration or another script on the WordPress site, not from this codebase.

- **The `GamService` registry must skip out-of-page/anchor slots.** Anchors manage their own
  lifecycle; refreshing them is not supported the same way. Filter on
  `getSlotElementId().startsWith('gpt_unit_')` or, better, only ever refresh slots the
  registry itself registered — which the Phase 1 design already does by construction.
- **Separately, flag to the GAM network owner:** GPT logs
  `Anchor ... not requested: Format already created on the page` **twice** per load, meaning
  the anchor is being created twice and one creation is discarded. That is a pre-existing
  server/GAM-config issue, out of scope for these phases, but worth reporting.

### New finding — RC-10: `MutationObserver` leaks on every modal close

[`AdSlotComponent`](src/app/components/ad-slot/ad-slot.component.ts) has **no `ngOnDestroy`
at all**. `_cleanupObserver` ([line 87](src/app/components/ad-slot/ad-slot.component.ts#L87))
is only invoked from inside the `effect()`, never on teardown. Every modal open/close cycle
leaks one live `MutationObserver` bound to a detached DOM node. Phase 1 fixes this as a side
effect of adding proper teardown.

---

## Phase 0 — Safety net (do this first, no production code changes)

- [x] **0.1** Confirm a clean working tree before starting.
  **Done —** working tree was already clean. The dependency changes were committed separately
  as `33aa7a2e` ("chore: upgrade Angular dependencies to version 21.1.3"), so the ad work
  lands as an isolated, revertible changeset as intended.

- [x] **0.2** Create a working branch off `daily-sangram`.
  ```
  git checkout -b fix/gam-ad-refresh
  ```
  **Done —** on `fix/gam-ad-refresh`, branched from `33aa7a2e`.

- [x] **0.3** Record the current baseline so regressions are detectable.
  **Done — captured 2026-08-29** by driving real Chrome against production with Playwright.
  Full results in [Appendix A of the analysis](GAM_AD_REFRESH_ANALYSIS.md#appendix-a--empirical-verification-live-site).
  Baseline numbers Phase 1 and Phase 2 must be compared against:

  | Metric (production, pre-fix) | Value |
  |---|---|
  | `pubads().refresh()` calls, all interactions | **0** |
  | `destroySlots()` calls | **0** |
  | Ad requests after pagination click | **no change** (8 → 8 → 8) |
  | Ad requests after 2nd article select | **no change** (10 → 10) |
  | Ad requests after modal reopen #2 and #3 | **no change** (11 → 11 → 11) |
  | `display()` calls on modal reopen | 5 → 7 → 9 (fire, but are silent no-ops) |
  | `Desktop_Post_Middle` on modal open #1 | `iframes=1`, 300x266 — filled |
  | `Desktop_Post_Middle` on modal opens #2 / #3 | `iframes=0`, 300x60 — **blank** |
  | Slots filled on desktop first load | 3 of 10 |
  | Desktop slots `display()`-ed on a 390px mobile viewport | **4**, all at `display:none` / `0x0` |

  Two plan-affecting discoveries came out of this — see **Corrections 3 and 4** below.

- [x] **0.4** Confirm the kill switch works.
  **It did not.** See **RC-11** below — the global toggle left five of seven slots rendering.
  Closed in 0.6; the admin **GAM off** toggle is now a complete rollback path, and no new
  feature flag is needed.

- [x] **0.5** Note the two GPT globals rule for the whole task: every new `googletag` access
  must go through `googletag.cmd.push(...)` and must be wrapped in
  `isPlatformBrowser(this.platformId)`.
  **Confirmed:** [`angular.json`](angular.json) declares `"ssr": { "entry": "src/server.ts" }`
  and emits a `server/` bundle, so `npm run build` compiles for the server. An unguarded
  `window` reference fails there, not in `ng serve`.

- [x] **0.6** Establish a green baseline build, then close RC-11.
  - Baseline `npm run build`: **exit 0**, 13.9 s, initial total **596.71 kB** raw /
    146.79 kB transfer — comfortably under the 750 kB warning and 1 MB error budgets. Server
    bundles emitted. Use these numbers to detect bundle regressions in later phases.
  - RC-11 fix applied to
    [`ad-slot.component.ts`](src/app/components/ad-slot/ad-slot.component.ts): the `slot`
    computed now returns `undefined` when `adService.enabled()` is false. Re-verified:
    **build exit 0**, 11.2 s.

### RC-11 — the global GAM toggle was not a complete kill switch *(found and fixed in Phase 0)*

`OPTION_GAM_ENABLED` (global) and `OPTION_GAM_SLOT_STATES` (per-slot) are persisted and
updated **independently** by
[`update_ads_config`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L3303-L3320),
and [`saveAdManagerSettings()`](src/app/admin/admin.component.ts#L4292) passes per-slot states
through untouched. Turning GAM off globally therefore leaves every per-slot flag as it was.

`AdSlotComponent` gated rendering on `slot()!.enabled` — the per-slot flag only — and never
consulted `adService.enabled()`. Only `desktop_page_left` and `desktop_page_right` had a
global-aware `slotEnabledMap()` gate in their parent template. The other five (both preview
slots, all three modal slots) had none, so with GAM off globally they still rendered reserved
empty divs and threw `ReferenceError: googletag is not defined`.

**Why this had to be fixed before Phase 1:** every later phase's rollback plan is "turn GAM
off in admin." That path had to actually work before starting a refactor of ad loading.

**Fix:** one computed, gating on the global flag. Both the template `@if` and the
`dn-ad--hidden` host binding derive from `slot()`, so a single change covers both.
Zero behaviour change when ads are enabled.

**Verify:** with GAM off globally but per-slot toggles left **on**, confirm no empty ad gaps and
no `googletag is not defined` errors in the console.

**Do not test this by toggling the live admin panel.** Dev `environment.wpBaseUrl` points at
production (`https://epaper.dailysangram.com/wp`), so the local admin panel writes to the live
site and would disable ads for real visitors. Simulate it instead: temporarily add
`this._enabled.set(false);` immediately after the existing `this._enabled.set(res.enabled === true);`
in `AdService._fetch()`, run `npm start`, check, then revert (`git diff` on the file must come
back empty).

---

## Phase 1 — Correct the slot lifecycle (fixes RC-3, RC-4, RC-9, RC-10)

**Goal:** every container's DOM lifetime is paired 1:1 with a `defineSlot` + `display`, and
`destroySlots` runs on teardown. After this phase, modal ads fill on **every** open instead
of only the first, and no refresh logic exists yet.

**Why first:** this recovers impressions being lost today, and it is a prerequisite for
Phase 2 (refreshing a slot whose GPT state is stale would paint into a detached node).

### 1.1 Create the slot registry service

- [x] **1.1.1** Create `src/app/services/gam.service.ts` as a new
  `@Injectable({ providedIn: 'root' })` service. Follow the conventions already used in
  [`ad.service.ts`](src/app/services/ad.service.ts): `inject()` for DI, `PLATFORM_ID` +
  `isPlatformBrowser` guards, `DOCUMENT` rather than the global `document`.

- [x] **1.1.2** Define the internal record type and the registry map:
  ```ts
  interface LiveSlot {
    id: string;
    gptSlot: googletag.Slot;
    el: HTMLElement;
    lastRefreshedAt: number;
  }

  private readonly live = new Map<string, LiveSlot>();
  ```

- [x] **1.1.3** Implement `register(def: AdSlot, el: HTMLElement): void`.
  - Guard on `isPlatformBrowser`.
  - If `this.live.has(def.id)`, return early — a double registration is a bug, not a
    recoverable state. Log via `console.warn` in dev only.
  - Inside `googletag.cmd.push(() => { ... })`: `defineSlot(def.unit, def.sizes, def.div)`,
    bail if it returns `null` (duplicate div id — see 1.1.6), `addService(pubads())`,
    store in `live` with `lastRefreshedAt: Date.now()`, then `display(def.div)`.
  - **Order matters:** `display()` must be the last call, after the slot is in the map, so a
    `slotRenderEnded` listener firing synchronously can find it.

- [x] **1.1.4** Implement `unregister(id: string): void`.
  - Delete from `live` **before** the `cmd.push`, so a remount during the same tick cannot
    see a stale entry.
  - Inside `cmd.push`: `googletag.destroySlots([entry.gptSlot])`.

- [x] **1.1.5** Do **not** add refresh, targeting, or debounce logic in this phase. Keep the
  diff reviewable. Phase 2 extends this same service.

- [x] **1.1.6** Add a dev-only guard for the `defineSlot` → `null` case (the duplicate-div-id
  failure that previously forced the `desktop_post_top` → `_image` / `_text` split, see
  [`digital-newspaper.php:639-644`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L639-L644)).
  Gate it behind Angular's `isDevMode()` so production stays silent.

### 1.2 Slim down `AdService` to bootstrap only

- [x] **1.2.1** In [`ad.service.ts`](src/app/services/ad.service.ts), replace `_initGpt(slots)`
  ([lines 136-171](src/app/services/ad.service.ts#L136-L171)) with a `_bootGpt()` that takes
  **no arguments** and does not build any `defineSlot` strings.
  - **This removes the string-interpolation injection surface (RC-9) entirely.** No
    server-supplied value is ever concatenated into executable JS again.

- [x] **1.2.2** In `_bootGpt()`, append the `gpt.js` library tag exactly as today (async,
  `crossOrigin = 'anonymous'`, same `GPT_SRC`), then configure and enable services via a
  real function — **not** an injected `<script>` element. **Implemented without the
  `collapseEmptyDivs(false)` line** shown below — see Correction 3 for why:
  ```ts
  const w = window as any;
  w.googletag = w.googletag || { cmd: [] };
  w.googletag.cmd.push(() => {
    const pubads = w.googletag.pubads();
    pubads.collapseEmptyDivs(false);
    w.googletag.enableServices();
  });
  ```
  - Keep the `_gptInitialized` idempotence guard; rename to `_gptBooted` for accuracy.
  - **Do not add `enableLazyLoad` yet** — it changes *when* ads fetch, which would confound
    Phase 1's regression testing. It is Phase 4.

- [x] **1.2.3** Update the call site in `_fetch()`
  ([`ad.service.ts:244-246`](src/app/services/ad.service.ts#L244-L246)) to call `_bootGpt()`.
  - **Keep the `res.enabled === true && slots.length > 0` condition unchanged** so GPT is
    still never loaded when ads are off.

- [x] **1.2.4** Update the class JSDoc block
  ([lines 106-135](src/app/services/ad.service.ts#L106-L135)) — it documents the old
  `defineSlot`-in-head behaviour in detail and will be actively misleading otherwise. This
  codebase comments the *why* heavily; match that density and explain why slot definition
  moved to the component.

- [x] **1.2.5** Leave `setEnabled()`, `getSlot()`, `slotEnabledMap`, `ready`, `enabled`, and
  `slots` **untouched**.
  **Must not break:** the admin GAM panel reads all of these
  ([`admin.component.ts:4243-4300`](src/app/admin/admin.component.ts#L4243-L4300)).
  **Verify:** admin ad-manager form still loads, toggles, and saves.

- [x] **1.2.6** ~~Decide on `setConfig({ singleRequest: true })`.~~ **Decided by measurement —
  SRA stays, and `_bootGpt()` must keep owning it.** See **Correction 3**: `_initGpt` is the
  only GPT bootstrap in the SPA, so `setConfig({ singleRequest: true })` and `enableServices()`
  must survive the rewrite — only the `defineSlot` loop moves to the component. Order inside the
  `cmd.push`: `collapseEmptyDivs(false)` → `setConfig` → `enableServices()` last.
  The binding constraint this places on Phase 2: always call `pubads().refresh([slot])` with an
  explicit array, never a bare `refresh()`.

### 1.3 Rewrite `AdSlotComponent`'s lifecycle

- [x] **1.3.1** Inject `GamService` alongside the existing `AdService`.

- [x] **1.3.2** Replace the `_scriptInjected` flag and the injected `<script>` element
  ([`ad-slot.component.ts:84`](src/app/components/ad-slot/ad-slot.component.ts#L84),
  [`134-137`](src/app/components/ad-slot/ad-slot.component.ts#L134-L137)) with
  `gam.register(slot, container.nativeElement)`.
  - Keep the existing `effect()` structure and the `viewChild` signal — it already resolves at
    exactly the right moment (when Angular commits the div), and that timing is correct and
    hard-won. Change only *what* runs inside it.
  - Track a `_registeredId: string | null` instead of a boolean, so teardown knows which id
    to unregister.

- [x] **1.3.3** Handle the disabled/unavailable branch
  ([lines 111-116](src/app/components/ad-slot/ad-slot.component.ts#L111-L116)): when
  `!slot || !slot.enabled`, call `gam.unregister(_registeredId)` if set, then clear
  `_registeredId`, reset `removedByBrowser`, and run `_cleanupObserver`.
  **Must not break:** toggling a single slot off in the admin panel must still hide it
  immediately, and toggling it back on must show a **fresh** ad.
  **Verify:** toggle `desktop_page_right` off → on in admin; the slot fills again without a
  page reload (this never worked before — it is a bonus fix, not a regression risk).

- [x] **1.3.4** Add `ngOnDestroy()` and `implements OnDestroy` — **fixes RC-10**:
  ```ts
  ngOnDestroy(): void {
    this._cleanupObserver?.();
    if (this._registeredId) this.gam.unregister(this._registeredId);
  }
  ```
  **Must not break:** closing a modal must not throw. `unregister` is a no-op for an unknown
  id by design.

- [x] **1.3.5** Leave the template
  ([`ad-slot.component.html`](src/app/components/ad-slot/ad-slot.component.html)) and the CSS
  ([`ad-slot.component.css`](src/app/components/ad-slot/ad-slot.component.css)) **completely
  unchanged** in this phase.
  **Must not break:** the `min-width` / `min-height` bindings and the
  desktop/mobile visibility classes are the only thing preventing layout shift today.

- [x] **1.3.6** Leave `_observeForHeavyAdRemoval` logic unchanged for now. Its re-arming
  problem (RC-7) is Phase 3, and it is not a *new* bug introduced here.

### 1.4 Phase 1 measured result

Verified 2026-08-29 by loading the **production origin** in real Chrome while intercepting
requests for the app's own JS/HTML and fulfilling them from the local `dist/` build. This keeps
the WordPress API, CORS, and live GAM ad serving identical to production, so the code change is
the only variable.

> Two local-only routes were **not** usable and are worth knowing about:
> `npm start` fails with a pre-existing `NG0401: Missing Platform` SSR error in
> [`main.server.ts:11`](src/main.server.ts#L11) (unrelated to ads — nothing in the bootstrap path
> was touched), and serving the build from `localhost` is blocked because the app sends an
> `X-Requested-With` header that the live WordPress `Access-Control-Allow-Headers` does not permit.

| Metric | Baseline (prod, pre-fix) | Phase 1 | |
|---|---|---|---|
| `destroySlots()` calls over 3 modal cycles | **0** | **1 → 3 → 5 → 7 → 9** | fixed |
| Ad requests on modal open #1 / #2 / #3 | 11 / **11** / **11** | 20 / **24** / **28** | fixed |
| `Desktop_Post_Middle` on modal open #1 | `iframes=1`, 300x266 | `iframes=1`, 300x266 | unchanged |
| `Desktop_Post_Middle` on modal open #2 | `iframes=0`, 300x60 (**blank**) | **`iframes=1`, 300x266 (filled)** | **fixed** |
| `Desktop_Post_Middle` on modal open #3 | `iframes=0`, 300x60 (**blank**) | **`iframes=1`, 300x266 (filled)** | **fixed** |
| GPT slots defined at initial load | 10 (all, up front) | **2** (only mounted ones) | improved |
| `refresh()` calls | 0 | 0 | Phase 2 |

**The headline fix holds: the modal ad now fills on every open instead of only the first.**
Slot count rises to 5 while the modal is open and falls back to 3 on close, confirming the
define/destroy pairing is 1:1.

Two secondary observations:

- **Bonus fix:** pagination now issues fresh ad requests too (28 → 31), because
  `desktop_page_right` remounting no longer produces a permanently blank slot. This is the
  remount path being repaired, **not** refresh — `refresh()` is still 0, as intended for
  this phase.
- **`Desktop_Post_Top` still returns empty on repeat opens** despite being correctly destroyed
  and re-requested each cycle. Since the request now fires, this is GAM-side (no creative
  available or frequency capping for that unit), not a lifecycle defect. It was blank on open
  #1 in production too. Raise with the GAM network owner rather than treating it as a code bug.
- **RC-8 is unchanged by this phase**, as expected: the desktop containers still mount on mobile
  (hidden by CSS) and therefore still register and request. That is Phase 2 / Phase 5 work.

No console errors attributable to the app; the only page error was a benign
`Attestation check for Shared Storage on googleadservices.com failed` from Google's own tag.

**UI regression check.** Element counts before/after are structurally identical — left rail
present, one `app-ad-slot` on load rising to two after selecting a section. Raw thumbnail and
pagination counts differed between the two runs (15 vs 12) purely because production served a
**stale SSR page for edition 2026-08-05** while the local build resolved the current edition
2026-08-29; the two runs were looking at different newspapers, not different layouts.

### 1.5 Phase 1 regression checklist

Test with ads **enabled** in admin, on desktop (≥768 px) unless noted.

- [x] Fresh load: left rail, and either the right ad or the placeholder, render as before.
- [x] Thumbnail list still appears when `desktop_page_left` is **disabled**
      ([`newspaper.component.html:368-371`](src/app/newspaper.component.html#L368-L371)).
      *`desktop_page_left` is disabled in the live config, and 12 thumbnails still render.*
- [x] Lazy thumbnail loading via `IntersectionObserver` still works (scroll the left panel).
- [x] Click a section in the center panel → right panel opens, preview ads fill.
      *`desktop_post_preview_middle` fills (1 iframe, 554×266). `desktop_post_preview_top`
      holds its reserved 554×100 but returns an empty fill — the same GAM-side inventory
      issue recorded in §1.4, not a lifecycle defect.*
- [x] **Key fix:** open the image modal, close it, open it again → **the modal ad fills on
      the second and third open.** This is the headline verification for Phase 1.
- [x] **Key fix:** open the right panel, close it (click a thumbnail) → `desktop_page_right`
      fills again.
- [x] Content modal (text) ad **is re-requested** on repeat opens (lifecycle correct: +1 ad
      request per open, where the baseline was frozen). It does **not** fill — but it never
      filled, including on the first open, so this is not a Phase 1 regression. Cause is a
      GAM inventory gap, not code: see §1.7.
- [x] **Do not** rely on the console to detect duplicate-`display()` failures — per
      **Correction 3** / Appendix A.5, current GPT swallows them silently with no warning.
      Verify by **counting network requests to `securepubads` instead**: opening the modal on
      three different articles must produce **three** new ad requests, where the pre-fix
      baseline produced **one** (11 → 11 → 11).
- [x] No `MutationObserver` growth after 10 modal open/close cycles.
      *Measured by instrumenting `MutationObserver` directly rather than reading the DevTools
      Memory panel — see T3 below.*
- [x] Turn GAM **off** in admin → all ad space collapses, thumbnails/placeholder return, no
      console errors.
- [x] Admin ad-manager panel loads, toggles individual slots, and saves.
- [x] `npm run build` succeeds (this exercises the SSR/prerender path — an unguarded
      `window` reference will fail here, not in `ng serve`).
- [x] Mobile viewport (<768 px): layout is byte-for-byte identical to before. Desktop slots
      are still hidden. *(The wasted mobile requests of RC-8 are unchanged in this phase —
      that is Phase 2.)*

### 1.6 How the admin-gated items were verified without touching production

Dev and prod `wpBaseUrl` both point at `https://epaper.dailysangram.com/wp`, so using the
local admin panel for real would have rewritten live ad settings. Instead the three
admin-gated checks ran against the **production origin with the local `dist/` bundle
injected**, with three requests handled locally so nothing reached the backend:

| Request | Handling |
|---|---|
| `GET …rest_route=/…/ads/config` | served from a snapshot of the real payload, rewritten per test |
| `POST …rest_route=/…/ads/config` | **fulfilled locally and never forwarded** — the admin save is a no-op upstream |
| `GET …rest_route=/…/auth/me` | fulfilled locally so the admin UI renders without a real login |

The REST URLs matter: `wpApiInterceptor` rewrites them to `/wp/?rest_route=/…`, so the route
name is in the **query string**, not the path. A path-only matcher silently misses them and
the test appears to fail.

**T1 — global GAM off is a complete kill switch (RC-11, now confirmed end-to-end)**

| Observation | Result |
|---|---|
| `gpt.js` injected | **no** |
| slots defined / `display()` calls | 0 / 0 |
| `div-gpt-ad-*` containers in DOM | 0 |
| `app-ad-slot` hosts in DOM | 0 |
| network requests to `securepubads` | 0 |
| console errors | none |
| layout | 12 thumbnails, 16 sections, 12 pagination buttons, no horizontal overflow — identical to the ads-enabled run |

Exercised article selection and pagination while disabled; no slot leaked through.

**T2 — per-slot toggle, off → on, with no page reload**

`desktop_page_right` was forced off in the served config, then toggled on through the real
admin UI. Navigation back to the viewer used the Angular router (verified by a
window-scoped marker surviving the transition), so `AdService` and `GamService` were the same
instances throughout — a genuine runtime `disabled → enabled` transition.

| | Before | After |
|---|---|---|
| admin checkbox | unchecked | checked |
| slots defined | 0 | 2 |
| `desktop_page_right` container | absent | present, 1 iframe, 600×266 |
| `securepubads` requests | — | +8 |
| console errors | none | none |

The intercepted POST body carried the correct `slot_states` map for all nine slots.

*Note for whoever runs this by hand: the admin tab bar only exists on the non-vintage theme.
Under the vintage theme (`ADMIN_THEME`), Ad Manager is inside the "Menu ▾" dropdown.*

*Also note: `desktop_page_right` lives in the **no-section-selected** branch of the right
panel (Correction 2). Selecting an article unmounts it, which will mask this test.*

**T3 — 10 modal open/close cycles**

`MutationObserver` was wrapped to count only observers bound inside an `app-ad-slot`, so
Angular's and GPT's own observers do not pollute the measurement.

| Cycle | slots (open / closed) | observers created | disconnected | **live** | `destroySlots()` | ad requests |
|---|---|---|---|---|---|---|
| 1 | 5 / 3 | 8 | 5 | **3** | 3 | 16 |
| 5 | 5 / 3 | 20 | 17 | **3** | 11 | 31 |
| 10 | 5 / 3 | 35 | 32 | **3** | 21 | 51 |

Live observers stay pinned at 3 — one per slot that legitimately remains mounted — and
defined slots stay flat at 3, so nothing accumulates. `destroySlots()` and ad requests grow
linearly, which is the intended behaviour: every reopen genuinely re-requests. The only
console error across all ten cycles is a third-party `Shared Storage` attestation notice from
`googleadservices.com`, unrelated to this change.

**T4 — thumbnail `IntersectionObserver` lazy-load, unaffected**

| | before scroll | after scrolling the rail to the bottom |
|---|---|---|
| `.thumbnail-item` | 12 | 12 |
| `<img>` present | 4 | 12 |
| decoded (`naturalWidth > 0`) | 4 | 12 |
| skeleton loaders | 8 | 0 |

The rail genuinely overflows (2889 px of content in a 906 px viewport), so this is a real
lazy-load exercise, not a vacuous pass. No page errors.

**T5 — text/content modal (`desktop_post_top_text`), lifecycle fixed but still unfilled**

| Open | `securepubads` requests | container | iframes |
|---|---|---|---|
| #1 | 13 | 1591×60 | 0 |
| #2 | 14 | 1591×60 | 0 |
| #3 | 15 | 1606×60 | 0 |

The request count now advances by one per open — before Phase 1 it was frozen — so the
define/destroy pairing is working. The slot returns an **empty fill every time, including the
first**, so this is pre-existing and outside the scope of these phases. Root cause in §1.7.

**T6 — mobile viewport, 390×844, local build vs production build side by side**

| | production bundle | local (Phase 1) bundle |
|---|---|---|
| thumbnails / sections / pagination | 12 / 12 / 6 | 12 / 12 / 6 |
| `app-ad-slot` hosts / `div-gpt-ad` divs | 1 / 1 | 1 / 1 |
| **visibly rendered** gpt divs | 0 | 0 |
| horizontal overflow | 0 px | 0 px |
| `.main-page-image` rect | 298×465 at (46, 213) | 298×465 at (46, 213) |
| `securepubads` requests | 8 | 8 |

Every compared layout key is identical, down to element geometry. No page errors. RC-8 is
unchanged, as intended for this phase.

### 1.7 Why some slots never fill — a GAM inventory gap, not a code defect

Three slots reliably return empty fills (`desktop_post_preview_top`, `desktop_post_top_image`,
`desktop_post_top_text`) while others reliably fill. The declared sizes explain it exactly:

| Slot | Has a rectangle size (300×250 / 336×280)? | Observed |
|---|---|---|
| `desktop_page_right` | yes | **fills** (600×266) |
| `desktop_post_preview_middle` | yes | **fills** (554×266) |
| `desktop_post_middle` | yes | **fills** (300×266) |
| `desktop_post_preview_top` | no — banner sizes only | empty |
| `desktop_post_top_image` | no — banner sizes only | empty |
| `desktop_post_top_text` | no — banner sizes only | empty |

The correlation is perfect across every slot tested. The banner-only units
(`TDSEV3_Desktop_Post_Preview_Top-01`, `TDSEV3_Desktop_Post_Top-01`, sizes 320×100 / 300×100 /
728×90 / 468×60) appear to have **no line items booked against them** in the GAM network,
whereas every unit offering a rectangle does.

This closes out the "`Desktop_Post_Top` still returns empty on repeat opens" note in §1.4:
it is not a lifecycle defect and no further code change will fix it. Two items for the GAM
network owner, added to the Phase 6 gate:

1. Book creatives against the banner sizes on `TDSEV3_Desktop_Post_Top-01` and
   `TDSEV3_Desktop_Post_Preview_Top-01`, or add a rectangle size to those slot definitions in
   `gam_ad_slots()`.
2. Note that `desktop_post_top_image` and `desktop_post_top_text` share **one** ad unit path
   (`TDSEV3_Desktop_Post_Top-01`) across two different div ids. That is legal, but under SRA
   both are requested in the same call and will compete for the same inventory.

---

## Phase 2 — Coalesced, targeted refresh (fixes RC-1, RC-2, RC-5, RC-6, RC-8)

**Goal:** slots whose container **persists** across a content change fetch a new, correctly
targeted creative. Slots that unmount/remount are already handled by Phase 1 and must not be
double-refreshed.

### 2.1 Extend `GamService` with refresh

- [x] **2.1.1** Add `requestRefresh(targeting: Record<string, string>, ids?: string[]): void`.
  - Add the ids (or all live ids) to a `pending: Set<string>`.
  - Store `pendingTargeting`.
  - Debounce with `clearTimeout` / `setTimeout(..., 250)`.
  - Comment the 250 ms choice: long enough to coalesce a burst of clicks and let the DOM swap
    settle, short enough that the ad turns over while the user is still on the new content.

- [x] **2.1.2** Implement the private `flush()` with all four guards, in this order:
  1. `if (this.document.hidden) return;` — never refresh a backgrounded tab (policy).
  2. Skip ids absent from `live` — the container unmounted during the debounce window.
     **This is what prevents double-counting with Phase 1's mount-time `display()`.**
  3. Skip when `!isVisible(el)` — **fixes RC-8**, the hidden-desktop-slots-on-mobile waste.
  4. Skip when `now - lastRefreshedAt < 5000` — per-slot floor against rapid pagination
     clicking. A slot registered in Phase 1 gets `lastRefreshedAt = Date.now()` at
     registration, so it **cannot** be refreshed within 5 s of its initial fill.

- [x] **2.1.3** Implement `isVisible(el)`:
  ```ts
  return el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  ```
  `offsetParent` is `null` for any `display: none` subtree, which is exactly the condition the
  desktop/mobile CSS creates — no `matchMedia` duplication of the breakpoint needed.
  **Must not break:** do not use `IntersectionObserver` here; a slot scrolled out of the
  panel is still legitimately refreshable.

- [x] **2.1.4** Implement `applyTargeting(gptSlot, t)`:
  ```ts
  gptSlot.clearTargeting();
  Object.entries(t).forEach(([k, v]) => v && gptSlot.setTargeting(k, v));
  ```
  **`clearTargeting()` is mandatory** — `setTargeting` accumulates per key, so without it
  targeting degrades to `page=[1,2,3,…]` after a few navigations.

- [x] **2.1.5** Issue exactly one batched refresh per flush:
  ```ts
  gt.pubads().refresh(batch.map(e => e.gptSlot), { changeCorrelator: true });
  ```
  `changeCorrelator: true` makes GAM treat this as a new pageview so frequency caps,
  competitive exclusions, and roadblocks are evaluated fresh.

- [x] **2.1.6** Apply the same targeting map in `register()` (Phase 1.1.3) so first-load ads
  and refreshed ads are targeted consistently. ~~This requires passing targeting into
  `register()` — extend its signature now rather than reaching back into the component.~~
  **Implemented differently:** targeting is held on the service (a private `targeting` field
  updated by `requestRefresh`) rather than threaded through `register()`. `AdSlotComponent` is a
  generic host that knows nothing about pages or articles, and the component that *does* know
  (`NewspaperComponent`) is not the one mounting the slot — so extending the signature would
  have forced targeting through a component that has no business carrying it. Keeping it on the
  service means one source of truth for both the initial `display()` and every later
  `refresh()`, so a slot that mounts mid-session (a modal ad) is targeted identically to one
  refreshed in place. Verified by S4 below: the modal-era slots carry the same key-values.

- [x] **2.1.7** Add `ngOnDestroy` to `GamService` (or use `DestroyRef`) to `clearTimeout` the
  pending debounce. A root-provided service outliving a timer is harmless in the browser but
  will hang an SSR render.

### 2.2 Wire the triggers in `NewspaperComponent`

- [x] **2.2.1** Add a private `adTargeting()` returning the key-values. Use the **verified**
  field names:
  ```ts
  {
    date:    this.selectedDate,                          // string, line 168
    edition: String(this.selectedEditionNumber),         // number, line 178
    page:    String(this.currentPage?.id ?? ''),
    section: this.selectedSection?.id ?? '',
  }
  ```
  **Confirm the key names with whoever manages GAM network `22062727803` first.** Targeting
  keys must exist in GAM as custom key-values or they are silently ignored — the refresh
  would work while appearing to change nothing.

- [x] **2.2.2** Add a private `notifyAdContentChanged()` that calls
  `this.gam.requestRefresh(this.adTargeting())`.

- [x] **2.2.3** Call it from **`selectPage()`** ([line 825](src/app/newspaper.component.ts#L825))
  — one line, at the **end** of the method, after all state is assigned.
  Per Correction 1 this single call covers pagination buttons, thumbnails, linked-section
  jumps, deep links, and initial load.
  **Must not break:** place it after `updateUrl()` so targeting reflects final state.
  **Note:** on initial load this fires while slots are registering; guard 2.1.2 (id not yet
  in `live`) and guard 2.1.4 (5 s floor) both suppress it. No wasted request.

- [x] **2.2.4** Call it from **`selectSection()`** ([line 1296](src/app/newspaper.component.ts#L1296)),
  also at the end. This covers Scenario 2 (center-panel selection).
  **Note:** `selectPage()` calls `selectSection()` at line 849, so both fire on a
  targeted page change — the 250 ms debounce coalesces them into **one** refresh. This is the
  primary reason the debounce exists.

- [x] **2.2.5 — verified redundant, deliberately not added.** Traced both paths:
  `onDatePickerChange()` → `onDateChange()` → `loadCurrentEdition()`, and `onEditionChange()` →
  `loadCurrentEdition()`. `loadCurrentEdition()` always ends in `selectPage()`
  ([lines 630 and 635](src/app/newspaper.component.ts#L630)) whenever pages exist, so 2.2.3
  already covers both. Adding the calls would have been dead code.

  <details><summary>Original item</summary>

  Call it from **`onEditionChange()`**
  ([line 773](src/app/newspaper.component.ts#L773)) and **`onDatePickerChange()`**
  ([line 768](src/app/newspaper.component.ts#L768)). Both already funnel into a reload that
  ends in `selectPage()`, so this may be redundant — **verify before adding**, and skip if the
  `selectPage()` hook already covers them. Redundant calls are harmless (debounced) but dead
  code is not.

  </details>

- [x] **2.2.6 — held to.** No trigger added for modal opens (`openImageModal` line 1482,
  `openLinkedSectionImage` line 1706, `openContentModal` line 1458). Phase 1 already gives
  those slots a fresh `defineSlot` + `display` per mount, which **is** a new ad request.
  Adding a refresh here would double-request. The registry makes this automatic: unmounted
  slots are not in `live`.

- [x] **2.2.7 — evaluated and rejected.** Deferring the preview-slot refresh to
  `onSectionImageLoad()` ([line 1367](src/app/newspaper.component.ts#L1367)) was to be adopted
  only if the double reflow proved perceptible. **It does not exist.** S7 sampled the layout 16
  times at 600 ms intervals across a navigation *and* the refresh that follows it, and every ad
  container held one single height for the whole window:

  | Container | Heights observed across 16 samples |
  |---|---|
  | `desktop_page_left` (`1781436865448-0`) | `[240]` |
  | `desktop_page_right` (`1781437781482-0`) | `[266]` |

  The reserved boxes never collapse and never regrow, so there is no second reflow to merge
  into the image load. Adopting it would have coupled the ad lifecycle to an image `load`
  event for no measurable gain.

### 2.3 Phase 2 regression checklist

- [x] **Scenario 1:** click through pagination `1 → 2 → 3`. The left-rail ad turns over.
      Network shows **one** `securepubads` request per navigation, not one per slot per click.
- [x] **Scenario 1 (burst):** click 6 pagination numbers rapidly → **at most one** refresh
      request fires (debounce + 5 s floor).
- [x] **Scenario 2:** select three different articles from the center panel on one page →
      the preview ads turn over each time.
- [x] **Scenario 3:** modal ads still fill on every open, and **no** extra refresh request
      accompanies the modal's own `display()` (verify in the Network panel).
      *Scored on lifecycle rather than fill — see the S3 note below.*
- [x] Targeting is present and correct: in the GPT console, confirm each refreshed slot's
      key-values reflect the current page/section, and that **no key has accumulated
      multiple values**.
- [x] Background the tab, navigate via keyboard, return → no refresh fired while hidden.
- [x] **Mobile viewport:** navigate pages. **Zero** ad requests for the hidden desktop slots
      (this is the RC-8 fix). Confirm in the Network panel.
- [x] No layout shift or flicker during refresh; the reserved box does not collapse.
- [x] Section image loading, skeletons, and the slow-connection warning
      ([`newspaper.component.html:625`](src/app/newspaper.component.html#L625)) behave exactly
      as before.
- [x] URL still updates correctly via `replaceState` on every navigation.
- [x] `npm run build` succeeds — 9.9 s, Brotli saved ~1208 KB.

### 2.4 Phase 2 measured result

Automated with `/tmp/gam-probe/verify2.js`, using the Phase 0 isolation harness from §1.6:
production origin, local `dist/` injected, `/ads/config` served from a snapshot, config `POST`
aborted so **nothing was written to the live backend**.

One deliberate change to the served config: **`desktop_page_left` is forced enabled.** It is
disabled in production, and per Correction 2 it is the *only* slot that persists across
pagination — with it off there is no surviving slot for a refresh to act on and Scenario 1
cannot be observed at all. This is a measurement necessity, not a product change.

| Test | What it proves | Result |
|---|---|---|
| **S1** pagination `1→2→3`, spaced past the 5 s floor | `refresh()` fires **once per navigation** (1, 2, 3) with **exactly one ad request each**, batch = `[desktop_page_left, desktop_page_right]` | **PASS** |
| **S1b** 6 pagination clicks at 120 ms | **1** refresh call for the entire burst; `display()` count unchanged at 2 (no slot churn) | **PASS** |
| **S2** three articles on one page | refresh 1→2→3, batch grows to include `desktop_post_preview_top` + `desktop_post_preview_middle`, `preview_middle` creative turned over (`138576173999` → `138577028059`) | **PASS** |
| **S3** three content-modal open/close cycles | fresh ad request on **every** open (7→9→11) and **zero** refresh calls during an open — no double-request alongside the modal's own `display()` | **PASS** |
| **S4** targeting after 3 paginations + 1 article select | `{date: ["2026-08-29"], edition: ["1"], page: ["4"], section: ["post-1787931361460"]}` on all three managed slots — **exactly one value per key**, proving `clearTargeting()` works | **PASS** |
| **S5** `document.hidden` forced true | **0** refresh calls across 4 navigations, while `display()` still runs (4) for newly mounted slots — the policy guard suppresses refresh only | **PASS** |
| **S6** mobile 390×844, 3 paginations | all three defined slots hidden; **0** refresh calls, **0** hidden slots refreshed — RC-8 fix confirmed | **PASS** |
| **S7** layout sampled 16× across a refresh | panel scaffolding unmoved, page image settles and stays, ad heights constant, `0 px` horizontal overflow, URL `/2026-08-29/page-03/edition-01/` | **PASS** |

**Note on S3 — scored on lifecycle, not fill.** The content modal mounts exactly one slot,
`desktop_post_top_text`, which declares banner sizes only and therefore returns empty on every
request regardless of code — the GAM inventory gap documented in §1.7 and first seen as T5. What
Phase 2 must not break is that each open issues its own ad request and that no coalesced refresh
lands on top of the modal's own `display()`; both hold.

**Note on the anchor slot.** S4 also surfaced
`gpt_unit_/22062727803/TDSEV2_Bottom_Anchor_0` carrying **no** targeting. That is expected: per
Correction 4 the anchor unit is created outside this repo and `GamService` deliberately does not
manage it, so it receives neither targeting nor refresh. Tracked as Phase 6 item 6.7.

**Two harness traps worth recording** (both cost real debugging time):

1. The live backend intermittently 504s or drops the connection, which renders the app with
   **zero** sections and zero pagination buttons — indistinguishable from a genuine regression.
   Two runs were falsely scored REVIEW before `boot()` was changed to wait on the content
   itself, retry up to 3×, and report `INCONCLUSIVE` rather than `FAIL`. Any future manual
   verification should confirm section count is non-zero *before* trusting a verdict.
2. Counting ad requests by matching the `securepubads` **host** over-counts by ~3× — it picks up
   viewability pings, `/pcs/activeview`, and cookie syncs. Only `/gampad/ads?` and
   `/gampad/live/ads?` are actual ad requests. The "one request per navigation" claim above is
   measured with the strict matcher.

---

## Phase 3 — Re-arm the Heavy-Ad observer (fixes RC-7)

**Why after Phase 2:** RC-7 only becomes an observable bug once refresh exists. Doing it
earlier would be untestable.

- [x] **3.1** In `GamService`, register a single `pubads().addEventListener('slotRenderEnded', …)`
  and expose it to components. Implemented as `onRender(id, cb)` / `offRender(id)` with one
  GPT-level listener attached lazily on first interest and dispatched by
  `ev.slot.getSlotElementId()`, mapped back to the slot id via the `live` registry.

- [x] **3.2** In `AdSlotComponent`, on a `slotRenderEnded` for its own div: clear
  `removedByBrowser`, clear the service-side collapse flag, and re-arm the observer.

- [x] **3.3** ~~Use `ev.isEmpty` from the event to detect genuine empty fills.~~ **Not needed,
  and would have been wrong here.** An empty fill inserts no iframe at all, so
  `iframeWasPresent` stays false and the observer already never collapses on it — `isEmpty`
  would add a second code path for a case that is already handled. The `iframeWasPresent`
  invariant is kept, as required. The event *is* consumed, just for un-collapsing (3.2) rather
  than for empty detection.

- [x] **3.4** Listener removed on service teardown, in `ngOnDestroy`, via
  `removeEventListener` inside the GPT command queue.

### 3.5 Three defects found while making this work

Phase 3 was supposed to be a small change. Verifying it turned up two pre-existing bugs and one
flaw in the plan itself, all of which had to be fixed for the Heavy-Ad feature to work at all.

**(a) The observer's selector never matched, so the collapse could never fire.** The observer
watched for `iframe[id*="<divId>"], iframe[name*="<divId>"]`, but GPT names its SafeFrame after
the **ad unit path**, not the div id. Measured on the live site:

| | value |
|---|---|
| container div id | `div-gpt-ad-1781437781482-0` |
| GPT iframe id | `google_ads_iframe_/22062727803/TDSEV3_Desktop_Page_Right-01_0` |
| iframes matching the old selector | **0** |

So `iframeWasPresent` never became true and the whole Heavy-Ad path was dead code. Now matches
any iframe inside the container, which is sound because the container holds only this slot's
render. *This means RC-7 — "the collapse is latched forever" — was never observable in
production: not because the latch released, but because nothing ever latched.*

**(b) `dn-ad--hidden` did not hide desktop slots on desktop.** Every rule in the component CSS is
`:host(.one-class)`, so specificity ties and **source order** decides. The `.dn-ad--hidden`
block sat *above* the `@media (min-width: 768px) { :host(.dn-ad--desktop) { display: block } }`
rule, so on a desktop viewport the later rule won and a "collapsed" slot kept its full box.
Measured: host carried `dn-ad--hidden` while the container still reported **266 px** tall.
Fixed by moving the block to the end of the file, with a comment saying it must stay there.
After the fix the same simulation reports **0 px**.

**(c) The plan's own design deadlocked.** With (a) and (b) fixed, a collapsed slot is genuinely
`display: none` — which Phase 2's guard 3 reads as "not worth refreshing". That is a closed loop:
no refresh → no new render → no `slotRenderEnded` → never un-collapses. The recovery listener
would have been unreachable code. Fixed by having the component report the collapse to
`GamService` (`setCollapsed`), and having guard 3 treat a Heavy-Ad collapse as the one hidden
state that *is* still refreshable — since a new creative is precisely what brings it back.

**(d) A refresh briefly looks identical to a Heavy-Ad removal.** GPT drops the old iframe a
moment before inserting the new one. With (a) fixed, that gap would collapse the slot on *every*
refresh. The removal is now confirmed after a 1500 ms delay (`HEAVY_AD_CONFIRM_MS`) and cancelled
if an iframe reappears — an intervention is permanent, so waiting costs nothing.

### Phase 3 regression checklist

- [x] A slot collapsed by Chrome's Heavy Ad Intervention **recovers** on the next refresh
      instead of staying hidden for the session.
- [x] An empty-fill slot still collapses (or holds reserved space, per the
      `collapseEmptyDivs(false)` decision) exactly as before.
- [x] No false-positive collapses during normal ad load — navigate 20 pages and confirm no
      slot ever collapses while an iframe is present.
- [x] `npm run build` succeeds.

### 3.6 Phase 3 measured result

Same harness as §2.4. Heavy Ad Intervention cannot be triggered on demand, so it is simulated
the way Chrome performs it: removing the SafeFrame iframe from a container that had one — which
is exactly the transition the observer exists to detect.

| Test | What it proves | Result |
|---|---|---|
| **S8** simulate a Heavy-Ad removal on `desktop_page_right`, then navigate | fills (`iframes=1`, 266 px) → collapses (`dn-ad--hidden`, container hidden, **0 px**) → is still included in a refresh batch despite being hidden → **recovers** (`iframes=1`, 266 px, no longer collapsed) | **PASS** |
| **S9** 6 navigations, layout sampled 5× per navigation during load | **0** collapses while an iframe was present — the `iframeWasPresent` invariant plus the 1500 ms confirmation hold under real refresh churn | **PASS** |

Re-ran the full Phase 2 suite afterwards (S1, S1b, S2–S7): all still pass, so making the collapse
real did not regress the refresh path or the layout.

---

## Phase 4 — Performance and viewability polish

Independent of correctness; ship only after Phases 1–3 are verified.

**Outcome: no code change.** All three items were resolved by measurement, and every candidate
change was rejected on its own numbers. Details in §4.4.

- [x] **4.1** ~~Add `pubads().enableLazyLoad({ fetchMarginPercent: 100, renderMarginPercent: 50, mobileScaling: 2.0 })`
  in `_bootGpt()`.~~ **Implemented, measured, then reverted.** Every slot this app mounts is
  already within one viewport of the fold, so the config changed nothing that could be measured;
  the one place slots *do* leave the fetch margin is after the user scrolls a modal past them,
  by which point they have already fetched. See §4.4 for the numbers and the positive control
  that proves the call was genuinely active rather than inert.

- [x] **4.2** ~~Address the variable-height container for `desktop_post_middle`.~~ **Rejected —
  no shift to fix.** Its box measured a constant **266 px** across 8 samples spanning two modal
  opens and three scroll positions each. It declares sizes from `300×100` to `336×280`
  ([`digital-newspaper.php:664`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L664)),
  but GAM only ever served it a `300×250`. Pinning the container to the tallest declared size
  would add 30 px of permanent blank space to buy protection against a shift that does not occur.
  **Caveat, routed to 6.7:** the box is stable because the *inventory* is homogeneous, not because
  the CSS prevents movement. If banner line items are ever booked against this unit the box will
  drop to 116 px and the shift becomes real — at which point pin it.

- [x] **4.3** **Confirmed as-is: keep GPT's default, do not call `collapseEmptyDivs` at all.**
  An unfilled slot reserves exactly its configured `min_height` and nothing more —
  measured 240 px (`desktop_page_left`), 100 px (`desktop_post_preview_top`), 60 px
  (`desktop_post_top_image` / `desktop_post_top_text`). No double reservation, so there is
  nothing to reconcile; `collapseEmptyDivs(false)` would be a no-op restating the default.
  The dead space that *is* visible on an article view (100 px + 60 px) is caused by the inventory
  gap in §1.7, not by the reservation. Collapsing those divs would hide the symptom and trade it
  for layout shift on the days the units do fill, so it is reported in 6.7 instead.
  > **Refined in §6.11.** The three measurements above are right, but "nothing to reconcile" was
  > wrong: those are *empty* heights, and a filled slot occupies `min_height` + 16 px of padding.
  > Phase 6 measured the resulting 100 → 116 px shift and fixed it. The decision on
  > `collapseEmptyDivs` is unaffected; the empty-state numbers are now 256 px and 116 px
  > (both re-measured) and 76 px for the 60 px slots (inferred from the same +16, not re-measured).

---

### 4.4 Phase 4 measured result

Same harness and same isolation as §2.4 — production origin, local `dist/` injected,
`/ads/config` GET served from a snapshot with `desktop_page_left` forced on, config POST aborted
so nothing reached the live backend. Tests S10–S15, added to `verify2.js`.

| Test | What it measured | Result |
|---|---|---|
| **S10** initial load, 1680×1000 | 2 slots mounted, both at `top=94`, **0** outside the fetch margin. Initial ad requests **4** with lazy load, **4** without | no difference |
| **S11** 3 paginations, lazy load on | `desktop_page_right` turned over `138576173999` → `138577028059` → `138576173999`, `iframes ≥ 1` at every sample, **+3** ad requests | refresh unaffected |
| **S13** text modal, deep scroll | only `desktop_post_top_text` ever left the fetch margin, and only *after* scrolling past it (`top=-1294`) — it had already fetched | nothing saved |
| **S14** image modal, 3 scroll steps × 2 opens | `desktop_post_middle` mounts, fills, and measures **266 px at all 8 samples**; it leaves the margin only at `top≤-1438`, again after fetching | answers 4.2 |
| **S15** mobile 390×844 | 3 GPT slots defined, **3 hidden** (`display:none`), **3** ad requests — lazy load does **not** suppress a fetch for a hidden slot | no mobile saving |

**Positive control — the reason this conclusion is trustworthy.** "No measured difference" is also
what an *inert* config call looks like, so the same build was re-run with
`fetchMarginPercent: 0, renderMarginPercent: 0`. Behaviour changed sharply:
`desktop_post_preview_middle` went from 266 px filled to **100 px unfilled**, `desktop_post_middle`
from 266 px to **60 px unfilled**, and `desktop_post_top_image` never filled. The call was
therefore genuinely active — the config simply has nothing to act on at margin 100.

That control also surfaced the argument *against* keeping it: with lazy loading on, whether a slot
fills depends on where it happens to sit when GPT evaluates it. At margin 0, slots sitting plainly
inside the viewport (`top=537`) still failed to fill. This app mounts slots inside overlays and
scrolling panels whose layout settles after mount, so tying fill to geometry adds a silent failure
mode in exchange for, today, nothing.

**Revisit when — and only when — a slot is placed more than one viewport below the fold** (the most
likely trigger is 5.1 giving the mobile slots a real placement). The check is one run: enable the
config, then confirm via S10/S14 that some slot reports `inFetchMargin: false` *while still
unfilled*. Until that is true, lazy loading has nothing to defer.

**Two measurement traps worth keeping** (alongside §2.4's two):

3. **`iframes > 0` is not proof of a fill.** GPT inserts an iframe for some empty responses too.
   `desktop_page_left` reported `iframes=1` with `creativeId: null` and a 616 px box on one run
   and `iframes=0` with a 240 px box on the next. Box height against declared size is the
   reliable signal: 616 px ⇒ a 600-tall creative rendered, 240 px ⇒ the bare `min_height`.
4. **Fill is not deterministic run to run.** The same build produced 3 and 4 initial ad requests
   on consecutive runs, and `desktop_page_left` filled on some runs and not others. Any assertion
   of the form "this exact set of slots fills" is flaky by construction — assert on lifecycle
   (a request happened, a creative changed, a box never went blank) rather than on which slot won
   an auction.

---

## Phase 5 — Mobile slots (product decision required first)

**Blocked** — needs a decision before any code.

- [ ] **5.1** Decide the fate of `mobile_post_top` and `mobile_post_middle`
  ([`digital-newspaper.php:670-685`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L670-L685)).
  They are `defineSlot`-ed but rendered nowhere. Either:
  - **(a)** place them in the mobile layout — the correct answer to RC-8, giving mobile users
    real mobile creatives instead of hidden desktop ones; or
  - **(b)** remove them from `gam_ad_slots()`.

  Right now they are neither serving nor removed. Option (a) is a new placement and needs
  design sign-off; (b) is a two-line deletion.

- [ ] **5.2** Resolve the open product question: with `desktop_page_left` **enabled**, the ad
  **replaces the entire thumbnail list**
  ([`newspaper.component.html:368-371`](src/app/newspaper.component.html#L368-L371) uses
  `@else if`). Scenario 1 describes navigating *by thumbnails* while also refreshing the
  left-rail ad — currently mutually exclusive. **Confirmed empirically** while building the
  Phase 2 harness: with `desktop_page_left` enabled at a 1680 px viewport, `.thumbnail-item`
  count is **0** — the thumbnail rail is gone entirely, and pagination is the only way to
  change page. This is why §2.4's Scenario 1 is measured via pagination buttons.
  Confirm whether that is intended; it determines
  whether `desktop_page_left` needs refresh-on-page-change at all.

---

## Phase 6 — Pre-merge gate

- [x] **6.1** Full pass of all four requested scenarios on desktop and mobile — covered by the
      automated suite rather than by hand: S1/S1b (pagination), S2 (centre-panel selection),
      S3/S14 (modal), S6/S15 (mobile), S7 (layout). All PASS; see §6.9.
- [x] **6.2** GPT console clean — every test asserts `errs.length === 0`, which captures
      `pageerror` and `console.error`. No `display` warning, no `defineSlot` returning `null`, no
      duplicate-div error anywhere in the suite.
      **Scope this claim carefully:** `errs` also catches *third-party* console output, so a
      clean report means "nothing from our code" only after the known noise is filtered —
      privacy-sandbox probes, Chrome's SafeFrame `Blocked script execution in 'about:blank'`, and
      google.com's own report-only `frame-ancestors` violation. See §6.11; two of those three
      were only identified because they made a passing test report REVIEW.
- [x] **6.3** Request count per navigation is bounded: **exactly one** `/gampad/ads` per
      navigation (S1: 3→4→5→6 over three paginations) and **one for a whole six-click burst**
      (S1b). Counted with the `/gampad/(live/)?ads?` matcher, not the loose host match — see
      §2.4 trap 2.
- [x] **6.4** `npm run build` (includes `scripts/compress-dist.js`) succeeds — green on every
      build in Phases 2–6, ~9 s, Brotli saving ~1209 KB.
- [x] **6.5** Ads **off** in admin: site behaves exactly as a no-ads build. Re-confirmed on the
      final build via `regress.js` T1 — `gpt.js` **never injected**, 0 slots defined, 0
      `display()` calls, 0 GPT containers, 0 `app-ad-slot` hosts, **0 ad requests**, and the
      layout intact at 12 thumbnails / 16 sections / 12 pagination buttons with no horizontal
      overflow. Errors `(none)`. Costs nothing on the live network, since GPT never loads.
- [ ] **6.6** Confirm with the GAM network owner that (a) the targeting keys exist, and
      (b) refresh is expected on these units — some direct-sold line items are priced on a
      no-refresh assumption.
- [ ] **6.7** Report the GAM-side issues found during Phase 1 to the network owner. None are
      fixable in this codebase:
      - **No inventory booked against banner-only units** — see §1.7.
        `TDSEV3_Desktop_Post_Top-01` and `TDSEV3_Desktop_Post_Preview_Top-01` return empty
        fills on every request; every unit offering a 300×250/336×280 rectangle fills fine.
      - **`TDSEV2_Bottom_Anchor` is created twice per page load**, one creation discarded with
        `Format already created on the page` — see **Correction 4**. This unit is not in
        `gam_ad_slots()` and does not come from this repo.
      - **`TDSEV3_Desktop_Post_Middle-01` only ever serves `300×250`** even though the unit
        declares six sizes up to `336×280` — measured 266 px on 8 of 8 samples (§4.4). Harmless
        today, but it is the reason 4.2 was rejected: if banner line items are later booked
        against this unit the container will shift between 116 px and 296 px, and the CSS will
        need to pin it. Worth confirming whether the extra sizes are intentional or dead.
      - **`TDSEV3_Desktop_Page_Left-01` fills inconsistently** — the same build produced a
        600-tall creative on one run and an empty response on the next (§4.4, trap 3). This unit
        is disabled in the live config, so it affects nobody today, but 5.2 cannot be decided
        without knowing whether the unit is genuinely booked.
      - **Disclose the verification traffic.** Roughly a few hundred ad requests were made from
        the automated runs behind Phases 1–6, against the live network, from automated
        navigation. They are real impressions in reporting and could be read as invalid traffic.
        See §6.12 for why they hit production and what to do about it.
- [x] **6.8** Re-read [GAM_AD_REFRESH_ANALYSIS.md](GAM_AD_REFRESH_ANALYSIS.md) §4 policy
      notes: every trigger must be user-initiated. Confirm no `setInterval` auto-refresh crept
      in, and that the `document.hidden` guard is present.
      **One real defect found and fixed — see §6.10.**

---

## §6.9 Phase 6 measured result

Suite re-run against the production origin with the local `dist/` injected, `/ads/config` GET
served from the snapshot and the config POST aborted. Eleven tests, all green:

| Test | Key numbers |
|---|---|
| **S1** pagination, spaced >5 s | `refreshCalls` 1/2/3 over pages 2/3/4; `adReqs` 3→4→5→6; batch `["1781436865448-0","1781437781482-0"]` on every navigation |
| **S1b** 6-click burst | `refreshCalls = 1` for the whole burst; `adReqs +1`; `displays` 1→1 |
| **S2** three articles | `refreshCalls` 1/2/3; `adReqs` 6/7/8; `preview_middle` creative turned over `…028059`→`…028059`→`…173999` |
| **S3** three modal opens | one fresh ad request per open (`adReqs` 7/9/11); `refreshCalls = 0` during every open — the modal's own `display()` is not shadowed by a refresh |
| **S4** targeting | 3/4 slots carry all of `date`/`edition`/`page`/`section`; every key single-valued; the 4th is the externally-injected `TDSEV2_Bottom_Anchor` |
| **S5** `document.hidden` | `refreshCalls = 0` after 4 navigations, while `display()` still ran 4× for newly mounted slots |
| **S6** mobile 390×844 | 3 slots defined, all hidden, `refreshCalls = 0`, `divs refreshed = []` |
| **S7** layout | container heights constant at 240 and 266 across a refresh; 0 px horizontal overflow; URL `/2026-08-29/page-03/edition-01/` |
| **S8** Heavy-Ad collapse | 266 → collapsed 0 → **266 again after refresh**; the collapsed slot was in the batch |
| **S9** 6 navigations | 0 false-positive collapses while an iframe was present |
| **S16** version poll | see §6.10 |

S1 reported `INCONCLUSIVE (environment)` on the batch run — `BOOT_FAILED after 3 attempts
(sections=0 pag=0)`, the §2.4 trap 1 backend outage guard doing its job — and PASSed on a
re-run by itself. An inconclusive verdict is not a failure and must not be read as one.

`errors: (none)` on all eleven, which is what closes 6.2.

## §6.10 Defect: the version poll refreshed ads with no user behind it

Found by the 6.8 static read, not by any test — the tests were all passing.

`startVersionPoll(300_000)` polls `/data/version`; on a change it calls
`reloadCurrentDateOnly()`, whose `data$` emission runs `loadCurrentEdition()` →
`renderCurrentEdition()` → `selectPage()` → `notifyAdContentChanged()`. So a **publisher
content change** produced an ad refresh with **nobody having clicked anything** — a breach of
compliance guardrail 1 below, and exactly the mechanical refresh GAM counts as invalid traffic.
Introduced by Phase 2 and invisible to every scenario test, because no scenario waits five
minutes.

The obvious discriminator is wrong. `isBackgroundRefresh` (newspaper.component.ts:515) is
**also** true for a date change and an edition change, both of which *are* user actions and
must still refresh. The flag has to record *who asked*, so it is set by the poll and consumed
by the render that poll triggers:

- `pollDrivenReload` field — newspaper.component.ts:79
- set in the `remoteDataChanged$` subscription — :348
- consumed at the **end** of `renderCurrentEdition()` — :674 (`selectPage()`/`selectSection()`
  run synchronously above it and must still see it; it must not survive into the next click)
- read by `notifyAdContentChanged()` — :929

Verified against the real 5-minute poll, driven by a `bumpVersion` route override returning
`{dataVersion: 9999999999}`:

```
S16 with the fix:       version hits=1  reload hits=4  refreshCalls 0→0  adReqs 3→3  ==> PASS
S16 control (no gate):  version hits=1  reload hits=3  refreshCalls 0→1  adReqs 3→4  ==> REVIEW
```

The control matters more than the pass: without it, a test that asserts "no refresh happened"
passes just as well when the poll never ran. S16 therefore also asserts `pollFired &&
reloadHappened` before it is allowed to report PASS.

### Why the clear lives in `finalize` and not in the render

The first cut of this fix consumed the flag at the end of `renderCurrentEdition()`. That is
correct on the happy path and **wrong on the error path**: `reloadCurrentDateOnly()` falls back
to `loadData()`, and if that also fails there is no `data$` emission, so no render, so the flag
stays `true` — and from that moment on **every** user navigation is silently gated and the ads
never refresh again for the rest of the session. A dropped connection would have been enough.
That is a worse bug than the one being fixed, and no scenario test would have caught it.

Set and cleared at the same site instead, so the two cannot drift:

```ts
this.pollDrivenReload = true;
this.dataService.reloadCurrentDateOnly(this.selectedDate)
  .pipe(finalize(() => { this.pollDrivenReload = false; }))
  .subscribe();
```

This is safe because the reload emits its `data$` update **synchronously** inside `tap()`
(newspaper-data.service.ts:972-984) and the `data$` subscriber has no async operators
(newspaper.component.ts:314) — so the render has already read the flag by the time `finalize`
runs. `finalize` fires on complete **and** on error, which is the point.

One artefact worth not chasing: the fixed run logged `activePage=null` after the poll reload
(`position kept=false`). Not reproducible — the control run reported `position kept=true` with
`activePage=১` preserved. Treated as harness flake, not a defect. If it recurs, it is about
reload position restore and has nothing to do with ads.

## §6.11 Defect: the ad container reserved less space than a creative occupies

Found by re-running S12 after the poll fix. It **refines 4.3**, which measured that an unfilled
slot reserves "exactly its configured `min_height` and nothing more — 240 / 100 / 60 px". That
observation was correct; the conclusion drawn from it — that the reservation is therefore right —
was not. A *filled* slot occupies `min_height` **plus 16 px of padding**, so the reservation was
16 px short all along.

It went unnoticed because seeing it requires the slot to actually fill, and fill is not
deterministic run to run (§4.4 trap 4). On the earlier run the slot in question returned empty
every time, so its box never moved off the placeholder height.

Measured on `desktop_post_preview_top` across 8 samples: `[100, 100, 116, 116, 116, 116, 116,
116]`. A **16 px downward shift** of everything below it, the moment the ad arrived.

Cause is a two-line interaction, neither line wrong by itself:

- `styles.css:123` — a global `* { box-sizing: border-box }`.
- `ad-slot.component.css` — `.dn-ad-container { padding: 8px 0 }` with `min-height` bound from
  the slot config (`ad-slot.component.html`).

Under `border-box`, `min-height: 100px` is the **outer** height, so the 8 px top and bottom
padding eat into the reservation: the empty placeholder is 100 px tall, but the 100 px creative it
was reserving space *for* needs 100 + 16. Every slot whose configured `min_height` equals its
creative height shifts by exactly the vertical padding.

Fix is one declaration, in `.dn-ad-container`:

```css
box-sizing: content-box;   /* deliberately overrides the global border-box */
```

`min-height` now reserves the creative and the padding sits outside it. Verified — same test, same
8 samples: `[116, 116, 116, 116, 116, 116, 116, 116]`, `slots whose box height varied: 0`, errors
`(none)`. `desktop_page_left` reads 256 and `desktop_post_preview_middle` 266, both constant.

**What it costs**, measured, not assumed: empty placeholders grow by 16 px. `desktop_page_left`
went 240 → 256 (S7 and S12 agree). That slot never fills (§1.7), so this is 16 px of additional
dead space on a unit that is already dead space, and it is disabled in the live config anyway.
Accepted: a permanent 16 px on an empty placeholder is worth less than a 16 px jump under the
reader's eye every time an ad lands. No filled ad's rendering changes.

**Why the test did not catch this the first time.** S12's pass condition was
`st.errs.length === 0` — it *logged* the varying heights but never asserted on them, so the
finding sat in the output while the verdict was decided by unrelated console noise. Both halves
are fixed: S12 now asserts `varying.length === 0`, and the third-party noise is filtered (§6.2).
The lesson generalises — **a measurement that is printed but not asserted is not a test.**

## §6.12 The verification ran against production — why, and what it does and doesn't prove

Every measurement in this document was taken with the **locally-built `dist/` injected into the
production origin**. That is a compromise, not a preference, and it should be understood before
anyone relies on the numbers.

**Why it was done that way**

1. **GAM keys ad serving to the registered domain.** From `localhost` no creative arrives at
   all, so every question of the form "does this slot fill / at what height / with which
   creative id" is unanswerable off the real origin.
2. **The staging backend does not answer.** A staging environment *is* configured —
   `src/environments/environment.staging.ts` points at `https://nepaper.dailysangram.com/wp`, with
   `npm run build:staging` / `serve:staging` wired up. But it is unreachable: DNS resolves
   (`70.32.23.108`) and every connection times out, on both `/wp/?rest_route=…/data/version` and
   the bare host. So the option existed on paper and not in practice.

   Two open questions for whoever owns that host, in 6.6:
   - Is `nepaper` meant to be up? If it is, most of this suite should point there instead.
   - Is `nepaper` an **approved GAM domain**? Ad serving is per-domain, so even a healthy staging
     host only replaces the fill-dependent runs if GAM will serve to it.

   Independently of staging: the **dev** environment's `wpBaseUrl` points at *production*
   (`epaper`), so plain `ng serve` and the local admin panel both edit the live site. The harness
   inherited that; it did not introduce it. See the risk note below.

**Containment that was applied**

- `/ads/config` GET answered from a local snapshot (`adcfg.json`), never the live value.
- The config **POST aborted at the network layer**, so no run could ever flip GAM settings,
  enable a slot, or otherwise mutate the live site. This matters: toggling ads off in that admin
  panel would disable ads for real visitors.
- Everything else is a GET, and cached.

**What was not contained, and is a genuine cost**

The `/gampad/ads` requests are **real**. A few hundred impressions from automated navigation
landed in the live network's reporting across Phases 1–6. They will slightly skew fill-rate and
CTR for the affected units in that window, and automated navigation is the shape of thing Google
classifies as invalid traffic. Routed to 6.7 for disclosure rather than left implicit.

**What this does and does not undermine**

| | Needs prod? | Used for |
|---|---|---|
| refresh counts, batch membership, `display()` counts, `document.hidden`, targeting accumulation, collapse recovery, layout stability, URL form | **no** — needs GPT loaded, not prod data | **every PASS/FAIL assertion in the suite** |
| whether a creative arrives, at what height, with which id | **yes** | the descriptive findings in §1.7 and §4.4 only |

So the verdicts rest on the first row and would hold against any backend. The production origin
bought the second row — the inventory-gap and creative-size findings, which are precisely the
ones handed to the network owner in 6.7 and which no local stub could have produced.

**Standing risk, beyond this task:** dev pointing at production means any developer running the
admin panel locally is editing the live site. The fix is small — point `environment.ts` at
`nepaper` like `environment.staging.ts` already does, and require an explicit opt-in to aim dev at
production — but it is a change to everyone's local workflow, not an ad fix, so it is flagged here
rather than made silently. It is also moot until `nepaper` answers.

---

## Compliance guardrails — non-negotiable

Google Ad Manager treats mechanical ad refresh as invalid traffic. These hold for the life of
the codebase, not just this task:

1. **Refresh only on genuine user action**, or on a **≥30 s** dwell timer. Every trigger in
   Phase 2 is a direct user action.
2. **Never** add `setInterval`-driven refresh without a ≥30 s floor.
3. **Always** bail when `document.hidden`.
4. Never refresh a slot that is not visible (`isVisible()` guard).

---

## Files touched, by phase

| File | P1 | P2 | P3 | P4 | P5 | P6 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `src/app/services/gam.service.ts` *(new)* | ● | ● | ● | | | |
| [`src/app/services/ad.service.ts`](src/app/services/ad.service.ts) | ● | | | | | |
| [`src/app/components/ad-slot/ad-slot.component.ts`](src/app/components/ad-slot/ad-slot.component.ts) | ● | | ● | | | |
| [`src/app/newspaper.component.ts`](src/app/newspaper.component.ts) | | ● | | | | ● |
| `ad-slot.component.css` | | | ● | | | ● |
| [`wordpress-plugin/.../digital-newspaper.php`](wordpress-plugin/digital-newspaper/digital-newspaper.php) | | | | | ○ | |
| `newspaper.component.html` | | | | | ○ | |

● changed  ○ only if the corresponding decision goes that way

Phase 4 ended up touching **no** files: its one code candidate (`ad.service.ts`, lazy loading) was
implemented, measured, and reverted — see §4.4.

Phase 6 was meant to touch none either. It touched two files because the gate did its job:
`newspaper.component.ts` for the version-poll defect (§6.10) and `ad-slot.component.css` for the
16 px reservation defect (§6.11). Both were pre-existing and neither was caught by any earlier
phase.

**Not touched in any phase:** `admin.component.ts` (reads `AdService`'s unchanged public API),
routing, data services, the image pipeline, i18n, or any existing CSS.

---

## Rollback

Each phase is an independent commit. Phase 1 is the only one that changes ad *loading*
behaviour and is therefore the highest-risk revert target.

Immediate production kill switch, no rebuild required: **GAM off** in the admin panel. This
sets `enabled: false` on `/ads/config`, `slotEnabledMap()` empties, every `app-ad-slot`
collapses, and `_bootGpt()` is never reached — `gpt.js` is not even loaded.

**This only became true in step 0.6.** Before the RC-11 fix, five of the seven rendered slots
ignored the global flag entirely. Any deployment that predates the RC-11 fix does **not** have
a working kill switch — check that the fix is present before relying on this rollback path.
