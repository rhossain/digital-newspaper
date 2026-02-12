import { Injectable } from '@angular/core';
import { CacheService, CacheConfig } from './cache.service';
import { Observable, from, of } from 'rxjs';
import { tap, map, catchError } from 'rxjs/operators';

export interface ImageCacheEntry {
  url: string;
  blob: Blob;
  objectUrl: string;
  timestamp: number;
  size: number;
}

export interface ImagePreloadConfig {
  priority?: 'high' | 'medium' | 'low';
  maxConcurrent?: number;
}

/**
 * Dedicated image caching service with blob storage and intelligent preloading
 * Provides optimized image loading and memory management
 */
@Injectable({
  providedIn: 'root'
})
export class ImageCacheService {
  private objectUrlCache = new Map<string, string>();
  private loadingQueue = new Map<string, Promise<string>>();
  private preloadQueue: string[] = [];
  private isPreloading = false;
  
  private readonly MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
  private readonly IMAGE_TTL = 24 * 3600000; // 24 hours
  private currentCacheSize = 0;

  constructor(private cacheService: CacheService) {
    this.initializeCacheSize();
  }

  /**
   * Calculate current cache size
   */
  private async initializeCacheSize(): Promise<void> {
    try {
      const keys = await this.getAllImageKeys();
      this.currentCacheSize = 0;
      
      for (const key of keys) {
        const entry = await this.cacheService.get<ImageCacheEntry>(key, 'images');
        if (entry) {
          this.currentCacheSize += entry.size;
        }
      }
    } catch (error) {
      console.error('Error initializing cache size:', error);
    }
  }

  /**
   * Get image from cache or fetch if not cached
   */
  getImage(url: string): Observable<string> {
    // Check if we already have an object URL in memory
    if (this.objectUrlCache.has(url)) {
      return of(this.objectUrlCache.get(url)!);
    }

    // Check if already loading
    if (this.loadingQueue.has(url)) {
      return from(this.loadingQueue.get(url)!);
    }

    // Start loading
    const loadPromise = this.loadImage(url);
    this.loadingQueue.set(url, loadPromise);

    return from(loadPromise).pipe(
      tap(() => this.loadingQueue.delete(url)),
      catchError(error => {
        this.loadingQueue.delete(url);
        console.error('Error loading image:', url, error);
        return of(url); // Fallback to original URL
      })
    );
  }

  /**
   * Load image from cache or network
   */
  private async loadImage(url: string): Promise<string> {
    try {
      // Try to get from cache
      const cacheKey = this.getCacheKey(url);
      const cachedEntry = await this.cacheService.get<ImageCacheEntry>(cacheKey, 'images');

      if (cachedEntry && cachedEntry.blob) {
        const objectUrl = URL.createObjectURL(cachedEntry.blob);
        this.objectUrlCache.set(url, objectUrl);
        return objectUrl;
      }

      // Fetch from network
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      // Store in cache
      await this.cacheImage(url, blob, objectUrl);

      return objectUrl;
    } catch (error) {
      console.error('Image load error:', error);
      return url; // Return original URL as fallback
    }
  }

  /**
   * Cache image blob
   */
  private async cacheImage(url: string, blob: Blob, objectUrl: string): Promise<void> {
    const size = blob.size;

    // Check if we need to make space
    if (this.currentCacheSize + size > this.MAX_CACHE_SIZE) {
      await this.evictOldestEntries(size);
    }

    const entry: ImageCacheEntry = {
      url,
      blob,
      objectUrl,
      timestamp: Date.now(),
      size
    };

    const cacheKey = this.getCacheKey(url);
    await this.cacheService.set(cacheKey, entry, {
      ttl: this.IMAGE_TTL,
      storage: 'indexeddb'
    }, 'images');

    this.objectUrlCache.set(url, objectUrl);
    this.currentCacheSize += size;
  }

  /**
   * Preload multiple images
   */
  preloadImages(urls: string[], config: ImagePreloadConfig = {}): void {
    const maxConcurrent = config.maxConcurrent || 3;
    
    // Add to preload queue
    for (const url of urls) {
      if (!this.objectUrlCache.has(url) && !this.preloadQueue.includes(url)) {
        this.preloadQueue.push(url);
      }
    }

    // Start preloading if not already running
    if (!this.isPreloading && this.preloadQueue.length > 0) {
      this.processPreloadQueue(maxConcurrent);
    }
  }

  /**
   * Process preload queue
   */
  private async processPreloadQueue(maxConcurrent: number): Promise<void> {
    this.isPreloading = true;

    while (this.preloadQueue.length > 0) {
      const batch = this.preloadQueue.splice(0, maxConcurrent);
      
      await Promise.allSettled(
        batch.map(url => this.loadImage(url))
      );
    }

    this.isPreloading = false;
  }

  /**
   * Preload images for a specific date's edition
   */
  async preloadEditionImages(date: string, pages: any[]): Promise<void> {
    const imageUrls: string[] = [];

    // Collect all image URLs from pages
    for (const page of pages) {
      if (page.thumbnail) imageUrls.push(page.thumbnail);
      if (page.fullImage) imageUrls.push(page.fullImage);
      
      if (page.sections) {
        for (const section of page.sections) {
          if (section.imageUrl) imageUrls.push(section.imageUrl);
        }
      }
    }

    // Preload in batches
    this.preloadImages(imageUrls, { maxConcurrent: 4 });
  }

  /**
   * Clear cache for specific date
   */
  async clearDateCache(date: string): Promise<void> {
    const pattern = new RegExp(`^image:.*date=${date}`);
    await this.cacheService.deletePattern(pattern, 'images');
    
    // Clear object URLs from memory
    for (const [url, objectUrl] of this.objectUrlCache.entries()) {
      if (url.includes(`date=${date}`) || url.includes(date)) {
        URL.revokeObjectURL(objectUrl);
        this.objectUrlCache.delete(url);
      }
    }
  }

  /**
   * Clear cache for specific page
   */
  async clearPageCache(pageId: number): Promise<void> {
    const pattern = new RegExp(`^image:.*pageId=${pageId}`);
    await this.cacheService.deletePattern(pattern, 'images');
    
    // Clear object URLs from memory
    for (const [url, objectUrl] of this.objectUrlCache.entries()) {
      if (url.includes(`pageId=${pageId}`)) {
        URL.revokeObjectURL(objectUrl);
        this.objectUrlCache.delete(url);
      }
    }
  }

  /**
   * Clear all image cache
   */
  async clearAll(): Promise<void> {
    await this.cacheService.clear('images');
    
    // Revoke all object URLs
    for (const objectUrl of this.objectUrlCache.values()) {
      URL.revokeObjectURL(objectUrl);
    }
    
    this.objectUrlCache.clear();
    this.currentCacheSize = 0;
  }

  /**
   * Evict oldest entries to make space
   */
  private async evictOldestEntries(requiredSpace: number): Promise<void> {
    const keys = await this.getAllImageKeys();
    const entries: Array<{ key: string; timestamp: number; size: number }> = [];

    // Get all entries with timestamps
    for (const key of keys) {
      const entry = await this.cacheService.get<ImageCacheEntry>(key, 'images');
      if (entry) {
        entries.push({ key, timestamp: entry.timestamp, size: entry.size });
      }
    }

    // Sort by timestamp (oldest first)
    entries.sort((a, b) => a.timestamp - b.timestamp);

    // Evict until we have enough space
    let freedSpace = 0;
    for (const entry of entries) {
      if (freedSpace >= requiredSpace) break;

      await this.cacheService.delete(entry.key, 'images');
      
      // Revoke object URL
      const cachedEntry = await this.cacheService.get<ImageCacheEntry>(entry.key, 'images');
      if (cachedEntry) {
        this.objectUrlCache.delete(cachedEntry.url);
        if (cachedEntry.objectUrl) {
          URL.revokeObjectURL(cachedEntry.objectUrl);
        }
      }

      freedSpace += entry.size;
      this.currentCacheSize -= entry.size;
    }
  }

  /**
   * Get all image cache keys
   */
  private async getAllImageKeys(): Promise<string[]> {
    const stats = await this.cacheService.getStats();
    return stats.dbKeys.filter(key => key.startsWith('image:'));
  }

  /**
   * Generate cache key for image URL
   */
  private getCacheKey(url: string): string {
    return `image:${url}`;
  }

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<{
    totalSize: number;
    itemCount: number;
    maxSize: number;
    utilization: number;
  }> {
    const keys = await this.getAllImageKeys();
    
    return {
      totalSize: this.currentCacheSize,
      itemCount: keys.length,
      maxSize: this.MAX_CACHE_SIZE,
      utilization: (this.currentCacheSize / this.MAX_CACHE_SIZE) * 100
    };
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    // Revoke all object URLs
    for (const objectUrl of this.objectUrlCache.values()) {
      URL.revokeObjectURL(objectUrl);
    }
    this.objectUrlCache.clear();
  }
}
