const { createClient } = require('redis');

class CacheManagerRedis {
  /**
   * @param {object} options - Options for the Redis client.
   * Example: { url: 'redis://localhost:6379' }
   */
  constructor(options) {
    this.client = createClient(options);
    this.client.on('error', (err) => console.error('Redis Client Error', err));
    this.client.connect();
  }

  // Normalize input for consistent comparison
  normalize(input) {
    return input.trim().toLowerCase();
  }

  // Compute the Levenshtein distance between two strings
  levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  // Calculate similarity between two strings (1 means identical, 0 means completely different)
  similarity(a, b) {
    const distance = this.levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - distance / maxLen;
  }

  // Check the cache for a result that is at least 80% similar to the new input.
  async getCachedResult(input) {
    const normalizedInput = this.normalize(input);
    const keys = await this.client.keys('cache:*');
    for (const key of keys) {
      const storedNormalizedInput = key.slice(6); // remove "cache:" prefix
      const sim = this.similarity(normalizedInput, storedNormalizedInput);
      if (sim >= 0.8) {
        const cachedOutput = await this.client.get(key);
        return cachedOutput;
      }
    }
    return null;
  }

  // Store the result in cache with key as normalized input
  async setCache(input, output) {
    const normalizedInput = this.normalize(input);
    await this.client.set(`cache:${normalizedInput}`, output, { EX: 3600 });
  }
}

module.exports = CacheManagerRedis;
