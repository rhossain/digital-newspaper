import { Component, OnInit, OnDestroy, Inject, isDevMode, PLATFORM_ID, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { ToasterComponent } from './toaster/toaster.component';
import { LoaderComponent } from './components/loader/loader.component';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { NewspaperDataService } from './services/newspaper-data.service';
import { WebVitalsService } from './services/web-vitals.service';
import { filter, Subscription } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToasterComponent, LoaderComponent, UpdateBannerComponent],
  template: `
    <router-outlet></router-outlet>
    <app-toaster></app-toaster>
    <app-loader></app-loader>
    @if (updateAvailable) {
      <app-update-banner (dismissed)="applyUpdate()" />
    }
  `,
  styles: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'digital-newspaper';

  /** Set to true when ngsw signals a new app version is ready to activate. */
  updateAvailable = false;

  private _swSub?: Subscription;
  private _dataSub?: Subscription;

  constructor(
    private dataService: NewspaperDataService,
    private swUpdate: SwUpdate,
    @Inject(DOCUMENT) private document: Document,
    @Inject(PLATFORM_ID) private platformId: object,
    private cdr: ChangeDetectorRef,
    private webVitals: WebVitalsService,
  ) {}

  ngOnInit(): void {
    // Begin dependency-free Core Web Vitals collection (browser-only, no-op on
    // server). Metrics are exposed on window.__dnWebVitals and logged on tab
    // hide; off-device beaconing stays disabled unless explicitly configured.
    this.webVitals.start();

    this._dataSub = this.dataService.data$.subscribe(() => {
      this.injectHeadScripts();
    });

    // ── Service-worker update notification ──────────────────────────────────
    // SW is browser-only — skip entirely on the server.
    if (isPlatformBrowser(this.platformId) && !isDevMode() && this.swUpdate.isEnabled) {
      this._swSub = this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => {
          this.updateAvailable = true;
          // OnPush: signal Angular to re-check this component since we updated
          // a property from outside the component's own event handlers.
          this.cdr.markForCheck();
        });
    }

    // Dismiss the static splash screen for all routes (e.g. /admin/ never
    // mounts NewspaperComponent, so the splash must be hidden here instead).
    const splash = this.document.getElementById('app-splash');
    if (splash) {
      splash.classList.add('hidden');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }
  }

  ngOnDestroy(): void {
    this._swSub?.unsubscribe();
    this._dataSub?.unsubscribe();
  }

  /**
   * Called when the user clicks "Reload" in the update banner.
   * Activates the waiting SW version then reloads the page.
   */
  applyUpdate(): void {
    this.swUpdate.activateUpdate()
      .then(() => this.document.location.reload())
      .catch(err => console.warn('[AppComponent] SW activateUpdate failed:', err));
  }

  /**
   * Reads `headScripts` from global settings and injects any <script> tags
   * into <head>. Skips injection when the value is empty.
   * Existing injected scripts (marked with data-head-scripts) are removed first
   * so re-saves don't accumulate duplicate tags.
   */
  private injectHeadScripts(): void {
    const html = (this.dataService.getSettings().headScripts || '').trim();

    // Remove previously injected scripts
    this.document.head
      .querySelectorAll('script[data-head-scripts]')
      .forEach(el => el.remove());

    if (!html) return;

    const container = this.document.createElement('div');
    container.innerHTML = html;

    container.querySelectorAll('script').forEach(original => {
      const script = this.document.createElement('script');
      script.setAttribute('data-head-scripts', 'true');
      Array.from(original.attributes).forEach(attr =>
        script.setAttribute(attr.name, attr.value)
      );
      if (original.textContent) {
        script.textContent = original.textContent;
      }
      this.document.head.appendChild(script);
    });
  }
}
