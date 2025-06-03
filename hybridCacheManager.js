// hybridCacheManager.js

const MongoCacheManager = require('./mongoCacheManager');

class HybridCacheManager {
  /**
   * @param {string} mongoUrl - Connection URL for MongoDB.
   * @param {string} dbName - MongoDB database name.
   * @param {string} collectionName - MongoDB collection name for cache.
   */
  constructor(mongoUrl, dbName, collectionName = 'cache') {
    this.mongoCache = new MongoCacheManager(mongoUrl, dbName, collectionName);
  }

  async getCachedResult(input) {
    let result = await this.mongoCache.getCachedResult(input);
    if (result) {
      console.log("Hybrid Cache: Found result in MongoDB.");
      return result;
    }
    console.log("Hybrid Cache: No cached result found.");
    return null;
  }

  async setCache(input, value) {
    await this.mongoCache.setCache(input, value);
    console.log("Hybrid Cache: Stored value in both caches for key:", input);
  }
}

module.exports = HybridCacheManager;
