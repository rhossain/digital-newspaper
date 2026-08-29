# Google Ad Manager — Dynamic Ad Refresh: Diagnosis & Solution Design

**Date:** 2026-08-29
**Branch:** `daily-sangram`
**Site:** epaper.dailysangram.com
**GAM network:** `22062727803`
**Status:** Analysis complete — no code changed yet.

---

## Problem statement

Once a Google Ad Manager (GAM) ad loads, it never refreshes unless the entire page is
reloaded. The site updates content dynamically in several ways, and ads must turn over
with that content:

1. **Pagination & thumbnail navigation** — navigating to a new page via the left
   thumbnail panel or the pagination numbers must refresh the right-side ad slot.
2. **Center-section news selection** — selecting an article in the center panel loads its
   details on the right; the right-side ad slot must refresh.
3. **Modal ads from right-panel selection** — clicking a news item opens a modal
   containing an ad slot, which must refresh on each click-through.
4. **All other ad placements** — the same behaviour must apply universally.

---

## 1. What was verified

### 1.1 Slot inventory

Nine slots are defined server-side in
[`digital-newspaper.php:591-698`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L591-L698).
Only seven are actually rendered by the Angular app.

| Slot id | Ad unit | Rendered at | Container lifecycle on content change |
|---|---|---|---|
| `desktop_page_left` | `TDSEV3_Desktop_Page_Left-01` | [`newspaper.component.html:370`](src/app/newspaper.component.html#L370) | **Never destroyed** — lives for the whole session |
| `desktop_page_right` | `TDSEV3_Desktop_Page_Right-01` | [`newspaper.component.html:931`](src/app/newspaper.component.html#L931) | Destroyed when a section is selected, recreated when deselected |
| `desktop_post_preview_top` | `TDSEV3_Desktop_Post_Preview_Top-01` | [`newspaper.component.html:813`](src/app/newspaper.component.html#L813) | **Survives** an article switch on the same page; **destroyed** by a thumbnail/pagination click (see note below) |
| `desktop_post_preview_middle` | `TDSEV3_Desktop_Post_Preview_Middle-01` | [`newspaper.component.html:857`](src/app/newspaper.component.html#L857) | Same as above |
| `desktop_post_top_image` | `TDSEV3_Desktop_Post_Top-01` | [`article-modal.component.html:64`](src/app/components/article-modal/article-modal.component.html#L64) | Destroyed / recreated on every modal close/open |
| `desktop_post_middle` | `TDSEV3_Desktop_Post_Middle-01` | [`article-modal.component.html:77`](src/app/components/article-modal/article-modal.component.html#L77) | Same |
| `desktop_post_top_text` | `TDSEV3_Desktop_Post_Top-01` | [`article-modal.component.html:129`](src/app/components/article-modal/article-modal.component.html#L129) | Same |
| `mobile_post_top` | `TDSEV3_Mobile_Post_Top-01` | — | **Defined in GPT but never rendered anywhere** |
| `mobile_post_middle` | `TDSEV3_Mobile_Post_Middle-01` | — | **Defined in GPT but never rendered anywhere** |

### 1.2 The decisive fact

A grep for `refresh`, `destroySlots`, `setTargeting`, and `clearTargeting` across `src/`
returns **zero GAM-related hits**. There is no refresh mechanism in the codebase at all.
Every slot is `display()`-ed exactly once and then left untouched for the rest of the
session.

> **Correction to the lifecycle table above** (verified while planning implementation —
> see [GAM_AD_REFRESH_TODO.md](GAM_AD_REFRESH_TODO.md) "Pre-flight"): the preview slots
> survive an *article* switch on the same page, but a thumbnail/pagination click calls
> `selectPage(page)` with no `targetSectionId`, which sets `selectedSection = null`
> ([`newspaper.component.ts:855-870`](src/app/newspaper.component.ts#L855-L870)) and
> **destroys** the `@if (selectedSection)` block. So Scenario 1 and Scenario 2 are each hit
> by *both* failure modes (frozen ad **and** permanently-blank remount), not just one.

### 1.3 Relevant files

| File | Role |
|---|---|
| [`src/app/services/ad.service.ts`](src/app/services/ad.service.ts) | Fetches `/ads/config`, injects `gpt.js` + a `<head>` blob of `defineSlot` calls |
| [`src/app/components/ad-slot/ad-slot.component.ts`](src/app/components/ad-slot/ad-slot.component.ts) | Renders one container div, injects a one-shot `display()` script |
| [`src/app/components/ad-slot/ad-slot.component.html`](src/app/components/ad-slot/ad-slot.component.html) | The `#adContainer` div with `min-width` / `min-height` bindings |
| [`src/app/newspaper.component.ts`](src/app/newspaper.component.ts) | Owns all page/section/modal state (2136 lines) |
| [`src/app/components/article-modal/article-modal.component.ts`](src/app/components/article-modal/article-modal.component.ts) | Presentational modal; hosts three ad slots |
| [`wordpress-plugin/digital-newspaper/digital-newspaper.php`](wordpress-plugin/digital-newspaper/digital-newspaper.php) | `gam_ad_slots()` — single source of truth for slot config |

---

## 2. Root cause analysis

### RC-1 — `display()` is called once and nothing ever calls `refresh()` *(primary cause)*

[`ad-slot.component.ts:84`](src/app/components/ad-slot/ad-slot.component.ts#L84) declares a
`_scriptInjected` guard, and the effect bails out permanently once it is set
([`ad-slot.component.ts:120`](src/app/components/ad-slot/ad-slot.component.ts#L120)):

```ts
if (!container || this._scriptInjected) return;
...
script.text = `googletag.cmd.push(function() { googletag.display('${slot.div}'); });`;
```

That guard is *correct* for `display()` — GPT forbids calling it twice for the same slot.
The bug is that nothing else ever tells GPT to fetch a new creative. `display()` fetches
an ad exactly once; only `googletag.pubads().refresh()` re-fetches one.

### RC-2 — Angular `@if` does not recreate on value change, so components never re-init

This is why a full page reload is the only thing that works today.

`@if (selectedSection)` ([`newspaper.component.html:746`](src/app/newspaper.component.html#L746))
and `@if (currentPage)` ([`newspaper.component.html:810`](src/app/newspaper.component.html#L810))
only create or destroy their embedded view on a **truthiness transition**.
`selectSection()` ([`newspaper.component.ts:1296`](src/app/newspaper.component.ts#L1296))
swaps one object for another — truthy → truthy — so the embedded view, the
`AdSlotComponent` instances inside it, and their `_scriptInjected = true` flags all
survive untouched. The same applies to `currentPage = page` at
[`newspaper.component.ts:826`](src/app/newspaper.component.ts#L826).

Consequently, for **Scenario 1** (pagination / thumbnail) and **Scenario 2** (center-panel
article select), the ad components are never even notified that content changed. There is
no input, signal, or event connecting page/section state to `AdSlotComponent`.

### RC-3 — Recreated containers render *blank forever*, which is worse than stale

This is the bug behind **Scenario 3**, and it is more severe than "does not refresh."

GPT's contract: `googletag.display(div)` must be called **at most once per slot per page
load**. When the modal closes, Angular destroys `<div id="div-gpt-ad-1781518880480-0">`.
When it reopens, a *fresh* `AdSlotComponent` (with `_scriptInjected = false`) injects a
*second* `display()` for the same slot. GPT sees the slot as already displayed and does
nothing — **silently**. No console warning is emitted (see the measured evidence in
[Appendix A](#appendix-a--empirical-verification-live-site); the expected
`Ignoring an unnecessary call to display(...)` warning did **not** appear in the current
GPT build, so this failure is invisible in the console and cannot be detected by log
inspection alone).

> **Net effect: modal ads work on the first open of the session and are permanently empty
> on every subsequent open.** Measured: modal ad filled on open #1 (`iframes=1`, 300x266),
> blank on opens #2 and #3 (`iframes=0`, collapsed to 300x60), with **zero** new ad
> requests despite `display()` being re-invoked each time.

The same applies to `desktop_page_right` — once the user opens the right panel and closes
it, that slot is dead for the rest of the session.

### RC-4 — Destroyed divs are never cleaned up in GPT

[`_initGpt`](src/app/services/ad.service.ts#L136-L171) calls `defineSlot` for all nine
slots once in `<head>`, and nothing ever calls `googletag.destroySlots()`. GPT therefore
accumulates slot objects whose containers no longer exist in the DOM. Google's guidance is
explicit: if you remove an ad div from the DOM you must `destroySlots()` it. Without that,
GPT's internal render target is a detached node, and any later `refresh()` would paint into
nothing.

### RC-5 — Even a correct `refresh()` would return the same creative

There is no `setTargeting()` anywhere in the codebase. Every refresh would be an identical
ad request: same ad unit, same sizes, no key-values distinguishing page 1 from page 12, or
article A from article B. GAM would legitimately serve the same line item back, and the
symptom would look unchanged.

**Refresh without targeting fixes the mechanic but not the requirement** ("must refresh
with the new page's content").

### RC-6 — There is no navigation event to hook

Worth flagging before anyone reaches for the obvious SPA solution: this app does **not**
use the Angular Router for content navigation. URLs are rewritten with
`location.replaceState()` at
[`newspaper.component.ts:1957-1964`](src/app/newspaper.component.ts#L1957-L1964).

So the standard recipe — subscribe to `Router.events` / `NavigationEnd` and refresh —
**will never fire**. The trigger must come from the component's own state mutations.

### RC-7 — The Heavy-Ad observer permanently poisons a slot

[`ad-slot.component.ts:156-187`](src/app/components/ad-slot/ad-slot.component.ts#L156-L187)
sets `removedByBrowser.set(true)` and calls `observer.disconnect()`. That signal is only
reset when the slot becomes *disabled*
([`ad-slot.component.ts:111-113`](src/app/components/ad-slot/ad-slot.component.ts#L111-L113)).

Once refresh is introduced, a slot collapsed once by Chrome's Heavy Ad Intervention will
stay `display: none` for the rest of the session, even though a fresh, lightweight creative
has since loaded into it. The observer must be re-armed and the signal reset on every
refresh.

### RC-8 — On mobile, every desktop slot is requested but can never be seen

`display()` is injected regardless of viewport, while the CSS hides
`:host(.dn-ad--desktop)` below 768 px
([`ad-slot.component.css`](src/app/components/ad-slot/ad-slot.component.css)).

A phone user therefore triggers ad requests for seven desktop slots inside `display: none`
containers — wasted requests, 0 % viewability, and the kind of pattern that attracts
invalid-traffic scrutiny. Meanwhile `mobile_post_top` / `mobile_post_middle` are
`defineSlot`-ed and never rendered. Any refresh logic will multiply this waste unless
visibility is checked first.

### RC-9 — Secondary: script-injection surface in `_initGpt`

[`ad.service.ts:156-159`](src/app/services/ad.service.ts#L156-L159) builds executable
JavaScript by string-interpolating `s.unit` and `s.div` straight from the REST response,
with no escaping. (The PHP side uses `esc_js`; the Angular side uses nothing.) A
compromised or misconfigured WordPress option becomes arbitrary JS execution in every
visitor's browser.

The lifecycle rework in Part A below removes this code path entirely, so it is worth fixing
in the same pass rather than as a separate task.

### 2.1 Scenario → cause map

| Scenario | Current behaviour | Causes |
|---|---|---|
| 1. Pagination / thumbnail navigation | Left rail frozen; preview slots blank after first cycle | RC-1, RC-2, RC-3, RC-5 |
| 2. Center-panel article select | Ad stays frozen | RC-1, RC-2, RC-5 |
| 3. Modal ads | **Blank after the first open** | RC-3, RC-4 |
| Right-panel close (`desktop_page_right`) | **Blank after first open/close** | RC-3, RC-4 |
| Mobile (any scenario) | Ads requested, never visible | RC-8 |
| After a Heavy-Ad collapse | Slot hidden for the rest of the session | RC-7 |
| Every modal open/close cycle | One leaked `MutationObserver` on a detached node | RC-10 |

### RC-11 — The global GAM toggle is not a complete kill switch

Discovered while validating the rollback path in Phase 0. `OPTION_GAM_ENABLED` (global) and
`OPTION_GAM_SLOT_STATES` (per-slot) are persisted and updated **independently** by
[`update_ads_config`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L3303-L3320),
and the admin form passes per-slot states through untouched, so turning GAM off globally
leaves every per-slot flag exactly as it was.

`AdSlotComponent` gated rendering on `slot()!.enabled` — the **per-slot** flag only — and
never consulted `adService.enabled()`. Only two of the seven rendered slots
(`desktop_page_left`, `desktop_page_right`) had a global-aware `slotEnabledMap()` gate in
their parent template. The other five — both preview slots and all three modal slots — had
none.

**Effect:** with GAM off globally but per-slot toggles left on, those five slots still
rendered reserved empty divs (60–100 px each), and their injected `display()` script threw
`ReferenceError: googletag is not defined` because `_initGpt` was never called.

**Fixed in Phase 0** by making the `slot` computed return `undefined` when
`adService.enabled()` is false. Both the template `@if` and the `dn-ad--hidden` host binding
derive from that signal, so one change covers both, and the admin toggle becomes a genuine
kill switch — which the rollback plan for all later phases depends on.

### RC-10 — `AdSlotComponent` has no teardown at all

Discovered during implementation planning. The component has **no `ngOnDestroy`**;
`_cleanupObserver` ([`ad-slot.component.ts:87`](src/app/components/ad-slot/ad-slot.component.ts#L87))
is only ever invoked from inside the `effect()`, never on destroy. Every modal open/close
cycle therefore leaks a live `MutationObserver` bound to a detached DOM node. Fixed as a side
effect of adding proper teardown in Phase 1 of the TODO.

---

## 3. Solution design

Two separable changes. **Doing only the refresh half (Part B) will leave the modal slots
blank (RC-3), so both are required.**

### Part A — Move slot lifecycle ownership into the component

Stop defining slots in a `<head>` blob. Let each `AdSlotComponent` define its own slot on
mount and destroy it on unmount. This makes create/destroy cycles correct and eliminates
RC-3, RC-4, and RC-9 at once.

`AdService` keeps only three jobs: fetch config, load `gpt.js`, call `enableServices()` once.

```ts
// ad.service.ts — replaces _initGpt's defineSlot blob
private _bootGpt(): void {
  if (!isPlatformBrowser(this.platformId) || this._gptBooted) return;
  this._gptBooted = true;

  const lib = this.document.createElement('script');
  lib.async = true;
  lib.crossOrigin = 'anonymous';
  lib.src = AdService.GPT_SRC;
  this.document.head.appendChild(lib);

  const w = window as any;
  w.googletag = w.googletag || { cmd: [] };
  w.googletag.cmd.push(() => {
    const pubads = w.googletag.pubads();
    // SRA off: containers mount/unmount independently, so slots can never be
    // batched into one request anyway. Keeping it on only produces GPT warnings.
    pubads.collapseEmptyDivs(false);   // min-height is already reserved in CSS
    pubads.enableLazyLoad({
      fetchMarginPercent: 100,
      renderMarginPercent: 50,
      mobileScaling: 2.0,
    });
    w.googletag.enableServices();
  });
}
```

#### Trade-off: dropping single-request mode (SRA)

Stated explicitly, with numbers, because it is the one architectural concession here.

With seven slots that mount and unmount at different times (modal ads appear seconds after
page ads), SRA was already only batching the 1–3 slots that happened to mount in the same
tick — the other 4–6 were sent as individual requests regardless.

- **Cost of dropping it:** up to 6 extra HTTP/2 requests to `securepubads`, on an
  already-warm connection, roughly 5–15 ms each and fully parallel.
- **Benefit:** correct create/destroy semantics for every slot, which is the actual bug.

If SRA batching is later shown to matter for a specific pairing, the always-mounted slots
(`desktop_page_left`, `desktop_post_preview_top`, `desktop_post_preview_middle`) can be
re-batched in isolation.

#### The slot registry

A small service that becomes the single source of truth for "which slots are live right
now." This is also the answer to request #4 (universal coverage).

```ts
// gam.service.ts
interface LiveSlot {
  id: string;
  gptSlot: any;              // googletag.Slot
  el: HTMLElement;
  lastRefreshedAt: number;
}

@Injectable({ providedIn: 'root' })
export class GamService {
  private readonly live = new Map<string, LiveSlot>();
  private pending = new Set<string>();
  private pendingTargeting: Record<string, string> = {};
  private timer: any = null;

  /** Called by AdSlotComponent once its div is committed to the DOM. */
  register(def: AdSlot, el: HTMLElement, targeting: Record<string, string>): void {
    const gt = (window as any).googletag;
    gt.cmd.push(() => {
      const gptSlot = gt.defineSlot(def.unit, def.sizes, def.div);
      if (!gptSlot) return;                       // duplicate div id — warn loudly in dev
      gptSlot.addService(gt.pubads());
      this.applyTargeting(gptSlot, targeting);
      this.live.set(def.id, { id: def.id, gptSlot, el, lastRefreshedAt: Date.now() });
      gt.display(def.div);                        // exactly one display() per defineSlot
    });
  }

  /** Called from AdSlotComponent.ngOnDestroy. */
  unregister(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    const gt = (window as any).googletag;
    gt.cmd.push(() => gt.destroySlots([entry.gptSlot]));
  }
}
```

> **The invariant to hold onto:** `defineSlot` and `display` are paired 1:1 with the
> container's DOM lifetime, and `destroySlots` runs on teardown. Every "blank ad" symptom in
> this codebase traces back to that pairing being broken.

### Part B — A coalesced, targeted refresh driven by content changes

```ts
// gam.service.ts (continued)

/** Queue a refresh for every live slot; coalesced into one GPT call. */
requestRefresh(targeting: Record<string, string>, ids?: string[]): void {
  (ids ?? [...this.live.keys()]).forEach(id => this.pending.add(id));
  this.pendingTargeting = targeting;

  clearTimeout(this.timer);
  // 250 ms: long enough to swallow a burst of clicks and let the new section
  // image + DOM swap settle, short enough that the ad turns over while the
  // user is still looking at the new content.
  this.timer = setTimeout(() => this.flush(), 250);
}

private flush(): void {
  if (this.document.hidden) return;              // never refresh a backgrounded tab

  const now = Date.now();
  const batch: LiveSlot[] = [];

  for (const id of this.pending) {
    const entry = this.live.get(id);
    if (!entry) continue;                        // container unmounted mid-debounce
    if (!this.isVisible(entry.el)) continue;     // fixes RC-8: skip hidden desktop slots on mobile
    if (now - entry.lastRefreshedAt < 5000) continue;  // per-slot floor, anti-hammer
    batch.push(entry);
  }
  this.pending.clear();
  if (!batch.length) return;

  const gt = (window as any).googletag;
  gt.cmd.push(() => {
    batch.forEach(e => {
      this.applyTargeting(e.gptSlot, this.pendingTargeting);
      e.lastRefreshedAt = now;
    });
    // One call with an array => one ad request for the whole batch.
    gt.pubads().refresh(batch.map(e => e.gptSlot), { changeCorrelator: true });
  });
}

private isVisible(el: HTMLElement): boolean {
  // offsetParent is null for display:none subtrees — cheap, and exactly the
  // condition the desktop/mobile CSS creates.
  return el.offsetParent !== null && el.getBoundingClientRect().height > 0;
}

private applyTargeting(gptSlot: any, t: Record<string, string>): void {
  gptSlot.clearTargeting();                      // must clear, or old keys accumulate
  Object.entries(t).forEach(([k, v]) => v && gptSlot.setTargeting(k, v));
}
```

Two details that matter:

- **`changeCorrelator: true`** tells GAM this is a genuinely new page view, so frequency
  caps, competitive exclusions, and roadblocks are evaluated fresh. Omit it and refreshed
  slots are treated as part of the original pageview.
- **`clearTargeting()` before re-applying** — `setTargeting` *accumulates* values per key,
  so without a clear, slot targeting degrades to `page=[1,2,3,...]` after a few navigations.

### Part C — Wire the triggers

Because there is no Router event (RC-6), the trigger is an explicit call from
`NewspaperComponent` at each state mutation. One private helper, called from each site:

```ts
// newspaper.component.ts
private adTargeting(): Record<string, string> {
  return {
    date:    this.selectedDate ?? '',
    edition: String(this.selectedEditionNumber ?? ''),
    page:    String(this.currentPage?.id ?? ''),
    section: this.selectedSection?.id ?? '',
  };
}

private notifyContentChanged(): void {
  this.gam.requestRefresh(this.adTargeting());
}
```

Call sites:

| Trigger | Method | Line |
|---|---|---|
| Thumbnail / pagination click | `onPageClick()` | [`newspaper.component.ts:781`](src/app/newspaper.component.ts#L781) |
| Center-panel article select | `selectSection()` | [`newspaper.component.ts:1296`](src/app/newspaper.component.ts#L1296) |
| Linked-section jump | `selectLinkedSection()` | [`newspaper.component.ts:1839`](src/app/newspaper.component.ts#L1839) |
| Modal open (image) | `openImageModal()` | [`newspaper.component.ts:1482`](src/app/newspaper.component.ts#L1482) |
| Modal open (linked image) | `openLinkedSectionImage()` | [`newspaper.component.ts:1706`](src/app/newspaper.component.ts#L1706) |
| Modal open (text) | content-modal open path | [`~newspaper.component.ts:1459`](src/app/newspaper.component.ts#L1459) |
| Date / edition change | data-subscription handler | [`~newspaper.component.ts:604-649`](src/app/newspaper.component.ts#L604-L649) |

**Note on the modal slots:** no `requestRefresh` is needed on modal *open* — Part A already
gives them a fresh `defineSlot` + `display` per mount, which is a real new ad request.
`requestRefresh` is only for slots whose container **persists** across the change
(`desktop_page_left`, `desktop_post_preview_top`, `desktop_post_preview_middle`). The
registry handles this automatically: unmounted slots are not in `live`, so `flush()` skips
them.

### Part D — Re-arm the Heavy-Ad observer (RC-7)

`AdSlotComponent` must reset `removedByBrowser` and reconnect its `MutationObserver`
whenever GPT reports a new render into its div, rather than disconnecting for good:

```ts
gt.pubads().addEventListener('slotRenderEnded', (ev: any) => {
  if (ev.slot.getSlotElementId() !== slot.div) return;
  this.removedByBrowser.set(false);
  this._observeForHeavyAdRemoval(container, slot.div);
});
```

`slotRenderEnded` also exposes `ev.isEmpty`, which is a far more reliable empty-fill signal
than watching for a missing iframe — worth using to replace part of the current heuristic in
[`_observeForHeavyAdRemoval`](src/app/components/ad-slot/ad-slot.component.ts#L156-L187).

---

## 4. Implementation best practices

### Timing — refresh *after* the content swap, not with it

The 250 ms debounce in `flush()` handles the common case, but there is a subtlety: the
section image loads asynchronously (`sectionImageLoading`,
[`newspaper.component.ts:1330`](src/app/newspaper.component.ts#L1330)). Refreshing while the
image is still loading means the ad and the article settle at different moments, causing a
visible double reflow.

Prefer firing `notifyContentChanged()` from `onSectionImageLoad()` for the preview slots,
and immediately for the left rail (which is unaffected by image load).

### Flicker and layout shift

Three things, in order of impact:

1. `min-width` / `min-height` are already bound from config
   ([`ad-slot.component.html:5-6`](src/app/components/ad-slot/ad-slot.component.html#L5-L6))
   — keep that, and pair it with `collapseEmptyDivs(false)` so the reserved box never
   collapses mid-session.
   **Caveat:** `desktop_post_middle` declares sizes from `300×100` up to `336×280`, so its
   box *will* resize between refreshes unless the container is pinned to the tallest declared
   size, or `setForceSafeFrame` is used with a fixed wrapper.
2. **Do not call `slot.clear()` before `refresh()`.** `refresh()` swaps the creative in
   place; clearing first produces a visible blank frame.
3. Keep `overflow: hidden` on `.dn-ad-container` (already present) so an oversized creative
   cannot push layout.

### Avoiding double refreshes

Three guards, all inside `flush()`:

- The 250 ms debounce collapses click bursts into one call.
- The 5 s per-slot floor stops a user rapid-firing pagination from generating 12 requests.
- The `live.get(id)` existence check drops slots that unmounted during the debounce window.

A slot that was just `display()`-ed receives `lastRefreshedAt = Date.now()` at registration,
so it cannot be refreshed within 5 s of its initial load.

### Policy compliance — a hard requirement, not a nicety

Google Ad Manager policy allows refresh on **user action** or on a **≥30 s dwell timer**, and
treats mechanical/automatic refresh as invalid traffic. Every trigger in Part C is a direct
user action, which is compliant.

Two rules to hold:

- Never add a `setInterval` auto-refresh without a ≥30 s floor.
- Always bail when `document.hidden`.

Also worth confirming with whoever manages GAM network `22062727803` that refresh is expected
on these units — some direct-sold line items are priced on a no-refresh assumption.

### Viewability

Add `pubads().enableLazyLoad(...)` as shown in Part A, and keep the `isVisible()` gate.
Combined, these stop the mobile waste in RC-8 and improve the viewability rate GAM reports on
the desktop units.

---

## 5. Systematically covering all ad slots

DOM-scanning for `div[id^="div-gpt-ad-"]` is the tempting answer and the wrong one — it
re-derives state GPT already owns and races with Angular's rendering.

**Use the registry as the single source of truth.** Every ad on this site renders through
exactly one component — `AdSlotComponent`. This was verified: all seven usages go through it,
and there are no bare `googletag` calls anywhere outside
[`ad.service.ts`](src/app/services/ad.service.ts) and
[`ad-slot.component.ts`](src/app/components/ad-slot/ad-slot.component.ts).

`GamService.live` is therefore automatically complete and self-maintaining:

- `register()` in the component's mount effect → every new slot enters the map.
- `unregister()` in `ngOnDestroy` → every removed slot leaves it.
- `requestRefresh()` with no `ids` argument → covers every currently-live slot, including
  slots added to the templates a year from now, with zero changes to the refresh logic.

### Two cleanups that fall out of this

1. **`mobile_post_top` and `mobile_post_middle` are dead config** — defined in GPT, rendered
   nowhere. Either place them in the mobile layout (they are the correct answer to RC-8: real
   mobile creatives instead of hidden desktop ones), or remove them from `gam_ad_slots()`.
   Right now they are neither serving nor removed.

2. **A guardrail so this cannot regress.** Since `AdSlotComponent` becomes the only legal way
   to create a slot, a dev-mode assertion in `register()` — warn if `defineSlot` returns
   `null`, which is exactly what happens on a duplicate div id — catches the class of bug that
   already forced the `desktop_post_top` → `_image` / `_text` split
   ([`digital-newspaper.php:639-644`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L639-L644)).

---

## 6. One product question outside the ad plumbing

Scenario 1 describes navigating via the left thumbnail panel *and* refreshing the left-rail
ad. In the current template these are **mutually exclusive**:
[`newspaper.component.html:368-371`](src/app/newspaper.component.html#L368-L371) uses
`@else if`, so when `desktop_page_left` is enabled the ad **replaces the entire thumbnail
list**.

With that slot on, there are no thumbnails to navigate by — only the pagination numbers.
Worth confirming whether that is intended before building against it, since it determines
whether `desktop_page_left` needs refresh-on-page-change at all.

---

## 7. Summary

The ads never refresh because **nothing calls `pubads().refresh()`**, and Angular's `@if`
never recreates the ad components on article or page changes (RC-1, RC-2).

Separately and more urgently: the **modal and right-panel slots go permanently blank after
their first open**, because their divs are destroyed without `destroySlots()` and then hit
with a second, ignored `display()` (RC-3, RC-4). That is currently costing filled impressions
on every session.

A correct refresh also requires per-content **targeting key-values** (RC-5), or GAM will
legitimately serve the same creative back and the symptom will appear unfixed.

### Recommended implementation order

| # | Change | Fixes | Why this order |
|---|---|---|---|
| 1 | Part A — component-owned slot lifecycle | RC-3, RC-4, RC-9 | Recovers impressions that are being lost *today* |
| 2 | Part B + C — coalesced targeted refresh | RC-1, RC-2, RC-5, RC-6, RC-8 | Delivers the four requested scenarios |
| 3 | Part D — re-arm Heavy-Ad observer | RC-7 | Only becomes a live bug once refresh exists |
| 4 | Mobile slot cleanup | RC-8 (fully) | Product decision required first |

---

## Appendix A — Empirical verification (live site)

Measured on **2026-08-29** against `https://epaper.dailysangram.com` (production, pre-fix)
by driving real Google Chrome with Playwright. `googletag.display`, `pubads().refresh`, and
`destroySlots` were wrapped before `gpt.js` loaded in order to count invocations; GAM ad
requests were counted at the network layer (`securepubads` / `gampad/ads`).

This appendix supersedes any conflicting statement earlier in this document.

### A.1 Actual slot inventory — 10 slots, not 7

`googletag.pubads().getSlots()` on a desktop viewport:

| Div id | Ad unit | Filled |
|---|---|---|
| `div-gpt-ad-1781436865448-0` | `TDSEV3_Desktop_Page_Left-01` | blank |
| `div-gpt-ad-1781437781482-0` | `TDSEV3_Desktop_Page_Right-01` | **FILLED** |
| `div-gpt-ad-1781440036290-0` | `TDSEV3_Desktop_Post_Preview_Top-01` | blank |
| `div-gpt-ad-1781441150109-0` | `TDSEV3_Desktop_Post_Preview_Middle-01` | **FILLED** |
| `div-gpt-ad-1781518880480-0` | `TDSEV3_Desktop_Post_Top-01` | blank |
| `div-gpt-ad-1781518880480-1` | `TDSEV3_Desktop_Post_Top-01` | blank |
| `div-gpt-ad-1781519469306-0` | `TDSEV3_Desktop_Post_Middle-01` | **FILLED** |
| `div-gpt-ad-1781520617033-0` | `TDSEV3_Mobile_Post_Top-01` | blank |
| `div-gpt-ad-1781521397082-0` | `TDSEV3_Mobile_Post_Middle-01` | blank |
| `gpt_unit_/22062727803/TDSEV2_Bottom_Anchor_0` | `TDSEV2_Bottom_Anchor` | blank |

**New finding — an out-of-page anchor unit exists that this repo does not manage.**
`TDSEV2_Bottom_Anchor` (desktop) / `TDSEV2_Mobile_Bottom_Anchor` (mobile) are on the **V2**
ad-unit path, are absent from `gam_ad_slots()`, and `grep -rniE 'anchor|TDSEV2'` over
`wordpress-plugin/` and `src/` returns no matches. They therefore originate from GAM-side
configuration (an out-of-page/anchor format enabled in the GAM UI) or another script on the
WordPress site. GPT logs this twice per load:

```
[GPT] Anchor /22062727803/TDSEV2_Bottom_Anchor not requested: Format already created on the page.
https://goo.gle/gpt-message#134
```

Two consequences: (a) the anchor is being created twice and one creation is discarded, and
(b) any refresh implementation must **exclude** out-of-page anchor slots, since anchors
manage their own lifecycle and are not refreshable the same way.

**Note on `-0` / `-1`:** `desktop_post_top_image` and `desktop_post_top_text` are two
distinct WordPress slot ids that intentionally share one ad unit (`Desktop_Post_Top-01`),
which is why GPT reports two div ids for it. This is not a defect.

### A.2 Architectural fact discovered: SRA is enabled

[`inject_gam_head_script`](wordpress-plugin/digital-newspaper/digital-newspaper.php#L704-L735)
calls `defineSlot()` for all nine slots, then `setConfig({singleRequest: true})` and
`enableServices()` — but **never** calls `display()`. Single Request Architecture is
therefore active. This materially constrains the fix: under SRA, slots are batched per
request, so the refresh implementation must call `pubads().refresh([slot])` with an explicit
slot array (never a bare `refresh()`), and must not rely on re-invoking `display()`.

### A.3 Scenario 1 — Pagination: zero ad activity

| Step | GAM ad requests | `display()` calls | `refresh()` |
|---|---|---|---|
| initial load | 8 | 1 | 0 |
| click page 2 | **8** | **1** | **0** |
| click page 3 | **8** | **1** | **0** |

No delta whatsoever. Confirms **RC-1** and **RC-6**.

### A.4 Scenario 2 — Article selection: fires once, then never again

| Step | GAM ad requests | `display()` calls | `refresh()` |
|---|---|---|---|
| before any selection | 8 | 1 | 0 |
| select article A | 10 | 3 | 0 |
| select article B | **10** | **3** | **0** |

The first selection flips `@if (selectedSection)` from falsy to truthy, so the two preview
ad components are created and `display()` runs. The second selection is a **truthy → truthy**
value swap, so Angular does not recreate the views and nothing fires. Confirms **RC-2**
exactly as predicted.

### A.5 Scenario 3 — Modal reopen: `display()` runs but is a silent no-op

Three open/close cycles, each on a *different* article, closing via `.modal-close-button`:

| Step | ad requests | `display()` total | `destroySlots()` | `Desktop_Post_Middle` container |
|---|---|---|---|---|
| modal open #1 | 11 | 5 | 0 | `iframes=1`, **300x266 — FILLED** |
| modal closed | 11 | 5 | 0 | absent from DOM |
| modal open #2 | **11** | **7** | **0** | `iframes=0`, **300x60 — BLANK** |
| modal open #3 | **11** | **9** | **0** | `iframes=0`, **300x60 — BLANK** |

This is the clearest result in the whole investigation. `display()` **is** re-invoked on
every reopen (5 → 7 → 9), yet the ad request count never moves off 11 and the container
renders empty forever. `destroySlots()` is never called, and — contrary to the original
prediction — **no console warning is emitted**. Confirms **RC-3** and **RC-4**.

### A.6 RC-8 — Mobile viewport wastes every desktop impression

At 390x844 with an iPhone user agent, after selecting an article:

```
app-ad-slot hosts in DOM (all four desktop slots):
  class="dn-ad--desktop"  display:none  rect=0x0  iframes=0
```

Yet `display()` was invoked for all four of them, and 7 GAM ad requests were sent. Every one
of those impressions is structurally unviewable (`display:none`, zero area) — measured
**0% viewability** by construction, and a likely invalid-traffic signal. Separately,
`TDSEV3_Mobile_Post_Top-01` and `TDSEV3_Mobile_Post_Middle-01` are defined but were never
displayed on either viewport, confirming they are rendered nowhere in the app.

### A.7 Summary of confirmations

| Root cause | Status |
|---|---|
| RC-1 — `refresh()` never called | **CONFIRMED** — 0 calls across all 9 interactions, both viewports |
| RC-2 — `@if` does not recreate on truthy→truthy | **CONFIRMED** — A.4 |
| RC-3 — recreated containers blank forever | **CONFIRMED** — A.5; correction: fails *silently*, no warning |
| RC-4 — `destroySlots()` never called | **CONFIRMED** — 0 calls |
| RC-6 — no router events to hook | **CONFIRMED** — A.3 |
| RC-8 — desktop slots requested on mobile | **CONFIRMED** — A.6 |
| RC-5, RC-7, RC-9, RC-10, RC-11 | Not observable from outside; established by code inspection |
| **NEW** — unmanaged anchor unit, created twice | **FOUND** — A.1 |
| **NEW** — SRA (`singleRequest: true`) active | **FOUND** — A.2, constrains the fix |
