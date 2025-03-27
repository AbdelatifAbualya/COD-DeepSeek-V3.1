// Vercel Edge Function for Fireworks.ai API Proxy
export default async function handler(request, context) {
  // Log function invocation to help with debugging
  console.log("Fireworks API proxy called:", new Date().toISOString());
  
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
    // Get API key from environment variable - add debug logging
    const apiKey = process.env.FIREWORKS_API_KEY;
    console.log("Environment check: FIREWORKS_API_KEY exists?", !!apiKey);
    
    if (!apiKey) {
      console.error("ERROR: Fireworks API key is missing in environment variables");
      return new Response(
        JSON.stringify({
          error: 'API key not configured',
          message: 'Please set FIREWORKS_API_KEY in your Vercel environment variables'
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

    // Log request info (non-sensitive)
    const modelName = requestBody.model || 'not specified';
    console.log(`Model requested: ${modelName}`);
    
    // Add timing metrics for monitoring CoD vs CoT performance
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
    const originalMaxTokens = requestBody.max_tokens || 4096;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 8192);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens} to meet API requirements`);
    }
    
    const startTime = Date.now();
    
    // Forward the request to Fireworks.ai with timeout
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
        
        return new Response(
          JSON.stringify({ 
            error: `API Error: ${response.statusText}`, 
            details: errorDetails
          }),
          {
            status: response.status,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
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
      return new Response(
        JSON.stringify(data),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        }
      );
    } catch (fetchError) {
      // Clear the timeout to prevent memory leaks
      clearTimeout(timeoutId);
      
      // Check if this is an abort error (timeout)
      if (fetchError.name === 'AbortError') {
        return new Response(
          JSON.stringify({ 
            error: 'Gateway Timeout', 
            message: 'The request to the LLM API took too long to complete (>120 seconds). Try reducing complexity or using fewer tokens.'
          }),
          {
            status: 504,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          }
        );
      }
      
      // Handle other fetch errors
      console.error("Fetch error:", fetchError);
      return new Response(
        JSON.stringify({ 
          error: 'Request Failed', 
          message: fetchError.message
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
