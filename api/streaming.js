// api/streaming.js
// This file is needed for streaming support - it seems it's missing from your files

const fetch = require('node-fetch');
const { createReadStream } = require('stream');

module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse the request body
    const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Get the API key from environment
    const apiKey = process.env.FIREWORKS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send request to Fireworks API
    const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Send error as an event
      res.write(`data: ${JSON.stringify({ error: true, message: errorText })}\n\n`);
      res.end();
      return;
    }

    // Pipe the stream directly to the client
    const stream = response.body;
    stream.on('data', (chunk) => {
      res.write(`data: ${chunk.toString()}\n\n`);
    });

    stream.on('end', () => {
      res.write(`data: [DONE]\n\n`);
      res.end();
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.write(`data: ${JSON.stringify({ error: true, message: err.message })}\n\n`);
      res.end();
    });

  } catch (error) {
    console.error('Error:', error);
    res.write(`data: ${JSON.stringify({ error: true, message: error.message })}\n\n`);
    res.end();
  }
};

// Fixed Perplexity Integration
function initWebSearch() {
  const btn = document.getElementById('webSearchBtn');
  if (!btn) return;
  
  // Update button tooltip with more informative text
  btn.title = "Toggle web search with Perplexity";
  
  // Load saved preference - check both keys for backward compatibility
  const webSearchEnabled = localStorage.getItem('webSearchEnabled') === 'true';
  const perplexityEnabled = localStorage.getItem('usePerplexity') === 'true';
  
  // Use either setting, prioritizing webSearchEnabled
  enableWebSearch = webSearchEnabled || perplexityEnabled;
  
  // Key fix: Set the usePerplexity variable that's used by the sendMessage function
  window.usePerplexity = enableWebSearch; // Make sure they stay in sync
  
  // Update both settings to be consistent
  localStorage.setItem('webSearchEnabled', enableWebSearch.toString());
  localStorage.setItem('usePerplexity', enableWebSearch.toString());
  
  // Update button appearance
  if (enableWebSearch) {
    btn.style.backgroundColor = 'var(--accent-primary)';
    btn.style.color = 'white';
    btn.title = "Web search is enabled (click to disable)";
  } else {
    btn.style.backgroundColor = 'var(--bg-component)';
    btn.style.color = 'var(--text-secondary)';
    btn.title = "Web search is disabled (click to enable)";
  }
  
  // Add event listener with error handling
  try {
    // Remove any existing listeners to prevent duplicates
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    
    // Fix: Properly set the toggle function to update both variables
    newBtn.addEventListener('click', () => {
      // Toggle both flags to keep them in sync
      enableWebSearch = !enableWebSearch;
      window.usePerplexity = enableWebSearch;
      
      // Store preference - save both for backward compatibility
      localStorage.setItem('webSearchEnabled', enableWebSearch.toString());
      localStorage.setItem('usePerplexity', enableWebSearch.toString());
      
      // Update button appearance with transition
      if (enableWebSearch) {
        newBtn.style.backgroundColor = 'var(--accent-primary)';
        newBtn.style.color = 'white';
        newBtn.title = "Web search is enabled (click to disable)";
      } else {
        newBtn.style.backgroundColor = 'var(--bg-component)';
        newBtn.style.color = 'var(--text-secondary)';
        newBtn.title = "Web search is disabled (click to enable)";
      }
      
      // Show notification
      showNotification(enableWebSearch ? 'Web search enabled' : 'Web search disabled');
      
      console.log(`Web search ${enableWebSearch ? 'enabled' : 'disabled'}`);
    });
    
    console.log("Web search button event listener initialized successfully");
  } catch (error) {
    console.error("Error setting up web search button:", error);
  }
}

// Fix for Perplexity API query function
async function queryPerplexity(question) {
  try {
    // Add timestamp to URL to prevent caching
    const timestamp = new Date().getTime();
    const cacheBuster = `?t=${timestamp}`;
    
    console.log("Querying Perplexity for:", question);
    
    // Set a reasonable timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout
    
    const response = await fetch(`/api/perplexity${cacheBuster}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query: question }),
      signal: controller.signal
    });
    
    // Clear the timeout
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      let errorMessage = `Status: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorData.message || errorMessage;
      } catch (e) {
        // If we can't parse JSON, try text
        try {
          errorMessage = await response.text() || errorMessage;
        } catch (e2) {
          // If all else fails, use status code
          errorMessage = `Status: ${response.status}`;
        }
      }
      throw new Error(`Perplexity API error: ${errorMessage}`);
    }
    
    const data = await response.json();
    
    // Improved response handling
    if (!data) {
      throw new Error("Empty response from Perplexity API");
    }
    
    console.log("Perplexity response:", data);
    
    // Return structured data with consistent format
    return {
      answer: data.answer || data.text || (typeof data === 'string' ? data : "No answer provided"),
      sources: data.sources || data.citations || [],
      metadata: data.metadata || {}
    };
  } catch (error) {
    console.error("Perplexity query error:", error);
    
    // Handle specific error types
    let errorMessage = error.message;
    if (error.name === "AbortError") {
      errorMessage = "Request to Perplexity timed out. Please try again or use a shorter query.";
    } else if (error.message.includes("Failed to fetch")) {
      errorMessage = "Could not connect to the Perplexity API. Please check your internet connection.";
    }
    
    return { 
      error: error.message,
      answer: `Error accessing Perplexity: ${errorMessage}. Please try again later or disable web search.`,
      sources: []
    };
  }
}
