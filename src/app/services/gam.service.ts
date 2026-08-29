import { Injectable, PLATFORM_ID, inject, isDevMode } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { AdSlot } from './ad.service';

/**
 * Minimal structural types for the parts of the Google Publisher Tag API this
 * service touches. Declared locally rather than pulling in
 * @types/google-publisher-tag: the surface used here is four methods wide, and
 * a local declaration keeps the GPT contract we depend on visible in-repo.
 */
interface GptSlot {
  getSlotElementId(): string;
  getAdUnitPath(): string;
  addService(service: unknown): GptSlot;
}

interface GoogleTag {
  cmd: Array<() => void>;
  defineSlot(unit: string, sizes: number[][], div: string): GptSlot | null;
  display(div: string): void;
  destroySlots(slots: GptSlot[]): boolean;
  pubads(): unknown;
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
 * Bootstrapping (loading gpt.js, `setConfig`, `enableServices`) stays in
 * AdService — this service only manages slots.
 */
@Injectable({ providedIn: 'root' })
export class GamService {

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
