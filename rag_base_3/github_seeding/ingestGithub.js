import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { GithubRepoLoader } from "@langchain/community/document_loaders/web/github";
import { MarkdownTextSplitter } from "@langchain/textsplitters";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { config } from "./config.js";
import crypto from "crypto";
// import { sha256 } from "@langchain/core/utils/hash";


// --- Helper Functions for Processing ---

/**
 * A simple function to sanitize and normalize the content of markdown files.
 */
function sanitizeContent(text) {
  let s = String(text ?? "");
  // Normalize whitespace
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\t/g, " ");
  s = s.replace(/[ ]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}


function sha256(message) {
  const hash = crypto.createHash('sha256');
  hash.update(message);
  return hash.digest('hex');
}

/**
 * The main processing pipeline for GitHub documents.
 * @param {Array} rawDocs - The array of markdown documents loaded from GithubRepoLoader.
 * @returns {Promise<Array>} - Chunked documents ready for ingestion.
 */
export async function processGithubDocuments(rawDocs) {

  const splitter = new MarkdownTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 150,
  });

  const chunks = await splitter.splitDocuments(rawDocs);
  const fileContent = rawDocs.map(doc => doc.pageContent).join('\n');
  const pageHash = sha256(fileContent);
  const processedChunks = [];
  const counters = new Map(); // Tracks chunk_index per unique file

  for (const chunk of chunks) {
    const repoUrl = chunk.metadata.repository; // e.g., "https://github.com/owner/repo"
    const filePath = chunk.metadata.source; // e.g., "README.md"
    const branch = chunk.metadata.branch;

    // Robustly parse "owner/repo" from the full URL
    let repoName = "";
    try {
      repoName = new URL(repoUrl).pathname.substring(1);
    } catch {
      repoName = "unknown/repo"; // Fallback for safety
    }

    // Construct the unique identifier for the entire file
    const sourceUrl = `https://github.com/${repoName}/blob/${branch}/${filePath}`;
    const cleanedContent = sanitizeContent(chunk.pageContent);

    if (cleanedContent.length === 0) continue;

    // Get the current index for this specific file to ensure unique chunk IDs
    const fileKey = `${repoName}:${filePath}`;
    const idx = counters.get(fileKey) ?? 0;
    counters.set(fileKey, idx + 1);

    processedChunks.push({
      pageContent: cleanedContent,
      metadata: {
        source: "github",
        pageHash: pageHash,
        source_url: sourceUrl,
        repository: `${repoName}`,
        file_path: filePath,
        chunk_id: `github:${repoName}:${filePath}:${idx}`,
      },
    });
  }
  return processedChunks;
}

export async function embed_upsert(processedDocs) {
  // 3. EMBED & INGEST the processed chunks into Pinecone
  try {
    console.log("\nInitializing clients and preparing for ingestion...");
    const embeddings = new GoogleGenerativeAIEmbeddings({
      model: "text-embedding-004",
      apiKey: process.env.GEMINI_API_KEY,
    });

    const pinecone = new Pinecone();
    const pineconeIndex = pinecone.Index(config.pineconeIndex);

    // Extract the deterministic IDs you created
    const ids = processedDocs.map((chunk) => chunk.metadata.chunk_id);
    // console.log(processedDocs);
    console.log("document is processed");
    console.log(`Upserting ${processedDocs.length} chunks to Pinecone...`);
    await PineconeStore.fromDocuments(processedDocs, embeddings, {
      pineconeIndex,
      ids,
    });

    console.log("\n✅ GitHub ingestion complete.");
  } catch (error) {
    console.error(
      "An error occurred during the GitHub ingestion process:",
      error
    );
  }
}

// --- Main Execution Logic ---

async function fetch_processs() {
  try {
    // 1. FETCH all markdown documents using your provided script logic
    // const accessToken = process.env.GITHUB_ACCESS_TOKEN;

    // helper retry (paste near top)
    async function retry(fn, { retries = 4, baseDelay = 500 } = {}) {
      let last;
      for (let i = 0; i < retries; i++) {
        try {
          return await fn();
        } catch (e) {
          last = e;
          const wait = baseDelay * Math.pow(2, i);
          console.warn(
            `Retry ${i + 1}/${retries} failed: ${e.message}. waiting ${wait}ms`
          );
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      throw last;
    }
    async function fetchMdFilesFromRepo(repoStr) {
      const loader = new GithubRepoLoader(`https://github.com/${repoStr}`, {
        recursive: true,
        // branch: "main",
        accessToken: process.env.GITHUB_ACCESS_TOKEN,
        maxRetries: 5, // be more forgiving
        verbose: true, // helpful logs
        maxConcurrency: 2, // reduce socket usagemaxConcurrency: 2, // reduce socket usages
        ignorePaths: [
          ".git/",
          "node_modules/",
          "dist/",
          "build/",
          ".next/",
          "coverage/",
          // include-only markdown
          "**/*",
          "!**/",
          "!**/*.md",
          "!**/*.markdown",
        ],
      });
      // run loader.load with our outer retry
      const allDocs = await retry(() => loader.load(), {
        retries: 4,
        baseDelay: 1000,
      });
      return allDocs.filter((doc) =>
        (doc?.metadata?.source || "").toLowerCase().endsWith(".md")
      );
    }

    console.log(
      "Starting to fetch Markdown files from all configured repositories..."
    );
    const allMdDocs = [];
    for (const repoStr of config.githubRepos) {
      try {
        const repoMdDocs = await fetchMdFilesFromRepo(repoStr);
        console.log(`- ${repoStr}: Loaded ${repoMdDocs.length} Markdown files`);
        allMdDocs.push(...repoMdDocs);
      } catch (err) {
        console.error(`Error loading repo ${repoStr}:`, err.message);
      }
    }

    console.log(`\nTotal Markdown files loaded: ${allMdDocs.length}`);
    if (allMdDocs.length === 0) {
      console.log("No markdown files found to process. Exiting.");
      return;
    }

    // 2. PROCESS the raw documents into cleaned, structured chunks
    console.log("\nProcessing all loaded documents...");
    const processedDocs = await processGithubDocuments(allMdDocs);
    console.log(
      `Processing complete. Total chunks created: ${processedDocs.length}`
    );
    if (processedDocs.length === 0) {
      console.log("No processable chunks were created. Exiting.");
      return;
    }

    return processedDocs;
  } catch (error) {
    console.error(
      "An error occurred during the document fetching or processing:",
      error
    );
  }
}

async function main() {
  const processedDocs = await fetch_processs();

  await embed_upsert(processedDocs);
}

// comment out to start the seed
// main();
