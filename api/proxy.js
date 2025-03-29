// api/api-proxy.js - Fixed for Node.js runtime
module.exports = async (req, res) => {
  // Log function invocation to help with debugging
  console.log("Fireworks API proxy called:", new Date().toISOString());
  
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method Not Allowed',
      headers: {
        'Allow': 'POST'
      }
    });
  }

  try {
    // Get API key from environment variable
    const apiKey = process.env.FIREWORKS_API_KEY;
    console.log("Environment check: FIREWORKS_API_KEY exists?", !!apiKey);
    
    if (!apiKey) {
      console.error("ERROR: Fireworks API key is missing in environment variables");
      return res.status(500).json({
        error: 'API key not configured',
        message: 'Please set FIREWORKS_API_KEY in your Vercel environment variables'
      });
    }

    // Parse request body - Node.js serverless function compatible
    let requestBody;
    try {
      // For Node.js Vercel functions, req.body is already parsed if content-type is application/json
      requestBody = req.body;
      
      // If req.body is a string (happens sometimes with Vercel), parse it
      if (typeof requestBody === 'string') {
        requestBody = JSON.parse(requestBody);
      }
      
      // Fallback if body wasn't parsed automatically
      if (!requestBody) {
        // This should rarely happen with Vercel functions
        const buffers = [];
        for await (const chunk of req) {
          buffers.push(chunk);
        }
        const data = Buffer.concat(buffers).toString();
        requestBody = data ? JSON.parse(data) : {};
      }
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      return res.status(400).json({
        error: 'Invalid JSON in request body',
        message: parseError.message
      });
    }

    // Log request info (non-sensitive)
    const modelName = requestBody.model || 'not specified';
    console.log(`Model requested: ${modelName}`);
    
    // Add timing metrics for monitoring
    let reasoningMethod = 'Standard';
    if (requestBody.messages && requestBody.messages[0] && requestBody.messages[0].content) {
      const systemPrompt = requestBody.messages[0].content;
      if (systemPrompt.includes('Chain of Draft')) {
        reasoningMethod = 'CoD';
      } else if (systemPrompt.includes('Chain of Thought')) {
        reasoningMethod = 'CoT';
      }
    }
    
    console.log(`Using reasoning method: ${reasoningMethod}`);
    console.log(`Request complexity: ${JSON.stringify({
      messages_count: requestBody.messages ? requestBody.messages.length : 0,
      max_tokens: requestBody.max_tokens || 'default'
    })}`);
    
    // Validate max_tokens (Fireworks models accept different limits based on model)
    const originalMaxTokens = requestBody.max_tokens || 4008;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 40000);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens} to meet API requirements`);
    }
    
    // Set default parameters if not provided
    if (requestBody.top_p === undefined) requestBody.top_p = 1;
    if (requestBody.top_k === undefined) requestBody.top_k = 40;
    if (requestBody.presence_penalty === undefined) requestBody.presence_penalty = 0;
    if (requestBody.frequency_penalty === undefined) requestBody.frequency_penalty = 0;
    if (requestBody.temperature === undefined) requestBody.temperature = 0.6;
    
    const startTime = Date.now();
    
    // Forward the request to Fireworks.ai with timeout
    const fetch = require('node-fetch');
    const AbortController = require('abort-controller');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.log("Request is taking too long, aborting...");
    }, 120000); // 120 seconds timeout (Vercel's maximum)
    
    try {
      const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          ...requestBody,
          max_tokens: validatedMaxTokens
        }),
        signal: controller.signal
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      console.log(`Fireworks API response status: ${response.status}, time: ${responseTime}ms, method: ${reasoningMethod}`);
      
      // Check if response is ok
      if (!response.ok) {
        // Try to get detailed error info
        let errorDetails = `Status code: ${response.status}`;
        try {
          const errorText = await response.text();
          console.error(`API error (${response.status}): ${errorText}`);
          errorDetails = errorText;
        } catch (e) {
          console.error(`Failed to read error response: ${e.message}`);
        }
        
        return res.status(response.status).json({ 
          error: `API Error: ${response.statusText}`, 
          details: errorDetails
        });
      }
      
      // Get the response data
      const data = await response.json();
      
      // Add performance metrics to response
      if (data && !data.error) {
        data.performance = {
          response_time_ms: responseTime,
          reasoning_method: reasoningMethod
        };
      }
      
      // Return the response from Fireworks.ai
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).json(data);
      
    } catch (fetchError) {
      // Clear the timeout to prevent memory leaks
      clearTimeout(timeoutId);
      
      // Check if this is an abort error (timeout)
      if (fetchError.name === 'AbortError') {
        return res.status(504).json({ 
          error: 'Gateway Timeout', 
          message: 'The request to the LLM API took too long to complete (>120 seconds). Try reducing complexity or using fewer tokens.'
        });
      }
      
      // Handle other fetch errors
      console.error("Fetch error:", fetchError);
      return res.status(500).json({ 
        error: 'Request Failed', 
        message: fetchError.message
      });
    }
  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    return res.status(500).json({ 
      error: 'Internal Server Error', 
      message: error.message
    });
  }
};
