// preprocess_notion.js
import "dotenv/config";
import crypto from "crypto";
import fs from "fs/promises";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"; // keep if you already use langchain
import { Client as PgClient } from "pg"; // optional, only used if you enable pg persistence

// ========== CONFIG ==========
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 200;
const STATE_JSON = process.env.STATE_FILE || "./notion_state.json";
// ============================

function sha256Hex(s) {
  return crypto
    .createHash("sha256")
    .update(s ?? "", "utf8")
    .digest("hex");
}

function normalizeText(s) {
  if (!s) return "";
  return s
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00A0]+/g, " ")
    .trim();
}

/** Simple PII redaction — extend for your needs */
function redactPII(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    "<REDACTED_EMAIL>"
  );
  out = out.replace(
    /(\+?\d{1,3}[-.\s]?)?(\(?\d{2,4}\)?)[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    "<REDACTED_PHONE>"
  );
  out = out.replace(/\b[A-Za-z0-9_\-]{30,}\b/g, "<REDACTED_TOKEN>");
  return out;
}

/** Try LangChain splitter; fallback to char-window */
async function splitIntoChunks(
  text,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
) {
  text = normalizeText(text);
  // try LangChain splitter if available
  try {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap: overlap,
    });
    // newer versions have splitText; older use splitDocuments
    if (typeof splitter.splitText === "function") {
      const chunks = await splitter.splitText(text);
      // splitText sometimes returns array of strings or Document objects, normalize to strings
      return chunks.map((c) =>
        typeof c === "string" ? c : c.pageContent ?? String(c)
      );
    }
    if (typeof splitter.splitDocuments === "function") {
      // splitDocuments expects Document[]; provide dummy doc
      const docs = await splitter.splitDocuments([
        { pageContent: text, metadata: {} },
      ]);
      return docs.map((d) => d.pageContent ?? "");
    }
  } catch (e) {
    // fall through to char-split fallback
  }

  // fallback: deterministic char-window splitter
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + chunkSize);
    const chunk = text.slice(i, end).trim();
    if (chunk.length) chunks.push(chunk);
    if (end === text.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks.length ? chunks : [text];
}

/** Extract a reliable pageId from loader metadata or fallback to hash */
function getPageIdFromDoc(doc) {
  const m = doc.metadata ?? {};
  return (
    m.notion_page_id ||
    m.pageId ||
    m.page_id ||
    m.id ||
    m.source_id ||
    // fallback: short hash of content
    sha256Hex(doc.pageContent ?? doc.page_content ?? "")?.slice(0, 12)
  );
}

/** Deterministic chunk id */
function makeChunkId(pageId, pageHashShort, chunkIndex) {
  return `${pageId}::${pageHashShort}::${String(chunkIndex).padStart(5, "0")}`;
}

/** Main function: accepts pageDocs (array from LangChain Notion loader) */
export async function preprocessPageDocs(pageDocs, options = {}) {
  const results = [];
  for (const doc of pageDocs) {
    const raw = doc.pageContent ?? doc.page_content ?? doc.content ?? "";
    const metadata = doc.metadata ?? {};

    const pageId = getPageIdFromDoc(doc);
    const pageTitle =
      metadata.title ??
      metadata.page_title ??
      metadata.name ??
      `notion_${pageId}`;
    const lastEdited =
      metadata.last_edited_time ??
      metadata.lastEditedTime ??
      metadata.lastEdited ??
      null;
    const source = metadata.url ?? metadata.source ?? null;

    const normalized = normalizeText(raw);
    const redacted = redactPII(normalized);
    const pageHash = sha256Hex(redacted);

    // chunk
    const chunksText = await splitIntoChunks(
      redacted,
      options.chunkSize ?? CHUNK_SIZE,
      options.chunkOverlap ?? CHUNK_OVERLAP
    );

    const chunks = chunksText.map((text, idx) => {
      const chunkHash = sha256Hex(text);
      const chunkId = makeChunkId(pageId, pageHash.slice(0, 8), idx);
      return {
        chunk_id: chunkId,
        chunk_index: idx,
        text,
        text_excerpt: text.slice(0, 200),
        chunk_hash: chunkHash,
        metadata: {
          notion_page_id: pageId,
          page_title: pageTitle,
          page_hash: pageHash,
          last_edited_time: lastEdited,
          source,
        },
      };
    });

    results.push({
      page_id: pageId,
      page_title: pageTitle,
      page_hash: pageHash,
      last_edited_time: lastEdited,
      source,
      chunks,
    });
  }
  return results;
}

/* ========== simple JSON state save/load (dev) ========== */
export async function saveStateToJson(processedPages, filePath = STATE_JSON) {
  // we save as mapping of page_id -> metadata (page_hash, vector_ids placeholder)
  const state = { pages: {} };
  for (const p of processedPages) {
    state.pages[p.page_id] = {
      page_title: p.page_title,
      page_hash: p.page_hash,
      last_edited_time: p.last_edited_time,
      chunk_ids: p.chunks.map((c) => c.chunk_id),
      updated_at: new Date().toISOString(),
    };
  }
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  return filePath;
}

/* ========== optional Postgres helper (production) ==========
  - Run SQL in earlier messages to create `pages` and `chunks` tables.
  - Use this function to persist the page-level state.
*/
export async function saveStateToPostgres(processedPages) {
  const databaseUrl =
    process.env.DATABASE_URL ||
    "postgresql://postgres:<your_password>r@localhost:5432/postgres";
  if (!databaseUrl)
    throw new Error("DATABASE_URL required for Postgres persistence");
  const pg = new PgClient({ connectionString: databaseUrl });
  await pg.connect();
  try {
    for (const p of processedPages) {
      await pg.query(
        `INSERT INTO pages (page_id,page_title,page_hash,last_indexed_at)
        VALUES ($1,$2,$3,now())
        ON CONFLICT (page_id) DO UPDATE SET page_title = EXCLUDED.page_title, page_hash = EXCLUDED.page_hash, last_indexed_at = now()`,
        [p.page_id, p.page_title, p.page_hash]
      );
      // Optionally insert chunk rows (or handle chunk diffs later)
      for (const c of p.chunks) {
        await pg.query(
          `INSERT INTO chunks (chunk_id,page_id,chunk_index,chunk_hash,text_excerpt,metadata,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,now(),now())
          ON CONFLICT (chunk_id) DO UPDATE SET chunk_hash = EXCLUDED.chunk_hash, metadata = EXCLUDED.metadata, updated_at = now()`,
          [
            c.chunk_id,
            p.page_id,
            c.chunk_index,
            c.chunk_hash,
            c.text_excerpt,
            JSON.stringify(c.metadata),
          ]
        );
      }
    }
  } finally {
    await pg.end();
  }
  return true;
}
