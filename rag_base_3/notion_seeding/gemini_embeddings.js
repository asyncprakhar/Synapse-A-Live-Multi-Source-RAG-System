// gemini_embeddings.js
/**
 * Wrapper that exposes a LangChain-compatible Embeddings adapter
 * backed by LangChain's GoogleGenerativeAIEmbeddings (Gemini/Vertex).
 *
 * Usage:
 *   import { GeminiEmbeddings } from './gemini_embeddings.js';
 *   const gemini = new GeminiEmbeddings({ model: 'text-embedding-004', taskType: 'RETRIEVAL_DOCUMENT', title: 'My docs' });
 *   const embs = await gemini.embedDocuments(["text1","text2"]);
 *
 * Requirements:
 *  - npm install @langchain/google-genai
 *  - Proper Google credentials / env vars as required by the Google GenAI client (e.g. GOOGLE_API_KEY or application default credentials).
 */

import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { TaskType } from "@google/generative-ai";
import 'dotenv/config';

export class GeminiEmbeddings {
  /**
   * opts:
   *  - model: string (e.g. "text-embedding-004")
   *  - taskType: TaskType enum or string (defaults to TaskType.RETRIEVAL_DOCUMENT)
   *  - title: optional title used by the GenAI adapter
   *  - batchSize: optional (the underlying adapter may handle batching itself)
   */
  constructor(opts = {}) {
    const {
      model = process.env.GEMINI_MODEL || "text-embedding-004",
      taskType = process.env.GEMINI_TASK_TYPE || TaskType.RETRIEVAL_DOCUMENT,
      title = process.env.GEMINI_TITLE || undefined,
      batchSize = Number(process.env.GEMINI_BATCH_SIZE || 32),
      ...rest
    } = opts;

    // If taskType is provided as a string (e.g., "RETRIEVAL_DOCUMENT"), convert to TaskType enum when possible
    const resolvedTaskType = typeof taskType === "string" ? TaskType[taskType] ?? taskType : taskType;

    this._inner = new GoogleGenerativeAIEmbeddings({
      model,
      taskType: resolvedTaskType,
      title,
      ...rest,
    });

    this.batchSize = batchSize;
  }

  /**
   * Embed an array of documents (strings).
   * Returns Promise< number[][] >
   */
  async embedDocuments(texts) {
    if (!Array.isArray(texts)) throw new Error("embedDocuments expects an array of strings");
    // Delegate to LangChain's GoogleGenerativeAIEmbeddings which handles batching/requests.
    // Some versions provide embedDocuments directly; otherwise we chunk + call embedQuery/embedding APIs.
    if (typeof this._inner.embedDocuments === "function") {
      return await this._inner.embedDocuments(texts);
    }

    // Fallback: call embedQuery or lower-level API in batches
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      // GoogleGenerativeAIEmbeddings may expose embedQuery per item; prefer embedDocuments if available
      if (typeof this._inner.embedQuery === "function" && typeof this._inner.embedDocuments !== "function") {
        for (const t of batch) {
          const e = await this._inner.embedQuery(t);
          out.push(e);
        }
      } else {
        // If neither exists, throw so user can update lib / adapter
        throw new Error("GoogleGenerativeAIEmbeddings does not expose embedDocuments/embedQuery in this version.");
      }
    }
    return out;
  }

  /**
   * Embed a single query string (useful for retrieval queries).
   * Returns Promise<number[]>
   */
  async embedQuery(text) {
    if (typeof this._inner.embedQuery === "function") {
      return await this._inner.embedQuery(text);
    }
    // fallback to embedDocuments and return first
    const arr = await this.embedDocuments([text]);
    return arr[0];
  }
}
