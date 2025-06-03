// hybridCacheManager.js

const crypto = require('crypto');
const MongoCacheManager = require('./mongoCacheManager');
const { Worker } = require('worker_threads');
const path = require('path');
const { getVoyageEmbeddings } = require('./embedding');

function hashInput(input) {
  return crypto.createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

async function getEmbedding(text) {
  const embeddings = await getVoyageEmbeddings([text]);
  return embeddings[0];
}


class HybridCacheManager {
  constructor(mongoUrl, dbName, collectionName = 'cache') {
    this.mongoCache = new MongoCacheManager(mongoUrl, dbName, collectionName);
  }

  async getCachedResult(input, threshold = 0.8) {
    const inputHash = hashInput(input);

    // 🔍 Fast exact-match hash lookup
    const exactMatch = await this.mongoCache.getByHash(inputHash);
    if (exactMatch) {
      console.log("[HybridCache] Exact hash match found.");
      return exactMatch.value;
    }

    // 🤖 Embedding-based semantic search
    const inputEmbedding = await getEmbedding(input);
    const cachedEntries = await this.mongoCache.getAllEmbeddings();

    if (cachedEntries.length === 0) {
      console.log("[HybridCache] No cache entries with embeddings found.");
      return null;
    }

    // Return a Promise that resolves with the worker's result
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.resolve(__dirname, './cosineSimilarityWorker.js'));

      worker.postMessage({ inputEmbedding, cachedEntries, threshold });

      worker.on('message', ({ bestMatch, bestScore }) => {
        if (bestMatch) {
          console.log(`[HybridCache] Semantic match found with similarity ${bestScore.toFixed(2)}`);
          resolve(bestMatch.value);
        } else {
          console.log("[HybridCache] No suitable semantic cache match found.");
          resolve(null);
        }
        worker.terminate();
      });

      worker.on('error', (err) => {
        console.error("[HybridCache] Worker thread error:", err);
        reject(err);
      });

      worker.on('exit', (code) => {
        if (code !== 0)
          console.warn(`[HybridCache] Worker stopped with exit code ${code}`);
      });
    });
  }

  async setCache(input, value) {
    const embedding = await getEmbedding(input);
    const hash = hashInput(input);
    await this.mongoCache.setCache(input, value, embedding, hash);
    console.log("[HybridCache] Stored new cache entry with embedding and hash.");
  }
}

module.exports = HybridCacheManager;
