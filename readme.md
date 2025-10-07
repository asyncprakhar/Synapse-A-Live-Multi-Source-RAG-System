# RAG (Retrieval-Augmented Generation) System with LangChain

A comprehensive RAG system built with LangChain that supports real-time data ingestion from Notion and GitHub, with webhook-based synchronization and a modern chat interface.

## 🚀 Features

- **Multi-Source Data Ingestion**: Supports both Notion pages and GitHub repositories
- **Real-time Synchronization**: Webhook-based updates for both Notion and GitHub
- **Vector Database**: Uses Pinecone for efficient similarity search
- **Modern Chat Interface**: Beautiful HTML chat UI with streaming responses
- **API Authentication**: Secure API key-based authentication
- **State Management**: JSON and PostgreSQL state persistence options
- **Content Processing**: Advanced text chunking, PII redaction, and normalization

## 📁 Project Structure

```
rag_base_3/
├── api_server.js                 # Main API server for chat functionality
├── chat_ui.html                  # Modern chat interface
├── rag_chain.js                  # RAG chain implementation with LangChain
├── clean_db.js                   # Database cleanup utilities
├── github_webhook_handler.js     # GitHub webhook handler
├── notion_webhook_handler.js     # Notion webhook handler
├── package.json                  # Dependencies and scripts
├── state_after_embedding.json    # State persistence file
├── github_seeding/              # GitHub data ingestion
│   ├── config.js                # GitHub configuration
│   ├── ingestGithub.js          # GitHub document processing
│   └── ingest2.js               # Alternative GitHub ingestion
└── notion_seeding/              # Notion data ingestion
    ├── data_preprocess.js       # Text preprocessing and chunking
    ├── gemini_embeddings.js     # Google Gemini embeddings wrapper
    ├── langchain_embed_upsert.js # Vector embedding and upsert
    ├── makeLangChainDocuments.js # Document conversion utilities
    ├── notion_data_extracter.js # Notion API data extraction
    └── orchestration.js         # Main orchestration script
```

## 🛠️ Technology Stack

### Core Technologies
- **Node.js** - Runtime environment
- **LangChain** - LLM framework and orchestration
- **Pinecone** - Vector database for similarity search
- **Google Gemini** - Embeddings and chat model
- **Express.js** - Web server framework

### Data Sources
- **Notion API** - Document extraction and webhook integration
- **GitHub API** - Repository content extraction
- **PostgreSQL** - Optional state persistence

### Frontend
- **HTML5** - Chat interface
- **CSS3** - Modern styling with responsive design
- **JavaScript** - Real-time chat functionality
- **Marked.js** - Markdown rendering
- **Highlight.js** - Code syntax highlighting

## 🔧 Installation & Setup

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Pinecone account and API key
- Google Cloud account with Gemini API access
- Notion integration token (optional)
- GitHub personal access token (optional)
- PostgreSQL database (optional)

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/asyncprakhar/Synapse-A-Live-Multi-Source-RAG-System.git
cd rag_base_3
npm install
```

### 2. Environment Configuration

Create a `.env` file in the root directory:

```env
# Notion Integration
NOTION_TOKEN=your_notion_integration_token

# Google Gemini / Google GenAI
GEMINI_MODEL=text-embedding-004
GOOGLE_API_KEY=your_google_api_key

# Pinecone Configuration
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_ENV=your_pinecone_environment
PINECONE_INDEX=your_pinecone_index_name
PINECONE_NAMESPACE=your_namespace

# State Management (optional)
STATE_FILE=./state_after_embedding.json
DATABASE_URL=postgres://user:pass@host:5432/dbname  # Optional

# API Configuration
API_KEY=your_secure_api_key

# Optional Tuning
GEMINI_BATCH=32
PINECONE_UPSERT_BATCH=100

# GitHub Integration
GITHUB_ACCESS_TOKEN=your_github_token
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Webhook Ports
GITHUB_WEBHOOK_PORT=3001
NOTION_WEBHOOK_PORT=3000
```

### 3. Database Setup (Optional)

If using PostgreSQL for state persistence, create the required tables:

```sql
CREATE TABLE pages (
    page_id VARCHAR PRIMARY KEY,
    page_title TEXT,
    page_hash VARCHAR,
    last_indexed_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE chunks (
    chunk_id VARCHAR PRIMARY KEY,
    page_id VARCHAR REFERENCES pages(page_id),
    chunk_index INTEGER,
    chunk_hash VARCHAR,
    text_excerpt TEXT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

## 🚀 Usage

### 1. Data Ingestion

#### Notion Data Ingestion
- Update the page ID in notion_seeding/notion_data_extracter.js
```bash
# Update the page ID in notion_seeding/notion_data_extracter.js
# Then run the orchestration script
node notion_seeding/orchestration.js
```

#### GitHub Data Ingestion
- Update repositories in github_seeding/config.js
```bash
# Update repositories in github_seeding/config.js
# Then run the GitHub ingestion
cd github_seeding
node ingestGithub.js
```

### 2. Start the Chat API Server

```bash
node api_server.js
```

The API server will start on port 3001 (or PORT environment variable).

### 3. Access the Chat Interface

- Get into the chatbot folder:
```bash
    cd chatbot
```


- Install dependencies:
```bash
    npm install
```

- Run the frontend:
```bash
    npm run dev
```


### 4. Webhook Setup (Optional)

#### Notion Webhooks
```bash
# Start the Notion webhook handler
node notion_webhook_handler.js

# Use ngrok to expose local port 3000
ngrok http 3000

# Configure the ngrok URL as webhook endpoint in Notion
```

#### GitHub Webhooks
```bash
# Start the GitHub webhook handler
node github_webhook_handler.js

# Use ngrok to expose local port 3001
ngrok http 3001

# Configure the ngrok URL as webhook endpoint in GitHub
```

## 🔧 Configuration

### Text Processing Configuration

In `notion_seeding/data_preprocess.js`:
- `CHUNK_SIZE`: Size of text chunks (default: 800)
- `CHUNK_OVERLAP`: Overlap between chunks (default: 200)
- PII redaction patterns for sensitive data

### RAG Chain Configuration

In `rag_chain.js`:
- Model selection (Gemini 2.5 Flash)
- Retrieval parameters (top 5 documents)
- Prompt template customization
- Response formatting rules

### GitHub Integration

In `github_seeding/config.js` do these changes :
```javascript
export const config = {
  pineconeIndex: "your_index_name",
  pineconeHost: "",
  pineconeNamespace: "__default__",
  githubRepos: [
    "owner/repo1",
    "owner/repo2"
  ],
};
```

## 📊 API Endpoints

### Chat API
- **POST** `/api/chat`
  - Headers: `x-api-key: your_api_key`
  - Body: `{ "question": "your question" }`
  - Response: Server-Sent Events stream with markdown-formatted answer

### Webhook Endpoints
- **POST** `/notion-webhook` - Notion change notifications
- **POST** `/github-webhook` - GitHub push notifications

## 🔍 Key Features Explained

### 1. Real-time Synchronization
- **Notion Webhooks**: Automatically updates vector database when Notion pages change
- **GitHub Webhooks**: Syncs repository changes, especially markdown files
- **Hash-based Change Detection**: Only processes modified content

### 2. Advanced Text Processing
- **Content Normalization**: Handles various text formats and encodings
- **PII Redaction**: Automatically removes sensitive information
- **Smart Chunking**: Preserves context with overlapping chunks
- **Metadata Preservation**: Maintains source attribution and timestamps

### 3. Vector Search & Retrieval
- **Semantic Search**: Uses Google Gemini embeddings for similarity
- **Contextual Retrieval**: Retrieves top 5 most relevant documents
- **Source Attribution**: Provides clickable links to original sources

### 4. Modern Chat Interface
- **Streaming Responses**: Real-time token-by-token response streaming
- **Markdown Support**: Rich text formatting with code highlighting
- **Source Links**: Direct links to Notion pages and GitHub files
- **Responsive Design**: Works on desktop and mobile devices

## 🛡️ Security Features

- **API Key Authentication**: Secure access control
- **PII Redaction**: Automatic removal of sensitive data
- **Webhook Signature Verification**: Ensures webhook authenticity
- **Content Sanitization**: Safe handling of user input

## 📈 Performance Optimizations

- **Batch Processing**: Efficient embedding and upsert operations
- **Incremental Updates**: Only processes changed content
- **Connection Pooling**: Optimized database connections
- **Memory Management**: Streaming responses for large outputs

## 🔧 Troubleshooting

### Common Issues

1. **Embedding Failures**
   - Check Google API key and quotas
   - Verify Gemini model availability

2. **Pinecone Connection Issues**
   - Verify API key and environment
   - Check index configuration

3. **Webhook Not Working**
   - Ensure ngrok is running
   - Verify webhook URL configuration
   - Check signature verification

4. **State Persistence Issues**
   - Verify database connection
   - Check file permissions for JSON state

### Debug Mode

Enable detailed logging by setting:
```env
DEBUG=true
NODE_ENV=development
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 🙏 Acknowledgments

- **LangChain** - LLM framework and orchestration
- **Pinecone** - Vector database service
- **Google Gemini** - AI model and embeddings
- **Notion** - Document management platform
- **GitHub** - Code repository platform

## 📧 Contact

- Prakhar Srivastava - [LinkedIn: asyncioprakhar](www.linkedin.com/in/asyncioprakhar) | [Email: srivastavaprakhar081@gmail.com](mailto:srivastavaprakhar081@gmail.com)
---

**Built with ❤️ using LangChain, Pinecone, and modern web technologies**