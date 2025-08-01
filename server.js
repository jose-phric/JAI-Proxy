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
app.use(express.json({ limit: '10mb' }));
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
  // return req.headers['x-api-key'] || req.body?.api_key || req.query.api_key || '';
}

function ensureMarkdownFormatting(text) {
  return text.replace(/\n{3,}/g, '\n\n');
}

function cleanResponseText(text) {
  return text.trim().replace(/^"(.*)"$/, '$1');
}

// Function to handle non-streaming Gemini requests
async function routeToGemini(req, clientBody) {
  console.log('➡️ Non-streaming request to Gemini detected');
  const geminiKey = extractApiKey(req);
  const modelName = clientBody.model || 'gemini-2.5-pro';
  const endpoint = 'generateContent';

  const contents = clientBody.messages.map(m => {
    // The Gemini API expects a 'user' and 'model' role
    const role = m.role === 'system' || m.role === 'user' ? 'user' : 'model';
    return {
      role: role,
      parts: [{ text: m.content }]
    };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;

  try {
    const response = await axios.post(
      url,
      { contents: contents },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
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
  } catch (err) {
    console.error('[❌ Gemini API Error]', err.response ? err.response.data : err.message);
    throw err;
  }
}

// Function to handle streaming Gemini requests
async function streamToGemini(req, res, clientBody) {
  console.log('➡️ Streaming request to Gemini detected');
  const geminiKey = extractApiKey(req);
  const modelName = clientBody.model || 'gemini-pro';
  const endpoint = 'streamGenerateContent';

  // Get the system instruction from the first message
  const systemInstruction = {
    parts: [
      { text: clientBody.messages[0].content.trim() }
    ]
  };
  console.log('System instruction:', systemInstruction);
  // Get the rest of the messages for the 'contents' array
  const chatMessages = clientBody.messages.slice(1);

  // const contents = clientBody.messages.map(m => {
  const contents = chatMessages.map(m => {
    // The Gemini API expects a 'user' and 'model' role
    const role = m.role === 'system' || m.role === 'user' ? 'user' : 'model';
    return {
      role: role,
      parts: [{ text: m.content }]
    };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;

  // try {
  //   const response = await axios.post(
  //     url,
  //     { contents: contents },
  //     {
  //       headers: { 'Content-Type': 'application/json' },
  //       responseType: 'stream',
  //       timeout: 300000
  //     }
  //   );

  try {
    const response = await axios.post(
      url,
      {
        system_instruction: systemInstruction,
        contents: contents,
        generation_config: {
          temperature: 0.9,
          top_k: 40,
          top_p: 0.9,
          max_output_tokens: 4096
        },
        safety_settings: [
          { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
          { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 300000
      }
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    response.data.on('data', chunk => {
        buffer += chunk.toString('utf-8');
        let lastProcessedIndex = 0;

        // This robust parser finds complete JSON objects by balancing curly braces.
        while (true) {
            let braceCount = 0;
            let startIndex = -1;
            let endIndex = -1;
            let inString = false;

            // Find the start of the next JSON object
            for (let i = lastProcessedIndex; i < buffer.length; i++) {
                if (buffer[i] === '{') {
                    startIndex = i;
                    break;
                }
            }
            
            if (startIndex === -1) break; // No more JSON objects in the buffer

            // Find the corresponding end of the JSON object
            for (let i = startIndex; i < buffer.length; i++) {
                const char = buffer[i];
                if (char === '"' && (i === 0 || buffer[i - 1] !== '\\')) {
                    inString = !inString;
                }
                if (!inString) {
                    if (char === '{') braceCount++;
                    else if (char === '}') braceCount--;
                }
                if (braceCount === 0 && startIndex !== -1) {
                    endIndex = i;
                    break;
                }
            }

            if (endIndex === -1) break; // Incomplete JSON object, wait for more data

            const jsonString = buffer.substring(startIndex, endIndex + 1);
            lastProcessedIndex = endIndex + 1;

            try {
                const data = JSON.parse(jsonString);
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (text) {
                    console.log('✅ Streaming chunk:', text);
                    const formattedChunk = {
                        id: `chatcmpl-${Date.now()}`,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: modelName,
                        choices: [{
                            delta: { content: text },
                            index: 0,
                            finish_reason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                }
            } catch (e) {
                console.error(`❌ Error parsing a full JSON object: ${e.message}`);
                console.error(`❌ Raw data that failed to parse: '${jsonString}'`);
            }
        }
        
        // Keep the unprocessed part of the buffer
        if (lastProcessedIndex > 0) {
            buffer = buffer.substring(lastProcessedIndex);
        }
    });

    response.data.on('end', () => {
        // Send a final chunk to signal the end of the stream
        const endChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [{
                delta: {},
                index: 0,
                finish_reason: "stop"
            }]
        };
        res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
        res.end();
    });

  } catch (err) {
    console.error('[❌ Gemini Streaming Error]', err.response ? err.response.data : err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream from Gemini.' });
    } else {
      res.end();
    }
  }
}

async function routeToOpenRouter(req, clientBody) {
  console.log('➡️ Non-streaming request to OpenRouter detected');
  const apiKey = extractApiKey(req);

  try {
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
        timeout: 60000
      }
    );
    return response.data;
  } catch (err) {
    console.error('[❌ OpenRouter API Error]', err.response ? err.response.data : err.message);
    throw err;
  }
}

// New endpoint for OpenRouter
app.post('/openrouter', async (req, res) => {
  try {
    const clientBody = req.body;
    const isStreamingRequested = clientBody.stream;
    console.log(`🔄 Request received on /openrouter. Streaming: ${isStreamingRequested}`);

    if (isStreamingRequested) {
      console.log('🔄 Streaming request to OpenRouter detected');
      const apiKey = extractApiKey(req);
      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          { ...clientBody, stream: true },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://janitorai.com',
              'X-Title': 'Aria Extension'
            },
            httpsAgent: agent,
            responseType: 'stream',
            timeout: 60000
          }
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        response.data.pipe(res);
        return;
      } catch (err) {
        console.error('[❌ OpenRouter Streaming Error]', err.response ? err.response.data : err.message);
        res.status(500).json({ error: 'Failed to stream from OpenRouter.' });
        return;
      }
    } else {
      let responseData = await routeToOpenRouter(req, clientBody);
      const content = ensureMarkdownFormatting(cleanResponseText(responseData.choices[0].message.content));

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
    console.error('[❌ Server Error on /openrouter]', err.response ? err.response.data : err.message);
    const errorMessage = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      choices: [
        {
          message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
          finish_reason: 'error'
        }
      ]
    });
  }
});


// A flag to enable or disable the NSFW prefill
const ENABLE_NSFW = true;

// Enhanced NSFW prefill for roleplay
const nsfwPrefill = require('./nsfwprefill.js');

// A flag to enable or disable the "thinking" prompts
const ENABLE_THINKING = true;

// Enhanced thinking prompt - encourages tag usage
const thinkingPrompt = `You should structure your response using thinking tags:

<think>
[Your internal analysis here]
[Plan your roleplay response]
[Consider character motivations]
[Any reasoning or thoughts]
</think>
<response>
[Your actual roleplay content goes here]

This format helps separate your reasoning from the actual roleplay content.`;

// Reminder message for thinking
const reminder = "Remember to use <think>...</think> for your reasoning and <response>... for your roleplay content.";

// Custom assistant prompt to prime the model
const customAssistantPrompt = "Okay, I understand. I'm ready to begin the roleplay.";

// New endpoint for Gemini
app.post('/gemini', async (req, res) => {
  try {
    const clientBody = req.body;
    const isStreamingRequested = clientBody.stream;
    console.log(`🔄 Request received on /gemini. Streaming: ${isStreamingRequested}`);

    let messages = clientBody.messages;

    // 1. Separate all system and conversational messages
    const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content);
    let conversationMessages = messages.filter(m => m.role !== 'system');
    
    // 2. Combine all system-related prompts into one string
    let consolidatedSystemPrompt = systemMessages.join('\n\n');

    // 3. Add fixed system prompts (NSFW, thinking)
    if (ENABLE_NSFW) {
      consolidatedSystemPrompt += `\n\n${nsfwPrefill}`;
      if (ENABLE_THINKING) {
        consolidatedSystemPrompt += `\n\n${thinkingPrompt}\n\n${reminder}`;
      }
    }

    const jailbreakOnTag = '<JAILBREAK=ON>';
    const hasJailbreakTag = consolidatedSystemPrompt.includes(jailbreakOnTag);

    // 4. Apply jailbreak if the tag was present in the original system message
    if (hasJailbreakTag && typeof JAILBREAK === 'string' && JAILBREAK.trim()) {
      // Use replace to directly replace the tag with the JAILBREAK content
      consolidatedSystemPrompt = consolidatedSystemPrompt.replace(jailbreakOnTag, JAILBREAK.trim());
    }

    // 5. Construct the final message array with a single consolidated system message
    const finalMessages = [];

    // Add the single, consolidated system prompt at the beginning
    if (consolidatedSystemPrompt.trim()) {
      finalMessages.push({ role: 'user', content: consolidatedSystemPrompt.trim() });
      // Add a placeholder response from the model to maintain conversational turn.
      finalMessages.push({ role: 'assistant', content: customAssistantPrompt });
    }

    // Append the rest of the conversation messages
    conversationMessages.forEach(msg => {
      if (msg.content && msg.content.trim()) {
        finalMessages.push({ role: msg.role, content: msg.content });
      }
    });

    // Update the clientBody with the new message structure
    clientBody.messages = finalMessages;

    // --- DEBUGGING OUTPUT ---
    console.log('--- FINAL MESSAGES SENT TO GEMINI API ---');
    console.log(JSON.stringify(clientBody.messages, null, 2));
    console.log('-----------------------------------------');

    if (isStreamingRequested) {
      await streamToGemini(req, res, clientBody);
      return;
    }

    const responseData = await routeToGemini(req, clientBody);
    const content = ensureMarkdownFormatting(cleanResponseText(responseData.choices[0].message.content));

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

  } catch (err) {
    console.error('[❌ Server Error on /gemini]', err.response ? err.response.data : err.message);
    const errorMessage = err.response?.data?.error?.message || err.message;
    res.status(500).json({
      choices: [
        {
          message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
          finish_reason: 'error'
        }
      ]
    });
  }
});


app.listen(port, () => {
  console.log(`🚀 Proxy server running on port ${port}`);
});
