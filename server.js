// proxy_server_debug.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const path = require("path");
const JAILBREAK = require('./jailbreak.js');
const app = express();
const port = 4949;

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

function extractApiKey(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1].trim();
  }
  return req.headers['x-api-key'] || req.body?.api_key || req.query.api_key || '';
}

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
      choices: [
        {
          delta: { content: words[index] + ' ' },
          index: 0,
          finish_reason: null
        }
      ]
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    index++;
    setTimeout(sendChunk, 20);
  };
  sendChunk();
}

async function routeToGemini(req, clientBody) {
  const geminiKey = extractApiKey(req);
  const modelName = clientBody.model || 'gemini-pro';
  const endpoint = 'generateContent';
  const messages = clientBody.messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;

  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: messages }] }] },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  return {
    choices: [
      {
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ],
    id: `chat-${Date.now()}`,
    model: modelName,
    created: Math.floor(Date.now() / 1000),
    object: 'chat.completion'
  };
}

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
      timeout: 300000
    }
  );

  return response.data;
}

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const clientBody = req.body;
    const isStreamingRequested = clientBody.stream;
    let targetLLM = 'or';
    let systemMsg = clientBody.messages.find(m => m.role === 'system');

    if (systemMsg?.content) {
      const llmMatch = systemMsg.content.match(/<LLM:([\w-]+)>/i);
      if (llmMatch) {
        targetLLM = llmMatch[1].toLowerCase();
        systemMsg.content = systemMsg.content.replace(llmMatch[0], '').trim();
      }

      if (targetLLM === 'gemini') {
        const jailbreakMatch = systemMsg.content.match(/<JAILBREAK:ON>/i);
        if (jailbreakMatch) {
          systemMsg.content = systemMsg.content.replace(jailbreakMatch[0], '').trim();

          if (typeof JAILBREAK === 'string' && JAILBREAK.trim()) {
            systemMsg.content = JAILBREAK.trim() + "\n\n" + systemMsg.content;
          } else {
            console.error('❌ [JAILBREAK is empty or not a string!]');
          }
        }
      }
    }

    const fullPrompt = clientBody.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
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

    const content = ensureMarkdownFormatting(cleanResponseText(responseData.choices[0].message.content));

    if (isStreamingRequested) {
      simulateStreamingResponse(content, res);
    } else {
      res.status(200).json({
        choices: [
          {
            message: { role: 'assistant', content },
            finish_reason: responseData.choices[0].finish_reason || 'stop'
          }
        ],
        created: responseData.created || Math.floor(Date.now() / 1000),
        id: responseData.id || `chat-${Date.now()}`,
        model: responseData.model,
        object: 'chat.completion',
        usage: responseData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  } catch (err) {
    console.error('[❌ Server Error]', err);
    const errorMessage = err.response?.data?.error?.message || err.message;
    if (req.body?.stream) {
      simulateStreamingResponse(`❌ Error: ${errorMessage}`, res);
    } else {
      res.status(500).json({
        choices: [
          {
            message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
            finish_reason: 'error'
          }
        ]
      });
    }
  }
});

app.listen(port, () => {
  console.log(`🚀 Proxy server running on port ${port}`);
  console.log(`🔁 Streaming simulation enabled`);
});