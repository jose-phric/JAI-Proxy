const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const path = require("path");


const app = express();
const port = 3000;

// Configuration constants
const MODEL_DEFAULTS = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40
};
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'e6a03e1a4bcd47d1ade91408252607';

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

const agent = new https.Agent({
  keepAlive: true,
  secureProtocol: 'TLSv1_2_method',
});

const weatherCache = {};

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));  

// Serve the index.html file for the root pathapp.use(express.static(path.join(__dirname, 'public')));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// --- Utility Functions ---


function ensureMarkdownFormatting(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

function cleanResponseText(text) {
  return text.trim().replace(/^"(.*)"$/, '$1');
}

function simulateStreamingResponse(content, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Split content into words for more natural streaming
  const words = content.split(' ');
  let index = 0;

  const sendChunk = () => {
    if (index >= words.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Send chunks as JSON objects like real OpenAI API
    const chunk = {
      id: `chat-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'openrouter/auto',
      choices: [{
        delta: { content: words[index] + ' ' },
        index: 0,
        finish_reason: null
      }]
    };

    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    index++;
    setTimeout(sendChunk, 20); // Adjust speed as needed
  };

  sendChunk();
}

// --- Core Handler ---
app.post('/v1/chat/completions', async (req, res) => {
  const isStreamingRequested = req.body?.stream;
  const clientBody = req.body;
  
  try {
    // --- Pre-process System Message ---
    const systemMsg = clientBody.messages?.find(m => m.role === 'system');
    if (systemMsg?.content) {
      const summaryMatch = systemMsg.content.match(/<summary>(.*?)<\/summary>/s);
      if (summaryMatch) {
        const tagContent = summaryMatch[1];
        
        // Time processing
        const timeMatch = tagContent.match(/TIME:UTC([+-]\d+)/);
        if (timeMatch) {
          const offsetHours = parseInt(timeMatch[1]);
          const serverTime = new Date(Date.now() + offsetHours * 3600000)
            .toISOString().replace('T', ' ').slice(0, 19);
          systemMsg.content += `\n <OOC : Current Time and Date: ${serverTime}>`;
        }

        // Location and weather processing
        const locMatch = tagContent.match(/LOCATION:([\w\s-]+)/);
        if (locMatch) {
          const city = locMatch[1].trim();
          const now = Date.now();
          systemMsg.content += `\n <OOC : Location: ${city}>`;

          if (weatherCache[city]?.timestamp && (now - weatherCache[city].timestamp < 3600000)) {
            systemMsg.content += `\n <OOC : Current Weather ${weatherCache[city].text}, ${weatherCache[city].temp}°C>`;
          } else {
            try {
              const { data } = await axios.get('https://api.weatherapi.com/v1/current.json', {
                params: { key: 'e6a03e1a4bcd47d1ade91408252607', q: city, aqi: 'no' },
                timeout: 5000
              });
              
              if (data?.current) {
                weatherCache[city] = {
                  timestamp: now,
                  text: data.current.condition.text,
                  temp: data.current.temp_c
                };
                systemMsg.content += `\n🌤️ Weather: ${data.current.condition.text}, ${data.current.temp_c}°C`;
              }
            } catch (err) {
              console.error('Weather API error:', err.message);
            }
          }
        }
      }
    }

    // --- Prepare OpenRouter Payload ---
    const openRouterPayload = {
      ...clientBody,
      messages: clientBody.messages,
      stream: false // Always request full response from OpenRouter
    };


    // --- Call OpenRouter API ---
    let apiKey = null;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      apiKey = req.headers.authorization.split(' ')[1].trim();
    } else if (req.headers['x-api-key']) {
      apiKey = req.headers['x-api-key'].trim();
    } else if (req.body?.api_key) {
      apiKey = req.body.api_key;
      delete req.body.api_key;
    } else if (req.query.api_key) {
      apiKey = req.query.api_key;
    }

    console.log('[OpenRouter] Sending request with:');
console.log('→ URL:', 'https://openrouter.ai/api/v1/chat/completions');
console.log('→ Headers:', {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${apiKey.slice(0, 5)}...redacted`,
  'HTTP-Referer': 'https://janitorai.com',
  'X-Title': 'Aria Extension'
});
console.log('→ Payload:', JSON.stringify(openRouterPayload, null, 2));
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      openRouterPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://janitorai.com',
          'X-Title': 'Aria Extension'
        },
        httpsAgent: agent,
        timeout: 30000
      }
    );
    // --- Process Response ---
    if (!response.data?.choices?.[0]?.message?.content) {
      throw new Error('Invalid response structure from OpenRouter');
    }

    let content = response.data.choices[0].message.content;
    content = cleanResponseText(content);
    content = ensureMarkdownFormatting(content);

    // --- Handle Streaming vs Non-Streaming ---
    if (isStreamingRequested) {
      simulateStreamingResponse(content, res);
    } else {
      res.json({
        choices: [{
          message: { role: 'assistant', content },
          finish_reason: response.data.choices[0].finish_reason || 'stop'
        }],
        created: response.data.created || Math.floor(Date.now() / 1000),
        id: response.data.id || `chat-${Date.now()}`,
        model: response.data.model,
        object: 'chat.completion',
        usage: response.data.usage || { 
          prompt_tokens: 0, 
          completion_tokens: 0, 
          total_tokens: 0 
        }
      });
    }

  } catch (err) {
    console.error('Request failed:', err.message);
    const errorMessage = err.response?.data?.error?.message || err.message;
    
    if (isStreamingRequested) {
      simulateStreamingResponse(`❌ Error: ${errorMessage}`, res);
    } else {
      res.status(500).json({
        choices: [{
          message: { 
            role: 'assistant', 
            content: `❌ Error: ${errorMessage}` 
          },
          finish_reason: 'error'
        }]
      });
    }
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Proxy server running on port ${port}`);
  console.log(`🔁 Streaming simulation enabled`);
});