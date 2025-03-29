// Vercel API endpoint for MongoDB RAG functionality
const { MongoClient } = require('mongodb');

module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('RAG API called:', new Date().toISOString());

  try {
    // Parse request body
    const { query, collectionName } = typeof req.body === 'string' 
      ? JSON.parse(req.body) 
      : req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    console.log(`RAG Query: "${query.substring(0, 100)}${query.length > 100 ? '...' : ''}"`);
    console.log(`Collection: ${collectionName || process.env.MONGODB_COLLECTION}`);

    // Connect to MongoDB
    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME;
    const defaultCollection = process.env.MONGODB_COLLECTION;
    
    if (!uri || !dbName) {
      return res.status(500).json({ 
        error: 'MongoDB configuration missing',
        message: 'Please set MONGODB_URI and MONGODB_DB_NAME in your environment variables'
      });
    }
    
    // Use specified collection or default
    const collection = collectionName || defaultCollection;
    if (!collection) {
      return res.status(400).json({ error: 'Collection name is required' });
    }

    // Connect to MongoDB
    const client = new MongoClient(uri);
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(dbName);
    const coll = db.collection(collection);
    
    // Perform vector search if available, otherwise fallback to text search
    let results;
    try {
      // Check if vector search is possible
      const hasVectorSearch = await db.command({ listSearchIndexes: collection })
        .then(result => {
          const indexes = result.cursor.firstBatch;
          return indexes.some(index => 
            index.definition && 
            index.definition.mappings && 
            index.definition.mappings.fields && 
            index.definition.mappings.fields.some(field => field.type === 'vector')
          );
        })
        .catch(() => false);
      
      if (hasVectorSearch) {
        // Perform vector search
        console.log('Performing vector search');
        results = await coll.aggregate([
          {
            $vectorSearch: {
              index: 'vector_index',
              queryVector: query,
              path: 'embedding',
              numCandidates: 100,
              limit: 5
            }
          },
          {
            $project: {
              _id: 0,
              text: 1,
              score: { $meta: 'vectorSearchScore' }
            }
          }
        ]).toArray();
      } else {
        // Fallback to text search
        console.log('Vector search not available, using text search');
        results = await coll.find(
          { $text: { $search: query } },
          { 
            score: { $meta: 'textScore' },
            projection: { _id: 0, text: 1 } 
          }
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(5)
        .toArray();
      }
    } catch (searchError) {
      console.error('Search error:', searchError);
      // Fallback to simple text match if searches fail
      console.log('Falling back to simple query match');
      results = await coll.find({
        text: { $regex: query.split(' ').filter(w => w.length > 3).join('|'), $options: 'i' }
      })
      .limit(5)
      .project({ _id: 0, text: 1 })
      .toArray();
    }
    
    // Close MongoDB connection
    await client.close();
    console.log('Closed MongoDB connection');

    // Generate answer using the retrieved sources
    let answer = "";
    if (results && results.length > 0) {
      answer = `Based on the knowledge base, here is the information related to your query:\n\n${query}\n\n`;
      
      // Format the sources for LLM context
      const contexts = results.map(doc => doc.text).join('\n\n');
      answer += contexts;
    } else {
      answer = "I couldn't find any relevant information in the knowledge base for your query. Please try a different query or more specific terms.";
    }

    // Return the answer and sources
    res.status(200).json({
      answer,
      sources: results || []
    });
    
  } catch (error) {
    console.error('RAG API error:', error);
    res.status(500).json({
      error: 'Error processing RAG request',
      message: error.message
    });
  }
};
