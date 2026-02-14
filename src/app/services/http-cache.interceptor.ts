/*
import { Injectable } from '@angular/core';
import { HttpEvent, HttpInterceptor, HttpHandler, HttpRequest, HttpResponse } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap, shareReplay } from 'rxjs/operators';
import { CacheService } from './cache.service';

/**
 * HTTP Cache Interceptor for automatic request/response caching
 * Intelligently caches API responses with configurable TTL
 */
@Injectable()
export class HttpCacheInterceptor implements HttpInterceptor {
  private inFlightRequests = new Map<string, Observable<HttpEvent<any>>>();

  constructor(private cacheService: CacheService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Only cache GET requests
    if (req.method !== 'GET') {
      return next.handle(req);
    }

    // Check if request should be cached
    if (!this.isCacheable(req)) {
      return next.handle(req);
    }

    // Generate cache key
    const cacheKey = this.generateCacheKey(req);

    // Check if request is already in flight
    if (this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey)!;
    }

    // Try to get from cache
    return new Observable(observer => {
      this.cacheService.get<HttpResponse<any>>(cacheKey, 'data').then(cachedResponse => {
        if (cachedResponse) {
          // Return cached response
          observer.next(cachedResponse);
          observer.complete();
        } else {
          // Make actual request
          const request$ = next.handle(req).pipe(
            tap(event => {
              if (event instanceof HttpResponse) {
                // Cache successful response
                const ttl = this.getTTL(req);
                this.cacheService.set(cacheKey, event, { ttl }, 'data');
              }
            }),
            shareReplay(1)
          );

          // Store in-flight request
          this.inFlightRequests.set(cacheKey, request$);

          // Subscribe and forward events
          request$.subscribe({
            next: event => observer.next(event),
            error: err => {
              this.inFlightRequests.delete(cacheKey);
              observer.error(err);
            },
            complete: () => {
              this.inFlightRequests.delete(cacheKey);
              observer.complete();
            }
          });
        }
      }).catch(error => {
        console.error('Cache get error:', error);
        // Fallback to network request
        next.handle(req).subscribe(observer);
      });
    });
  }

  /**
   * Check if request should be cached
   */
  private isCacheable(req: HttpRequest<any>): boolean {
    // Don't cache if explicitly disabled
    if (req.headers.has('X-No-Cache')) {
      return false;
    }

    // Cache API requests
    if (req.url.includes('/api/')) {
      return true;
    }

    // Cache asset requests
    if (req.url.includes('/assets/')) {
      return true;
    }

    return false;
  }

  /**
   * Generate cache key from request
   */
  private generateCacheKey(req: HttpRequest<any>): string {
    const url = req.urlWithParams;
    return `http:${url}`;
  }

  /**
   * Get TTL for request
   */
  private getTTL(req: HttpRequest<any>): number {
    // Check for custom TTL header
    const customTTL = req.headers.get('X-Cache-TTL');
    if (customTTL) {
      return parseInt(customTTL, 10);
    }

    // Default TTLs based on URL patterns
    if (req.url.includes('/api/newspaper-data')) {
      return 3600000; // 1 hour for newspaper data
    }

    if (req.url.includes('/assets/')) {
      return 86400000; // 24 hours for assets
    }

    return 1800000; // 30 minutes default
  }
}
*/
