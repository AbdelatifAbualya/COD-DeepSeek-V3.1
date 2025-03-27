// Vercel/Netlify Function to handle Perplexity API requests
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Log function invocation to help with debugging
  console.log("Perplexity API endpoint called:", new Date().toISOString());

  // Handle OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(204).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    // Get Perplexity API key from environment variable
    const API_KEY = process.env.PERPLEXITY_API_KEY;
    console.log("Environment check: PERPLEXITY_API_KEY exists?", !!API_KEY);
    
    if (!API_KEY) {
      console.error("ERROR: Perplexity API key is missing");
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({ error: 'Perplexity API key not configured on server' });
      return;
    }

    // Parse the request body
    let requestBody;
    try {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      console.error("Failed to parse request body:", parseError);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ 
        error: 'Invalid JSON in request body', 
        message: parseError.message 
      });
      return;
    }

    // Validate the query parameter
    if (!requestBody.query) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ error: 'Missing required parameter: query' });
      return;
    }

    // Log the query (truncate if very long)
    const truncatedQuery = requestBody.query.substring(0, 100) + 
                          (requestBody.query.length > 100 ? '...' : '');
    console.log(`Perplexity query: "${truncatedQuery}"`);
    
    // Set a timeout for the request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 seconds timeout
    
    try {
      // Forward the request to Perplexity API
      const response = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [
            { 
              role: "system", 
              content: "You are a helpful assistant that provides accurate information with online search capabilities." 
            },
            { 
              role: "user", 
              content: requestBody.query 
            }
          ],
          temperature: 0.7,
          max_tokens: 2048,
          stream: false
        }),
        signal: controller.signal
      });
      
      // Clear the timeout
      clearTimeout(timeoutId);
      
      // Check if response is ok
      if (!response.ok) {
        let errorText = await response.text();
        console.error(`Perplexity API error (${response.status}): ${errorText}`);
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(response.status).json({ 
          error: `Perplexity API Error: ${response.statusText}`, 
          details: errorText
        });
        return;
      }
      
      // Parse the response data
      const data = await response.json();
      console.log("Perplexity API response received successfully");
      
      // Extract the answer and any citations/sources
      let responseData = {
        answer: data.choices[0].message.content,
        sources: []
      };
      
      // Check if there are any tool calls for citations
      if (data.choices[0].message.tool_calls) {
        try {
          // Extract citations if they exist in the tool_calls
          const citations = data.choices[0].message.tool_calls.filter(
            tool => tool.function.name === "citation" || tool.function.name === "web_search"
          );
          
          if (citations.length > 0) {
            console.log(`Found ${citations.length} citations in response`);
            
            // Parse citation arguments and add to sources
            responseData.sources = citations.map(citation => {
              try {
                const args = JSON.parse(citation.function.arguments);
                return {
                  title: args.title || "Source",
                  url: args.url || "",
                  snippet: args.snippet || ""
                };
              } catch (e) {
                console.error("Error parsing citation arguments:", e);
                return { title: "Citation", url: "#" };
              }
            });
          }
        } catch (e) {
          console.warn("Error parsing citations:", e);
        }
      }
      
      // Return processed response
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.status(200).json(responseData);
      
    } catch (fetchError) {
      // Clear the timeout to prevent memory leaks
      clearTimeout(timeoutId);
      
      // Check if this is an abort error (timeout)
      if (fetchError.name === 'AbortError') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(504).json({ 
          error: 'Gateway Timeout', 
          message: 'The request to the Perplexity API took too long to complete (>25 seconds).'
        });
        return;
      }
      
      // Handle other fetch errors
      console.error("Fetch error:", fetchError);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(500).json({ 
        error: 'Request Failed', 
        message: fetchError.message
      });
    }
  } catch (error) {
    console.error('Function error:', error.message, error.stack);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ 
      error: 'Internal Server Error', 
      message: error.message
    });
  }
};
