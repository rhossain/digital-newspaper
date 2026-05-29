import { Component, OnInit, Inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { ToasterComponent } from './toaster/toaster.component';
import { LoaderComponent } from './components/loader/loader.component';
import { NewspaperDataService } from './services/newspaper-data.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToasterComponent, LoaderComponent],
  template: `
    <router-outlet></router-outlet>
    <app-toaster></app-toaster>
    <app-loader></app-loader>
  `,
  styles: []
})
export class AppComponent implements OnInit {
  title = 'digital-newspaper';

  constructor(
    private dataService: NewspaperDataService,
    @Inject(DOCUMENT) private document: Document
  ) {}

  ngOnInit(): void {
    this.dataService.data$.subscribe(() => {
      this.injectHeadScripts();
    });

    // Dismiss the static splash screen for all routes (e.g. /admin/ never
    // mounts NewspaperComponent, so the splash must be hidden here instead).
    const splash = this.document.getElementById('app-splash');
    if (splash) {
      splash.classList.add('hidden');
      splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    }
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
