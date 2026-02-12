import { Injectable } from '@angular/core';
import { Observable, of, from } from 'rxjs';
import { tap, catchError, map } from 'rxjs/operators';

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
  version: string;
}

export interface CacheConfig {
  ttl?: number; // Time to live in milliseconds (default: 1 hour)
  storage?: 'memory' | 'indexeddb' | 'both'; // Storage type
  version?: string; // Cache version for invalidation
}

/**
 * Multi-layer caching service with memory (fast) and IndexedDB (persistent) storage
 * Provides granular cache management for optimal performance
 */
@Injectable({
  providedIn: 'root'
})
export class CacheService {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private dbName = 'NewspaperCache';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private dbReady: Promise<void>;
  
  private readonly DEFAULT_TTL = 3600000; // 1 hour
  private readonly CACHE_VERSION = '1.0.0';

  constructor() {
    this.dbReady = this.initDB();
  }

  /**
   * Initialize IndexedDB
   */
  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('Failed to open IndexedDB');
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('IndexedDB initialized successfully');
        resolve();
      };

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        
        // Create object stores for different cache types
        if (!db.objectStoreNames.contains('data')) {
          db.createObjectStore('data', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * Get data from cache
   */
  async get<T>(key: string, storeName: string = 'data'): Promise<T | null> {
    // Try memory cache first (fastest)
    const memoryEntry = this.memoryCache.get(key);
    if (memoryEntry && this.isValid(memoryEntry)) {
      return memoryEntry.data as T;
    }

    // Try IndexedDB (persistent)
    try {
      await this.dbReady;
      if (!this.db) return null;

      const entry = await this.getFromDB<T>(key, storeName);
      if (entry && this.isValid(entry)) {
        // Restore to memory cache
        this.memoryCache.set(key, entry);
        return entry.data;
      }
    } catch (error) {
      console.error('Cache get error:', error);
    }

    return null;
  }

  /**
   * Set data in cache
   */
  async set<T>(
    key: string, 
    data: T, 
    config: CacheConfig = {},
    storeName: string = 'data'
  ): Promise<void> {
    const ttl = config.ttl || this.DEFAULT_TTL;
    const version = config.version || this.CACHE_VERSION;
    const storage = config.storage || 'both';
    
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      expiresAt: Date.now() + ttl,
      version
    };

    // Store in memory cache
    if (storage === 'memory' || storage === 'both') {
      this.memoryCache.set(key, entry);
    }

    // Store in IndexedDB
    if (storage === 'indexeddb' || storage === 'both') {
      try {
        await this.dbReady;
        await this.setInDB(key, entry, storeName);
      } catch (error) {
        console.error('Cache set error:', error);
      }
    }
  }

  /**
   * Delete specific cache entry
   */
  async delete(key: string, storeName: string = 'data'): Promise<void> {
    this.memoryCache.delete(key);
    
    try {
      await this.dbReady;
      await this.deleteFromDB(key, storeName);
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  /**
   * Delete entries matching pattern
   */
  async deletePattern(pattern: RegExp, storeName: string = 'data'): Promise<void> {
    // Clear from memory
    for (const key of this.memoryCache.keys()) {
      if (pattern.test(key)) {
        this.memoryCache.delete(key);
      }
    }

    // Clear from IndexedDB
    try {
      await this.dbReady;
      const keys = await this.getAllKeysFromDB(storeName);
      for (const key of keys) {
        if (pattern.test(key)) {
          await this.deleteFromDB(key, storeName);
        }
      }
    } catch (error) {
      console.error('Cache deletePattern error:', error);
    }
  }

  /**
   * Clear all cache
   */
  async clear(storeName?: string): Promise<void> {
    if (!storeName) {
      this.memoryCache.clear();
    }

    try {
      await this.dbReady;
      if (storeName) {
        await this.clearStore(storeName);
      } else {
        await this.clearStore('data');
        await this.clearStore('images');
        await this.clearStore('metadata');
      }
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    memorySize: number;
    dbSize: number;
    memoryKeys: string[];
    dbKeys: string[];
  }> {
    const memoryKeys = Array.from(this.memoryCache.keys());
    
    try {
      await this.dbReady;
      const dataKeys = await this.getAllKeysFromDB('data');
      const imageKeys = await this.getAllKeysFromDB('images');
      const metadataKeys = await this.getAllKeysFromDB('metadata');
      
      return {
        memorySize: memoryKeys.length,
        dbSize: dataKeys.length + imageKeys.length + metadataKeys.length,
        memoryKeys,
        dbKeys: [...dataKeys, ...imageKeys, ...metadataKeys]
      };
    } catch (error) {
      return {
        memorySize: memoryKeys.length,
        dbSize: 0,
        memoryKeys,
        dbKeys: []
      };
    }
  }

  /**
   * Clean expired entries
   */
  async cleanExpired(): Promise<void> {
    const now = Date.now();
    
    // Clean memory cache
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt < now) {
        this.memoryCache.delete(key);
      }
    }

    // Clean IndexedDB
    try {
      await this.dbReady;
      await this.cleanExpiredFromStore('data');
      await this.cleanExpiredFromStore('images');
      await this.cleanExpiredFromStore('metadata');
    } catch (error) {
      console.error('Clean expired error:', error);
    }
  }

  // Private helper methods

  private isValid(entry: CacheEntry<any>): boolean {
    return entry.expiresAt > Date.now();
  }

  private getFromDB<T>(key: string, storeName: string): Promise<CacheEntry<T> | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve(null);
        return;
      }

      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result : null);
      };

      request.onerror = () => reject(request.error);
    });
  }

  private setInDB(key: string, entry: CacheEntry<any>, storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put({ key, ...entry });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private deleteFromDB(key: string, storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private getAllKeysFromDB(storeName: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        resolve([]);
        return;
      }

      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();

      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }

  private clearStore(storeName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Database not initialized'));
        return;
      }

      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async cleanExpiredFromStore(storeName: string): Promise<void> {
    if (!this.db) return;

    const keys = await this.getAllKeysFromDB(storeName);
    const now = Date.now();

    for (const key of keys) {
      const entry = await this.getFromDB(key, storeName);
      if (entry && entry.expiresAt < now) {
        await this.deleteFromDB(key, storeName);
      }
    }
  }
}
