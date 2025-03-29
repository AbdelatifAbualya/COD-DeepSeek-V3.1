// Vercel Serverless Function for RAG using MongoDB and Fireworks.ai
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');

// Cache MongoDB connection
let cachedDb = null;
let cachedClient = null;
let connectionPromise = null;

async function connectToDatabase(uri) {
  // If already connecting, wait for that connection to establish
  if (connectionPromise) {
    try {
      return await connectionPromise;
    } catch (error) {
      // If previous connection attempt failed, reset and try again
      connectionPromise = null;
      cachedDb = null;
      cachedClient = null;
    }
  }

  // Return cached connection if available
  if (cachedDb) {
    return cachedDb;
  }
  
  // Create new connection promise
  connectionPromise = new Promise(async (resolve, reject) => {
    try {
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
      
      console.log("Attempting to connect to MongoDB...");
      await client.connect();
      console.log("Successfully connected to MongoDB");
      
      const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
      
      // Store both client and db in cache
      cachedClient = client;
      cachedDb = db;
      
      resolve(db);
    } catch (error) {
      console.error("MongoDB connection error:", error.message);
      // Reset connection promise so future attempts can try again
      connectionPromise = null;
      reject(error);
    }
  });
  
  return connectionPromise;
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
    answer: `I'm unable to search the knowledge base at the moment due to a database connection issue. I'll answer based on my general knowledge instead.\n\nYour question was: "${query}"`,
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
    
    // Validate required environment variables
    if (!fireworksApiKey) {
      console.error("Missing required Fireworks API key");
      return errorResponse(res, 500, 'Configuration error: Missing Fireworks API key');
    }
    
    if (!mongoDbUri) {
      console.error("Missing required MongoDB URI");
      return errorResponse(res, 500, 'Configuration error: Missing MongoDB URI');
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
    
    // Step 1: Try to connect to MongoDB with timeout protection
    try {
      console.log(`Connecting to MongoDB, collection: ${collection}`);
      
      // Set a timeout for the MongoDB connection attempt
      const dbConnectionPromise = connectToDatabase(mongoDbUri);
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('MongoDB connection timeout after 5 seconds'));
        }, 5000);
      });
      
      // Race the connection against the timeout
      db = await Promise.race([dbConnectionPromise, timeoutPromise]);
      
      documentsCollection = db.collection(collection);
      
      // Check if collection exists and has documents
      try {
        const collectionInfo = await documentsCollection.stats();
        console.log(`Collection stats: count=${collectionInfo.count}, size=${collectionInfo.size}`);
        
        if (collectionInfo.count === 0) {
          console.warn(`Collection ${collection} exists but is empty`);
        }
      } catch (statsError) {
        console.warn(`Failed to get collection stats: ${statsError.message}`);
      }
    } catch (dbError) {
      console.error(`MongoDB connection error: ${dbError.message}`);
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
        const errorText = await embeddingResponse.text();
        throw new Error(`Embedding API error (${embeddingResponse.status}): ${errorText}`);
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
        
        // Set a timeout for the vector search
        const searchPromise = documentsCollection.aggregate([
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
        
        // Create a timeout promise
        const searchTimeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('MongoDB search timeout after 4 seconds'));
          }, 4000);
        });
        
        // Race the search against the timeout
        queryResult = await Promise.race([searchPromise, searchTimeoutPromise]);
        
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
        `Question: ${doc.instruction || "Unknown"}\nContext: ${doc.context || ""}\nAnswer: ${doc.response || "Unknown"}`
      ).join("\n\n");
      console.log("Successfully prepared context from retrieved documents");
    } else {
      console.log("No relevant documents found, using empty context");
    }

    // Step 5: Send query with context to Fireworks LLM
    const messages = [
      {
        role: "system",
        content: `You are a helpful assistant. ${usedFallback ? 
          "The knowledge base search is currently unavailable, so please answer based on your general knowledge." : 
          "Use the following retrieved information to answer the user's question. If the retrieved information isn't relevant or doesn't contain the answer, rely on your general knowledge."}\n\n${usedFallback ? "" : `Retrieved Information:\n${context}`}`
      },
      {
        role: "user",
        content: query
      }
    ];

    try {
      console.log("Sending query to LLM API");
      
      // Set a timeout for the LLM response
      const llmPromise = fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${fireworksApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: "accounts/fireworks/models/phi-3-vision-128k-instruct", // Updated model
          messages: messages,
          temperature: 0.6,
          max_tokens: 4008,
          top_p: 1,
          top_k: 40, 
          presence_penalty: 0,
          frequency_penalty: 0
        })
      });
      
      // Create a timeout promise
      const llmTimeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('LLM API timeout after 15 seconds'));
        }, 15000);
      });
      
      // Race the LLM request against the timeout
      const llmResponse = await Promise.race([llmPromise, llmTimeoutPromise]);

      if (!llmResponse.ok) {
        const errorText = await llmResponse.text();
        throw new Error(`LLM API error (${llmResponse.status}): ${errorText}`);
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
          instruction: doc.instruction || "",
          response: doc.response ? 
            (doc.response.substring(0, 200) + (doc.response.length > 200 ? '...' : '')) : 
            "",
          context: doc.context || "",
          score: doc.score || 0
        })),
        fallback: usedFallback
      });
      
    } catch (llmError) {
      console.error(`LLM API error: ${llmError.message}`);
      
      // If LLM fails but we have context, provide a simplified response
      const fallbackResponse = generateFallbackResponse(query);
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json({
        answer: fallbackResponse.answer,
        sources: queryResult.map(doc => ({
          instruction: doc.instruction || "",
          response: doc.response ? 
            (doc.response.substring(0, 200) + (doc.response.length > 200 ? '...' : '')) : 
            "",
          context: doc.context || "",
          score: doc.score || 0
        })),
        fallback: true,
        error: `LLM API error: ${llmError.message}`
      });
    }

  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    return errorResponse(res, 500, 'Internal Server Error', error.message);
  }
}
