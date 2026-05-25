import { Component, OnInit, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
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

  // Mobile/tablet responsive state
  isMobileView = false;
  mobileHeaderMenuOpen = false;
  pendingMobileModal = false;
  private resizeListener?: () => void;
  
  // Image loading states
  thumbnailsLoading: { [key: number]: boolean } = {};
  /** Pre-resolved thumbnail src for each page (thumbnail → fullImage fallback). */
  pageThumbnailSrcs: { [pageId: number]: string } = {};
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
    private router: Router,
    private route: ActivatedRoute,
    private translationService: TranslationService,
    private location: Location,
    private meta: Meta,
    private titleService: Title
  ) {}

  /** Expose TranslationService to the template. */
  get ts(): TranslationService { return this.translationService; }

  /** URL for the logo anchor. Uses the configured link, falling back to the app's base URL. */
  get logoHref(): string {
    return this.settings?.logo?.link?.trim() || document.baseURI;
  }

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();
    
    // Subscribe to route parameters
    const routeSubscription = this.route.paramMap.subscribe(params => {
      const dateParam = params.get('date');
      const sectionParam = params.get('section');
      
      if (dateParam) {
        this.selectedDate = dateParam;
        this.dataService.setCurrentDate(dateParam);
      }
      
      // Store section parameter for later use after data loads
      if (sectionParam) {
        this.pendingSectionSlug = sectionParam;
      }
    });
    this.subscriptions.push(routeSubscription);

    // Subscribe to query parameters (edition number)
    const querySubscription = this.route.queryParamMap.subscribe(params => {
      const editionParam = params.get('e');
      this.selectedEditionNumber = editionParam ? parseInt(editionParam, 10) : 1;
    });
    this.subscriptions.push(querySubscription);
    
    // Subscribe to date changes
    const dateSubscription = this.dataService.currentDate$.subscribe(date => {
      this.selectedDate = date;
      this.updateDisplayDate();
      this.checkIfToday();
      // Update URL when date changes (unless there's a pending section to navigate to)
      if (!this.pendingSectionSlug) {
        this.updateUrl();
      }
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

    // Detect mobile/tablet view and keep it updated on resize
    this.updateIsMobileView();
    this.resizeListener = () => this.updateIsMobileView();
    window.addEventListener('resize', this.resizeListener);
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
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
    // Reset main view so the image element gets recreated when date changes
    this.currentPage = null;
    this.selectedSection = null;
    this.linkedSections = [];
    this.croppedSectionImage = null;
    this.imageLoaded = false;
    this.sectionImageLoading = false;

    // Populate edition tabs for current date
    this.editionsForDate = this.dataService.getEditionsByDate(this.selectedDate);

    const edition = this.dataService.getCurrentEdition(this.selectedEditionNumber);
    if (edition) {
      this.pages = edition.pages;
      // Pre-resolve thumbnail sources once, handling PHP [] → '' coercion and
      // falling back from thumbnail → fullImage.
      this.thumbnailsLoading = {};
      this.pageThumbnailSrcs = {};
      this.pages.forEach(page => {
        const thumb = typeof page.thumbnail === 'string' ? page.thumbnail.trim() : '';
        const full  = typeof page.fullImage  === 'string' ? page.fullImage.trim()  : '';
        const src   = this.resolveImageUrl(thumb || full);
        this.pageThumbnailSrcs[page.id] = src;
        this.thumbnailsLoading[page.id] = !!src;
      });
      if (this.pages.length > 0) {
        // Navigate to section if pendingSectionSlug exists, otherwise select first page
        if (this.pendingSectionSlug) {
          const found = this.navigateToSection(this.pendingSectionSlug);
          this.pendingSectionSlug = null; // Clear after use
          if (!found) {
            this.selectPage(this.pages[0]);
          }
        } else {
          this.selectPage(this.pages[0]);
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
    let found = false;
    // Find the section across all pages by ID or title-based slug
    for (const page of this.pages) {
      // First try to find by ID (for backward compatibility)
      let section = page.sections.find(s => s.id === sectionSlug);
      
      // If not found by ID, try to match by title slug
      if (!section) {
        section = page.sections.find(s => {
          const slug = this.createSectionSlug(s.title, s.id);
          return slug === sectionSlug;
        });
      }
      
      if (section) {
        // Select the page with the target section ID
        this.selectPage(page, section.id);
        found = true;
        break;
      }
    }

    return found;
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

  onDateChange() {
    this.selectedEditionNumber = 1;
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
    this.loadCurrentEdition();
    this.updateUrl();
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
    
    // If a target section is specified, select it; otherwise select the first section
    if (page.sections && page.sections.length > 0) {
      let sectionToSelect = page.sections[0];
      
      if (targetSectionId) {
        const targetSection = page.sections.find(s => s.id === targetSectionId);
        if (targetSection) {
          sectionToSelect = targetSection;
        }
      }
      
      // Use selectSection to properly initialize everything including linked sections
      this.selectSection(sectionToSelect);
      
      // Scroll right panel to top when page changes
      setTimeout(() => {
        const rightPanel = document.querySelector('.right-panel');
        if (rightPanel) {
          rightPanel.scrollTop = 0;
        }
      }, 0);
    } else {
      this.selectedSection = null;
      this.linkedSections = [];
    }
  }

  onThumbnailLoad(pageId: number) {
    this.thumbnailsLoading[pageId] = false;
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

  onLinkedSectionImageError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  onModalImageError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  resolveImageUrl(url: string): string {
    // Guard: PHP may serialize empty fields as [] (truthy array) instead of "".
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('data:')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      // Normalize WordPress uploads absolute URLs to the current WP origin.
      // This fixes images after a domain migration: source_url saved with the
      // old domain is rewritten to the current WP_BASE_URL host so the browser
      // can resolve them without touching the database.
      if (url.includes('/wp-content/uploads/')) {
        try {
          const wpOrigin = new URL(this.dataService.getApiBaseUrl()).origin;
          const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)$/);
          if (pathMatch) return wpOrigin + pathMatch[1];
        } catch { /* malformed URL — fall through and return as-is */ }
      }
      return url;
    }
    // Relative URL — prepend the WordPress base URL so the browser resolves it
    // against the WP host rather than the Angular dev server.
    const base = this.dataService.getApiBaseUrl();
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
  }

  closeSection() {
    this.selectedSection = null;
    this.croppedSectionImage = null;
    this.showContentModal = false;
    this.showImageModal = false;
    this.linkedSections = [];
    this.sectionImageLoading = false;
    this.pendingMobileModal = false;
    
    // Update URL to remove section
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

  printContent(content: string, title: string): void {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write('<!DOCTYPE html><html><head><title></title><style>body{margin:0;background:white;font-family:serif;font-size:16px;line-height:1.7;color:#000;padding-top:100px;padding-bottom:70px;}.print-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ccc;background:white;font-family:sans-serif;}.print-header-left{display:flex;align-items:center;gap:12px;}.logo-img{height:40px;width:auto;object-fit:contain;}.logo-text{font-size:20px;font-weight:600;}.print-header-date{font-size:16px;color:#444;white-space:nowrap;}h1{font-size:22px;margin:16px 20px;}article{padding:0 20px 20px;}.print-footer{padding:16px 20px;border-top:1px solid #ccc;text-align:left;font-size:15px;color:#555;background:white;font-family:sans-serif;}.footer-editor{font-weight:bold;white-space:nowrap;display:block;margin-bottom:4px;}.footer-detail{display:block;line-height:1.5;}@media print{body{margin:0;padding-top:100px;padding-bottom:120px;}.print-header{position:fixed;top:0;left:0;right:0;z-index:1000;}.print-footer{position:fixed;bottom:0;left:0;right:0;z-index:1000;}}</style></head><body><div class="print-header"><div class="print-header-left"></div><span class="print-header-date"></span></div><h1></h1><article></article><div class="print-footer"></div></body></html>');
    win.document.close();
    this.populatePrintHeaderFooter(win);
    const titleEl = win.document.querySelector('title');
    if (titleEl) titleEl.textContent = title;
    const h1El = win.document.querySelector('h1');
    if (h1El) h1El.textContent = title;
    const articleEl = win.document.querySelector('article');
    if (articleEl) {
      articleEl.innerHTML = this.normalizeContent(content);
      win.print();
      win.close();
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
    win.document.write('<!DOCTYPE html><html><head><title></title><style>body{margin:0;background:white;font-family:sans-serif;padding-top:100px;padding-bottom:70px;}.print-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ccc;background:white;}.print-header-left{display:flex;align-items:center;gap:12px;}.logo-img{height:40px;width:auto;object-fit:contain;}.logo-text{font-size:20px;font-weight:600;}.print-header-date{font-size:16px;color:#444;white-space:nowrap;}.img-container{display:flex;justify-content:center;align-items:flex-start;padding:20px;}img{max-width:100%;height:auto;display:block;}.print-footer{padding:16px 20px;border-top:1px solid #ccc;text-align:left;font-size:15px;color:#555;background:white;}.footer-editor{font-weight:bold;white-space:nowrap;display:block;margin-bottom:4px;}.footer-detail{display:block;line-height:1.5;}@media print{body{margin:0;padding-top:100px;padding-bottom:120px;}.print-header{position:fixed;top:0;left:0;right:0;z-index:1000;}.print-footer{position:fixed;bottom:0;left:0;right:0;z-index:1000;}}</style></head><body><div class="print-header"><div class="print-header-left"></div><span class="print-header-date"></span></div><div class="img-container"><img/></div><div class="print-footer"></div></body></html>');
    win.document.close();
    this.populatePrintHeaderFooter(win);
    const titleEl = win.document.querySelector('title');
    if (titleEl) titleEl.textContent = title;
    const imgEl = win.document.querySelector('.img-container img') as HTMLImageElement | null;
    if (imgEl) {
      imgEl.alt = title;
      imgEl.src = imageUrl;
      imgEl.onload = () => { win.print(); win.close(); };
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
    win.document.write('<!DOCTYPE html><html><head><title></title><style>body{margin:0;background:white;font-family:sans-serif;padding-top:100px;padding-bottom:70px;}.print-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #ccc;background:white;}.print-header-left{display:flex;align-items:center;gap:12px;}.logo-img{height:40px;width:auto;object-fit:contain;}.logo-text{font-size:20px;font-weight:600;}.print-header-date{font-size:16px;color:#444;white-space:nowrap;}.images-container{padding:20px;display:flex;flex-direction:column;gap:30px;align-items:center;}.print-image{width:100%;max-width:900px;height:auto;display:block;}.print-footer{padding:16px 20px;border-top:1px solid #ccc;text-align:left;font-size:15px;color:#555;background:white;}.footer-editor{font-weight:bold;white-space:nowrap;display:block;margin-bottom:4px;}.footer-detail{display:block;line-height:1.5;}@media print{body{margin:0;padding-top:100px;padding-bottom:120px;}.print-header{position:fixed;top:0;left:0;right:0;z-index:1000;}.print-footer{position:fixed;bottom:0;left:0;right:0;z-index:1000;}}</style></head><body><div class="print-header"><div class="print-header-left"></div><span class="print-header-date"></span></div><div class="images-container"></div><div class="print-footer"></div></body></html>');
    win.document.close();

    this.populatePrintHeaderFooter(win);

    // Add all images; print once all are loaded
    const container = win.document.querySelector('.images-container')!;
    let loadedCount = 0;
    const checkPrint = () => {
      loadedCount++;
      if (loadedCount >= images.length) { win.print(); win.close(); }
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
  }

  selectLinkedSection(linkedSection: NewsSection) {
    // Navigate to the page containing the linked section
    const targetPage = this.pages.find(p => p.id === linkedSection.pageId);
    if (targetPage) {
      // Pass the linked section ID to selectPage so it selects the right section
      this.selectPage(targetPage, linkedSection.id);
    }
  }

  getCroppedImageForSection(section: NewsSection): string | null {
    if (section.imageUrl) {
      return section.imageUrl;
    }
    // For sections without imageUrl, we'll need to crop dynamically
    // This is a simplified version - in production you'd want to cache these
    return null;
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

      const cropX = (section.x / 100) * naturalWidth;
      const cropY = (section.y / 100) * naturalHeight;
      const cropWidth = (section.width / 100) * naturalWidth;
      const cropHeight = (section.height / 100) * naturalHeight;

      const canvas = document.createElement('canvas');
      canvas.width = cropWidth;
      canvas.height = cropHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

      try {
        this.croppedSectionImage = canvas.toDataURL('image/jpeg', 0.9);
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
    // Update URL with current date, optional edition, and section if selected
    if (this.selectedDate) {
      const queryParams = this.selectedEditionNumber > 1 ? { e: this.selectedEditionNumber } : {};
      if (this.selectedSection) {
        // Use title-based slug with section ID fallback
        const slug = this.createSectionSlug(this.selectedSection.title, this.selectedSection.id);
        this.router.navigate(['/', this.selectedDate, slug], { queryParams, replaceUrl: true });
      } else if (this.selectedEditionNumber > 1) {
        this.router.navigate(['/', this.selectedDate], { queryParams, replaceUrl: true });
      } else {
        // Use Location.replaceState instead of router.navigate so that
        // paramMap does NOT fire — this prevents the cascade:
        // paramMap → setCurrentDate → currentDate$ → loadCurrentEdition
        // → selectPage → selectSection → updateUrl (loop back to section URL)
        this.location.replaceState('/' + this.selectedDate + '/');
      }
    }
  }

  /** Update Open Graph and Twitter Card meta tags for the selected section.
   *  Pass null to reset to site-level defaults. */
  private updateMetaTags(section: NewsSection | null): void {
    const siteName = this.settings?.logo?.alt || 'ইপেপার - দৈনিক সংগ্রাম';
    const pageUrl = window.location.href;

    if (section) {
      // Title
      const title = `${section.title} | ${siteName}`;
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

  private createSectionSlug(title: string, sectionId: string): string {
    // Preserve Unicode characters for non-ASCII languages like Bengali
    let slug = title
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')           // Replace spaces with hyphens
      .replace(/[^\w\u0980-\u09FF-]/g, '') // Keep alphanumeric, Bengali Unicode, and hyphens
      .replace(/-+/g, '-')            // Replace multiple hyphens with single hyphen
      .replace(/^-|-$/g, '');         // Remove leading/trailing hyphens

    // If slug is empty, use section ID
    if (!slug || slug.length === 0) {
      slug = sectionId;
    }

    return slug;
  }
}
