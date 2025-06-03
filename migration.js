require('dotenv').config();
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { getVoyageEmbeddings } = require('./embedding');

const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.MONGO_DB_NAME;
const COLLECTION_NAME = process.env.MONGO_COLLECTION_NAME;
const BATCH_SIZE = 500;

// Toggle: set true to overwrite all embeddings, false to update only missing ones
const OVERWRITE_EMBEDDINGS = true;

function computeHash(input) {
  return crypto.createHash('sha256').update(input.trim().toLowerCase()).digest('hex');
}

(async () => {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION_NAME);

  // Select documents based on the toggle
  const query = OVERWRITE_EMBEDDINGS
    ? {} // all documents
    : {
        $or: [
          { embedding: { $exists: false } },
          { hash: { $exists: false } }
        ]
      };

  const cursor = collection.find(query);

  let updatedCount = 0;
  let batchDocs = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();

    if (!OVERWRITE_EMBEDDINGS) {
      // Only push docs missing embedding or hash
      const needsEmbedding = !doc.embedding;
      const needsHash = !doc.hash;
      if (!needsEmbedding && !needsHash) continue;
    }

    batchDocs.push(doc);

    if (batchDocs.length === BATCH_SIZE) {
      const texts = batchDocs.map(d => d.key);
      try {
        const embeddings = await getVoyageEmbeddings(texts);

        for (let i = 0; i < batchDocs.length; i++) {
          const hash = computeHash(batchDocs[i].key);
          await collection.updateOne(
            { _id: batchDocs[i]._id },
            { $set: { embedding: embeddings[i], hash } }
          );
          console.log(`✅ Updated embedding & hash for: ${batchDocs[i].key}`);
          updatedCount++;
        }
      } catch (err) {
        console.warn(`⚠️ Failed batch: ${err.message}`);
      }

      batchDocs = [];
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (batchDocs.length > 0) {
    const texts = batchDocs.map(d => d.key);
    try {
      const embeddings = await getVoyageEmbeddings(texts);
      for (let i = 0; i < batchDocs.length; i++) {
        const hash = computeHash(batchDocs[i].key);
        await collection.updateOne(
          { _id: batchDocs[i]._id },
          { $set: { embedding: embeddings[i], hash } }
        );
        console.log(`✅ Updated embedding & hash for: ${batchDocs[i].key}`);
        updatedCount++;
      }
    } catch (err) {
      console.warn(`⚠️ Failed batch: ${err.message}`);
    }
  }

  console.log(`🎉 Migration complete. ${updatedCount} entries updated.`);
  await client.close();
})();
