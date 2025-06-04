require('dotenv').config();
const { MongoClient } = require('mongodb');

class MongoCacheManager {
  /**
   * @param {string} mongoUrl - Connection URL for MongoDB.
   * @param {string} dbName - Database name.
   * @param {string} collectionName - Collection name for caching.
   */
  constructor(mongoUrl, dbName, collectionName) {
    this.mongoUrl = mongoUrl;
    this.dbName = dbName;
    this.collectionName = collectionName || process.env.MONGO_COLLECTION_NAME || 'cache';
    this.client = new MongoClient(mongoUrl, { useUnifiedTopology: true });
    this.connected = false;
    this.readOnly = false;
  }

  async connect() {
    if (!this.connected) {
      try {
        await this.client.connect();
        this.collection = this.client.db(this.dbName).collection(this.collectionName);
        this.connected = true;
        console.log("[MongoCache] Connected to MongoDB for caching.");
        await this.collection.createIndex({ hash: 1 }, { unique: true });
        await this.collection.createIndex({ key: 1 }, { unique: true });
        // Try a dry-run write to detect read-only access
        try {
          await this.collection.insertOne({ _test: true });
          await this.collection.deleteOne({ _test: true });
        } catch (e) {
          if (e.code === 13 || e.message.includes("not authorized")) {
            console.warn("[MongoCache] MongoDB user is read-only. Caching will be read-only.");
            this.readOnly = true;
          }
        }
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

  async getByHash(hash) {
    await this.connect();
    return await this.collection.findOne({ hash });
  }

  async getAllEmbeddings() {
    await this.connect();
    return await this.collection.find({ embedding: { $exists: true } }).toArray();
  }

  async getEmbeddingsPage(page = 0, pageSize = 100) {
    await this.connect();
    return await this.collection
      .find({ embedding: { $exists: true } })
      .skip(page * pageSize)
      .limit(pageSize)
      .toArray();
  }

  async setCache(input, value, embedding, hash) {
    await this.connect();
    if (!this.connected || !this.collection || this.readOnly) return;

    const key = this.normalize(input);

    await this.collection.updateOne(
      { key },
      {
        $set: {
          key,
          value,
          updatedAt: new Date(),
          embedding,
          hash
        }
      },
      { upsert: true }
    );
  }

  // Add this function at the bottom of your main file (index.js)
  async getMongoCacheCount() {
    try {
      await this.connect(); // Ensure connection
      const count = await this.collection.countDocuments();
      console.log(`Total cache entries in MongoDB: ${count}`);
      return count;
    } catch (err) {
      console.error('Error counting cache documents:', err);
      return null;
    }
  }
}

module.exports = MongoCacheManager;
