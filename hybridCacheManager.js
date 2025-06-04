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

    // 🤖 Embedding-based semantic search with pagination
    const inputEmbedding = await getEmbedding(input);

    let page = 0;
    const pageSize = 1000;
    let globalBestMatch = null;
    let globalBestScore = threshold;

    while (true) {
      const cachedEntries = await this.mongoCache.getEmbeddingsPage(page, pageSize);
      if (cachedEntries.length === 0) break;

      // Run worker on this page
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(path.resolve(__dirname, './cosineSimilarityWorker.js'));
        worker.postMessage({ inputEmbedding, cachedEntries, threshold: globalBestScore });

        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) console.warn(`[HybridCache] Worker stopped with exit code ${code}`);
        });
      });

      if (result.bestScore > globalBestScore) {
        globalBestScore = result.bestScore;
        globalBestMatch = result.bestMatch;
      }

      if (globalBestScore >= 0.95) break;

      page++;
    }

    if (globalBestMatch) {
      console.log(`[HybridCache] Semantic match found with similarity ${globalBestScore.toFixed(2)}`);
      return globalBestMatch.value;
    } else {
      console.log("[HybridCache] No suitable semantic cache match found.");
      return null;
    }
  }

  async setCache(input, value) {
    const embedding = await getEmbedding(input);
    const hash = hashInput(input);
    await this.mongoCache.setCache(input, value, embedding, hash);
    console.log("[HybridCache] Stored new cache entry with embedding and hash.");
  }
}

module.exports = HybridCacheManager;
