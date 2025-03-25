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
    // Get the DeepSeek API key from environment variables
    const apiKey = Deno.env.get('DEEPSEEKAPI') || Deno.env.get('DEEPSEEK_API_KEY');
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'API key not configured',
          message: 'Please set DEEPSEEKAPI in your Netlify environment variables'
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
    
    // Always use DeepSeek Chat V3
    const modelName = "deepseek-chat";
    
    // Properly validate max_tokens (DeepSeek API accepts 1-8192)
    const originalMaxTokens = requestBody.max_tokens || 4096;
    const validatedMaxTokens = Math.min(Math.max(1, originalMaxTokens), 8192);
    
    if (originalMaxTokens !== validatedMaxTokens) {
      console.log(`Adjusted max_tokens from ${originalMaxTokens} to ${validatedMaxTokens} to meet DeepSeek API requirements`);
    }
    
    // Prepare request for DeepSeek API
    const apiEndpoint = 'https://api.deepseek.com/v1/chat/completions';
    
    const cleanedParams = {
      model: modelName,
      messages: requestBody.messages,
      max_tokens: validatedMaxTokens,
      temperature: requestBody.temperature,
      top_p: requestBody.top_p,
      stream: false // Edge functions could support streaming but we'll keep it simple
    };

    // Remove undefined or null values
    Object.keys(cleanedParams).forEach(key => {
      if (cleanedParams[key] === undefined || cleanedParams[key] === null) {
        delete cleanedParams[key];
      }
    });
    
    // Set up the DeepSeek API request
    const apiRequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(cleanedParams)
    };
    
    // Call the DeepSeek API with a timeout
    // Use AbortController via Promise.race to implement timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 28000); // 28-second timeout (slightly increased)
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
        errorMessage = "Authentication failed. Please check your DeepSeek API key.";
      } else if (response.status === 400 && errorMessage.includes('max_tokens')) {
        errorMessage = "Invalid max_tokens value. The DeepSeek API accepts values between 1 and 8192.";
      } else if (response.status === 429) {
        errorMessage = "Rate limit exceeded. Please try again in a few moments.";
      }
      
      return new Response(
        JSON.stringify({
          error: `DeepSeek API error: ${response.status}`,
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
