// api/streaming-proxy.js
import fetch from 'node-fetch';

export default async function handler(req, res) {
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Get the Fireworks API key from environment variables
    const apiKey = process.env.FIREWORKS_API_KEY;
    
    if (!apiKey) {
      res.status(500).json({
        error: 'API key not configured',
        message: 'Please set FIREWORKS_API_KEY in your Vercel environment variables'
      });
      return;
    }

    // Log request information
    console.log('Streaming request received for model:', req.body.model || 'unknown');
    
    // Prepare request for Fireworks API
    const apiEndpoint = 'https://api.fireworks.ai/inference/v1/chat/completions';
    
    // Validate max_tokens (Fireworks models accept different limits based on model)
    const originalMaxTokens = req.body.max_tokens || 4096;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 8192);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens}`);
    }
    
    const cleanedParams = {
      model: req.body.model,
      messages: req.body.messages,
      max_tokens: validatedMaxTokens,
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      stream: true  // Enable streaming!
    };

    // Remove undefined or null values
    Object.keys(cleanedParams).forEach(key => {
      if (cleanedParams[key] === undefined || cleanedParams[key] === null) {
        delete cleanedParams[key];
      }
    });
    
    // Setup headers for Server-Sent Events (SSE)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Set up the Fireworks API request
    const apiRequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(cleanedParams)
    };
    
    // Call the Fireworks API with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60-second timeout
    
    try {
      const response = await fetch(apiEndpoint, {
        ...apiRequestOptions,
        signal: controller.signal
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // Try to parse error response
        let errorText = await response.text();
        let errorMessage;
        
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || 'Unknown API error';
        } catch {
          errorMessage = errorText || `Error ${response.status}`;
        }
        
        // Handle specific errors
        if (response.status === 401) {
          errorMessage = "Authentication failed. Please check your Fireworks API key.";
        } else if (response.status === 429) {
          errorMessage = "Rate limit exceeded. Please try again in a few moments.";
        }
        
        // Send error event to client
        res.write(`data: ${JSON.stringify({ error: true, message: errorMessage })}\n\n`);
        res.end();
        return;
      }
      
      // Process streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      
      // Process the stream chunk by chunk
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Decode the chunk
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        
        // Process buffer for complete SSE messages
        let lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            
            // Check for stream end marker
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
            } else {
              try {
                // Forward the chunk to client
                res.write(`data: ${data}\n\n`);
              } catch (err) {
                console.error('Error parsing or forwarding SSE data:', err);
              }
            }
          }
        }
      }
      
      // Send final message
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    console.error('Streaming API error:', error.name, error.message);
    
    // Special handling for timeout errors
    let errorMessage = error.message || 'Unknown error';
    
    if (error.name === "AbortError") {
      errorMessage = "The streaming request took too long to process.";
    }
    
    // Send error as SSE event
    res.write(`data: ${JSON.stringify({ error: true, message: errorMessage })}\n\n`);
    res.end();
  }
}
