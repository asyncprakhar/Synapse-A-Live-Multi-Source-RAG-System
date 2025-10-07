import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";
import {config} from "./github_seeding/config.js";

dotenv.config("./env");

const pinecone = new Pinecone();
const pineconeIndex = pinecone.index(config.pineconeIndex, config.pineconeHost).namespace(config.pineconeNamespace);; 

export async function deleteAllReadmeChunks_github(repoName){
    // const sourceUrl = `https://github.com/${repoName}/blob/README.md`
    await pineconeIndex.deleteMany({
      source: "github"
    });
}
export async function deleteAllReadmeChunks_notion(repoName){
    // const sourceUrl = `https://github.com/${repoName}/blob/README.md`
    await pineconeIndex.deleteMany({
      source: "notion"
    });
}

// deleteAllReadmeChunks_github();
// deleteAllReadmeChunks_notion();