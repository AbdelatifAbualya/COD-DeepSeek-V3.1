// api/streaming-edge.js
// This file is specifically for Vercel Edge Functions
export const config = {
  runtime: 'edge',
  regions: ['iad1'], // Optional: you can specify regions or use 'auto'
};

export default async function handler(request) {
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
    // Get API key from environment variable
    const apiKey = process.env.FIREWORKS_API_KEY;
    
    if (!apiKey) {
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
    
    // Make sure model is specified and stream is true
    if (!requestBody.model) {
      return new Response(
        JSON.stringify({
          error: 'Missing model parameter',
          message: 'Model parameter is required'
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
    
    // Force stream parameter to true
    requestBody.stream = true;
    
    // Set default parameters if not provided
    if (requestBody.max_tokens === undefined) requestBody.max_tokens = 4008;
    if (requestBody.top_p === undefined) requestBody.top_p = 1;
    if (requestBody.top_k === undefined) requestBody.top_k = 40;
    if (requestBody.presence_penalty === undefined) requestBody.presence_penalty = 0;
    if (requestBody.frequency_penalty === undefined) requestBody.frequency_penalty = 0;
    if (requestBody.temperature === undefined) requestBody.temperature = 0.6;
    
    // Validate max_tokens
    requestBody.max_tokens = Math.min(Math.max(1, requestBody.max_tokens), 8192);
    
    // Log request details for monitoring
    console.log(`Streaming request: model=${requestBody.model}`);
    
    // Create a transform stream for processing
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    
    // Start the response immediately with streaming headers
    const response = new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    });
    
    // Process in background
    (async () => {
      try {
        // Call the Fireworks API with streaming enabled
        const fireworksResponse = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });
        
        if (!fireworksResponse.ok) {
          // Handle API error responses
          let errorDetails;
          try {
            errorDetails = await fireworksResponse.text();
          } catch (e) {
            errorDetails = `Status code: ${fireworksResponse.status}`;
          }
          
          const errorMessage = `data: ${JSON.stringify({ 
            error: true, 
            message: `API Error: ${fireworksResponse.statusText}`,
            details: errorDetails
          })}\n\n`;
          
          await writer.write(encoder.encode(errorMessage));
          await writer.close();
          return;
        }
        
        // Handle streaming response from Fireworks API
        const reader = fireworksResponse.body.getReader();
        const decoder = new TextDecoder();
        
        let incompleteChunk = '';
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              break;
            }
            
            // Decode the chunk and combine with any incomplete data from previous iteration
            const textChunk = incompleteChunk + decoder.decode(value, { stream: true });
            
            // Split by lines and process each SSE message
            const lines = textChunk.split('\n');
            
            // The last line might be incomplete, save it for the next iteration
            incompleteChunk = lines.pop() || '';
            
            // Process all complete lines
            for (const line of lines) {
              // Skip empty lines
              if (!line.trim()) {
                continue;
              }
              
              // Forward data messages directly
              if (line.startsWith('data:')) {
                await writer.write(encoder.encode(line + '\n\n'));
              } else {
                // For non-data lines, wrap them in a proper SSE format
                await writer.write(encoder.encode(`data: ${line}\n\n`));
              }
            }
          }
          
          // Process any remaining incomplete chunk
          if (incompleteChunk) {
            await writer.write(encoder.encode(`data: ${incompleteChunk}\n\n`));
          }
          
          // Signal the end of the stream
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        } catch (streamError) {
          console.error('Stream processing error:', streamError);
          
          // Communicate stream error to client
          const errorMessage = `data: ${JSON.stringify({ 
            error: true, 
            message: `Stream processing error: ${streamError.message}`
          })}\n\n`;
          
          await writer.write(encoder.encode(errorMessage));
        } finally {
          await writer.close();
        }
      } catch (error) {
        console.error('Fetch error:', error);
        
        // Communicate fetch error to client
        const errorMessage = `data: ${JSON.stringify({ 
          error: true, 
          message: `Request failed: ${error.message}`
        })}\n\n`;
        
        await writer.write(encoder.encode(errorMessage));
        await writer.close();
      }
    })();
    
    return response;
  } catch (error) {
    console.error('Handler error:', error);
    
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
