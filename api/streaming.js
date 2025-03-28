// Node.js compatible function for streaming API responses
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Log function invocation
  console.log("Streaming API called:", new Date().toISOString());

  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Get the Fireworks API key from environment variables
    const apiKey = process.env.FIREWORKS_API_KEY;
    console.log("Environment check: FIREWORKS_API_KEY exists?", !!apiKey);
    
    if (!apiKey) {
      console.error("ERROR: Fireworks API key is missing in environment variables");
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({
        error: 'API key not configured',
        message: 'Please set FIREWORKS_API_KEY in your Vercel environment variables'
      });
      return;
    }

    // Parse request body
    let requestBody;
    try {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Invalid JSON in request body',
        message: parseError.message
      });
      return;
    }

    // Log request information
    const modelName = requestBody.model || 'unknown';
    console.log('Streaming request received for model:', modelName);
    
    // Enable streaming if not explicitly set
    if (requestBody.stream === undefined) {
      requestBody.stream = true;
    }
    
    // Prepare request for Fireworks API
    const apiEndpoint = 'https://api.fireworks.ai/inference/v1/chat/completions';
    
    // Validate max_tokens (Fireworks models accept different limits based on model)
    const originalMaxTokens = requestBody.max_tokens || 4008;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 40000);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens}`);
    }
    
    const cleanedParams = {
      model: requestBody.model,
      messages: requestBody.messages,
      max_tokens: validatedMaxTokens,
      temperature: requestBody.temperature !== undefined ? requestBody.temperature : 0.6,
      top_p: requestBody.top_p !== undefined ? requestBody.top_p : 1,
      top_k: requestBody.top_k !== undefined ? requestBody.top_k : 40,
      presence_penalty: requestBody.presence_penalty !== undefined ? requestBody.presence_penalty : 0,
      frequency_penalty: requestBody.frequency_penalty !== undefined ? requestBody.frequency_penalty : 0,
      stream: true  // Force streaming mode
    };

    // Remove undefined or null values
    Object.keys(cleanedParams).forEach(key => {
      if (cleanedParams[key] === undefined || cleanedParams[key] === null) {
        delete cleanedParams[key];
      }
    });
    
    // Set up headers for streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders(); // Important for streaming
    
    // Set up the Fireworks API request
    const apiRequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(cleanedParams)
    };
    
    try {
      // Call the Fireworks API to get the streaming response
      const response = await fetch(apiEndpoint, apiRequestOptions);
      
      if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }
      
      // Get the readable stream from the response
      const apiStream = response.body;
      
      // Set up event listeners for the stream
      apiStream.on('data', (chunk) => {
        // Send each chunk directly to the client
        res.write(chunk);
        // Flush to ensure streaming
        res.flush && res.flush();
      });
      
      apiStream.on('end', () => {
        // Ensure [DONE] is sent to close the client connection
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
      apiStream.on('error', (error) => {
        console.error('Stream error:', error);
        res.write(`data: ${JSON.stringify({error: true, message: error.message})}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
      // Handle client disconnection
      req.on('close', () => {
        console.log('Client closed connection');
        apiStream.destroy();
        res.end();
      });
      
    } catch (error) {
      console.error('API request error:', error);
      res.write(`data: ${JSON.stringify({error: true, message: error.message})}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (error) {
    console.error('Function error:', error.name, error.message);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      error: error.message || 'Unknown error',
      details: {
        name: error.name,
        message: error.message
      }
    });
  }
};
