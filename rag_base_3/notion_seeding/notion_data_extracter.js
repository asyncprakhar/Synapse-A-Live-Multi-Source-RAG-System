import { NotionAPILoader } from "@langchain/community/document_loaders/web/notionapi";
import "dotenv/config";

// const PAGE_ID = process.env.PAGE_ID
// Loading a page (including child pages all as separate documents)
// console.log(process.env.NOTION_TOKEN);
export async function pageLoader() {
  const pageLoader = new NotionAPILoader({
    clientOptions: {
      auth: process.env.NOTION_TOKEN,
    },
    id: "<central_page_id_here>",
    type: "page",
  });
  const pageDocs = await pageLoader.load();
  return pageDocs;
}

// const splitter = new RecursiveCharacterTextSplitter();

// Load the documents
// console.log(pageDocs)
// console.log("---------------------------------------------------------------------------------------------")
// console.log(pageDocs[1].metadata.parent)
// console.log("---------------------------------------------------------------------------------------------")
// console.log(pageDocs[1].id)
// Split the documents using the text splitter
// const splitDocs = await splitter.splitDocuments(pageDocs);

// // console.log({ splitDocs });
// const single_chunk = splitDocs[1];
// console.log(single_chunk); // Check entire object

// if(single_chunk) {
//   console.log(single_chunk.document);
//   console.log(single_chunk.metadata.loc);
// }

// Loading a database (each row is a separate document with all properties as metadata)
// const dbLoader = new NotionAPILoader({
//   clientOptions: {
//     auth: "<NOTION_INTEGRATION_TOKEN>",
//   },
//   id: "<DATABASE_ID>",
//   type: "database",
//   onDocumentLoaded: (current, total, currentTitle) => {
//     console.log(`Loaded Page: ${currentTitle} (${current}/${total})`);
//   },
//   callerOptions: {
//     maxConcurrency: 64, // Default value
//   },
//   propertiesAsHeader: true, // Prepends a front matter header of the page properties to the page contents
// });

// // A database row contents is likely to be less than 1000 characters so it's not split into multiple documents
// const dbDocs = await dbLoader.load();

// console.log({ dbDocs });

