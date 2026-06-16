import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Renderer2,
  computed,
  effect,
  inject,
  input,
  viewChild,
  PLATFORM_ID,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AdService, AdSlot } from '../../services/ad.service';

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
    '[class.dn-ad--hidden]':  '!slot() || !slot()!.enabled',
  },
})
export class AdSlotComponent {

  /** Stable slot identifier matching the WordPress gam_ad_slots() id field. */
  readonly slotId = input.required<string>();

  protected readonly adService = inject(AdService);
  private  readonly platformId = inject(PLATFORM_ID);
  private  readonly renderer   = inject(Renderer2);

  /** Resolved slot definition (undefined while AdService is loading). */
  protected readonly slot = computed<AdSlot | undefined>(() =>
    this.adService.getSlot(this.slotId())
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

  /** Guard: inject the display script only once per slot instance. */
  private _scriptInjected = false;

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

      // Reset the guard whenever the slot is unavailable or disabled so that
      // re-enabling a slot within the same session injects a fresh display call.
      if (!slot || !slot.enabled) {
        this._scriptInjected = false;
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
    });
  }
}
