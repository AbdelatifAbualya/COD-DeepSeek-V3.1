// api/perplexity.js - Fixed and improved version

import fetch from 'node-fetch';

export default async function handler(req, res) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Get the Perplexity API key from environment variables
    const apiKey = process.env.PERPLEXITY_API_KEY;
    
    if (!apiKey) {
      res.status(500).json({
        error: 'API key not configured',
        message: 'Please set PERPLEXITY_API_KEY in your Vercel environment variables'
      });
      return;
    }

    // Parse request body
    const { query } = req.body;
    
    if (!query) {
      res.status(400).json({ error: 'Query parameter is required' });
      return;
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

    // Set up timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25-second timeout
    
    try {
      // Call the Perplexity API
      const response = await fetch(perplexityEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(perplexityPayload),
        signal: controller.signal
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        let errorText;
        try {
          errorText = await response.text();
        } catch (e) {
          errorText = `Error ${response.status}`;
        }
        
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || 'Unknown API error';
        } catch {
          errorMessage = errorText || `Error ${response.status}`;
        }
        
        console.error(`Perplexity API error: ${response.status} - ${errorMessage}`);
        
        res.status(response.status).json({
          error: `Perplexity API error: ${response.status}`,
          message: errorMessage
        });
        return;
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
      res.status(200).json(formattedResponse);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    console.error('Perplexity API error:', error.name, error.message);
    
    // Special handling for timeout errors
    let errorMessage = error.message || 'Unknown error';
    let statusCode = 500;
    
    if (error.name === "AbortError") {
      errorMessage = "The request to Perplexity took too long. Please try again.";
      statusCode = 504; // Gateway Timeout
    }
    
    res.status(statusCode).json({
      error: errorMessage,
      details: {
        name: error.name,
        message: error.message
      }
    });
  }
}
