/*
import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NewspaperPage } from '../services/newspaper-data.service';
import { ImageCacheService } from '../services/image-cache.service';

// Newspaper page thumbnail component
// Optimized for caching and performance with OnPush change detection
@Component({
  selector: 'app-newspaper-page-thumbnail',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-thumbnail" 
         [class.active]="isActive"
         (click)="onPageClick()">
      <img 
        [src]="cachedThumbnail || page.thumbnail" 
        [alt]="'Page ' + page.id"
        (load)="onImageLoad()"
        (error)="onImageError()"
        loading="lazy">
      <div class="page-number">{{ page.id }}</div>
      <div class="loading-indicator" *ngIf="loading">
        <span>Loading...</span>
      </div>
    </div>
  `,
  styles: [`
    .page-thumbnail {
      position: relative;
      cursor: pointer;
      border: 2px solid transparent;
      border-radius: 4px;
      overflow: hidden;
      transition: all 0.3s ease;
      background: #f5f5f5;
    }

    .page-thumbnail:hover {
      border-color: #007bff;
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    .page-thumbnail.active {
      border-color: #007bff;
      box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25);
    }

    .page-thumbnail img {
      width: 100%;
      height: auto;
      display: block;
      transition: opacity 0.3s ease;
    }

    .page-number {
      position: absolute;
      bottom: 8px;
      right: 8px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }

    .loading-indicator {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.9);
      font-size: 12px;
      color: #666;
    }
  `]
})
export class NewspaperPageThumbnailComponent {
  @Input() page!: NewspaperPage;
  @Input() isActive: boolean = false;
  @Output() pageSelected = new EventEmitter<NewspaperPage>();

  cachedThumbnail: string | null = null;
  loading: boolean = true;

  constructor(private imageCacheService: ImageCacheService) {}

  ngOnInit() {
    // Preload thumbnail from cache
    if (this.page.thumbnail) {
      this.imageCacheService.getImage(this.page.thumbnail).subscribe(
        url => {
          this.cachedThumbnail = url;
        }
      );
    }
  }

  onPageClick() {
    this.pageSelected.emit(this.page);
  }

  onImageLoad() {
    this.loading = false;
  }

  onImageError() {
    this.loading = false;
    console.error('Failed to load thumbnail for page', this.page.id);
  }
}
*/
