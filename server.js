const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const path = require("path");
const JAILBREAK = require('./jailbreak.js');
const app = express();
const port = 3000;

// Configs
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || 'e6a03e1a4bcd47d1ade91408252607';
const weatherCache = {};

const agent = new https.Agent({
  keepAlive: true,
  secureProtocol: 'TLSv1_2_method',
});

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
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
function extractApiKey(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1].trim();
  }
  return req.headers['x-api-key'] || req.body?.api_key || req.query.api_key || '';
}
function simulateStreamingResponse(content, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const words = content.split(' ');
  let index = 0;
  const sendChunk = () => {
    if (index >= words.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const chunk = {
      id: `chat-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'proxy/auto',
      choices: [{
        delta: { content: words[index] + ' ' },
        index: 0,
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    index++;
    setTimeout(sendChunk, 20);
  };
  sendChunk();
}

// --- Gemini Handler ---
async function routeToGemini(req, clientBody) {
  const geminiKey = extractApiKey(req); // your custom dynamic key parser
  const modelName = clientBody.model || 'gemini-pro'; // <- dynamically pulled
  const endpoint = 'generateContent';

  const messages = clientBody.messages.map(m => {
    return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
  }).join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;

  const response = await axios.post(
    url,
    {
      contents: [{ parts: [{ text: messages }] }]
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  return {
    choices: [{
      message: { role: 'assistant', content: text },
      finish_reason: 'stop'
    }],
    id: `chat-${Date.now()}`,
    model: modelName,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion'
  };
}


// --- OpenRouter Handler ---
async function routeToOpenRouter(req, clientBody) {
  const apiKey = extractApiKey(req);

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    { ...clientBody, stream: false },
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

  return response.data;
}

// --- Main Chat Route ---
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const clientBody = req.body;
    let targetLLM = 'or'; // Default is OpenRouter

    let systemMsg = clientBody.messages.find(m => m.role === 'system');

    // Detect <LLM:gemini> or <LLM:or>
    if (systemMsg?.content) {
      const llmMatch = systemMsg.content.match(/<LLM:([\w-]+)>/i);
      if (llmMatch) {
        targetLLM = llmMatch[1].toLowerCase();
        systemMsg.content = systemMsg.content.replace(llmMatch[0], '').trim();
      }

      // Check for <JAILBREAKON> if target is gemini
      if (targetLLM === 'gemini') {
        const jailbreakMatch = systemMsg.content.match(/<JAILBREAK:ON>/i);
        if (jailbreakMatch) {
          console.log('\n🟠 [Original System Message]:');
          console.log(systemMsg.content);
    
          systemMsg.content = systemMsg.content.replace(jailbreakMatch[0], '').trim();
    
          if (typeof JAILBREAK !== 'string' || !JAILBREAK.trim()) {
            console.error('❌ [ERROR] JAILBREAK string is not defined or empty!');
          } else {
            systemMsg.content += JAILBREAK.trim() + "\n\n" + systemMsg.content;
    
            console.log('\n🟢 [System Message After Jailbreak Injected]:');
            console.log(systemMsg.content);
          }
        } else {
          console.log('⚠️ No <JAILBREAK:ON> tag found.');
        }
      }
    }

    // Log full prompt content
    const fullPrompt = clientBody.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
    console.log(`\n===========================\n🧠 Using LLM: ${targetLLM.toUpperCase()}\n===========================`);
    console.log('[📨 Full Prompt Sent]:\n' + fullPrompt + '\n===========================\n');

    let responseData;

    switch (targetLLM) {
      case 'gemini':
        responseData = await routeToGemini(req, clientBody);
        break;

      case 'or':
      default:
        responseData = await routeToOpenRouter(req, clientBody);
        break;
    }

    res.status(200).json(responseData);
  } catch (err) {
    console.error('[❌ Error]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



// --- Start Server ---
app.listen(port, () => {
  console.log(`🚀 Proxy server running on port ${port}`);
  console.log(`🔁 Streaming simulation enabled`);
});