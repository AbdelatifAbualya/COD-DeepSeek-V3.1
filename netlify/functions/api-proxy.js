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
    const apiKey = process.env.DEEPSEEK_API_KEY;
    
    // Debug logging for API key (safely shows just the first 4 characters)
    console.log('API Key configured:', apiKey ? `Yes (first 4 chars: ${apiKey.substring(0, 4)})` : 'No');
    
    if (!apiKey) {
      console.error('No API key found in environment variables');
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'API key not configured',
          message: 'Please set DEEPSEEK_API_KEY in your Netlify environment variables'
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Parse the request body
    const requestBody = JSON.parse(event.body);
    console.log('Request received for model:', requestBody.model);
    
    // Force the model to be DeepSeek-V3 regardless of what was sent
    requestBody.model = "deepseek-chat";
    console.log('Using model: deepseek-chat (DeepSeek-V3)');
    
    // Check if token limit is set and warn if very high
    if (requestBody.max_tokens && requestBody.max_tokens > 32000) {
      console.log(`Warning: Using a very high token limit of ${requestBody.max_tokens}. Make sure your model supports this.`);
    }
    
    // Set default max tokens to 8192 if not specified
    if (!requestBody.max_tokens) {
      requestBody.max_tokens = 8192;
      console.log('Setting default max_tokens to 8192');
    }
    
    // DeepSeek API endpoint for chat completions
    const apiEndpoint = 'https://api.deepseek.com/v1/chat/completions';
    console.log(`Using DeepSeek API endpoint: ${apiEndpoint}`);
    
    // Filter out parameters not supported by DeepSeek API if needed
    const supportedParams = {
      model: requestBody.model,
      messages: requestBody.messages,
      max_tokens: requestBody.max_tokens,
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
    
    console.log('Sending cleaned params to DeepSeek API');
    
    // Implement retry logic
    let retries = 3;
    let response;
    
    while (retries > 0) {
      try {
        // Set up abort controller with increased timeout (180 seconds for large token limits)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3-minute timeout
        
        // Make a request to the DeepSeek API
        console.log(`Sending request to DeepSeek API (attempts remaining: ${retries})`);
        response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(cleanedParams),
          signal: controller.signal
        });
        
        // Clear timeout
        clearTimeout(timeoutId);
        
        // If we get a 502, retry; otherwise, break the loop
        if (response.status === 502) {
          console.log('Received 502 from DeepSeek API, retrying...');
          retries--;
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, (3 - retries) * 3000));
        } else {
          // For any other status (success or other errors), break the retry loop
          break;
        }
      } catch (fetchError) {
        console.error('Fetch error:', fetchError);
        retries--;
        if (retries === 0) throw fetchError;
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, (3 - retries) * 3000));
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
        
        // Check if the error is related to token limit
        if (errorMessage.includes('token') && errorMessage.includes('limit')) {
          errorMessage = `Token limit exceeded. The model may not support ${requestBody.max_tokens || 'the requested'} tokens. Try reducing the max_tokens value.`;
        }
      } catch {
        // If parsing fails, use the raw text
        errorMessage = errorData || `Error ${response.status}`;
      }
      
      // Special error message for 401 errors
      if (response.status === 401) {
        errorMessage = "Authentication failed. Please check your DeepSeek API key value in Netlify environment variables.";
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
              "Try reducing max_tokens if you're getting timeout or content length errors"
            ]
          }
        }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      };
    }

    // Parse the response
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
    console.error('Function error:', error);
    
    // Special error message for abort errors (timeouts)
    let errorMessage = error.message || 'Unknown error occurred';
    if (error.name === 'AbortError' || errorMessage.includes('abort')) {
      errorMessage = "Request timed out. Try reducing the max_tokens value or using a model that supports larger outputs.";
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: errorMessage,
        details: {
          name: error.name,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          suggestions: [
            "Verify API key is set correctly in Netlify environment variables",
            "Try reducing max_tokens if you're getting timeout errors",
            "Ensure network connection is stable",
            "Verify your DeepSeek API subscription is active"
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
