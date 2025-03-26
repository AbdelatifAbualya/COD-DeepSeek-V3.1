// netlify/edge-functions/perplexity.js

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
    // Get the Perplexity API key from environment variables
    const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
    
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'API key not configured',
          message: 'Please set PERPLEXITY_API_KEY in your Netlify environment variables'
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

    const { query } = requestBody;
    
    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Query parameter is required' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    }

    console.log(`Querying Perplexity for: "${query}"`);

    // Prepare request for Perplexity API
    const perplexityEndpoint = 'https://api.perplexity.ai/chat/completions';
    
    const perplexityPayload = {
      model: "sonar-pro",
      messages: [
        {
          role: "system",
          content: "You are a helpful web search assistant. Provide accurate, detailed answers based on available information. Include all relevant sources in your response."
        },
        {
          role: "user",
          content: query
        }
      ]
    };

    const apiRequestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(perplexityPayload)
    };
    
    // Call the Perplexity API with a timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout')), 25000); // 25-second timeout
    });
    
    const fetchPromise = fetch(perplexityEndpoint, apiRequestOptions);
    
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
      
      return new Response(
        JSON.stringify({
          error: `Perplexity API error: ${response.status}`,
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
    
    // Process successful response
    const data = await response.json();
    
    // Extract answer and sources if available
    const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    
    // Parse sources from the answer - this is a simple heuristic
    const sources = [];
    const sourceRegex = /\[(.*?)\]\((https?:\/\/[^\s\)]+)\)/g;
    let match;
    while ((match = sourceRegex.exec(answer)) !== null) {
      sources.push({
        title: match[1],
        url: match[2]
      });
    }
    
    const formattedResponse = {
      answer: answer,
      sources: sources,
      metadata: {
        model: data.model,
        usage: data.usage
      }
    };
    
    // Return the response to the client
    return new Response(
      JSON.stringify(formattedResponse),
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
      errorMessage = "The request to Perplexity took too long. Please try again.";
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
};
