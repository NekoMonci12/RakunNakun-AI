// cosineSimilarityWorker.js

const { parentPort } = require('worker_threads');

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
  return dot / (magA * magB);
}

parentPort.on('message', (data) => {
  const { inputEmbedding, cachedEntries, threshold } = data;

  let bestMatch = null;
  let bestScore = threshold;

  for (const item of cachedEntries) {
    const score = cosineSimilarity(inputEmbedding, item.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  parentPort.postMessage({ bestMatch, bestScore });
});
