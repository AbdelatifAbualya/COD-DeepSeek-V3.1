// api/mongodb-status.js
const { MongoClient } = require('mongodb');

// Cache MongoDB connection
let cachedDb = null;

async function connectToDatabase(uri) {
  if (cachedDb) {
    return cachedDb;
  }
  
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });
  
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
  
  cachedDb = db;
  return db;
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
    
    // Attempt to connect to MongoDB
    const db = await connectToDatabase(mongoDbUri);
    
    // Test a simple command to verify connection is working
    const result = await db.command({ ping: 1 });
    
    const endTime = Date.now();
    const connectionTime = endTime - startTime;
    
    return res.status(200).json({
      status: 'ok',
      message: 'Successfully connected to MongoDB',
      connectionTimeMs: connectionTime,
      time: new Date().toISOString(),
      collections: process.env.MONGODB_COLLECTION || "rag_collection"
    });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    
    return res.status(500).json({
      status: 'error',
      message: `Failed to connect to MongoDB: ${error.message}`,
      time: new Date().toISOString()
    });
  }
};
