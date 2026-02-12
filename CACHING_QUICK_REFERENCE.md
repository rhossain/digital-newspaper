# 🚀 Caching System - Quick Reference

## Quick Start

The caching system is **automatically active** - no configuration needed! It works transparently in the background.

## Key Components

### 1. **CacheService** - Core Storage
```typescript
import { CacheService } from './services/cache.service';

// Get from cache
const data = await cacheService.get<MyType>('my-key', 'data');

// Set in cache (1 hour TTL)
await cacheService.set('my-key', myData, { ttl: 3600000 }, 'data');

// Delete specific key
await cacheService.delete('my-key', 'data');

// Delete by pattern
await cacheService.deletePattern(/^data:page:.*/, 'data');

// Clear all
await cacheService.clear();
```

### 2. **ImageCacheService** - Image Optimization
```typescript
import { ImageCacheService } from './services/image-cache.service';

// Get cached image
imageCacheService.getImage(imageUrl).subscribe(cachedUrl => {
  // Use cachedUrl (blob URL or original)
});

// Preload images
imageCacheService.preloadImages([url1, url2, url3]);

// Clear date images
await imageCacheService.clearDateCache('2026-02-11');
```

### 3. **CacheManagerService** - Smart Invalidation
```typescript
import { CacheManagerService } from './services/cache-manager.service';

// Invalidate date
await cacheManager.invalidateDate('2026-02-11');

// Invalidate page
await cacheManager.invalidatePage(pageId, date);

// Invalidate section
await cacheManager.invalidateSection(sectionId, pageId, date);

// Invalidate settings
await cacheManager.invalidateSettings();

// Preload edition
await cacheManager.preloadEdition(date, pages);
```

## Common Tasks

### Check Cache Health
```typescript
const health = await cacheManager.getCacheHealth();
console.log('Cache health:', health);
```

### Get Cache Statistics
```typescript
const stats = await cacheService.getStats();
console.log('Memory:', stats.memorySize, 'IndexedDB:', stats.dbSize);

const imageStats = await imageCacheService.getCacheStats();
console.log('Images:', imageStats.totalSize / 1024 / 1024, 'MB');
```

### Clear All Cache (Emergency)
```typescript
await cacheManager.invalidateAll();
```

### Manual Maintenance
```typescript
await cacheManager.performMaintenance();
```

## Admin Panel Integration

Cache invalidation happens **automatically** when you:
- Add/update/delete pages
- Add/update/delete sections
- Update global settings

No manual intervention needed!

## Cache Behavior

| Action | Cache Strategy | Speed |
|--------|---------------|-------|
| First visit | Network → Cache | Normal |
| Return visit | Cache → Instant | ⚡ Ultra-fast |
| Admin update | Invalidate affected only | Targeted |
| Date change | Check cache → Preload | Fast |

## Troubleshooting

### Clear Browser Cache
1. Open DevTools (F12)
2. Application tab → Storage
3. Clear IndexedDB "NewspaperCache"
4. Refresh page

### Check Cache in Console
```javascript
// Get all cache info
const debugInfo = await cacheManager.exportCacheDebugInfo();
console.log(JSON.stringify(debugInfo, null, 2));
```

### Performance Issues?
```javascript
// Run maintenance
await cacheManager.performMaintenance();

// Check health and recommendations
const health = await cacheManager.getCacheHealth();
console.log(health.recommendations);
```

## Cache TTLs (Time to Live)

- **Data**: 24 hours
- **Images**: 24 hours
- **Settings**: 24 hours
- **HTTP Responses**: 1 hour
- **Assets**: 24 hours

## Storage Limits

- **Memory Cache**: Browser managed
- **IndexedDB Data**: Unlimited (browser dependent)
- **IndexedDB Images**: 100MB max
- **Auto-eviction**: Enabled (LRU)

## Key Features

✅ Multi-layer caching (Memory + IndexedDB)
✅ Automatic cache-first strategy
✅ Granular invalidation (date/page/section)
✅ Image preloading and optimization
✅ HTTP request deduplication
✅ Offline support (cached content)
✅ Automatic maintenance
✅ Zero configuration needed

## Developer Tips

1. **Always invalidate after updates** (happens automatically)
2. **Use granular invalidation** over clearing all cache
3. **Preload next likely content** for best UX
4. **Monitor cache health** periodically
5. **Test cache behavior** in Network tab (DevTools)

## Need More Info?

See [CACHING_SYSTEM.md](./CACHING_SYSTEM.md) for comprehensive documentation.
