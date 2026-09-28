import { Injectable, OnDestroy, PLATFORM_ID, inject, isDevMode } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { AdSlot } from './ad.service';

/** Custom key-values sent to GAM alongside an ad request. */
export type AdTargeting = Record<string, string>;

/**
 * Minimal structural types for the parts of the Google Publisher Tag API this
 * service touches. Declared locally rather than pulling in
 * @types/google-publisher-tag: the surface used here is a handful of methods
 * wide, and a local declaration keeps the GPT contract we depend on visible
 * in-repo.
 */
interface GptSlot {
  getSlotElementId(): string;
  getAdUnitPath(): string;
  addService(service: unknown): GptSlot;
  clearTargeting(): GptSlot;
  setTargeting(key: string, value: string): GptSlot;
}

/** The subset of GPT's slotRenderEnded event this app reads. */
export interface SlotRenderEvent {
  slot: GptSlot;
  isEmpty: boolean;
  size: number[] | null;
}

interface PubAdsService {
  refresh(slots: GptSlot[], options?: { changeCorrelator: boolean }): void;
  addEventListener(type: 'slotRenderEnded', listener: (ev: SlotRenderEvent) => void): void;
  removeEventListener(type: 'slotRenderEnded', listener: (ev: SlotRenderEvent) => void): void;
}

interface GoogleTag {
  cmd: Array<() => void>;
  defineSlot(unit: string, sizes: number[][], div: string): GptSlot | null;
  display(div: string): void;
  destroySlots(slots: GptSlot[]): boolean;
  pubads(): PubAdsService;
}

/** A slot that currently has both a live container in the DOM and a GPT slot object. */
interface LiveSlot {
  id: string;
  gptSlot: GptSlot;
  /** The ad container GPT renders into. */
  el: HTMLElement;
  /** The `<app-ad-slot>` host, which carries this app's own collapse class. */
  hostEl: HTMLElement;
  lastRefreshedAt: number;
  /**
   * Whether this slot's first ad request has gone out. False between
   * `defineSlot` and `_flushInitialFetch`, which is the only window in which a
   * live slot has no creative and none on the way.
   */
  initialFetchDone: boolean;
}

/**
 * GamService — owns the GPT slot lifecycle, pairing it 1:1 with container
 * lifetime in the Angular component tree.
 *
 * Why this exists: GPT's `display()` may be called at most once per slot per
 * page load. The previous design defined every slot once in <head> and injected
 * a one-shot `display()` script per container, which meant a container that was
 * destroyed and recreated (modal close/reopen, right panel open/close) issued a
 * second `display()` that GPT silently ignored — leaving the slot permanently
 * blank for the rest of the session. Measured before this change: a modal ad
 * filled on the first open and was empty on every subsequent open, with zero new
 * ad requests despite `display()` being re-invoked.
 *
 * The fix is to make define and destroy symmetric:
 *
 *   container mounts   → defineSlot + addService + display
 *   container unmounts → destroySlots
 *
 * After `destroySlots`, GPT releases the div id, so the next mount can define a
 * genuinely fresh slot and fetch a genuinely new creative.
 *
 * The fetch itself is this service's too. `AdService` calls GPT's
 * `disableInitialLoad()`, so `display()` binds a slot to its div but requests
 * nothing; `_scheduleInitialFetch()` sends the first request explicitly, with a
 * fresh correlator. That correlator is the reason for the whole arrangement —
 * measured in §8.6, a slot mounting mid-session inherited the page's existing
 * pageview and was judged against an auction the earlier slots had already won,
 * which filled the modal's ad 0 times in 16 while the right panel's identical
 * 300x250 demand filled 30 in 30.
 *
 * The service also owns refreshing. Content in this app changes without a
 * document load (pagination, article selection), so a slot that stays mounted
 * would otherwise keep showing the creative it was first given. `requestRefresh`
 * coalesces those content changes into a single targeted `pubads().refresh()`.
 *
 * Bootstrapping (loading gpt.js, `setConfig`, `enableServices`) stays in
 * AdService — this service only manages slots.
 */
@Injectable({ providedIn: 'root' })
export class GamService implements OnDestroy {

  /**
   * Long enough to coalesce a burst of pagination clicks and to let the DOM swap
   * settle, short enough that the ad turns over while the user is still looking
   * at the new content.
   */
  private static readonly REFRESH_DEBOUNCE_MS = 250;

  /**
   * Per-slot floor between ad requests. Also stops a refresh from landing on top
   * of a slot's initial fill: `_flushInitialFetch()` stamps `lastRefreshedAt`
   * when that first request goes out, so a freshly mounted slot is ineligible
   * for this long.
   */
  private static readonly MIN_REFRESH_INTERVAL_MS = 5000;

  /**
   * How long a deferred refresh may keep waiting for its blocker to clear before
   * it is abandoned.
   *
   * Every deferral in `_flush()` waits on something that normally resolves in
   * well under a second — a cooldown expiring, a `defineSlot` draining out of
   * `googletag.cmd`, a backgrounded tab coming forward. This bounds the ones that
   * never resolve: gpt.js blocked by an extension leaves ids in `claimed` that
   * never reach `live`, and a tab left in the background for an hour should not
   * fire a refresh for a navigation the reader has long forgotten.
   */
  private static readonly MAX_DEFER_MS = 30_000;

  private readonly platformId = inject(PLATFORM_ID);
  private readonly document   = inject(DOCUMENT);

  /** Slots whose GPT object has been created. Populated inside the GPT command queue. */
  private readonly live = new Map<string, LiveSlot>();

  /**
   * Slot ids that have been claimed by a mounted container but whose `defineSlot`
   * may not have run yet.
   *
   * This is tracked separately from `live` because `register()` returns
   * immediately while the actual definition happens later, inside
   * `googletag.cmd`. Two things depend on the distinction:
   *
   *  - the double-registration guard must be synchronous, or two containers
   *    mounting in the same tick would both queue a `defineSlot`;
   *  - a container that unmounts before the queue drains (open and close a modal
   *    quickly) must be able to cancel its pending definition, otherwise GPT
   *    would define a slot for a div that no longer exists.
   */
  private readonly claimed = new Set<string>();

  /**
   * Slot ids awaiting the next coalesced refresh, mapped to the time the content
   * change that asked for them happened.
   *
   * The timestamp is what makes deferral safe. `_flush()` puts an id back here
   * when its blocker is temporary, so without a record of when the *user* acted
   * there would be nothing to expire against and a permanently blocked id would
   * re-arm the timer forever.
   */
  private readonly pending = new Map<string, number>();

  /**
   * Removes the `visibilitychange` listener, or null when none is attached.
   *
   * Attached lazily, on the first flush that lands in a hidden tab, because the
   * common case never needs it.
   */
  private visibilityCleanup: (() => void) | null = null;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesces the first ad request across every slot mounting in one tick. */
  private initialFetchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Targeting for the content currently on screen, owned here rather than passed
   * through `register()`.
   *
   * `AdSlotComponent` is a generic host that knows nothing about pages or
   * articles, while the component that *does* know is not the one mounting the
   * slot. Keeping the value on the service means the initial `display()` and
   * every later `refresh()` read from one place, so a slot that mounts mid-session
   * (a modal ad) is targeted the same way as one refreshed in place.
   */
  private targeting: AdTargeting = {};

  /** Per-slot render callbacks, keyed by slot id. */
  private readonly renderListeners = new Map<string, (ev: SlotRenderEvent) => void>();

  /**
   * Slots the component has collapsed — by Chrome's Heavy Ad Intervention, or
   * because GAM answered the last request empty.
   *
   * Tracked here because such a slot is `display: none`, which the visibility
   * guard would otherwise read as "not worth refreshing" — and refreshing is
   * precisely how it recovers. Without this the collapse would be permanent: no
   * refresh, so no new render, so nothing to un-collapse it. That applies to
   * both causes: a no-fill retry is only worth queueing if it can survive
   * guard 3 while the slot it is trying to fill is hidden.
   */
  private readonly collapsed = new Set<string>();

  /**
   * The one GPT-level `slotRenderEnded` listener, or null if not yet attached.
   * One listener dispatching by element id, rather than one per slot each doing
   * its own id comparison — GPT calls every registered listener for every slot.
   */
  private gptRenderListener: ((ev: SlotRenderEvent) => void) | null = null;

  /**
   * Define, display and fetch a GPT slot for a container that has just been
   * committed to the DOM. Safe to call when gpt.js has not finished loading — the
   * work is queued on `googletag.cmd`.
   */
  register(def: AdSlot, el: HTMLElement, hostEl: HTMLElement): void {
    if (!isPlatformBrowser(this.platformId)) return;

    if (this.claimed.has(def.id)) {
      if (isDevMode()) {
        console.warn(
          `[GamService] Slot "${def.id}" is already registered. ` +
          `Each slot id may be rendered at most once at a time.`
        );
      }
      return;
    }
    this.claimed.add(def.id);

    const gt = this._googletag();
    if (!gt) return;

    gt.cmd.push(() => {
      // Unregistered while this callback sat in the queue — the container is
      // already gone, so defining a slot for it would leak a GPT object.
      if (!this.claimed.has(def.id)) return;

      const gptSlot = gt.defineSlot(def.unit, def.sizes, def.div);

      // GPT returns null when the div id is already bound to another slot. That
      // means a previous slot was not destroyed, so the pairing invariant is
      // broken somewhere upstream.
      if (!gptSlot) {
        this.claimed.delete(def.id);
        if (isDevMode()) {
          console.warn(
            `[GamService] defineSlot returned null for "${def.id}" (div "${def.div}"). ` +
            `The div id is still bound to an undestroyed slot.`
          );
        }
        return;
      }

      gptSlot.addService(gt.pubads());
      this._applyTargeting(gptSlot, this.targeting);

      // Register before display() so that a slotRenderEnded listener firing
      // synchronously can already find this slot in the map.
      this.live.set(def.id, {
        id: def.id,
        gptSlot,
        el,
        hostEl,
        lastRefreshedAt: Date.now(),
        initialFetchDone: false,
      });

      // Still required — `display()` is what binds the slot to its div and lets
      // GPT render into it. Since `disableInitialLoad()`, it no longer fetches;
      // `_scheduleInitialFetch()` below does that.
      gt.display(def.div);
    });

    this._scheduleInitialFetch();
  }

  /**
   * Coalesce the first ad request for every slot that mounted in this tick, and
   * send it as one `refresh` with a fresh correlator.
   *
   * One request per mount *group*, not per slot: the modal mounts two containers
   * in the same tick and single-request mode is meant to batch them. A timeout of
   * 0 is enough — Angular commits the whole template synchronously, so every
   * container in that render has already called `register()` by the time this
   * runs.
   *
   * Deliberately **not** routed through `_flush()`. Those guards exist to decide
   * whether a *content change* justifies re-requesting an ad, and none of them
   * apply to a slot that has never had one: a first impression in a backgrounded
   * tab is an ordinary page load rather than mechanical refresh, and holding it
   * behind the 5 s rate floor or the visibility guard would simply lose it. This
   * is the `display()`-time fetch that `disableInitialLoad()` took away, put back
   * under our control.
   */
  private _scheduleInitialFetch(): void {
    if (this.initialFetchTimer !== null) return;
    this.initialFetchTimer = setTimeout(() => {
      this.initialFetchTimer = null;
      this._flushInitialFetch();
    }, 0);
  }

  private _flushInitialFetch(): void {
    const gt = this._googletag();
    if (!gt) return;

    gt.cmd.push(() => {
      // Read `live` inside the queue callback, not outside: the `defineSlot`
      // calls this batch is waiting on are queued ahead of it, so the map is
      // only complete once GPT gets here.
      const batch = [...this.live.values()].filter(entry => !entry.initialFetchDone);
      if (batch.length === 0) return;

      const now = Date.now();
      for (const entry of batch) {
        entry.initialFetchDone = true;
        entry.lastRefreshedAt = now;
      }

      // changeCorrelator makes this mount its own pageview — the whole point of
      // §8.6. Without it these slots would be judged against the auction whatever
      // mounted before them already won.
      gt.pubads().refresh(batch.map(entry => entry.gptSlot), { changeCorrelator: true });
    });
  }

  /**
   * Destroy the GPT slot for a container that is being removed from the DOM.
   * A no-op for an unknown id by design, so callers can invoke it
   * unconditionally during teardown.
   */
  unregister(id: string): void {
    if (!isPlatformBrowser(this.platformId)) return;

    // Cancels a definition still sitting in the GPT command queue.
    this.claimed.delete(id);
    this.collapsed.delete(id);
    // Drop any deferred refresh for this slot. A remount defines a fresh slot and
    // displays it, which is already a new ad request — letting the old deferral
    // survive would fire a second one the moment the cooldown expired.
    this.pending.delete(id);

    const entry = this.live.get(id);
    if (!entry) return;

    // Remove from the map before queueing, so a remount in this same tick
    // cannot observe an entry that is about to be destroyed.
    this.live.delete(id);

    const gt = this._googletag();
    if (!gt) return;

    gt.cmd.push(() => {
      gt.destroySlots([entry.gptSlot]);
    });
  }

  /**
   * Set the key-values for the content on screen without asking for a refresh.
   *
   * For the first render of a session, where there is no previous content and so
   * nothing to refresh *from*: the slots are registering at this moment and their
   * mount-time `display()` is the session's first impression. Seeding targeting
   * here is what lets that first fetch be targeted, instead of going out with
   * `{}` and being corrected by a second, duplicate ad request moments later.
   *
   * Only affects slots that have not yet been defined. A slot already live keeps
   * the targeting it fetched with until something refreshes it — which is the
   * point: this call must never itself cause a network request.
   */
  primeTargeting(targeting: AdTargeting): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.targeting = targeting;
  }

  /**
   * Note that the on-screen content changed, so the mounted ad slots should be
   * re-requested with fresh targeting.
   *
   * Callers fire this freely on every navigation; the debounce and the guards in
   * `_flush()` decide what actually goes to the network. `ids` narrows the batch
   * to specific slots — omit it to consider everything currently mounted.
   */
  requestRefresh(targeting: AdTargeting, ids?: string[]): void {
    if (!isPlatformBrowser(this.platformId)) return;

    this.targeting = targeting;
    const now = Date.now();
    // Default to `claimed` rather than `live`: a slot mid-definition when this is
    // called will be live by the time the debounce elapses.
    //
    // An id already pending keeps its original timestamp: a burst of clicks is
    // one content change as far as the reader is concerned, and re-stamping would
    // let a slot that never becomes refreshable outlive MAX_DEFER_MS.
    for (const id of ids ?? this.claimed) {
      if (!this.pending.has(id)) this.pending.set(id, now);
    }

    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this._flush(), GamService.REFRESH_DEBOUNCE_MS);
  }

  /**
   * Ask for one more ad request for a slot GAM answered empty.
   *
   * Separate from `requestRefresh` because a no-fill retry is not a content
   * change: the key-values already on the slot are still the right ones, and a
   * caller that knows only "this slot came back empty" has no business
   * re-stamping `this.targeting` for every other slot in the batch.
   *
   * Everything else is shared on purpose. The retry joins the same `pending`
   * map and passes the same guards, so it is still dropped when the container
   * has unmounted, still held while the tab is backgrounded, and still batched
   * with anything else due at that moment rather than firing its own request.
   *
   * Ignored for a slot that is not claimed: an empty render for a container
   * that has since unmounted has nothing to retry into.
   */
  requestRefill(id: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (!this.claimed.has(id)) return;

    // Leaves an earlier timestamp alone. A content change already queued for
    // this slot will fetch anyway, which is exactly what the retry wanted, and
    // re-stamping would push its MAX_DEFER_MS deadline out.
    if (!this.pending.has(id)) this.pending.set(id, Date.now());

    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this._flush(), GamService.REFRESH_DEBOUNCE_MS);
  }

  /**
   * Be told when GPT finishes rendering a slot — the only reliable signal that a
   * slot has a new creative, which is what lets a collapsed slot recover.
   *
   * One callback per slot id; registering again replaces it. Paired with
   * `offRender` on teardown.
   */
  onRender(id: string, listener: (ev: SlotRenderEvent) => void): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.renderListeners.set(id, listener);
    this._ensureRenderListener();
  }

  offRender(id: string): void {
    this.renderListeners.delete(id);
  }

  /**
   * Report that a slot has been collapsed — by Chrome's Heavy Ad Intervention or
   * by an empty response — or that it has recovered, so the refresh path can
   * keep considering it while hidden.
   */
  setCollapsed(id: string, collapsed: boolean): void {
    if (collapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;

    if (this.initialFetchTimer !== null) clearTimeout(this.initialFetchTimer);
    this.initialFetchTimer = null;

    this.renderListeners.clear();
    this.pending.clear();

    this.visibilityCleanup?.();
    this.visibilityCleanup = null;

    const listener = this.gptRenderListener;
    if (!listener) return;
    this.gptRenderListener = null;
    const gt = this._googletag();
    gt?.cmd.push(() => gt.pubads().removeEventListener('slotRenderEnded', listener));
  }

  /** Attach the single GPT listener, once, on first interest. */
  private _ensureRenderListener(): void {
    if (this.gptRenderListener) return;

    const gt = this._googletag();
    if (!gt) return;

    const listener = (ev: SlotRenderEvent) => {
      const divId = ev.slot.getSlotElementId();
      // The event carries a div id; map it back to the slot id the component knows.
      for (const entry of this.live.values()) {
        if (entry.gptSlot.getSlotElementId() !== divId) continue;
        this.renderListeners.get(entry.id)?.(ev);
        return;
      }
    };

    this.gptRenderListener = listener;
    gt.cmd.push(() => gt.pubads().addEventListener('slotRenderEnded', listener));
  }

  /**
   * Issue at most one batched refresh for everything that accumulated in
   * `pending`, and re-arm for whatever could not go out yet.
   *
   * Each guard below either *drops* an id or *defers* it, and which one it does
   * is the whole design. A guard drops when only a fresh user action could make
   * the slot refreshable again — the container is gone, or it is hidden with no
   * scheduled moment when it stops being hidden. A guard defers when its blocker
   * clears on its own: a cooldown expires, a `defineSlot` drains out of
   * `googletag.cmd`, a backgrounded tab comes forward.
   *
   * Dropping a deferrable case is what made rapid navigation lose its refresh
   * entirely. A slot is stamped when its first fetch goes out, so every slot is
   * inside the 5 s floor for its first five seconds; a reader who picked
   * a page and then an article two seconds later had both refreshes discarded and
   * kept the creative the slot was born with, with nothing left to re-fire it.
   */
  private _flush(): void {
    this.refreshTimer = null;
    const targeting = this.targeting;
    const now = Date.now();

    // Guard 1 — a backgrounded tab. GAM treats impressions the user cannot
    // possibly see as invalid traffic, so nothing goes out now. `pending` is left
    // untouched and the visibility listener re-arms the flush on return; the
    // MAX_DEFER_MS check below is what stops a long absence from firing a refresh
    // for a navigation the reader has forgotten.
    if (this.document.hidden) {
      this._ensureVisibilityListener();
      return;
    }

    const requests = [...this.pending.entries()];
    this.pending.clear();

    const batch: LiveSlot[] = [];
    /** Shortest wait among the ids put back into `pending`, in ms. */
    let retryIn = Infinity;

    const defer = (id: string, requestedAt: number, waitMs: number) => {
      this.pending.set(id, requestedAt);
      retryIn = Math.min(retryIn, waitMs);
    };

    for (const [id, requestedAt] of requests) {
      // Expiry — applied before the guards so that an id blocked for this long by
      // any of them stops re-arming the timer.
      if (now - requestedAt >= GamService.MAX_DEFER_MS) continue;

      const entry = this.live.get(id);

      if (!entry) {
        // Guard 2 — no GPT slot yet. Still claimed means its `defineSlot` has not
        // drained out of the command queue, so hold it; otherwise the container
        // unmounted during the debounce and a remount will fetch its own creative.
        if (this.claimed.has(id)) defer(id, requestedAt, GamService.REFRESH_DEBOUNCE_MS);
        continue;
      }

      // Guard 3 — hidden containers. Desktop slots stay mounted but
      // `display: none` on mobile; refreshing them would buy impressions with
      // zero chance of being viewed.
      // Dropped rather than deferred: nothing on a timer un-hides a container, so
      // the next content change is the right thing to reconsider it.
      if (!this._isRefreshable(entry)) continue;

      // Guard 4a — the slot's own fetch already answers this request. A request
      // stamped at or before the moment the slot last went to the network asked
      // for content that fetch was already getting.
      //
      // This is what keeps initial load quiet. `selectPage()` requests a refresh
      // while the containers are still registering, and the initial fetch that
      // follows a tick later gets exactly the content that request was about. The old code dropped it as a side effect of the rate floor;
      // deferring turned it into a duplicate ad request for identical content five
      // seconds after the first, on every single page load — measured as
      // refreshCalls=2 where the suite expects 1.
      if (requestedAt <= entry.lastRefreshedAt) continue;

      // Guard 4b — per-slot rate floor, against rapid pagination clicking. Unlike
      // 4a the content genuinely moved on after the last fetch, so the request is
      // held for exactly the remaining cooldown rather than discarded.
      const sinceRefresh = now - entry.lastRefreshedAt;
      if (sinceRefresh < GamService.MIN_REFRESH_INTERVAL_MS) {
        defer(id, requestedAt, GamService.MIN_REFRESH_INTERVAL_MS - sinceRefresh);
        continue;
      }

      batch.push(entry);
    }

    if (retryIn !== Infinity) {
      this.refreshTimer = setTimeout(() => this._flush(), retryIn);
    }

    if (batch.length === 0) return;

    const gt = this._googletag();
    if (!gt) return;

    gt.cmd.push(() => {
      // Re-check liveness: the queue drains asynchronously, so a container may
      // have unmounted (and its slot been destroyed) since the batch was built.
      const live = batch.filter(entry => this.live.get(entry.id) === entry);
      if (live.length === 0) return;

      for (const entry of live) {
        this._applyTargeting(entry.gptSlot, targeting);
        entry.lastRefreshedAt = Date.now();
      }

      // The slot array is mandatory, not an optimisation: single-request mode is
      // on, so a bare refresh() would re-request every defined slot — including
      // the hidden ones guard 3 just excluded.
      // changeCorrelator makes GAM treat this as a new pageview, so frequency
      // caps, competitive exclusions and roadblocks are evaluated fresh.
      gt.pubads().refresh(live.map(entry => entry.gptSlot), { changeCorrelator: true });
    });
  }

  /**
   * Re-arm the flush when the tab comes back to the foreground, once.
   *
   * Guard 1 leaves the batch in `pending` rather than discarding it, so without
   * this there would be nothing to fire it: the reader returns to a tab whose
   * content changed before they left and sees the creative from before the
   * change, with no further navigation to trigger a refresh.
   */
  private _ensureVisibilityListener(): void {
    if (this.visibilityCleanup) return;

    const onVisibilityChange = () => {
      if (this.document.hidden || this.pending.size === 0) return;
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this._flush(), GamService.REFRESH_DEBOUNCE_MS);
    };

    this.document.addEventListener('visibilitychange', onVisibilityChange);
    this.visibilityCleanup =
      () => this.document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  /**
   * Whether refreshing this slot could put a creative in front of the reader.
   *
   * Usually that is just `_isVisible`. The exception is a slot this app
   * collapsed itself — Chrome's Heavy Ad Intervention, or an empty response —
   * which is `display: none` precisely so the reader is not left looking at a
   * gap, and which only a new creative can bring back. Such a slot has to stay
   * refreshable or the collapse is permanent.
   *
   * But only when our own collapse is the *sole* reason it is hidden. A slot can
   * be collapsed and independently out of view: a slot inside the modal's image
   * panel is hidden by the mobile text view too, and refreshing it there buys an
   * impression nobody can see. Measured on the `mobile-toggle` case (when
   * `mobile_post_middle` still sat in that panel) — a blanket collapse exemption
   * put the hidden slot straight back into the batch.
   *
   * Lifting the collapse for the measurement is what tells the two apart. An
   * inline `display` outranks the host's `:host(.dn-ad--hidden)` rule, so the
   * slot lays out exactly as it would with an ad in it; a container still hidden
   * after that is hidden by an ancestor, and no creative will change that.
   */
  private _isRefreshable(entry: LiveSlot): boolean {
    if (this._isVisible(entry.el)) return true;
    if (!this.collapsed.has(entry.id)) return false;

    const host = entry.hostEl;
    const previousDisplay = host.style.display;
    try {
      host.style.display = 'block';
      return this._isVisible(entry.el);
    } finally {
      // Restored in `finally` because the alternative failure mode is ugly and
      // permanent: an inline `display: block` left on the host would un-hide a
      // slot this app collapsed on purpose, showing the reader the empty box
      // the collapse exists to remove, for the rest of the session.
      host.style.display = previousDisplay;
    }
  }

  /**
   * Whether a container can actually show an ad. `offsetParent` is null anywhere
   * inside a `display: none` subtree, which is exactly what the responsive CSS
   * does to the desktop slots on mobile — so this needs no duplicate of the
   * breakpoint.
   *
   * Deliberately not `IntersectionObserver`: a slot scrolled out of view is still
   * legitimately refreshable, and GPT does its own viewability accounting.
   */
  private _isVisible(el: HTMLElement): boolean {
    return el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  }

  /**
   * `setTargeting` appends to any existing values for a key, so without the
   * `clearTargeting()` first, targeting would degrade to `page=[1,2,3,…]` after a
   * few navigations.
   */
  private _applyTargeting(gptSlot: GptSlot, targeting: AdTargeting): void {
    gptSlot.clearTargeting();
    for (const [key, value] of Object.entries(targeting)) {
      if (value) gptSlot.setTargeting(key, value);
    }
  }

  /**
   * Resolve the GPT global, creating the command-queue stub if gpt.js has not
   * loaded yet. Returns null when there is no window (SSR).
   */
  private _googletag(): GoogleTag | null {
    const w = this.document.defaultView as (Window & { googletag?: GoogleTag }) | null;
    if (!w) return null;
    w.googletag = w.googletag ?? ({ cmd: [] } as unknown as GoogleTag);
    return w.googletag;
  }
}
