import { Component, Input, Output, EventEmitter, Inject, PLATFORM_ID, ChangeDetectionStrategy } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Meta, Title } from '@angular/platform-browser';
import { ToasterService } from '../../services/toaster.service';
import { TranslationService } from '../../i18n/translation.service';
import { NewsSection } from '../../services/newspaper-data.service';

@Component({
  selector: 'app-share-buttons',
  standalone: true,
  imports: [],
  templateUrl: './share-buttons.component.html',
  styleUrl: './share-buttons.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShareButtonsComponent {
  @Input() section!: NewsSection;
  @Input() selectedDate!: string;
  @Input() logo?: { url: string; alt?: string };
  /** Resolved image URL for the current section (cropped or direct). */
  @Input() imageUrl?: string;
  /** Site name shown in meta tags and as Twitter creator/site. */
  @Input() siteName?: string;
  @Input() showPrint = false;
  @Input() showDownload = false;
  @Input() pageSlug: string = '';
  @Input() editionSlug: string = '';
  @Output() printClicked = new EventEmitter<void>();
  @Output() downloadClicked = new EventEmitter<void>();

  private readonly isBrowser: boolean;

  constructor(
    private toaster: ToasterService,
    protected ts: TranslationService,
    private meta: Meta,
    private titleService: Title,
    @Inject(DOCUMENT) private document: Document,
    @Inject(PLATFORM_ID) platformId: object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  onLogoError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  private getShareableUrl(section: NewsSection): string {
    const sectionSlug = this.createSectionSlug(section.title, section.id);
    // Use the injected DOCUMENT token so this method is safe in SSR context.
    const loc = this.document.location;
    const pathParts = loc?.pathname?.split('/').filter(Boolean) ?? [];

    const date = (this.selectedDate || pathParts[0] || '').trim();
    const page = (this.pageSlug || pathParts[1] || '').trim();
    const edition = (this.editionSlug || pathParts[2] || '').trim();

    if (!date || !page || !edition) {
      // Fallback to current URL when required segments are unavailable.
      return loc?.href ?? '';
    }

    return `${loc?.origin ?? ''}/${date}/${page}/${edition}/${sectionSlug}/`;
  }

  private createSectionSlug(_: string, sectionId: string): string {
    const rawId = (sectionId || '').trim();
    if (!rawId) return 'post-unknown';
    if (rawId.startsWith('post-')) return rawId;
    return rawId.startsWith('section-')
      ? 'post-' + rawId.slice('section-'.length)
      : `post-${rawId}`;
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
    if (!this.isBrowser) return;
    this.syncMetaTags(section);
    const url = encodeURIComponent(this.getShareableUrl(section));
    this.document.defaultView?.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank', 'width=600,height=400');
  }

  shareOnTwitter(section: NewsSection) {
    if (!this.isBrowser) return;
    this.syncMetaTags(section);
    const url  = encodeURIComponent(this.getShareableUrl(section));
    const text = encodeURIComponent(section.title);
    this.document.defaultView?.open(`https://twitter.com/intent/tweet?url=${url}&text=${text}`, '_blank', 'width=600,height=400');
  }

  shareOnLinkedIn(section: NewsSection) {
    if (!this.isBrowser) return;
    this.syncMetaTags(section);
    const url     = encodeURIComponent(this.getShareableUrl(section));
    const title   = encodeURIComponent(section.title);
    const summary = encodeURIComponent(this.buildDescription(section.content, 120));
    this.document.defaultView?.open(
      `https://www.linkedin.com/shareArticle?mini=true&url=${url}&title=${title}&summary=${summary}`,
      '_blank', 'width=600,height=400'
    );
  }

  shareOnWhatsApp(section: NewsSection) {
    if (!this.isBrowser) return;
    this.syncMetaTags(section);
    const pageUrl = this.getShareableUrl(section);
    const text = encodeURIComponent(`${section.title}\n${pageUrl}`);
    const win = this.document.defaultView;
    const ua = win?.navigator?.userAgent ?? '';
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    if (isMobile) {
      win?.open(`whatsapp://send?text=${text}`, '_blank');
    } else {
      win?.open(`https://web.whatsapp.com/send?text=${text}`, '_blank', 'width=600,height=700');
    }
  }

  copyShareLink(section: NewsSection) {
    if (!this.isBrowser) return;
    const url = this.getShareableUrl(section);
    this.document.defaultView?.navigator.clipboard.writeText(url).then(() => {
      this.toaster.success(this.ts.t('share.copied'));
    }).catch(() => {
      this.toaster.error(this.ts.t('share.copyFailed'));
    });
  }
}

