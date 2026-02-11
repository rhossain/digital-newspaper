import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NewspaperDataService, NewspaperPage, NewsSection, GlobalSettings } from '../services/newspaper-data.service';
import { ToasterService } from '../services/toaster.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
  
  // UI State
  activeTab: 'pages' | 'sections' = 'pages';
  activeMainTab: 'content' | 'settings' = 'content';
  isEditingPage = false;
  isEditingSection = false;
  showImageCropper = false;
  
  // Form Data
  pageForm: Partial<NewspaperPage> = {
    id: 0,
    thumbnail: '',
    fullImage: '',
    sections: []
  };
  
  // Image input modes
  fullImageInputMode: 'url' | 'file' = 'url';
  thumbnailInputMode: 'url' | 'file' = 'url';
  fullImageFile: File | null = null;
  thumbnailFile: File | null = null;

  // Global Settings
  settingsForm: GlobalSettings = {
    logo: { url: '', alt: 'Digital Newspaper' },
    socialLinks: {
      facebook: '',
      twitter: '',
      linkedin: '',
      whatsapp: '',
      instagram: '',
      youtube: ''
    },
    defaultDateMode: 'current',
    specificDate: ''
  };
  logoInputMode: 'url' | 'file' = 'url';
  logoFile: File | null = null;
  
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
  
  // Image source option
  imageSourceOption: 'auto-crop' | 'external-url' | 'upload' = 'auto-crop';
  
  // Image Cropper
  cropperImageLoaded = false;
  cropperStartX = 0;
  cropperStartY = 0;
  cropperEndX = 0;
  cropperEndY = 0;
  isDrawing = false;
  imageNaturalWidth = 0;
  imageNaturalHeight = 0;

  constructor(
    private dataService: NewspaperDataService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private toaster: ToasterService
  ) {}

  ngOnInit() {
    this.todayDate = this.dataService.getTodayDate();
    this.selectedDate = this.todayDate;
    this.availableDates = this.selectedDate ? [this.selectedDate] : [];
    
    this.loadData();
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
    
    // Defer edition loading to next tick to update UI immediately
    setTimeout(() => {
      const edition = this.dataService.getCurrentEdition();
      if (edition) {
        this.pages = edition.pages;
      } else {
        // Create new edition if it doesn't exist
        this.dataService.getOrCreateEdition(this.selectedDate);
        this.pages = [];
      }
      this.isLoadingEdition = false;
      this.cdr.detectChanges();
    }, 0);
  }

  onDateChange() {
    this.loadCurrentEdition();
    this.selectedPage = null;
    this.selectedSection = null;
    this.isEditingPage = false;
    this.isEditingSection = false;
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

  newPage() {
    this.isEditingPage = true;
    this.pageForm = {
      id: this.dataService.getNextPageId(this.selectedDate),
      thumbnail: '',
      fullImage: '',
      sections: []
    };
    this.fullImageInputMode = 'url';
    this.thumbnailInputMode = 'url';
    this.fullImageFile = null;
    this.thumbnailFile = null;
  }

  editPage(page: NewspaperPage) {
    this.isEditingPage = true;
    this.pageForm = { ...page };
    this.fullImageInputMode = 'url';
    this.thumbnailInputMode = 'url';
    this.fullImageFile = null;
    this.thumbnailFile = null;
  }

  savePage() {
    if (this.pageForm.id && this.pageForm.fullImage) {
      const page = this.pageForm as NewspaperPage;
      const existingPage = this.pages.find(p => p.id === page.id);
      
      if (existingPage) {
        this.dataService.updatePage(page.id, page, this.selectedDate);
      } else {
        this.dataService.addPage(page, this.selectedDate);
      }
      
      // Reload pages from the current edition
      this.loadCurrentEdition();
      
      this.cancelPageEdit();
      this.toaster.success('Page saved successfully!');
    }
  }

  deletePage(page: NewspaperPage) {
    if (confirm(`Delete page ${page.id}?`)) {
      this.dataService.deletePage(page.id, this.selectedDate);
      if (this.selectedPage?.id === page.id) {
        this.selectedPage = null;
      }
      
      // Reload pages from the current edition
      this.loadCurrentEdition();
      this.toaster.success('Page deleted successfully!');
    }
  }

  cancelPageEdit() {
    this.isEditingPage = false;
    this.pageForm = { id: 0, thumbnail: '', fullImage: '', sections: [] };
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
      id: `section-${Date.now()}`,
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
    this.sectionForm = { ...section };
    
    // Set the appropriate radio button based on imageUrl
    if (!section.imageUrl || section.imageUrl.trim() === '') {
      this.imageSourceOption = 'auto-crop';
    } else if (section.imageUrl.startsWith('assets/cropped/')) {
      this.imageSourceOption = 'upload';
    } else {
      this.imageSourceOption = 'external-url';
    }
  }

  saveSection() {
    if (this.selectedPage && this.sectionForm.id && this.sectionForm.title) {
      // Clear imageUrl if auto-crop is selected
      const imageUrl = this.imageSourceOption === 'auto-crop' ? '' : (this.sectionForm.imageUrl || '');
      
      // Create a clean copy of the section
      const section: NewsSection = {
        id: this.sectionForm.id,
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
      
      console.log('Saving section:', section);
      
      // Check if section exists by looking in the service data (not the stale selectedPage)
      const edition = this.dataService.getEditionByDate(this.selectedDate);
      const currentPage = edition?.pages.find(p => p.id === this.selectedPage?.id);
      const existingSection = currentPage?.sections.find(s => s.id === section.id);
      
      if (existingSection) {
        console.log('Updating existing section');
        this.dataService.updateSection(this.selectedPage.id, section.id, section, this.selectedDate);
      } else {
        console.log('Adding new section');
        this.dataService.addSection(this.selectedPage.id, section, this.selectedDate);
      }
      
      // Reload pages from the current edition
      this.loadCurrentEdition();
      // Update selected page reference
      this.selectedPage = this.pages.find(p => p.id === this.selectedPage?.id) || null;
      
      console.log('Updated data:', this.dataService.getData());
      
      this.cancelSectionEdit();
      this.toaster.success('Section saved successfully!');
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
      this.dataService.deleteSection(this.selectedPage.id, section.id, this.selectedDate);
      
      // Reload pages from the current edition
      this.loadCurrentEdition();
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

  // Image Cropper
  openImageCropper() {
    if (!this.selectedPage?.fullImage) {
      alert('Please save the page with a full image URL first');
      return;
    }
    this.showImageCropper = true;
    this.cropperImageLoaded = false;
  }

  onCropperImageLoad(event: Event) {
    const img = event.target as HTMLImageElement;
    this.imageNaturalWidth = img.naturalWidth;
    this.imageNaturalHeight = img.naturalHeight;
    this.cropperImageLoaded = true;
    console.log('Image loaded:', { 
      naturalWidth: this.imageNaturalWidth, 
      naturalHeight: this.imageNaturalHeight,
      cropperImageRef: !!this.cropperImageRef 
    });
    this.cdr.detectChanges();
  }

  onCropperMouseDown(event: MouseEvent) {
    console.log('Mouse down event triggered');
    if (!this.cropperImageRef) {
      console.log('cropperImageRef not available');
      return;
    }
    
    const imgRect = this.cropperImageRef.nativeElement.getBoundingClientRect();
    console.log('Image rect:', imgRect);
    
    this.cropperStartX = event.clientX - imgRect.left;
    this.cropperStartY = event.clientY - imgRect.top;
    this.cropperEndX = this.cropperStartX;
    this.cropperEndY = this.cropperStartY;
    this.isDrawing = true;
    
    console.log('Start coordinates:', { x: this.cropperStartX, y: this.cropperStartY });
    this.cdr.detectChanges();
  }

  onCropperMouseMove(event: MouseEvent) {
    if (!this.isDrawing || !this.cropperImageRef) return;
    
    const imgRect = this.cropperImageRef.nativeElement.getBoundingClientRect();
    this.cropperEndX = event.clientX - imgRect.left;
    this.cropperEndY = event.clientY - imgRect.top;
    
    console.log('Move coordinates:', { x: this.cropperEndX, y: this.cropperEndY });
    
    // Only calculate coordinates in real-time, don't generate image yet
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  onCropperMouseUp() {
    if (!this.isDrawing) return;
    console.log('Mouse up - finalizing crop');
    this.isDrawing = false;
    this.calculateCropCoordinates();
    this.cdr.detectChanges();
  }

  calculateCropCoordinates() {
    if (!this.cropperImageRef) return;
    
    const img = this.cropperImageRef.nativeElement;
    const imgWidth = img.clientWidth;
    const imgHeight = img.clientHeight;
    
    // Normalize coordinates
    const x1 = Math.min(this.cropperStartX, this.cropperEndX);
    const y1 = Math.min(this.cropperStartY, this.cropperEndY);
    const x2 = Math.max(this.cropperStartX, this.cropperEndX);
    const y2 = Math.max(this.cropperStartY, this.cropperEndY);
    
    // Convert to percentages and ensure sectionForm is updated
    const newX = Math.round((x1 / imgWidth) * 100);
    const newY = Math.round((y1 / imgHeight) * 100);
    const newWidth = Math.round(((x2 - x1) / imgWidth) * 100);
    const newHeight = Math.round(((y2 - y1) / imgHeight) * 100);
    
    // Update sectionForm coordinates only
    this.sectionForm = {
      ...this.sectionForm,
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight
    };
    
    console.log('Crop coordinates calculated:', { x: newX, y: newY, width: newWidth, height: newHeight });
  }

  async generateAndUploadCroppedImageFromFullSize(fullImageUrl: string) {
    try {
      console.log('Fetching full-size image from:', fullImageUrl);
      console.log('Using crop coordinates (%):', { 
        x: this.sectionForm.x, 
        y: this.sectionForm.y, 
        width: this.sectionForm.width, 
        height: this.sectionForm.height 
      });
      
      // Fetch the full-size image
      const response = await fetch(fullImageUrl);
      const blob = await response.blob();
      
      // Create a new image from the blob
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      
      img.onload = () => {
        try {
          console.log('Full-size image loaded:', img.naturalWidth + 'x' + img.naturalHeight);
          
          // Create canvas
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          if (!ctx) {
            this.toaster.error('Failed to create crop canvas');
            URL.revokeObjectURL(objectUrl);
            return;
          }
          
          // Calculate actual pixel coordinates from percentages
          const cropX = Math.round(((this.sectionForm.x ?? 0) / 100) * img.naturalWidth);
          const cropY = Math.round(((this.sectionForm.y ?? 0) / 100) * img.naturalHeight);
          const cropWidth = Math.round(((this.sectionForm.width ?? 0) / 100) * img.naturalWidth);
          const cropHeight = Math.round(((this.sectionForm.height ?? 0) / 100) * img.naturalHeight);
          
          console.log('Crop area in pixels:', { x: cropX, y: cropY, width: cropWidth, height: cropHeight });
          
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
          console.log('Canvas data URL generated, length:', croppedImageData.length);
          
          // Generate filename
          const safeName = this.sectionForm.title?.replace(/\s+/g, '_').toLowerCase() || 'section';
          const fileName = `${safeName}_${this.sectionForm.x}_${this.sectionForm.y}_${this.sectionForm.width}_${this.sectionForm.height}_${this.sectionForm.id}`;
          
          // Upload to backend
          this.uploadCroppedImage(croppedImageData, fileName);
          
          // Clean up
          URL.revokeObjectURL(objectUrl);
        } catch (error) {
          console.error('Error in canvas operations:', error);
          this.toaster.error('Failed to process cropped image');
          URL.revokeObjectURL(objectUrl);
        }
      };
      
      img.onerror = () => {
        this.toaster.error('Failed to load full-size image for cropping');
        URL.revokeObjectURL(objectUrl);
      };
      
      img.src = objectUrl;
      
    } catch (error) {
      console.error('Error fetching full-size image:', error);
      this.toaster.error('Failed to fetch image: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }

  uploadCroppedImage(imageData: string, fileName: string) {
    const url = `${this.dataService.getApiBaseUrl()}/api/upload-cropped-image`;
    
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ imageData, fileName })
    })
    .then(response => response.json())
    .then(data => {
      if (data.success && data.path) {
        // Update sectionForm with the saved image path
        this.sectionForm = {
          ...this.sectionForm,
          imageUrl: data.path
        };
        this.cdr.detectChanges();
        this.toaster.success('Cropped image saved successfully!');
        console.log('Cropped image saved at:', data.path);
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    })
    .catch(error => {
      console.error('Error uploading cropped image:', error);
      this.toaster.error('Failed to save cropped image. Using auto-crop instead.');
      // Keep coordinates but clear imageUrl for auto-crop
      this.sectionForm = {
        ...this.sectionForm,
        imageUrl: ''
      };
      this.cdr.detectChanges();
    });
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
    console.log('Uploading image, filename:', fileName);
    const url = `${this.dataService.getApiBaseUrl()}/api/upload-image`;
    
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ imageData, fileName })
    })
    .then(response => {
      console.log('Upload response status:', response.status);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      console.log('Upload response data:', data);
      if (data.success && data.path) {
        this.sectionForm = {
          ...this.sectionForm,
          imageUrl: data.path
        };
        this.cdr.detectChanges();
        this.toaster.success('Image uploaded successfully!');
        console.log('Image uploaded at:', data.path);
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    })
    .catch(error => {
      console.error('Error uploading image:', error);
      this.toaster.error('Failed to upload image: ' + error.message);
    });
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
    
    console.log('getCropStyle returning:', style, 'isDrawing:', this.isDrawing, 'cropperEndX:', this.cropperEndX);
    
    return style;
  }

  applyCrop() {
    // Ensure the crop coordinates are calculated one final time
    if (this.cropperEndX > 0 && this.cropperEndY > 0 && this.cropperImageRef && this.selectedPage) {
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
    this.cropperStartX = 0;
    this.cropperStartY = 0;
    this.cropperEndX = 0;
    this.cropperEndY = 0;
  }

  // Data Management
  saveAllData() {
    // Get the latest data from service to ensure we have all changes
    const currentData = this.dataService.getData();
    
    console.log('Saving data to backend:', currentData);
    
    if (!currentData.editions || currentData.editions.length === 0) {
      console.warn('No data to save!');
      this.toaster.warning('No data to save');
      return;
    }
    
    this.dataService.saveData(currentData).subscribe({
      next: (response) => {
        console.log('Save successful:', response);
        this.toaster.success('All data saved successfully!');
        // Ensure local pages are in sync with current edition
        this.loadCurrentEdition();
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

  downloadJSON() {
    this.dataService.downloadJSON();
    this.toaster.success('JSON file downloaded!');
  }

  // Navigation
  goToViewer() {
    this.router.navigate(['/']);
  }

  // Linked Sections Helper
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
      const reader = new FileReader();
      reader.onload = (e: ProgressEvent<FileReader>) => {
        this.pageForm.fullImage = e.target?.result as string;
      };
      reader.readAsDataURL(this.fullImageFile);
    }
  }

  onThumbnailFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.thumbnailFile = input.files[0];
      const reader = new FileReader();
      reader.onload = (e: ProgressEvent<FileReader>) => {
        this.pageForm.thumbnail = e.target?.result as string;
      };
      reader.readAsDataURL(this.thumbnailFile);
    }
  }

  // Global Settings Management
  loadSettings(): void {
    const settings = this.dataService.getSettings();
    this.settingsForm = {
      logo: settings.logo || { url: '', alt: 'Digital Newspaper' },
      socialLinks: settings.socialLinks || {},
      defaultDateMode: settings.defaultDateMode || 'current',
      specificDate: settings.specificDate || ''
    };
  }

  saveSettings(): void {
    // Ensure settings structure is complete
    const completeSettings: GlobalSettings = {
      logo: this.settingsForm.logo || { url: '', alt: 'Digital Newspaper' },
      socialLinks: this.settingsForm.socialLinks || {},
      defaultDateMode: this.settingsForm.defaultDateMode || 'current',
      specificDate: this.settingsForm.specificDate || ''
    };
    
    this.dataService.updateSettings(completeSettings);
    
    // Save to backend
    const currentData = this.dataService.getData();
    console.log('Saving settings:', completeSettings);
    console.log('Complete data structure:', currentData);
    
    this.dataService.saveData(currentData).subscribe({
      next: () => {
        console.log('Settings saved successfully');
        this.toaster.success('Settings saved successfully!');
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
      const reader = new FileReader();
      reader.onload = (e: ProgressEvent<FileReader>) => {
        if (this.settingsForm.logo) {
          this.settingsForm.logo.url = e.target?.result as string;
        }
      };
      reader.readAsDataURL(this.logoFile);
    }
  }
}
