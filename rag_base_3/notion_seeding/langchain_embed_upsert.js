// langchain_embed_upsert.js
import fs from "fs/promises";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { processedToDocuments } from "./makeLangChainDocuments.js";
import { GeminiEmbeddings } from "./gemini_embeddings.js";
import { TaskType } from "@google/generative-ai";

// Config
const PINECONE_UPSERT_BATCH = Number(process.env.PINECONE_UPSERT_BATCH || 100);
const GEMINI_BATCH = Number(process.env.GEMINI_BATCH || 32);
const DEFAULT_STATE_FILE = process.env.STATE_FILE || "./langchain_state.json";

/**
 * processedPages = output of preprocessPageDocs()
 * statePersistenceFn = async (state) => { ... }  // optional, if you persist to Postgres
 */
export async function embedAndUpsertWithLangChain(processedPages, statePersistenceFn) {
  if (!Array.isArray(processedPages)) throw new Error("processedPages must be an array (output of preprocessPageDocs)");

  // convert to LangChain Documents (so fromDocuments path can work)
  const docs = processedToDocuments(processedPages);

  // instantiate Gemini embeddings wrapper
  const gemini = new GeminiEmbeddings({
    model: process.env.GEMINI_MODEL || "text-embedding-004",
    taskType: TaskType.RETRIEVAL_DOCUMENT, // safe default; you may change
    title: process.env.GEMINI_TITLE || "Documents",
    batchSize: GEMINI_BATCH
  });

  // init pinecone
  const pinecone = new PineconeClient();
  // await pinecone.init({ apiKey: process.env.PINECONE_API_KEY, environment: process.env.PINECONE_ENV });
  const pineIndex = pinecone.Index(process.env.PINECONE_INDEX);

  // Prepare state container (page_id -> { page_title, page_hash, vector_ids })
  const state = { pages: {} };

  // Try the LangChain convenience function first
  let usedFromDocuments = false;
  try {
    // Some LangChain versions accept additional args that let you control id generation.
    // We'll attempt the simplest call — many versions will compute embeddings and upsert for us.
    await PineconeStore.fromDocuments(docs, gemini, {
      pineconeIndex: pineIndex,
      namespace: process.env.PINECONE_NAMESPACE || undefined,
      // NOTE: some versions accept idField or idFn; if your version does, pass it to ensure chunk_id is used:
      // idField: 'metadata.chunk_id'  // Uncomment if supported by your LangChain version
    });
    usedFromDocuments = true;
    console.log("PineconeStore.fromDocuments completed (LangChain handled embeddings/upsert).");
  } catch (err) {
    console.warn("PineconeStore.fromDocuments failed or is incompatible with deterministic ids. Falling back to manual upsert. Error:", err?.message ?? err);
    usedFromDocuments = false;
  }

  // If fromDocuments succeeded we still want to build state mapping using chunk_ids from processedPages
  if (usedFromDocuments) {
    for (const p of processedPages) {
      state.pages[p.page_id] = {
        page_title: p.page_title,
        page_hash: p.page_hash,
        vector_ids: p.chunks.map((c) => c.chunk_id),
        updated_at: new Date().toISOString()
      };
    }

    // persist state
    if (statePersistenceFn) {
      await statePersistenceFn(state);
    } else {
      await fs.writeFile(DEFAULT_STATE_FILE, JSON.stringify(state, null, 2));
    }
    return state;
  }

  // ----------------------------
  // FALLBACK: Manual embedding + upsert (guarantees chunk_id -> vector id)
  // ----------------------------
  // We'll iterate pages and upsert per-page to limit memory usage.
  for (const page of processedPages) {
    const pageId = page.page_id;
    const pageTitle = page.page_title;
    const pageHash = page.page_hash;
    const lastEdited = page.last_edited_time;
    const source = page.source ?? null;

    const texts = page.chunks.map((c) => c.text);
    if (texts.length === 0) {
      console.log(`Skipping empty page ${pageId}`);
      continue;
    }

    // embed all chunks (gemini handles internal batching)
    let embeddings;
    try {
      embeddings = await gemini.embedDocuments(texts);
    } catch (e) {
      console.error(`Gemini embedding failed for page ${pageId}:`, e);
      throw e;
    }
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(`Unexpected embeddings length for page ${pageId}: got ${embeddings?.length}, expected ${texts.length}`);
    }

    // build vector objects with deterministic ids and metadata
    const vectors = page.chunks.map((c, i) => ({
      id: c.chunk_id,
      values: embeddings[i],
      metadata: {
        notion_page_id: pageId,
        page_title: pageTitle,
        chunk_index: c.chunk_index,
        text_excerpt: c.text_excerpt,
        page_hash: pageHash,
        last_edited_time: lastEdited,
        source
      }
    }));

    // upsert in batches to Pinecone
    for (let i = 0; i < vectors.length; i += PINECONE_UPSERT_BATCH) {
      const batch = vectors.slice(i, i + PINECONE_UPSERT_BATCH);
      await pineIndex.upsert({ upsertRequest: { vectors: batch, namespace: process.env.PINECONE_NAMESPACE || undefined } });
    }

    // update state record for this page
    state.pages[pageId] = {
      page_title: pageTitle,
      page_hash: pageHash,
      vector_ids: vectors.map((v) => v.id),
      updated_at: new Date().toISOString()
    };

    // persist state incrementally (safer for long runs)
    if (statePersistenceFn) {
      await statePersistenceFn(state);
    } else {
      await fs.writeFile(DEFAULT_STATE_FILE, JSON.stringify(state, null, 2));
    }

    console.log(`Manual upsert: page ${pageTitle} (${pageId}) -> ${vectors.length} vectors`);
  }

  console.log("All pages processed and state saved.");
  return state;
}
