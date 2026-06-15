import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';

import { NewsSection } from '../../services/newspaper-data.service';

/**
 * Renders the transparent clickable overlays on top of the main page image.
 *
 * Purely presentational — receives sections from the parent smart container
 * (NewspaperComponent) and emits a sectionClick event when the user picks one.
 * The parent is responsible for all selection state and side-effects.
 *
 * Usage:
 *   <app-section-overlay
 *     [sections]="currentPage.sections"
 *     [selectedSectionId]="selectedSection?.id"
 *     (sectionClick)="selectSection($event)"
 *   />
 */
@Component({
  selector: 'app-section-overlay',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sections-overlay">
      @for (section of sections; track trackBySectionId($index, section)) {
        <!-- Skip sections that were imported but never positioned (zero-area crop) -->
        @if (section.width > 0 && section.height > 0) {
          <div
            class="clickable-section"
            [style.left.%]="section.x"
            [style.top.%]="section.y"
            [style.width.%]="section.width"
            [style.height.%]="section.height"
            [class.selected]="selectedSectionId === section.id"
            (click)="sectionClick.emit(section)"
            [title]="section.title"
            >
            <div class="section-label">{{ section.title }}</div>
          </div>
        }
      }
    </div>
    `,
  styles: [`
    .sections-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }

    .clickable-section {
      position: absolute;
      border: 2px solid transparent;
      cursor: pointer;
      transition: all 0.3s ease;
      background-color: rgba(25, 118, 210, 0);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .clickable-section:hover {
      background-color: rgba(25, 118, 210, 0.15);
      border-color: var(--color-primary);
      z-index: 10;
    }

    .clickable-section.selected {
      background-color: rgba(25, 118, 210, 0.25);
      border-color: var(--color-primary-darker);
      border-width: 1px;
    }

    .section-label {
      background-color: rgba(25, 118, 210, 0.9);
      color: var(--color-white);
      padding: 8px 15px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: bold;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
      white-space: nowrap;
      max-width: 90%;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'Google Sans', sans-serif;
    }

    .clickable-section:hover .section-label {
      opacity: 1;
    }
  `],
})
export class SectionOverlayComponent {
  /** All sections for the currently displayed page. */
  @Input() sections: NewsSection[] = [];
  /** ID of the section that is currently highlighted/selected. */
  @Input() selectedSectionId: string | null | undefined = null;
  /** Emitted when the user clicks a section rectangle. */
  @Output() sectionClick = new EventEmitter<NewsSection>();

  trackBySectionId(_: number, section: NewsSection): string {
    return section.id;
  }
}
