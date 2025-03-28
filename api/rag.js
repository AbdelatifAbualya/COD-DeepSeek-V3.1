// This function creates a more robust MongoDB connection for serverless environments
async function connectToDatabase(uri) {
  if (cachedDb) {
    return cachedDb;
  }
  
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // Add these connection options for better performance in serverless
    serverSelectionTimeoutMS: 5000, // Faster timeout (5 seconds)
    connectTimeoutMS: 10000, // Connection timeout (10 seconds)
    socketTimeoutMS: 30000, // Socket timeout (30 seconds)
    // Keep connections alive
    heartbeatFrequencyMS: 1000, // Check connection health more often
    maxPoolSize: 10, // Limit connection pool size appropriate for serverless
    minPoolSize: 0, // Allow pool to scale down when not in use
  });
  
  try {
    // Connect to the MongoDB server
    await client.connect();
    
    // Return the database object
    const db = client.db(process.env.MONGODB_DB_NAME || "ragDatabase");
    
    // Cache the database connection
    cachedDb = db;
    return db;
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw new Error(`Unable to connect to MongoDB: ${err.message}`);
  }
}
