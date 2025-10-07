import { Document } from "langchain/document"; // adjust import to your langchain version

/**
 * processedPages: output of preprocessPageDocs()
 * returns an array of Documents ready for LangChain VectorStore
 */
export function processedToDocuments(processedPages) {
  const docs = [];
  for (const p of processedPages) {
    for (const c of p.chunks) {
      const doc = new Document({
        pageContent: c.text,
        metadata: {
          chunk_id: c.chunk_id,
          chunk_index: c.chunk_index,
          chunk_hash: c.chunk_hash,
          text_excerpt: c.text_excerpt,
          notion_page_id: p.page_id,
          page_title: p.page_title,
          page_hash: p.page_hash,
          last_edited_time: p.last_edited_time,
          source: p.source ?? null
        }
      });
      docs.push(doc);
    }
  }
  return docs;
}
