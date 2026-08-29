import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AdService, AdSlot } from '../../services/ad.service';
import { GamService } from '../../services/gam.service';

/**
 * AdSlotComponent — renders a single Google Ad Manager slot.
 *
 * Usage:
 *   <app-ad-slot slotId="desktop_page_left" />
 *
 * How it works:
 * - Reads slot config from AdService (which mirrors WordPress /ads/config).
 * - Renders a container div with the exact id, min-width, and min-height
 *   that GAM expects.
 * - Once the div is committed to the DOM, hands it to GamService, which defines
 *   and displays the GPT slot; on teardown it hands the id back so GamService can
 *   destroy the slot.
 *
 * The register/unregister pairing is the important part. GPT allows `display()`
 * at most once per slot per page load, so a container that is destroyed and
 * recreated — a modal reopening, the right panel closing and opening — must have
 * its slot destroyed in GPT too. Without that, the second `display()` is silently
 * ignored and the slot stays blank for the rest of the session. That was the
 * behaviour before this component delegated to GamService.
 *
 * - Desktop slots (id starts with 'desktop_') are hidden on mobile via CSS.
 * - Mobile slots (id starts with 'mobile_') are hidden on desktop via CSS.
 * - SSR-safe: registration is guarded by isPlatformBrowser().
 * - Hidden when global GAM is off OR when the individual slot is disabled.
 */
@Component({
  selector: 'app-ad-slot',
  standalone: true,
  imports: [],
  templateUrl: './ad-slot.component.html',
  styleUrl: './ad-slot.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dn-ad--desktop]': 'isDesktop()',
    '[class.dn-ad--mobile]':  'isMobile()',
    '[class.dn-ad--hidden]':  '!slot() || !slot()!.enabled || removedByBrowser()',
  },
})
export class AdSlotComponent implements OnDestroy {

  /**
   * How long an iframe must stay absent before it counts as a Heavy-Ad removal
   * rather than the momentary gap in the middle of a refresh.
   */
  private static readonly HEAVY_AD_CONFIRM_MS = 1500;

  /** Stable slot identifier matching the WordPress gam_ad_slots() id field. */
  readonly slotId = input.required<string>();

  protected readonly adService = inject(AdService);
  private  readonly gam        = inject(GamService);
  private  readonly platformId = inject(PLATFORM_ID);

  /**
   * Resolved slot definition (undefined while AdService is loading).
   *
   * Returns undefined when global GAM is off, not just when the individual slot
   * is off. The two flags are persisted independently on the WordPress side
   * (OPTION_GAM_ENABLED vs OPTION_GAM_SLOT_STATES), so a slot can be
   * per-slot-enabled while GAM as a whole is disabled. Without the global check
   * here, such a slot renders a reserved empty div and its display() call throws
   * ReferenceError because gpt.js was never loaded. Both the template @if and the
   * dn-ad--hidden host binding derive from this signal, so gating it here is
   * sufficient — and it makes the admin GAM toggle a complete kill switch.
   */
  protected readonly slot = computed<AdSlot | undefined>(() =>
    this.adService.enabled() ? this.adService.getSlot(this.slotId()) : undefined
  );

  readonly isDesktop = computed(() => this.slotId().startsWith('desktop_'));
  readonly isMobile  = computed(() => this.slotId().startsWith('mobile_'));

  /**
   * Signal-based ref to the ad container div.
   * Becomes defined when the @if renders the div, undefined when it removes it.
   * Tracking this in the effect() means the effect re-runs the moment Angular
   * commits the div to the DOM — which is the correct time to inject the script.
   */
  private readonly adContainer =
    viewChild<ElementRef<HTMLDivElement>>('adContainer');

  /**
   * The slot id currently registered with GamService, or null.
   * Tracked as an id rather than a boolean so teardown knows what to unregister.
   */
  private _registeredId: string | null = null;

  /** Cleanup fn for the MutationObserver watching for Chrome Heavy Ad removal. */
  private _cleanupObserver?: () => void;

  /**
   * True when Chrome's Heavy Ad Intervention removes the ad iframe.
   * When set, the host's dn-ad--hidden class collapses the slot so no
   * blank space is reserved for a removed ad.
   */
  readonly removedByBrowser = signal(false);

  constructor() {
    /**
     * This effect tracks two signals:
     *   slot()         — resolves when AdService completes its HTTP fetch
     *   adContainer()  — resolves when Angular renders the @if div
     *
     * Both must be truthy before we inject the GPT display script.
     * Because viewChild is a signal, this effect re-runs automatically when
     * Angular creates or destroys the div, so the timing is always correct.
     */
    effect(() => {
      const slot = this.slot();

      // Release the GPT slot whenever it becomes unavailable or disabled, so that
      // re-enabling it within the same session gets a genuinely fresh ad rather
      // than a silently-ignored second display() call.
      if (!slot || !slot.enabled) {
        this._release();
        return;
      }

      // Wait for Angular to commit the div to the DOM.
      const container = this.adContainer();
      if (!container || this._registeredId === slot.id) return;

      if (!isPlatformBrowser(this.platformId)) return; // SSR guard

      this._registeredId = slot.id;

      // Recover from a Heavy-Ad collapse. GPT renders a new creative into this
      // same container on every refresh, but the collapse is latched and its
      // observer disconnected, so without this the slot would stay hidden for the
      // rest of the session and refresh into a box nobody can see.
      this.gam.onRender(slot.id, () => {
        this.removedByBrowser.set(false);
        this.gam.setCollapsed(slot.id, false);
        this._observeForHeavyAdRemoval(container.nativeElement);
      });

      this.gam.register(slot, container.nativeElement);

      // Watch for Chrome's Heavy Ad Intervention, which replaces the ad iframe
      // with an intervention notice element and leaves the container visible.
      // When detected, collapse the slot so it takes no layout space.
      this._observeForHeavyAdRemoval(container.nativeElement);
    });
  }

  /**
   * Destroy the GPT slot and stop observing. Paired with the register() call in
   * the effect above; safe to call when nothing is registered.
   */
  private _release(): void {
    this._cleanupObserver?.();
    this._cleanupObserver = undefined;

    if (this._registeredId) {
      this.gam.offRender(this._registeredId);
      this.gam.unregister(this._registeredId);
      this._registeredId = null;
    }

    this.removedByBrowser.set(false);
  }

  ngOnDestroy(): void {
    this._release();
  }

  /**
   * Sets up a MutationObserver that collapses the slot ONLY when Chrome's
   * Heavy Ad Intervention removes an iframe that was previously present.
   *
   * The key invariant: we must first observe the iframe being ADDED by GPT,
   * then watch for it being REMOVED by Chrome. Checking "no iframe present"
   * immediately on the first mutation would be a false positive — GPT builds
   * the ad in multiple DOM steps (outer div first, then the SafeFrame iframe),
   * so the observer fires before the iframe exists during normal ad loading.
   *
   * Matches any iframe inside the container, because GPT names its SafeFrame
   * after the *ad unit path* (`google_ads_iframe_/22062727803/TDSEV3_…_0`), not
   * the div id. A previous id-based selector matched nothing, so
   * `iframeWasPresent` never became true and this observer could never collapse
   * anything — measured against the live site. The container holds only this
   * slot's render, so "has an iframe" is the right proxy for "an ad is here".
   */
  private _observeForHeavyAdRemoval(container: HTMLElement): void {
    this._cleanupObserver?.(); // disconnect any prior observer

    // Track whether the SafeFrame iframe was ever observed inside this container.
    // We must not collapse the slot until we have confirmed the iframe existed,
    // otherwise normal GPT construction (multi-step DOM mutations) would
    // trigger a false positive and collapse a healthy ad before it renders.
    //
    // Seeded from a synchronous check rather than starting false, because this is
    // also called to re-arm after a render, by which point the iframe usually
    // already exists — and a MutationObserver reports only future mutations, so
    // starting false would leave a slot whose iframe never mutates again
    // permanently unable to detect a Heavy-Ad removal.
    let iframeWasPresent = !!container.querySelector('iframe');
    let pendingCheck: ReturnType<typeof setTimeout> | undefined;

    const clearPending = () => {
      if (pendingCheck === undefined) return;
      clearTimeout(pendingCheck);
      pendingCheck = undefined;
    };

    const observer = new MutationObserver(() => {
      if (container.querySelector('iframe')) {
        // Normal ad load — record that the iframe arrived.
        iframeWasPresent = true;
        clearPending();
        return;
      }

      // iframe is gone — only act if it was previously confirmed present.
      // This distinguishes Chrome's Heavy Ad removal from the normal period
      // between script injection and GPT completing the SafeFrame build.
      if (!iframeWasPresent || pendingCheck !== undefined) return;

      // A refresh also drops the old iframe a moment before building the new
      // one, which is indistinguishable from a Heavy-Ad removal at this instant.
      // Confirm the absence persists first: an intervention is permanent, so
      // waiting costs nothing, whereas collapsing immediately would flicker the
      // slot closed on every single refresh.
      pendingCheck = setTimeout(() => {
        pendingCheck = undefined;
        if (container.querySelector('iframe')) return;

        this.removedByBrowser.set(true);
        // Keeps this slot eligible for refresh while collapsed — the next
        // creative is what brings it back.
        this.gam.setCollapsed(this.slotId(), true);
        observer.disconnect();
      }, AdSlotComponent.HEAVY_AD_CONFIRM_MS);
    });

    observer.observe(container, { childList: true, subtree: true });
    this._cleanupObserver = () => {
      clearPending();
      observer.disconnect();
    };
  }
}
