// Vercel Serverless Function for RAG using MongoDB and Fireworks.ai
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');

// Cache MongoDB connection
let cachedDb = null;
let cachedClient = null;

async function connectToDatabase(uri) {
  // Return cached connection if available
  if (cachedDb) {
    return cachedDb;
  }
  
  // Configure MongoDB client with optimized settings for serverless
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,     // 5 seconds timeout for server selection
    connectTimeoutMS: 10000,            // 10 seconds timeout for initial connection
    socketTimeoutMS: 30000,             // 30 seconds timeout for socket operations
    maxPoolSize: 10,                    // Limit connection pool size for serverless
    minPoolSize: 0                      // Allow pool to scale down when not in use
  });
  
  try {
    console.log("Attempting to connect to MongoDB...");
    await client.connect();
    console.log("Successfully connected to MongoDB");
    
    const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
    
    // Store both client and db in cache
    cachedClient = client;
    cachedDb = db;
    
    return db;
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    throw new Error(`Failed to connect to MongoDB: ${error.message}`);
  }
}

// Helper function for graceful error responses
function errorResponse(res, status, message, details = null) {
  const response = { 
    error: message
  };
  
  if (details) {
    response.details = details;
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(status).json(response);
}

// Fallback response when MongoDB fails
function generateFallbackResponse(query) {
  return {
    answer: `I'm unable to search the knowledge base at the moment due to a database connection issue. Here's a general response to your query: "${query}".\n\nPlease try again later or contact support if this issue persists.`,
    sources: [],
    fallback: true
  };
}

module.exports = async (req, res) => {
  // Log function invocation to help with debugging
  console.log("RAG API endpoint called:", new Date().toISOString());
  
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return errorResponse(res, 405, 'Method Not Allowed');
  }

  try {
    // Get API keys from environment variables
    const fireworksApiKey = process.env.FIREWORKS_API_KEY;
    const mongoDbUri = process.env.MONGODB_URI;
    
    if (!fireworksApiKey || !mongoDbUri) {
      console.error("Missing required environment variables");
      return errorResponse(res, 500, 'Configuration error: Missing API keys or MongoDB URI');
    }

    // Parse request body - handle different request body formats
    let requestBody;
    try {
      // For Vercel Serverless Functions (Node.js), req.body is already parsed
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return errorResponse(res, 400, 'Invalid JSON in request body', parseError.message);
    }

    // Get query from request
    const { query, collectionName, modelName } = requestBody;
    
    if (!query) {
      return errorResponse(res, 400, 'Missing query parameter');
    }
    
    // Set default collection name if not provided
    const collection = collectionName || process.env.MONGODB_COLLECTION || "rag_collection";
    // Set default model name if not provided
    const model = modelName || "nomic-ai/nomic-embed-text-v1.5";
    
    let db;
    let documentsCollection;
    let queryResult = [];
    let usedFallback = false;
    
    // Step 1: Try to connect to MongoDB
    try {
      console.log(`Connecting to MongoDB, collection: ${collection}`);
      db = await connectToDatabase(mongoDbUri);
      documentsCollection = db.collection(collection);
      
      // Check if collection exists and has documents
      const collectionInfo = await documentsCollection.stats();
      console.log(`Collection stats: count=${collectionInfo.count}, size=${collectionInfo.size}`);
      
      if (collectionInfo.count === 0) {
        console.warn(`Collection ${collection} exists but is empty`);
      }
    } catch (dbError) {
      console.error(`MongoDB connection error: ${dbError.message}`);
      // Continue with fallback approach instead of failing
      usedFallback = true;
    }

    // Step 2: Create embedding for the query using Fireworks API
    let queryEmbedding;
    try {
      console.log(`Creating embedding for query using model: ${model}`);
      const embeddingResponse = await fetch('https://api.fireworks.ai/inference/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${fireworksApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          input: query
        })
      });

      if (!embeddingResponse.ok) {
        const error = await embeddingResponse.text();
        throw new Error(`Embedding API error: ${error}`);
      }

      const embeddingData = await embeddingResponse.json();
      queryEmbedding = embeddingData.data[0].embedding;
      console.log("Successfully created embedding for query");
    } catch (embeddingError) {
      console.error(`Failed to create embedding: ${embeddingError.message}`);
      // If embedding fails, use fallback response
      const fallbackResponse = generateFallbackResponse(query);
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json({
        answer: fallbackResponse.answer,
        sources: fallbackResponse.sources,
        fallback: true,
        error: `Embedding failed: ${embeddingError.message}`
      });
      return;
    }

    // Step 3: Perform vector search in MongoDB (if connected)
    if (!usedFallback) {
      try {
        console.log("Performing vector search in MongoDB");
        queryResult = await documentsCollection.aggregate([
          {
            $search: {
              index: "vector_index", // Make sure this matches your MongoDB index name
              knnBeta: {
                vector: queryEmbedding,
                path: "embedding",
                k: 5
              }
            }
          },
          {
            $project: {
              _id: 0,
              instruction: 1,
              context: 1,
              response: 1,
              score: { $meta: "searchScore" }
            }
          }
        ]).toArray();
        
        console.log(`Found ${queryResult.length} relevant documents`);
      } catch (searchError) {
        console.error(`Vector search error: ${searchError.message}`);
        // If search fails, continue with empty results
        queryResult = [];
        usedFallback = true;
      }
    }

    // Step 4: Prepare context from retrieved documents
    let context = "";
    if (queryResult && queryResult.length > 0) {
      context = queryResult.map(doc => 
        `Question: ${doc.instruction}\nContext: ${doc.context}\nAnswer: ${doc.response}`
      ).join("\n\n");
      console.log("Successfully prepared context from retrieved documents");
    } else {
      console.log("No relevant documents found, using empty context");
    }

    // Step 5: Send query with context to Fireworks LLM
    const messages = [
      {
        role: "system",
        content: `You are a helpful assistant. ${usedFallback ? "The knowledge base search is currently unavailable, so please answer based on your general knowledge." : "Use the following context to answer the user's question, but don't mention that you're using a context. If the context doesn't contain relevant information, just answer based on your knowledge."}\n\n${usedFallback ? "" : `Context:\n${context}`}`
      },
      {
        role: "user",
        content: query
      }
    ];

    try {
      console.log("Sending query to LLM API");
      const llmResponse = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${fireworksApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: "accounts/fireworks/models/llama-v3p3-70b-instruct", // Use your preferred model
          messages: messages,
          temperature: 0.7,
          max_tokens: 1024
        })
      });

      if (!llmResponse.ok) {
        const error = await llmResponse.text();
        throw new Error(`LLM API error: ${error}`);
      }

      const llmData = await llmResponse.json();
      const answer = llmData.choices[0].message.content;
      console.log("Successfully received response from LLM API");

      // Step 6: Return response with answer and sources
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json({
        answer: answer,
        sources: queryResult.map(doc => ({
          instruction: doc.instruction,
          response: doc.response.substring(0, 200) + (doc.response.length > 200 ? '...' : ''),
          context: doc.context,
          score: doc.score
        })),
        fallback: usedFallback
      });
      
    } catch (llmError) {
      console.error(`LLM API error: ${llmError.message}`);
      return errorResponse(res, 500, `LLM API error: ${llmError.message}`);
    }

  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    return errorResponse(res, 500, 'Internal Server Error', error.message);
  }
}
