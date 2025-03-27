// Vercel Edge Function for RAG using MongoDB and Fireworks.ai
import { MongoClient } from 'mongodb';
import fetch from 'node-fetch';

// Cache MongoDB connection
let cachedDb = null;

async function connectToDatabase(uri) {
  if (cachedDb) {
    return cachedDb;
  }
  
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
  
  cachedDb = db;
  return db;
}

export default async function handler(request, context) {
  // Log function invocation to help with debugging
  console.log("RAG API endpoint called:", new Date().toISOString());
  
  // Handle CORS for preflight requests
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  // Only allow POST requests
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method Not Allowed' }),
      {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Allow': 'POST'
        }
      }
    );
  }

  try {
    // Get API keys from environment variables
    const fireworksApiKey = process.env.FIREWORKS_API_KEY;
    const mongoDbUri = process.env.MONGODB_URI;
    
    if (!fireworksApiKey || !mongoDbUri) {
      console.error("Missing required environment variables");
      return new Response(
        JSON.stringify({
          error: 'Configuration error',
          message: 'Please set FIREWORKS_API_KEY and MONGODB_URI in your Vercel environment variables'
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // Parse request body
    let requestBody;
    try {
      requestBody = await request.json();
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return new Response(
        JSON.stringify({
          error: 'Invalid JSON in request body',
          message: parseError.message
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    // Get query from request
    const { query, collectionName, modelName } = requestBody;
    
    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Missing query parameter' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }
    
    // Set default collection name if not provided
    const collection = collectionName || process.env.MONGODB_COLLECTION || "documents";
    // Set default model name if not provided
    const model = modelName || "nomic-ai/nomic-embed-text-v1.5";

    // Step 1: Connect to MongoDB
    const db = await connectToDatabase(mongoDbUri);
    const documentsCollection = db.collection(collection);
    
    // Step 2: Create embedding for the query using Fireworks API
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
    const queryEmbedding = embeddingData.data[0].embedding;

    // Step 3: Perform vector search in MongoDB
    const queryResult = await documentsCollection.aggregate([
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

    // Step 4: Prepare context from retrieved documents
    let context = "";
    if (queryResult && queryResult.length > 0) {
      context = queryResult.map(doc => 
        `Question: ${doc.instruction}\nContext: ${doc.context}\nAnswer: ${doc.response}`
      ).join("\n\n");
    }

    // Step 5: Send query with context to Fireworks LLM
    const messages = [
      {
        role: "system",
        content: `You are a helpful assistant. Use the following context to answer the user's question, but don't mention that you're using a context. If the context doesn't contain relevant information, just answer based on your knowledge.
        
Context:
${context}`
      },
      {
        role: "user",
        content: query
      }
    ];

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

    // Step 6: Return response with answer and sources
    return new Response(
      JSON.stringify({
        answer: answer,
        sources: queryResult.map(doc => ({
          instruction: doc.instruction,
          response: doc.response.substring(0, 200) + (doc.response.length > 200 ? '...' : ''),
          context: doc.context,
          score: doc.score
        }))
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      }
    );

  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    return new Response(
      JSON.stringify({ 
        error: 'Internal Server Error', 
        message: error.message
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}
