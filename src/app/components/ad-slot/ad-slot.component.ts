import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  Renderer2,
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

/**
 * Declared container size per slot, mirroring gam_ad_slots()
 * (digital-newspaper.php:594-685).
 *
 * Used for one purpose only: reserving layout space while /ads/config is still
 * in flight, so an in-flow slot does not expand from 0 px the moment the config
 * lands. Once AdService is ready the live config's min_width/min_height take
 * over and this map is never read again — so a stale number here costs a layout
 * shift, never a broken or mis-sized ad.
 */
const RESERVED_SIZES: Readonly<Record<string, { width: number; height: number }>> = {
  desktop_page_left:           { width: 120, height: 240 },
  desktop_page_right:          { width: 300, height: 250 },
  desktop_post_preview_top:    { width: 300, height: 100 },
  desktop_post_preview_middle: { width: 300, height: 100 },
  desktop_post_top_image:      { width: 300, height:  60 },
  desktop_post_top_text:       { width: 300, height:  60 },
  desktop_post_middle:         { width: 300, height:  60 },
  mobile_post_top:             { width: 300, height: 100 },
  mobile_post_middle:          { width: 300, height: 100 },
};

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
 * - After the div is committed to the DOM, injects a <script> tag inside it:
 *
 *     <div id="div-gpt-ad-...">
 *       <script>
 *         googletag.cmd.push(function() { googletag.display('div-gpt-ad-...'); });
 *       </script>
 *     </div>
 *
 *   This is the standard GPT placement format. Doing it via Renderer2 after
 *   the viewChild resolves guarantees the div exists in the DOM when the
 *   cmd.push callback runs — regardless of whether gpt.js has finished loading.
 *
 * - Desktop slots (id starts with 'desktop_') are hidden on mobile via CSS.
 * - Mobile slots (id starts with 'mobile_') are hidden on desktop via CSS.
 * - SSR-safe: Renderer2 / script injection is guarded by isPlatformBrowser().
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
    // Deliberately does NOT collapse while AdService is still loading: that is
    // when the reserved-space placeholder renders, and display:none on the host
    // would defeat it.
    '[class.dn-ad--hidden]':
      'adService.ready() && (!slot() || !slot()!.enabled) || removedByBrowser()',
  },
})
export class AdSlotComponent {

  /** Stable slot identifier matching the WordPress gam_ad_slots() id field. */
  readonly slotId = input.required<string>();

  protected readonly adService = inject(AdService);
  private  readonly platformId = inject(PLATFORM_ID);
  private  readonly renderer   = inject(Renderer2);
  private  readonly zone       = inject(NgZone);
  private  readonly destroyRef = inject(DestroyRef);

  /** Resolved slot definition (undefined while AdService is loading). */
  protected readonly slot = computed<AdSlot | undefined>(() =>
    this.adService.getSlot(this.slotId())
  );

  /** Declared size to reserve before /ads/config resolves; undefined for unknown ids. */
  protected readonly reservedSize = computed(() => RESERVED_SIZES[this.slotId()]);

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

  /** Guard: inject the display script only once per slot instance. */
  private _scriptInjected = false;

  /** Cleanup fn for the MutationObserver watching for Chrome Heavy Ad removal. */
  private _cleanupObserver?: () => void;

  /**
   * True when Chrome's Heavy Ad Intervention removes the ad iframe.
   * When set, the host's dn-ad--hidden class collapses the slot so no
   * blank space is reserved for a removed ad.
   */
  readonly removedByBrowser = signal(false);

  constructor() {
    // Slots are destroyed and recreated routinely — the right-panel slot goes
    // away on every section click — so without this the MutationObserver and the
    // detached GPT iframe it holds a reference to leak once per cycle.
    this.destroyRef.onDestroy(() => {
      this._cleanupObserver?.();
      this._cleanupObserver = undefined;
    });

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

      // Reset the guard whenever the slot is unavailable or disabled so that
      // re-enabling a slot within the same session injects a fresh display call.
      if (!slot || !slot.enabled) {
        this._scriptInjected = false;
        this.removedByBrowser.set(false);
        this._cleanupObserver?.();
        this._cleanupObserver = undefined;
        return;
      }

      // Wait for Angular to commit the div to the DOM.
      const container = this.adContainer();
      if (!container || this._scriptInjected) return;

      if (!isPlatformBrowser(this.platformId)) return; // SSR guard

      this._scriptInjected = true;

      // Inject:  <script>googletag.cmd.push(function() {
      //            googletag.display('div-gpt-ad-...');
      //          });</script>
      //
      // Appending a script element to the DOM causes the browser to execute
      // it immediately (standard browser behaviour for inline scripts).
      // Even if gpt.js is still loading, cmd.push queues the callback and
      // GPT processes it once the library is ready.
      const script = this.renderer.createElement('script') as HTMLScriptElement;
      script.text =
        `googletag.cmd.push(function() { googletag.display('${slot.div}'); });`;
      this.renderer.appendChild(container.nativeElement, script);

      // Watch for Chrome's Heavy Ad Intervention, which replaces the ad iframe
      // with an intervention notice element and leaves the container visible.
      // When detected, collapse the slot so it takes no layout space.
      this._observeForHeavyAdRemoval(container.nativeElement, slot.div);
    });
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
   */
  private _observeForHeavyAdRemoval(container: HTMLElement, divId: string): void {
    this._cleanupObserver?.(); // disconnect any prior observer

    // Track whether the SafeFrame iframe was ever observed inside this container.
    // We must not collapse the slot until we have confirmed the iframe existed,
    // otherwise normal GPT construction (multi-step DOM mutations) would
    // trigger a false positive and collapse a healthy ad before it renders.
    let iframeWasPresent = false;

    const iframeSelector = `iframe[id*="${divId}"], iframe[name*="${divId}"]`;

    // Constructed outside the Angular zone, which is what keeps this cheap:
    // zone.js binds a MutationObserver callback to the zone that was current
    // when the observer was created, and {childList, subtree} on a GPT container
    // fires dozens to hundreds of times while the SafeFrame is built. Inside the
    // zone that would be one full change-detection pass per mutation.
    this.zone.runOutsideAngular(() => {
      const observer = new MutationObserver(() => {
        const iframePresent = !!container.querySelector(iframeSelector);

        if (iframePresent) {
          // Normal ad load — record that the iframe arrived.
          iframeWasPresent = true;
          return;
        }

        // iframe is gone — only act if it was previously confirmed present.
        // This distinguishes Chrome's Heavy Ad removal from the normal period
        // between script injection and GPT completing the SafeFrame build.
        if (iframeWasPresent) {
          observer.disconnect();
          // The one place a tick is wanted: re-enter so the host binding that
          // collapses the slot is picked up immediately.
          this.zone.run(() => this.removedByBrowser.set(true));
        }
      });

      observer.observe(container, { childList: true, subtree: true });
      this._cleanupObserver = () => observer.disconnect();
    });
  }
}
