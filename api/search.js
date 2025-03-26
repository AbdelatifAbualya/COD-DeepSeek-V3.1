// api/perplexity.js
import { perplexity } from '@ai-sdk/perplexity';
import { generateText } from 'ai';

export default async function handler(req, res) {
  // Handle CORS for preflight requests
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    // Check if API key is configured
    if (!process.env.PERPLEXITY_API_KEY) {
      console.error("Perplexity API key not configured");
      return res.status(500).json({ error: 'Perplexity API not configured on server' });
    }

    console.log(`Querying Perplexity for: "${query}"`);

    try {
      // Generate response from Perplexity
      const result = await generateText({
        model: perplexity('sonar-pro'),
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
      
      return res.status(200).json({
        answer: text,
        sources: sources || [],
        metadata: metadata
      });
    } catch (apiError) {
      console.error('Perplexity API error:', apiError);
      return res.status(500).json({
        error: 'Perplexity API Error',
        message: apiError.message
      });
    }
  } catch (error) {
    console.error('Perplexity request error:', error);
    return res.status(500).json({ 
      error: 'Internal Server Error', 
      message: error.message
    });
  }
}
