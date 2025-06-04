require('dotenv').config();

const fs = require('fs');
const axios = require('axios');
const readline = require('readline');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const path = require('path');
const MongoCacheManager = require('./mongoCacheManager');

// Initialize MongoCacheManager singleton
const mongoCache = new MongoCacheManager(
  process.env.MONGO_URL,
  process.env.MONGO_DB_NAME,
  process.env.MONGO_COLLECTION_NAME
);

const models = [
  'llama-4-scout-17b-16e-instruct',
  'ministral-8b-2410',
  'mistral-large-2411',
  'qwen2.5-coder-32b-instruct:int8',
  'gpt-4.1'
];

// Limit concurrency (ESM import dynamic)
async function getPLimit() {
  const pLimit = (await import('p-limit')).default;
  return pLimit;
}

// Simple file loggers
const successLog = fs.createWriteStream('success.log', { flags: 'a' });
const failedLog = fs.createWriteStream('failed.log', { flags: 'a' });

// Hash input text (for exact match caching)
function hashInput(input) {
  return crypto.createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

// Get embedding for text (calls your embedding module)
async function getEmbedding(text) {
  const { getVoyageEmbeddings } = require('./embedding');
  const embeddings = await getVoyageEmbeddings([text]);
  return embeddings[0];
}

// Check cache: exact hash match or semantic similarity with pagination
async function getCachedResult(input, threshold = 0.9) {
  const inputHash = hashInput(input);

  // Exact hash match
  const exactMatch = await mongoCache.getByHash(inputHash);
  if (exactMatch) {
    console.log("[HybridCache] Exact hash match found.");
    return exactMatch.value;
  }

  // Semantic search with embedding & worker thread (paginated)
  const inputEmbedding = await getEmbedding(input);

  const pageSize = 100;
  let page = 0;
  let globalBestMatch = null;
  let globalBestScore = threshold;

  while (true) {
    const cachedEntries = await mongoCache.getEmbeddingsPage(page, pageSize);
    if (cachedEntries.length === 0) break;

    // Run worker on current page
    const { bestMatch, bestScore } = await new Promise((resolve, reject) => {
      const worker = new Worker(path.resolve(__dirname, './cosineSimilarityWorker.js'));

      worker.postMessage({ inputEmbedding, cachedEntries, threshold: globalBestScore });

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          console.warn(`[HybridCache] Worker stopped with exit code ${code}`);
        }
      });
    });

    if (bestScore > globalBestScore) {
      globalBestScore = bestScore;
      globalBestMatch = bestMatch;
    }

    // Early exit if similarity is very high (e.g. 0.95)
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

// Store input + response in cache with embedding and hash
async function setCache(input, value) {
  const embedding = await getEmbedding(input);
  const hash = hashInput(input);
  await mongoCache.setCache(input, value, embedding, hash);
  console.log("[HybridCache] Stored new cache entry with embedding and hash.");
}

// Read inputs from file
async function readInputs(filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });

  const inputs = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) inputs.push(trimmed);
  }
  return inputs;
}

async function fetchLLMResponse(input, retries = 5, backoff = 1000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const randomModel = models[Math.floor(Math.random() * models.length)];
      const res = await axios.post(
        'https://api.llm7.io/v1/chat/completions',
        {
          model: randomModel,
          messages: [{ role: 'user', content: input }]
        },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
      return res.data.choices[0].message.content.trim();
    } catch (err) {
      if (err.response && err.response.status === 429) {
        // Rate limit hit, wait then retry
        const waitTime = backoff * Math.pow(2, attempt); // Exponential backoff
        console.warn(`⚠️ Rate limit hit. Waiting ${waitTime}ms before retrying... (Attempt ${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, waitTime));
      } else {
        // Other errors - rethrow immediately
        throw err;
      }
    }
  }
  throw new Error('Max retries reached due to rate limiting.');
}

// Process a single input line: check cache, fetch if needed, store result
async function processInput(input) {
  try {
    const cached = await getCachedResult(input);
    if (cached) {
      console.log(`🔁 Cache hit: "${input}"`);
      return;
    }

    const response = await fetchLLMResponse(input);
    await setCache(input, response);

    console.log(`✅ Stored: "${input}"`);
    successLog.write(`${input}\n`);
  } catch (err) {
    console.error(`❌ Failed: "${input}" → ${err.message}`);
    failedLog.write(`${input} | ${err.message}\n`);
  }
}

// Main async runner
async function main() {
  const pLimit = await getPLimit();
  const CONCURRENCY = 5;
  const limit = pLimit(CONCURRENCY);

  const inputs = await readInputs('./inputs.txt');
  await Promise.all(inputs.map(input => limit(() => processInput(input))));

  successLog.end();
  failedLog.end();
  console.log('📝 Done! Check success.log and failed.log.');
}

main();
