import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';

import {
  NewsSection,
  NewspaperPage,
  GlobalSettings,
} from '../../services/newspaper-data.service';
import { ShareButtonsComponent } from '../../shared/share-buttons/share-buttons.component';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { NormalizeContentPipe } from '../../shared/pipes/normalize-content.pipe';

/**
 * Presentational component that renders both the image modal and the content modal.
 *
 * State is owned entirely by the parent (NewspaperComponent). This component
 * receives everything it needs as @Inputs and emits events for every user action
 * so the parent can update its state consistently.
 *
 * Why a single component for two modals?
 * Both modals share: section data, share-buttons, normalizeContent logic.
 * Keeping them together avoids duplicating those bindings and utilities.
 *
 * Usage:
 *   <app-article-modal
 *     [showImageModal]="showImageModal"
 *     [showContentModal]="showContentModal"
 *     [section]="selectedSection"
 *     ...
 *     (closeImageModal)="closeImageModal()"
 *     (closeContentModal)="closeContentModal()"
 *     ...
 *   />
 */
@Component({
  selector: 'app-article-modal',
  standalone: true,
  imports: [ShareButtonsComponent, TranslatePipe, NormalizeContentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './article-modal.component.html',
  styleUrls: ['./article-modal.component.css'],
})
export class ArticleModalComponent {

  // ── Visibility ────────────────────────────────────────────────────────────

  /** Whether the image gallery modal is visible. */
  @Input() showImageModal = false;
  /** Whether the article content modal is visible. */
  @Input() showContentModal = false;

  // ── Section data ──────────────────────────────────────────────────────────

  /** Currently selected section (used in both modals). */
  @Input() section: NewsSection | null = null;
  /** Page that contains the selected section (for page-number display). */
  @Input() currentPage: NewspaperPage | null = null;

  // ── Image modal state ─────────────────────────────────────────────────────

  /** Primary/first image shown at the top of the image modal. */
  @Input() modalImage: string | null = null;
  /** Alt text for the primary modal image. */
  @Input() modalImageTitle = '';
  /** Additional linked-section images shown below the primary image. */
  @Input() modalLinkedSections: NewsSection[] = [];
  /** Bound method from the parent for resolving a section's cropped image URL. */
  @Input() getCroppedImage: (s: NewsSection) => string | null = () => null;

  // ── Mobile state ──────────────────────────────────────────────────────────

  /** Whether the viewport is currently in mobile/tablet range (≤1024 px). */
  @Input() isMobileView = false;
  /** Which tab is active in the mobile image-modal: 'image' or 'text'. */
  @Input() mobileModalView: 'image' | 'text' = 'image';

  // ── Share-buttons inputs ──────────────────────────────────────────────────

  @Input() selectedDate = '';
  @Input() pageSlug = '';
  @Input() editionSlug = '';
  @Input() logo: GlobalSettings['logo'] | null = null;
  @Input() shareImageUrl = '';
  @Input() siteName = '';

  // ── Outputs ───────────────────────────────────────────────────────────────

  /** Parent should set showImageModal = false. */
  @Output() closeImageModal = new EventEmitter<void>();
  /** Parent should set showContentModal = false. */
  @Output() closeContentModal = new EventEmitter<void>();
  /** Parent should update mobileModalView. */
  @Output() mobileViewChange = new EventEmitter<'image' | 'text'>();
  /** Parent should call printAllModalImages(). */
  @Output() printImages = new EventEmitter<void>();
  /** Parent should call downloadAllModalImages(). */
  @Output() downloadImages = new EventEmitter<void>();
  /** Parent should call printContent(section.content, section.title). */
  @Output() printContent = new EventEmitter<void>();

  // ── Template helpers ──────────────────────────────────────────────────────

  trackByLinkedSectionId(_: number, section: NewsSection): string {
    return section.id;
  }

  onModalImageError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

}
