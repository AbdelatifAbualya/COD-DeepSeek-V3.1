// netlify/functions/api-proxy.js
const fetch = require('node-fetch');
const { AbortController } = require('abort-controller');

exports.handler = async function(event, context) {
  // Set the function timeout to 120 seconds (2 minutes)
  context.callbackWaitsForEmptyEventLoop = false;
  
  // Configure fetch timeout to 120 seconds (Netlify's maximum)
  const fetchWithTimeout = async (url, options, timeout = 150000) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log("Request is taking too long, aborting...");
      controller.abort();
    }, timeout);
    
    try {
      options.signal = controller.signal;
      const response = await fetch(url, options);
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  
  // Handle OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
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
    // Get API key from environment variable
    const API_KEY = process.env.FIREWORKS_API_KEY;
    
    if (!API_KEY) {
      console.log("ERROR: API key is missing");
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'API key not configured on server' }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Log request info (non-sensitive)
    console.log("Received request");
    
    try {
      // Parse the request body
      const requestBody = JSON.parse(event.body);
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
      
      const startTime = Date.now();
      
      // Forward the request to Fireworks.ai with timeout
      // Increased timeout to maximum allowed by Netlify (120 seconds)
      const response = await fetchWithTimeout('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify(requestBody)
      }, 120000); // 120 seconds timeout

      const endTime = Date.now();
      const responseTime = endTime - startTime;
      console.log(`Fireworks API response status: ${response.status}, time: ${responseTime}ms, method: ${reasoningMethod}`);
      
      // Check if response is ok
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`API error (${response.status}): ${errorText}`);
        return {
          statusCode: response.status,
          body: JSON.stringify({ 
            error: `API Error: ${response.statusText}`, 
            details: errorText
          }),
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        };
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
      return {
        statusCode: 200,
        body: JSON.stringify(data),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      };
    } catch (parseError) {
      // Check if this is an abort error (timeout)
      if (parseError.name === 'AbortError') {
        console.error("Request timed out after 120 seconds");
        return {
          statusCode: 504,
          body: JSON.stringify({ 
            error: 'Gateway Timeout', 
            message: 'The request to the LLM API took too long to complete (>120 seconds). Try reducing complexity or using fewer tokens.'
          }),
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        };
      }
      
      console.error("Error processing request:", parseError);
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Bad Request', 
          message: 'Error processing request: ' + parseError.message
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }
  } catch (error) {
    console.error('Function error:', error.message, error.stack);
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
