// netlify/functions/perplexity-api.js
const { perplexity } = require('@ai-sdk/perplexity');
const { generateText } = require('ai');

exports.handler = async function(event, context) {
  // Handle CORS for preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
      },
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Allow': 'POST'
      }
    };
  }

  try {
    // Parse request body
    const requestBody = JSON.parse(event.body);
    const { query } = requestBody;
    
    if (!query) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Query parameter is required' }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Check if API key is configured
    const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
    if (!PERPLEXITY_API_KEY) {
      console.error("Perplexity API key not configured");
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Perplexity API key not configured on server' }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    console.log(`Querying Perplexity for: "${query}"`);

    // Create custom Perplexity provider with API key
    const customPerplexity = perplexity({
      apiKey: PERPLEXITY_API_KEY
    });

    try {
      // Generate response from Perplexity
      const result = await generateText({
        model: customPerplexity('sonar-pro'),
        prompt: query,
        providerOptions: {
          perplexity: {
            // Set any additional options here
            return_images: false, // Set to true if you have Tier-2 access
          },
        },
      });

      // Get sources from the result
      const { text, sources } = result;
      
      // Get metadata if available
      const metadata = result.providerMetadata?.perplexity || {};
      
      console.log(`Perplexity response received with ${sources?.length || 0} sources`);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          answer: text,
          sources: sources || [],
          metadata: metadata
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    } catch (apiError) {
      console.error('Perplexity API error:', apiError);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Perplexity API Error', 
          message: apiError.message
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }
  } catch (error) {
    console.error('Perplexity request error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Internal Server Error', 
        message: error.message
      }),
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    };
  }
};
