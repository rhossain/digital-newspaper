import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NewspaperDataService, NewsSection, NewspaperPage, NewspaperEdition } from './services/newspaper-data.service';
import { ToasterService } from './services/toaster.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-newspaper',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './newspaper.component.html',
  styleUrls: ['./newspaper.component.css']
})
export class NewspaperComponent implements OnInit, OnDestroy {
  pages: NewspaperPage[] = [];
  currentPage: NewspaperPage | null = null;
  selectedSection: NewsSection | null = null;
  imageLoaded = false;
  croppedSectionImage: string | null = null;
  showContentModal = false;
  showImageModal = false;
  linkedSections: NewsSection[] = [];
  private imageElement: HTMLImageElement | null = null;
  
  // Image loading states
  thumbnailsLoading: { [key: number]: boolean } = {};
  sectionImageLoading = false;
  
  // Date navigation
  selectedDate: string = '';
  todayDate: string = '';
  displayDate: string = '';
  availableDates: string[] = [];
  isToday: boolean = true;
  isLoading: boolean = false;
  
  private subscriptions: Subscription[] = [];

  constructor(
    private dataService: NewspaperDataService,
    private toaster: ToasterService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();
    this.selectedDate = this.todayDate;
    
    // Subscribe to date changes
    const dateSubscription = this.dataService.currentDate$.subscribe(date => {
      this.selectedDate = date;
      this.updateDisplayDate();
      this.checkIfToday();
    });
    this.subscriptions.push(dateSubscription);
    
    // Subscribe to data changes
    const dataSubscription = this.dataService.data$.subscribe(() => {
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
        this.loadCurrentEdition();
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

  loadCurrentEdition() {
    const edition = this.dataService.getCurrentEdition();
    if (edition) {
      this.pages = edition.pages;
      // Initialize loading states for thumbnails
      this.thumbnailsLoading = {};
      this.pages.forEach(page => {
        this.thumbnailsLoading[page.id] = true;
      });
      if (this.pages.length > 0) {
        this.selectPage(this.pages[0]);
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

  updateDisplayDate() {
    this.displayDate = this.dataService.formatDisplayDate(this.selectedDate);
  }

  checkIfToday() {
    this.isToday = this.selectedDate === this.todayDate;
  }

  onDateChange() {
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

  formatShortDate(dateStr: string): string {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });
  }
  //   });
  // }

  selectPage(page: NewspaperPage, targetSectionId?: string) {
    this.currentPage = page;
    this.imageLoaded = false;
    
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

  selectSection(section: NewsSection) {
    this.selectedSection = section;
    this.sectionImageLoading = true;
    
    // Load linked sections
    this.loadLinkedSections(section);
    
    // Use imageUrl if available, otherwise crop from main image
    if (section.imageUrl) {
      // Ensure the path starts with / for proper Angular asset resolution
      const imagePath = section.imageUrl.startsWith('/') ? section.imageUrl : `/${section.imageUrl}`;
      this.croppedSectionImage = imagePath;
      console.log('Loading section image from:', imagePath);
    } else {
      this.croppedSectionImage = null;
      this.cropSectionImage();
    }
    
    // Scroll right panel to top when new section is selected
    const rightPanel = document.querySelector('.right-panel');
    if (rightPanel) {
      rightPanel.scrollTop = 0;
    }
  }

  onSectionImageLoad() {
    this.sectionImageLoading = false;
  }

  closeSection() {
    this.selectedSection = null;
    this.croppedSectionImage = null;
    this.showContentModal = false;
    this.showImageModal = false;
    this.linkedSections = [];
    this.sectionImageLoading = false;
  }

  openContentModal() {
    this.showContentModal = true;
  }

  closeContentModal() {
    this.showContentModal = false;
  }

  openImageModal() {
    this.showImageModal = true;
  }

  closeImageModal() {
    this.showImageModal = false;
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
    if (!this.selectedSection || !this.imageElement || !this.currentPage) {
      return;
    }

    // If section has its own imageUrl, use it instead of cropping
    if (this.selectedSection.imageUrl) {
      const imagePath = this.selectedSection.imageUrl.startsWith('/') ? this.selectedSection.imageUrl : `/${this.selectedSection.imageUrl}`;
      this.croppedSectionImage = imagePath;
      console.log('Using section imageUrl:', imagePath);
      return;
    }

    // Wait for image to be fully loaded
    if (!this.imageElement.complete) {
      this.imageElement.onload = () => this.cropSectionImage();
      return;
    }

    const section = this.selectedSection;
    const img = this.imageElement;

    // Get the natural (actual) dimensions of the image
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;

    // Calculate the crop area based on percentages
    const cropX = (section.x / 100) * naturalWidth;
    const cropY = (section.y / 100) * naturalHeight;
    const cropWidth = (section.width / 100) * naturalWidth;
    const cropHeight = (section.height / 100) * naturalHeight;

    // Create a canvas to crop the image
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = cropHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Draw the cropped portion of the image
    ctx.drawImage(
      img,
      cropX, cropY, cropWidth, cropHeight,  // Source rectangle
      0, 0, cropWidth, cropHeight            // Destination rectangle
    );

    // Convert canvas to data URL
    this.croppedSectionImage = canvas.toDataURL('image/jpeg', 0.9);
  }
}
