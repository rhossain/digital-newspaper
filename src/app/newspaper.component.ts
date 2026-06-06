import { Component, OnInit, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild, Inject } from '@angular/core';
import { CommonModule, Location, DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { NewspaperDataService, NewsSection, NewspaperPage, NewspaperEdition, GlobalSettings } from './services/newspaper-data.service';
import { ToasterService } from './services/toaster.service';
import { ShareButtonsComponent } from './shared/share-buttons/share-buttons.component';
import { TranslationService } from './i18n/translation.service';
import { TranslatePipe } from './i18n/translate.pipe';
import { LocaleDatePipe } from './i18n/locale-date.pipe';
import { DatePickerComponent } from './components/date-picker/date-picker.component';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-newspaper',
  standalone: true,
  imports: [CommonModule, FormsModule, ShareButtonsComponent, TranslatePipe, LocaleDatePipe, DatePickerComponent],
  templateUrl: './newspaper.component.html',
  styleUrls: ['./newspaper.component.css']
})
export class NewspaperComponent implements OnInit, OnDestroy {
  @ViewChild('mainImage') mainImageRef?: ElementRef<HTMLImageElement>;
  pages: NewspaperPage[] = [];
  currentPage: NewspaperPage | null = null;
  selectedSection: NewsSection | null = null;
  imageLoaded = false;
  assetLogoError = false;
  croppedSectionImage: string | null = null;
  showContentModal = false;
  showImageModal = false;
  linkedSections: NewsSection[] = [];
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
  private resizeListener?: () => void;
  private resizeDebounceTimer?: ReturnType<typeof setTimeout>;

  // Performance caches
  private cropCache = new Map<string, string>();
  private resolvedUrlCache = new Map<string, string>();
  
  // Image loading states
  thumbnailsLoading: { [key: number]: boolean } = {};
  /** Pre-resolved thumbnail src for each page (thumbnail → fullImage fallback). */
  pageThumbnailSrcs: { [pageId: number]: string } = {};
  /** Queue of pages whose thumbnails have not yet been requested (sequential loading). */
  private thumbnailLoadQueue: NewspaperPage[] = [];
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
  
  private subscriptions: Subscription[] = [];

  constructor(
    private dataService: NewspaperDataService,
    private toaster: ToasterService,
    private cdr: ChangeDetectorRef,
    private route: ActivatedRoute,
    private translationService: TranslationService,
    private location: Location,
    private meta: Meta,
    private titleService: Title,
    @Inject(DOCUMENT) private document: Document
  ) {}

  /** Expose TranslationService to the template. */
  get ts(): TranslationService { return this.translationService; }

  /** URL for the logo anchor. Uses the configured link, falling back to the app's base URL. */
  get logoHref(): string {
    return this.settings?.logo?.link?.trim() || document.baseURI;
  }

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
        this.selectedDate = dateParam;
        this.dataService.setCurrentDate(dateParam);
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
        this.loadCurrentEdition();
        this.cdr.detectChanges();
      }
    });
    this.subscriptions.push(dataSubscription);
    
    this.loadNewspaperData();

    // ── Remote-change detection ──────────────────────────────────────────────
    // Poll the server's lightweight /data/version endpoint every 60 s.
    // When a new version is detected (another user added/edited content), reload
    // the data transparently so readers always see the latest edition without
    // having to refresh the browser tab.
    this.dataService.startVersionPoll(60_000);
    const versionSub = this.dataService.remoteDataChanged$.subscribe(() => {
      // Only reload if the user is not viewing a modal (section detail / image)
      if (!this.showContentModal && !this.showImageModal) {
        this.dataService.loadData().subscribe();
        // dataService.data$ subscriber above handles UI refresh automatically
      }
    });
    this.subscriptions.push(versionSub);

    // Detect mobile/tablet view and keep it updated on resize
    this.updateIsMobileView();
    this.resizeListener = () => {
      clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = setTimeout(() => this.updateIsMobileView(), 150);
    };
    window.addEventListener('resize', this.resizeListener);
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.dataService.stopVersionPoll();
    clearTimeout(this.resizeDebounceTimer);
    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
    }
  }

  private updateIsMobileView() {
    this.isMobileView = window.innerWidth <= 1024;
    if (!this.isMobileView && this.mobileHeaderMenuOpen) {
      this.mobileHeaderMenuOpen = false;
    }
  }

  toggleMobileHeaderMenu() {
    this.mobileHeaderMenuOpen = !this.mobileHeaderMenuOpen;
  }

  closeMobileHeaderMenu() {
    this.mobileHeaderMenuOpen = false;
  }

  loadNewspaperData() {
    this.isLoading = true;
    this.dataService.loadData().subscribe({
      next: () => {
        this.availableDates = this.dataService.getAvailableDates();
        
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

  /** Pull the latest global settings from the data service into component state. */
  private refreshSettings(): void {
    this.settings = this.dataService.getSettings();
    this.socialLinks = this.settings?.socialLinks || {};
    if (this.settings?.language) {
      this.translationService.setLanguage(this.settings.language);
    }
  }

  loadCurrentEdition() {
    // Resolve pending edition slug first so getCurrentEdition() uses the correct number
    if (this.pendingEditionSlug) {
      this.selectedEditionNumber = this.getEditionFromSlug(this.pendingEditionSlug);
      this.pendingEditionSlug = null;
    }

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
      this.pages = edition.pages;
      // Sequential thumbnail loading: resolve one page at a time so the
      // browser only fetches one thumbnail per round-trip instead of
      // hammering all of them simultaneously.
      this.thumbnailsLoading = {};
      this.pageThumbnailSrcs = {};
      this.thumbnailLoadQueue = [];
      // Mark every page as pending (skeleton shows)
      this.pages.forEach(page => { this.thumbnailsLoading[page.id] = true; });
      if (this.pages.length > 0) {
        // Kick off page 1 immediately; the rest wait in the queue
        this.thumbnailLoadQueue = this.pages.slice(1);
        this.seedThumbnail(this.pages[0]);
      }
      if (this.pages.length > 0) {
        // Resolve target page from pending page slug (default: first page)
        let targetPage = this.pages[0];
        if (this.pendingPageSlug) {
          const resolvedPage = this.getPageFromSlug(this.pendingPageSlug);
          if (resolvedPage) targetPage = resolvedPage;
          this.pendingPageSlug = null;
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
          // No section pending — show page without auto-selecting a section
          this.selectPage(targetPage);
        }
      } else {
        this.currentPage = null;
        this.selectedSection = null;
      }
    } else {
      this.pages = [];
      this.currentPage = null;
      this.selectedSection = null;
      this.croppedSectionImage = null;
      this.linkedSections = [];
      this.thumbnailsLoading = {};
      this.pageThumbnailSrcs = {};
    }
    this.updateDisplayDate();
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

  /** Always shows today's date formatted in the active locale. */
  get todayDisplayDate(): string {
    return this.translationService.formatDate(this.todayDate, 'full');
  }

  /** Localized editor name, falling back to the base editor field. */
  get localizedEditor(): string {
    return this.dataService.getLocalizedSetting(
      this.settings?.editorLabels, this.settings?.editor, this.translationService.language
    );
  }

  /** Localized address line 1, falling back to the base field. */
  get localizedAddressLine1(): string {
    return this.dataService.getLocalizedSetting(
      this.settings?.address?.line1Labels, this.settings?.address?.line1, this.translationService.language
    );
  }

  /** Localized address line 2, falling back to the base field. */
  get localizedAddressLine2(): string {
    return this.dataService.getLocalizedSetting(
      this.settings?.address?.line2Labels, this.settings?.address?.line2, this.translationService.language
    );
  }

  /** Localized phone display, falling back to the base phone field. */
  get localizedPhone(): string {
    return this.dataService.getLocalizedSetting(
      this.settings?.address?.phoneLabels, this.settings?.address?.phone, this.translationService.language
    );
  }

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
  trackByIndex(index: number): number { return index; }

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

  selectPage(page: NewspaperPage, targetSectionId?: string) {
    this.currentPage = page;
    this.imageLoaded = false;

    // If the image is already cached, the load event may not fire
    setTimeout(() => {
      const img = this.mainImageRef?.nativeElement;
      if (img && img.complete && img.naturalWidth > 0) {
        this.onImageLoad();
      }
    }, 0);

    if (targetSectionId) {
      // Section explicitly requested — find and select it
      if (page.sections && page.sections.length > 0) {
        const targetSection = page.sections.find(s => s.id === targetSectionId);
        this.selectSection(targetSection ?? page.sections[0]);
        setTimeout(() => {
          const rightPanel = document.querySelector('.right-panel');
          if (rightPanel) rightPanel.scrollTop = 0;
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
        const rightPanel = document.querySelector('.right-panel');
        if (rightPanel) rightPanel.scrollTop = 0;
      }, 0);
      this.updateUrl();
      this.updateMetaTags(null);
    }
  }

  onThumbnailLoad(pageId: number) {
    this.thumbnailsLoading[pageId] = false;
    this.loadNextThumbnail();
  }

  /** Resolve and assign the src for a single page thumbnail. */
  private seedThumbnail(page: NewspaperPage): void {
    const thumb = typeof page.thumbnail === 'string' ? page.thumbnail.trim() : '';
    const full  = typeof page.fullImage  === 'string' ? page.fullImage.trim()  : '';
    const src   = this.resolveImageUrl(thumb || full);
    this.pageThumbnailSrcs[page.id] = src;
    if (!src) {
      // No image for this page — mark done and immediately load the next
      this.thumbnailsLoading[page.id] = false;
      this.loadNextThumbnail();
    }
  }

  /** Dequeue and start loading the next pending thumbnail. */
  private loadNextThumbnail(): void {
    if (this.thumbnailLoadQueue.length === 0) return;
    const next = this.thumbnailLoadQueue.shift()!;
    this.seedThumbnail(next);
  }

  onImageLoad() {
    this.imageLoaded = true;
    
    // Store reference to the loaded image for cropping
    const imgElement = document.querySelector('.main-page-image') as HTMLImageElement;
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
    this.imageLoaded = true;
  }

  selectSection(section: NewsSection) {
    this.selectedSection = section;
    this.sectionImageError = false;
    
    // Load linked sections
    this.loadLinkedSections(section);
    
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
            const imgEl = document.querySelector('.section-full-image') as HTMLImageElement;
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
    const rightPanel = document.querySelector('.right-panel');
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
        this.modalImage = null;
        this.modalImageTitle = this.selectedSection.title;
        this.modalLinkedSections = [...this.linkedSections];
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

  onModalImageError(event: Event): void {
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

  closeContentModal() {
    this.showContentModal = false;
  }

  openImageModal() {
    if (this.croppedSectionImage && this.selectedSection && this.currentPage) {
      // Collect all sections: main + linked
      const allSections: NewsSection[] = [
        { ...this.selectedSection, pageId: this.currentPage.id },
        ...this.linkedSections
      ];
      
      // Sort by page number
      allSections.sort((a, b) => {
        const pageA = a.pageId || 0;
        const pageB = b.pageId || 0;
        return pageA - pageB;
      });
      
      // Set first section as main modal image
      const firstSection = allSections[0];
      this.modalImage = firstSection.pageId === this.currentPage.id ? this.croppedSectionImage : this.getCroppedImageForSection(firstSection);
      this.modalImageTitle = firstSection.title;
      
      // Rest of the sections
      this.modalLinkedSections = allSections.slice(1);
      this.showImageModal = true;
    }
  }

  closeImageModal() {
    this.showImageModal = false;
    this.modalImage = null;
    this.modalImageTitle = '';
    this.modalLinkedSections = [];
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
      const a = document.createElement('a');
      a.href = url;
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      a.download = `${title || 'image'}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
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
    // Show all sections in page order
    if (this.selectedSection && this.currentPage) {
      // Collect all sections: main + linked
      const allSections: NewsSection[] = [
        { ...this.selectedSection, pageId: this.currentPage.id },
        ...this.linkedSections
      ];
      
      // Sort by page number
      allSections.sort((a, b) => {
        const pageA = a.pageId || 0;
        const pageB = b.pageId || 0;
        return pageA - pageB;
      });
      
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
    
    if (!section.linkedSectionIds || section.linkedSectionIds.length === 0) {
      return;
    }
    
    // Find all linked sections across all pages
    for (const page of this.pages) {
      for (const pageSection of page.sections) {
        if (section.linkedSectionIds.includes(pageSection.id)) {
          // Add pageId to the section for reference
          this.linkedSections.push({
            ...pageSection,
            pageId: page.id
          });
        }
      }
    }
    
    // Sort linked sections by pageId to maintain consistent order
    this.linkedSections.sort((a, b) => {
      const pageA = a.pageId || 0;
      const pageB = b.pageId || 0;
      return pageA - pageB;
    });

    // Trigger canvas cropping for linked sections that don't have their own imageUrl
    for (const linked of this.linkedSections) {
      if (!linked.imageUrl) {
        this.cropLinkedSectionImage(linked);
      }
    }
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

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;

      // Disable image smoothing to preserve source pixel fidelity
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      try {
        // Use PNG (lossless) to avoid double JPEG compression artifacts and color shift
        const dataUrl = canvas.toDataURL('image/png');
        this.cropCache.set(cacheKey, dataUrl);
        this.cdr.detectChanges();
      } catch (error) {
        console.error('Failed to crop linked section image:', error);
      }
    };

    img.src = srcUrl;
  }

  private cropSectionImage() {
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

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;

      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;

      // Disable image smoothing to preserve source pixel fidelity
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

      try {
        // Use PNG (lossless) to avoid double JPEG compression artifacts and color shift
        const dataUrl = canvas.toDataURL('image/png');
        this.cropCache.set(cacheKey, dataUrl);
        this.croppedSectionImage = dataUrl;
        this.sectionImageLoading = false;
        this.cdr.detectChanges();
        if (this.pendingMobileModal) {
          this.pendingMobileModal = false;
          setTimeout(() => this.openImageModal(), 0);
        }
      } catch (error) {
        this.croppedSectionImage = null;
        this.sectionImageError = true;
        this.sectionImageLoading = false;
        this.cdr.detectChanges();
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
      this.cdr.detectChanges();
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
    const pageUrl = window.location.href;

    if (section) {
      // Title
      const title = `${section.title} - ${othersTitle}`;
      this.titleService.setTitle(title);

      // Description: strip HTML tags, collapse whitespace, truncate to 155 chars
      const rawContent = section.content || '';
      const plainText = rawContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const description = plainText.length > 155 ? plainText.slice(0, 152) + '...' : (plainText || siteName);

      // Image: prefer section's own imageUrl, fall back to full page image
      const imageUrl = this.resolveImageUrl(
        (section.imageUrl && section.imageUrl.trim()) ||
        (this.currentPage?.fullImage?.trim() ?? '')
      );

      // Open Graph
      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'article' });
      this.meta.updateTag({ property: 'og:title',     content: section.title });
      this.meta.updateTag({ property: 'og:description', content: description });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: imageUrl });
      this.meta.updateTag({ property: 'og:image:secure_url', content: imageUrl });
      this.meta.updateTag({ property: 'og:image:width',  content: '' });
      this.meta.updateTag({ property: 'og:image:height', content: '' });

      // Twitter Card
      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: siteName });
      this.meta.updateTag({ name: 'twitter:title',       content: section.title });
      this.meta.updateTag({ name: 'twitter:description', content: description });
      this.meta.updateTag({ name: 'twitter:creator',     content: siteName });
      this.meta.updateTag({ name: 'twitter:image',       content: imageUrl });
    } else if (this.currentPage) {
      const pageLabel = this.getPageLabel(this.currentPage);
      const displayDate = this.translationService.formatDate(this.selectedDate, 'long');
      const pageTitle = `${pageLabel} ${displayDate} - ${othersTitle}`;
      const pageImageUrl = this.resolveImageUrl(this.currentPage.fullImage?.trim() ?? '');

      this.titleService.setTitle(pageTitle);

      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'article' });
      this.meta.updateTag({ property: 'og:title',     content: pageTitle });
      this.meta.updateTag({ property: 'og:description', content: pageTitle });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: pageImageUrl });
      this.meta.updateTag({ property: 'og:image:secure_url', content: pageImageUrl });
      this.meta.updateTag({ property: 'og:image:width',  content: '' });
      this.meta.updateTag({ property: 'og:image:height', content: '' });

      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: siteName });
      this.meta.updateTag({ name: 'twitter:title',       content: pageTitle });
      this.meta.updateTag({ name: 'twitter:description', content: pageTitle });
      this.meta.updateTag({ name: 'twitter:creator',     content: siteName });
      this.meta.updateTag({ name: 'twitter:image',       content: pageImageUrl });
    } else {
      // Reset to site-level defaults
      this.titleService.setTitle(siteName);

      this.meta.updateTag({ property: 'og:site_name', content: siteName });
      this.meta.updateTag({ property: 'og:type',      content: 'article' });
      this.meta.updateTag({ property: 'og:title',     content: siteName });
      this.meta.updateTag({ property: 'og:description', content: siteName });
      this.meta.updateTag({ property: 'og:url',       content: pageUrl });
      this.meta.updateTag({ property: 'og:image',        content: '' });
      this.meta.updateTag({ property: 'og:image:secure_url', content: '' });
      this.meta.updateTag({ property: 'og:image:width',  content: '' });
      this.meta.updateTag({ property: 'og:image:height', content: '' });

      this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
      this.meta.updateTag({ name: 'twitter:site',        content: siteName });
      this.meta.updateTag({ name: 'twitter:title',       content: siteName });
      this.meta.updateTag({ name: 'twitter:description', content: siteName });
      this.meta.updateTag({ name: 'twitter:creator',     content: siteName });
      this.meta.updateTag({ name: 'twitter:image',       content: '' });
    }
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
