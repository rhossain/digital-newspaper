import { Component, OnInit, OnDestroy, ChangeDetectionStrategy, ChangeDetectorRef, ElementRef, ViewChild, viewChild, effect, untracked, inject, Inject, PLATFORM_ID } from '@angular/core';
import { Location, DOCUMENT, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { NewspaperDataService, NewsSection, NewspaperPage, NewspaperEdition, GlobalSettings } from './services/newspaper-data.service';
import { ToasterService } from './services/toaster.service';
import { TranslationService } from './i18n/translation.service';
import { TranslatePipe } from './i18n/translate.pipe';
import { LocaleDatePipe } from './i18n/locale-date.pipe';
import { DatePickerComponent } from './components/date-picker/date-picker.component';
import { SectionOverlayComponent } from './components/section-overlay/section-overlay.component';
import { ArticleModalComponent } from './components/article-modal/article-modal.component';
import { AdSlotComponent } from './components/ad-slot/ad-slot.component';
import { ShareButtonsComponent } from './shared/share-buttons/share-buttons.component';
import { AdService } from './services/ad.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-newspaper',
  standalone: true,
  imports: [FormsModule, TranslatePipe, LocaleDatePipe, DatePickerComponent, SectionOverlayComponent, ArticleModalComponent, AdSlotComponent, ShareButtonsComponent],
  templateUrl: './newspaper.component.html',
  styleUrls: ['./newspaper.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewspaperComponent implements OnInit, OnDestroy {
  @ViewChild('mainImage') mainImageRef?: ElementRef<HTMLImageElement>;

  /** Exposed for template — reads slotEnabledMap signal (reactive, OnPush-safe). */
  protected readonly adService = inject(AdService);

  // Signal-based viewChild: the effect() below re-runs only when this
  // element enters/leaves the DOM (much cheaper than afterEveryRender).
  readonly paginationBarRef = viewChild<ElementRef<HTMLElement>>('paginationBar');
  private paginationContainerWidth = 0;
  private paginationObserver?: ResizeObserver;
  /** Section ID → section lookup, rebuilt once per edition load instead of per-click. */
  private _sectionByIdCache = new Map<string, NewsSection>();
  pages: NewspaperPage[] = [];
  currentPage: NewspaperPage | null = null;
  selectedSection: NewsSection | null = null;
  imageLoaded = false;
  assetLogoError = false;
  showSlowConnectionWarning = false;
  private slowConnectionTimer?: ReturnType<typeof setTimeout>;
  croppedSectionImage: string | null = null;
  showContentModal = false;
  showImageModal = false;
  showShareDropdown = false;
  linkedSections: NewsSection[] = [];
  /** Resolved primary section ID for the current section's link group. Set by loadLinkedSections(). */
  private linkedSectionPrimaryId: string | undefined;
  private imageElement: HTMLImageElement | null = null;
  
  // Modal image state
  modalImage: string | null = null;
  modalImageTitle: string = '';
  modalLinkedSections: NewsSection[] = [];
  pendingSectionSlug: string | null = null;
  pendingPageSlug: string | null = null;
  pendingEditionSlug: string | null = null;
  private startedFromBaseUrl = false;
  private userNavigated = false;

  // Mobile/tablet responsive state
  isMobileView = false;
  mobileHeaderMenuOpen = false;
  pendingMobileModal = false;
  /** Which panel is active in the mobile image modal: 'image' or 'text'. */
  mobileModalView: 'image' | 'text' = 'image';
  private resizeListener?: () => void;
  private resizeDebounceTimer?: ReturnType<typeof setTimeout>;

  // Performance caches
  private cropCache = new Map<string, string>();
  private resolvedUrlCache = new Map<string, string>();
  
  // Image loading states
  thumbnailsLoading: { [key: number]: boolean } = {};
  /** Pre-resolved thumbnail src for each page (thumbnail → fullImage fallback). */
  pageThumbnailSrcs: { [pageId: number]: string } = {};
  /**
   * Cross-date thumbnail source cache — keyed by page ID scoped to a date.
   * Key format: `${date}:${pageId}` — survives date navigation so that
   * returning to a previously-visited date can skip the skeleton for URLs
   * already confirmed loaded.  Distinct from pageThumbnailSrcs (which is
   * reset on every renderCurrentEdition) to avoid cross-date false-positives.
   */
  private _thumbnailSrcCache = new Map<string, string>();
  /**
   * The selectedDate value at the time pageThumbnailSrcs was last populated.
   * Used in onThumbnailLoad instead of selectedDate to avoid a date-race:
   * if the user navigates to a new date before all (load) events fire, the
   * cache key must still reflect the date the thumbnails were built for —
   * not the currently-selected date (which may have already advanced).
   */
  private _thumbnailRenderDate = '';
  /**
   * Set to true in ngOnDestroy so that async image callbacks (img.onload /
   * img.onerror) never call detectChanges() on an already-destroyed view.
   * Without this guard an OnPush component would throw ViewDestroyedError if
   * the user navigates away while a crop image is still in flight.
   */
  private _viewDestroyed = false;
  sectionImageLoading = false;
  sectionImageError = false;
  
  // Date navigation
  selectedDate: string = '';
  todayDate: string = '';
  displayDate: string = '';
  availableDates: string[] = [];
  isToday: boolean = true;
  isLoading: boolean = false;
  /** Guard to prevent redundant loadCurrentEdition() calls during initialization. */
  private initialLoadComplete = false;

  // Edition navigation
  selectedEditionNumber: number = 1;
  editionsForDate: NewspaperEdition[] = [];
  
  // Global settings
  settings: GlobalSettings | null = null;
  socialLinks: any = {};

  // Cached localized string properties — computed once in refreshSettings() instead
  // of recomputing on every change-detection cycle via getter calls in the template.
  logoHref = '';
  localizedEditor = '';
  localizedAddressLine1 = '';
  localizedAddressLine2 = '';
  localizedPhone = '';
  todayDisplayDate = '';
  
  private subscriptions: Subscription[] = [];

  /**
   * Stable bound reference to getCroppedImageForSection, passed to ArticleModalComponent
   * as an @Input to avoid creating a new function on every change-detection cycle.
   */
  readonly getCroppedImageBound = (s: NewsSection) => this.getCroppedImageForSection(s);

  constructor(
    private dataService: NewspaperDataService,
    private toaster: ToasterService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private translationService: TranslationService,
    private location: Location,
    private meta: Meta,
    private titleService: Title,
    @Inject(DOCUMENT) private document: Document,
    @Inject(PLATFORM_ID) private platformId: object,
  ) {
    // Use an effect() + viewChild signal instead of afterEveryRender().
    // afterEveryRender fires after EVERY render of the entire app; effect() fires
    // only when the paginationBarRef signal value changes — i.e. when the element
    // enters or leaves the DOM due to an @if toggle.  This is orders of magnitude
    // cheaper for a reader who never enters maintenance mode.
    effect(() => {
      // Reading the signal registers a reactive dependency. The effect re-runs
      // only when paginationBarRef changes (element added or removed from DOM).
      const el = this.paginationBarRef()?.nativeElement;
      // untracked: mutations inside (paginationContainerWidth, paginationObserver)
      // are plain properties — not signals — so untracked() is a no-op here, but
      // it is good practice to mark side-effectful work explicitly.
      untracked(() => {
        if (el && !this.paginationObserver) {
          // Element just became visible — start observing its width.
          this.paginationObserver = new ResizeObserver(entries => {
            const w = Math.floor(entries[0]?.contentRect.width ?? 0);
            if (w !== this.paginationContainerWidth) {
              this.paginationContainerWidth = w;
              this.updatePaginationPages();
              this.cdr.detectChanges();
            }
          });
          this.paginationObserver.observe(el);
        } else if (!el && this.paginationObserver) {
          // Element removed from DOM — clean up.
          this.paginationObserver.disconnect();
          this.paginationObserver = undefined;
          this.paginationContainerWidth = 0;
          this.updatePaginationPages();
        }
      });
    });
  }

  private get isBrowser(): boolean { return isPlatformBrowser(this.platformId); }

  /** Expose TranslationService to the template. */
  get ts(): TranslationService { return this.translationService; }

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();

    // Detect if the app was opened at the base URL (no path segments)
    this.startedFromBaseUrl = !this.route.snapshot.routeConfig?.path;

    // Subscribe to route parameters — only apply pending slugs before initial load
    // completes; after that all URL updates use location.replaceState() which
    // does NOT re-fire paramMap, so this guard is purely defensive.
    const routeSubscription = this.route.paramMap.subscribe(params => {
      if (this.initialLoadComplete) return;

      const dateParam    = params.get('date');
      const pageParam    = params.get('page');
      const editionParam = params.get('edition');
      const sectionParam = params.get('section');

      if (dateParam) {
        // Defense-in-depth: ignore future-dated URL params — the server returns
        // empty editions for them anyway, but redirecting to the latest available
        // date gives the reader a better experience than a blank page.
        const effectiveDate = dateParam <= this.todayDate ? dateParam : this.todayDate;
        this.selectedDate = effectiveDate;
        this.dataService.setCurrentDate(effectiveDate);
      }
      if (pageParam)    this.pendingPageSlug    = pageParam;
      if (editionParam) this.pendingEditionSlug = editionParam;
      if (sectionParam) this.pendingSectionSlug = sectionParam;
    });
    this.subscriptions.push(routeSubscription);

    // Subscribe to date changes — URL is updated via selectPage()/selectSection()
    // after loadCurrentEdition() resolves, avoiding interim incorrect URLs.
    const dateSubscription = this.dataService.currentDate$.subscribe(date => {
      this.selectedDate = date;
      this.updateDisplayDate();
      this.checkIfToday();
    });
    this.subscriptions.push(dateSubscription);
    
    // Subscribe to data changes.
    // Guard with initialLoadComplete so that the BehaviorSubject's immediate
    // emit and the tap()-triggered emit during loadNewspaperData() do NOT call
    // loadCurrentEdition() — that single call is made explicitly in
    // loadNewspaperData() after the correct date has been established.
    const dataSubscription = this.dataService.data$.subscribe(() => {
      // Always sync global settings from the latest data
      this.refreshSettings();
      if (this.initialLoadComplete) {
        // Re-sync the date picker list — a targeted reload may have added a
        // newly-published edition date that wasn't in the initial load.
        // Filter future dates: public readers should never see editions whose
        // publication date has not yet been reached.
        this.availableDates = this.dataService.getAvailableDates()
          .filter(d => d <= this.todayDate);
        this.loadCurrentEdition();
        this.cdr.detectChanges();
      }
    });
    this.subscriptions.push(dataSubscription);
    
    this.loadNewspaperData();

    // ── Remote-change detection ──────────────────────────────────────────────
    // Poll the server's lightweight /data/version endpoint every 5 minutes.
    // 5 min is sufficient for a read-only viewer — the version endpoint is
    // very cheap but polling faster than 5 min on a public site wastes server
    // resources. Admin sessions use 30 s (set in admin.component.ts).
    // SSR: do not start polling on the server — setInterval has no meaning
    // in a single-pass server render and the interval would leak.
    if (this.isBrowser) {
      this.dataService.startVersionPoll(300_000);
      const versionSub = this.dataService.remoteDataChanged$.subscribe(() => {
        // Only reload if the user is not viewing a modal (section detail / image)
        if (!this.showContentModal && !this.showImageModal) {
          // Targeted reload: fetch only the currently-displayed date's edition plus
          // the dates index. This is much cheaper than the full /data blob and
          // handles both "today's content changed" and "new date published" cases.
          // Falls back to loadData() automatically if the granular endpoints fail.
          this.dataService.reloadCurrentDateOnly(this.selectedDate).subscribe();
          // dataService.data$ subscriber above handles UI refresh automatically
        }
      });
      this.subscriptions.push(versionSub);
    }

    // Detect mobile/tablet view and keep it updated on resize (browser only)
    if (this.isBrowser) {
      this.updateIsMobileView();
      this.resizeListener = () => {
        clearTimeout(this.resizeDebounceTimer);
        this.resizeDebounceTimer = setTimeout(() => this.updateIsMobileView(), 150);
      };
      window.addEventListener('resize', this.resizeListener);
    }
  }

  ngOnDestroy() {
    this._viewDestroyed = true;
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.dataService.stopVersionPoll();
    this.clearSlowConnectionTimer();
    this.paginationObserver?.disconnect();
    clearTimeout(this.resizeDebounceTimer);
    if (this.isBrowser && this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
    }
  }

  private updateIsMobileView() {
    this.isMobileView = window.innerWidth <= 1024;
    if (!this.isMobileView && this.mobileHeaderMenuOpen) {
      this.mobileHeaderMenuOpen = false;
    }
    // OnPush: resize events fire outside Angular's zone — mark for check so the
    // template reflects the updated isMobileView / mobileHeaderMenuOpen values.
    this.cdr.markForCheck();
  }

  toggleMobileHeaderMenu() {
    this.mobileHeaderMenuOpen = !this.mobileHeaderMenuOpen;
  }

  closeMobileHeaderMenu() {
    this.mobileHeaderMenuOpen = false;
  }

  loadNewspaperData() {
    this.isLoading = true;
    // Public read-only viewer: opt into the light first-paint payload (fast
    // render, then background upgrade to full). The admin editor never passes
    // this, so it always loads the full, save-safe payload.
    this.dataService.loadData({ lightFirst: true }).subscribe({
      next: () => {
        // Filter future dates: public readers should never see editions whose
        // publication date has not yet been reached.
        this.availableDates = this.dataService.getAvailableDates()
          .filter(d => d <= this.todayDate);

        // Load global settings (also done in data$ subscriber, but
        // kept here so settings are guaranteed up-to-date before we
        // read defaultDate below).
        this.refreshSettings();
        
        // If no date was set from URL, use the default date from settings.
        // data$ is gated by initialLoadComplete, so no premature edition load
        // has happened — we simply set the correct date here.
        if (!this.route.snapshot.paramMap.has('date')) {
          const defaultDate = this.dataService.getDefaultDate();
          this.selectedDate = defaultDate;
          this.dataService.setCurrentDate(defaultDate);
        }
        
        // Single, authoritative loadCurrentEdition() call: always runs once
        // here after the date is finalised, preventing the double-call race
        // that left sectionImageLoading stuck at true for cached images.
        this.loadCurrentEdition();
        this.initialLoadComplete = true;
        this.isLoading = false;
        this.cdr.detectChanges();

        // Warm the previous day's edition during browser idle time. Readers
        // frequently navigate to "yesterday's paper"; pre-hydrating it through
        // the 4-layer cache makes that navigation instant. Best-effort only:
        // guarded, cancellable, never blocks the current view.
        this.prefetchPreviousDateOnIdle();
      },
      error: (error) => {
        console.error('Error loading newspaper data:', error);
        this.toaster.error('Failed to load newspaper data');
        this.pages = [];
        this.initialLoadComplete = true; // allow future data$ triggers to work
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  /**
   * Pre-warm the previous available date's edition during browser idle time.
   *
   * Best-effort and fully guarded: runs only in the browser, only when
   * requestIdleCallback exists, swallows all errors, and routes through the
   * existing 4-layer cache via hydrateDateIfMissing() so it never duplicates
   * a fetch already covered by cache. Has no effect on the current view.
   */
  private prefetchPreviousDateOnIdle(): void {
    if (!this.isBrowser) return;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric !== 'function') return;

    ric(() => {
      try {
        const dates = this.availableDates;
        const idx = dates.indexOf(this.selectedDate);
        // availableDates is sorted newest-first, so the NEXT index is the
        // previous (older) day — the common "yesterday's paper" navigation.
        const previousDate = idx >= 0 ? dates[idx + 1] : undefined;
        if (!previousDate) return;
        // Static-only warm: hits the fast snapshot file or does nothing.
        // Never falls back to PHP, so an un-backfilled date costs no time.
        this.dataService.prefetchDateInBackground(previousDate);
      } catch { /* never let a prefetch break the view */ }
    }, { timeout: 4000 });
  }

  /** Pull the latest global settings from the data service into component state. */
  private refreshSettings(): void {
    this.settings = this.dataService.getSettings();
    this.socialLinks = this.settings?.socialLinks || {};
    if (this.settings?.language) {
      this.translationService.setLanguage(this.settings.language);
    }
    // Cache localized values so the template reads plain properties instead of
    // re-executing service calls on every change-detection cycle.
    const lang = this.translationService.language;
    this.logoHref          = this.settings?.logo?.link?.trim() || this.document.baseURI;
    this.localizedEditor   = this.dataService.getLocalizedSetting(
      this.settings?.editorLabels, this.settings?.editor, lang
    );
    this.localizedAddressLine1 = this.dataService.getLocalizedSetting(
      this.settings?.address?.line1Labels, this.settings?.address?.line1, lang
    );
    this.localizedAddressLine2 = this.dataService.getLocalizedSetting(
      this.settings?.address?.line2Labels, this.settings?.address?.line2, lang
    );
    this.localizedPhone = this.dataService.getLocalizedSetting(
      this.settings?.address?.phoneLabels, this.settings?.address?.phone, lang
    );
    this.todayDisplayDate = this.translationService.formatDate(this.todayDate, 'full');
  }

  loadCurrentEdition() {
    // LAZY HYDRATION: loadDataFromGranular() only fetches editions for
    // latestDate + today.  If the viewer navigates (URL, date picker, prev/
    // next day) to a date not yet hydrated, getEditionsByDate() returns []
    // and the user sees a blank page.  hydrateDateIfMissing() is a no-op
    // when the date is already loaded, otherwise it fetches it through the
    // 4-layer EditionCache before we run the render path below.
    this.dataService.hydrateDateIfMissing(this.selectedDate).subscribe({
      next: () => this.renderCurrentEdition(),
      error: () => this.renderCurrentEdition(), // already swallowed inside helper
    });
  }

  private renderCurrentEdition() {
    // Resolve pending edition slug first so getCurrentEdition() uses the correct number
    if (this.pendingEditionSlug) {
      this.selectedEditionNumber = this.getEditionFromSlug(this.pendingEditionSlug);
      this.pendingEditionSlug = null;
    }

    // A background refresh is any call after the initial load with no pending
    // URL slugs. For these we want to restore the user's position and avoid
    // showing skeleton loaders for thumbnails/images whose URLs haven't changed.
    const isBackgroundRefresh = this.initialLoadComplete &&
                                !this.pendingPageSlug &&
                                !this.pendingSectionSlug;

    // Snapshot position before resetting state so we can restore it below.
    const prevPageId    = this.currentPage?.id ?? null;
    const prevSectionId = this.selectedSection?.id ?? null;
    const prevMainUrl   = this.currentPage
      ? this.resolveImageUrl((this.currentPage.fullImage ?? '').trim())
      : null;

    // Reset main view so the image element gets recreated when date changes
    this.currentPage = null;
    this.selectedSection = null;
    this.linkedSections = [];
    this.croppedSectionImage = null;
    this.imageLoaded = false;
    this.sectionImageLoading = false;
    this.cropCache.clear();

    // Populate edition tabs for current date
    this.editionsForDate = this.dataService.getEditionsByDate(this.selectedDate);

    const edition = this.dataService.getCurrentEdition(this.selectedEditionNumber);
    if (edition) {
      this.pages = [...edition.pages].sort((a, b) => a.id - b.id);
      // Rebuild section-ID lookup once here so loadLinkedSections() can do
      // O(1) lookups instead of O(pages × sections) on every section click.
      this._sectionByIdCache = new Map<string, NewsSection>();
      for (const page of this.pages) {
        for (const section of page.sections) {
          this._sectionByIdCache.set(section.id, { ...section, pageId: page.id });
        }
      }
      // Parallel thumbnail seeding — all pages get their src assigned at
      // once. The sequential queue was removed because @defer (on viewport)
      // caused it to permanently stall: the queue advances via (load), but
      // (load) only fires when the <img> renders, and deferred blocks only
      // render when the item enters the viewport. Any out-of-viewport page
      // silently blocked every subsequent page from loading.
      // The browser's own connection pool (6 concurrent per host) provides
      // natural throttling; thumbnails are loaded eagerly (no loading="lazy").
      this.thumbnailsLoading = {};
      this.pageThumbnailSrcs = {};
      // Capture the date NOW so onThumbnailLoad always writes the cache key for
      // the date these thumbnails belong to, regardless of when (load) fires.
      this._thumbnailRenderDate = this.selectedDate;

      this.pages.forEach(page => {
        const thumb  = typeof page.thumbnail === 'string' ? page.thumbnail.trim() : '';
        const full   = typeof page.fullImage  === 'string' ? page.fullImage.trim()  : '';
        const newSrc = this.resolveImageUrl(thumb || full);
        const cacheKey = `${this._thumbnailRenderDate}:${page.id}`;

        if (newSrc && this._thumbnailSrcCache.get(cacheKey) === newSrc) {
          // URL previously confirmed loaded for this date+page — restore
          // immediately with no skeleton. The cross-date cache survives date
          // navigation so returning to a visited date never re-shows skeleton.
          this.pageThumbnailSrcs[page.id] = newSrc;
          this.thumbnailsLoading[page.id] = false;
        } else {
          // New or first-time URL — show skeleton until (load) fires.
          this.pageThumbnailSrcs[page.id] = newSrc;
          this.thumbnailsLoading[page.id] = !!newSrc;
          if (!newSrc) {
            // No image at all — clear skeleton immediately.
            this.thumbnailsLoading[page.id] = false;
          }
        }
      });

      if (this.pages.length > 0) {
        // Resolve target page:
        //   1. Honour an explicit pending URL slug (deep link).
        //   2. On a background refresh, restore the page the user was viewing.
        //   3. Fall back to the first page.
        let targetPage = this.pages[0];
        if (this.pendingPageSlug) {
          const resolvedPage = this.getPageFromSlug(this.pendingPageSlug);
          if (resolvedPage) targetPage = resolvedPage;
          this.pendingPageSlug = null;
        } else if (isBackgroundRefresh && prevPageId !== null) {
          const prevPage = this.pages.find(p => p.id === prevPageId);
          if (prevPage) targetPage = prevPage;
        }

        // Pre-mark the main image as loaded when the URL hasn't changed so the
        // skeleton doesn't flash before selectPage's own setTimeout can confirm it.
        const preserveMainImage = isBackgroundRefresh && prevMainUrl !== null &&
          !!prevMainUrl && this.resolveImageUrl((targetPage.fullImage ?? '').trim()) === prevMainUrl;
        if (preserveMainImage) {
          this.imageLoaded = true;
        }

        if (this.pendingSectionSlug) {
          // Navigate to section; fall back to target page with no section selected
          const sectionSlug = this.pendingSectionSlug;
          this.pendingSectionSlug = null;
          const found = this.navigateToSection(sectionSlug);
          if (!found) {
            this.selectPage(targetPage);
          }
        } else {
          // No section pending — restore the previously-selected section on a
          // background refresh; otherwise show page without auto-selecting one.
          this.selectPage(
            targetPage,
            isBackgroundRefresh && prevSectionId ? prevSectionId : undefined,
            preserveMainImage
          );
        }
      } else {
        this.currentPage = null;
        this.selectedSection = null;
      }
    } else {
      this.pages = [];
      this._sectionByIdCache.clear();
      this.currentPage = null;
      this.selectedSection = null;
      this.croppedSectionImage = null;
      this.linkedSections = [];
      this.thumbnailsLoading = {};
      this.pageThumbnailSrcs = {};
    }
    this.updateDisplayDate();
    // Recalculate pagination after all page/edition state has settled.
    this.updatePaginationPages();
    this.cdr.detectChanges();
  }

  navigateToSection(sectionSlug: string): boolean {
    // Accept canonical post IDs plus legacy IDs from older links.
    const slugValue = (sectionSlug || '').trim();
    const idsToFind = new Set<string>([slugValue]);

    if (slugValue.startsWith('post-')) {
      const suffix = slugValue.slice('post-'.length);
      idsToFind.add(`section-${suffix}`);
      idsToFind.add(suffix);
    } else if (slugValue.startsWith('section-')) {
      const suffix = slugValue.slice('section-'.length);
      idsToFind.add(`post-${suffix}`);
      idsToFind.add(suffix);
    } else if (slugValue) {
      idsToFind.add(`post-${slugValue}`);
      idsToFind.add(`section-${slugValue}`);
    }

    for (const page of this.pages) {
      // Try all known ID aliases first (post- / section- / bare ID)
      let section = page.sections.find(s => idsToFind.has((s.id || '').trim()));

      // Fall back to legacy title-based slug match so older shared links keep working.
      if (!section) {
        section = page.sections.find(s => {
          return this.createLegacySectionSlug(s.title, s.id) === slugValue;
        });
      }

      if (section) {
        this.selectPage(page, section.id);
        return true;
      }
    }

    return false;
  }

  updateDisplayDate() {
    this.displayDate = this.translationService.formatDate(this.selectedDate, 'full');
  }

  // localizedEditor, localizedAddressLine1/2, localizedPhone, todayDisplayDate, logoHref
  // are now plain properties computed in refreshSettings() — see class field declarations above.

  checkIfToday() {
    this.isToday = this.selectedDate === this.todayDate;
  }

  // --- URL slug helpers ---

  /** Returns the zero-padded URL slug for a page, e.g. 'page-01'. Public for use in template. */
  getPageSlug(page: NewspaperPage): string {
    const index = this.pages.indexOf(page);
    const num = index >= 0 ? index + 1 : 1;
    return `page-${String(num).padStart(2, '0')}`;
  }

  private getPageFromSlug(slug: string): NewspaperPage | null {
    const match = /^page-(\d+)$/.exec(slug);
    if (!match) return null;
    const index = parseInt(match[1], 10) - 1;
    return this.pages[index] ?? null;
  }

  /** Returns the zero-padded URL slug for an edition, e.g. 'edition-01'. Public for use in template. */
  getEditionSlug(editionNumber: number): string {
    return `edition-${String(editionNumber).padStart(2, '0')}`;
  }

  private getEditionFromSlug(slug: string): number {
    const match = /^edition-(\d+)$/.exec(slug);
    return match ? parseInt(match[1], 10) : 1;
  }

  // --- trackBy helpers for *ngFor performance ---
  trackByPageId(_: number, page: NewspaperPage): number { return page.id; }
  trackBySectionId(_: number, section: NewsSection): string { return section.id; }
  trackByDate(_: number, date: string): string { return date; }
  trackByEditionKey(_: number, ed: NewspaperEdition): string { return `${ed.date}-${ed.edition ?? 1}`; }
  trackByLinkedSectionId(_: number, section: NewsSection): string { return section.id; }
  trackByIndex(index: number, _?: unknown): number { return index; }

  onDateChange() {
    this.selectedEditionNumber = 1;
    this.userNavigated = true;
    this.dataService.setCurrentDate(this.selectedDate);
    this.loadCurrentEdition();
    this.checkIfToday();
  }

  previousDay() {
    const date = new Date(this.selectedDate + 'T00:00:00');
    date.setDate(date.getDate() - 1);
    this.selectedDate = date.toISOString().split('T')[0];
    this.onDateChange();
  }

  nextDay() {
    if (!this.isToday) {
      const date = new Date(this.selectedDate + 'T00:00:00');
      date.setDate(date.getDate() + 1);
      this.selectedDate = date.toISOString().split('T')[0];
      this.onDateChange();
    }
  }

  onDatePickerChange(date: string) {
    this.selectedDate = date;
    this.onDateChange();
  }

  onEditionChange(editionNumber: number) {
    this.selectedEditionNumber = editionNumber;
    this.editionDropdownOpen = false;
    this.userNavigated = true;
    this.loadCurrentEdition();
  }

  /** Called when the user explicitly clicks a page thumbnail or pagination button. */
  onPageClick(page: NewspaperPage) {
    this.userNavigated = true;
    this.selectPage(page);
  }

  editionDropdownOpen = false;
  pageDropdownOpen = false;
  leftPanelVisible = true;

  get currentEdition(): NewspaperEdition | null {
    return this.editionsForDate.find(e => (e.edition || 1) === this.selectedEditionNumber) || this.editionsForDate[0] || null;
  }

  /**
   * Returns the best absolute HTTP(S) image URL for the selected section —
   * safe to use as an OG image. Never returns a data: URL (which crawlers
   * and social platforms cannot fetch).
   */
  get shareImageUrl(): string {
    const sectionImg = this.selectedSection?.imageUrl?.trim() ?? '';
    if (sectionImg) return this.resolveImageUrl(sectionImg);
    const pageImg = this.currentPage?.fullImage?.trim() ?? '';
    if (pageImg) return this.resolveImageUrl(pageImg);
    return '';
  }

  /** Returns the display label for an edition in the current UI language. */
  getEditionLabel(ed: NewspaperEdition): string {
    const label = this.dataService.getEditionDisplayLabel(ed, this.translationService.language);
    return label || this.translationService.getEditionName(ed.edition || 1);
  }

  /** Returns the display label for a page in the current UI language. */
  getPageLabel(page: NewspaperPage): string {
    const label = this.dataService.getPageDisplayLabel(page, this.translationService.language);
    return label || this.translationService.getPageName(this.pages.indexOf(page) + 1);
  }

  formatShortDate(dateStr: string): string {
    return this.translationService.formatDate(dateStr, 'short');
  }
  //   });
  // }

  selectPage(page: NewspaperPage, targetSectionId?: string, preserveImageLoaded = false) {
    this.currentPage = page;
    // Refresh the cached pagination array whenever the active page changes.
    this.updatePaginationPages();
    if (!preserveImageLoaded) {
      this.imageLoaded = false;
      this.startSlowConnectionTimer();

      // If the image is already cached, the load event may not fire
      setTimeout(() => {
        const img = this.mainImageRef?.nativeElement;
        if (img && img.complete && img.naturalWidth > 0) {
          this.onImageLoad();
        }
      }, 0);
    }

    if (targetSectionId) {
      // Section explicitly requested — find and select it
      if (page.sections && page.sections.length > 0) {
        const targetSection = page.sections.find(s => s.id === targetSectionId);
        this.selectSection(targetSection ?? page.sections[0]);
        setTimeout(() => {
          const rightPanel = this.document.querySelector('.right-panel');
          if (rightPanel) (rightPanel as HTMLElement).scrollTop = 0;
        }, 0);
      } else {
        this.selectedSection = null;
        this.linkedSections = [];
        this.croppedSectionImage = null;
        this.sectionImageLoading = false;
        this.updateUrl();
        this.updateMetaTags(null);
      }
    } else {
      // No section: clear section state and show the placeholder panel
      this.selectedSection = null;
      this.linkedSections = [];
      this.croppedSectionImage = null;
      this.sectionImageLoading = false;
      this.sectionImageError = false;
      this.showContentModal = false;
      this.showImageModal = false;
      setTimeout(() => {
        const rightPanel = this.document.querySelector('.right-panel');
        if (rightPanel) (rightPanel as HTMLElement).scrollTop = 0;
      }, 0);
      this.updateUrl();
      this.updateMetaTags(null);
    }
  }

  onThumbnailLoad(pageId: number) {
    this.thumbnailsLoading[pageId] = false;
    // Persist the confirmed-loaded src in the cross-date cache so that
    // returning to this date skips the skeleton entirely.
    // Use _thumbnailRenderDate (captured at render time) rather than
    // selectedDate: if the user navigates dates quickly, selectedDate may
    // already point to the NEW date when this (load) event fires, which
    // would write the cache key for the wrong date.
    const src = this.pageThumbnailSrcs[pageId];
    if (src && this._thumbnailRenderDate) {
      this._thumbnailSrcCache.set(`${this._thumbnailRenderDate}:${pageId}`, src);
    }
    // OnPush: thumbnailsLoading is a plain object (mutated in-place, no new
    // reference). markForCheck() ensures the template re-evaluates the
    // skeleton @if and opacity binding after the mutation.
    this.cdr.markForCheck();
  }

  onThumbnailError(pageId: number) {
    // Clear the skeleton on image load failure, but do NOT cache the URL.
    // Caching a failed src in _thumbnailSrcCache would cause every future
    // visit to this date to skip the skeleton but show a permanently broken
    // image — the cache hit logic assumes the URL was successfully loaded.
    this.thumbnailsLoading[pageId] = false;
    this.cdr.markForCheck();
  }

  onImageLoad() {
    this.clearSlowConnectionTimer();
    this.imageLoaded = true;
    // markForCheck is required here: this method is called both from the
    // template (load) binding (where Angular handles CD automatically) AND
    // from a setTimeout() in selectPage() for browser-cached images (where
    // it runs outside Angular's event cycle). Without markForCheck(), setting
    // imageLoaded = true from setTimeout never triggers OnPush re-evaluation
    // and the skeleton persists indefinitely for already-cached images.
    this.cdr.markForCheck();

    // Store reference to the loaded image for cropping
    const imgElement = this.document.querySelector('.main-page-image') as HTMLImageElement;
    if (imgElement) {
      this.imageElement = imgElement;
      // If a section is already selected, crop it and reload linked sections
      if (this.selectedSection) {
        this.cropSectionImage();
        // Reload linked sections now that image is available for cropping
        this.loadLinkedSections(this.selectedSection);
      }
    }
  }

  onImageError() {
    this.clearSlowConnectionTimer();
    this.imageLoaded = true;
    this.cdr.markForCheck(); // same reason as onImageLoad()
  }

  /** Reload the entire page when the user requests it from the slow-connection notice. */
  refreshPage(): void {
    this.document.defaultView?.location.reload();
  }

  /**
   * Starts an 8-second timer; if the image is still not loaded when it fires,
   * shows the slow-connection notice.
   */
  private startSlowConnectionTimer(): void {
    this.clearSlowConnectionTimer();
    this.slowConnectionTimer = setTimeout(() => {
      if (!this.imageLoaded) {
        this.showSlowConnectionWarning = true;
        this.cdr.detectChanges();
      }
    }, 8000);
  }

  private clearSlowConnectionTimer(): void {
    if (this.slowConnectionTimer !== undefined) {
      clearTimeout(this.slowConnectionTimer);
      this.slowConnectionTimer = undefined;
    }
    this.showSlowConnectionWarning = false;
  }

  /**
   * Cached pagination items for the template — updated by updatePaginationPages()
   * whenever pages, currentPage, or paginationContainerWidth change.
   *
   * Numbers are 1-based indices into this.pages[]. null = ellipsis slot.
   * Keeping this as a plain property (instead of a getter called every render)
   * eliminates repeated array allocations and indexOf() scans on every CD cycle.
   */
  paginationPages: (number | null)[] = [];

  /**
   * Recalculate paginationPages and store the result. Called whenever the
   * inputs change: page list, selected page, or measured container width.
   *
   * If the container is wide enough to fit all page buttons on one line they
   * are all shown; otherwise a 7-slot window with ellipsis keeps it single-line.
   */
  private updatePaginationPages(): void {
    const total = this.pages.length;

    // Each page button: min-width 32px; numbers ≥10 render wider (~44px).
    // 2 nav arrows (32px each) + gaps (4px × (total+1 slots)).
    const allFit = (): boolean => {
      if (this.paginationContainerWidth <= 0) return total <= 7;
      const needed = 64
        + this.pages.reduce((s, p) => s + (p.id >= 10 ? 44 : 32), 0)
        + (total + 1) * 4;
      return needed <= this.paginationContainerWidth;
    };

    if (allFit()) {
      this.paginationPages = Array.from({ length: total }, (_, i) => i + 1);
      return;
    }

    // Windowed: exactly 7 slots with ellipsis so the bar stays single-line.
    const current = this.pages.indexOf(this.currentPage!) + 1;
    if (current <= 4) {
      this.paginationPages = [1, 2, 3, 4, 5, null, total];
    } else if (current >= total - 3) {
      this.paginationPages = [1, null, total - 4, total - 3, total - 2, total - 1, total];
    } else {
      this.paginationPages = [1, null, current - 1, current, current + 1, null, total];
    }
  }

  /**
   * On-demand article-body hydration for the light first-paint payload.
   *
   * The light payload keeps article `content` only for the first page; other
   * pages' bodies are blank until the background upgrade completes. If the
   * reader opens such an article before then (most notably via a deep link),
   * this fetches the full edition and patches the bodies into the bound fields
   * (`selectedSection`, `linkedSections`, `modalLinkedSections`) so the panel and
   * modal render immediately. No-op when the body is already present (the common
   * case) and fully guarded — on failure the existing content simply remains.
   */
  private ensureSelectedSectionContent(section: NewsSection): void {
    if (!this.isBrowser) return;
    if (section.content && section.content.trim().length > 0) return; // already hydrated

    const capturedId = section.id;
    this.dataService.getFullEditionsForDate(this.selectedDate).subscribe(fullEditions => {
      // Bail if the fetch was empty or the reader has moved to another section.
      if (!fullEditions || fullEditions.length === 0) return;
      const current = this.selectedSection;
      if (!current || current.id !== capturedId) return;

      // id → content across the whole edition (linked sections may be on other pages).
      const contentById = new Map<string, string>();
      for (const ed of fullEditions) {
        for (const page of ed.pages ?? []) {
          for (const s of page.sections ?? []) {
            contentById.set(s.id, s.content ?? '');
          }
        }
      }
      // Nothing to add (e.g. snapshot genuinely has empty content) → leave as-is.
      if (!contentById.has(capturedId)) return;

      this.selectedSection = { ...current, content: contentById.get(capturedId)! };
      this.linkedSections = (this.linkedSections ?? []).map(s =>
        contentById.has(s.id) ? { ...s, content: contentById.get(s.id)! } : s,
      );
      this.modalLinkedSections = (this.modalLinkedSections ?? []).map(s =>
        contentById.has(s.id) ? { ...s, content: contentById.get(s.id)! } : s,
      );
      this.cdr.detectChanges();
    });
  }

  selectSection(section: NewsSection) {
    this.selectedSection = section;
    this.sectionImageError = false;

    // Load linked sections
    this.loadLinkedSections(section);

    // Light first-paint payload strips article bodies from non-first pages. If
    // this section's body is empty, fetch the full edition on demand and patch
    // the bodies into the bound fields (covers a deep-linked article opened
    // before the background upgrade finishes). No-op when content is present.
    // Runs AFTER loadLinkedSections so it can patch the freshly-built lists.
    this.ensureSelectedSectionContent(section);
    
    // Use imageUrl if available, otherwise crop from main image
    if (section.imageUrl) {
      const isExternalUrl = section.imageUrl.startsWith('http://') || section.imageUrl.startsWith('https://');
      const imagePath = isExternalUrl
        ? section.imageUrl
        : (section.imageUrl.startsWith('/') ? section.imageUrl : `/${section.imageUrl}`);
      const resolvedUrl = this.resolveImageUrl(imagePath);
      
      // Only show loader when the URL is actually changing — if the same
      // src is already in the <img>, the browser won't fire (load) again
      // and sectionImageLoading would stay true forever.
      this.sectionImageLoading = resolvedUrl !== this.croppedSectionImage;
      this.croppedSectionImage = resolvedUrl;

      // Safety net: after Angular's next change-detection pass, check whether
      // the <img> is already complete (e.g. pulled from browser cache) but
      // the load event was never received.  If so, clear the loading flag.
      if (this.sectionImageLoading) {
        const capturedSection = section;
        setTimeout(() => {
          if (this.sectionImageLoading && this.selectedSection === capturedSection) {
            const imgEl = this.document.querySelector('.section-full-image') as HTMLImageElement;
            if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
              this.sectionImageLoading = false;
              this.cdr.detectChanges();
            }
          }
        }, 0);
      }
    } else {
      this.croppedSectionImage = null;
      this.sectionImageLoading = true;
      this.cropSectionImage();
    }
    
    // Scroll right panel to top when new section is selected
    const rightPanel = this.document.querySelector('.right-panel') as HTMLElement | null;
    if (rightPanel) {
      rightPanel.scrollTop = 0;
    }

    // For mobile/tablet: open image modal directly on section select
    if (this.isMobileView) {
      if (!this.sectionImageLoading && this.croppedSectionImage) {
        // Image already ready (e.g. same URL re-selected)
        setTimeout(() => this.openImageModal(), 0);
      } else {
        this.pendingMobileModal = true;
      }
    }
    
    // Update URL with section
    this.updateUrl();
    // Update social sharing meta tags
    this.updateMetaTags(section);
  }

  onSectionImageLoad() {
    this.sectionImageLoading = false;
    if (this.pendingMobileModal) {
      this.pendingMobileModal = false;
      this.openImageModal();
    }
    this.cdr.detectChanges();
  }

  onSectionImageError() {
    this.sectionImageLoading = false;
    this.sectionImageError = true;
    if (this.pendingMobileModal) {
      this.pendingMobileModal = false;
      if (this.selectedSection && this.currentPage) {
        const allSections = this.getModalSectionOrder();
        // The main image failed — keep null for the first slot and show the
        // selected section's title so the user has context for the error.
        this.modalImage = null;
        this.modalImageTitle = this.selectedSection.title;
        this.modalLinkedSections = allSections.filter(s => s.id !== this.selectedSection!.id);
        this.mobileModalView = 'image';
        this.showImageModal = true;
      }
    }
    this.cdr.detectChanges();
  }

  onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  onAssetLogoError(): void {
    this.assetLogoError = true;
  }

  onLinkedSectionImageError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  resolveImageUrl(url: string): string {
    // Guard: PHP may serialize empty fields as [] (truthy array) instead of "".
    if (!url || typeof url !== 'string') return '';
    const cached = this.resolvedUrlCache.get(url);
    if (cached !== undefined) return cached;

    let resolved: string;
    if (url.startsWith('data:')) {
      resolved = url;
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // Normalize WordPress uploads absolute URLs to the current WP origin.
      // This fixes images after a domain migration: source_url saved with the
      // old domain is rewritten to the current WP_BASE_URL host so the browser
      // can resolve them without touching the database.
      if (url.includes('/wp-content/uploads/')) {
        try {
          const wpOrigin = new URL(this.dataService.getApiBaseUrl()).origin;
          const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)$/);
          resolved = pathMatch ? wpOrigin + pathMatch[1] : url;
        } catch { resolved = url; /* malformed URL — fall through and return as-is */ }
      } else {
        resolved = url;
      }
    } else {
      // Relative URL — prepend the WordPress base URL so the browser resolves it
      // against the WP host rather than the Angular dev server.
      const base = this.dataService.getApiBaseUrl();
      resolved = url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
    }

    this.resolvedUrlCache.set(url, resolved);
    return resolved;
  }

  closeSection() {
    this.selectedSection = null;
    this.croppedSectionImage = null;
    this.showContentModal = false;
    this.showImageModal = false;
    this.showShareDropdown = false;
    this.linkedSections = [];
    this.sectionImageLoading = false;
    this.pendingMobileModal = false;

    // User explicitly closed the section — update URL to page/edition only
    this.userNavigated = true;
    this.updateUrl();
    // Reset social sharing meta tags to site defaults
    this.updateMetaTags(null);
  }

  openContentModal() {
    this.showContentModal = true;
  }

  toggleShareDropdown(event: Event): void {
    event.stopPropagation();
    this.showShareDropdown = !this.showShareDropdown;
    if (this.showShareDropdown) {
      // Close on next outside click
      setTimeout(() => {
        const closeHandler = () => {
          this.showShareDropdown = false;
          this.cdr.markForCheck();
          this.document.removeEventListener('click', closeHandler);
        };
        this.document.addEventListener('click', closeHandler);
      });
    }
  }

  closeContentModal() {
    this.showContentModal = false;
  }

  openImageModal() {
    if (this.croppedSectionImage && this.selectedSection && this.currentPage) {
      const allSections = this.getModalSectionOrder();

      // Set first section as main modal image
      const firstSection = allSections[0];
      this.modalImage = firstSection.pageId === this.currentPage.id ? this.croppedSectionImage : this.getCroppedImageForSection(firstSection);
      this.modalImageTitle = firstSection.title;
      
      // Rest of the sections
      this.modalLinkedSections = allSections.slice(1);
      this.mobileModalView = 'image';
      this.showImageModal = true;
    }
  }

  closeImageModal() {
    this.showImageModal = false;
    this.modalImage = null;
    this.modalImageTitle = '';
    this.modalLinkedSections = [];
    this.mobileModalView = 'image';
  }

  private getPrintDocument(contentHtml: string, styles: string = ''): string {
    // <thead> repeats at top of every page (no overlap). <tfoot> spacer bounds tbody so it
    // cannot flow under the position:fixed footer. The visible footer is outside the table.
    return `<!DOCTYPE html><html><head><title></title><style>${this.getPrintStyles()}${styles}</style></head><body><table class="print-table"><thead><tr><td><div class="print-header"><div class="print-header-left"></div><span class="print-header-date"></span></div></td></tr></thead><tbody><tr><td><main class="print-content">${contentHtml}</main></td></tr></tbody><tfoot><tr><td><div class="print-footer-spacer"></div></td></tr></tfoot></table><div class="print-footer"></div></body></html>`;
  }

  private getPrintStyles(): string {
    return `*{box-sizing:border-box;}html,body{margin:0;padding:0;background:white;color:#000;font-family:sans-serif;font-size:16px;line-height:1.7;}.print-table{width:100%;border-collapse:collapse;border-spacing:0;}.print-table thead td,.print-table tfoot td{padding:0;margin:0;}.print-table tbody td{padding:0;vertical-align:top;}.print-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px;border-bottom:2px solid #ccc;background:white;font-family:sans-serif;}.print-header-left{display:flex;align-items:center;gap:12px;min-width:0;}.logo-img{height:40px;width:auto;max-width:220px;object-fit:contain;}.logo-text{font-size:20px;font-weight:600;overflow-wrap:anywhere;}.print-header-date{font-size:14px;color:#444;white-space:nowrap;}.print-content{padding:16px 20px;}.print-footer{padding:12px 20px;border-top:2px solid #ccc;font-size:14px;line-height:1.5;color:#555;background:white;font-family:sans-serif;}.footer-editor{font-weight:bold;display:block;margin-bottom:4px;}.footer-detail{display:block;overflow-wrap:anywhere;}h1{font-size:22px;line-height:1.3;margin:0 0 14px;}article{font-family:serif;overflow-wrap:anywhere;}article p{margin:0 0 10px;}img{max-width:100%;height:auto;}@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}@page{margin:15mm;}.print-footer{position:fixed;bottom:0;left:0;right:0;z-index:100;}.print-footer-spacer{display:block;}h1,img{break-inside:avoid;page-break-inside:avoid;}img{max-height:185mm;width:auto;}}`;
  }

  printContent(content: string, title: string): void {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(this.getPrintDocument('<h1></h1><article></article>'));
    win.document.close();
    this.populatePrintHeaderFooter(win);
    const titleEl = win.document.querySelector('title');
    if (titleEl) titleEl.textContent = title;
    const h1El = win.document.querySelector('h1');
    if (h1El) h1El.textContent = title;
    const articleEl = win.document.querySelector('article');
    if (!articleEl) return;
    articleEl.innerHTML = this.normalizeContent(content);

    // Defer print until the header logo image has loaded; otherwise the logo is
    // blank because win.print() fires before the network request completes.
    const doPrint = () => { this.applyPrintContentPadding(win); win.print(); win.close(); };
    const logoImg = win.document.querySelector('.logo-img') as HTMLImageElement | null;
    if (logoImg && !logoImg.complete) {
      logoImg.onload  = doPrint;
      logoImg.onerror = doPrint; // still print even if logo fails to load
    } else {
      doPrint();
    }
  }

  /** Replace &nbsp; entities and Unicode non-breaking spaces with regular spaces
   *  so text wraps naturally in the article viewer and print window. */
  normalizeContent(content: string | undefined | null): string {
    if (!content) return '';
    return content
      .replace(/&nbsp;/g, ' ')
      .replace(/\u00a0/g, ' ');
  }

  printImage(imageUrl: string, title: string): void {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(this.getPrintDocument('<div class="img-container"><img/></div>', '.img-container{display:flex;justify-content:center;align-items:flex-start;}.img-container img{display:block;max-width:100%;max-height:185mm;height:auto;object-fit:contain;}'));
    win.document.close();
    this.populatePrintHeaderFooter(win);
    const titleEl = win.document.querySelector('title');
    if (titleEl) titleEl.textContent = title;
    const imgEl = win.document.querySelector('.img-container img') as HTMLImageElement | null;
    if (imgEl) {
      imgEl.alt = title;
      imgEl.src = imageUrl;
      imgEl.onload = () => { this.applyPrintContentPadding(win); win.print(); win.close(); };
    }
  }

  printAllModalImages(): void {
    const images: { src: string; alt: string }[] = [];
    if (this.modalImage) {
      images.push({ src: this.modalImage, alt: this.modalImageTitle });
    }
    for (const linked of this.modalLinkedSections) {
      const src = this.getCroppedImageForSection(linked);
      if (src) images.push({ src, alt: linked.title });
    }
    if (images.length === 0) return;

    const win = window.open('', '_blank');
    if (!win) return;

    // Write a minimal skeleton — no user content injected as HTML
    win.document.write(this.getPrintDocument('<div class="images-container"></div>', '.images-container{display:flex;flex-direction:column;gap:30px;align-items:center;}.print-image{width:100%;max-width:100%;max-height:185mm;height:auto;object-fit:contain;display:block;break-inside:avoid;page-break-inside:avoid;}'));
    win.document.close();

    this.populatePrintHeaderFooter(win);

    // Add all images; print once all are loaded
    const container = win.document.querySelector('.images-container')!;
    let loadedCount = 0;
    const checkPrint = () => {
      loadedCount++;
      if (loadedCount >= images.length) { this.applyPrintContentPadding(win); win.print(); win.close(); }
    };
    for (const img of images) {
      const el = win.document.createElement('img');
      el.className = 'print-image';
      el.alt = img.alt;
      el.onload = checkPrint;
      el.onerror = checkPrint;
      el.src = img.src;
      container.appendChild(el);
    }
  }

  /** Measures the footer at A4 content width (680 px ≈ 180 mm) and sets the <tfoot> spacer
   *  to the same height so <tbody> content is always bounded above the position:fixed footer. */
  private applyPrintContentPadding(win: Window): void {
    const body = win.document.body;
    const savedWidth    = body.style.width;
    const savedOverflow = body.style.overflow;
    body.style.width    = '680px';
    body.style.overflow = 'hidden';

    const footerEl = win.document.querySelector('.print-footer') as HTMLElement | null;
    const footerH  = (footerEl?.offsetHeight ?? 90) + 12; // 12 px breathing room

    body.style.width    = savedWidth;
    body.style.overflow = savedOverflow;

    const spacerEl = win.document.querySelector('.print-footer-spacer') as HTMLElement | null;
    if (spacerEl) spacerEl.style.height = footerH + 'px';
  }

  private populatePrintHeaderFooter(win: Window): void {
    const headerLeft = win.document.querySelector('.print-header-left')!;
    const logo = this.settings?.logo;
    if (logo?.url) {
      const logoImg = win.document.createElement('img');
      logoImg.className = 'logo-img';
      logoImg.alt = logo.alt || 'Logo';
      logoImg.src = logo.url;
      headerLeft.appendChild(logoImg);
    } else {
      const logoText = win.document.createElement('span');
      logoText.className = 'logo-text';
      logoText.textContent = logo?.alt || 'Digital Newspaper';
      headerLeft.appendChild(logoText);
    }
    const dateEl = win.document.querySelector('.print-header-date')!;
    dateEl.textContent = this.displayDate;
    const footerEl = win.document.querySelector('.print-footer')!;
    const editorEl = win.document.createElement('strong');
    editorEl.className = 'footer-editor';
    editorEl.textContent = 'সম্পাদকঃ আযম মীর শাহীদুল আহসান';
    footerEl.appendChild(editorEl);
    const detailEl = win.document.createElement('span');
    detailEl.className = 'footer-detail';
    detailEl.textContent = 'বাংলাদেশ পাবলিকেশন লিঃ- এর পক্ষে আবুল আসাদ কর্তৃক আল ফালাহ প্রিন্টিং প্রেস, ৪২৩ বড় মগবাজার, ঢাকা-১২১৭ থেকে মুদ্রিত ও প্রকাশিত। পিএবিএক্সঃ 02222226448, 02222226362, 02222226862, 0248318128, 0248321073, 0258310013, 01775489135 (বিজ্ঞাপন)। ই-মেইল : news@dailysangram.com, ad@dailysangram.com (বিজ্ঞাপন)';
    footerEl.appendChild(detailEl);
  }

  async downloadImage(imageUrl: string, title: string): Promise<void> {
    const tryFetch = async (url: string): Promise<Blob | null> => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return await resp.blob();
      } catch {
        return null;
      }
    };

    // Try direct fetch; fall back to proxy for cross-origin images
    let blob = await tryFetch(imageUrl);
    if (!blob) {
      const isExternal = imageUrl.startsWith('http://') || imageUrl.startsWith('https://');
      if (isExternal) {
        const proxyUrl = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/proxy?url=${encodeURIComponent(imageUrl)}`;
        blob = await tryFetch(proxyUrl);
      }
    }

    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = this.document.createElement('a');
      a.href = url;
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      a.download = `${title || 'image'}.${ext}`;
      this.document.body.appendChild(a);
      a.click();
      this.document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      window.open(imageUrl, '_blank');
    }
  }

  async downloadAllModalImages(): Promise<void> {
    const images: { src: string; alt: string }[] = [];
    if (this.modalImage) {
      images.push({ src: this.modalImage, alt: this.modalImageTitle });
    }
    for (const linked of this.modalLinkedSections) {
      const src = this.getCroppedImageForSection(linked);
      if (src) images.push({ src, alt: linked.title });
    }
    for (let i = 0; i < images.length; i++) {
      await this.downloadImage(images[i].src, images[i].alt);
      // Brief pause between downloads so the browser registers each one separately
      if (i < images.length - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 400));
      }
    }
  }

  openLinkedSectionImage(linkedSection: NewsSection) {
    if (this.selectedSection && this.currentPage) {
      const allSections = this.getModalSectionOrder(linkedSection);

      // Set first section as main modal image
      const firstSection = allSections[0];
      this.modalImage = firstSection.pageId === this.currentPage.id ? this.croppedSectionImage : this.getCroppedImageForSection(firstSection);
      this.modalImageTitle = firstSection.title;
      
      // Rest of the sections
      this.modalLinkedSections = allSections.slice(1);
      this.showImageModal = true;
    }
  }

  private loadLinkedSections(section: NewsSection) {
    this.linkedSections = [];

    // Use the pre-built lookup (populated in renderCurrentEdition()) instead of
    // rebuilding it from scratch on every section click — O(1) vs O(pages × sections).
    const sectionById = this._sectionByIdCache;

    // 1) Forward-linked sections: those this section explicitly names in linkedSectionIds.
    const forwardIds = new Set<string>(section.linkedSectionIds ?? []);
    const forwardLinked: NewsSection[] = (section.linkedSectionIds ?? [])
      .map(id => sectionById.get(id))
      .filter((s): s is NewsSection => !!s);

    // 2) Reverse-reference sections: other sections that explicitly link TO this section.
    //    This is a safety net — catches cases where the back-link atomic save failed
    //    (server race condition) or was never stored (legacy data).
    const reverseLinked: NewsSection[] = [];
    for (const [id, other] of sectionById) {
      if (id === section.id) continue;
      if (!forwardIds.has(id) && other.linkedSectionIds?.includes(section.id)) {
        reverseLinked.push(other);
      }
    }

    // 3) Merge and deduplicate by ID.
    const seen = new Set<string>();
    const combined: NewsSection[] = [];
    for (const s of [...forwardLinked, ...reverseLinked]) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        combined.push(s);
      }
    }

    // 4) Resolve the group primary: the section that was explicitly designated as primary
    //    by another section's linkedSectionPrimary field takes precedence over timestamp order.
    //    Include the current section in the group scan so its own linkedSectionPrimary is read too.
    const fullGroup: NewsSection[] = [section, ...combined];
    this.linkedSectionPrimaryId = this.resolveGroupPrimary(fullGroup);

    // 5) Sort — explicit primary gets key 0 (always first); others sort by creation timestamp.
    combined.sort((a, b) => this.getSectionSortKey(a, this.linkedSectionPrimaryId) - this.getSectionSortKey(b, this.linkedSectionPrimaryId));
    this.linkedSections = combined;

    // 6) Trigger canvas cropping for linked sections that don't have their own imageUrl.
    for (const linked of this.linkedSections) {
      if (!linked.imageUrl) this.cropLinkedSectionImage(linked);
    }
  }

  /**
   * Scans a group of sections to find an explicitly designated primary.
   * A section designates a primary by setting linkedSectionPrimary to the ID of the
   * main article in its group. The first designation found that points to a section
   * actually present in the group wins. Returns undefined → fall back to timestamp sort.
   */
  private resolveGroupPrimary(group: NewsSection[]): string | undefined {
    const groupIds = new Set(group.map(s => s.id));
    for (const s of group) {
      if (s.linkedSectionPrimary && groupIds.has(s.linkedSectionPrimary)) {
        return s.linkedSectionPrimary;
      }
    }
    return undefined;
  }

  /**
   * Returns a numeric sort key for ordering sections within a group.
   * - The explicitly-designated primary (primaryId) always gets key 0 → sorts first.
   * - Other sections: sort by creation timestamp extracted from 'post-{Date.now()}' IDs.
   * - Non-timestamp IDs (e.g. XML-imported) sort last (MAX_SAFE_INTEGER).
   */
  private getSectionSortKey(section: NewsSection, primaryId?: string): number {
    if (primaryId !== undefined && section.id === primaryId) return 0;
    const match = /^post-(\d+)$/.exec(section.id ?? '');
    return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Returns all sections in the modal group (selected + linked) sorted by creation
   * timestamp so the primary/earlier article always appears first — regardless of
   * which section is currently selected or was clicked.
   *
   * Section IDs follow 'post-{Date.now()}' format; lower timestamp = created first
   * = main/primary article. This produces a consistent, symmetric order:
   * [Section-1 (older), Section-2 (newer), ...] from any viewing direction.
   */
  private getModalSectionOrder(_clickedLinkedSection?: NewsSection): NewsSection[] {
    if (!this.selectedSection || !this.currentPage) return [];

    const selectedWithPage: NewsSection = {
      ...this.selectedSection,
      pageId: this.currentPage.id
    };

    // Combine selected + linked, dedup by ID (guards against old mutual-link data),
    // then sort by creation timestamp ascending.
    const seen = new Set<string>();
    const all: NewsSection[] = [];
    for (const s of [selectedWithPage, ...this.linkedSections]) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        all.push(s);
      }
    }
    all.sort((a, b) => this.getSectionSortKey(a, this.linkedSectionPrimaryId) - this.getSectionSortKey(b, this.linkedSectionPrimaryId));
    return all;
  }

  selectLinkedSection(linkedSection: NewsSection) {
    const targetPage = this.pages.find(p => p.id === linkedSection.pageId);
    if (targetPage) {
      this.userNavigated = true;
      this.selectPage(targetPage, linkedSection.id);
    }
  }

  getCroppedImageForSection(section: NewsSection): string | null {
    if (section.imageUrl) {
      return section.imageUrl;
    }
    // Check if we have a cached crop for this section
    const cacheKey = `${section.pageId}:${section.id}`;
    return this.cropCache.get(cacheKey) ?? null;
  }

  private cropLinkedSectionImage(section: NewsSection): void {
    if (!this.isBrowser) return; // SSR guard: new Image() and canvas are browser-only APIs
    if (!section.pageId || section.imageUrl) return;

    const cacheKey = `${section.pageId}:${section.id}`;
    if (this.cropCache.has(cacheKey)) {
      this.cdr.detectChanges();
      return;
    }

    const page = this.pages.find(p => p.id === section.pageId);
    const fullImageUrl = page?.fullImage;
    if (!fullImageUrl) return;

    const isExternalUrl = fullImageUrl.startsWith('http://') || fullImageUrl.startsWith('https://');
    const wpBaseUrl = this.dataService.getApiBaseUrl();
    const srcUrl = isExternalUrl
      ? `${wpBaseUrl}/wp-json/digital-newspaper/v1/proxy?url=${encodeURIComponent(fullImageUrl)}`
      : fullImageUrl;

    const img = new Image();
    if (isExternalUrl) img.crossOrigin = 'anonymous';

    img.onload = () => {
      const cropX = Math.round((section.x / 100) * img.naturalWidth);
      const cropY = Math.round((section.y / 100) * img.naturalHeight);
      const cropWidth = Math.round((section.width / 100) * img.naturalWidth);
      const cropHeight = Math.round((section.height / 100) * img.naturalHeight);

      if (cropWidth <= 0 || cropHeight <= 0) return;

      const canvas = this.document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;

      // Disable image smoothing to preserve source pixel fidelity
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      try {
        // JPEG at quality 0.85: ~5–10× smaller data URL than PNG for photographic
        // newspaper pages (PNG was lossless but produced huge in-memory strings).
        // Source images are WebP; JPEG is chosen over WebP output because
        // canvas.toDataURL('image/webp') is unsupported in Firefox/Safari (falls
        // back to PNG silently), whereas JPEG is universally supported.
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        this.cropCache.set(cacheKey, dataUrl);
        if (!this._viewDestroyed) this.cdr.detectChanges();
      } catch (error) {
        console.error('Failed to crop linked section image:', error);
      }
    };

    // Without an onerror handler the linked-section panel would be permanently
    // stuck in a loading/empty state if the page image fails to fetch. Logging
    // the failure and triggering CD lets the UI gracefully show "no image" for
    // this linked section instead of hanging forever.
    img.onerror = () => {
      console.warn('[NewspaperComponent] Failed to load linked section image for crop:', srcUrl);
      if (!this._viewDestroyed) this.cdr.detectChanges();
    };

    img.src = srcUrl;
  }

  private cropSectionImage() {
    if (!this.isBrowser) return; // SSR guard: new Image() and canvas are browser-only APIs
    if (!this.selectedSection || !this.currentPage) {
      return;
    }

    // If section has its own imageUrl, use it instead of cropping
    if (this.selectedSection.imageUrl) {
      const isExternalUrl = this.selectedSection.imageUrl.startsWith('http://') || this.selectedSection.imageUrl.startsWith('https://');
      const imagePath = isExternalUrl
        ? this.selectedSection.imageUrl
        : (this.selectedSection.imageUrl.startsWith('/') ? this.selectedSection.imageUrl : `/${this.selectedSection.imageUrl}`);
      this.croppedSectionImage = imagePath;
      return;
    }

    const section = this.selectedSection;
    const fullImageUrl = this.currentPage.fullImage;
    if (!fullImageUrl) return;

    // Return a previously computed crop immediately without re-fetching the image.
    const cacheKey = `${this.currentPage.id}:${section.id}`;
    const cachedCrop = this.cropCache.get(cacheKey);
    if (cachedCrop) {
      this.croppedSectionImage = cachedCrop;
      this.sectionImageLoading = false;
      this.cdr.detectChanges();
      if (this.pendingMobileModal) {
        this.pendingMobileModal = false;
        setTimeout(() => this.openImageModal(), 0);
      }
      return;
    }

    // For cross-origin images (WP media), fetch via proxy so canvas.toDataURL() doesn't
    // throw a tainted-canvas error. The display <img> tag has no crossorigin attribute
    // so it loads fine; we only need CORS for the canvas crop operation.
    const isExternalUrl = fullImageUrl.startsWith('http://') || fullImageUrl.startsWith('https://');
    const wpBaseUrl = this.dataService.getApiBaseUrl();
    const srcUrl = isExternalUrl
      ? `${wpBaseUrl}/wp-json/digital-newspaper/v1/proxy?url=${encodeURIComponent(fullImageUrl)}`
      : fullImageUrl;

    const sectionAtStart = this.selectedSection;

    const img = new Image();
    if (isExternalUrl) {
      img.crossOrigin = 'anonymous';
    }

    img.onload = () => {
      // Discard result if the user switched to a different section while loading
      if (this.selectedSection !== sectionAtStart) return;

      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;

      const cropX = Math.round((section.x / 100) * naturalWidth);
      const cropY = Math.round((section.y / 100) * naturalHeight);
      const cropWidth = Math.round((section.width / 100) * naturalWidth);
      const cropHeight = Math.round((section.height / 100) * naturalHeight);

      const canvas = this.document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;

      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;

      // Disable image smoothing to preserve source pixel fidelity
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

      try {
        // JPEG at quality 0.85: ~5–10× smaller data URL than PNG.
        // Source images are WebP; JPEG output is chosen for universal browser
        // support (canvas.toDataURL('image/webp') silently falls back to PNG in Firefox/Safari).
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        this.cropCache.set(cacheKey, dataUrl);
        this.croppedSectionImage = dataUrl;
        this.sectionImageLoading = false;
        if (!this._viewDestroyed) this.cdr.detectChanges();
        if (this.pendingMobileModal) {
          this.pendingMobileModal = false;
          setTimeout(() => this.openImageModal(), 0);
        }
      } catch (error) {
        this.croppedSectionImage = null;
        this.sectionImageError = true;
        this.sectionImageLoading = false;
        if (!this._viewDestroyed) this.cdr.detectChanges();
        console.error('Failed to crop section image due to canvas security restrictions:', error);
        if (this.pendingMobileModal) {
          this.pendingMobileModal = false;
          if (this.selectedSection && this.currentPage) {
            this.modalImage = null;
            this.modalImageTitle = this.selectedSection.title;
            this.modalLinkedSections = [...this.linkedSections];
            this.showImageModal = true;
          }
        }
      }
    };

    img.onerror = () => {
      if (this.selectedSection !== sectionAtStart) return;
      this.sectionImageError = true;
      this.sectionImageLoading = false;
      if (!this._viewDestroyed) this.cdr.detectChanges();
      console.error('Failed to load image for cropping:', srcUrl);
      if (this.pendingMobileModal) {
        this.pendingMobileModal = false;
        if (this.selectedSection && this.currentPage) {
          this.modalImage = null;
          this.modalImageTitle = this.selectedSection.title;
          this.modalLinkedSections = [...this.linkedSections];
          this.showImageModal = true;
        }
      }
    };

    img.src = srcUrl;
  }

  private updateUrl() {
    if (!this.selectedDate || !this.currentPage) return;

    const date        = this.selectedDate;
    const pageSlug    = this.getPageSlug(this.currentPage);
    const editionSlug = this.getEditionSlug(this.selectedEditionNumber);

    if (this.selectedSection) {
      // Full URL: /date/page-XX/edition-XX/post-xxxx/
      const sectionSlug = this.createSectionSlug(this.selectedSection.title, this.selectedSection.id);
      this.location.replaceState(`/${date}/${pageSlug}/${editionSlug}/${sectionSlug}/`);
    } else if (!this.startedFromBaseUrl || this.userNavigated) {
      // Page + edition URL: /date/page-XX/edition-XX/
      // (either started from a full URL path, or user has interacted)
      this.location.replaceState(`/${date}/${pageSlug}/${editionSlug}/`);
    } else {
      // Keep base URL for the first visit before any user interaction
      this.location.replaceState('/');
    }
  }

  /** Update Open Graph and Twitter Card meta tags for the selected section.
   *  Pass null to reset to site-level defaults. */
  private updateMetaTags(section: NewsSection | null): void {
    const siteName = this.settings?.logo?.alt || 'ইপেপার - দৈনিক সংগ্রাম';
    const othersTitle = this.settings?.othersPageTitle?.trim() || siteName;
    const pageUrl = this.document.location.href;

    // Twitter handle from settings (e.g. "https://twitter.com/handle" → "@handle").
    // Falls back to empty string — setting twitter:site to the site name is invalid.
    const twitterHandle = this.getTwitterHandle();

    // Build the social-thumb endpoint base URL once — used for og:image so
    // crawlers (WhatsApp, Twitter/X) always receive a valid 1200×630 JPEG
    // with a logo fallback, even when the raw section image is a large WebP.
    const wpBase       = this.dataService.getApiBaseUrl();
    const curPageSlug  = this.currentPage ? this.getPageSlug(this.currentPage) : '';
    const curEdSlug    = this.getEditionSlug(this.selectedEditionNumber);
    const thumbBase    = `${wpBase}/wp-json/digital-newspaper/v1/social-thumb`;

    if (section) {
      // Title
      const title = `${section.title} - ${othersTitle}`;
      this.titleService.setTitle(title);

      // Description: strip HTML tags + decode entities, collapse whitespace, truncate
      const rawContent = section.content || '';
      const plainText = this.stripHtmlToPlainText(rawContent);
      const description = plainText.length > 155 ? plainText.slice(0, 152) + '...' : (plainText || siteName);

      // Social image: route through the PHP /social-thumb endpoint so crawlers
      // receive a properly resized 1200×630 JPEG (with logo fallback) rather
      // than the raw full-page WebP which can be >5 MB and wrong aspect ratio.
      const sectionSlug = this.createSectionSlug(section.title, section.id);
      const socialImageUrl = (this.selectedDate && curPageSlug && curEdSlug)
        ? `${thumbBase}?date=${encodeURIComponent(this.selectedDate)}&page=${encodeURIComponent(curPageSlug)}&edition=${encodeURIComponent(curEdSlug)}&slug=${encodeURIComponent(sectionSlug)}`
        : this.resolveImageUrl((section.imageUrl && section.imageUrl.trim()) || (this.currentPage?.fullImage?.trim() ?? ''));

      // Open Graph
      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'article' });
      this.meta.updateTag({ property: 'og:title',     content: section.title });
      this.meta.updateTag({ property: 'og:description', content: description });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: socialImageUrl });
      this.meta.updateTag({ property: 'og:image:secure_url', content: socialImageUrl });
      // Dimensions always 1200×630 — the /social-thumb endpoint guarantees this.
      this.meta.updateTag({ property: 'og:image:width',  content: '1200' });
      this.meta.updateTag({ property: 'og:image:height', content: '630' });

      // Twitter Card
      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:url',         content: pageUrl });
      this.meta.updateTag({ name: 'twitter:title',       content: section.title });
      this.meta.updateTag({ name: 'twitter:description', content: description });
      this.meta.updateTag({ name: 'twitter:creator',     content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:image',       content: socialImageUrl });
    } else if (this.currentPage) {
      const pageLabel = this.getPageLabel(this.currentPage);
      const displayDate = this.translationService.formatDate(this.selectedDate, 'long');
      const pageTitle = `${pageLabel} ${displayDate} - ${othersTitle}`;

      // For page-level (no section), use the /social-thumb endpoint without
      // a slug — it will serve the logo fallback image.
      const pageSocialImageUrl = (this.selectedDate && curPageSlug && curEdSlug)
        ? `${thumbBase}?date=${encodeURIComponent(this.selectedDate)}&page=${encodeURIComponent(curPageSlug)}&edition=${encodeURIComponent(curEdSlug)}`
        : this.resolveImageUrl(this.currentPage.fullImage?.trim() ?? '');

      this.titleService.setTitle(pageTitle);

      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'article' });
      this.meta.updateTag({ property: 'og:title',     content: pageTitle });
      this.meta.updateTag({ property: 'og:description', content: pageTitle });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: pageSocialImageUrl });
      this.meta.updateTag({ property: 'og:image:secure_url', content: pageSocialImageUrl });
      this.meta.updateTag({ property: 'og:image:width',  content: '1200' });
      this.meta.updateTag({ property: 'og:image:height', content: '630' });

      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:url',         content: pageUrl });
      this.meta.updateTag({ name: 'twitter:title',       content: pageTitle });
      this.meta.updateTag({ name: 'twitter:description', content: pageTitle });
      this.meta.updateTag({ name: 'twitter:creator',     content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:image',       content: pageSocialImageUrl });
    } else {
      // Reset to site-level defaults — use logo fallback via social-thumb.
      this.titleService.setTitle(siteName);
      const homepageSocialImageUrl = `${thumbBase}?homepage=1`;

      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'website' });
      this.meta.updateTag({ property: 'og:title',     content: siteName });
      this.meta.updateTag({ property: 'og:description', content: siteName });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: homepageSocialImageUrl });
      this.meta.updateTag({ property: 'og:image:secure_url', content: homepageSocialImageUrl });
      this.meta.updateTag({ property: 'og:image:width',  content: '1200' });
      this.meta.updateTag({ property: 'og:image:height', content: '630' });

      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:url',         content: pageUrl });
      this.meta.updateTag({ name: 'twitter:title',       content: siteName });
      this.meta.updateTag({ name: 'twitter:description', content: siteName });
      this.meta.updateTag({ name: 'twitter:creator',     content: twitterHandle });
      this.meta.updateTag({ name: 'twitter:image',       content: homepageSocialImageUrl });
    }
  }

  /**
   * Strip HTML tags and decode common HTML entities so meta description
   * text doesn't contain raw entities like &nbsp; or &amp;.
   */
  private stripHtmlToPlainText(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract a Twitter @handle from the configured socialLinks.twitter URL.
   * Returns '@handle' if a URL is configured, empty string otherwise.
   * twitter:site / twitter:creator must be a @handle — never a plain site name.
   */
  private getTwitterHandle(): string {
    const url = this.settings?.socialLinks?.twitter?.trim() ?? '';
    if (!url) return '';
    // Extract the last path segment from URLs like https://twitter.com/handle
    const segment = url.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!segment) return '';
    return segment.startsWith('@') ? segment : '@' + segment;
  }

  private createSectionSlug(_: string, sectionId: string): string {
    const rawId = (sectionId || '').trim();
    if (!rawId) return 'post-unknown';
    if (rawId.startsWith('post-')) return rawId;
    return rawId.startsWith('section-')
      ? 'post-' + rawId.slice('section-'.length)
      : `post-${rawId}`;
  }

  private createLegacySectionSlug(title: string, sectionId: string): string {
    // Preserve Unicode characters for non-ASCII languages like Bengali
    let slug = title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u0980-\u09FF-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!slug || slug.length === 0) {
      slug = this.createSectionSlug('', sectionId);
    }

    return slug;
  }
}
