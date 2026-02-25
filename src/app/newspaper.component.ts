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
    private location: Location
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
    
    // Subscribe to data changes
    const dataSubscription = this.dataService.data$.subscribe(() => {
      // Always sync global settings from the latest data
      this.refreshSettings();
      this.loadCurrentEdition();
      this.cdr.detectChanges();
    });
    this.subscriptions.push(dataSubscription);
    
    this.loadNewspaperData();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(sub => sub.unsubscribe());
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
        
        // If no date was set from URL, use the default date from settings
        if (!this.route.snapshot.paramMap.has('date')) {
          const defaultDate = this.dataService.getDefaultDate();
          this.selectedDate = defaultDate;
          this.dataService.setCurrentDate(defaultDate);
        }
        
        // loadCurrentEdition will be called by the data$ subscription
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error loading newspaper data:', error);
        this.toaster.error('Failed to load newspaper data');
        this.pages = [];
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
      console.log('Loading section image from:', resolvedUrl);
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
    
    // Update URL with section
    this.updateUrl();
  }

  onSectionImageLoad() {
    this.sectionImageLoading = false;
    this.cdr.detectChanges();
  }

  onSectionImageError() {
    this.sectionImageLoading = false;
    this.sectionImageError = true;
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
      } catch (error) {
        this.croppedSectionImage = null;
        this.sectionImageError = true;
        this.sectionImageLoading = false;
        this.cdr.detectChanges();
        console.error('Failed to crop section image due to canvas security restrictions:', error);
      }
    };

    img.onerror = () => {
      if (this.selectedSection !== sectionAtStart) return;
      this.sectionImageError = true;
      this.sectionImageLoading = false;
      this.cdr.detectChanges();
      console.error('Failed to load image for cropping:', srcUrl);
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
