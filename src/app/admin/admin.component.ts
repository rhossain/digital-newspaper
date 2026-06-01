import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { QuillModule } from 'ngx-quill';
import { NewspaperDataService, NewspaperPage, NewsSection, GlobalSettings, NewspaperEdition, ExportOptions, ImportOptions, ImportValidationResult, ImportPreview, BackupHistoryEntry } from '../services/newspaper-data.service';
import { AuthService } from '../services/auth.service';
import { ToasterService } from '../services/toaster.service';
import { LoaderService } from '../services/loader.service';
import { TranslationService } from '../i18n/translation.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, QuillModule],
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.css']
})
export class AdminComponent implements OnInit {
  @ViewChild('cropperImage') cropperImageRef!: ElementRef<HTMLImageElement>;
  
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
  activeMainTab: 'content' | 'settings' = 'content';
  isEditingPage = false;
  isEditingSection = false;
  showImageCropper = false;
  isBodyMaximized = false;
  isSavingCrop = false;
  
  // Form Data
  pageForm: Partial<NewspaperPage> = {
    id: 0,
    thumbnail: '',
    fullImage: '',
    sections: []
  };
  
  // Image input modes
  fullImageInputMode: 'url' | 'file' = 'url';
  fullImageHiResInputMode: 'url' | 'file' = 'url';
  thumbnailInputMode: 'url' | 'file' = 'url';
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
    headScripts: ''
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
    this.selectPage(this.previewPage);
    this.editSection(sec);
    this.closePagePreview();
    this.cdr.detectChanges();
  }

  previewDeleteSection(sec: NewsSection) {
    if (!confirm(`Delete section "${sec.title}"?`)) return;
    this.dataService.deleteSection(this.previewPage.id, sec.id, this.selectedDate, this.selectedEditionNumber);
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (edition) this.pages = edition.pages;
    this.previewPage = this.pages.find((p: any) => p.id === this.previewPage?.id) ?? null;
    if (!this.previewPage) { this.closePagePreview(); return; }
    this.toaster.success('Section deleted.');
    this.cdr.detectChanges();
  }

  constructor(
    private dataService: NewspaperDataService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private toaster: ToasterService,
    private authService: AuthService,
    private translationService: TranslationService,
    private loader: LoaderService
  ) {}

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();
    this.selectedDate = this.todayDate;
    this.availableDates = this.selectedDate ? [this.selectedDate] : [];
    this.backupHistory = this.dataService.getBackupHistory();
    this.verifyAuth();
  }

  get isAuthenticated(): boolean {
    return this.authService.isAuthenticated();
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
        if (err.status === 0) {
          this.authError = 'Cannot reach WordPress. Verify the WordPress site is online and CORS "Allowed Origins" includes this app\'s URL.';
        } else if (err.status === 401 || err.status === 400) {
          this.authError = 'Invalid username or password. Please try again.';
        } else if (err.status === 403) {
          this.authError = 'Access denied. Your WordPress account may not have the Administrator role.';
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
        this.availableDates = this.dataService.getAvailableDates();
        if (!this.availableDates.includes(this.selectedDate)) {
          this.availableDates.unshift(this.selectedDate);
        }
        this.loadCurrentEdition();
        this.loadSettings();
        this.cdr.detectChanges(); // Explicitly trigger change detection
      },
      error: (error) => console.error('Error loading data:', error)
    });
  }

  loadCurrentEdition() {
    this.isLoadingEdition = true;
    this.dataService.setCurrentDate(this.selectedDate);
    
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
    this.isLoadingEdition = false;
    this.cdr.detectChanges();
  }

  onDateChange() {
    this.selectedEditionNumber = 1;
    this.loadCurrentEdition();
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
  }

  onEditionChange(editionNumber: number) {
    this.selectedEditionNumber = editionNumber;
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
    this.loadCurrentEdition();
  }

  createNewEdition() {
    const editionNumbers = this.editionsForDate.map(e => e.edition || 1);
    const nextEditionNumber = editionNumbers.length > 0 ? Math.max(...editionNumbers) + 1 : 2;

    this.dataService.getOrCreateEdition(this.selectedDate, nextEditionNumber);
    this.selectedEditionNumber = nextEditionNumber;
    this.loadCurrentEdition();
    this.toaster.success(`Edition ${nextEditionNumber} created!`);

    // Open label editor immediately for the new edition
    const newEd = this.editionsForDate.find(e => (e.edition || 1) === nextEditionNumber);
    if (newEd) this.openEditionLabelEditor(newEd);
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
    this.dataService['dataSubject'].next({ ...data, editions });
    this.editingEditionLabel = null;
    this.loadCurrentEdition();
    this.toaster.success('Edition labels saved!');
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

  createNewDate() {
    const newDate = prompt('Enter date (YYYY-MM-DD):', this.todayDate);
    if (newDate && /^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      this.selectedDate = newDate;
      this.dataService.getOrCreateEdition(newDate);
      if (!this.availableDates.includes(newDate)) {
        this.availableDates.unshift(newDate);
        this.availableDates.sort().reverse();
      }
      this.onDateChange();
    } else if (newDate) {
      alert('Invalid date format. Please use YYYY-MM-DD');
    }
  }

  formatDisplayDate(dateStr: string): string {
    return this.dataService.formatDisplayDate(dateStr);
  }

  // Page Management
  selectPage(page: NewspaperPage) {
    this.selectedPage = page;
    this.selectedSection = null;
    this.activeTab = 'sections';
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
    this.pageForm = {
      id: this.dataService.getNextPageId(this.selectedDate, this.selectedEditionNumber),
      thumbnail: '',
      fullImage: '',
      fullImageHiRes: '',
      sections: [],
      pageLabels: { en: '', bn: '' }
    };
    this.pageNameSelect = '';
    this.fullImageInputMode = 'url';
    this.fullImageHiResInputMode = 'url';
    this.thumbnailInputMode = 'url';
    this.fullImageFile = null;
    this.fullImageHiResFile = null;
    this.thumbnailFile = null;
  }

  editPage(page: NewspaperPage) {
    this.isEditingPage = true;
    this.pageForm = { ...page, pageLabels: { en: page.pageLabels?.['en'] ?? '', bn: page.pageLabels?.['bn'] ?? '' } };
    this.initPageNameSelects();
    this.fullImageInputMode = 'url';
    this.fullImageHiResInputMode = 'url';
    this.thumbnailInputMode = 'url';
    this.fullImageFile = null;
    this.fullImageHiResFile = null;
    this.thumbnailFile = null;
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
      
      // Update local pages immediately from service (no network call)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) {
        this.pages = edition.pages;
      }

      // Re-sync selectedPage so the cropper reflects the latest saved data
      if (this.selectedPage?.id === page.id) {
        this.selectedPage = this.pages.find(p => p.id === page.id) || null;
      }

      this.cancelPageEdit();
      this.toaster.success('Page saved successfully!');
    }
  }

  deletePage(page: NewspaperPage) {
    if (confirm(`Delete page ${page.id}?`)) {
      this.dataService.deletePage(page.id, this.selectedDate, this.selectedEditionNumber);
      if (this.selectedPage?.id === page.id) {
        this.selectedPage = null;
      }
      
      // Update local pages immediately from service (no network call)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) {
        this.pages = edition.pages;
      }
      this.toaster.success('Page deleted successfully!');
    }
  }

  cancelPageEdit() {
    this.isEditingPage = false;
    this.pageForm = { id: 0, thumbnail: '', fullImage: '', fullImageHiRes: '', sections: [], pageLabels: { en: '', bn: '' } };
    this.pageNameSelect = '';
    this.pageFormErrors = {};
  }

  // Section Management
  newSection() {
    if (!this.selectedPage) {
      alert('Please select a page first');
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
      showCaption: true
    };
  }

  editSection(section: NewsSection) {
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
    if (this.selectedPage && this.sectionForm.id && this.sectionForm.title) {
      const normalizedSectionId = this.normalizeSectionId(this.sectionForm.id);

      // Clear imageUrl if auto-crop is selected
      const imageUrl = this.imageSourceOption === 'auto-crop' ? '' : (this.sectionForm.imageUrl || '');
      
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
        linkedSectionIds: this.sectionForm.linkedSectionIds || [],
        showCaption: this.sectionForm.showCaption !== undefined ? this.sectionForm.showCaption : true
      };
      
      
      // Check if section exists by looking in the service data (not the stale selectedPage)
      const currentEdition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      const currentPage = currentEdition?.pages.find(p => p.id === this.selectedPage?.id);
      const originalSectionId = this.selectedSection?.id || normalizedSectionId;
      const existingSection = currentPage?.sections.find(s => s.id === originalSectionId);
      
      if (existingSection) {
        this.dataService.updateSection(this.selectedPage.id, originalSectionId, section, this.selectedDate, this.selectedEditionNumber);
      } else {
        this.dataService.addSection(this.selectedPage.id, section, this.selectedDate, this.selectedEditionNumber);
      }

      this.sectionForm.id = normalizedSectionId;

      // Sync bidirectional links: ensure every section linked from A also links back to A,
      // and every section no longer linked from A removes A from its links.
      this.syncBidirectionalLinks(normalizedSectionId, section.linkedSectionIds || []);
      
      // Update local pages immediately from service (no network call)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) {
        this.pages = edition.pages;
      }
      // Update selected page reference
      this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
      
      
      if (closeForm) {
        this.cancelSectionEdit();
        this.toaster.success('Section saved successfully!');
      }
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
    if (this.selectedPage && confirm(`Delete section "${section.title}"?`)) {
      this.dataService.deleteSection(this.selectedPage.id, section.id, this.selectedDate, this.selectedEditionNumber);
      
      // Update local pages immediately from service (no network call)
      const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
      if (edition) {
        this.pages = edition.pages;
      }
      // Update selected page reference
      this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
      
      this.toaster.success('Section deleted successfully!');
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
      linkedSectionIds: []
    };
  }

  // ─── Image Cropper ──────────────────────────────────────────────

  openImageCropper() {
    if (!this.selectedPage?.fullImage) {
      alert('Please save the page with a full image URL first');
      return;
    }
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
    if (!this.selectedPage || !confirm(`Delete section "${section.title}"?`)) return;
    this.dataService.deleteSection(this.selectedPage.id, section.id, this.selectedDate, this.selectedEditionNumber);
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (edition) this.pages = edition.pages;
    this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) ?? null;
    this.toaster.success('Section deleted.');
    this.cdr.detectChanges();
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
    this.loader.show();
    this.isSavingCrop = true;
    this.cdr.detectChanges();
    try {
      const proxyUrl = `${this.dataService.getApiBaseUrl()}/wp-json/digital-newspaper/v1/proxy?url=${encodeURIComponent(fullImageUrl)}`;
      
      // Fetch the full-size image
      const response = await fetch(proxyUrl);
      if (!response.ok) {
        this.isSavingCrop = false;
        this.loader.hide();
        throw new Error(`Proxy fetch failed (${response.status})`);
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
          
          // Convert to data URL
          const croppedImageData = canvas.toDataURL('image/jpeg', 0.9);
          
          // Generate filename: DD_MM_YYYY_NNNN_sectionId
          const datePrefix = this.formatDateForFilename(
            this.selectedDate || this.dataService.getTodayDate()
          );
          const headers = this.authService.getAuthHeaders();
          const sequence = await this.getNextCropSequence(datePrefix, headers);
          const sequenceStr = sequence.toString().padStart(4, '0');
          const sectionId = (this.sectionForm.id || 'unknown').toString();
          const fileName = `${datePrefix}_${sequenceStr}_${sectionId}`;
          
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
    const file = this.dataUrlToFile(imageData, `${fileName}.jpg`);
    // loader already shown by generateAndUploadCroppedImageFromFullSize
    this.uploadMediaFile(file, `${fileName}.jpg`)
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

    // Read file and upload
    const reader = new FileReader();
    reader.onload = () => {
      const imageData = reader.result as string;
      const fileName = this.sectionForm.title?.replace(/\s+/g, '_').toLowerCase() || 'uploaded';
      this.uploadImageFile(imageData, fileName);
    };
    reader.onerror = () => {
      this.toaster.error('Failed to read image file');
    };
    reader.readAsDataURL(file);
  }

  uploadImageFile(imageData: string, fileName: string) {
    const file = this.dataUrlToFile(imageData, `${fileName}.jpg`);
    this.loader.show();
    this.uploadMediaFile(file, `${fileName}.jpg`)
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Upload failed');
    }

    const data = await response.json();
    return data.source_url || data.guid?.rendered || '';
  }

  /** Convert YYYY-MM-DD → DD_MM_YYYY for use in media filenames. */
  private formatDateForFilename(dateStr: string): string {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    return `${parts[2]}_${parts[1]}_${parts[0]}`;
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
      const response = await fetch(searchUrl, { headers });
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
    const response = await fetch(searchUrl, { headers });
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
    const response = await fetch(deleteUrl, { method: 'DELETE', headers });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || 'Failed to delete existing media');
    }
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
      this.calculateCropCoordinates();
      
      // Only generate cropped image if auto-crop is selected and imageUrl is empty
      if (this.imageSourceOption === 'auto-crop' && (!this.sectionForm.imageUrl || this.sectionForm.imageUrl.trim() === '')) {
        // Use percentage coordinates to crop from full-size image
        const fullImageUrl = this.selectedPage.fullImage;
        this.generateAndUploadCroppedImageFromFullSize(fullImageUrl);
      } else {
        this.toaster.success('Crop coordinates set!');
      }
    }
    this.closeCropper();
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
  saveAllData() {
    // Get the latest data from service to ensure we have all changes
    const currentData = this.dataService.getData();
    
    
    if (!currentData.editions || currentData.editions.length === 0) {
      console.warn('No data to save!');
      this.toaster.warning('No data to save');
      return;
    }
    
    // Show immediate feedback
    this.toaster.success('Saving data...');
    
    // Save asynchronously without blocking UI
    this.dataService.saveData(currentData).subscribe({
      next: (response) => {
        console.log('Save successful:', response);
        this.toaster.success('All data saved successfully!');
        // NO RELOAD - data is already updated locally
        // Just ensure selected page reference is current
        if (this.selectedPage) {
          this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
        }
      },
      error: (error) => {
        console.error('Error saving data:', error);
        this.toaster.error(error.message || 'Failed to save data');
      }
    });
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
    const { filename } = this.dataService.downloadExport(opts);
    this.toaster.success(`Exported: ${filename}`);
    this.backupHistory = this.dataService.getBackupHistory();
    this.showExportModal = false;
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
    this.loader.show();
    this.toaster.info(`Reading backup file…`);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = e.target?.result as string;
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
    reader.readAsText(file);
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
    this.loader.show();

    // Auto-backup current data before overwriting
    this.dataService.downloadExport({ exportType: 'full', exportScope: 'full' });
    this.toaster.info('Auto-backup downloaded. Starting import…');

    const mergedData = this.dataService.applyImport(this.importParsed, this.importOptions);
    this.dataService.saveData(mergedData).subscribe({
      next: () => {
        this.isImporting = false;
        this.loader.hide();
        this.toaster.success('Backup imported successfully!');
        this.backupHistory = this.dataService.getBackupHistory();
        this.closeImportModal();

        // Re-fetch from server so in-memory state matches what was persisted,
        // then navigate to the most-recent date in the imported data so the
        // user immediately sees the imported content instead of an empty
        // "today" edition that would otherwise be auto-created.
        this.dataService.loadData().subscribe({
          next: () => {
            this.availableDates = this.dataService.getAvailableDates();
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
      error: (err) => {
        this.isImporting = false;
        this.loader.hide();
        console.error('Import failed:', err);
        this.toaster.error('Failed to import: ' + (err.message || 'Unknown error'));
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
  }

  goToViewer() {
    if (this.isSavingCrop) {
      this.toaster.warning('Please wait — the cropped image is still being saved.');
      return;
    }
    this.router.navigate(['/']);
  }

  // Linked Sections Helper

  /** Keeps linked sections in sync bidirectionally.
   *  When section A links to B, B is automatically updated to link back to A.
   *  When section A removes a link to B, B's back-link to A is also removed.
   */
  private syncBidirectionalLinks(currentSectionId: string, currentLinkedIds: string[]): void {
    const edition = this.dataService.getEditionByDateAndNumber(this.selectedDate, this.selectedEditionNumber);
    if (!edition) return;

    edition.pages.forEach(page => {
      page.sections.forEach(otherSection => {
        if (otherSection.id === currentSectionId) return;

        const shouldBeLinked = currentLinkedIds.includes(otherSection.id);
        const isAlreadyLinked = otherSection.linkedSectionIds?.includes(currentSectionId) ?? false;

        if (shouldBeLinked && !isAlreadyLinked) {
          // Add back-link
          const updated: NewsSection = {
            ...otherSection,
            linkedSectionIds: [...(otherSection.linkedSectionIds || []), currentSectionId]
          };
          this.dataService.updateSection(page.id, otherSection.id, updated, this.selectedDate, this.selectedEditionNumber);
        } else if (!shouldBeLinked && isAlreadyLinked) {
          // Remove back-link
          const updated: NewsSection = {
            ...otherSection,
            linkedSectionIds: (otherSection.linkedSectionIds || []).filter(id => id !== currentSectionId)
          };
          this.dataService.updateSection(page.id, otherSection.id, updated, this.selectedDate, this.selectedEditionNumber);
        }
      });
    });
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
    return sections;
  }

  toggleLinkedSection(sectionId: string) {
    if (!this.sectionForm.linkedSectionIds) {
      this.sectionForm.linkedSectionIds = [];
    }
    
    const index = this.sectionForm.linkedSectionIds.indexOf(sectionId);
    if (index === -1) {
      this.sectionForm.linkedSectionIds.push(sectionId);
    } else {
      this.sectionForm.linkedSectionIds.splice(index, 1);
    }
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

  onFullImageFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.fullImageFile = input.files[0];
      const fileName = this.fullImageFile.name || `page_full_${Date.now()}.jpg`;
      this.loader.show();
      this.uploadMediaFile(this.fullImageFile, fileName)
        .then((url) => {
          this.pageForm.fullImage = url;
          this.previewLoading = true;
          this.cdr.detectChanges();
          this.toaster.success('Full image uploaded');
        })
        .catch((error) => {
          console.error('Error uploading full image:', error);
          this.toaster.error('Failed to upload full image');
        })
        .finally(() => this.loader.hide());
    }
  }

  onFullImageUrlChange(value: string) {
    this.previewLoading = !!value;
  }

  onFullImageHiResFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.fullImageHiResFile = input.files[0];
      const fileName = this.fullImageHiResFile.name || `page_full_hires_${Date.now()}.jpg`;
      this.loader.show();
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
  }

  onFullImagePreviewError() {
    this.previewLoading = false;
  }

  onThumbnailFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.thumbnailFile = input.files[0];
      const fileName = this.thumbnailFile.name || `page_thumb_${Date.now()}.jpg`;
      this.loader.show();
      this.uploadMediaFile(this.thumbnailFile, fileName)
        .then((url) => {
          this.pageForm.thumbnail = url;
          this.cdr.detectChanges();
          this.toaster.success('Thumbnail uploaded');
        })
        .catch((error) => {
          console.error('Error uploading thumbnail:', error);
          this.toaster.error('Failed to upload thumbnail');
        })
        .finally(() => this.loader.hide());
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
      headScripts: settings.headScripts ?? ''
    };
  }

  saveSettings(): void {
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
    const completeSettings: GlobalSettings = {
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
      headScripts: this.settingsForm.headScripts || ''
    };
    
    // Update settings in the data service
    this.dataService.updateSettings(completeSettings);
    
    // Get the updated data after settings change
    const currentData = this.dataService.getData();
    console.log('Saving settings:', completeSettings);
    console.log('Complete data structure:', currentData);
    
    // Save to backend
    this.dataService.saveData(currentData).subscribe({
      next: () => {
        console.log('Settings saved successfully');
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
      const ext = this.logoFile.name.split('.').pop()?.toLowerCase() || 'jpg';
      const fileName = `logo_${Date.now()}.${ext}`;
      this.loader.show();
      this.uploadMediaFile(this.logoFile, fileName)
        .then((url) => {
          if (this.settingsForm.logo) {
            this.settingsForm.logo.url = url;
          }
          this.cdr.detectChanges();
          this.toaster.success('Logo uploaded');
        })
        .catch((error) => {
          console.error('Error uploading logo:', error);
          this.toaster.error('Failed to upload logo');
        })
        .finally(() => this.loader.hide());
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
