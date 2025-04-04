const { MongoClient } = require('mongodb');

class MongoCacheManager {
  /**
   * @param {string} mongoUrl - Connection URL for MongoDB.
   * @param {string} dbName - Database name.
   * @param {string} collectionName - Collection name for caching.
   */
  constructor(mongoUrl, dbName, collectionName = 'cache') {
    this.mongoUrl = mongoUrl;
    this.dbName = dbName;
    this.collectionName = collectionName;
    this.client = new MongoClient(mongoUrl, { useUnifiedTopology: true });
    this.connected = false;
  }

  async connect() {
    if (!this.connected) {
      try {
        await this.client.connect();
        this.collection = this.client.db(this.dbName).collection(this.collectionName);
        this.connected = true;
        console.log("[MongoCache] Connected to MongoDB for caching.");
      } catch (error) {
        console.error("[MongoCache] MongoDB connection error:", error);
        this.connected = false;
      }
    }
  }

  normalize(input) {
    return input.trim().toLowerCase();
  }

  async getCachedResult(input) {
    try {
      await this.connect();
      if (!this.connected || !this.collection) {
        console.error("[MongoCache] Not connected to MongoDB, skipping getCachedResult.");
        return null;
      }
      const key = this.normalize(input);
      const doc = await this.collection.findOne({ key });
      if (doc) {
        console.log("[MongoCache] Found cached result for key:", key);
        return doc.value;
      }
    } catch (error) {
      console.error("[MongoCache] Error retrieving cache for key:", this.normalize(input), error);
    }
    return null;
  }

  async setCache(input, value) {
    try {
      await this.connect();
      if (!this.connected || !this.collection) {
        console.error("[MongoCache] Not connected to MongoDB, skipping setCache.");
        return;
      }
      const key = this.normalize(input);
      const result = await this.collection.updateOne(
        { key },
        { $set: { value, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log("[MongoCache] Stored value for key:", key, "Update result:", result.result);
    } catch (error) {
      console.error("[MongoCache] Error storing cache for key:", this.normalize(input), error);
    }
  }
}

module.exports = MongoCacheManager;
