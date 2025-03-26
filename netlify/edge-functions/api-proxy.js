// netlify/edge-functions/api-proxy.js

export default async (request, context) => {
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
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }

  try {
    // Get the Fireworks API key from environment variables
    const apiKey = Deno.env.get('FIREWORKS_API_KEY');
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'API key not configured',
          message: 'Please set FIREWORKS_API_KEY in your Netlify environment variables'
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

    // Log request information
    console.log('Request received for model:', requestBody.model || 'unknown');
    
    // Prepare request for Fireworks API
    const apiEndpoint = 'https://api.fireworks.ai/inference/v1/chat/completions';
    
    // Validate max_tokens (Fireworks models accept different limits based on model)
    const originalMaxTokens = requestBody.max_tokens || 4096;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 8192);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens}`);
    }
    
    const cleanedParams = {
      model: requestBody.model,
      messages: requestBody.messages,
      max_tokens: validatedMaxTokens,
      temperature: requestBody.temperature,
      top_p: requestBody.top_p,
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
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 28000); // 28-second timeout
    });
    
    const fetchPromise = fetch(apiEndpoint, apiRequestOptions);
    
    // Race between fetch and timeout
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    
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
      
      return new Response(
        JSON.stringify({
          error: `Fireworks API error: ${response.status}`,
          message: errorMessage
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
    
    // Successfully got a response
    const data = await response.json();
    
    // Return the response to the client
    return new Response(
      JSON.stringify(data),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  } catch (error) {
    console.error('Edge function error:', error.name, error.message);
    
    // Special handling for timeout errors
    let errorMessage = error.message || 'Unknown error';
    let statusCode = 500;
    
    if (error.message === 'Request timeout') {
      errorMessage = "The request took too long to process. Try reducing max_tokens or simplifying your prompt.";
      statusCode = 504; // Gateway Timeout
    }
    
    return new Response(
      JSON.stringify({
        error: errorMessage,
        details: {
          name: error.name,
          message: error.message
        }
      }),
      {
        status: statusCode,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}
