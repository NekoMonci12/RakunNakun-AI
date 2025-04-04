const CacheManagerRedis = require('./cacheManagerRedis');
const MongoCacheManager = require('./mongoCacheManager');

class HybridCacheManager {
  /**
   * @param {object} redisOptions - Options for Redis.
   * @param {string} mongoUrl - Connection URL for MongoDB.
   * @param {string} dbName - MongoDB database name.
   * @param {string} collectionName - MongoDB collection name for cache.
   */
  constructor(redisOptions = {}, mongoUrl, dbName, collectionName = 'cache') {
    this.redisCache = new CacheManagerRedis(redisOptions);
    this.mongoCache = new MongoCacheManager(mongoUrl, dbName, collectionName);
  }

  async getCachedResult(input) {
    // Try Redis first.
    let result = await this.redisCache.getCachedResult(input);
    if (result) {
      console.log("Hybrid Cache: Found result in Redis.");
      return result;
    }
    // If not in Redis, try MongoDB.
    result = await this.mongoCache.getCachedResult(input);
    if (result) {
      console.log("Hybrid Cache: Found result in MongoDB.");
      // Optionally, refresh Redis cache.
      await this.redisCache.setCache(input, result);
      return result;
    }
    console.log("Hybrid Cache: No cached result found.");
    return null;
  }

  async setCache(input, value) {
    await this.redisCache.setCache(input, value);
    await this.mongoCache.setCache(input, value);
    console.log("Hybrid Cache: Stored value in both caches for key:", input);
  }
}

module.exports = HybridCacheManager;
