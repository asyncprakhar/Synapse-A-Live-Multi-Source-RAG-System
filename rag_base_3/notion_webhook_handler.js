/**
 * notion_webhook_handler.js
 *
 * Express webhook that receives Notion change events and performs idempotent reindexing
 * using your existing pipeline:
 *   notion_data_extracter.pageLoader()
 *   data_preprocess.preprocessPageDocs()
 *   langchain_embed_upsert.embedAndUpsertWithLangChain()
 *
 * Behavior:
 * - Detect page id from payload
 * - Load that page via Notion loader (instantiating loader for the page)
 * - Preprocess -> get page_hash and chunks
 * - If page_hash unchanged -> no-op (200)
 * - If changed -> delete previous vectors (if any), re-embed & upsert, update state
 *
 * Config via env:
 *  - PORT (default 3000)
 *  - STATE_FILE (fallback JSON path)
 *  - PINECONE_* and GEMINI_* environment variables already required by your pipeline
 *  - DATABASE_URL (optional) -> if present, will persist to Postgres (saveStateToPostgres)
 *
 * To run:
 *   node notion_webhook_handler.js
 */

import express from "express";
import bodyParser from "body-parser";
import "dotenv/config";
import fs from "fs/promises";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";

import { pageLoader as pageLoaderFactory } from "./seeding/notion_data_extracter.js"; // should export async pageLoader()
import {
  preprocessPageDocs,
  saveStateToPostgres,
} from "./seeding/data_preprocess.js";
import { embedAndUpsertWithLangChain } from "./seeding/langchain_embed_upsert.js";

const PORT = process.env.NOTION_WEBHOOK_PORT || 3000;
const STATE_FILE =
  process.env.STATE_FILE || "./seeding/state_after_embedding.json";
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || undefined;

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// Helper: load JSON state file (dev)
async function loadStateJson() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { pages: {} };
  }
}
async function saveStateJson(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return true;
}

// Helper: delete vector ids from Pinecone (safe if some ids don't exist)
async function deleteVectorsFromPinecone(ids) {
  if (!ids || ids.length === 0) return;
  const pine = new PineconeClient();
  await pine.init({
    apiKey: process.env.PINECONE_API_KEY,
    environment: process.env.PINECONE_ENV,
  });
  const index = pine.Index(process.env.PINECONE_INDEX);
  try {
    if (typeof index.delete1 === "function") {
      await index.delete1({
        deleteRequest: { ids, namespace: PINECONE_NAMESPACE },
      });
    } else {
      await index.delete({
        deleteRequest: { ids, namespace: PINECONE_NAMESPACE },
      });
    }
  } catch (e) {
    console.warn("Pinecone delete error (continuing):", e?.message ?? e);
  }
}
// Extract page id from common Notion webhook shapes (be generous)
function extractPageIdFromPayload(body) {
  // Notion may send different shapes; common keys: event.page.id, page_id, resource_id
  if (!body) return null;
  // If Notion's webhook shape: { "event": { "page": { "id": "..." } } }
  if (body.entity && body.entity.id) return body.entity.id;
  if (body.event && body.event.page && body.event.page.id)
    return body.event.page.id;
  if (body.page && body.page.id) return body.page.id;
  if (body.page_id) return body.page_id;
  if (body.resource_id) return body.resource_id;
  // fallback: sometimes path is body.record?.id
  if (body.record && body.record.id) return body.record.id;
  // If the payload is an array of events, pick first
  if (Array.isArray(body) && body[0]) {
    return extractPageIdFromPayload(body[0]);
  }
  return null;
}

// Endpoint
app.post("/notion-webhook", async (req, res) => {
  try {
    const payload = req.body;
    const pageId = extractPageIdFromPayload(payload);
    if (!pageId) {
      console.warn(
        "Webhook received but no page id found in payload:",
        payload
      );
      return res.status(400).json({ ok: false, error: "no page id found" });
    }

    console.log(`[webhook] Received event for page: ${pageId}`);

    // Load existing state (JSON or Postgres)
    const usePostgres = !!process.env.DATABASE_URL;
    let currentState = { pages: {} };
    if (usePostgres) {
      // For Postgres we will query using saveStateToPostgres helper if you have a retrieval helper.
      // For now, fallback to JSON if Postgres read function not implemented.
      currentState = await loadStateJson();
    } else {
      currentState = await loadStateJson();
    }

    const existing = currentState.pages?.[pageId];

    // Load the single page via Notion loader
    // Your notion_data_extracter.pageLoader() returned a loader over a root page earlier.
    // Instantiate a new loader for this specific page or call that loader but we will create a new NotionAPILoader here for the page.
    // Simpler: call pageLoaderFactory() to get the loader you use; if it supports loading by id param we should modify factory.
    // We'll attempt to call the factory then filter for the pageId in returned docs.
    let pageDocs = [];
    try {
      // If your pageLoader factory returns docs for a root page, you'd need a loader that can load a single page.
      // We'll attempt to call it and then find the matching page
      const allDocs = await pageLoaderFactory(); // returns array of docs (your current implementation)
      // Try to find doc with matching metadata id
      pageDocs = allDocs.filter((d) => {
        const meta = d.metadata || {};
        const candidate =
          meta.notion_page_id || meta.pageId || meta.page_id || meta.id;
        return candidate === pageId || d.id === pageId;
      });
      // If not found, attempt creating a new loader instance specifically for this page by importing NotionAPILoader dynamically
      if (!pageDocs || pageDocs.length === 0) {
        // dynamic import - fallback: create a loader for the specific page id
        const { NotionAPILoader } = await import(
          "@langchain/community/document_loaders/web/notionapi"
        );
        const loader = new NotionAPILoader({
          clientOptions: { auth: process.env.NOTION_TOKEN },
          id: pageId,
          type: "page",
        });
        pageDocs = await loader.load();
      }
    } catch (e) {
      console.error("Failed to load page docs for webhook:", e);
      return res.status(500).json({ ok: false, error: "failed to load page" });
    }

    if (!pageDocs || pageDocs.length === 0) {
      console.warn("No page docs returned from loader for page id", pageId);
      return res
        .status(404)
        .json({ ok: false, error: "page not found by loader" });
    }

    // Preprocess (returns array; usually 1 element for single page)
    const processed = await preprocessPageDocs(pageDocs);
    if (!Array.isArray(processed) || processed.length === 0) {
      console.warn("Preprocess returned no pages for", pageId);
      return res.status(500).json({ ok: false, error: "preprocess empty" });
    }
    const page = processed[0]; // the single page

    // If no change in hash -> noop
    if (existing && existing.page_hash === page.page_hash) {
      console.log(`No-op: page ${pageId} hash unchanged.`);
      return res.status(200).json({ ok: true, result: "no-change" });
    }

    // If changed: delete old vectors (if any) before reindex to avoid orphaned vectors
    if (
      existing &&
      Array.isArray(existing.vector_ids) &&
      existing.vector_ids.length > 0
    ) {
      console.log(
        `Deleting ${existing.vector_ids.length} old vectors for page ${pageId}`
      );
      try {
        await deleteVectorsFromPinecone(existing.vector_ids);
      } catch (e) {
        console.warn(
          "Failed to delete existing vectors (continuing):",
          e?.message ?? e
        );
      }
    }

    // Reindex only this page using your embed/upsert function
    // embedAndUpsertWithLangChain expects an array of processedPages
    const statePersistenceFn = async (newState) => {
      // if you want Postgres persistence, call saveStateToPostgres() here
      if (usePostgres) {
        try {
          await saveStateToPostgres(Object.values(newState.pages)); // adapt if your function accepts different shape
          // Also save JSON copy
          await saveStateJson(newState);
        } catch (e) {
          console.warn("Postgres save failed, falling back to JSON:", e);
          await saveStateJson(newState);
        }
      } else {
        await saveStateJson(newState);
      }
    };

    // call embed/upsert for this single page
    const newState = await embedAndUpsertWithLangChain(
      [page],
      statePersistenceFn
    );

    console.log(`Reindexed page ${pageId}.`);
    return res
      .status(200)
      .json({
        ok: true,
        result: "updated",
        state: newState.pages?.[pageId] ?? null,
      });
  } catch (err) {
    console.error("Webhook processing failed:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Notion webhook handler listening on port ${PORT}`);
});
