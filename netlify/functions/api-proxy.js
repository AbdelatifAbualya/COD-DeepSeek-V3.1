// netlify/functions/api-proxy.js
const fetch = require('node-fetch');
const { AbortController } = require('abort-controller');

exports.handler = async function(event, context) {
  // Set CORS headers for preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    console.log('Method not allowed:', event.httpMethod);
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    };
  }

  try {
    // Check for DeepSeek API key in environment variables
    const apiKey = process.env.DEEPSEEKAPI || process.env.DEEPSEEK_API_KEY;
    
    if (!apiKey) {
      console.error('No API key found in environment variables');
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'API key not configured',
          message: 'Please set DEEPSEEKAPI in your Netlify environment variables'
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Parse the request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
      console.log('Request received for model:', requestBody.model);
    } catch (parseError) {
      console.error('Error parsing request body:', parseError);
      return {
        statusCode: 400,
        body: JSON.stringify({ 
          error: 'Invalid JSON in request body',
          message: parseError.message
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }
    
    // Log request information
    console.log('Request structure:', {
      model: requestBody.model,
      hasMessages: Array.isArray(requestBody.messages),
      messageCount: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
      temperature: requestBody.temperature,
      max_tokens: requestBody.max_tokens,
      top_p: requestBody.top_p
    });
    
    // Always use DeepSeek V3 regardless of what model is requested
    const originalModelRequested = requestBody.model || "deepseek-chat";
    const modelName = "deepseek-chat"; // Always use DeepSeek V3
    
    console.log(`Original model requested: "${originalModelRequested}", using DeepSeek V3 (deepseek-chat)`);

    // Validate max_tokens - DeepSeek API accepts 1-8192
    let validatedMaxTokens = 4096; // Default
    
    if (requestBody.max_tokens !== undefined) {
      // Ensure max_tokens is within valid range
      validatedMaxTokens = Math.min(Math.max(1, requestBody.max_tokens), 8192);
      
      if (validatedMaxTokens !== requestBody.max_tokens) {
        console.log(`Adjusted max_tokens from ${requestBody.max_tokens} to ${validatedMaxTokens} to meet DeepSeek API requirements`);
      }
    }
    
    // DeepSeek API endpoint
    const apiEndpoint = 'https://api.deepseek.com/v1/chat/completions';
    console.log(`Using DeepSeek API endpoint: ${apiEndpoint}`);
    
    // Construct parameters accepted by DeepSeek
    const supportedParams = {
      model: modelName,
      messages: requestBody.messages,
      max_tokens: validatedMaxTokens,
      temperature: requestBody.temperature,
      top_p: requestBody.top_p,
      n: requestBody.n,
      stream: requestBody.stream,
      stop: requestBody.stop,
      presence_penalty: requestBody.presence_penalty,
      frequency_penalty: requestBody.frequency_penalty
    };
    
    // Remove null or undefined values
    const cleanedParams = Object.entries(supportedParams)
      .reduce((acc, [key, value]) => {
        if (value !== null && value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {});
    
    console.log('Sending request with model:', cleanedParams.model);
    
    // Implement retry logic with exponential backoff
    let retries = 3;
    let response;
    
    while (retries > 0) {
      try {
        // Set up abort controller with timeout - 2.5 minutes
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 150000);
        
        // Construct request options
        const requestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(cleanedParams),
          signal: controller.signal
        };
        
        console.log(`Sending request to DeepSeek API (attempt ${4-retries}/3)`);
        
        // Make request to the DeepSeek API
        response = await fetch(apiEndpoint, requestOptions);
        
        // Clear timeout
        clearTimeout(timeoutId);
        
        console.log(`Received response with status: ${response.status}`);
        
        // On 502/503 errors, retry; otherwise, break the loop
        if (response.status === 502 || response.status === 503) {
          console.log(`Received ${response.status} from DeepSeek API, retrying...`);
          retries--;
          // Exponential backoff before retrying
          const backoffTime = (4 - retries) * 2000;
          console.log(`Waiting ${backoffTime}ms before retry`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        } else {
          // For any other status (success or other errors), break the retry loop
          break;
        }
      } catch (fetchError) {
        console.error('Fetch error:', fetchError.name, fetchError.message);
        retries--;
        
        if (retries === 0) throw fetchError;
        
        // Exponential backoff before retrying
        const backoffTime = (4 - retries) * 2000;
        console.log(`Waiting ${backoffTime}ms before retry`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }

    // If we exhausted retries and still don't have a response
    if (!response) {
      throw new Error('Failed to get response from DeepSeek API after multiple attempts');
    }

    // Handle response errors
    if (!response.ok) {
      const errorData = await response.text();
      console.error(`DeepSeek API error: ${response.status}`, errorData);
      
      let errorMessage;
      try {
        // Try to parse error as JSON
        const parsedError = JSON.parse(errorData);
        errorMessage = parsedError.error?.message || 'Unknown API error';
        
        // Check for specific errors
        if (errorMessage.includes('max_tokens')) {
          errorMessage = `Invalid max_tokens value. The DeepSeek API accepts values between 1 and 8192.`;
        }
      } catch {
        // If parsing fails, use the raw text
        errorMessage = errorData || `Error ${response.status}`;
      }
      
      // Special error message for 401 errors
      if (response.status === 401) {
        errorMessage = "Authentication failed. Please check your DeepSeek API key.";
      }
      
      return {
        statusCode: response.status,
        body: JSON.stringify({ 
          error: `DeepSeek API error: ${response.status}`,
          message: errorMessage,
          details: {
            possible_fixes: [
              "Verify the API key is correct in Netlify",
              "Ensure your DeepSeek API subscription is active",
              "Try reducing max_tokens if you're getting timeout errors"
            ]
          }
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Parse the successful response
    const data = await response.json();
    console.log('Received successful response from DeepSeek API');
    
    // Log token usage if available
    if (data.usage) {
      console.log(`Token usage: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, total=${data.usage.total_tokens}`);
    }

    // Return the response
    return {
      statusCode: 200,
      body: JSON.stringify(data),
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    };
  } catch (error) {
    console.error('Function error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
    
    // Special error message for abort errors (timeouts)
    let errorMessage = error.message || 'Unknown error occurred';
    if (error.name === 'AbortError' || errorMessage.includes('abort')) {
      errorMessage = "Request timed out. Try reducing the max_tokens value or simplifying your prompt.";
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: errorMessage,
        details: {
          name: error.name,
          message: error.message,
          suggestions: [
            "Try reducing max_tokens (8192 maximum)",
            "Simplify your prompt or use shorter messages",
            "Try again later if service is experiencing high load"
          ]
        }
      }),
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    };
  }
};
