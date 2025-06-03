require('dotenv').config();
const axios = require('axios');

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_EMBEDDING_URL = process.env.VOYAGE_EMBEDDING_URL || 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_EMBEDDING_MODEL = process.env.VOYAGE_EMBEDDING_MODEL || 'voyage-3.5-lite';

async function getVoyageEmbeddings(texts) {
  if (!Array.isArray(texts)) {
    throw new Error('Input must be an array of strings');
  }

  try {
    const response = await axios.post(
      VOYAGE_EMBEDDING_URL,
      {
        model: VOYAGE_EMBEDDING_MODEL,
        input: texts,
        output_dimension: 1024,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        },
      }
    );

    // Map over the response data to return an array of embeddings
    return response.data.data.map(item => item.embedding);
  } catch (error) {
    console.error('Error fetching voyage embeddings:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { getVoyageEmbeddings };
