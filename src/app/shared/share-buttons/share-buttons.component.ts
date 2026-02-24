import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToasterService } from '../../services/toaster.service';

interface NewsSection {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  content?: string;
  linkedSections?: string[];
  showCaption?: boolean;
  pageId?: number;
}

@Component({
  selector: 'app-share-buttons',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './share-buttons.component.html',
  styleUrl: './share-buttons.component.css'
})
export class ShareButtonsComponent {
  @Input() section!: NewsSection;
  @Input() selectedDate!: string;
  @Input() logo?: { url: string; alt?: string };

  constructor(private toaster: ToasterService) {}

  private getShareableUrl(section: NewsSection): string {
    const baseUrl = window.location.origin;
    // Use title-based slug with section ID fallback
    const slug = this.createSectionSlug(section.title, section.id);
    return `${baseUrl}/${this.selectedDate}/${slug}`;
  }

  private getEncodedShareableUrl(section: NewsSection): string {
    const baseUrl = window.location.origin;
    // Use title-based slug with section ID fallback
    const slug = this.createSectionSlug(section.title, section.id);
    return `${baseUrl}/${this.selectedDate}/${slug}`;
  }

  private createSectionSlug(title: string, sectionId: string): string {
    if (!title) return sectionId;
    
    // Convert to lowercase and replace spaces with hyphens
    // Keep Bengali/Unicode characters (U+0980-U+09FF for Bengali)
    let slug = title.toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\u0980-\u09FF-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    
    // If slug is empty or only hyphens after processing, use section ID
    if (!slug || slug.match(/^-+$/)) {
      return sectionId;
    }
    
    return slug;
  }

  shareOnFacebook(section: NewsSection) {
    const url = this.getEncodedShareableUrl(section);
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank', 'width=600,height=400');
  }

  shareOnTwitter(section: NewsSection) {
    const url = this.getEncodedShareableUrl(section);
    window.open(`https://twitter.com/intent/tweet?url=${url}`, '_blank', 'width=600,height=400');
  }

  shareOnLinkedIn(section: NewsSection) {
    const url = this.getEncodedShareableUrl(section);
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank', 'width=600,height=400');
  }

  shareOnWhatsApp(section: NewsSection) {
    const url = this.getEncodedShareableUrl(section);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
      window.open(`whatsapp://send?text=${encodeURIComponent(url)}`, '_blank');
    } else {
      window.open(`https://web.whatsapp.com/send?text=${encodeURIComponent(url)}`, '_blank');
    }
  }

  copyShareLink(section: NewsSection) {
    const url = this.getShareableUrl(section);
    navigator.clipboard.writeText(url).then(() => {
      this.toaster.success('Link copied to clipboard!');
    }).catch(() => {
      this.toaster.error('Failed to copy link');
    });
  }
}
