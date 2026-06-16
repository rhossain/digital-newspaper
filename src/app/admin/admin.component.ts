import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef, HostListener, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { QuillModule } from 'ngx-quill';
import { NewspaperDataService, NewspaperPage, NewsSection, GlobalSettings, NewspaperEdition, ExportOptions, ImportOptions, ImportValidationResult, ImportPreview, BackupHistoryEntry } from '../services/newspaper-data.service';
import { AuthService } from '../services/auth.service';
import { ToasterService } from '../services/toaster.service';
import { LoaderService } from '../services/loader.service';
import { LockService, LockInfo } from '../services/lock.service';
import { ActivityLogService, ActivityLogEntry, ActivityLogFilters, ACTION_LABELS, ACTION_COLOR } from '../services/activity-log.service';
import { ActionTrackerDirective } from '../directives/action-tracker.directive';
import { TranslationService } from '../i18n/translation.service';
import { ADMIN_THEME } from './themes.config';
import { BulkXmlImportComponent } from './bulk-xml-import/bulk-xml-import.component';
import { Observable, Subscription, Subject, of } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';
import { resizeImageToWidth } from '../shared/utils/image-resize.util';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, QuillModule, BulkXmlImportComponent, ActionTrackerDirective],
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.css'],
  // ViewEncapsulation.None is required so that Quill's dynamically-generated DOM
  // (which carries no Angular attribute) can be styled by the Quill CSS imported
  // via admin.component.css.  The admin CSS uses only class-based selectors so
  // there is no risk of these styles leaking onto the viewer.
  // The Quill styles are bundled with the admin lazy chunk rather than the main
  // bundle, so first-load visitors never download them.
  encapsulation: ViewEncapsulation.None,
})
export class AdminComponent implements OnInit, OnDestroy {
  /** Active theme — set in themes.config.ts */
  readonly adminTheme = ADMIN_THEME;

  @ViewChild('cropperImage') cropperImageRef!: ElementRef<HTMLImageElement>;
  @ViewChild('importFileInput') importFileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('vintageMenuPanel') vintageMenuPanelRef?: ElementRef<HTMLElement>;
  
  pages: NewspaperPage[] = [];
  selectedPage: NewspaperPage | null = null;
  selectedSection: NewsSection | null = null;
  
  // Date management
  selectedDate: string = '';
  availableDates: string[] = [];
  todayDate: string = '';
  isLoadingEdition: boolean = false;

  // Edition management
  selectedEditionNumber: number = 1;
  editionsForDate: NewspaperEdition[] = [];
  editingEditionLabel: NewspaperEdition | null = null;
  editionLabelForm: { en: string; bn: string } = { en: '', bn: '' };
  
  // UI State
  activeTab: 'pages' | 'sections' = 'pages';
  activeMainTab: 'content' | 'settings' | 'logs' = 'content';
  isEditingPage = false;
  isEditingSection = false;
  showImageCropper = false;
  isBodyMaximized = false;
  isMenuOpen = false;
  isSavingCrop = false;
  hasUnsavedChanges = false;
  private hasUnsavedSettingsChanges = false;

  // Vintage theme navigation state
  vintageView: 'pages' | 'sections' | 'section-detail' | 'editions' = 'pages';
  vintageSelectedSection: NewsSection | null = null;

  // ─── Activity log state ───────────────────────────────────────────────────
  logEntries: ActivityLogEntry[] = [];
  logTotal = 0;
  logPage = 1;
  logPerPage = 30;
  logLoading = false;
  logIsLoadingMore = false;
  logSortBy: 'created_at' | 'user_id' | 'action' | 'display_name' = 'created_at';
  logSortDir: 'asc' | 'desc' = 'desc';
  logActionFilter = '';
  logUserFilter = 0;
  logSearchFilter = '';
  logDateFrom = '';
  logDateTo = '';
  logKnownUsers: { userId: number; displayName: string }[] = [];
  expandedLogId: string | null = null;
  readonly logActionLabels = ACTION_LABELS;
  readonly logActionColor  = ACTION_COLOR;
  readonly logActionKeys   = Object.keys(ACTION_LABELS);

  // ─── Locking state ────────────────────────────────────────────────────────
  /** Resource ID of the lock WE currently hold (null if none). */
  private heldLockResource: string | null = null;
  /** True when the currently selected page is locked by another user. */
  isPageLockedByOther = false;
  /** Display name of the user who holds the lock on the current page. */
  lockHeldByName = '';
  /** All active locks — fetched by the poll, used for admin management panel. */
  activeLocks: LockInfo[] = [];
  private lockPollSub?: Subscription;
  /** Per-resource poll sub — used by non-admin users to detect lock release. */
  private resourceLockPollSub?: Subscription;
  /** Cancels any in-flight activity-log HTTP request when a new one starts. */
  private logLoad$ = new Subject<void>();
  /** Emits once on ngOnDestroy to clean up all long-lived subscriptions. */
  private destroy$ = new Subject<void>();
  
  // Form Data
  pageForm: Partial<NewspaperPage> = {
    id: 0,
    thumbnail: '',
    fullImage: '',
    sections: []
  };
  
  // Image input modes
  fullImageInputMode: 'url' | 'file' = 'file';
  fullImageHiResInputMode: 'url' | 'file' = 'url';
  thumbnailInputMode: 'url' | 'file' = 'file';
  fullImageFile: File | null = null;
  fullImageHiResFile: File | null = null;
  thumbnailFile: File | null = null;
  previewLoading: boolean = false;

  // Global Settings
  settingsForm: GlobalSettings = {
    logo: { url: '', alt: 'Digital Newspaper', link: '' },
    socialLinks: {
      facebook: '',
      twitter: '',
      linkedin: '',
      whatsapp: '',
      instagram: '',
      youtube: ''
    },
    defaultDateMode: 'current',
    specificDate: '',
    editor: '',
    editorLabels: { en: '', bn: '' },
    address: {
      line1: '',
      line1Labels: { en: '', bn: '' },
      line2: '',
      line2Labels: { en: '', bn: '' },
      phone: '',
      phoneLabels: { en: '', bn: '' },
      email: '',
      website: ''
    },
    language: 'en',
    headScripts: '',
    underMaintenance: false,
    maintenanceMessage: '',
    othersPageTitle: '',
    imageFormat: 'webp' as 'webp' | 'all'
  };
  logoInputMode: 'url' | 'file' = 'url';
  logoFile: File | null = null;

  // Predefined page name options (paired BN / EN)
  readonly predefinedPageNames: { bn: string; en: string }[] = [
    { bn: 'প্রথম পাতা',    en: 'First Page'   },
    { bn: 'খবর',           en: 'News'          },
    { bn: 'সম্পাদকীয়',   en: 'Editorial'     },
    { bn: 'আন্তর্জাতিক', en: 'International'  },
    { bn: 'সাহিত্য',      en: 'Literature'    },
    { bn: 'গ্রাম-গঞ্জ-শহর', en: 'National'   },
    { bn: 'খেলার খবর',   en: 'Sports'         },
    { bn: 'শেষের পাতা',   en: 'Last Page'     },
    { bn: 'নীল সবুজের হাট', en: 'For Kids'   },
    { bn: 'বিষেশ সংখ্যা', en: 'Supplement'   },
    { bn: 'ঈদুল ফিতর',   en: 'Eid al-Fitr'   },
    { bn: 'ঈদুল আজহা',   en: 'Eid al-Adha'   },
  ];
  pageNameSelect: string = '';
  pageFormErrors: { fullImage?: boolean; pageName?: boolean } = {};

  sectionForm: Partial<NewsSection> = {
    id: '',
    title: '',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    content: '',
    imageUrl: '',
    linkedSectionIds: [],
    showCaption: true
  };

  private generateSectionId(): string {
    return `post-${Date.now()}`;
  }

  private normalizeSectionId(sectionId: string | undefined | null): string {
    const rawId = (sectionId || '').trim();
    if (!rawId) return this.generateSectionId();
    if (rawId.startsWith('section-')) {
      return `post-${rawId.slice('section-'.length)}`;
    }
    return rawId;
  }
  
  // Image source option
  imageSourceOption: 'auto-crop' | 'external-url' | 'upload' = 'auto-crop';

  // Quill rich text editor configuration
  quillModules = {
    toolbar: [
      ['bold', 'italic', 'underline', 'strike'],
      [{ 'header': [1, 2, 3, 4, false] }],
      [{ 'list': 'ordered' }, { 'list': 'bullet' }],
      [{ 'indent': '-1' }, { 'indent': '+1' }],
      [{ 'align': [] }],
      ['blockquote'],
      ['link'],
      ['clean']
    ]
  };
  
  // ─── Bulk XML Import modal state
  showBulkXmlImport = false;

  openBulkXmlImport(): void {
    this.closeMenu();
    this.showBulkXmlImport = true;
  }

  onBulkXmlImportCompleted(event: { firstDate: string }): void {
    this.showBulkXmlImport = false;
    this.toaster.success('Bulk import complete!');
    // Clear all cache layers before reloading so newly imported editions
    // (which may be past dates already stored in IDB / localStorage) are
    // fetched fresh from the server instead of returning stale cached data.
    this.dataService.clearAllCaches();
    this.dataService.loadData().subscribe({
      next: () => {
        if (event.firstDate) {
          this.selectedDate = event.firstDate;
          this.onDateChange();
        }
      },
    });
  }

  // ─── Export modal state
  showExportModal = false;
  exportOptions: ExportOptions = {
    exportType: 'full',
    exportScope: 'full',
  };

  // ─── Import preview modal state
  showImportPreviewModal = false;
  importParsed: any = null;
  importValidation: ImportValidationResult | null = null;
  importPreview: ImportPreview | null = null;
  importOptions: ImportOptions = {
    importSettings: true,
    importEditions: true,
    mergeMode: 'overwrite-all',
    rewriteUrls: false,
  };
  isImporting = false;

  // ─── Backup history
  backupHistory: BackupHistoryEntry[] = [];

  // Image Cropper – base state
  cropperImageLoaded = false;
  cropperStartX = 0;
  cropperStartY = 0;
  cropperEndX = 0;
  cropperEndY = 0;
  isDrawing = false;
  imageNaturalWidth = 0;
  imageNaturalHeight = 0;
  cropperZoom = 1;

  // Enhanced Cropper – interaction
  cropMode: 'idle' | 'drawing' | 'moving' | 'resizing' = 'idle';
  activeResizeHandle: string | null = null;
  dragStartMouseX = 0;
  dragStartMouseY = 0;
  dragStartBox = { x1: 0, y1: 0, x2: 0, y2: 0 };
  cropperCursor = 'crosshair';
  // Enhanced Cropper – options
  cropAspectRatio: number | null = null;
  showCropGrid = false;
  // Enhanced Cropper – undo/redo
  cropUndoStack: Array<{ sx: number; sy: number; ex: number; ey: number }> = [];
  cropRedoStack: Array<{ sx: number; sy: number; ex: number; ey: number }> = [];

  // Image preview lightbox
  previewPageUrl: string | null = null;
  previewPage: any = null;

  // Section image preview lightbox (vintage post cards)
  previewSectionUrl: string | null = null;

  openSectionPreview(section: NewsSection, event: MouseEvent): void {
    event.stopPropagation();
    this.previewSectionUrl = this.resolveImageUrl(section.imageUrl || '');
  }

  closeSectionPreview(): void {
    this.previewSectionUrl = null;
  }

  openPagePreview(page: any, event: MouseEvent) {
    event.stopPropagation();
    this.previewPage = page;
    this.previewPageUrl = page.fullImage || page.thumbnail || null;
  }

  closePagePreview() {
    this.previewPageUrl = null;
    this.previewPage = null;
  }

  previewEditSection(sec: NewsSection) {
    const page = this.previewPage;
    if (!page) return;
    // Acquire lock for this page first; only open section editor if we get it.
    this.acquirePageLockAsync(page.id).subscribe(acquired => {
      if (!acquired) {
        this.toaster.error(`${this.lockHeldByName} is currently editing this page. Editing is disabled.`);
        this.closePagePreview();
        this.cdr.detectChanges();
        return;
      }
      this.selectedPage = page;
      this.selectedSection = null;
      this.activeTab = 'sections';
      this.activityLog.track('page_select', { pageId: String(page.id), pageLabel: this.getPageLabel(page) });
      this.editSection(sec);
      this.closePagePreview();
      this.cdr.detectChanges();
    });
  }

  previewDeleteSection(sec: NewsSection) {
    const page = this.previewPage;
    if (!page) return;
    // Simple guard: if any other user holds the lock on this page, deny deletion.
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Deletion is disabled.`);
      this.closePagePreview();
      return;
    }
    if (!confirm(`Delete section "${sec.title}"?`)) return;
    const previewPageId = this.previewPage.id;
    this.dataService.deleteSection(previewPageId, sec.id, this.selectedDate, this.selectedEditionNumber);
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (edition) this.pages = edition.pages;
    this.previewPage = this.pages.find((p: any) => p.id === previewPageId) ?? null;
    if (!this.previewPage) { this.closePagePreview(); return; }
    this.toaster.success('Section deleted.');
    this.cdr.detectChanges();
    // Atomic server delete
    this.dataService.deleteSectionAtomically(previewPageId, sec.id, this.selectedDate, this.selectedEditionNumber).subscribe({
      next: () => {
        // Reload from server on success; re-sync previewPage to the fresh
        // page reference so the preview modal reflects confirmed server state.
        this.dataService.reloadDate(this.selectedDate).subscribe({
          next: () => {
            this.loadCurrentEdition();
            if (this.previewPage) {
              this.previewPage = this.pages.find((p: any) => p.id === previewPageId) ?? null;
              if (!this.previewPage) this.closePagePreview();
              this.cdr.detectChanges();
            }
          },
        });
      },
      error: () => {
        this.markUnsavedChanges();
        this.toaster.warning('Section deletion could not sync to server. Please try deleting again.');
      }
    });
  }

  constructor(
    private dataService: NewspaperDataService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private toaster: ToasterService,
    private authService: AuthService,
    private translationService: TranslationService,
    private loader: LoaderService,
    private lockService: LockService,
    private activityLog: ActivityLogService
  ) {}

  // ── Image format helpers ─────────────────────────────────────────────────
  // Read the active imageFormat setting at the moment of each upload so that
  // changing the setting mid-session takes effect on the very next upload.

  /**
   * `accept` attribute value for image file inputs.
   * Reads from the live settings form (not yet saved) so the restriction
   * takes effect as soon as the user toggles the radio button.
   */
  get imageAccept(): string {
    return this.settingsForm.imageFormat === 'webp' ? 'image/webp' : 'image/*';
  }

  /** MIME type to use when encoding new images via Canvas or FileReader. */
  private get imageMime(): 'image/webp' | 'image/jpeg' {
    return (this.dataService.getSettings()?.imageFormat || 'webp') === 'webp'
      ? 'image/webp'
      : 'image/jpeg';
  }

  /** File extension (no dot) matching the current image format. */
  private get imageExt(): string {
    return this.imageMime === 'image/webp' ? 'webp' : 'jpg';
  }

  /**
   * Canvas encoding quality.
   * WebP uses 0.88 — visually equivalent to JPEG 0.92 thanks to better
   * codec efficiency, while producing a smaller file.
   */
  private get imageQuality(): number {
    return this.imageMime === 'image/webp' ? 0.88 : 0.92;
  }
  // ────────────────────────────────────────────────────────────────────────

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();
    this.selectedDate = this.todayDate;
    this.availableDates = this.selectedDate ? [this.selectedDate] : [];
    this.backupHistory = this.dataService.getBackupHistory();
    this.verifyAuth();
  }

  ngOnDestroy(): void {
    this.releaseCurrentLock();
    this.lockPollSub?.unsubscribe();
    this.resourceLockPollSub?.unsubscribe();
    this.dataService.stopVersionPoll();
    // Cancel any in-flight log request
    this.logLoad$.next();
    this.logLoad$.complete();
    // Tear down all long-lived subscriptions (version poll listener, etc.)
    this.destroy$.next();
    this.destroy$.complete();
  }

  private markUnsavedChanges(): void {
    this.hasUnsavedChanges = true;
    this.cdr.detectChanges();
  }

  onSettingsFormChanged(): void {
    this.hasUnsavedSettingsChanges = true;
    this.markUnsavedChanges();
  }

  private markSaved(): void {
    this.hasUnsavedChanges = false;
    this.hasUnsavedSettingsChanges = false;
    this.cdr.detectChanges();
  }

  get isAuthenticated(): boolean {
    return this.authService.isAuthenticated();
  }

  get isAdmin(): boolean {
    return this.authService.isAdmin();
  }

  get currentUserName(): string {
    return this.authService.getUserDisplayName();
  }

  authForm = {
    username: '',
    password: ''
  };
  authError = '';
  isAuthenticating = false;

  verifyAuth() {
    if (!this.authService.isAuthenticated()) {
      return;
    }
    this.authService.verifyToken().subscribe({
      next: () => this.loadData(),
      error: () => {
        this.authService.logout();
        this.authError = 'Session expired. Please login again.';
        this.toaster.error(this.authError);
      }
    });
  }

  login() {
    this.authError = '';
    this.isAuthenticating = true;
    this.authService.login(this.authForm.username, this.authForm.password).subscribe({
      next: () => {
        this.isAuthenticating = false;
        this.loadData();
      },
      error: (err) => {
        this.isAuthenticating = false;
        const isParseError = err.error instanceof SyntaxError || (err.status === 200 && err.name === 'HttpErrorResponse');
        const msg: string = err?.message ?? '';
        if (err.status === 0) {
          // Status 0 means the browser got no HTTP response — caused by a
          // brief network drop, a CORS preflight rejection, or the server
          // being momentarily unreachable.  The auth service already retried
          // once, so if we're here the problem persisted.
          this.authError = 'Could not reach the server. Please check your internet connection and try again. '  
            + 'If the problem persists, ask the site administrator to verify: '  
            + '(1) WordPress is online, (2) CORS \'Allowed Origins\' in the Digital Newspaper plugin settings includes this site\'s URL.';
        } else if (err.status === 401 || err.status === 400) {
          this.authError = 'Invalid username or password. Please try again.';
        } else if (err.status === 403) {
          this.authError = 'Access denied. Your WordPress account may not have the Administrator role.';
        } else if (msg.startsWith('WAF_BLOCKED:')) {
          // Host-level security (e.g. Imunify360, ModSecurity) blocked the request.
          // The withCredentials interceptor sends session cookies to avoid this;
          // if it still happens, the REST API paths must be whitelisted server-side.
          const detail = msg.replace('WAF_BLOCKED:', '').trim();
          this.authError = `The login request was blocked by the server's security module. `
            + `To fix: whitelist the path /wp-json/digital-newspaper/v1/ in your hosting `
            + `security settings (Imunify360 → White List, or ModSecurity ignore list). `
            + `Server message: ${detail}`;
        } else if (msg === 'NO_TOKEN' || msg.includes('did not include a token')) {
          this.authError = 'WordPress did not return a login token. Please check: (1) the Digital Newspaper plugin is active, (2) WordPress Permalinks are set to "Post name", and (3) the WordPress URL in the app configuration is correct.';
        } else if (isParseError) {
          this.authError = 'WordPress returned an unexpected response. Please check: (1) WordPress Permalinks are set to "Post name", (2) the Digital Newspaper plugin is active, and (3) the WordPress URL in the app configuration is correct.';
        } else {
          this.authError = `Login failed (HTTP ${err.status}). Check that the Digital Newspaper plugin is active and WordPress Permalinks are set to "Post name".`;
        }
        this.cdr.detectChanges();
        this.toaster.error(this.authError);
      }
    });
  }

  logout() {
    this.activityLog.logClientEvent('logout');
    this.releaseCurrentLock();
    this.dataService.stopVersionPoll();
    this.authService.logout();
    this.authForm.password = '';
  }

  zoomOut() {
    this.cropperZoom = Math.max(0.25, parseFloat((this.cropperZoom - 0.1).toFixed(2)));
  }

  zoomIn() {
    this.cropperZoom = Math.min(3, parseFloat((this.cropperZoom + 0.1).toFixed(1)));
  }

  loadData() {
    this.dataService.loadData().subscribe({
      next: () => {
        // getAllEditionDates() includes editions with no pages yet (e.g. a
        // freshly created date with no pages added).  getAvailableDates() only
        // returns dates that have at least one page, so a brand-new empty date
        // would disappear from the dropdown on every reload.
        this.availableDates = this.dataService.getAllEditionDates();
        if (!this.availableDates.includes(this.selectedDate)) {
          this.availableDates.unshift(this.selectedDate);
        }

        // After a refresh the admin resets to today's date (set in ngOnInit).
        // If today has no pages yet, auto-switch to the most recent date that
        // does so the user doesn't see an empty grid and think data was lost.
        const todayEditions = this.dataService.getEditionsByDate(this.selectedDate);
        const todayHasPages = todayEditions.some(e => e.pages && e.pages.length > 0);
        if (!todayHasPages) {
          const latestWithContent = this.dataService.getAvailableDates()[0];
          if (latestWithContent && latestWithContent !== this.selectedDate) {
            this.selectedDate = latestWithContent;
            this.dataService.setCurrentDate(latestWithContent);
          }
        }

        this.loadCurrentEdition();
        this.loadSettings();
        this.markSaved();
        this.startLockPoll();
        this.startVersionPoll();
        this.cdr.detectChanges();
      },
      error: (error) => console.error('Error loading data:', error)
    });
  }

  /**
   * Poll the server's dataVersion every 30 s.
   * - If nobody is editing (no held lock): silently reload and update UI.
   * - If actively editing: show a non-blocking warning so the user can
   *   save their work before refreshing.
   */
  private startVersionPoll(): void {
    this.dataService.stopVersionPoll();
    this.dataService.startVersionPoll(30_000);
    this.dataService.remoteDataChanged$.pipe(takeUntil(this.destroy$)).subscribe((newVersion: number) => {
      // Immediately adopt the emitted version so the next poll tick (which
      // fires 30 s later) sees local == server and does NOT fire again while
      // loadData() is still in flight.
      this.dataService.patchDataVersionPublic(newVersion);
      if (!this.heldLockResource && !this.isEditingPage && !this.isEditingSection) {
        // Not mid-edit — reload silently then refresh UI
        this.dataService.loadData().subscribe({
          next: () => {
            this.availableDates = this.dataService.getAllEditionDates();
            this.loadCurrentEdition();
            this.cdr.detectChanges();
            this.toaster.success('Content updated by another user — view refreshed.');
          }
        });
      } else {
        // Mid-edit — warn without disrupting the form
        this.toaster.warning('Another user added content. Save your work, then click Refresh to see updates.');
      }
    });
  }

  // ─── Lock helpers ─────────────────────────────────────────────────────────

  /** Build the lock resource ID for the current page. */
  private buildLockResource(pageId: number): string {
    return `${this.selectedDate}:${this.selectedEditionNumber}:${pageId}`;
  }

  /** Acquire a lock when the user enters a page edit context. */
  private acquirePageLock(pageId: number): void {
    this.acquirePageLockAsync(pageId).subscribe();
  }

  /**
   * Acquire a lock and return Observable<true> on success or Observable<false>
   * when another user holds the lock.  Use this when the caller needs to know
   * the result before opening a form.
   */
  private acquirePageLockAsync(pageId: number): Observable<boolean> {
    const resource = this.buildLockResource(pageId);

    // Don't re-acquire if we already hold this exact lock
    if (this.heldLockResource === resource) return of(true);

    // Release any previously held lock (and any resource poll) first
    this.releaseCurrentLock();

    return this.lockService.acquireLock(resource).pipe(
      map(result => {
        if (result.lockedByOther) {
          this.isPageLockedByOther = true;
          this.lockHeldByName = result.heldBy ?? 'Another user';
          // Poll this resource so we notice when it becomes free
          this.startResourceLockPoll(resource);
          this.cdr.detectChanges();
          return false;
        }
        this.heldLockResource = resource;
        this.isPageLockedByOther = false;
        this.lockHeldByName = '';
        this.lockService.startHeartbeat(resource);
        this.cdr.detectChanges();
        return true;
      })
    );
  }

  /** Release our currently held lock (if any). */
  private releaseCurrentLock(): void {
    this.stopResourceLockPoll();
    if (this.heldLockResource) {
      this.lockService.stopHeartbeat();
      this.lockService.releaseLock(this.heldLockResource).subscribe();
      this.heldLockResource = null;
    }
    this.isPageLockedByOther = false;
    this.lockHeldByName = '';
  }

  /**
   * Poll a specific resource every 10 s so the UI updates when another user's
   * lock expires or is released.  Works for all authenticated users.
   */
  private startResourceLockPoll(resourceId: string): void {
    this.stopResourceLockPoll();
    this.resourceLockPollSub = this.lockService.pollResourceLock(resourceId).subscribe(info => {
      if (!info) {
        // Lock was released — allow editing again
        this.isPageLockedByOther = false;
        this.lockHeldByName = '';
        this.stopResourceLockPoll();
        this.toaster.success('The page is now available for editing.');
      } else {
        this.isPageLockedByOther = true;
        this.lockHeldByName = info.displayName;
      }
      this.cdr.detectChanges();
    });
  }

  private stopResourceLockPoll(): void {
    this.resourceLockPollSub?.unsubscribe();
    this.resourceLockPollSub = undefined;
  }

  /** Start polling active locks for the admin lock-management panel.
   *  Only administrators can call GET /locks — non-admins skip this poll. */
  private startLockPoll(): void {
    if (!this.isAdmin) return;
    // Unsubscribe any existing poll before creating a new one to prevent
    // duplicate intervals when startLockPoll() is called after re-login.
    this.lockPollSub?.unsubscribe();
    this.lockPollSub = undefined;

    this.lockPollSub = this.lockService.pollLocks().subscribe({
      next: locks => {
        // null is the sentinel emitted when GET /locks returns 404 (plugin not
        // yet deployed on the server). The Observable auto-completes after this
        // so no further requests are made.
        if (locks === null) {
          console.info(
            '[Digital Newspaper] The lock-management endpoint was not found on the server ' +
            '(GET /digital-newspaper/v1/locks → 404). ' +
            'Upload the latest digital-newspaper.php to enable real-time locking. ' +
            'Editing continues normally without it.'
          );
          this.activeLocks = [];
          this.cdr.detectChanges();
          return;
        }

        this.activeLocks = locks;

        // Refresh the lock banner for the currently-selected page
        if (this.selectedPage && this.heldLockResource === null) {
          const resource = this.buildLockResource(this.selectedPage.id);
          const held = locks.find(l => l.resource === resource);
          this.isPageLockedByOther = !!held;
          this.lockHeldByName      = held?.displayName ?? '';
        }
        this.cdr.detectChanges();
      },
    });
  }

  /** Admin: force-release a lock from the management panel. */
  adminForceReleaseLock(resource: string): void {
    this.lockService.forceReleaseLock(resource).subscribe(() => {
      this.activeLocks = this.activeLocks.filter(l => l.resource !== resource);
      this.toaster.success('Lock released.');
      this.cdr.detectChanges();
    });
  }

  /** Used in template for lock TTL countdown. */
  nowMs(): number { return Date.now(); }

  /** Exposed Math.ceil for use in template. */
  readonly Math = Math;

  // ─── Activity log ─────────────────────────────────────────────────────────

  get logHasMore(): boolean {
    return this.logEntries.length < this.logTotal;
  }

  loadActivityLog(): void {
    if (!this.isAdmin) return;
    // Cancel any in-flight request from a previous load / filter change.
    this.logLoad$.next();
    // Reset to first page and replace entries (used on initial load / filter / sort change)
    this.logPage = 1;
    this.logEntries = [];
    this.logLoading = true;
    this.activityLog.flush(); // push any queued client events before loading
    this.cdr.detectChanges();
    const filters: ActivityLogFilters = {
      page:     1,
      per_page: this.logPerPage,
      sort_by:  this.logSortBy,
      sort_dir: this.logSortDir,
      action:   this.logActionFilter  || undefined,
      userId:   this.logUserFilter    || undefined,
      search:   this.logSearchFilter  || undefined,
      from:     this.logDateFrom      || undefined,
      to:       this.logDateTo        || undefined,
    };
    this.activityLog.getLogs(filters).pipe(takeUntil(this.logLoad$)).subscribe(res => {
      this.logEntries    = res.entries;
      this.logTotal      = res.total;
      this.logKnownUsers = res.users ?? [];
      this.logLoading    = false;
      this.cdr.detectChanges();
    });
  }

  loadMoreLog(): void {
    if (!this.isAdmin || this.logIsLoadingMore || !this.logHasMore) return;
    this.logIsLoadingMore = true;
    this.logPage++;
    this.cdr.detectChanges();
    const filters: ActivityLogFilters = {
      page:     this.logPage,
      per_page: this.logPerPage,
      sort_by:  this.logSortBy,
      sort_dir: this.logSortDir,
      action:   this.logActionFilter  || undefined,
      userId:   this.logUserFilter    || undefined,
      search:   this.logSearchFilter  || undefined,
      from:     this.logDateFrom      || undefined,
      to:       this.logDateTo        || undefined,
    };
    this.activityLog.getLogs(filters).subscribe(res => {
      this.logEntries    = [...this.logEntries, ...res.entries];
      this.logTotal      = res.total;
      this.logIsLoadingMore = false;
      this.cdr.detectChanges();
    });
  }

  onLogsScroll(event: Event): void {
    const el = event.target as HTMLElement;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
    if (nearBottom && this.logHasMore && !this.logIsLoadingMore && !this.logLoading) {
      this.loadMoreLog();
    }
  }

  applyLogFilters(): void { this.loadActivityLog(); }

  clearLogFilters(): void {
    this.logActionFilter = '';
    this.logUserFilter   = 0;
    this.logSearchFilter = '';
    this.logDateFrom     = '';
    this.logDateTo       = '';
    this.loadActivityLog();
  }

  setLogSort(col: 'created_at' | 'user_id' | 'action' | 'display_name'): void {
    if (this.logSortBy === col) {
      this.logSortDir = this.logSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.logSortBy  = col;
      this.logSortDir = 'desc';
    }
    this.loadActivityLog();
  }

  logSortIcon(col: string): string {
    if (this.logSortBy !== col) return '↕';
    return this.logSortDir === 'asc' ? '↑' : '↓';
  }

  /** @deprecated — kept for any stale template references; use loadMoreLog() instead */
  logPrevPage(): void {}
  /** @deprecated — kept for any stale template references; use loadMoreLog() instead */
  logNextPage(): void {}

  toggleLogRow(id: string): void {
    this.expandedLogId = this.expandedLogId === id ? null : id;
  }

  confirmClearLog(): void {
    if (!confirm('Clear the entire activity log? This cannot be undone.')) return;
    this.activityLog.clearLogs().subscribe(() => {
      this.logEntries    = [];
      this.logTotal      = 0;
      this.logKnownUsers = [];
      this.toaster.success('Activity log cleared.');
      this.cdr.detectChanges();
    });
  }

  exportLogCsv(): void {
    // Load all pages for the current filter, then export
    this.activityLog.getLogs({
      ...this.buildLogFilters(),
      page: 1, per_page: 500
    }).subscribe(res => this.activityLog.exportCsv(res.entries));
  }

  private buildLogFilters(): ActivityLogFilters {
    return {
      sort_by:  this.logSortBy,
      sort_dir: this.logSortDir,
      action:   this.logActionFilter  || undefined,
      userId:   this.logUserFilter    || undefined,
      search:   this.logSearchFilter  || undefined,
      from:     this.logDateFrom      || undefined,
      to:       this.logDateTo        || undefined,
    };
  }

  getLogActionLabel(action: string): string { return this.activityLog.getActionLabel(action); }
  getLogActionColor(action: string): string { return this.activityLog.getActionColor(action); }

  formatLogTimestamp(ts: string): string {
    if (!ts) return '—';
    try {
      // PHP now returns ISO-8601 (with 'c' format). For any legacy entries
      // stored as MySQL 'YYYY-MM-DD HH:MM:SS' (no timezone), treat as UTC by
      // replacing the space with 'T' and appending 'Z'. All modern browsers
      // and Safari parse this form correctly.
      const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
      return new Date(iso).toLocaleString([], {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return ts; }
  }

  hasLogDetails(details: Record<string, string>): boolean {
    return !!details && Object.keys(details).length > 0;
  }

  /**
   * Memoized — returns the same array reference for the same `details` object
   * reference, preventing repeated array allocations on every change-detection
   * cycle (called 3 times per row in the template).
   */
  private _detailCache = new WeakMap<object, { key: string; value: string }[]>();

  logDetailEntries(details: Record<string, string>): { key: string; value: string }[] {
    if (!details || typeof details !== 'object') return [];
    const cached = this._detailCache.get(details);
    if (cached) return cached;
    const result = Object.entries(details).map(([key, value]) => ({ key, value: String(value ?? '') }));
    this._detailCache.set(details, result);
    return result;
  }

  // ── trackBy helpers (prevent unnecessary DOM re-creation on *ngFor) ──────
  trackByPageId(_: number, page: NewspaperPage): number { return page.id; }
  trackBySectionId(_: number, sec: NewsSection): string { return sec.id; }
  trackByEditionNum(_: number, ed: NewspaperEdition): number { return ed.edition ?? 1; }
  trackByDate(_: number, date: string): string { return date; }
  trackByLogId(_: number, entry: ActivityLogEntry): string { return entry.id; }

  loadCurrentEdition() {
    this.isLoadingEdition = true;
    this.dataService.setCurrentDate(this.selectedDate);

    // LAZY HYDRATION: loadDataFromGranular() only hydrates editions for
    // latestDate + today.  When the user picks an older date the in-memory
    // editions array won't include it, so getEditionsByDate() would return
    // [] and the user would see "no data" even though the server has it
    // (in dn_edition_{date} options or rebuilt from section posts).
    //
    // hydrateDateIfMissing() is a no-op when the date is already loaded,
    // otherwise it fetches /data/editions/:date through the 4-layer cache
    // and merges the result into the data subject before we read it.
    this.dataService.hydrateDateIfMissing(this.selectedDate).subscribe({
      next: () => this.applyEditionFromMemory(),
      error: () => this.applyEditionFromMemory(), // already swallowed inside the helper
    });
  }

  private applyEditionFromMemory(): void {
    // Populate edition tabs for this date
    this.editionsForDate = this.dataService.getEditionsByDate(this.selectedDate);

    // Load edition immediately from service (no network delay)
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (edition) {
      this.pages = edition.pages;
    } else {
      // Auto-create the first edition; additional editions are created explicitly
      if (this.selectedEditionNumber === 1) {
        this.dataService.getOrCreateEdition(this.selectedDate, 1);
      }
      this.pages = [];
    }

    // Re-sync selectedPage to the freshly-resolved page objects so that
    // selectedPage.sections always reflects current state regardless of what
    // triggered this reload (version poll, save/delete success, date change).
    // This is the single authoritative place that fixes the stale-reference
    // issue for ALL callers of loadCurrentEdition().
    if (this.selectedPage != null) {
      this.selectedPage = this.pages.find(p => p.id === this.selectedPage!.id) ?? null;
    }

    this.isLoadingEdition = false;
    this.cdr.detectChanges();
  }

  onDateChange() {
    this.releaseCurrentLock();
    this.activityLog.track('date_change', { date: this.selectedDate });
    this.selectedEditionNumber = 1;
    this.loadCurrentEdition();
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
    this.vintageView = 'pages';
    this.vintageSelectedSection = null;
  }

  onEditionChange(editionNumber: number) {
    this.releaseCurrentLock();
    this.activityLog.track('edition_change', { edition: String(editionNumber), date: this.selectedDate });
    this.selectedEditionNumber = editionNumber;
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
    this.vintageView = 'pages';
    this.vintageSelectedSection = null;
    this.loadCurrentEdition();
  }

  createNewEdition() {
    const editionNumbers = this.editionsForDate.map(e => e.edition || 1);
    const nextEditionNumber = editionNumbers.length > 0 ? Math.max(...editionNumbers) + 1 : 2;
    this.activityLog.track('edition_add', { date: this.selectedDate, edition: String(nextEditionNumber) });

    this.dataService.getOrCreateEdition(this.selectedDate, nextEditionNumber);
    this.markUnsavedChanges();
    this.selectedEditionNumber = nextEditionNumber;
    if (this.adminTheme !== 'vintage') {
      this.loadCurrentEdition();
      this.toaster.success(`Edition ${nextEditionNumber} created!`);
      const newEd = this.editionsForDate.find(e => (e.edition || 1) === nextEditionNumber);
      if (newEd) this.openEditionLabelEditor(newEd);
      return;
    }

    this.syncCurrentDateStructure(
      'Creating edition and syncing...',
      `Edition ${nextEditionNumber} created!`,
      () => {
        const newEd = this.editionsForDate.find(e => (e.edition || 1) === nextEditionNumber);
        if (newEd) this.openEditionLabelEditor(newEd);
      }
    );
  }

  openEditionLabelEditor(ed: NewspaperEdition) {
    this.editingEditionLabel = ed;
    this.editionLabelForm = {
      en: ed.editionLabels?.['en'] ?? ed.editionLabel ?? '',
      bn: ed.editionLabels?.['bn'] ?? '',
    };
  }

  saveEditionLabels() {
    if (!this.editingEditionLabel) return;
    const targetNum = this.editingEditionLabel.edition || 1;
    const data = this.dataService.getData();
    const editions = data.editions.map(e =>
      e.date === this.selectedDate && (e.edition || 1) === targetNum
        ? { ...e, editionLabels: { en: this.editionLabelForm.en.trim(), bn: this.editionLabelForm.bn.trim() } }
        : e
    );
    this.dataService.updateEditions(editions);
    this.markUnsavedChanges();
    this.editingEditionLabel = null;
    if (this.adminTheme !== 'vintage') {
      this.loadCurrentEdition();
      this.toaster.success('Edition labels saved!');
      return;
    }

    this.syncCurrentDateStructure(
      'Saving edition labels and syncing...',
      'Edition labels saved!'
    );
  }

  /** Display label for the admin UI (always shows EN / BN side-by-side if custom labels are set). */
  getEditionLabel(ed: NewspaperEdition): string {
    const en = ed.editionLabels?.['en'] ?? ed.editionLabel ?? '';
    const bn = ed.editionLabels?.['bn'] ?? '';
    if (en || bn) {
      return en && bn ? `${en} / ${bn}` : en || bn;
    }
    // No custom label: show ordinal names for both languages separated by /
    const enName = this.getEditionOrdinalName(ed.edition || 1, 'en');
    const bnName = this.getEditionOrdinalName(ed.edition || 1, 'bn');
    return `${enName} / ${bnName}`;
  }

  /** Returns the ordinal edition name for a specific language. */
  private getEditionOrdinalName(num: number, lang: 'en' | 'bn'): string {
    const prevLang = this.translationService.language;
    this.translationService.setLanguage(lang);
    const name = this.translationService.getEditionName(num);
    this.translationService.setLanguage(prevLang);
    return name;
  }

  /** Number of pages in the current edition that have imageStatus === 'pending'. */
  get pendingImagePagesCount(): number {
    return this.pages.filter(p => p.imageStatus === 'pending').length;
  }

  /** Display label for a page in the admin UI (EN / BN side-by-side). */
  getPageLabel(page: NewspaperPage): string {
    const en = page.pageLabels?.['en'] ?? '';
    const bn = page.pageLabels?.['bn'] ?? '';
    if (en || bn) {
      return en && bn ? `${en} / ${bn}` : en || bn;
    }
    const idx = this.pages.indexOf(page) + 1 || page.id;
    const enName = this.getPageOrdinalName(idx, 'en');
    const bnName = this.getPageOrdinalName(idx, 'bn');
    return `${enName} / ${bnName}`;
  }

  /** Returns the ordinal page name for a specific language. */
  private getPageOrdinalName(num: number, lang: 'en' | 'bn'): string {
    const prevLang = this.translationService.language;
    this.translationService.setLanguage(lang);
    const name = this.translationService.getPageName(num);
    this.translationService.setLanguage(prevLang);
    return name;
  }

  // ── Add New Date dialog state ──────────────────────────────────────────
  showNewDateDialog = false;
  newDateInput = '';
  newDateError = '';
  newDateWarning = '';

  /** Opens the Add New Date modal, pre-filling today's date. */
  createNewDate() {
    this.newDateInput = this.todayDate;
    this.newDateError = '';
    this.newDateWarning = '';
    this.showNewDateDialog = true;
    // Run live validation immediately so the state reflects today's date.
    this.onNewDateInputChange(this.newDateInput);
  }

  /** Validates the typed date and updates error/warning messages reactively. */
  onNewDateInputChange(value: string): void {
    this.newDateInput = value;
    this.newDateError = '';
    this.newDateWarning = '';

    if (!value) {
      this.newDateError = 'Date is required.';
      return;
    }

    // Format check (browsers with native date picker always emit YYYY-MM-DD;
    // this guard covers manual input in browsers without native support).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      this.newDateError = 'Invalid format. Please use YYYY-MM-DD (e.g. 2025-06-15).';
      return;
    }

    // Calendar validity check (rejects e.g. 2024-02-30, 2023-13-01).
    const [y, m, d] = value.split('-').map(Number);
    const parsed = new Date(y, m - 1, d);
    if (
      parsed.getFullYear() !== y ||
      parsed.getMonth() !== m - 1 ||
      parsed.getDate() !== d
    ) {
      this.newDateError = 'This is not a valid calendar date. Please check the month and day.';
      return;
    }

    // Duplicate / existing-pages check.
    if (this.availableDates.includes(value)) {
      const editions = this.dataService.getEditionsByDate(value);
      const totalPages = editions.reduce((sum, ed) => sum + (ed.pages?.length ?? 0), 0);
      if (totalPages > 0) {
        this.newDateWarning =
          `This date already exists and has ${totalPages} page${totalPages === 1 ? '' : 's'} across ` +
          `${editions.length} edition${editions.length === 1 ? '' : 's'}. ` +
          `You can still open it to add more content.`;
      } else {
        this.newDateWarning = 'This date was previously created but has no pages yet.';
      }
    }
  }

  /** Confirms the dialog: creates/navigates to the date and closes the modal. */
  confirmNewDate(): void {
    // Re-run validation as a safety net.
    this.onNewDateInputChange(this.newDateInput);
    if (this.newDateError || !this.newDateInput) return;

    const newDate = this.newDateInput;
    this.selectedDate = newDate;
    this.dataService.getOrCreateEdition(newDate);
    this.markUnsavedChanges();
    if (!this.availableDates.includes(newDate)) {
      this.availableDates.unshift(newDate);
      this.availableDates.sort().reverse();
    }

    // Optimized date change: for a brand-new empty date, skip the full loadCurrentEdition()
    // which would trigger hydrateDateIfMissing() and subscription overhead.
    // The date was just created in memory, so we already have everything we need.
    this.releaseCurrentLock();
    this.activityLog.track('date_change', { date: this.selectedDate });
    this.selectedEditionNumber = 1;
    
    // Load the edition data directly from memory without hydration
    this.editionsForDate = this.dataService.getEditionsByDate(this.selectedDate);
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    this.pages = edition?.pages || [];
    
    // Reset UI state
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
    this.vintageView = 'pages';
    this.vintageSelectedSection = null;

    this.cdr.detectChanges();
    this.persistNewDateAndRefresh();
    this.cancelNewDateDialog();
  }

  /** Persist a just-created date and keep loading state until it is reloaded from server/index. */
  private persistNewDateAndRefresh(): void {
    if (this.adminTheme !== 'vintage') {
      this.isLoadingEdition = false;
      this.cdr.detectChanges();
      return;
    }

    this.syncCurrentDateStructure(
      'Creating and syncing date...',
      'Date created and visible now.'
    );
  }

  /** Persist current date structural changes and keep loading until UI re-renders from fresh server data. */
  private syncCurrentDateStructure(
    pendingMessage: string,
    successMessage: string,
    onSynced?: () => void
  ): void {
    const date = this.selectedDate;
    const applySyncedUi = () => {
      this.availableDates = this.dataService.getAllEditionDates();
      if (!this.availableDates.includes(date)) {
        this.availableDates.unshift(date);
      }
      this.availableDates = [...new Set(this.availableDates)].sort().reverse();

      this.editionsForDate = this.dataService.getEditionsByDate(this.selectedDate);
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      this.pages = edition?.pages || [];
      this.isLoadingEdition = false;
      this.markSaved();
      if (onSynced) onSynced();
      this.cdr.detectChanges();
      this.toaster.success(successMessage, 4500);
    };

    this.isLoadingEdition = true;
    this.toaster.info(pendingMessage, 7000);

    this.dataService.saveEditionsForDateAtomically(date).pipe(
      switchMap(() => this.dataService.reloadCurrentDateOnly(date))
    ).subscribe({
      next: () => applySyncedUi(),
      error: (err: any) => {
        // Backward compatibility: older plugin versions may not expose the atomic endpoint.
        const status = err?.status;
        if (status === 404 || status === 405) {
          this.dataService.saveData(this.dataService.getData()).pipe(
            switchMap(() => this.dataService.reloadCurrentDateOnly(date))
          ).subscribe({
            next: () => applySyncedUi(),
            error: (fallbackErr: any) => {
              this.isLoadingEdition = false;
              this.markUnsavedChanges();
              const msg = fallbackErr?.error?.message || fallbackErr?.message || 'Unknown error';
              this.toaster.warning(`Changes saved locally but sync is delayed: ${msg}`, 6000);
              this.cdr.detectChanges();
            }
          });
          return;
        }

        this.isLoadingEdition = false;
        this.markUnsavedChanges();
        const msg = err?.error?.message || err?.message || `HTTP ${status}`;
        this.toaster.warning(`Sync failed: ${msg}. Please retry Save All.`, 6000);
        this.cdr.detectChanges();
      }
    });
  }

  /** Closes the Add New Date modal without making any changes. */
  cancelNewDateDialog(): void {
    this.showNewDateDialog = false;
    this.newDateInput = '';
    this.newDateError = '';
    this.newDateWarning = '';
  }
  // ── End Add New Date dialog ─────────────────────────────────────────────

  formatDisplayDate(dateStr: string): string {
    return this.dataService.formatDisplayDate(dateStr);
  }

  // Page Management
  selectPage(page: NewspaperPage) {
    this.selectedPage = page;
    this.selectedSection = null;
    this.activeTab = 'sections';
    this.acquirePageLock(page.id);
    this.activityLog.track('page_select', { pageId: String(page.id), pageLabel: this.getPageLabel(page) });
  }

  onPageNameSelectChange(value: string) {
    this.pageNameSelect = value;
    if (value === '' ) {
      this.pageForm.pageLabels!['en'] = '';
      this.pageForm.pageLabels!['bn'] = '';
    } else if (value === '__custom__') {
      this.pageForm.pageLabels!['en'] = '';
      this.pageForm.pageLabels!['bn'] = '';
    } else {
      const found = this.predefinedPageNames.find(p => p.bn === value);
      if (found) {
        this.pageForm.pageLabels!['en'] = found.en;
        this.pageForm.pageLabels!['bn'] = found.bn;
      }
    }
  }

  private initPageNameSelects() {
    const en = this.pageForm.pageLabels?.['en'] ?? '';
    const bn = this.pageForm.pageLabels?.['bn'] ?? '';
    if (!en && !bn) { this.pageNameSelect = ''; return; }
    const found = this.predefinedPageNames.find(p => p.bn === bn && p.en === en);
    this.pageNameSelect = found ? found.bn : '__custom__';
  }

  newPage() {
    this.isEditingPage = true;
    // Pick the first unused ID in the 1-15 range; fall back to 1 if all are taken.
    const usedIds = new Set(this.pages.map(p => p.id));
    const firstAvailable = Array.from({ length: 15 }, (_, i) => i + 1).find(id => !usedIds.has(id)) ?? 1;
    this.pageForm = {
      id: firstAvailable,
      thumbnail: '',
      fullImage: '',
      fullImageHiRes: '',
      sections: [],
      pageLabels: { en: '', bn: '' }
    };
    this.pageNameSelect = '';
    this.fullImageInputMode = 'file';
    this.fullImageHiResInputMode = 'url';
    this.thumbnailInputMode = 'file';
    this.fullImageFile = null;
    this.fullImageHiResFile = null;
    this.thumbnailFile = null;
  }

  editPage(page: NewspaperPage) {
    // Acquire the lock first; only open the form if we get it.
    this.acquirePageLockAsync(page.id).subscribe(acquired => {
      if (!acquired) {
        this.toaster.error(`${this.lockHeldByName} is currently editing this page. Editing is disabled.`);
        this.cdr.detectChanges();
        return;
      }
      this.isEditingPage = true;
      this.pageForm = { ...page, pageLabels: { en: page.pageLabels?.['en'] ?? '', bn: page.pageLabels?.['bn'] ?? '' } };
      this.initPageNameSelects();
      this.fullImageInputMode = 'file';
      this.fullImageHiResInputMode = 'url';
      this.thumbnailInputMode = 'file';
      this.fullImageFile = null;
      this.fullImageHiResFile = null;
      this.thumbnailFile = null;
      this.activityLog.track('page_edit', { pageId: String(page.id), pageLabel: this.getPageLabel(page) });
      this.cdr.detectChanges();
    });
  }

  savePage() {
    this.pageFormErrors = {};
    const enLabel = (this.pageForm.pageLabels?.['en'] || '').trim();
    const bnLabel = (this.pageForm.pageLabels?.['bn'] || '').trim();
    let hasErrors = false;

    if (!this.pageForm.fullImage) {
      this.pageFormErrors.fullImage = true;
      this.toaster.error('Full Image is required. Please provide an image URL or upload a file.');
      hasErrors = true;
    }
    if (!enLabel && !bnLabel) {
      this.pageFormErrors.pageName = true;
      this.toaster.error('Page Name is required. Please select or enter a page name.');
      hasErrors = true;
    }
    if (hasErrors) return;

    // Safety guard: prevent accidentally overwriting an existing page when creating a new one.
    if (!this.isEditingExistingPage() && this.pages.some(p => p.id === this.pageForm.id)) {
      this.toaster.error('Page ID ' + this.pageForm.id + ' is already in use. Please select a different ID.');
      return;
    }

    if (this.pageForm.id && this.pageForm.fullImage) {
      const page = { ...this.pageForm } as NewspaperPage;
      // Strip empty pageLabels
      if (page.pageLabels) {
        const en = (page.pageLabels['en'] || '').trim();
        const bn = (page.pageLabels['bn'] || '').trim();
        if (en || bn) {
          page.pageLabels = { en, bn };
        } else {
          delete page.pageLabels;
        }
      }
      const existingPage = this.pages.find(p => p.id === page.id);
      
      if (existingPage) {
        this.dataService.updatePage(page.id, page, this.selectedDate, this.selectedEditionNumber);
      } else {
        this.dataService.addPage(page, this.selectedDate, this.selectedEditionNumber);
      }

      // Update local pages immediately (in-memory, no network)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) this.pages = edition.pages;
      if (this.selectedPage?.id === page.id) {
        this.selectedPage = this.pages.find(p => p.id === page.id) || null;
      }

      this.cancelPageEdit();
      this.toaster.success('Page saved successfully!');
      this.activityLog.track('page_save', { pageId: String(page.id), date: this.selectedDate, edition: String(this.selectedEditionNumber) });

      // Atomic server save — only updates THIS page; other users' pages are untouched.
      const savedDate = this.selectedDate;
      const savedEditionNumber = this.selectedEditionNumber;
      this.dataService.savePageAtomically(page, savedDate, savedEditionNumber).subscribe({
        next: () => {
          // Reload from server on success so the grid always reflects what
          // was actually persisted — guards against stale ETag / cache issues.
          // applyEditionFromMemory() (called inside loadCurrentEdition) re-syncs
          // selectedPage centrally, so no manual re-sync is needed here.
          this.dataService.reloadDate(savedDate).subscribe({
            next: () => {
              this.loadCurrentEdition();
              this.cdr.detectChanges();
            },
          });
        },
        error: (err: any) => {
          // Re-fetch from server: the save likely succeeded but the response was
          // lost (e.g. sync step timed out after update_option committed).
          // reloadDate() drops the in-memory edition and re-fetches so both the
          // admin view and the viewer reflect the server's actual stored state.
          this.dataService.reloadDate(savedDate).subscribe({
            next: () => this.loadCurrentEdition(),
          });

          // Surface the actual server error (PHP fatal, validation, etc.) so
          // we don't mis-attribute every failure to a timeout.  Falls back to
          // the original message when the error is genuinely a timeout or a
          // network-level failure with no response body.
          const body = err?.error;
          let serverMsg = '';
          if (body && typeof body === 'object') {
            // Newer backend returns { error, code, message, file, line, ... }.
            serverMsg = String(body.message || body.error || '');
          } else if (typeof body === 'string' && body.trim().length) {
            // Older backend (or fatals before the shutdown handler is reached)
            // returns the WordPress critical-error HTML page.  Don't dump raw
            // HTML into a toast — collapse it to a single readable line.
            serverMsg = /critical error/i.test(body)
              ? 'WordPress reported a critical PHP error (likely out-of-memory or timeout). Check ?dn_diag=last-fatal for details.'
              : body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
          }
          // Strip HTML tags from JSON-bodied messages too, just in case the
          // backend embeds any markup in $e->getMessage().
          if (/<[a-z][^>]*>/i.test(serverMsg)) {
            serverMsg = serverMsg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }

          const status = err?.status;
          if (status === 500 && serverMsg) {
            this.toaster.error(`Save failed (server error): ${serverMsg}`);
          } else if (status === 500) {
            this.toaster.error('Save failed: WordPress PHP fatal (no body). Check ?dn_diag=last-fatal for the captured error.');
          } else if (status === 422 && serverMsg) {
            this.toaster.error(`Save rejected: ${serverMsg}`);
          } else if (status === 0 || err?.name === 'TimeoutError') {
            this.toaster.warning('Server response timed out — refreshing data from server. Your page should appear shortly.');
          } else if (status) {
            this.toaster.error(`Save failed (HTTP ${status}). Refreshing from server.`);
          } else {
            this.toaster.warning('Server response timed out — refreshing data from server. Your page should appear shortly.');
          }
        }
      });
    }
  }

  deletePage(page: NewspaperPage) {
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Deletion is disabled.`);
      return;
    }
    if (confirm(`Delete page ${page.id}?`)) {
      this.dataService.deletePage(page.id, this.selectedDate, this.selectedEditionNumber);
      if (this.selectedPage?.id === page.id) this.selectedPage = null;

      // Update local pages immediately (in-memory, no network)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) this.pages = edition.pages;

      this.toaster.success('Page deleted successfully!');
      this.activityLog.track('page_delete', { pageId: String(page.id), date: this.selectedDate });

      // Atomic server delete — only removes THIS page.
      this.dataService.deletePageAtomically(page.id, this.selectedDate, this.selectedEditionNumber).subscribe({
        next: () => {
          // Reload from server on success to confirm the deletion persisted.
          this.dataService.reloadDate(this.selectedDate).subscribe({
            next: () => this.loadCurrentEdition(),
          });
        },
        error: () => {
          this.markUnsavedChanges();
          this.toaster.warning('Page deletion could not sync to server. Please try deleting again.');
        }
      });
    }
  }

  cancelPageEdit() {
    this.isEditingPage = false;
    this.pageForm = { id: 0, thumbnail: '', fullImage: '', fullImageHiRes: '', sections: [], pageLabels: { en: '', bn: '' } };
    this.pageNameSelect = '';
    this.pageFormErrors = {};
    // Only release if we're not staying on the page (e.g. sections still selected)
    if (!this.selectedPage) {
      this.releaseCurrentLock();
    }
  }

  // Section Management
  newSection() {
    if (!this.selectedPage) {
      alert('Please select a page first');
      return;
    }
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Adding sections is disabled.`);
      return;
    }
    
    this.isEditingSection = true;
    this.imageSourceOption = 'auto-crop'; // Default to auto-crop
    this.sectionForm = {
      id: this.generateSectionId(),
      title: '',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      content: '',
      imageUrl: '',
      pageId: this.selectedPage.id,
      linkedSectionIds: [],
      linkedSectionPrimary: undefined,
      showCaption: true
    };
  }

  editSection(section: NewsSection) {
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Editing sections is disabled.`);
      return;
    }
    this.isEditingSection = true;
    this.selectedSection = section;
    this.sectionForm = {
      ...section,
      id: this.normalizeSectionId(section.id)
    };
    
    // Set the appropriate radio button based on imageUrl
    if (!section.imageUrl || section.imageUrl.trim() === '') {
      this.imageSourceOption = 'auto-crop';
    } else if (section.imageUrl.startsWith('assets/cropped/')) {
      this.imageSourceOption = 'upload';
    } else {
      this.imageSourceOption = 'external-url';
    }
  }

  saveSection(closeForm = true) {
    // Guard: lock must not be held by another user at save time
    // (newSection/editSection check on open, but the lock could have been
    // acquired by someone else while the form was already open).
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Your changes were not saved.`);
      return;
    }
    if (this.selectedPage && this.sectionForm.id && this.sectionForm.title) {
      const normalizedSectionId = this.normalizeSectionId(this.sectionForm.id);

      // Clear imageUrl if auto-crop is selected
      const imageUrl = this.imageSourceOption === 'auto-crop' ? '' : (this.sectionForm.imageUrl || '');
      
      // Prefer the admin's explicit primary choice; validate it is still in the linked list.
      // Fall back to earliest-timestamp detection for old data or if the form primary is stale.
      const linkedIds = this.sectionForm.linkedSectionIds || [];
      const linkedSectionPrimary: string | undefined = (() => {
        if (linkedIds.length === 0) return undefined;
        const explicit = this.sectionForm.linkedSectionPrimary;
        // Accept an explicit choice that refers to ANY section in this group —
        // including the current section itself (self-reference = "I am the primary").
        if (explicit && (explicit === normalizedSectionId || linkedIds.includes(explicit))) return explicit;
        // Auto-fallback: pick the section with the earliest creation timestamp,
        // including the CURRENT section being saved so it can win the race too.
        const getTs = (id: string): number => {
          const m = /^post-(\d+)$/.exec(id);
          return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
        };
        return [normalizedSectionId, ...linkedIds].reduce((best, id) => (getTs(id) < getTs(best) ? id : best));
      })();

      // Create a clean copy of the section
      const section: NewsSection = {
        id: normalizedSectionId,
        title: this.sectionForm.title,
        x: this.sectionForm.x || 0,
        y: this.sectionForm.y || 0,
        width: this.sectionForm.width || 0,
        height: this.sectionForm.height || 0,
        content: this.sectionForm.content || '',
        imageUrl: imageUrl,
        pageId: this.selectedPage.id,
        linkedSectionIds: linkedIds,
        linkedSectionPrimary,
        showCaption: this.sectionForm.showCaption !== undefined ? this.sectionForm.showCaption : true
      };

      // Content propagation (Case 1): if this section has no meaningful content and a primary
      // section is designated, auto-copy the primary's HTML before any data-service write,
      // so both the in-memory state and the server payload receive the correct content.
      // Strips HTML tags to determine whether the content is truly empty (handles Quill's
      // <p><br></p> placeholder as well as plain empty strings).
      const hasRealContent = (html: string | undefined): boolean =>
        html ? html.replace(/<[^>]*>/g, '').trim().length > 0 : false;

      if (!hasRealContent(section.content) && section.linkedSectionPrimary) {
        const primarySection = this.pages
          .flatMap(p => p.sections)
          .find(s => s.id === section.linkedSectionPrimary);
        if (primarySection && hasRealContent(primarySection.content)) {
          section.content = primarySection.content!;
        }
      }

      // Check if section exists by looking in the service data (not the stale selectedPage)
      const currentEdition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      const currentPage = currentEdition?.pages.find(p => p.id === this.selectedPage?.id);
      const originalSectionId = this.selectedSection?.id || normalizedSectionId;
      const existingSection = currentPage?.sections.find(s => s.id === originalSectionId);
      
      // Capture identifiers before any state changes
      const savePageId = this.selectedPage.id;
      const saveDate    = this.selectedDate;
      const saveEdition = this.selectedEditionNumber;

      if (existingSection) {
        this.dataService.updateSection(savePageId, originalSectionId, section, saveDate, saveEdition);
      } else {
        this.dataService.addSection(savePageId, section, saveDate, saveEdition);
      }

      this.sectionForm.id = normalizedSectionId;

      // Sync bidirectional links in-memory AND collect changed sections for server persistence.
      // syncBidirectionalLinks() reads pre-mutation state, so sectionsToSave is accurate.
      const sectionsToSave = this.syncBidirectionalLinks(normalizedSectionId, section.linkedSectionIds || [], linkedSectionPrimary);

      // Content propagation (Case 2): if THIS section has content and other sections in the
      // group are empty AND designate this section as their primary, push the content to them.
      // Covers: (a) back-linked sections now in the save queue, (b) forward-linked sections
      // that were saved previously with linkedSectionPrimary pointing here.
      if (hasRealContent(section.content)) {
        // Build candidate list: sections already in the queue + forward-linked sections on disk
        const candidates: Array<{ section: NewsSection; pageId: number }> = [...sectionsToSave];
        for (const linkedId of (section.linkedSectionIds || [])) {
          if (!candidates.some(c => c.section.id === linkedId)) {
            for (const page of this.pages) {
              const found = page.sections.find(s => s.id === linkedId);
              if (found) { candidates.push({ section: found, pageId: page.id }); break; }
            }
          }
        }
        for (const candidate of candidates) {
          if (candidate.section.linkedSectionPrimary !== normalizedSectionId) continue;
          if (hasRealContent(candidate.section.content)) continue;
          const updated: NewsSection = { ...candidate.section, content: section.content };
          this.dataService.updateSection(candidate.pageId, candidate.section.id, updated, saveDate, saveEdition);
          const inQueue = sectionsToSave.find(ls => ls.section.id === candidate.section.id);
          if (inQueue) {
            inQueue.section = updated;
          } else {
            sectionsToSave.push({ pageId: candidate.pageId, section: updated });
          }
        }
      }

      // Update local pages immediately (in-memory, no network)
      const edition = this.dataService.getEditionByDateAndNumber(saveDate, saveEdition);
      if (edition) this.pages = edition.pages;
      this.selectedPage = this.pages.find(p => p.id === savePageId) || null;

      if (closeForm) {
        this.cancelSectionEdit();
        this.toaster.success('Section saved successfully!');
        this.activityLog.track('section_save', { sectionId: normalizedSectionId, title: section.title, pageId: String(savePageId) });
      }

      // Save primary section first, then each back-link SEQUENTIALLY to avoid server race conditions.
      // Parallel saves to the same JSON file can cause the second write to overwrite the first.
      this.dataService.saveSectionAtomically(savePageId, section, originalSectionId, saveDate, saveEdition).pipe(
        switchMap(() => {
          if (sectionsToSave.length === 0) return of(null as any);
          // Chain each back-link save one after the other
          return sectionsToSave.reduce(
            (chain$: Observable<any>, ls) => chain$.pipe(
              switchMap(() => this.dataService.saveSectionAtomically(
                ls.pageId, ls.section, ls.section.id, saveDate, saveEdition
              ))
            ),
            of(null as any)
          );
        })
      ).subscribe({
        next: () => {
          // Reload from server on success so the sections grid always reflects
          // what was actually persisted — guards against stale cache issues.
          // applyEditionFromMemory() (called inside loadCurrentEdition) re-syncs
          // selectedPage centrally, so no manual re-sync is needed here.
          this.dataService.reloadDate(saveDate).subscribe({
            next: () => {
              this.loadCurrentEdition();
              this.cdr.detectChanges();
            },
          });
        },
        error: () => {
          this.toaster.warning('Section sync response failed. The section may have been saved — reload to confirm, or try saving again.');
          this.markUnsavedChanges();
        }
      });
    } else {
      console.error('Missing required fields:', {
        hasPage: !!this.selectedPage,
        hasId: !!this.sectionForm.id,
        hasTitle: !!this.sectionForm.title,
        sectionForm: this.sectionForm
      });
    }
  }

  deleteSection(section: NewsSection) {
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Deletion is disabled.`);
      return;
    }
    if (this.selectedPage && confirm(`Delete section "${section.title}"?`)) {
      const delPageId  = this.selectedPage.id;
      const delDate    = this.selectedDate;
      const delEdition = this.selectedEditionNumber;

      this.dataService.deleteSection(delPageId, section.id, delDate, delEdition);

      // Update local pages immediately (in-memory, no network)
      const edition = this.dataService.getEditionByDateAndNumber(delDate, delEdition);
      if (edition) this.pages = edition.pages;
      this.selectedPage = this.pages.find(p => p.id === delPageId) || null;

      this.toaster.success('Section deleted successfully!');
      this.activityLog.track('section_delete', { sectionTitle: section.title, pageId: String(delPageId) });

      // Atomic server delete — only removes THIS section.
      this.dataService.deleteSectionAtomically(delPageId, section.id, delDate, delEdition).subscribe({
        next: () => {
          // Reload from server on success to confirm the deletion persisted.
          // Prevents stale cache from restoring the deleted section on next reload.
          this.dataService.reloadDate(delDate).subscribe({
            next: () => this.loadCurrentEdition(),
          });
        },
        error: () => {
          this.markUnsavedChanges();
          this.toaster.warning('Section deletion could not sync to server. Please try again.');
        }
      });
    }
  }

  cancelSectionEdit() {
    this.isEditingSection = false;
    this.selectedSection = null;
    this.sectionForm = {
      id: '',
      title: '',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      content: '',
      imageUrl: '',
      linkedSectionIds: [],
      linkedSectionPrimary: undefined
    };
  }

  // ─── Image Cropper ──────────────────────────────────────────────

  openImageCropper() {
    if (!this.selectedPage?.fullImage) {
      alert('Please save the page with a full image URL first');
      return;
    }
    this.activityLog.track('cropper_open', { pageId: String(this.selectedPage?.id ?? ''), sectionId: this.sectionForm.id ?? '' });
    this.showImageCropper = true;
    this.cropperImageLoaded = false;
    this.cropperZoom = 1;
    this.cropMode = 'idle';
    this.activeResizeHandle = null;
    this.cropUndoStack = [];
    this.cropRedoStack = [];
    this.cropperCursor = 'crosshair';
    // Box will be restored in onCropperImageLoad from sectionForm
    this.cropperStartX = 0;
    this.cropperStartY = 0;
    this.cropperEndX = 0;
    this.cropperEndY = 0;
  }

  onCropperImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    this.imageNaturalWidth = img.naturalWidth;
    this.imageNaturalHeight = img.naturalHeight;
    this.cropperImageLoaded = true;
    this.cdr.detectChanges(); // render side-panel / stage first
    // Defer reading clientWidth until the layout has settled after detectChanges.
    // We prefer clientWidth (CSS layout, same as the draw coordinate space) and
    // fall back to naturalWidth (always available immediately after load).
    requestAnimationFrame(() => {
      if ((this.sectionForm.width ?? 0) > 0 && (this.sectionForm.height ?? 0) > 0) {
        const w = img.clientWidth  || img.naturalWidth;
        const h = img.clientHeight || img.naturalHeight;
        if (w > 0 && h > 0) {
          // Convert stored float percentages back to display-pixel positions.
          // Using the same reference (clientWidth) that calculateCropCoordinates
          // used when saving, so the round-trip is lossless.
          this.cropperStartX = ((this.sectionForm.x ?? 0) / 100) * w;
          this.cropperStartY = ((this.sectionForm.y ?? 0) / 100) * h;
          this.cropperEndX   = (((this.sectionForm.x ?? 0) + (this.sectionForm.width  ?? 0)) / 100) * w;
          this.cropperEndY   = (((this.sectionForm.y ?? 0) + (this.sectionForm.height ?? 0)) / 100) * h;
          this.cdr.detectChanges();
        }
      }
    });
  }

  onCropperMouseDown(event: MouseEvent) {
    if (!this.cropperImageRef) return;
    const mx = event.offsetX ?? 0;
    const my = event.offsetY ?? 0;

    if (this.hasCropBox()) {
      const handle = this.getHandleAtPoint(mx, my);
      if (handle) {
        this.pushCropUndo();
        this.cropMode = 'resizing';
        this.activeResizeHandle = handle;
        this.dragStartMouseX = mx;
        this.dragStartMouseY = my;
        const norm = this.getCropNormalized();
        this.dragStartBox = { x1: norm.x1, y1: norm.y1, x2: norm.x2, y2: norm.y2 };
        this.cdr.detectChanges();
        return;
      }
      if (this.isInsideCropBox(mx, my)) {
        this.pushCropUndo();
        this.cropMode = 'moving';
        this.dragStartMouseX = mx;
        this.dragStartMouseY = my;
        const norm = this.getCropNormalized();
        this.dragStartBox = { x1: norm.x1, y1: norm.y1, x2: norm.x2, y2: norm.y2 };
        this.cdr.detectChanges();
        return;
      }
    }

    this.pushCropUndo();
    this.cropMode = 'drawing';
    this.isDrawing = true;
    this.cropperStartX = mx;
    this.cropperStartY = my;
    this.cropperEndX = mx;
    this.cropperEndY = my;
    this.cdr.detectChanges();
  }

  onCropperMouseMove(event: MouseEvent) {
    if (!this.cropperImageRef) return;
    const mx = event.offsetX ?? 0;
    const my = event.offsetY ?? 0;

    if (this.cropMode === 'drawing') {
      this.cropperEndX = mx;
      this.cropperEndY = my;
      if (this.cropAspectRatio) this.applyAspectRatioConstraint();
      this.calculateCropCoordinates();
    } else if (this.cropMode === 'moving') {
      const img = this.cropperImageRef.nativeElement;
      const imgW = img.clientWidth;
      const imgH = img.clientHeight;
      const dx = mx - this.dragStartMouseX;
      const dy = my - this.dragStartMouseY;
      const bw = this.dragStartBox.x2 - this.dragStartBox.x1;
      const bh = this.dragStartBox.y2 - this.dragStartBox.y1;
      this.cropperStartX = Math.max(0, Math.min(this.dragStartBox.x1 + dx, imgW - bw));
      this.cropperStartY = Math.max(0, Math.min(this.dragStartBox.y1 + dy, imgH - bh));
      this.cropperEndX = this.cropperStartX + bw;
      this.cropperEndY = this.cropperStartY + bh;
      this.calculateCropCoordinates();
    } else if (this.cropMode === 'resizing') {
      this.handleResize(mx, my);
    } else {
      this.updateCropCursor(mx, my);
    }
    this.cdr.detectChanges();
  }

  onCropperMouseUp() {
    if (this.cropMode === 'idle') return;
    this.cropMode = 'idle';
    this.isDrawing = false;
    this.activeResizeHandle = null;
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  onCropperMouseLeave() {
    if (this.cropMode !== 'idle') this.onCropperMouseUp();
  }

  onCropperTouchStart(event: TouchEvent) {
    event.preventDefault();
    const touch = event.touches[0];
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zoom = this.cropperZoom || 1;
    this.onCropperMouseDown({ offsetX: (touch.clientX - rect.left) / zoom, offsetY: (touch.clientY - rect.top) / zoom } as unknown as MouseEvent);
  }

  onCropperTouchMove(event: TouchEvent) {
    event.preventDefault();
    const touch = event.touches[0];
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zoom = this.cropperZoom || 1;
    this.onCropperMouseMove({ offsetX: (touch.clientX - rect.left) / zoom, offsetY: (touch.clientY - rect.top) / zoom } as unknown as MouseEvent);
  }

  onCropperTouchEnd(event: TouchEvent) {
    event.preventDefault();
    this.onCropperMouseUp();
  }

  calculateCropCoordinates() {
    if (!this.cropperImageRef) return;
    const img = this.cropperImageRef.nativeElement;
    // Use clientWidth (= naturalWidth for inline-block stage) for coordinate
    // normalisation. Fall back to naturalWidth in case layout hasn't settled.
    const imgWidth  = img.clientWidth  || img.naturalWidth;
    const imgHeight = img.clientHeight || img.naturalHeight;
    if (!imgWidth || !imgHeight) return;
    const x1 = Math.min(this.cropperStartX, this.cropperEndX);
    const y1 = Math.min(this.cropperStartY, this.cropperEndY);
    const x2 = Math.max(this.cropperStartX, this.cropperEndX);
    const y2 = Math.max(this.cropperStartY, this.cropperEndY);
    // Store as high-precision floats (4 d.p.) to avoid rounding drift on restore.
    // For a 3000-px image, 4 d.p. = 0.003 px error — effectively lossless.
    const round4 = (v: number) => parseFloat(v.toFixed(4));
    this.sectionForm = {
      ...this.sectionForm,
      x:      round4(Math.max(0, (x1 / imgWidth)  * 100)),
      y:      round4(Math.max(0, (y1 / imgHeight) * 100)),
      width:  round4(Math.min(100, ((x2 - x1) / imgWidth)  * 100)),
      height: round4(Math.min(100, ((y2 - y1) / imgHeight) * 100))
    };
  }

  // ─── Crop helper methods ───────────────────────────────────────────

  getCropNormalized(): { x1: number; y1: number; x2: number; y2: number; w: number; h: number } {
    const x1 = Math.min(this.cropperStartX, this.cropperEndX);
    const y1 = Math.min(this.cropperStartY, this.cropperEndY);
    const x2 = Math.max(this.cropperStartX, this.cropperEndX);
    const y2 = Math.max(this.cropperStartY, this.cropperEndY);
    return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
  }

  hasCropBox(): boolean {
    return Math.abs(this.cropperEndX - this.cropperStartX) > 5 &&
           Math.abs(this.cropperEndY - this.cropperStartY) > 5;
  }

  private getHandleAtPoint(mx: number, my: number): string | null {
    if (!this.hasCropBox()) return null;
    const { x1, y1, x2, y2 } = this.getCropNormalized();
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const R = 8;
    const handles = [
      { id: 'nw', x: x1, y: y1 }, { id: 'n', x: cx, y: y1 }, { id: 'ne', x: x2, y: y1 },
      { id: 'e', x: x2, y: cy },
      { id: 'se', x: x2, y: y2 }, { id: 's', x: cx, y: y2 }, { id: 'sw', x: x1, y: y2 },
      { id: 'w', x: x1, y: cy },
    ];
    for (const h of handles) {
      if (Math.abs(mx - h.x) <= R && Math.abs(my - h.y) <= R) return h.id;
    }
    return null;
  }

  private isInsideCropBox(mx: number, my: number): boolean {
    if (!this.hasCropBox()) return false;
    const { x1, y1, x2, y2 } = this.getCropNormalized();
    return mx > x1 + 8 && mx < x2 - 8 && my > y1 + 8 && my < y2 - 8;
  }

  private updateCropCursor(mx: number, my: number) {
    const handle = this.getHandleAtPoint(mx, my);
    if (handle) {
      const cursors: Record<string, string> = {
        nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
        e: 'e-resize', se: 'se-resize', s: 's-resize',
        sw: 'sw-resize', w: 'w-resize'
      };
      this.cropperCursor = cursors[handle] ?? 'pointer';
    } else if (this.isInsideCropBox(mx, my)) {
      this.cropperCursor = 'move';
    } else {
      this.cropperCursor = 'crosshair';
    }
  }

  private handleResize(mx: number, my: number) {
    if (!this.activeResizeHandle || !this.cropperImageRef) return;
    const img = this.cropperImageRef.nativeElement;
    const imgW = img.clientWidth;
    const imgH = img.clientHeight;
    const dx = mx - this.dragStartMouseX;
    const dy = my - this.dragStartMouseY;
    const { x1, y1, x2, y2 } = this.dragStartBox;
    const MIN = 10;
    let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;

    switch (this.activeResizeHandle) {
      case 'nw': nx1 = Math.max(0, Math.min(x1 + dx, x2 - MIN)); ny1 = Math.max(0, Math.min(y1 + dy, y2 - MIN)); break;
      case 'n':  ny1 = Math.max(0, Math.min(y1 + dy, y2 - MIN)); break;
      case 'ne': nx2 = Math.min(imgW, Math.max(x2 + dx, x1 + MIN)); ny1 = Math.max(0, Math.min(y1 + dy, y2 - MIN)); break;
      case 'e':  nx2 = Math.min(imgW, Math.max(x2 + dx, x1 + MIN)); break;
      case 'se': nx2 = Math.min(imgW, Math.max(x2 + dx, x1 + MIN)); ny2 = Math.min(imgH, Math.max(y2 + dy, y1 + MIN)); break;
      case 's':  ny2 = Math.min(imgH, Math.max(y2 + dy, y1 + MIN)); break;
      case 'sw': nx1 = Math.max(0, Math.min(x1 + dx, x2 - MIN)); ny2 = Math.min(imgH, Math.max(y2 + dy, y1 + MIN)); break;
      case 'w':  nx1 = Math.max(0, Math.min(x1 + dx, x2 - MIN)); break;
    }
    if (this.cropAspectRatio && ['nw', 'ne', 'se', 'sw'].includes(this.activeResizeHandle)) {
      const newW = nx2 - nx1;
      const targetH = newW / this.cropAspectRatio;
      if (this.activeResizeHandle === 'nw' || this.activeResizeHandle === 'ne') {
        ny1 = Math.max(0, ny2 - targetH);
      } else {
        ny2 = Math.min(imgH, ny1 + targetH);
      }
    }
    this.cropperStartX = nx1; this.cropperStartY = ny1;
    this.cropperEndX = nx2; this.cropperEndY = ny2;
    this.calculateCropCoordinates();
  }

  private applyAspectRatioConstraint() {
    if (!this.cropAspectRatio) return;
    const w = Math.abs(this.cropperEndX - this.cropperStartX);
    const h = w / this.cropAspectRatio;
    const dirY = this.cropperEndY >= this.cropperStartY ? 1 : -1;
    this.cropperEndY = this.cropperStartY + dirY * h;
  }

  pushCropUndo() {
    this.cropUndoStack.push({
      sx: this.cropperStartX, sy: this.cropperStartY,
      ex: this.cropperEndX, ey: this.cropperEndY
    });
    if (this.cropUndoStack.length > 30) this.cropUndoStack.shift();
    this.cropRedoStack = [];
  }

  undoCrop() {
    if (!this.cropUndoStack.length) return;
    this.cropRedoStack.push({ sx: this.cropperStartX, sy: this.cropperStartY, ex: this.cropperEndX, ey: this.cropperEndY });
    const prev = this.cropUndoStack.pop()!;
    this.cropperStartX = prev.sx; this.cropperStartY = prev.sy;
    this.cropperEndX = prev.ex; this.cropperEndY = prev.ey;
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  redoCrop() {
    if (!this.cropRedoStack.length) return;
    this.cropUndoStack.push({ sx: this.cropperStartX, sy: this.cropperStartY, ex: this.cropperEndX, ey: this.cropperEndY });
    const next = this.cropRedoStack.pop()!;
    this.cropperStartX = next.sx; this.cropperStartY = next.sy;
    this.cropperEndX = next.ex; this.cropperEndY = next.ey;
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  setCropAspectRatio(ratio: number | null) { this.cropAspectRatio = ratio; }

  moveCropBox(dx: number, dy: number, imgW: number, imgH: number) {
    if (!this.hasCropBox()) return;
    const { x1, y1, w, h } = this.getCropNormalized();
    const nx1 = Math.max(0, Math.min(x1 + dx, imgW - w));
    const ny1 = Math.max(0, Math.min(y1 + dy, imgH - h));
    this.cropperStartX = nx1; this.cropperStartY = ny1;
    this.cropperEndX = nx1 + w; this.cropperEndY = ny1 + h;
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  getCropPixelDimensions(): { w: number; h: number } {
    if (!this.cropperImageRef?.nativeElement || !this.hasCropBox() || !this.imageNaturalWidth) return { w: 0, h: 0 };
    const img = this.cropperImageRef.nativeElement;
    const scaleX = this.imageNaturalWidth / img.clientWidth;
    const scaleY = this.imageNaturalHeight / img.clientHeight;
    const { w, h } = this.getCropNormalized();
    return { w: Math.round(w * scaleX), h: Math.round(h * scaleY) };
  }

  getResizeHandleStyle(handle: string): { [key: string]: string } {
    if (!this.hasCropBox()) return { display: 'none' };
    const { x1, y1, x2, y2 } = this.getCropNormalized();
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const pos: Record<string, [number, number]> = {
      nw: [x1, y1], n: [cx, y1], ne: [x2, y1],
      e: [x2, cy], se: [x2, y2], s: [cx, y2],
      sw: [x1, y2], w: [x1, cy],
    };
    const [left, top] = pos[handle] ?? [0, 0];
    return { left: `${left}px`, top: `${top}px` };
  }

  getExistingSectionsForCropper(): NewsSection[] {
    if (!this.selectedPage) return [];
    return this.selectedPage.sections.filter(s =>
      s.id !== this.sectionForm.id && (s.width ?? 0) > 0 && (s.height ?? 0) > 0
    );
  }

  getExistingSectionBoxStyle(section: NewsSection): { [key: string]: string } {
    if (!this.cropperImageRef?.nativeElement) return { display: 'none' };
    const img = this.cropperImageRef.nativeElement;
    const w = img.clientWidth; const h = img.clientHeight;
    if (!w || !h) return { display: 'none' };
    return {
      left: `${(section.x / 100) * w}px`,
      top: `${(section.y / 100) * h}px`,
      width: `${(section.width / 100) * w}px`,
      height: `${(section.height / 100) * h}px`,
    };
  }

  getSectionThumbStyle(section: NewsSection): { [key: string]: string } {
    const imageUrl = this.selectedPage?.fullImageHiRes || this.selectedPage?.fullImage || '';
    if (!imageUrl || !section.width || !section.height) return { background: 'var(--color-bg-muted)' };
    const tW = 44; const tH = 56;
    return {
      'background-image': `url(${imageUrl})`,
      'background-size': `${Math.round(tW * 100 / section.width)}px ${Math.round(tH * 100 / section.height)}px`,
      'background-position': `${-Math.round(tW * section.x / section.width)}px ${-Math.round(tH * section.y / section.height)}px`,
      'background-repeat': 'no-repeat',
    };
  }

  getSectionCardPreviewStyle(section: NewsSection): { [key: string]: string } {
    const imageUrl = this.selectedPage?.fullImageHiRes || this.selectedPage?.fullImage || '';
    if (!imageUrl || !section.width || !section.height) return { background: 'var(--color-bg-muted)' };
    const resolvedUrl = this.resolveImageUrl(imageUrl);
    const previewH = 180; // matches .section-preview height in CSS
    // Compute natural width from section aspect ratio to avoid any stretching
    const previewW = Math.round(previewH * (section.width / section.height));
    return {
      'background-image': `url(${resolvedUrl})`,
      'background-size': `${Math.round(previewW * 100 / section.width)}px ${Math.round(previewH * 100 / section.height)}px`,
      'background-position': `${-Math.round(previewW * section.x / section.width)}px ${-Math.round(previewH * section.y / section.height)}px`,
      'background-repeat': 'no-repeat',
    };
  }

  jumpToCropSection(section: NewsSection) {
    if (this.sectionForm.id && this.sectionForm.title) this.saveSection(false);
    this.isEditingSection = true;
    this.selectedSection = section;
    this.sectionForm = { ...section, id: this.normalizeSectionId(section.id) };
    this.imageSourceOption = !section.imageUrl || section.imageUrl.trim() === '' ? 'auto-crop' :
      section.imageUrl.startsWith('assets/cropped/') ? 'upload' : 'external-url';
    if (this.cropperImageRef?.nativeElement && (section.width ?? 0) > 0) {
      const img = this.cropperImageRef.nativeElement;
      const iw = img.clientWidth; const ih = img.clientHeight;
      this.cropperStartX = (section.x / 100) * iw;
      this.cropperStartY = (section.y / 100) * ih;
      this.cropperEndX = ((section.x + section.width) / 100) * iw;
      this.cropperEndY = ((section.y + section.height) / 100) * ih;
    } else {
      this.cropperStartX = this.cropperStartY = this.cropperEndX = this.cropperEndY = 0;
    }
    this.cropUndoStack = []; this.cropRedoStack = [];
    this.cdr.detectChanges();
  }

  deleteFromCropper(section: NewsSection) {
    if (!this.selectedPage) return;
    // Guard: don't allow deletion while another user holds the lock.
    if (this.isPageLockedByOther) {
      this.toaster.error(`${this.lockHeldByName} is currently editing this page. Deletion is disabled.`);
      return;
    }
    if (!confirm(`Delete section "${section.title}"?`)) return;

    // Capture identifiers before any state change.
    const delPageId  = this.selectedPage.id;
    const delDate    = this.selectedDate;
    const delEdition = this.selectedEditionNumber;

    this.dataService.deleteSection(delPageId, section.id, delDate, delEdition);
    this.markUnsavedChanges();
    const edition = this.dataService.getEditionByDateAndNumber(delDate, delEdition);
    if (edition) this.pages = edition.pages;
    this.selectedPage = this.pages.find(p => p.id === delPageId) ?? null;
    this.toaster.success('Section deleted.');
    this.cdr.detectChanges();

    // Atomic server delete — keeps server in sync without a full-blob overwrite.
    this.dataService.deleteSectionAtomically(delPageId, section.id, delDate, delEdition).subscribe({
      next: () => {
        // Reload from server on success to confirm the deletion persisted.
        this.dataService.reloadDate(delDate).subscribe({
          next: () => this.loadCurrentEdition(),
        });
      },
      error: () => {
        this.markUnsavedChanges();
        this.toaster.warning('Section deletion could not sync to server. Please try deleting again.');
      }
    });
  }

  /**
   * Mousedown on an existing-section overlay box.
   * - Lets Edit / Delete buttons handle their own clicks unobstructed.
   * - Forwards the event to the main crop handler ONLY when the pointer is
   *   on a resize handle or inside the current crop-box (move/resize intent).
   * - Swallows the event in all other cases, preventing a new draw from
   *   being started on top of a saved section.
   */
  onExistingSectionMouseDown(event: MouseEvent, section: NewsSection) {
    // Let the action buttons handle their own clicks
    if ((event.target as HTMLElement).closest('.section-box-actions')) return;
    event.preventDefault();
    if (!this.cropperImageRef?.nativeElement) return;
    // Convert viewport coords to stage layout coords (undo the CSS zoom transform)
    const imgRect = this.cropperImageRef.nativeElement.getBoundingClientRect();
    const zoom = this.cropperZoom || 1;
    const mx = (event.clientX - imgRect.left) / zoom;
    const my = (event.clientY - imgRect.top) / zoom;
    // Only allow move / resize of the active crop box — never start a new draw
    if (this.hasCropBox()) {
      const handle = this.getHandleAtPoint(mx, my);
      if (handle || this.isInsideCropBox(mx, my)) {
        this.onCropperMouseDown({ offsetX: mx, offsetY: my } as MouseEvent);
      }
    }
    // Otherwise: event is swallowed — drawing is blocked on this section area
  }

  @HostListener('document:keydown', ['$event'])
  onCropperKeyDown(event: KeyboardEvent) {
    if (!this.showImageCropper || !this.cropperImageRef?.nativeElement) return;
    const img = this.cropperImageRef.nativeElement;
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowLeft':  event.preventDefault(); this.moveCropBox(-step, 0, img.clientWidth, img.clientHeight); break;
      case 'ArrowRight': event.preventDefault(); this.moveCropBox(step, 0, img.clientWidth, img.clientHeight); break;
      case 'ArrowUp':    event.preventDefault(); this.moveCropBox(0, -step, img.clientWidth, img.clientHeight); break;
      case 'ArrowDown':  event.preventDefault(); this.moveCropBox(0, step, img.clientWidth, img.clientHeight); break;
      case 'z': case 'Z':
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); event.shiftKey ? this.redoCrop() : this.undoCrop(); }
        break;
      case 'Escape': this.closeCropper(); break;
    }
  }

  async generateAndUploadCroppedImageFromFullSize(fullImageUrl: string) {
    this.loader.show('Generating crop — please wait…');
    this.isSavingCrop = true;
    this.cdr.detectChanges();
    try {
      const fullImageHref = new URL(fullImageUrl, window.location.href).href;
      // Resolve relative URLs against the WP base so the proxy always receives an absolute URL
      const absoluteImageUrl = (() => {
        try { new URL(fullImageUrl); return fullImageUrl; } catch {
          return new URL(fullImageUrl, this.dataService.getApiBaseUrl() + '/').href;
        }
      })();
      // Normalize the image URL's origin to match the WP API origin.
      // epaper.dailysangram.com and nepaper.dailysangram.com are the same server;
      // rewriting ensures the proxy's host-allowlist check always passes.
      const wpApiOrigin = new URL(this.dataService.getApiBaseUrl()).origin;
      const proxyImageUrl = (() => {
        try {
          const p = new URL(absoluteImageUrl);
          return p.origin !== wpApiOrigin ? wpApiOrigin + p.pathname + p.search + p.hash : absoluteImageUrl;
        } catch { return absoluteImageUrl; }
      })();
      const proxyUrl = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/proxy?url=${encodeURIComponent(proxyImageUrl)}`;
      const fetchUrls = new URL(fullImageHref).origin === window.location.origin
        ? [fullImageHref, proxyUrl]
        : [proxyUrl];
      
      // Fetch the full-size image
      let response: Response | null = null;
      let lastFetchError = '';
      for (const imageUrl of fetchUrls) {
        response = await fetch(imageUrl);
        if (response.ok) break;
        lastFetchError = `${imageUrl === proxyUrl ? 'Proxy' : 'Image'} fetch failed (${response.status})`;
      }
      if (!response?.ok) {
        this.isSavingCrop = false;
        this.loader.hide();
        throw new Error(lastFetchError || 'Image fetch failed');
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        const text = await response.text();
        throw new Error(`Proxy returned ${contentType || 'unknown'}: ${text.slice(0, 200)}`);
      }
      const blob = await response.blob();
      
      // Create a new image from the blob
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      
      img.onload = async () => {
        try {
          
          // Create canvas
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          if (!ctx) {
            this.toaster.error('Failed to create crop canvas');
            this.isSavingCrop = false;
            this.loader.hide();
            URL.revokeObjectURL(objectUrl);
            return;
          }
          
          // Calculate actual pixel coordinates from percentages
          const cropX = Math.round(((this.sectionForm.x ?? 0) / 100) * img.naturalWidth);
          const cropY = Math.round(((this.sectionForm.y ?? 0) / 100) * img.naturalHeight);
          const cropWidth = Math.round(((this.sectionForm.width ?? 0) / 100) * img.naturalWidth);
          const cropHeight = Math.round(((this.sectionForm.height ?? 0) / 100) * img.naturalHeight);
          
          
          // Set canvas dimensions to the crop size
          canvas.width = cropWidth;
          canvas.height = cropHeight;
          
          // Draw the cropped portion from full-size image
          ctx.drawImage(
            img,
            cropX,
            cropY,
            cropWidth,
            cropHeight,
            0,
            0,
            cropWidth,
            cropHeight
          );
          
          // Convert to data URL using the admin-configured image format.
          const croppedImageData = canvas.toDataURL(this.imageMime, this.imageQuality);

          const fileName = this.buildSectionImageFilename(this.imageExt);

          // Upload to backend
          this.uploadCroppedImage(croppedImageData, fileName);
          
          // Clean up
          URL.revokeObjectURL(objectUrl);
        } catch (error) {
          console.error('Error in canvas operations:', error);
          this.toaster.error('Failed to process cropped image');
          this.isSavingCrop = false;
          this.loader.hide();
          URL.revokeObjectURL(objectUrl);
        }
      };
      
      img.onerror = () => {
        this.toaster.error('Failed to load full-size image for cropping');
        this.isSavingCrop = false;
        this.loader.hide();
        URL.revokeObjectURL(objectUrl);
      };
      
      img.src = objectUrl;
      
    } catch (error) {
      console.error('Error fetching full-size image:', error);
      this.toaster.error('Failed to fetch image: ' + (error instanceof Error ? error.message : 'Unknown error'));
      this.isSavingCrop = false;
      this.loader.hide();
    }
  }

  uploadCroppedImage(imageData: string, fileName: string) {
    const file = this.dataUrlToFile(imageData, fileName);
    const previousImageUrl = this.sectionForm.imageUrl || '';
    // loader already shown by generateAndUploadCroppedImageFromFullSize
    this.uploadMediaFile(file, fileName)
      .then((url) => {
        this.sectionForm = {
          ...this.sectionForm,
          imageUrl: url
        };
        this.imageSourceOption = 'external-url';
        // Close the cropper panel but stay in the section edit form.
        this.showImageCropper = false;
        this.cdr.detectChanges();
        // Persist the updated imageUrl to the in-memory store and backend
        // without closing the section form — the user stays on the edit page.
        this.saveSection(false);
        this.saveAllData();
        this.deletePreviousGeneratedPostCrop(previousImageUrl, url);
        this.toaster.success('Cropped image saved!');
      })
      .catch((error) => {
        console.error('Error uploading cropped image:', error);
        this.toaster.error('Failed to save cropped image. Using auto-crop instead.');
        this.sectionForm = {
          ...this.sectionForm,
          imageUrl: ''
        };
        this.imageSourceOption = 'auto-crop';
        this.cdr.detectChanges();
      })
      .finally(() => { this.isSavingCrop = false; this.loader.hide(); this.cdr.detectChanges(); });
  }

  onImageFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }

    const file = input.files[0];

    // Validate file type
    if (!file.type.startsWith('image/')) {
      this.toaster.error('Please select an image file');
      return;
    }

    // Validate file size (max 10MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      this.toaster.error('Image size must be less than 10MB');
      return;
    }

    // Legacy mode — upload the file as-is, preserving its original format.
    if (this.imageMime === 'image/jpeg') {
      const reader = new FileReader();
      reader.onload = () => {
        const imageData = reader.result as string;
        const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
        const fileName = this.buildSectionImageFilename(ext);
        this.uploadImageFile(imageData, fileName);
      };
      reader.onerror = () => this.toaster.error('Failed to read image file');
      reader.readAsDataURL(file);
      return;
    }

    // WebP mode — re-encode via Canvas before uploading.
    this.loader.show('Converting to WebP…');
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        this.loader.hide();
        this.toaster.error('Failed to convert image to WebP');
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = canvas.toDataURL('image/webp', this.imageQuality);
      const fileName = this.buildSectionImageFilename('webp');
      this.loader.hide();
      this.uploadImageFile(imageData, fileName);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      this.loader.hide();
      this.toaster.error('Failed to load image for conversion');
    };
    img.src = objectUrl;
  }

  uploadImageFile(imageData: string, fileName: string) {
    const file = this.dataUrlToFile(imageData, fileName);
    this.loader.show('Uploading image…');
    this.uploadMediaFile(file, fileName)
      .then((url) => {
        this.sectionForm = {
          ...this.sectionForm,
          imageUrl: url
        };
        this.cdr.detectChanges();
        this.toaster.success('Image uploaded successfully!');
      })
      .catch((error) => {
        console.error('Error uploading image:', error);
        this.toaster.error('Failed to upload image: ' + error.message);
      })
      .finally(() => this.loader.hide());
  }

  private dataUrlToFile(dataUrl: string, filename: string): File {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  /**
   * Applies the same WAF-bypass rules as wpApiInterceptor to a native fetch()
   * call so media uploads are not blocked by host-level security modules:
   *   1. URL rewrite  /wp-json/ → /?rest_route=/
   *   2. credentials: 'include'  (sends WAF verification cookies)
   *   3. X-Requested-With: XMLHttpRequest  (activates OWASP AJAX exemptions)
   */
  private wafBypassFetch(url: string, options: RequestInit = {}): Promise<Response> {
    let rewrittenUrl = url;
    if (url.includes('/wp-json/')) {
      const qIndex = url.indexOf('?');
      const path   = qIndex !== -1 ? url.substring(0, qIndex) : url;
      const qs     = qIndex !== -1 ? url.substring(qIndex + 1) : '';
      const base   = path.replace('/wp-json/', '/?rest_route=/');
      rewrittenUrl = qs ? `${base}&${qs}` : base;
    }
    const existingHeaders = (options.headers ?? {}) as Record<string, string>;
    return fetch(rewrittenUrl, {
      ...options,
      headers: { ...existingHeaders, 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
  }

  private async uploadMediaFile(file: File, filename: string): Promise<string> {
    const url = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/media`;
    const headers = this.authService.getAuthHeaders();
    const desiredName = this.normalizeFilename(filename);
    let finalName = desiredName;

    const existing = await this.findExistingMedia(desiredName, headers);
    if (existing) {
      const overwrite = confirm(
        `An image named "${desiredName}" already exists.\n\nClick OK to overwrite it, or Cancel to upload with a new name.`
      );
      if (overwrite) {
        await this.deleteMedia(existing.id, headers);
        finalName = desiredName;
      } else {
        finalName = this.appendTimestamp(desiredName);
      }
    }

    const formData = new FormData();
    formData.append('file', file, finalName);

    const response = await this.wafBypassFetch(url, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Upload failed');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = await response.text();
      throw new Error(
        `Upload endpoint returned non-JSON (HTTP ${response.status}). ` +
        `Check that WordPress REST API and permalinks are configured correctly. ` +
        `Response: ${bodyPreview.slice(0, 150)}`
      );
    }

    const data = await response.json();
    return data.source_url || data.guid?.rendered || '';
  }

  /** Convert YYYY-MM-DD → DD-MM-YYYY for use in media filenames. */
  private formatDateForFilename(dateStr: string): string {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  private buildPageImageFilename(ext: string, variant: 'full' | 'hires' | 'thumb' = 'full'): string {
    const pageNumber = this.pad2(this.pageForm.id || this.dataService.getNextPageId(this.selectedDate, this.selectedEditionNumber));
    const editionNumber = this.pad2(this.selectedEditionNumber || 1);
    const date = this.formatDateForFilename(this.selectedDate || this.dataService.getTodayDate());
    const suffix = variant === 'full' ? '' : `-${variant}`;
    return `page-${pageNumber}-e-${editionNumber}-${date}${suffix}.${this.cleanExtension(ext)}`;
  }

  private buildSectionImageFilename(ext: string): string {
    const pageNumber = this.pad2(this.selectedPage?.id || this.pageForm.id || 1);
    const editionNumber = this.pad2(this.selectedEditionNumber || 1);
    const postId = this.formatSectionIdForFilename(this.sectionForm.id || 'unknown');
    const date = this.formatDateForFilename(this.selectedDate || this.dataService.getTodayDate());
    const x = this.formatCoordinate(this.sectionForm.x ?? 0);
    const y = this.formatCoordinate(this.sectionForm.y ?? 0);
    const w = this.formatCoordinate(this.sectionForm.width ?? 0);
    const h = this.formatCoordinate(this.sectionForm.height ?? 0);
    return `page-${pageNumber}-e-${editionNumber}-${date}-post-${postId}-${x}-${y}-${w}-${h}.${this.cleanExtension(ext)}`;
  }

  private pad2(value: number | string): string {
    const numericValue = typeof value === 'number' ? value : Number.parseInt(value, 10);
    return Number.isFinite(numericValue) ? String(numericValue).padStart(2, '0') : String(value).padStart(2, '0');
  }

  private formatSectionIdForFilename(sectionId: string): string {
    const trailingNumber = sectionId.match(/(\d+)$/)?.[1];
    if (trailingNumber) return this.pad2(trailingNumber);
    return sectionId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  }

  private formatCoordinate(value: number): string {
    return Number(value || 0).toFixed(4);
  }

  private cleanExtension(ext: string): string {
    const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean || 'jpg';
  }

  /**
   * Query existing media to find the highest 4-digit crop sequence for a given
   * date prefix (DD_MM_YYYY), then return max + 1.  Falls back to 1 on error.
   */
  private async getNextCropSequence(
    datePrefix: string,
    headers: Record<string, string>
  ): Promise<number> {
    const searchUrl =
      `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/media` +
      `?search=${encodeURIComponent(datePrefix)}&per_page=100`;
    try {
      const response = await this.wafBypassFetch(searchUrl, { headers });
      if (!response.ok) return 1;
      const items: any[] = await response.json();
      if (!Array.isArray(items) || items.length === 0) return 1;
      // Match titles/slugs like "21_05_2026_0003_section-123"
      const pattern = new RegExp('^' + datePrefix + '_(\\d{4})_');
      let max = 0;
      for (const item of items) {
        const title = ((item.title?.rendered ?? item.slug) ?? '').toLowerCase();
        const match = title.match(pattern);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) max = num;
        }
      }
      return max + 1;
    } catch {
      return 1;
    }
  }

  private normalizeFilename(filename: string): string {
    const clean = filename.replace(/\s+/g, '_');
    return clean.length ? clean : `image_${Date.now()}.jpg`;
  }

  private appendTimestamp(filename: string): string {
    const parts = filename.split('.');
    if (parts.length === 1) {
      return `${filename}_${Date.now()}`;
    }
    const ext = parts.pop();
    const base = parts.join('.');
    return `${base}_${Date.now()}.${ext}`;
  }

  private async findExistingMedia(filename: string, headers: Record<string, string>): Promise<{ id: number } | null> {
    const base = filename.replace(/\.[^/.]+$/, '').toLowerCase();
    const searchUrl = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/media?search=${encodeURIComponent(base)}&per_page=100`;
    const response = await this.wafBypassFetch(searchUrl, { headers });
    if (!response.ok) return null;
    const items = await response.json();
    const match = Array.isArray(items)
      ? items.find((item: any) => {
          const title = (item.title?.rendered || '').toLowerCase();
          const slug = (item.slug || '').toLowerCase();
          return title === base || slug === base || `${slug}` === base;
        })
      : null;
    return match ? { id: match.id } : null;
  }

  private async deleteMedia(id: number, headers: Record<string, string>): Promise<void> {
    const deleteUrl = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/media/${id}`;
    const response = await this.wafBypassFetch(deleteUrl, { method: 'DELETE', headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to delete existing media');
    }
  }

  private deletePreviousGeneratedPostCrop(previousUrl: string, newUrl: string): void {
    if (!previousUrl || previousUrl === newUrl || !this.isGeneratedPostCropUrl(previousUrl)) {
      return;
    }

    const previousFilename = decodeURIComponent(previousUrl.split('/').pop() || '');
    if (!previousFilename) {
      return;
    }

    const headers = this.authService.getAuthHeaders();
    this.findExistingMedia(previousFilename, headers)
      .then((existing) => existing ? this.deleteMedia(existing.id, headers) : undefined)
      .catch((error) => {
        console.warn('Previous cropped post image could not be deleted:', error);
      });
  }

  getSectionCropPreviewStyle(): { [key: string]: string } {
    const x = this.sectionForm.x ?? 0;
    const y = this.sectionForm.y ?? 0;
    const w = this.sectionForm.width ?? 0;
    const h = this.sectionForm.height ?? 0;
    const imageUrl = this.selectedPage?.fullImageHiRes || this.selectedPage?.fullImage || '';
    if (!w || !h || !imageUrl) return {};

    const previewW = 108; // must match .section-crop-preview width in CSS
    const previewH = 135; // must match .section-crop-preview height in CSS

    return {
      'background-image': `url(${this.resolveImageUrl(imageUrl)})`,
      'background-size': `${Math.round(previewW * 100 / w)}px ${Math.round(previewH * 100 / h)}px`,
      'background-position': `${-Math.round(previewW * x / w)}px ${-Math.round(previewH * y / h)}px`,
      'background-repeat': 'no-repeat',
    };
  }

  getCropStyle() {
    if (!this.cropperImageRef) {
      return { left: '0px', top: '0px', width: '0px', height: '0px' };
    }
    
    const x1 = Math.min(this.cropperStartX, this.cropperEndX);
    const y1 = Math.min(this.cropperStartY, this.cropperEndY);
    const width = Math.abs(this.cropperEndX - this.cropperStartX);
    const height = Math.abs(this.cropperEndY - this.cropperStartY);
    
    const style = {
      left: `${x1}px`,
      top: `${y1}px`,
      width: `${width}px`,
      height: `${height}px`
    };
    
    
    return style;
  }

  applyCrop() {
    if (this.hasCropBox() && this.cropperImageRef && this.selectedPage) {
      this.activityLog.track('cropper_apply', { pageId: String(this.selectedPage.id), sectionId: this.sectionForm.id ?? '' });
      this.calculateCropCoordinates();

      if (this.shouldGenerateCroppedPostImage()) {
        // Prefer the original hi-res image as the crop source so section crops
        // retain full quality even though fullImage is now served at 700px.
        const fullImageUrl = this.selectedPage.fullImageHiRes || this.selectedPage.fullImage;
        this.generateAndUploadCroppedImageFromFullSize(fullImageUrl);
      } else {
        this.toaster.success('Crop coordinates set!');
      }
    }
    this.closeCropper();
  }

  private shouldGenerateCroppedPostImage(): boolean {
    const imageUrl = this.sectionForm.imageUrl || '';
    return this.imageSourceOption === 'auto-crop'
      || this.isGeneratedPostCropUrl(imageUrl);
  }

  private isGeneratedPostCropUrl(url: string): boolean {
    const filename = decodeURIComponent(url.split('/').pop() || '').toLowerCase();
    return /^page-\d{1,2}-e-\d{1,2}-\d{1,2}-\d{1,2}-\d{4}-post-/.test(filename);
  }

  closeCropper() {
    this.showImageCropper = false;
    this.cropperStartX = 0; this.cropperStartY = 0;
    this.cropperEndX = 0; this.cropperEndY = 0;
    this.cropMode = 'idle';
    this.activeResizeHandle = null;
    this.cropUndoStack = []; this.cropRedoStack = [];
    this.cropperCursor = 'crosshair';
  }

  // Data Management
  // ─── Conflict modal state ────────────────────────────────────────
  showConflictModal = false;
  conflictLastSavedBy = '';
  /** True when the 409 was triggered by a stale version from the current user's
   *  own previous save (e.g. WAF blocked the success response), not by a
   *  genuine concurrent edit from a different user. */
  conflictIsSelf = false;
  private conflictPendingData: any = null;

  saveAllData() {
    if (this.hasUnsavedSettingsChanges) {
      this.commitSettingsFormToData();
    }

    if (!this.hasUnsavedChanges) {
      this.toaster.info('No changes to save.');
      return;
    }

    const currentData = this.dataService.getData();

    if (!currentData.editions || currentData.editions.length === 0) {
      this.toaster.warning('No data to save');
      return;
    }

    this.persistAllData(currentData);
  }

  private persistAllData(currentData: any, opts: { forceVersionOverwrite?: boolean } = {}) {
    this.dataService.saveData(currentData, {
      forceVersionOverwrite: opts.forceVersionOverwrite,
    }).subscribe({
      next: () => {
        this.markSaved();
        this.toaster.success('All data saved successfully!');
        if (this.selectedPage) {
          this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
        }
      },
      error: (error) => {
        // ── Concurrent-edit conflict (version mismatch) ───────────────
        if (error?.status === 409) {
          const body = error?.error ?? {};
          if (body.conflictType === 'version-mismatch') {
            const lastSavedBy: string = body.lastSavedBy || '';
            const myName: string = this.authService.getUserDisplayName();
            // Self-conflict: the previous save reached the server but its
            // response was blocked (e.g. by Imunify360 WAF), so the server
            // advanced its dataVersion while Angular kept the old one.
            // Force-save is safe here — there is no concurrent editor.
            if (myName && lastSavedBy === myName) {
              this.toaster.info('Version out-of-sync — retrying save automatically…');
              this.persistAllData(currentData, { forceVersionOverwrite: true });
              return;
            }
            this.conflictLastSavedBy = lastSavedBy || 'another user';
            this.conflictIsSelf = false;
            this.conflictPendingData = currentData;
            this.showConflictModal = true;
            this.cdr.detectChanges();
            return;
          }
          // empty-overwrite guard from the server
          if (body.conflictType === 'empty-overwrite') {
            this.toaster.error(
              'Save rejected: your current view has no pages. Reload the admin panel before saving again.'
            );
            return;
          }
          // shrinking-overwrite guard — client has fewer dates than the server
          // (common when granular per-date loading only hydrated recent dates).
          if (body.conflictType === 'shrinking-overwrite') {
            const missing: number = (body.currentDateCount ?? 0) - (body.incomingDateCount ?? 0);
            this.toaster.error(
              `Save rejected: your current view is missing ${missing} historical date(s) that exist on the server. ` +
              `Use the atomic Save buttons on each page/section instead of Save All. ` +
              `If you need to force-save, use the Admin → Rebuild from Sections action first.`
            );
            return;
          }
        }

        if (this.isRecoveredDataSaveBlocked(error)) {
          const proceed = confirm(
            'This data was rebuilt temporarily from WordPress Media Library and may not include your cropped sections/content.\n\n' +
            'Only continue if you intentionally want to save this recovered/rebuilt dataset as the new canonical newspaper data.\n\n' +
            'Click OK to save anyway, or Cancel to stop and restore a backup first.'
          );
          if (proceed) {
            this.persistRecoveredData(currentData);
          }
          return;
        }

        const errMsg: string = error?.message ?? '';

        // WAF blocks can arrive two ways:
        //   (a) HTTP 200 + JSON body → assertSaveAccepted() throws WAF_BLOCKED:…
        //       → errMsg starts with 'WAF_BLOCKED:'
        //   (b) HTTP 500 + JSON/HTML body → HttpErrorResponse, body parsed below
        const responseBody = error?.error ?? {};
        const bodyText: string =
          typeof responseBody === 'object' && responseBody !== null
            ? String((responseBody as any)?.message ?? (responseBody as any)?.error ?? '')
            : (typeof responseBody === 'string' ? responseBody : '');
        const isWafBlock =
          errMsg.startsWith('WAF_BLOCKED:') ||
          (!!bodyText && AuthService.isWafBlockMessage(bodyText));

        if (isWafBlock) {
          const detail = errMsg.startsWith('WAF_BLOCKED:')
            ? errMsg.replace('WAF_BLOCKED:', '').trim()
            : bodyText;
          this.toaster.error(
            `Save was blocked by the server's security module. ` +
            `To fix: log out and log back in (this sets a session cookie Imunify360 trusts), ` +
            `or whitelist /wp-json/digital-newspaper/v1/ in your hosting security settings. (${detail})`
          );
        } else if ((error?.status ?? -1) === 0) {
          this.toaster.error(
            'Save failed: The WordPress server could not be reached. ' +
            'Check that your server is online and CORS settings allow this app.'
          );
        } else {
          this.toaster.error(errMsg || 'Failed to save data');
        }
      }
    });
  }

  /** User chose to reload the latest server data, discarding their local changes. */
  resolveConflictByReloading(): void {
    this.showConflictModal = false;
    this.conflictPendingData = null;
    this.conflictLastSavedBy = '';
    this.conflictIsSelf = false;
    this.toaster.info('Reloading latest data from server…');
    this.loadData();
  }

  /** Admin/power-user chose to force-save their local version over the server's. */
  resolveConflictByForcing(): void {
    const data = this.conflictPendingData;
    this.showConflictModal = false;
    this.conflictPendingData = null;
    this.conflictLastSavedBy = '';
    this.conflictIsSelf = false;
    if (data) {
      this.toaster.warning('Force-saving your version…');
      this.persistAllData(data, { forceVersionOverwrite: true });
    }
  }

  dismissConflictModal(): void {
    this.showConflictModal = false;
    this.conflictPendingData = null;
    this.conflictLastSavedBy = '';
    this.conflictIsSelf = false;
    this.toaster.warning('Your changes are still pending — save again or reload.');
  }

  private persistRecoveredData(currentData: any) {
    this.toaster.warning('Saving recovered data by explicit confirmation…');
    this.dataService.saveData(currentData, { allowRecoveredData: true }).subscribe({
      next: () => {
        this.markSaved();
        this.toaster.success('Recovered data saved successfully!');
        if (this.selectedPage) {
          this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
        }
      },
      error: (error) => {
        this.toaster.error(error.message || 'Failed to save recovered data');
      }
    });
  }

  private isRecoveredDataSaveBlocked(error: any): boolean {
    const message = error?.message || error?.error?.message || String(error || '');
    return message.includes('temporarily recovered from WordPress Media Library');
  }

  // ─── Export ──────────────────────────────────────────────────────

  downloadJSON() {
    this.openExportModal();
  }

  openExportModal() {
    this.exportOptions = {
      exportType: 'full',
      exportScope: 'full',
      currentDate: this.selectedDate,
    };
    this.showExportModal = true;
  }

  closeExportModal() {
    this.showExportModal = false;
  }

  confirmExport() {
    const opts: ExportOptions = { ...this.exportOptions, currentDate: this.selectedDate };

    // COMPLETENESS FIX: For full or editions-only exports, use the server-side
    // /data/export-full endpoint.  It reads directly from authoritative per-date
    // options (dn_edition_YYYY-MM-DD) so EVERY date is included — not just the
    // 1-2 dates hydrated into browser memory at load time.  Atomic saves
    // (PUT /data/page, PUT /data/section) write ONLY to per-date options and
    // never update the in-memory Angular state or the legacy dn_data blob, so
    // client-side export would silently miss any edits made via those endpoints.
    //
    // Settings-only, current-date, and date-range exports continue to use the
    // in-memory path because the data needed is already loaded.
    if (opts.exportType !== 'settings-only' && opts.exportScope === 'full') {
      this.loader.show('Downloading full backup from server…');
      this.dataService.downloadExportFull().subscribe({
        next: ({ filename }) => {
          this.loader.hide();
          this.toaster.success(`Full backup downloaded: ${filename}`);
          this.backupHistory = this.dataService.getBackupHistory();
          this.showExportModal = false;
          this.activityLog.logClientEvent('export_download', { filename, source: 'server-granular' });
        },
        error: (err: any) => {
          this.loader.hide();
          console.error('Server export-full failed:', err);
          // Fall back to in-memory export with a warning about potential incompleteness.
          this.toaster.warning(
            'Server export unavailable — falling back to browser-cached data. '
            + 'This may miss editions not loaded into memory. Error: '
            + (err?.message || 'Unknown')
          );
          const { filename } = this.dataService.downloadExport(opts);
          this.backupHistory = this.dataService.getBackupHistory();
          this.showExportModal = false;
          this.activityLog.logClientEvent('export_download', { filename, source: 'client-fallback' });
        },
      });
      return;
    }

    // Settings-only / current-date / date-range: in-memory path is sufficient.
    const { filename } = this.dataService.downloadExport(opts);
    this.toaster.success(`Exported: ${filename}`);
    this.backupHistory = this.dataService.getBackupHistory();
    this.showExportModal = false;
    this.activityLog.logClientEvent('export_download', { filename });
  }

  // ─── Import ──────────────────────────────────────────────────────

  importBackup(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;

    const file = input.files[0];
    input.value = ''; // reset so the same file can be re-selected

    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      this.toaster.error('Please select a valid .json backup file');
      return;
    }

    // Give immediate feedback — large backup files can take a moment to read
    this.loader.show('Reading backup file…');

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // BANGLA SAFETY: explicitly request UTF-8 decoding (same encoding the
        // server used when writing the file).  Also strip the UTF-8 BOM
        // (\uFEFF) — some editors/OS tools prepend it when saving UTF-8 files,
        // which causes JSON.parse() to throw "Unexpected token \uFEFF" even
        // though the rest of the file is valid JSON.
        const raw = ((e.target?.result as string) ?? '').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        const validation = this.dataService.validateImportPayload(parsed);
        const preview = validation.valid ? this.dataService.buildImportPreview(parsed) : null;

        this.importParsed = parsed;
        this.importValidation = validation;
        this.importPreview = preview;

        this.importOptions = {
          importSettings: preview ? preview.hasSettings : false,
          importEditions: preview ? preview.hasEditions : false,
          mergeMode: 'overwrite-all',
          rewriteUrls: preview ? preview.urlMismatch : false,
          oldBaseUrl: preview?.sourceUrl ?? '',
          newBaseUrl: preview?.currentUrl ?? '',
        };

        this.loader.hide();
        this.showImportPreviewModal = true;
        this.cdr.detectChanges();
      } catch {
        this.loader.hide();
        this.toaster.error('Failed to parse JSON file. Make sure it is a valid backup.');
      }
    };
    reader.onerror = () => {
      this.loader.hide();
      this.toaster.error('Failed to read the backup file.');
    };
    // BANGLA SAFETY: explicit UTF-8 encoding prevents the browser from
    // guessing a single-byte charset for files without a BOM, which would
    // corrupt multi-byte Bangla codepoints before JSON.parse() even runs.
    reader.readAsText(file, 'utf-8');
  }

  closeImportModal() {
    this.showImportPreviewModal = false;
    this.importParsed = null;
    this.importValidation = null;
    this.importPreview = null;
    this.isImporting = false;
  }

  confirmImport() {
    if (!this.importParsed || !this.importValidation?.valid) return;
    this.isImporting = true;
    this.loader.show('Importing backup — please wait…');

    // Auto-backup current data before overwriting
    this.dataService.downloadExport({ exportType: 'full', exportScope: 'full' });
    this.toaster.info('Auto-backup downloaded. Starting import…');

    const mergedData = this.dataService.applyImport(this.importParsed, this.importOptions);

    // SAFETY: always pass forceEmptyOverwrite=true for user-initiated imports.
    // The server's shrinking-overwrite guard exists to protect against
    // ACCIDENTAL data truncation (e.g. a buggy save that sends fewer editions
    // than are on the server).  An explicit import where the user has already
    // seen the preview and clicked "Confirm Import" is intentional — blocking
    // it with a 409 is the wrong behaviour and gives a confusing error.
    // The pre-import auto-backup above ensures the user can recover if they
    // chose the wrong file.
    this.dataService.saveData(mergedData, { forceEmptyOverwrite: true }).subscribe({
      next: () => {
        this.isImporting = false;
        this.loader.hide();
        this.toaster.success('Backup imported successfully!');
        this.backupHistory = this.dataService.getBackupHistory();
        this.markSaved();
        this.closeImportModal();

        // Re-fetch from server so in-memory state matches what was persisted,
        // then navigate to the most-recent date in the imported data so the
        // user immediately sees the imported content instead of an empty
        // "today" edition that would otherwise be auto-created.
        this.dataService.loadData().subscribe({
          next: () => {
            this.availableDates = this.dataService.getAllEditionDates();
            if (this.availableDates.length > 0) {
              this.selectedDate = this.availableDates[0]; // most recent imported date
            } else if (!this.availableDates.includes(this.selectedDate)) {
              this.availableDates.unshift(this.selectedDate);
            }
            this.selectedEditionNumber = 1;
            this.loadCurrentEdition();
            this.loadSettings();
            this.cdr.detectChanges();
          },
          error: (err) => console.error('Error reloading after import:', err)
        });
      },
      error: (err: any) => {
        this.isImporting = false;
        this.loader.hide();
        console.error('Import failed:', err);
        // Extract the most useful error message: prefer the server's 'error'
        // or 'message' field (from the REST response body) over the generic
        // Angular HttpErrorResponse message.
        const serverMsg = err?.error?.error || err?.error?.message || err?.message || 'Unknown error';
        this.toaster.error('Import failed: ' + serverMsg);
      }
    });
  }

  rebuildFromSectionPosts() {
    const proceed = confirm(
      'This will rebuild the main newspaper JSON from mirrored WordPress section posts.\n\n' +
      'A server-side snapshot of the current JSON will be kept before replacement. Continue?'
    );
    if (!proceed) return;

    this.loader.show('Rebuilding data — this may take a moment…');
    this.dataService.rebuildDataFromSectionPosts().subscribe({
      next: (result) => {
        this.toaster.success(
          `Rebuilt ${result.editionCount} edition(s), ${result.pageCount} page(s), ${result.sectionCount} section(s).`
        );
        this.dataService.loadData().subscribe({
          next: () => {
            this.availableDates = this.dataService.getAllEditionDates();
            if (this.availableDates.length > 0) {
              this.selectedDate = this.availableDates[0];
            }
            this.loadCurrentEdition();
            this.loader.hide();
            this.markSaved();
            this.cdr.detectChanges();
          },
          error: (error) => {
            this.loader.hide();
            console.error('Error reloading rebuilt data:', error);
            this.toaster.error('Rebuild succeeded, but reloading data failed. Please refresh.');
          }
        });
      },
      error: (error) => {
        this.loader.hide();
        console.error('Error rebuilding from section posts:', error);
        this.toaster.error(error?.error?.error || error?.message || 'Failed to rebuild from section posts');
      }
    });
  }

  // ─── Backup History ─────────────────────────────────────────────────

  clearBackupHistory() {
    this.dataService.clearBackupHistory();
    this.backupHistory = [];
    this.toaster.success('Backup history cleared.');
  }

  reExport(entry: BackupHistoryEntry) {
    const opts: ExportOptions = {
      exportType: entry.exportType,
      exportScope: entry.exportScope,
      currentDate: this.selectedDate,
    };
    const { filename } = this.dataService.downloadExport(opts);
    this.toaster.success(`Re-exported: ${filename}`);
    this.backupHistory = this.dataService.getBackupHistory();
  }

  formatExportDate(dateStr: string): string {
    if (!dateStr || dateStr === 'Unknown') return 'Unknown';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  }

  // Navigation
  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.isSavingCrop) {
      event.preventDefault();
    }
    // Best-effort lock release on tab close
    if (this.heldLockResource) {
      this.lockService.releaseOnUnload(this.heldLockResource);
    }
  }

  goToViewer() {
    if (this.isSavingCrop) {
      this.toaster.warning('Please wait — the cropped image is still being saved.');
      return;
    }
    this.router.navigate(['/']);
  }

  goToViewerNewWindow(): void {
    window.open('/', '_blank');
  }

  // ── Vintage header: menu state & navigation ───────────────────────────

  toggleMenu(): void {
    this.isMenuOpen = !this.isMenuOpen;
  }

  closeMenu(): void {
    this.isMenuOpen = false;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isMenuOpen) return;
    if (this.vintageMenuPanelRef &&
        !this.vintageMenuPanelRef.nativeElement.contains(event.target as Node)) {
      this.isMenuOpen = false;
    }
  }

  // ─── Vintage theme navigation ────────────────────────────────────

  vintageSelectPage(page: NewspaperPage): void {
    this.selectedPage = page;
    this.vintageView = 'sections';
    this.vintageSelectedSection = null;
    this.acquirePageLock(page.id);
  }

  vintageSelectSection(section: NewsSection): void {
    if (this.isPageLockedByOther) {
      // Page is locked — stay on the sections grid and inform the user.
      // Do NOT navigate to section-detail (which could be confused with editing).
      this.toaster.info(`🔒 ${this.lockHeldByName} is editing this page. Viewing only.`);
      return;
    }
    this.vintageSelectedSection = section;
    // Keep vintageView as 'sections' so Cancel returns to the post list
    this.editSection(section);
  }

  vintageBackToPages(): void {
    // Auto-save any in-progress section edit before leaving the page.
    if (this.isEditingSection && this.sectionForm.id && this.sectionForm.title) {
      this.saveSection(false);
    }
    // Release the lock for the page we're leaving before going back to the
    // pages grid. Without this, the lock lingers and the next DELETE (from
    // cancelPageEdit) fires while autoSaveForVintage is about to run,
    // causing the loader guard to skip the auto-save.
    this.releaseCurrentLock();
    this.selectedPage = null;
    this.vintageSelectedSection = null;
    this.vintageView = 'pages';
    this.isEditingPage = false;
    this.isEditingSection = false;
  }

  vintageBackToSections(): void {
    if (this.isEditingSection && this.sectionForm.id && this.sectionForm.title) {
      this.saveSection(false);
    }
    this.vintageSelectedSection = null;
    this.vintageView = 'sections';
    this.isEditingSection = false;
  }

  getCurrentEditionLabel(): string {
    const ed = this.editionsForDate.find(e => (e.edition || 1) === this.selectedEditionNumber);
    return ed ? this.getEditionLabel(ed) : '';
  }

  // ─── Menu navigation ─────────────────────────────────────────────

  menuGoToPages(): void {
    this.activeMainTab = 'content';
    this.activeTab = 'pages';
    // Auto-save in-progress edits BEFORE clearing state (vintage theme).
    // The vintage breadcrumbs are hidden during editing, so the header menu
    // is the only exit path — state must be read here, before being cleared.
    if (this.adminTheme === 'vintage') {
      if (this.isEditingSection && this.sectionForm.id && this.sectionForm.title) {
        this.saveSection(false);
      } else if (
        this.isEditingPage &&
        this.pageForm.fullImage &&
        (this.pageForm.pageLabels?.['en']?.trim() || this.pageForm.pageLabels?.['bn']?.trim())
      ) {
        this.savePage(); // savePage() calls cancelPageEdit() → sets isEditingPage = false
      }
    }
    this.isEditingPage = false;
    this.isEditingSection = false;
    if (this.adminTheme === 'vintage') {
      this.vintageBackToPages();
    }
    this.closeMenu();
  }

  menuAddNewPage(): void {
    this.activeMainTab = 'content';
    this.closeMenu();
    this.newPage();
  }

  menuGoToEditions(): void {
    this.activeMainTab = 'content';
    if (this.adminTheme === 'vintage') {
      this.vintageView = 'editions';
      this.isEditingPage = false;
      this.isEditingSection = false;
    }
    this.closeMenu();
  }

  menuAddNewEdition(): void {
    this.createNewEdition();
    this.closeMenu();
  }

  deleteEditionEntry(ed: NewspaperEdition): void {
    const label = this.getEditionLabel(ed);
    if (!confirm(`Delete edition "${label}" for ${this.formatDisplayDate(this.selectedDate)}? This will permanently remove all pages and content in this edition.`)) return;
    const data = this.dataService.getData();
    const targetNum = ed.edition || 1;
    const updatedEditions = data.editions.filter(e => !(e.date === this.selectedDate && (e.edition || 1) === targetNum));
    this.dataService.updateEditions(updatedEditions);
    this.markUnsavedChanges();
    // If the deleted edition was selected, switch to edition 1
    if (this.selectedEditionNumber === targetNum) {
      this.selectedEditionNumber = 1;
    }
    if (this.adminTheme !== 'vintage') {
      this.loadCurrentEdition();
      this.toaster.success(`Edition "${label}" deleted.`);
      return;
    }

    this.syncCurrentDateStructure(
      'Deleting edition and syncing...',
      `Edition "${label}" deleted.`
    );
  }

  private autoSaveForVintage(): void {
    // Only auto-save when using the vintage theme (which has no explicit Save
    // button in its main flow) and only when there are actual unsaved changes.
    // Skip if a save is already in-flight (loader active) — that would cause
    // the outgoing stale payload to race against the in-flight one and could
    // overwrite newly-saved data from another user.
    if (this.adminTheme !== 'vintage') return;
    if (!this.hasUnsavedChanges) return;
    if (this.loader.isSaving) return;

    // Use the targeted editions-for-date atomic endpoint instead of a full
    // POST /data save.  The full save sends only the 1-2 dates held in
    // memory (granular loading only hydrates recent dates) and is blocked by
    // the server's shrinking-overwrite guard on any site with >5 historical
    // dates.  The atomic endpoint writes ONLY the current date's edition
    // array — no blob write, no shrinking-overwrite check.
    this.dataService.saveEditionsForDateAtomically(this.selectedDate).subscribe({
      next: () => {
        this.markSaved();
      },
      error: (err: any) => {
        // Atomic endpoint unavailable (old server without the new route) —
        // fall back to the full save so older deployments keep working.
        const status = err?.status;
        if (status === 404 || status === 405) {
          this.saveAllData();
          return;
        }
        // Any other error: mark unsaved so the user knows to retry.
        this.markUnsavedChanges();
        const msg = err?.error?.message || err?.message || `HTTP ${status}`;
        this.toaster.warning(`Auto-save failed: ${msg}. Changes are in memory — click Save All to retry.`);
      }
    });
  }

  menuGoToDates(): void {
    this.activeMainTab = 'content';
    this.closeMenu();
  }

  menuAddNewDate(): void {
    this.createNewDate();
    this.closeMenu();
  }

  menuGoToSettings(): void {
    this.activeMainTab = 'settings';
    this.closeMenu();
  }

  menuGoToActivityLog(): void {
    this.activeMainTab = 'logs';
    this.loadActivityLog();
    this.closeMenu();
  }

  menuExportBackup(): void {
    this.openExportModal();
    this.closeMenu();
  }

  menuImportBackup(): void {
    this.importFileInputRef?.nativeElement.click();
    this.closeMenu();
  }

  menuRebuildFromPosts(): void {
    this.rebuildFromSectionPosts();
    this.closeMenu();
  }

  // Linked Sections Helper

  /**
   * Keeps linked sections in sync bidirectionally AND returns the sections
   * that were changed so they can be atomically persisted to the server.
   *
   * Reads the pre-mutation state before calling updateSection(), ensuring
   * the returned list correctly reflects only the sections that actually changed.
   *
   * When section A links to B: B is automatically updated to link back to A.
   * When section A removes a link to B: B's back-link to A is also removed.
   */
  private syncBidirectionalLinks(
    currentSectionId: string,
    currentLinkedIds: string[],
    linkedSectionPrimary: string | undefined
  ): Array<{ pageId: number; section: NewsSection }> {
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (!edition) return [];

    const sectionsToSave: Array<{ pageId: number; section: NewsSection }> = [];

    edition.pages.forEach(page => {
      page.sections.forEach(otherSection => {
        if (otherSection.id === currentSectionId) return;

        // Read pre-mutation state BEFORE calling updateSection()
        const shouldBeLinked  = currentLinkedIds.includes(otherSection.id);
        const isAlreadyLinked = otherSection.linkedSectionIds?.includes(currentSectionId) ?? false;

        if (shouldBeLinked && !isAlreadyLinked) {
          // Add back-link AND propagate the agreed primary for the whole group.
          const updated: NewsSection = {
            ...otherSection,
            linkedSectionIds: [...(otherSection.linkedSectionIds || []), currentSectionId],
            linkedSectionPrimary,
          };
          this.dataService.updateSection(page.id, otherSection.id, updated, this.selectedDate, this.selectedEditionNumber);
          sectionsToSave.push({ pageId: page.id, section: updated });
        } else if (!shouldBeLinked && isAlreadyLinked) {
          // Remove back-link. If the section's primary pointer referred to the section
          // now being unlinked, clear it so there is no dangling reference.
          const updatedPrimary =
            otherSection.linkedSectionPrimary === currentSectionId
              ? undefined
              : otherSection.linkedSectionPrimary;
          const updated: NewsSection = {
            ...otherSection,
            linkedSectionIds: (otherSection.linkedSectionIds || []).filter(id => id !== currentSectionId),
            linkedSectionPrimary: updatedPrimary,
          };
          this.dataService.updateSection(page.id, otherSection.id, updated, this.selectedDate, this.selectedEditionNumber);
          sectionsToSave.push({ pageId: page.id, section: updated });
        } else if (shouldBeLinked && isAlreadyLinked && otherSection.linkedSectionPrimary !== linkedSectionPrimary) {
          // Already linked but the primary designation has drifted — resync it.
          const updated: NewsSection = { ...otherSection, linkedSectionPrimary };
          this.dataService.updateSection(page.id, otherSection.id, updated, this.selectedDate, this.selectedEditionNumber);
          sectionsToSave.push({ pageId: page.id, section: updated });
        }
      });
    });

    return sectionsToSave;
  }
  getAvailableSections(): NewsSection[] {
    const sections: NewsSection[] = [];
    this.pages.forEach(page => {
      page.sections.forEach(section => {
        if (section.id !== this.sectionForm.id) {
          sections.push(section);
        }
      });
    });
    // Sort by page index (sequential: 1, 2, 3…) then by section order within page
    sections.sort((a, b) => {
      const pageIndexA = this.pages.findIndex(p => p.id === a.pageId);
      const pageIndexB = this.pages.findIndex(p => p.id === b.pageId);
      return pageIndexA - pageIndexB;
    });
    return sections;
  }

  toggleLinkedSection(sectionId: string) {
    if (!this.sectionForm.linkedSectionIds) {
      this.sectionForm.linkedSectionIds = [];
    }
    const index = this.sectionForm.linkedSectionIds.indexOf(sectionId);
    if (index === -1) {
      this.sectionForm.linkedSectionIds.push(sectionId);
      if (!this.sectionForm.linkedSectionPrimary) {
        // Auto-designate: the section with the earliest creation timestamp wins.
        // Include the current section being edited so it can be primary too.
        const getTs = (id: string): number => {
          const m = /^post-(\d+)$/.exec(id);
          return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
        };
        const currentId = this.normalizeSectionId(this.sectionForm.id);
        this.sectionForm.linkedSectionPrimary =
          getTs(currentId) <= getTs(sectionId) ? currentId : sectionId;
      }
    } else {
      this.sectionForm.linkedSectionIds.splice(index, 1);
      if (this.sectionForm.linkedSectionPrimary === sectionId) {
        // Removed section was the primary — promote the next remaining linked section,
        // or fall back to the current section being edited.
        const next = this.sectionForm.linkedSectionIds[0];
        const currentId = this.normalizeSectionId(this.sectionForm.id);
        this.sectionForm.linkedSectionPrimary = next ?? currentId;
      }
    }
  }

  /** Explicitly marks a linked section as the primary for this link group. */
  setLinkedSectionPrimary(sectionId: string): void {
    this.sectionForm.linkedSectionPrimary = sectionId;
  }

  /** Marks the section currently being edited as the primary of its link group. */
  setCurrentSectionAsPrimary(): void {
    this.sectionForm.linkedSectionPrimary = this.normalizeSectionId(this.sectionForm.id);
  }

  /** Returns true when the given section is the designated primary in the link group. */
  isLinkedSectionPrimary(sectionId: string): boolean {
    return this.sectionForm.linkedSectionPrimary === sectionId;
  }

  /**
   * Returns true when the section currently being EDITED is itself the designated
   * primary of its link group (linkedSectionPrimary points to its own ID).
   * Used to show a "this section is primary" notice in the form.
   */
  isCurrentSectionThePrimary(): boolean {
    if (!(this.sectionForm.linkedSectionIds?.length)) return false;
    const currentId = this.normalizeSectionId(this.sectionForm.id);
    return this.sectionForm.linkedSectionPrimary === currentId;
  }

  isLinked(sectionId: string): boolean {
    return this.sectionForm.linkedSectionIds?.includes(sectionId) || false;
  }

  // Helper methods for template
  isEditingExistingPage(): boolean {
    return !!(this.pageForm.id && this.pages.find(p => p.id === this.pageForm.id));
  }

  isEditingDisabled(): boolean {
    return !!this.pages.find(p => p.id === this.pageForm.id);
  }

  /**
   * Returns options for the Page ID dropdown (1–15).
   * Options already used by other pages on the same date/edition are flagged disabled.
   * When editing an existing page the current page's own ID is excluded from the
   * "used" set so it doesn't appear as taken in the (disabled) select.
   */
  get pageIdOptions(): Array<{ id: number; disabled: boolean }> {
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    const usedIds = new Set((edition?.pages ?? []).map(p => p.id));
    if (this.isEditingExistingPage() && this.pageForm.id) {
      usedIds.delete(this.pageForm.id);
    }
    return Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      disabled: usedIds.has(i + 1)
    }));
  }

  async onFullImageFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;

    const originalFile = input.files[0];

    if (!originalFile.type.startsWith('image/')) {
      this.toaster.error('Please select an image file');
      return;
    }
    if (originalFile.size > 20 * 1024 * 1024) {
      this.toaster.error('Image size must be less than 20MB');
      return;
    }

    this.fullImageFile = originalFile;
    this.loader.show('Resizing and uploading page image…');

    try {
      // Resize to 700px for the frontend center-panel display image.
      // Encode in the format chosen by the admin (WebP by default).
      const displayFile = await resizeImageToWidth(originalFile, 700, this.imageQuality, this.imageMime);
      const displayFileName = this.buildPageImageFilename(this.imageExt, 'full');

      // Keep the original at full resolution for the section crop tool.
      // Hi-res is the crop source — preserve its original format to avoid
      // quality loss from double re-encoding and to keep max detail for crops.
      const hiResExt = originalFile.name.split('.').pop()?.toLowerCase() || 'jpg';
      const hiResFileName = this.buildPageImageFilename(hiResExt, 'hires');

      this.activityLog.track('image_upload_page', { fileName: displayFileName, pageId: String(this.pageForm.id ?? '') });

      // Upload the 700px display copy and the original hi-res copy in parallel.
      const [displayUrl, hiResUrl] = await Promise.all([
        this.uploadMediaFile(displayFile, displayFileName),
        this.uploadMediaFile(originalFile, hiResFileName)
      ]);

      const prevFullImage = this.pageForm.fullImage;
      this.pageForm.fullImage = displayUrl;
      this.pageForm.fullImageHiRes = hiResUrl;
      // Only show the loading skeleton if the src URL actually changed.
      // When overwriting an image WordPress may return the same URL, in which
      // case the <img> src won't change and the load event never fires, which
      // would leave the skeleton visible indefinitely.
      this.previewLoading = (displayUrl !== prevFullImage);

      // Auto-generate a thumbnail from the original if none is set yet.
      if (!this.pageForm.thumbnail) {
        this.loader.setMessage('Generating thumbnail…');
        const thumbFile = await resizeImageToWidth(originalFile, 300, this.imageQuality, this.imageMime);
        const thumbFileName = this.buildPageImageFilename(this.imageExt, 'thumb');
        const thumbUrl = await this.uploadMediaFile(thumbFile, thumbFileName);
        this.pageForm.thumbnail = thumbUrl;
      }

      this.cdr.detectChanges();
      this.toaster.success('Full image uploaded');
    } catch (error) {
      console.error('Error uploading full image:', error);
      this.toaster.error('Failed to upload full image: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      this.loader.hide();
    }
  }

  onFullImageUrlChange(value: string) {
    this.previewLoading = !!value;
  }

  onFullImageHiResFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.fullImageHiResFile = input.files[0];
      const ext = this.fullImageHiResFile.name.split('.').pop()?.toLowerCase() || 'jpg';
      const fileName = this.buildPageImageFilename(ext, 'hires');
      this.loader.show('Uploading high-res image…');
      this.uploadMediaFile(this.fullImageHiResFile, fileName)
        .then((url) => {
          this.pageForm.fullImageHiRes = url;
          this.cdr.detectChanges();
          this.toaster.success('High-res image uploaded');
        })
        .catch((error) => {
          console.error('Error uploading high-res image:', error);
          this.toaster.error('Failed to upload high-res image');
        })
        .finally(() => this.loader.hide());
    }
  }

  onFullImagePreviewLoad() {
    this.previewLoading = false;
    this.cdr.detectChanges();
  }

  onFullImagePreviewError() {
    this.previewLoading = false;
    this.cdr.detectChanges();
  }

  async onThumbnailFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;

    const originalFile = input.files[0];

    if (!originalFile.type.startsWith('image/')) {
      this.toaster.error('Please select an image file');
      return;
    }
    if (originalFile.size > 10 * 1024 * 1024) {
      this.toaster.error('Image size must be less than 10MB');
      return;
    }

    this.thumbnailFile = originalFile;
    this.loader.show('Resizing and uploading thumbnail…');

    try {
      const thumbFile = await resizeImageToWidth(originalFile, 300, this.imageQuality, this.imageMime);
      const fileName = this.buildPageImageFilename(this.imageExt, 'thumb');
      const url = await this.uploadMediaFile(thumbFile, fileName);
      this.pageForm.thumbnail = url;
      this.cdr.detectChanges();
      this.toaster.success('Thumbnail uploaded');
    } catch (error) {
      console.error('Error uploading thumbnail:', error);
      this.toaster.error('Failed to upload thumbnail: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      this.loader.hide();
    }
  }

  // Global Settings Management
  loadSettings(): void {
    const settings = this.dataService.getSettings();
    const addr = settings.address || {};
    this.settingsForm = {
      logo: { url: '', alt: 'Digital Newspaper', link: '', ...(settings.logo || {}) },
      socialLinks: settings.socialLinks || {},
      defaultDateMode: settings.defaultDateMode || 'current',
      specificDate: settings.specificDate || '',
      editor: settings.editor || '',
      editorLabels: {
        en: settings.editorLabels?.['en'] ?? settings.editor ?? '',
        bn: settings.editorLabels?.['bn'] ?? ''
      },
      address: {
        ...addr,
        line1Labels: {
          en: addr.line1Labels?.['en'] ?? addr.line1 ?? '',
          bn: addr.line1Labels?.['bn'] ?? ''
        },
        line2Labels: {
          en: addr.line2Labels?.['en'] ?? addr.line2 ?? '',
          bn: addr.line2Labels?.['bn'] ?? ''
        },
        phoneLabels: {
          en: addr.phoneLabels?.['en'] ?? addr.phone ?? '',
          bn: addr.phoneLabels?.['bn'] ?? ''
        }
      },
      language: settings.language || 'en',
      showPagePagination: settings.showPagePagination !== false,
      showBetaBadge: settings.showBetaBadge === true,
      headScripts: settings.headScripts ?? '',
      underMaintenance: settings.underMaintenance === true,
      maintenanceMessage: settings.maintenanceMessage ?? '',
      othersPageTitle: settings.othersPageTitle ?? '',
      imageFormat: (settings.imageFormat || 'webp') as 'webp' | 'all'
    };
    this.hasUnsavedSettingsChanges = false;
  }

  private buildSettingsFromForm(): GlobalSettings {
    // Strip empty labels so we don't bloat saved data
    const editorLabels = this.settingsForm.editorLabels || {};
    const cleanEditorLabels = { en: (editorLabels['en'] || '').trim(), bn: (editorLabels['bn'] || '').trim() };

    const addr = this.settingsForm.address || {};
    const line1Labels = addr.line1Labels || {};
    const line2Labels = addr.line2Labels || {};
    const phoneLabels = addr.phoneLabels || {};
    const cleanLine1Labels = { en: (line1Labels['en'] || '').trim(), bn: (line1Labels['bn'] || '').trim() };
    const cleanLine2Labels = { en: (line2Labels['en'] || '').trim(), bn: (line2Labels['bn'] || '').trim() };
    const cleanPhoneLabels = { en: (phoneLabels['en'] || '').trim(), bn: (phoneLabels['bn'] || '').trim() };

    // Ensure settings structure is complete
    return {
      logo: this.settingsForm.logo || { url: '', alt: 'Digital Newspaper' },
      socialLinks: this.settingsForm.socialLinks || {},
      defaultDateMode: this.settingsForm.defaultDateMode || 'current',
      specificDate: this.settingsForm.specificDate || '',
      // Keep base scalar field in sync with EN label for backward compat
      editor: cleanEditorLabels.en || this.settingsForm.editor || '',
      editorLabels: cleanEditorLabels,
      address: {
        ...addr,
        // Sync base fields with EN labels for backward compat
        line1: cleanLine1Labels.en || addr.line1 || '',
        line1Labels: cleanLine1Labels,
        line2: cleanLine2Labels.en || addr.line2 || '',
        line2Labels: cleanLine2Labels,
        phone: cleanPhoneLabels.en || addr.phone || '',
        phoneLabels: cleanPhoneLabels
      },
      language: this.settingsForm.language || 'en',
      showPagePagination: this.settingsForm.showPagePagination !== false,
      showBetaBadge: this.settingsForm.showBetaBadge === true,
      headScripts: this.settingsForm.headScripts || '',
      underMaintenance: this.settingsForm.underMaintenance === true,
      maintenanceMessage: this.settingsForm.maintenanceMessage || '',
      othersPageTitle: this.settingsForm.othersPageTitle || '',
      imageFormat: this.settingsForm.imageFormat || 'webp'
    };
  }

  private commitSettingsFormToData(): GlobalSettings {
    const completeSettings = this.buildSettingsFromForm();

    // Update settings in the data service
    this.dataService.updateSettings(completeSettings);

    return completeSettings;
  }

  saveSettings(): void {
    this.activityLog.track('settings_save');
    const completeSettings = this.commitSettingsFormToData();

    console.log('Saving settings:', completeSettings);

    // Use the dedicated PATCH /data/settings endpoint so the editions data is
    // never included in the payload — prevents the shrinking-overwrite 409.
    this.dataService.saveSettingsOnly(completeSettings).subscribe({
      next: () => {
        console.log('Settings saved successfully');
        this.markSaved();
        this.toaster.success('Settings saved successfully!');
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error saving settings:', error);
        this.toaster.error('Failed to save settings');
      }
    });
  }

  onLogoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.logoFile = input.files[0];

      // Legacy mode — upload as-is, preserving original format
      if (this.imageMime === 'image/jpeg') {
        const ext = this.logoFile.name.split('.').pop()?.toLowerCase() || 'jpg';
        const fileName = `logo_${Date.now()}.${ext}`;
        this.loader.show('Uploading logo…');
        this.activityLog.track('image_upload_logo', { fileName });
        this.uploadMediaFile(this.logoFile, fileName)
          .then((url) => {
            if (this.settingsForm.logo) {
              this.settingsForm.logo.url = url;
            }
            this.onSettingsFormChanged();
            this.cdr.detectChanges();
            this.toaster.success('Logo uploaded');
          })
          .catch((error) => {
            console.error('Error uploading logo:', error);
            this.toaster.error('Failed to upload logo');
          })
          .finally(() => this.loader.hide());
        return;
      }

      // WebP mode — re-encode via Canvas (preserves PNG transparency)
      this.loader.show('Converting logo to WebP…');
      const objectUrl = URL.createObjectURL(this.logoFile);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          this.loader.hide();
          this.toaster.error('Failed to convert logo to WebP');
          return;
        }
        ctx.drawImage(img, 0, 0);
        const fileName = `logo_${Date.now()}.webp`;
        const imageData = canvas.toDataURL('image/webp', this.imageQuality);
        const file = this.dataUrlToFile(imageData, fileName);
        this.activityLog.track('image_upload_logo', { fileName });
        this.uploadMediaFile(file, fileName)
          .then((url) => {
            if (this.settingsForm.logo) {
              this.settingsForm.logo.url = url;
            }
            this.onSettingsFormChanged();
            this.cdr.detectChanges();
            this.toaster.success('Logo uploaded');
          })
          .catch((error) => {
            console.error('Error uploading logo:', error);
            this.toaster.error('Failed to upload logo');
          })
          .finally(() => this.loader.hide());
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        this.loader.hide();
        this.toaster.error('Failed to load logo for conversion');
      };
      img.src = objectUrl;
    }
  }

  resolveImageUrl(url: string): string {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (url.includes('/wp-content/uploads/')) {
        try {
          const wpOrigin = new URL(this.dataService.getApiBaseUrl()).origin;
          const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)$/);
          return pathMatch ? wpOrigin + pathMatch[1] : url;
        } catch { return url; }
      }
      return url;
    }
    const base = this.dataService.getApiBaseUrl();
    return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
  }
}
