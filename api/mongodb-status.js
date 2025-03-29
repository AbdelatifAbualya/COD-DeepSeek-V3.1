// api/mongodb-status.js
const { MongoClient } = require('mongodb');

// Cache MongoDB connection
let cachedDb = null;
let cachedClient = null;
let lastConnectionAttempt = 0;
const CONNECTION_COOLDOWN = 30000; // 30 seconds between connection attempts

async function connectToDatabase(uri) {
  const now = Date.now();
  
  // If we've tried connecting recently, use the cached connection or return the error
  if (now - lastConnectionAttempt < CONNECTION_COOLDOWN) {
    if (cachedDb) {
      return cachedDb;
    }
  }
  
  // Update the last connection attempt timestamp
  lastConnectionAttempt = now;
  
  // Close any existing connection
  if (cachedClient) {
    try {
      await cachedClient.close();
      console.log("Closed existing MongoDB connection");
    } catch (closeError) {
      console.warn("Error closing existing MongoDB connection:", closeError.message);
    }
    cachedClient = null;
    cachedDb = null;
  }
  
  console.log("Initializing new MongoDB connection");
  
  // Create a new client
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
    minPoolSize: 0
  });
  
  // Try to connect
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
    
    cachedClient = client;
    cachedDb = db;
    
    return db;
  } catch (error) {
    // Clean up on error
    try {
      await client.close();
    } catch (closeError) {
      console.warn("Error closing client after failed connection:", closeError.message);
    }
    
    throw error;
  }
}

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get MongoDB URI from environment variable
    const mongoDbUri = process.env.MONGODB_URI;
    
    if (!mongoDbUri) {
      return res.status(500).json({
        status: 'error',
        message: 'MongoDB URI not configured in environment variables',
        time: new Date().toISOString()
      });
    }
    
    // Start timer to measure connection speed
    const startTime = Date.now();
    
    // Add timeout protection for the connection
    const connectionPromise = connectToDatabase(mongoDbUri);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Connection timeout after 5 seconds')), 5000);
    });
    
    // Race the connection against the timeout
    const db = await Promise.race([connectionPromise, timeoutPromise]);
    
    // Test a simple command to verify connection is working
    const result = await db.command({ ping: 1 });
    
    const endTime = Date.now();
    const connectionTime = endTime - startTime;
    
    // Get collection names for diagnostics
    let collections = [];
    try {
      collections = await db.listCollections().toArray();
    } catch (listError) {
      console.warn("Error listing collections:", listError.message);
    }
    
    // Get the RAG collection info if it exists
    const ragCollectionName = process.env.MONGODB_COLLECTION || "rag_collection";
    let ragCollectionInfo = null;
    
    try {
      const ragCollection = db.collection(ragCollectionName);
      const stats = await ragCollection.stats();
      ragCollectionInfo = {
        name: ragCollectionName,
        count: stats.count,
        size: stats.size,
        avgDocSize: stats.avgObjSize
      };
    } catch (statsError) {
      console.warn(`Error getting RAG collection stats: ${statsError.message}`);
      ragCollectionInfo = {
        name: ragCollectionName,
        error: statsError.message
      };
    }
    
    // Check for vector index
    let vectorIndexInfo = null;
    try {
      const indexes = await db.collection(ragCollectionName).indexes();
      vectorIndexInfo = indexes.find(idx => idx.name === "vector_index") || null;
    } catch (indexError) {
      console.warn(`Error getting vector index info: ${indexError.message}`);
    }
    
    return res.status(200).json({
      status: 'ok',
      message: 'Successfully connected to MongoDB',
      connectionTimeMs: connectionTime,
      time: new Date().toISOString(),
      database: {
        name: db.databaseName,
        collectionsCount: collections.length,
        collectionsList: collections.map(c => c.name)
      },
      ragCollection: ragCollectionInfo,
      vectorIndex: vectorIndexInfo ? { exists: true, info: vectorIndexInfo } : { exists: false },
      environment: {
        dbName: process.env.MONGODB_DB_NAME || "ragDatabase",
        collectionName: process.env.MONGODB_COLLECTION || "rag_collection"
      }
    });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    
    return res.status(500).json({
      status: 'error',
      message: `Failed to connect to MongoDB: ${error.message}`,
      time: new Date().toISOString(),
      details: {
        name: error.name,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }
    });
  }
};
