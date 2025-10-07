// rag_chain_modified.js

import "dotenv/config";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import {
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";
import { GeminiEmbeddings } from "./notion_seeding/gemini_embeddings.js";
import { TaskType } from "@google/generative-ai";

export async function createRAGChain() {
  // 1. Initialize our external services (No changes here)
  const llm = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    streaming: true,
  });
  const pinecone = new Pinecone();
  const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
  const geminiEmbeddings = new GeminiEmbeddings({
    model: process.env.GEMINI_MODEL || "text-embedding-004",
    taskType: TaskType.RETRIEVAL_QUERY,
  });

  // 2. Initialize a PineconeStore for retrieval (No changes here)
  const vectorStore = await PineconeStore.fromExistingIndex(geminiEmbeddings, {
    pineconeIndex,
    namespace: process.env.PINECONE_NAMESPACE,
  });
  const retriever = vectorStore.asRetriever({ k: 5 });

  // 3. Create a prompt template with better formatting instructions
const promptTemplate = `You are a helpful assistant that answers questions based on the provided context.

RESPONSE STRUCTURE:
Your answer MUST follow this exact structure:

## 📝 Answer
Provide a clear, direct, and concise answer to the user's question.

## 📖 Details
Expand on the answer with additional explanations, context, or examples. Use bullet points or numbered lists for clarity.

## Sources
list all the links that can help user to validate your answer that you will get below from context or sources.
  ***title 1***: [write exact url that corresponds to that title](write exact url that corresponds to that title)\n
  
  ***title 2***: [write exact url that corresponds to that title](write exact url that corresponds to that title)\n
  i have listed only two links but if there are more list all of them with same format and link in one line and make the links clickable (in proper makedown format that make the link clickable).
---

CONTEXT INFORMATION:
Context: {context}
Sources: {sources}
Current question: {question}

Now, generate the response following these rules exactly.`;

  const prompt = ChatPromptTemplate.fromTemplate(promptTemplate);

  // 4. Custom function to format documents and extract unique source info
  // MODIFICATION 2: Reworked the entire function to handle de-duplication and multiple source types
  const formatDocsWithSources = (docs) => {
    // Combine the page content of all documents for the context
    const contextText = docs
      .map((doc, index) => `Source ${index + 1} Content:\n${doc.pageContent}`)
      .join("\n\n---\n\n");

    // Use a Map to store unique sources and avoid duplicates
    const uniqueSources = new Map();

    docs.forEach((doc) => {
      // Gracefully handle both GitHub ('source_url') and Notion ('url') metadata keys
      const url = doc.metadata.source_url || doc.metadata.url;
      // Ensure we have a URL and that it hasn't been added yet
      if (url && !uniqueSources.has(url)) {
        uniqueSources.set(url, {
          title: doc.metadata.source || url, // Use title, or fallback to the URL itself
          url: url,
        });
      }
    });
    
    // The `sources` object is now an array of unique source objects
    const sources = Array.from(uniqueSources.values());
    return { contextText, sources };
  };

  // 5. Create the RAG chain with source tracking (No changes to the structure)
  return RunnableSequence.from([
    {
      docs: retriever,
      question: new RunnablePassthrough(),
    },
    {
      context: ({ docs }) => formatDocsWithSources(docs).contextText,
      sources: ({ docs }) => formatDocsWithSources(docs).sources,
      question: ({ question }) => question,
    },
    {
      answer: prompt.pipe(llm).pipe(new StringOutputParser()),
      sources: ({ sources }) => sources,
    },
  ]);
}