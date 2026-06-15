// backend/utils/loadChunkContent.js

const path = require('path');
const fs   = require('fs');

const CHUNKS_PATH = path.join(
  __dirname,
  '../data/chunks/admission_guide_chunks.json'
);

// Load once at module level — no repeated disk reads
let CHUNKS = null;

function getChunks() {
  if (!CHUNKS) {
    try {
      CHUNKS = JSON.parse(
        fs.readFileSync(CHUNKS_PATH, 'utf8')
      );
    } catch (err) {
      console.error('loadChunkContent: failed to load chunks file', err.message);
      CHUNKS = {};
    }
  }
  return CHUNKS;
}

/**
 * Load and join specific chunk IDs for a destination country.
 *
 * @param {string[]} chunkIds  - e.g. ['qualification_recognition']
 * @param {string}   country   - must match top-level key in JSON
 *                               e.g. 'United Kingdom', 'Germany', 'India'
 * @returns {string|null}      - joined chunk text or null if nothing found
 */
function loadChunkContent(chunkIds, country) {
  if (!chunkIds || !chunkIds.length || !country) return null;

  const chunks = getChunks();
  const countryChunks = chunks[country];

  if (!countryChunks) {
    console.warn(`loadChunkContent: no chunks found for country "${country}"`);
    return null;
  }

  const parts = chunkIds
    .map(id => countryChunks[id] || null)
    .filter(Boolean);

  if (!parts.length) {
    console.warn(
      `loadChunkContent: none of [${chunkIds.join(', ')}] found for "${country}"`
    );
    return null;
  }

  return parts.join('\n\n---\n\n');
}

module.exports = { loadChunkContent };
