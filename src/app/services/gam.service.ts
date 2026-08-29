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

interface PubAdsService {
  refresh(slots: GptSlot[], options?: { changeCorrelator: boolean }): void;
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
  el: HTMLElement;
  lastRefreshedAt: number;
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
   * of a slot's initial fill: `register()` stamps `lastRefreshedAt` at
   * definition time, so a freshly mounted slot is ineligible for this long.
   */
  private static readonly MIN_REFRESH_INTERVAL_MS = 5000;

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

  /** Slot ids awaiting the next coalesced refresh. */
  private readonly pending = new Set<string>();

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

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

  /**
   * Define and display a GPT slot for a container that has just been committed
   * to the DOM. Safe to call when gpt.js has not finished loading — the work is
   * queued on `googletag.cmd`.
   */
  register(def: AdSlot, el: HTMLElement): void {
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
        lastRefreshedAt: Date.now(),
      });

      gt.display(def.div);
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
    // Default to `claimed` rather than `live`: a slot mid-definition when this is
    // called will be live by the time the debounce elapses.
    for (const id of ids ?? this.claimed) this.pending.add(id);

    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this._flush(), GamService.REFRESH_DEBOUNCE_MS);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Issue at most one batched refresh for everything that accumulated in `pending`. */
  private _flush(): void {
    this.refreshTimer = null;
    const ids = [...this.pending];
    this.pending.clear();
    const targeting = this.targeting;

    // Guard 1 — a backgrounded tab. GAM treats impressions the user cannot
    // possibly see as invalid traffic, so drop the batch rather than deferring it.
    if (this.document.hidden) return;

    const now = Date.now();
    const batch = ids
      .map(id => this.live.get(id))
      // Guard 2 — the container unmounted during the debounce window. This is
      // also what keeps a refresh from double-requesting a slot that Phase 1's
      // mount-time display() is already fetching.
      .filter((entry): entry is LiveSlot => entry !== undefined)
      // Guard 3 — hidden containers. Desktop slots stay mounted but
      // `display: none` on mobile; refreshing them would buy impressions with
      // zero chance of being viewed.
      .filter(entry => this._isVisible(entry.el))
      // Guard 4 — per-slot rate floor, against rapid pagination clicking.
      .filter(entry => now - entry.lastRefreshedAt >= GamService.MIN_REFRESH_INTERVAL_MS);

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
