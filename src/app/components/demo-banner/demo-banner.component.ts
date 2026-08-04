import { Component, ChangeDetectionStrategy, signal, inject } from '@angular/core';
import { DemoService } from '../../services/demo.service';

/**
 * §3.6 — Persistent Demo Mode banner: explains the sandbox, shows the demo
 * credentials, offers a "Reset my demo" action and a "Buy now" CTA. Renders
 * nothing unless this is a demo build (DemoService.enabled).
 */
@Component({
  selector: 'app-demo-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (demo.active) {
      <div class="dn-demo-banner" role="status" aria-live="polite">
        <div class="dn-demo-banner__msg">
          <span class="dn-demo-banner__badge">DEMO</span>
          <span>
            You're in a private sandbox — your changes are visible only to you and
            reset when you leave. Login: <code>demo</code> / <code>demo1234</code>
          </span>
        </div>
        <div class="dn-demo-banner__actions">
          <button type="button" class="dn-demo-banner__btn" (click)="reset()" [disabled]="resetting()">
            {{ resetting() ? 'Resetting…' : 'Reset my demo' }}
          </button>
          <a class="dn-demo-banner__cta" href="mailto:sales@dailysangram.com?subject=Digital%20Newspaper%20—%20Buy%20now">
            Buy now
          </a>
        </div>
      </div>
    }
  `,
  styles: [`
    .dn-demo-banner {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 12px; padding: 10px 16px;
      background: #b45309; color: #fff;
      font-size: 14px; line-height: 1.4;
      box-shadow: 0 -2px 10px rgba(0,0,0,.18);
    }
    .dn-demo-banner__msg { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .dn-demo-banner__badge {
      font-weight: 700; letter-spacing: .06em; font-size: 11px;
      background: rgba(255,255,255,.22); padding: 2px 8px; border-radius: 4px;
    }
    .dn-demo-banner code { background: rgba(0,0,0,.22); padding: 1px 5px; border-radius: 3px; }
    .dn-demo-banner__actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .dn-demo-banner__btn, .dn-demo-banner__cta {
      font: inherit; font-weight: 600; cursor: pointer; text-decoration: none;
      padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,.6);
      background: transparent; color: #fff;
    }
    .dn-demo-banner__btn:disabled { opacity: .6; cursor: default; }
    .dn-demo-banner__cta { background: #fff; color: #b45309; border-color: #fff; }
    @media (max-width: 560px) { .dn-demo-banner { font-size: 12.5px; } }
  `],
})
export class DemoBannerComponent {
  readonly demo = inject(DemoService);
  readonly resetting = signal(false);

  async reset(): Promise<void> {
    if (this.resetting()) return;
    this.resetting.set(true);
    try {
      await this.demo.reset();
      // Reload so every cache layer re-reads from the golden seed.
      location.reload();
    } finally {
      this.resetting.set(false);
    }
  }
}
