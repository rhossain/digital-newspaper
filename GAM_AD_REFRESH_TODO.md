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

### 1.5 Phase 1 regression checklist (remaining manual items)

Test with ads **enabled** in admin, on desktop (≥768 px) unless noted.

- [ ] Fresh load: left rail, and either the right ad or the placeholder, render as before.
- [ ] Thumbnail list still appears when `desktop_page_left` is **disabled**
      ([`newspaper.component.html:368-371`](src/app/newspaper.component.html#L368-L371)).
- [ ] Lazy thumbnail loading via `IntersectionObserver` still works (scroll the left panel).
- [ ] Click a section in the center panel → right panel opens, preview ads fill.
- [ ] **Key fix:** open the image modal, close it, open it again → **the modal ad fills on
      the second and third open.** This is the headline verification for Phase 1.
- [ ] **Key fix:** open the right panel, close it (click a thumbnail) → `desktop_page_right`
      fills again.
- [ ] Content modal (text) ad fills on repeat opens.
- [ ] **Do not** rely on the console to detect duplicate-`display()` failures — per
      **Correction 3** / Appendix A.5, current GPT swallows them silently with no warning.
      Verify by **counting network requests to `securepubads` instead**: opening the modal on
      three different articles must produce **three** new ad requests, where the pre-fix
      baseline produced **one** (11 → 11 → 11).
- [ ] No `MutationObserver` growth after 10 modal open/close cycles (check retained
      listeners in DevTools Memory).
- [ ] Turn GAM **off** in admin → all ad space collapses, thumbnails/placeholder return, no
      console errors.
- [ ] Admin ad-manager panel loads, toggles individual slots, and saves.
- [ ] `npm run build` succeeds (this exercises the SSR/prerender path — an unguarded
      `window` reference will fail here, not in `ng serve`).
- [ ] Mobile viewport (<768 px): layout is byte-for-byte identical to before. Desktop slots
      are still hidden. *(The wasted mobile requests of RC-8 are unchanged in this phase —
      that is Phase 2.)*

---

## Phase 2 — Coalesced, targeted refresh (fixes RC-1, RC-2, RC-5, RC-6, RC-8)

**Goal:** slots whose container **persists** across a content change fetch a new, correctly
targeted creative. Slots that unmount/remount are already handled by Phase 1 and must not be
double-refreshed.

### 2.1 Extend `GamService` with refresh

- [ ] **2.1.1** Add `requestRefresh(targeting: Record<string, string>, ids?: string[]): void`.
  - Add the ids (or all live ids) to a `pending: Set<string>`.
  - Store `pendingTargeting`.
  - Debounce with `clearTimeout` / `setTimeout(..., 250)`.
  - Comment the 250 ms choice: long enough to coalesce a burst of clicks and let the DOM swap
    settle, short enough that the ad turns over while the user is still on the new content.

- [ ] **2.1.2** Implement the private `flush()` with all four guards, in this order:
  1. `if (this.document.hidden) return;` — never refresh a backgrounded tab (policy).
  2. Skip ids absent from `live` — the container unmounted during the debounce window.
     **This is what prevents double-counting with Phase 1's mount-time `display()`.**
  3. Skip when `!isVisible(el)` — **fixes RC-8**, the hidden-desktop-slots-on-mobile waste.
  4. Skip when `now - lastRefreshedAt < 5000` — per-slot floor against rapid pagination
     clicking. A slot registered in Phase 1 gets `lastRefreshedAt = Date.now()` at
     registration, so it **cannot** be refreshed within 5 s of its initial fill.

- [ ] **2.1.3** Implement `isVisible(el)`:
  ```ts
  return el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  ```
  `offsetParent` is `null` for any `display: none` subtree, which is exactly the condition the
  desktop/mobile CSS creates — no `matchMedia` duplication of the breakpoint needed.
  **Must not break:** do not use `IntersectionObserver` here; a slot scrolled out of the
  panel is still legitimately refreshable.

- [ ] **2.1.4** Implement `applyTargeting(gptSlot, t)`:
  ```ts
  gptSlot.clearTargeting();
  Object.entries(t).forEach(([k, v]) => v && gptSlot.setTargeting(k, v));
  ```
  **`clearTargeting()` is mandatory** — `setTargeting` accumulates per key, so without it
  targeting degrades to `page=[1,2,3,…]` after a few navigations.

- [ ] **2.1.5** Issue exactly one batched refresh per flush:
  ```ts
  gt.pubads().refresh(batch.map(e => e.gptSlot), { changeCorrelator: true });
  ```
  `changeCorrelator: true` makes GAM treat this as a new pageview so frequency caps,
  competitive exclusions, and roadblocks are evaluated fresh.

- [ ] **2.1.6** Apply the same targeting map in `register()` (Phase 1.1.3) so first-load ads
  and refreshed ads are targeted consistently. This requires passing targeting into
  `register()` — extend its signature now rather than reaching back into the component.

- [ ] **2.1.7** Add `ngOnDestroy` to `GamService` (or use `DestroyRef`) to `clearTimeout` the
  pending debounce. A root-provided service outliving a timer is harmless in the browser but
  will hang an SSR render.

### 2.2 Wire the triggers in `NewspaperComponent`

- [ ] **2.2.1** Add a private `adTargeting()` returning the key-values. Use the **verified**
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

- [ ] **2.2.2** Add a private `notifyAdContentChanged()` that calls
  `this.gam.requestRefresh(this.adTargeting())`.

- [ ] **2.2.3** Call it from **`selectPage()`** ([line 825](src/app/newspaper.component.ts#L825))
  — one line, at the **end** of the method, after all state is assigned.
  Per Correction 1 this single call covers pagination buttons, thumbnails, linked-section
  jumps, deep links, and initial load.
  **Must not break:** place it after `updateUrl()` so targeting reflects final state.
  **Note:** on initial load this fires while slots are registering; guard 2.1.2 (id not yet
  in `live`) and guard 2.1.4 (5 s floor) both suppress it. No wasted request.

- [ ] **2.2.4** Call it from **`selectSection()`** ([line 1296](src/app/newspaper.component.ts#L1296)),
  also at the end. This covers Scenario 2 (center-panel selection).
  **Note:** `selectPage()` calls `selectSection()` at line 849, so both fire on a
  targeted page change — the 250 ms debounce coalesces them into **one** refresh. This is the
  primary reason the debounce exists.

- [ ] **2.2.5** Call it from **`onEditionChange()`**
  ([line 773](src/app/newspaper.component.ts#L773)) and **`onDatePickerChange()`**
  ([line 768](src/app/newspaper.component.ts#L768)). Both already funnel into a reload that
  ends in `selectPage()`, so this may be redundant — **verify before adding**, and skip if the
  `selectPage()` hook already covers them. Redundant calls are harmless (debounced) but dead
  code is not.

- [ ] **2.2.6** Do **not** add a trigger for modal opens (`openImageModal` line 1482,
  `openLinkedSectionImage` line 1706, `openContentModal` line 1458). Phase 1 already gives
  those slots a fresh `defineSlot` + `display` per mount, which **is** a new ad request.
  Adding a refresh here would double-request. The registry makes this automatic: unmounted
  slots are not in `live`.

- [ ] **2.2.7** Consider deferring the preview-slot refresh to `onSectionImageLoad()`
  ([line 1367](src/app/newspaper.component.ts#L1367)) so the ad and the article image settle
  together instead of causing two reflows. Evaluate visually in 2.3; only adopt if the double
  reflow is actually perceptible — otherwise it is unnecessary coupling.

### 2.3 Phase 2 regression checklist

- [ ] **Scenario 1:** click through pagination `1 → 2 → 3`. The left-rail ad turns over.
      Network shows **one** `securepubads` request per navigation, not one per slot per click.
- [ ] **Scenario 1 (burst):** click 6 pagination numbers rapidly → **at most one** refresh
      request fires (debounce + 5 s floor).
- [ ] **Scenario 2:** select three different articles from the center panel on one page →
      the preview ads turn over each time.
- [ ] **Scenario 3:** modal ads still fill on every open, and **no** extra refresh request
      accompanies the modal's own `display()` (verify in the Network panel).
- [ ] Targeting is present and correct: in the GPT console, confirm each refreshed slot's
      key-values reflect the current page/section, and that **no key has accumulated
      multiple values**.
- [ ] Background the tab, navigate via keyboard, return → no refresh fired while hidden.
- [ ] **Mobile viewport:** navigate pages. **Zero** ad requests for the hidden desktop slots
      (this is the RC-8 fix). Confirm in the Network panel.
- [ ] No layout shift or flicker during refresh; the reserved box does not collapse.
- [ ] Section image loading, skeletons, and the slow-connection warning
      ([`newspaper.component.html:625`](src/app/newspaper.component.html#L625)) behave exactly
      as before.
- [ ] URL still updates correctly via `replaceState` on every navigation.
- [ ] `npm run build` succeeds.

---

## Phase 3 — Re-arm the Heavy-Ad observer (fixes RC-7)

**Why after Phase 2:** RC-7 only becomes an observable bug once refresh exists. Doing it
earlier would be untestable.

- [ ] **3.1** In `GamService`, register a single `pubads().addEventListener('slotRenderEnded', …)`
  and expose it to components — either as an RxJS `Subject` or by letting `AdSlotComponent`
  attach its own filtered listener. **Prefer one service-level listener** that dispatches by
  `ev.slot.getSlotElementId()`; N listeners for N slots each doing an id comparison is
  wasteful and harder to tear down.

- [ ] **3.2** In `AdSlotComponent`, on a `slotRenderEnded` for its own div:
  - `this.removedByBrowser.set(false)` — un-poison the slot.
  - Re-run `_observeForHeavyAdRemoval(container, slot.div)` to re-arm the observer.

- [ ] **3.3** Use `ev.isEmpty` from the event to detect genuine empty fills. This is far more
  reliable than the current "no iframe present" heuristic and can replace part of
  [`_observeForHeavyAdRemoval`](src/app/components/ad-slot/ad-slot.component.ts#L156-L187).
  **Must not break:** keep the `iframeWasPresent` invariant
  ([lines 159-183](src/app/components/ad-slot/ad-slot.component.ts#L159-L183)) for the
  Heavy-Ad case specifically — that guard exists because GPT builds the ad in multiple DOM
  steps and a naive check produced false-positive collapses. Do not remove it.

- [ ] **3.4** Ensure the listener is removed on service teardown.

### Phase 3 regression checklist

- [ ] A slot collapsed by Chrome's Heavy Ad Intervention **recovers** on the next refresh
      instead of staying hidden for the session.
- [ ] An empty-fill slot still collapses (or holds reserved space, per the
      `collapseEmptyDivs(false)` decision) exactly as before.
- [ ] No false-positive collapses during normal ad load — navigate 20 pages and confirm no
      slot ever collapses while an iframe is present.

---

## Phase 4 — Performance and viewability polish

Independent of correctness; ship only after Phases 1–3 are verified.

- [ ] **4.1** Add `pubads().enableLazyLoad({ fetchMarginPercent: 100, renderMarginPercent: 50, mobileScaling: 2.0 })`
  in `_bootGpt()`. Deliberately deferred from Phase 1 because it changes *when* ads fetch and
  would confound earlier regression testing.
  **Verify:** above-the-fold slots still fill immediately on load.

- [ ] **4.2** Address the variable-height container for `desktop_post_middle`, which declares
  sizes from `300×100` to `336×280`
  ([`digital-newspaper.php:664`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L664)).
  Its box **will** resize between refreshes. Either pin the container to the tallest declared
  size or accept the shift — measure CLS before deciding, and do not change the CSS on
  assumption alone.

- [ ] **4.3** Confirm `collapseEmptyDivs(false)` is the right call against the existing
  `min-height` reservation. These two interact; verify no double-reserved blank space appears
  where a slot is unfilled.

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
  left-rail ad — currently mutually exclusive. Confirm whether that is intended; it determines
  whether `desktop_page_left` needs refresh-on-page-change at all.

---

## Phase 6 — Pre-merge gate

- [ ] **6.1** Full manual pass of all four requested scenarios on desktop and mobile.
- [ ] **6.2** GPT console clean: no `display` warnings, no `defineSlot` returning `null`, no
      duplicate-div errors.
- [ ] **6.3** Network panel: request count per navigation is bounded and matches expectation.
- [ ] **6.4** `npm run build` (includes `scripts/compress-dist.js`) succeeds.
- [ ] **6.5** Ads **off** in admin: site behaves exactly as a no-ads build. No GPT requests at
      all, thumbnails and placeholder render normally.
- [ ] **6.6** Confirm with the GAM network owner that (a) the targeting keys exist, and
      (b) refresh is expected on these units — some direct-sold line items are priced on a
      no-refresh assumption.
- [ ] **6.7** Re-read [GAM_AD_REFRESH_ANALYSIS.md](GAM_AD_REFRESH_ANALYSIS.md) §4 policy
      notes: every trigger must be user-initiated. Confirm no `setInterval` auto-refresh crept
      in, and that the `document.hidden` guard is present.

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

| File | P1 | P2 | P3 | P4 | P5 |
|---|:-:|:-:|:-:|:-:|:-:|
| `src/app/services/gam.service.ts` *(new)* | ● | ● | ● | | |
| [`src/app/services/ad.service.ts`](src/app/services/ad.service.ts) | ● | | | ● | |
| [`src/app/components/ad-slot/ad-slot.component.ts`](src/app/components/ad-slot/ad-slot.component.ts) | ● | | ● | | |
| [`src/app/newspaper.component.ts`](src/app/newspaper.component.ts) | | ● | | | |
| `ad-slot.component.html` / `.css` | | | | ○ | |
| [`wordpress-plugin/.../digital-newspaper.php`](wordpress-plugin/digital-newspaper/digital-newspaper.php) | | | | | ○ |
| `newspaper.component.html` | | | | | ○ |

● changed  ○ only if the corresponding decision goes that way

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
