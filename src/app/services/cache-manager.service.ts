import { Injectable } from '@angular/core';
import { CacheService } from './cache.service';
import { ImageCacheService } from './image-cache.service';
import { Subject } from 'rxjs';

export interface CacheInvalidationEvent {
  type: 'date' | 'page' | 'section' | 'settings' | 'all';
  date?: string;
  pageId?: number;
  sectionId?: string;
  timestamp: number;
}

/**
 * Cache manager service for granular cache invalidation
 * Coordinates between different cache layers and provides smart invalidation
 */
@Injectable({
  providedIn: 'root'
})
export class CacheManagerService {
  // Event stream for cache invalidations
  public cacheInvalidated$ = new Subject<CacheInvalidationEvent>();

  constructor(
    private cacheService: CacheService,
    private imageCacheService: ImageCacheService
  ) {}

  /**
   * Invalidate cache for a specific date
   * Only clears data related to that date, preserving other dates
   */
  async invalidateDate(date: string): Promise<void> {
    console.log(`Invalidating cache for date: ${date}`);

    // Clear data cache for this date
    await this.cacheService.deletePattern(
      new RegExp(`^(data|metadata):.*date[=:]${date}`),
      'data'
    );

    // Clear image cache for this date
    await this.imageCacheService.clearDateCache(date);

    // Emit invalidation event
    this.cacheInvalidated$.next({
      type: 'date',
      date,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate cache for a specific page
   * Only clears data related to that page
   */
  async invalidatePage(pageId: number, date?: string): Promise<void> {
    console.log(`Invalidating cache for page: ${pageId}`);

    // Clear data cache for this page
    const datePattern = date ? `date[=:]${date}` : '[^:]*';
    await this.cacheService.deletePattern(
      new RegExp(`^(data|metadata):.*${datePattern}.*page[=:]${pageId}`),
      'data'
    );

    // Clear image cache for this page
    await this.imageCacheService.clearPageCache(pageId);

    // Emit invalidation event
    this.cacheInvalidated$.next({
      type: 'page',
      pageId,
      date,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate cache for a specific section
   * Only clears data related to that section
   */
  async invalidateSection(sectionId: string, pageId: number, date?: string): Promise<void> {
    console.log(`Invalidating cache for section: ${sectionId}`);

    // Clear data cache for this section
    const datePattern = date ? `date[=:]${date}` : '[^:]*';
    await this.cacheService.deletePattern(
      new RegExp(`^(data|metadata):.*${datePattern}.*page[=:]${pageId}.*section[=:]${sectionId}`),
      'data'
    );

    // Note: We don't clear page images, only section-specific cache

    // Emit invalidation event
    this.cacheInvalidated$.next({
      type: 'section',
      sectionId,
      pageId,
      date,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate global settings cache
   * Only clears settings, not content
   */
  async invalidateSettings(): Promise<void> {
    console.log('Invalidating settings cache');

    // Clear settings from data cache
    await this.cacheService.deletePattern(
      new RegExp('^(data|metadata):.*settings'),
      'data'
    );

    // Clear settings metadata
    await this.cacheService.delete('metadata:global-settings', 'metadata');

    // Emit invalidation event
    this.cacheInvalidated$.next({
      type: 'settings',
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate entire cache
   * Use sparingly - prefer granular invalidation
   */
  async invalidateAll(): Promise<void> {
    console.log('Invalidating all cache');

    // Clear all cache layers
    await this.cacheService.clear();
    await this.imageCacheService.clearAll();

    // Emit invalidation event
    this.cacheInvalidated$.next({
      type: 'all',
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate cache when a page is added
   */
  async onPageAdded(pageId: number, date: string): Promise<void> {
    // Invalidate the date's edition list and metadata
    await this.cacheService.delete(`data:edition:${date}`, 'data');
    await this.cacheService.delete(`metadata:edition:${date}`, 'metadata');
    
    console.log(`Cache updated for new page ${pageId} on ${date}`);
  }

  /**
   * Invalidate cache when a page is updated
   */
  async onPageUpdated(pageId: number, date: string): Promise<void> {
    await this.invalidatePage(pageId, date);
    
    // Also invalidate the edition cache
    await this.cacheService.delete(`data:edition:${date}`, 'data');
  }

  /**
   * Invalidate cache when a page is deleted
   */
  async onPageDeleted(pageId: number, date: string): Promise<void> {
    await this.invalidatePage(pageId, date);
    
    // Also invalidate the edition cache
    await this.cacheService.delete(`data:edition:${date}`, 'data');
  }

  /**
   * Invalidate cache when a section is added
   */
  async onSectionAdded(sectionId: string, pageId: number, date: string): Promise<void> {
    // Invalidate the page cache
    await this.cacheService.delete(`data:page:${date}:${pageId}`, 'data');
    await this.cacheService.delete(`metadata:page:${date}:${pageId}`, 'metadata');
  }

  /**
   * Invalidate cache when a section is updated
   */
  async onSectionUpdated(sectionId: string, pageId: number, date: string): Promise<void> {
    await this.invalidateSection(sectionId, pageId, date);
    
    // Also invalidate the page cache
    await this.cacheService.delete(`data:page:${date}:${pageId}`, 'data');
  }

  /**
   * Invalidate cache when a section is deleted
   */
  async onSectionDeleted(sectionId: string, pageId: number, date: string): Promise<void> {
    await this.invalidateSection(sectionId, pageId, date);
    
    // Also invalidate the page cache
    await this.cacheService.delete(`data:page:${date}:${pageId}`, 'data');
  }

  /**
   * Invalidate cache when settings are updated
   */
  async onSettingsUpdated(): Promise<void> {
    await this.invalidateSettings();
    
    // If logo or social links changed, we might want to invalidate related assets
    await this.cacheService.deletePattern(
      new RegExp('^metadata:.*logo'),
      'metadata'
    );
  }

  /**
   * Preload cache for optimal performance
   */
  async preloadEdition(date: string, pages: any[]): Promise<void> {
    console.log(`Preloading cache for edition: ${date}`);

    // Store edition data
    await this.cacheService.set(
      `data:edition:${date}`,
      { date, pages },
      { ttl: 24 * 3600000 }, // 24 hours
      'data'
    );

    // Preload individual pages
    for (const page of pages) {
      await this.cacheService.set(
        `data:page:${date}:${page.id}`,
        page,
        { ttl: 24 * 3600000 },
        'data'
      );
    }

    // Preload images
    await this.imageCacheService.preloadEditionImages(date, pages);

    console.log(`Preloading complete for ${date}`);
  }

  /**
   * Get cache health statistics
   */
  async getCacheHealth(): Promise<{
    dataCache: any;
    imageCache: any;
    recommendations: string[];
  }> {
    const dataStats = await this.cacheService.getStats();
    const imageStats = await this.imageCacheService.getCacheStats();
    
    const recommendations: string[] = [];

    // Check if cache is healthy
    if (imageStats.utilization > 90) {
      recommendations.push('Image cache is over 90% full. Consider clearing old entries.');
    }

    if (dataStats.memorySize > 100) {
      recommendations.push('Memory cache has many entries. Performance is optimal.');
    }

    if (dataStats.dbSize === 0) {
      recommendations.push('No persistent cache found. Data will be fetched on every load.');
    }

    return {
      dataCache: dataStats,
      imageCache: imageStats,
      recommendations
    };
  }

  /**
   * Perform cache maintenance
   */
  async performMaintenance(): Promise<void> {
    console.log('Performing cache maintenance...');

    // Clean expired entries
    await this.cacheService.cleanExpired();

    // Check image cache size and evict if needed
    const imageStats = await this.imageCacheService.getCacheStats();
    if (imageStats.utilization > 85) {
      console.log('Image cache utilization high, cleaning up...');
      // The image cache service will automatically evict oldest entries
    }

    console.log('Cache maintenance complete');
  }

  /**
   * Export cache for debugging
   */
  async exportCacheDebugInfo(): Promise<any> {
    const health = await this.getCacheHealth();
    
    return {
      timestamp: new Date().toISOString(),
      health,
      memoryUsage: {
        jsHeapSizeLimit: (performance as any).memory?.jsHeapSizeLimit || 'N/A',
        totalJSHeapSize: (performance as any).memory?.totalJSHeapSize || 'N/A',
        usedJSHeapSize: (performance as any).memory?.usedJSHeapSize || 'N/A'
      }
    };
  }
}
