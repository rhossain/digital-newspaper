import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Meta, Title } from '@angular/platform-browser';
import { ToasterService } from '../../services/toaster.service';
import { TranslationService } from '../../i18n/translation.service';
import { NewsSection } from '../../services/newspaper-data.service';

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
  /** Resolved image URL for the current section (cropped or direct). */
  @Input() imageUrl?: string;
  /** Site name shown in meta tags and as Twitter creator/site. */
  @Input() siteName?: string;

  constructor(
    private toaster: ToasterService,
    private ts: TranslationService,
    private meta: Meta,
    private titleService: Title
  ) {}

  onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  private getShareableUrl(section: NewsSection): string {
    const slug = this.createSectionSlug(section.title, section.id);
    return `${window.location.origin}/${this.selectedDate}/${slug}`;
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

  /** Strip HTML tags and truncate to maxLen characters. */
  private buildDescription(content: string | undefined, maxLen = 155): string {
    if (!content) return '';
    return content
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }

  /** Best image URL: explicit input > section.imageUrl (if external) > empty. */
  private resolvedImageUrl(section: NewsSection): string {
    if (this.imageUrl) return this.imageUrl;
    const img = section.imageUrl?.trim() ?? '';
    return img.startsWith('http://') || img.startsWith('https://') ? img : '';
  }

  /** Update OG + Twitter Card meta tags right before opening the share dialog. */
  private syncMetaTags(section: NewsSection): void {
    const site = this.siteName || this.logo?.alt || 'ইপেপার - দৈনিক সংগ্রাম';
    const pageUrl = this.getShareableUrl(section);
    const description = this.buildDescription(section.content);
    const image = this.resolvedImageUrl(section);

    this.titleService.setTitle(`${section.title} | ${site}`);

    this.meta.updateTag({ property: 'og:site_name',        content: site });
    this.meta.updateTag({ property: 'og:type',             content: 'article' });
    this.meta.updateTag({ property: 'og:title',            content: section.title });
    this.meta.updateTag({ property: 'og:description',      content: description });
    this.meta.updateTag({ property: 'og:url',              content: pageUrl });
    this.meta.updateTag({ property: 'og:image',            content: image });
    this.meta.updateTag({ property: 'og:image:secure_url', content: image });

    this.meta.updateTag({ name: 'twitter:card',        content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:site',        content: site });
    this.meta.updateTag({ name: 'twitter:title',       content: section.title });
    this.meta.updateTag({ name: 'twitter:description', content: description });
    this.meta.updateTag({ name: 'twitter:creator',     content: site });
    this.meta.updateTag({ name: 'twitter:image',       content: image });
  }

  shareOnFacebook(section: NewsSection) {
    this.syncMetaTags(section);
    const url = encodeURIComponent(this.getShareableUrl(section));
    window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank', 'width=600,height=400');
  }

  shareOnTwitter(section: NewsSection) {
    this.syncMetaTags(section);
    const url  = encodeURIComponent(this.getShareableUrl(section));
    const text = encodeURIComponent(section.title);
    window.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, '_blank', 'width=600,height=400');
  }

  shareOnLinkedIn(section: NewsSection) {
    this.syncMetaTags(section);
    const url     = encodeURIComponent(this.getShareableUrl(section));
    const title   = encodeURIComponent(section.title);
    const summary = encodeURIComponent(this.buildDescription(section.content, 120));
    window.open(
      `https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${title}&summary=${summary}`,
      '_blank', 'width=600,height=400'
    );
  }

  shareOnWhatsApp(section: NewsSection) {
    this.syncMetaTags(section);
    const pageUrl = this.getShareableUrl(section);
    const text = encodeURIComponent(`${section.title}\n${pageUrl}`);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
      window.open(`whatsapp://send?text=${text}`, '_blank');
    } else {
      window.open(`https://web.whatsapp.com/send?text=${text}`, '_blank', 'width=600,height=700');
    }
  }

  copyShareLink(section: NewsSection) {
    const url = this.getShareableUrl(section);
    navigator.clipboard.writeText(url).then(() => {
      this.toaster.success(this.ts.t('share.copied'));
    }).catch(() => {
      this.toaster.error(this.ts.t('share.copyFailed'));
    });
  }
}

