// orchestration.js
import "dotenv/config";
import fs from "fs/promises";

import { pageLoader as pageLoaderFactory } from "./notion_data_extracter.js";
import { preprocessPageDocs, saveStateToPostgres } from "./data_preprocess.js";
import { embedAndUpsertWithLangChain } from "./langchain_embed_upsert.js";

const STATE_FILE = process.env.STATE_FILE || "./state_after_embedding.json";
const SAMPLE_LIMIT = process.env.SAMPLE_LIMIT ? Number(process.env.SAMPLE_LIMIT) : undefined;
const USE_POSTGRES = !!process.env.DATABASE_URL;

/**
 * Persist state JSON to disk.
 * state is the object returned by embedAndUpsertWithLangChain (page -> vector ids).
 */
async function persistStateJson(state, path = STATE_FILE) {
  await fs.writeFile(path, JSON.stringify(state, null, 2), "utf8");
  console.log(`State written to ${path}`);
}

/**
 * If you supplied DATABASE_URL and you implemented saveStateToPostgres(processedPages),
 * call that to persist processed pages & chunks into Postgres.
 *
 * Note: saveStateToPostgres (from your data_preprocess.js) expects processedPages array,
 * so we call it with the processedPages we produced earlier.
 */
async function persistStateToPostgres(processedPages) {
  if (!saveStateToPostgres) {
    throw new Error("saveStateToPostgres not exported from data_preprocess.js");
  }
  console.log("Persisting processed pages to Postgres via saveStateToPostgres(...)");
  await saveStateToPostgres(processedPages);
  console.log("Saved processed pages to Postgres.");
}

async function run() {
  console.log("Orchestration started.");
  // 1) Load docs from Notion
  console.log("Loading pages from Notion via loader...");
  let pageDocs;
  try {
    // pageLoaderFactory() should return an array of docs (your implementation)
    const docs = await pageLoaderFactory();
    if (!Array.isArray(docs)) {
      throw new Error("pageLoader did not return an array of documents. Got: " + typeof docs);
    }
    pageDocs = docs;
  } catch (err) {
    console.error("Failed to load from Notion loader:", err);
    process.exit(1);
  }
  console.log(`Loaded ${pageDocs.length} documents from Notion.`);

  // Optionally limit for smoke tests
  if (SAMPLE_LIMIT && SAMPLE_LIMIT > 0) {
    pageDocs = pageDocs.slice(0, SAMPLE_LIMIT);
    console.log(`Running in SAMPLE mode: limit=${SAMPLE_LIMIT}. Processing ${pageDocs.length} docs.`);
  }

  // 2) Preprocess (normalize, redact, chunk, compute ids/hashes)
  console.log("Preprocessing pages (normalize, redact, chunk) ...");
  let processedPages;
  try {
    processedPages = await preprocessPageDocs(pageDocs);
    if (!Array.isArray(processedPages)) {
      throw new Error("preprocessPageDocs did not return an array");
    }
  } catch (err) {
    console.error("Preprocessing failed:", err);
    process.exit(1);
  }
  console.log(`Preprocessing complete. Processed pages: ${processedPages.length}`);

  // Quick sanity check
  if (processedPages.length > 0) {
    console.log("Example processed page (first):");
    const p0 = processedPages[0];
    console.log(` page_id: ${p0.page_id}, page_hash: ${p0.page_hash}, chunks: ${p0.chunks.length}`);
    console.log(" first chunk excerpt:", p0.chunks[0]?.text_excerpt?.slice(0, 200) ?? "<empty>");
  }

  // 3) Embed & upsert (LangChain + Gemini + Pinecone)
  console.log("Embedding chunks and upserting into vector DB (Pinecone) ...");
  let state;
  try {
    // embedAndUpsertWithLangChain will return a state object mapping pages -> vector ids
    // It accepts (processedPages, optionalStatePersistenceFn)
    // We'll pass a small persistence function that writes JSON (and optionally Postgres after)
    const localStatePersistence = async (stateObj) => {
      // write JSON to disk (incremental)
      await persistStateJson(stateObj, STATE_FILE);
    };

    state = await embedAndUpsertWithLangChain(processedPages, localStatePersistence);
  } catch (err) {
    console.error("Embedding / upsert failed:", err);
    process.exit(1);
  }
  console.log("Embedding & upsert finished.");

  // 4) Persist canonical state (Postgres if requested, plus JSON)
  try {
    if (USE_POSTGRES) {
      // Save processed pages into Postgres (pages+chunks tables) if available
      await persistStateToPostgres(processedPages);
    }
    // Always write the final state JSON
    if (!state) {
      // If embedAndUpsert returned nothing (shouldn't happen), reconstruct minimal state
      const reconstructed = { pages: {} };
      for (const p of processedPages) {
        reconstructed.pages[p.page_id] = {
          page_title: p.page_title,
          page_hash: p.page_hash,
          vector_ids: p.chunks.map(c => c.chunk_id),
          updated_at: new Date().toISOString()
        };
      }
      state = reconstructed;
    }
    await persistStateJson(state, STATE_FILE);
  } catch (err) {
    console.error("Failed to persist state:", err);
    // not fatal — state may have been partially persisted by embedAndUpsert
  }

  console.log("Orchestration complete. Indexed pages:", Object.keys(state.pages || {}).length);
  console.log("You can now enable the webhook handler to keep the index in sync for changes.");
}

run().catch((e) => {
  console.error("Fatal error in orchestration:", e);
  process.exit(1);
});
