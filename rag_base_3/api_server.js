// api_server.js

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createRAGChain } from './rag_chain.js';

// --- Global RAG Chain variable ---
let ragChain;

/**
 * Starts the dedicated API server.
 */
async function startServer() {
    const app = express();

    // --- Middleware ---
    app.use(cors()); 
    app.use(express.json());

    // Simple API Key Authentication Middleware
    const apiKeyAuth = (req, res, next) => {
        const providedApiKey = req.headers['x-api-key'];
        if (!providedApiKey || providedApiKey !== process.env.API_KEY) {
            return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
        }
        next();
    };

    console.log("Initializing RAG chain... This might take a moment.");
    ragChain = await createRAGChain();
    console.log("RAG chain initialized successfully.");

    // --- API Endpoint for Chat (Updated for Server-Sent Events) ---
    app.post('/api/chat', apiKeyAuth, async (req, res) => {
        const { question } = req.body;
        if (!question) {
            return res.status(400).json({ error: 'Question is required.' });
        }

        try {
            console.log(`Streaming SSE response for question: "${question}"`);
            
            // Set headers for Server-Sent Events
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
            res.flushHeaders(); // Flush the headers to establish the connection

            const result = await ragChain.invoke(question);
            
            // First, send the sources
            if (result.sources && result.sources.length > 0) {
                res.write(`event: sources\ndata: ${JSON.stringify(result.sources)}\n\n`);
            }
            
            // Then stream the answer
            const stream = await ragChain.stream(question);
            
            for await (const chunk of stream) {
                if (chunk.answer) {
                    res.write(`data: ${JSON.stringify({ token: chunk.answer })}\n\n`);
                }
            }
            
            // Send a special 'end' event when the stream is finished
            res.write(`event: end\ndata: ${JSON.stringify({ message: 'Stream ended' })}\n\n`);
            
        } catch (error) {
            console.error("Error during SSE streaming:", error);
            // If an error occurs, send an 'error' event
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Failed to get an answer.' })}\n\n`);
        } finally {
            res.end();
        }
    });

    const PORT = process.env.SERVER_PORT || 5678;
    app.listen(PORT, () => {
        console.log(`RAG API Server is running on http://localhost:${PORT}`);
    });
}

// --- Start the application ---
startServer();