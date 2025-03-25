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
    // DEBUGGING: Log environment variables (safely)
    console.log('Environment check:', {
      hasDEEPSEEKAPI: !!process.env.DEEPSEEKAPI,
      hasDEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
      keyLength: process.env.DEEPSEEKAPI ? process.env.DEEPSEEKAPI.length : (process.env.DEEPSEEK_API_KEY ? process.env.DEEPSEEK_API_KEY.length : 0),
      availableEnvVars: Object.keys(process.env).filter(key => key.includes('DEEPSEEK') || key.includes('API'))
    });

    // Check for DeepSeek API key in environment variables (try both possible names)
    // Using the provided API key "sk-fbbeed48dde046d5812669b237080836"
    const apiKey = process.env.DEEPSEEKAPI || process.env.DEEPSEEK_API_KEY || "sk-fbbeed48dde046d5812669b237080836";
    
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
    
    // DEBUGGING: Log the request structure (without the full messages content for brevity)
    console.log('Request structure:', {
      model: requestBody.model,
      hasMessages: Array.isArray(requestBody.messages),
      messageCount: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
      temperature: requestBody.temperature,
      max_tokens: requestBody.max_tokens,
      top_p: requestBody.top_p,
      stream: requestBody.stream
    });
    
    // Force DeepSeek V3 (deepseek-chat) regardless of what model is requested
    // This ensures all requests use only DeepSeek V3
    const originalModelRequested = requestBody.model || "deepseek-chat";
    const modelName = "deepseek-chat"; // Always use DeepSeek V3
    
    console.log(`Original model requested: "${originalModelRequested}", using DeepSeek V3 (deepseek-chat)`);

    
    // Check if token limit is set and warn if very high
    if (requestBody.max_tokens && requestBody.max_tokens > 32000) {
      console.log(`Warning: Using a very high token limit of ${requestBody.max_tokens}. Make sure your model supports this.`);
    }
    
    // Set default max tokens to 4096 if not specified (reduced from 8192)
    if (!requestBody.max_tokens) {
      requestBody.max_tokens = 4096;
      console.log('Setting default max_tokens to 4096');
    }
    
    // DeepSeek API endpoint for chat completions
    const apiEndpoint = 'https://api.deepseek.com/v1/chat/completions';
    console.log(`Using DeepSeek API endpoint: ${apiEndpoint}`);
    
    // Filter out parameters not supported by DeepSeek API if needed
    const supportedParams = {
      model: modelName,
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
    
    console.log('Sending request with model:', cleanedParams.model);
    
    // DEBUGGING: For initial troubleshooting, try a simplified test request
    const testMode = false; // Set to true for testing
    
    let paramsToSend;
    if (testMode) {
      // Simple test payload for debugging
      paramsToSend = {
        model: modelName,
        messages: [
          {role: "system", content: "You are a helpful assistant."},
          {role: "user", content: "Say hello"}
        ],
        max_tokens: 100,
        temperature: 0.7,
        top_p: 0.95
      };
      console.log('TEST MODE: Using simplified test request');
    } else {
      paramsToSend = cleanedParams;
    }
    
    // Implement retry logic
    let retries = 3;
    let response;
    
    while (retries > 0) {
      try {
        // Set up abort controller with 3-minute timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);
        
        // Construct request options
        const requestOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(paramsToSend),
          signal: controller.signal
        };
        
        // DEBUGGING: Log the request being made (safely, without exposing auth token)
        console.log(`Sending request to DeepSeek API (attempt ${4-retries}/3)`, {
          endpoint: apiEndpoint,
          method: requestOptions.method,
          headers: Object.keys(requestOptions.headers),
          bodyLength: requestOptions.body.length
        });
        
        // Make a request to the DeepSeek API
        response = await fetch(apiEndpoint, requestOptions);
        
        // Clear timeout
        clearTimeout(timeoutId);
        
        // Log response status
        console.log(`Received response with status: ${response.status}`);
        
        // If we get a 502, retry; otherwise, break the loop
        if (response.status === 502) {
          console.log('Received 502 from DeepSeek API, retrying...');
          retries--;
          // Wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, (4 - retries) * 2000));
        } else {
          // For any other status (success or other errors), break the retry loop
          break;
        }
      } catch (fetchError) {
        console.error('Fetch error:', fetchError.name, fetchError.message);
        retries--;
        if (retries === 0) throw fetchError;
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, (4 - retries) * 2000));
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
          error: `DeepSeek V3 API error: ${response.status}`,
          message: errorMessage,
          details: {
            possible_fixes: [
              "Verify the API key is correct in Netlify",
              "Ensure your DeepSeek API subscription is active",
              "Try reducing max_tokens if you're getting timeout or content length errors",
              "The application is configured to only use DeepSeek V3"
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
    console.error('Function error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
    
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
          message: error.message,
          suggestions: [
            "Verify API key is set correctly in Netlify environment variables",
            "Try reducing max_tokens if you're getting timeout errors",
            "Check if the DeepSeek API endpoint is correct",
            "Verify your DeepSeek API subscription is active",
            "Check if the model name is valid"
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
