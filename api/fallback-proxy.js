// api/fallback-proxy.js
// This is a fallback version of the proxy.js file

import fetch from 'node-fetch';

export default async function handler(req, res) {
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
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
    console.log('[FALLBACK] Request received for model:', req.body.model || 'unknown');
    
    // Prepare request for Fireworks API
    const apiEndpoint = 'https://api.fireworks.ai/inference/v1/chat/completions';
    
    // Validate max_tokens (Fireworks models accept different limits based on model)
    const originalMaxTokens = req.body.max_tokens || 4096;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 8192);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`[FALLBACK] Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens}`);
    }
    
    const cleanedParams = {
      model: req.body.model,
      messages: req.body.messages,
      max_tokens: validatedMaxTokens,
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      stream: false
    };

    // Remove undefined or null values
    Object.keys(cleanedParams).forEach(key => {
      if (cleanedParams[key] === undefined || cleanedParams[key] === null) {
        delete cleanedParams[key];
      }
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
    const timeoutId = setTimeout(() => controller.abort(), 50000); // Longer timeout for fallback
    
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
        
        res.status(response.status).json({
          error: `[FALLBACK] Fireworks API error: ${response.status}`,
          message: errorMessage
        });
        return;
      }
      
      // Successfully got a response
      const data = await response.json();
      
      // Return the response to the client
      res.status(200).json(data);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    console.error('[FALLBACK] API error:', error.name, error.message);
    
    // Special handling for timeout errors
    let errorMessage = error.message || 'Unknown error';
    let statusCode = 500;
    
    if (error.name === "AbortError") {
      errorMessage = "The request took too long to process. Try reducing max_tokens or simplifying your prompt.";
      statusCode = 504; // Gateway Timeout
    }
    
    res.status(statusCode).json({
      error: errorMessage,
      details: {
        name: error.name,
        message: error.message
      }
    });
  }
}
