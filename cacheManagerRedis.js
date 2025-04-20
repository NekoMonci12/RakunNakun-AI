// cacheManagerRedis.js

const { createClient } = require('redis');

class CacheManagerRedis {
  /**
   * @param {object} options - Options for the Redis client.
   * Example: { url: 'redis://localhost:6379' }
   */
  constructor(options) {
    this.options = options;
    this.client = createClient(this.options);
    this.connected = false;
    this.connecting = false;

    this.redisErrorCount = 0;
    this.redisErrorLimit = 3;

    this.client.on('error', (err) => {
      this.connected = false;

      if (this.redisErrorCount < this.redisErrorLimit) {
        console.error('[RedisCache] Redis Client Error:', err.message);
        this.redisErrorCount++;

        if (this.redisErrorCount === this.redisErrorLimit) {
          console.warn('[RedisCache] Reached max Redis error log limit. Further errors will be silenced.');
        }
      }
    });

    this._initialConnect();
  }

  async _initialConnect() {
    try {
      this.connecting = true;
      await this.client.connect();
      this.connected = true;
      this.redisErrorCount = 0;
      console.log('[RedisCache] Connected to Redis.');
    } catch (err) {
      console.error('[RedisCache] Initial Redis connection failed:', err.message);
      this.connected = false;
    } finally {
      this.connecting = false;
    }
  }

  async _reconnectIfNeeded() {
    if (!this.connected && !this.connecting) {
      console.warn('[RedisCache] Attempting to reconnect to Redis...');
      try {
        this.connecting = true;
        this.client = createClient(this.options);

        // Reset listener and error limiter
        this.redisErrorCount = 0;
        this.client.on('error', (err) => {
          this.connected = false;

          if (this.redisErrorCount < this.redisErrorLimit) {
            console.error('[RedisCache] Redis Client Error:', err.message);
            this.redisErrorCount++;

            if (this.redisErrorCount === this.redisErrorLimit) {
              console.warn('[RedisCache] Reached max Redis error log limit. Further errors will be silenced.');
            }
          }
        });

        await this.client.connect();
        this.connected = true;
        console.log('[RedisCache] Reconnected to Redis.');
      } catch (err) {
        console.error('[RedisCache] Reconnection failed:', err.message);
      } finally {
        this.connecting = false;
      }
    }
  }

  normalize(input) {
    return input.trim().toLowerCase();
  }

  levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
          ? matrix[i - 1][j - 1]
          : Math.min(
              matrix[i - 1][j - 1] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j] + 1
            );
      }
    }
    return matrix[b.length][a.length];
  }

  similarity(a, b) {
    const distance = this.levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }

  async getCachedResult(input) {
    await this._reconnectIfNeeded();
    if (!this.connected) return null;

    try {
      const normalizedInput = this.normalize(input);
      const keys = await this.client.keys('cache:*');

      for (const key of keys) {
        const storedNormalizedInput = key.slice(6);
        const sim = this.similarity(normalizedInput, storedNormalizedInput);
        if (sim >= 0.8) {
          return await this.client.get(key);
        }
      }
    } catch (err) {
      console.error('[RedisCache] Error in getCachedResult:', err.message);
      this.connected = false;
    }

    return null;
  }

  async setCache(input, output) {
    await this._reconnectIfNeeded();
    if (!this.connected) return;

    try {
      const normalizedInput = this.normalize(input);
      await this.client.set(`cache:${normalizedInput}`, output, { EX: 3600 });
    } catch (err) {
      console.error('[RedisCache] Error in setCache:', err.message);
      this.connected = false;
    }
  }
}

module.exports = CacheManagerRedis;
