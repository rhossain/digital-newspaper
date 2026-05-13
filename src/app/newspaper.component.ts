import { Component, OnInit, OnDestroy, ChangeDetectorRef, ElementRef, ViewChild } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { NewspaperDataService, NewsSection, NewspaperPage, NewspaperEdition, GlobalSettings } from './services/newspaper-data.service';
import { ToasterService } from './services/toaster.service';
import { ShareButtonsComponent } from './shared/share-buttons/share-buttons.component';
import { TranslationService } from './i18n/translation.service';
import { TranslatePipe } from './i18n/translate.pipe';
import { LocaleDatePipe } from './i18n/locale-date.pipe';
import { DatePickerComponent } from './components/date-picker/date-picker.component';
import { Subscription, timer } from 'rxjs';
import { switchMap, take, pairwise, startWith, filter } from 'rxjs/operators';
import { AccessControlService } from './services/access-control.service';
import { SubscriptionService } from './services/subscription.service';
import { SubscriptionWallComponent } from './subscription/subscription-wall/subscription-wall.component';
import { SubscriptionStatusComponent } from './subscription/subscription-status/subscription-status.component';
import { CLIENT_PACKAGE } from './config';
import type { AccessMode } from './models/subscription.models';

@Component({
  selector: 'app-newspaper',
  standalone: true,
  imports: [CommonModule, FormsModule, ShareButtonsComponent, TranslatePipe, LocaleDatePipe, DatePickerComponent, SubscriptionWallComponent, SubscriptionStatusComponent],
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

  // Subscription / paywall state
  paywallActive = false;
  paywallAccessMode: AccessMode = 'today_edition';
  readonly isPublisherPackage = CLIENT_PACKAGE === 'publisher';

  constructor(
    private dataService: NewspaperDataService,
    private toaster: ToasterService,
    private cdr: ChangeDetectorRef,
    private router: Router,
    private route: ActivatedRoute,
    private translationService: TranslationService,
    private location: Location,
    private accessControl: AccessControlService,
    private subscriptionService: SubscriptionService,
  ) {}

  /** Expose TranslationService to the template. */
  get ts(): TranslationService { return this.translationService; }

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

    // Subscribe to query parameters (edition number + post-payment return)
    const querySubscription = this.route.queryParamMap.subscribe(params => {
      const editionParam = params.get('e');
      this.selectedEditionNumber = editionParam ? parseInt(editionParam, 10) : 1;

      // Handle return from WooCommerce checkout: ?sub=pending triggers a status refresh.
      // Never trust this param as proof of subscription — always re-fetch from the server.
      if (params.get('sub') === 'pending') {
        this.router.navigate([], {
          queryParams: { sub: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
        // Poll up to 3 times (2 s apart) — WC order processing can have a brief delay.
        const MAX_ATTEMPTS = 3;
        let attempt = 0;
        const pollSub = timer(0, 2000).pipe(
          take(MAX_ATTEMPTS),
          switchMap(() => {
            attempt++;
            return this.subscriptionService.loadStatus();
          })
        ).subscribe({
          next: (status) => {
            if (status.hasActiveSubscription && this.paywallActive) {
              this.onSubscriptionRefreshed();
              pollSub.unsubscribe();
            }
          },
          error: () => {},
        });
        this.subscriptions.push(pollSub);
      }
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

    // Reactively clear the paywall when subscription status becomes active
    // (covers login from the wall, post-payment refresh, and cross-tab login).
    // Uses pairwise so it only triggers on a genuine inactive→active transition,
    // not when a subscribed user manually opens the wall and status is re-fetched.
    const statusSubscription = this.subscriptionService.status$.pipe(
      startWith(null),
      pairwise(),
    ).subscribe(([prev, curr]) => {
      const wasActive = prev?.hasActiveSubscription === true;
      const isNowActive = curr?.hasActiveSubscription === true;
      if (!wasActive && isNowActive && this.paywallActive) {
        this.paywallActive = false;
        this.ensureAccessibleDate();
        this.loadCurrentEdition();
        // Defer detectChanges() to a microtask instead of running it synchronously.
        //
        // Why: setStatus() in auth.login()'s tap() operator calls status$.next()
        // synchronously, which fires this pairwise subscriber mid-pipeline — before
        // the tap's downstream next() callback (onLogin.next) has had a chance to run.
        // A synchronous detectChanges() here destroys the wall component via *ngIf,
        // which triggers ngOnDestroy → subs.unsubscribe() → sets isStopped=true on
        // the login subscription → RxJS skips onLogin.next entirely → loginLoading
        // stays true and the login form stays frozen on screen.
        //
        // By deferring to a microtask, the full pipeline (tap → next → onLogin.next)
        // completes first. onLogin.next emits subscriptionRefreshed which calls
        // detectChanges() via onSubscriptionRefreshed(), cleanly closing the wall.
        // The deferred detectChanges() here then runs as a no-op.
        Promise.resolve().then(() => this.cdr.detectChanges());
      }
    });
    this.subscriptions.push(statusSubscription);

    // Fetch subscription status on startup when the user is already logged in
    // (e.g. page reload with a valid token in localStorage).
    this.subscriptionService.loadStatus().subscribe({ error: () => {} });

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
        
        // Single, authoritative loadCurrentEdition() call — deferred until
        // subscription status is known so access-control checks never run
        // against a null status (which would always deny archive access).
        //
        // When status is already in memory (sessionStorage cache or synchronous
        // unauthenticated path), proceed immediately. Otherwise wait for the
        // in-flight loadStatus() HTTP request to complete first.
        const proceed = () => {
          this.ensureAccessibleDate();
          this.loadCurrentEdition();
          this.initialLoadComplete = true;
          this.isLoading = false;
          this.cdr.detectChanges();
        };

        if (this.subscriptionService.getStatus() !== null) {
          // Status already known — proceed immediately.
          proceed();
        } else {
          // Status HTTP is still in-flight. Wait for it before calling
          // loadCurrentEdition() so canAccessEdition/canAccessPage never
          // evaluate against null status (null → false → spurious paywall).
          const readySub = this.subscriptionService.status$.pipe(
            filter((s): s is NonNullable<typeof s> => s !== null),
            take(1),
          ).subscribe(() => proceed());
          this.subscriptions.push(readySub);
        }
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
      // Initialize loading states for thumbnails
      this.thumbnailsLoading = {};
      this.pages.forEach(page => {
        this.thumbnailsLoading[page.id] = true;
      });
      if (this.pages.length > 0) {
        // Access control: guard at the edition level.
        // Even when the edition is gated (e.g. archive in 'today_edition' mode), always
        // display page 1 so the center panel is never blank. The paywall fires as an overlay.
        if (!this.accessControl.canAccessEdition(edition)) {
          this.paywallActive = true;
          this.paywallAccessMode = this.accessControl.getEffectiveAccessMode();
          // Still load page 1 so users see the content preview behind the paywall.
          this.loadPageWithoutGating(this.pages[0]);
        } else {
          this.paywallActive = false;
          // Navigate to section if pendingSectionSlug exists, otherwise select first page.
          if (this.pendingSectionSlug) {
            const found = this.navigateToSection(this.pendingSectionSlug);
            this.pendingSectionSlug = null; // Clear after use
            if (!found) {
              this.selectPage(this.pages[0]);
            }
          } else {
            this.selectPage(this.pages[0]);
          }
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
    if (this.archiveLocked) return;
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

  /** True when the user has no access to past dates (archive locked). */
  get archiveLocked(): boolean {
    return !this.accessControl.canAccessPastDates();
  }

  get currentEdition(): NewspaperEdition | null {
    return this.editionsForDate.find(e => (e.edition || 1) === this.selectedEditionNumber) || this.editionsForDate[0] || null;
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

  /** Proxy for template access to AccessControlService.isPageLocked(). */
  isPageLocked(pageIndex: number): boolean {
    return this.accessControl.isPageLocked(pageIndex);
  }

  /** Called by SubscriptionWallComponent when login or status-refresh succeeds. */
  onSubscriptionRefreshed(): void {
    this.paywallActive = false;
    // If the edition currently on screen is locked (e.g. past date in
    // today_edition mode), silently navigate to today's edition so the
    // paywall doesn't immediately reopen after login/refresh.
    this.ensureAccessibleDate();
    this.loadCurrentEdition();
    this.cdr.detectChanges();
  }

  /**
   * When the currently-selected date's edition is not accessible, silently
   * switch to today's date so that automatic loadCurrentEdition() calls
   * (startup, post-login) never trigger the paywall automatically.
   *
   * User-initiated navigation (date picker, prev/next buttons) intentionally
   * does NOT call this — locking past dates for those cases is correct behaviour.
   */
  private ensureAccessibleDate(): void {
    const edition = this.dataService.getCurrentEdition(this.selectedEditionNumber);
    if (!edition) return; // no edition → loadCurrentEdition() will show empty state
    if (!this.accessControl.canAccessEdition(edition)) {
      const today = this.dataService.getTodayDate();
      if (this.selectedDate !== today) {
        this.selectedDate = today;
        this.dataService.setCurrentDate(today);
      }
    }
  }

  /** Called by SubscriptionStatusComponent when the user clicks the locked badge. */
  onOpenPaywall(): void {
    this.paywallActive = true;
    this.paywallAccessMode = this.accessControl.getEffectiveAccessMode();
    this.cdr.detectChanges();
  }

  /** Closes the paywall modal (backdrop click or close button). */
  onClosePaywall(): void {
    this.paywallActive = false;
    this.cdr.detectChanges();
  }

  selectPage(page: NewspaperPage, targetSectionId?: string) {
    // Access control: guard at the page level (gates in both 'today_edition' and 'archive_access' modes).
    if (!this.accessControl.canAccessPage(page, this.pages)) {
      this.paywallActive = true;
      this.paywallAccessMode = this.accessControl.getEffectiveAccessMode();
      // Keep page 1 visible behind the paywall — do not blank the center panel.
      if (!this.currentPage && this.pages.length > 0) {
        this.loadPageWithoutGating(this.pages[0]);
      }
      this.cdr.detectChanges();
      return;
    }
    this.paywallActive = false;
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

  /**
   * Loads a page into the center panel unconditionally — used to display page 1
   * behind the paywall so the center panel is never blank for gated content.
   */
  private loadPageWithoutGating(page: NewspaperPage): void {
    this.currentPage = page;
    this.imageLoaded = false;
    this.selectedSection = null;
    this.linkedSections = [];
    setTimeout(() => {
      const img = this.mainImageRef?.nativeElement;
      if (img && img.complete && img.naturalWidth > 0) {
        this.onImageLoad();
      }
    }, 0);
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
      console.log('Loading section image from:', resolvedUrl);

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

  resolveImageUrl(url: string): string {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return url;
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

  printImage(imageUrl: string, title: string): void {
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { margin: 0; display: flex; justify-content: center; align-items: flex-start; background: white; }
          img { max-width: 100%; height: auto; display: block; }
          @media print { body { margin: 0; } }
        </style>
      </head>
      <body>
        <img src="${imageUrl}" alt="${title}" onload="window.print(); window.close();" />
      </body>
      </html>
    `);
    win.document.close();
  }

  async downloadImage(imageUrl: string, title: string): Promise<void> {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      a.download = `${title || 'image'}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open(imageUrl, '_blank');
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
      console.log('Using section imageUrl:', imagePath);
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
