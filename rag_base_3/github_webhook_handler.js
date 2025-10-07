import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";
import { config } from "./github_seeding/config.js";
import express from "express";
import { Octokit } from "@octokit/rest";
import { processGithubDocuments, embed_upsert } from "./github_seeding/ingestGithub.js";
// Example function to verify signature
import crypto from "crypto";


dotenv.config("./env");



const PORT = process.env.GITHUB_WEBHOOK_PORT || 3001

const pinecone = new Pinecone();
const pineconeIndex = pinecone.index(config.pineconeIndex, config.pineconeHost).namespace(config.pineconeNamespace);

const app = express();


function sha256(message) {
  const hash = crypto.createHash('sha256');
  hash.update(message);
  return hash.digest('hex');
}


/**
 * Fetches the pageHash from the first record that matches a specific source_url.
 *
 * It queries Pinecone using a metadata filter. We only need one record to get
 * the pageHash, so we set `topK` to 1 for efficiency.
 *
 * @param {string} sourceUrl - The exact source_url to filter records by.
 * @returns {Promise<string|null>} - A promise that resolves to the pageHash string if found, otherwise null.
 */
async function fetchPageHashBySourceUrl(sourceUrl) {
    if (!sourceUrl) {
        console.error("Error: source_url parameter is missing.");
        return null;
    }

    try {
        console.log("Initializing Pinecone client...");
        const pinecone = new Pinecone();

        console.log(`Connecting to index: "${config.pineconeIndex}"...`);
        const pineconeIndex = pinecone.Index(config.pineconeIndex);

        // The dimension of the vector. For "text-embedding-004", this is 768.
        const vectorDimension = 768;

        // Create a zero vector as a placeholder for the query.
        const zeroVector = Array(vectorDimension).fill(0);

        // MODIFICATION: Set topK to 1 for efficiency, as we only need the first matching record.
        const topK = 1;

        console.log(`Querying for records with source_url: "${sourceUrl}"...`);

        // Perform the query with a metadata filter
        const queryResponse = await pineconeIndex.query({
            topK: topK,
            vector: zeroVector, // A dummy vector is required for the query operation.
            filter: {
                source_url: { '$eq': sourceUrl } // The filter condition.
            },
            includeMetadata: true, // Ensure metadata is returned with the results.
            includeValues: false   // We don't need the vector values for this task.
        });

        // MODIFICATION: Logic to extract and return only the pageHash from the first match.
        if (queryResponse && queryResponse.matches && queryResponse.matches.length > 0) {
            const pageHash = queryResponse.matches[0].metadata?.pageHash;
            if (pageHash) {
                console.log(`Found pageHash for the first chunk: ${pageHash}`);
                return pageHash;
            } else {
                console.log("A matching record was found, but it did not contain a pageHash.");
                return null;
            }
        } else {
            console.log("No matching records found.");
            return null;
        }

    } catch (error) {
        console.error("An error occurred while fetching data from Pinecone:", error);
        return null;
    }
}


async function deleteAllReadmeChunks(repoName, branch, modifiedFile) {
    const sourceUrl = `https://github.com/${repoName}/blob/${branch}/${modifiedFile}`
    await pineconeIndex.deleteMany({
        source_url: sourceUrl
    });
}

app.use('/github-webhook', express.raw({ type: '*/*' }));

function verifySignature(secret, signature, payload) {
    // Remove "sha256=" prefix
    const signatureHash = signature.replace('sha256=', '');
    const expected = crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('hex');
    // Use timing-safe compare
    return crypto.timingSafeEqual(Buffer.from(signatureHash), Buffer.from(expected));
}
// app.use(bodyParser.json({ limit: "1mb" }));

app.post('/github-webhook', async (req, res) => {
    // Verify webhook signature to ensure it's from github.
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.body; // Buffer

    // Verify signature against rawBody
    if (!verifySignature(secret, signature, rawBody)) {
        return res.status(401).send('Unauthorized');
    }
    // Get content type
    const contentType = req.headers['content-type'];

    let payloadObj;
    if (contentType && contentType.includes('application/json')) {
        payloadObj = JSON.parse(rawBody.toString('utf8'));
    } else if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
        // Parse form-urlencoded
        const form = rawBody.toString('utf8');
        // Get the payload param value
        const match = form.match(/payload=([^&]*)/);
        if (match) {
            const decoded = decodeURIComponent(match[1]);
            payloadObj = JSON.parse(decoded);
        } else {
            payloadObj = {};
        }
    } else {
        payloadObj = {};
    }

    // Ensure the event is a 'push' event
    const githubEvent = req.headers['x-github-event'];
    if (githubEvent !== "push") {
        res.status(202).send('Accepted: Event was not a push.');
    }
    if (githubEvent === "push") {
        const { repository, commits } = payloadObj;
        // console.log("BRANCH OF THIS REPOSITORY IS: ", repository.default_branch);

        // Process each modified file in the push
        for (const commit of commits) {
            // We only care about files that were modified.
            for (const modifiedFile of commit.modified) {
                // Filter to only process markdown files
                // if (modifiedFile.toLowerCase().includes('readme')) {
                if (modifiedFile.toLowerCase().endsWith('.md')) {
                    const repoName = `${repository.owner.name}/${repository.name}`;
                    
                    // 1. Download raw README contents
                    const octokit = new Octokit
                    const readmeResp = await octokit.repos.getContent({
                        owner: repository.owner.name,
                        repo: repository.name,
                        path: modifiedFile,
                    });
                    const content = Buffer.from(readmeResp.data.content, 'base64').toString('utf8');
                    const newPageHash = sha256(content);

                    // Get the old page hash
                    const sourceUrl = `https://github.com/${repoName}/blob/${repository.default_branch}/${modifiedFile}`;
                    const oldPageHash = await fetchPageHashBySourceUrl(sourceUrl);

                    console.log(`\nChecking file: ${modifiedFile}`);
                    console.log(` -> Old Hash (from Pinecone): ${oldPageHash}`);
                    console.log(` -> New Hash (from commit):   ${newPageHash}`);
                    
                    // HERE IS THE COMPARISON LOGIC
                    if (newPageHash === oldPageHash) {
                        console.log(" -> Hashes match. No update needed. Skipping.");
                        continue; // Move to the next modified file
                    }                    

                    // 8. If hashes differ, update the data in Pinecone
                   console.log(" -> Hashes differ. Proceeding with update...");
                    // First, delete all old chunks associated with this file
                    await deleteAllReadmeChunks(repoName, repository.default_branch, modifiedFile);


                    // Prepare the new content in the format your processing function expects
                    const rawDocs = [{
                        pageContent: content,
                        metadata: {
                            repository: `https://github.com/${repoName}`,
                            source: modifiedFile,
                            branch: repository.default_branch, // adjust per your webhook payload
                        }
                    }];

                    // Process and upsert the new chunks
                    const processedDocs = await processGithubDocuments(rawDocs);
                    await embed_upsert(processedDocs);
                    console.log(` -> Successfully updated chunks for ${modifiedFile}.`);
                }
            }
        }
        res.status(200).send('OK');
    }
});

app.listen(PORT, () => {
    console.log(`Github webhook handler listening on port ${PORT}`);
});