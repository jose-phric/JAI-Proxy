// Debug flags //
const DEBUG = true;               // enables debug logging
const DEBUG_CONTENT = false;		  // enables content logging (may expose sensitive data)

// Variables //
const PORT = 4949;
const JANITOR_URL = 'https://janitorai.com'; // referer header for requests
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';
const DEFAULT_TEMPERATURE = 0.85; // controls randomness in token selection, lower = more deterministic
const DEFAULT_TIMEOUT = 60000;    // Time in miliseconds for timeout. (60 seconds)
const DEFAULT_TOP_K = 64;         // determines how many of the most likely next tokens to consider
const DEFAULT_TOP_P = 0.95;       // cumulative probability for token selection

const STREAMING_SPEED = 200;
const ENABLE_NSFW = true;         // enables NSFW prefill
const JAILBREAK_REGEX = /<JAILBREAK(=ON)?>/i; // matches to <JAILBREAK> or <JAILBREAK=ON> (case insensitive)

// Thinking Formatting //
const MANUAL_THINKING = true;     // if true, dont prompt Gemini to use thinking tags, instead insert them manually
const STOP_REGEX = /<STOP=(.*?)>/i;
const DEFAULT_STOP_WORDS = ['__Info board:__', 'Info board:', 'Timezone:']; // these are the automatic stop words for thinking segments. it will insert </think> before these words if they appear

const THINKING_BUDGET = 1000;      // thinking budget for Gemini, -1 means unlimited
const ENABLE_THINKING_TAGS = true; // enables thinking formatting
const ENABLE_REMINDER = false;     // enables reminder for thinking formatting (should be redundant now)

// Prompts //
const JAILBREAK = require('./jailbreak.js');
const NSFWPREFILL = require('./nsfwprefill.js');
const ASSISSTANT_PROMPT = "Okay, I understand. I'm ready to begin the roleplay.";
const THINKING_REMINDER = "Remember to use <think>...</think> for your reasoning and <response>... for your roleplay content.";
const THINKING_PROMPT = `You must structure your response using thinking tags:

<think>
[Your internal analysis here]
[Plan your roleplay response]
[Consider character motivations]
[Any reasoning or thoughts]
</think>
<response>
[Your actual roleplay content goes here]

This format helps separate your reasoning from the actual roleplay content.`;

// Definitions //
const express = require('express');
const app = express();
const cors = require('cors');
const axios = require('axios');
const zlib = require('zlib');
const https = require('https');
const path = require("path");
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const e = require('express');

// Initialization //
const agent = new https.Agent({
    keepAlive: true,
    secureProtocol: 'TLSv1_2_method',
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', JANITOR_URL);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Helper Functions //
function extractApiKey(req) {
    if (req.headers.authorization?.startsWith('Bearer ')) {
        return req.headers.authorization.split(' ')[1].trim();
    }
}

function ensureMarkdownFormatting(text) {
    return text.replace(/\n{3,}/g, '\n\n');
}

function cleanResponseText(text) {
    return text.trim().replace(/^"(.*)"$/, '$1');
}

// Function to handle non-streaming Gemini requests
async function routeToGemini(url, requestBody, stopWords = DEFAULT_STOP_WORDS) {
    try {
        const response = await axios.post(
            url,
            requestBody,
            { headers: { 'Content-Type': 'application/json' }, timeout: DEFAULT_TIMEOUT }
        );
        
        // Scenario 1: Successful response with content
        if (response.data.candidates && response.data.candidates.length > 0) {
            let content = response.data.candidates[0].content?.parts?.[0]?.text || "No content returned by Gemini.";
            if (MANUAL_THINKING) {
                content = `<think> ${content}`;
                let firstIndex = -1;
                
                for (const stopWord of stopWords) {
                    const currentIndex = content.indexOf(stopWord);
                    if (currentIndex !== -1) {
                        if (firstIndex === -1 || currentIndex < firstIndex) {
                            firstIndex = currentIndex;
                        }
                    }
                }
                
                if (firstIndex !== -1) {
                    content = content.slice(0, firstIndex) + '</think> ' + content.slice(firstIndex);
                }
            }
            return {
                choices: [
                    {
                        message: { role: 'assistant', content },
                        finish_reason: response.data.candidates[0].finishReason || 'stop'
                    }
                ],
                // id: `chat-${Date.now()}`,
                // created: Math.floor(Date.now() / 1000),
                // object: 'chat.completion',
                usage: response.data.usageMetadata || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };
        }
        
        // Scenario 2: Response was blocked by safety filters
        if (response.data.promptFeedback) {
            const blockReason = response.data.promptFeedback.blockReason || 'No reason provided';
            let ratingsDetails = "No safety ratings provided.";
            
            if (response.data.promptFeedback.safetyRatings && Array.isArray(response.data.promptFeedback.safetyRatings)) {
                ratingsDetails = response.data.promptFeedback.safetyRatings
                .map(r => `  - ${r.category.replace('HARM_CATEGORY_', '')}: ${r.probability}`)
                .join('\n');
            }
            // console.error(`[❌ Gemini Safety Block] Reason: ${response.data.promptFeedback}`);
            throw new Error('Request blocked by Gemini safety filters.');
            // const errorMessage = `❌ **Request Blocked by Gemini**\n**Reason:** ${blockReason}\n**Safety Ratings:**\n${ratingsDetails}`;
            
            
            // return {
            //   choices: [
            //     {
            //       message: { role: 'assistant', content: errorMessage },
            //       finish_reason: 'safety_settings'
            //     }
            //   ],
            // id: `chat-${Date.now()}`,
            // created: Math.floor(Date.now() / 1000),
            // object: 'chat.completion'
            // };
        }
        
        // Scenario 3: Unexpected response structure (e.g., empty response)
        console.error('[❌ Gemini API Error] Unknown response structure:', JSON.stringify(response.data, null, 2));
        throw new Error('Invalid or empty response structure from Gemini API.');
        
    } catch (err) {
        console.error('[❌ Gemini API Error]', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
        throw err;
    }
}

// Function to handle streaming Gemini requests
async function streamToGemini(res, url, requestBody, modelName, geminiKey, stopWords = DEFAULT_STOP_WORDS) {
    try {
        const response = await axios.post(
            url,
            requestBody,
            {
                headers: { 'Content-Type': 'application/json' },
                responseType: 'stream',
                timeout: DEFAULT_TIMEOUT,
                httpsAgent: agent
            }
        );
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        let dataStream = response.data;
        const pipelineSteps = [dataStream];
        
        if (response.headers['content-encoding'] === 'gzip') {
            if (DEBUG) console.log('➡️ Response is GZIPPED, adding unzip stream');
            pipelineSteps.push(zlib.createUnzip());
        }
        
        let buffer = '';
        const textDecoder = new TextDecoder();
        
        // helper to stream text slowly
        async function streamTextSlowly(text, res) {
            const chars = Array.from(text);
            const delay = 1000 / STREAMING_SPEED;
            for (let i = 0; i < chars.length; i += 2) {
                const chunk = chars.slice(i, i + 2).join('');
                const formattedChunk = {
                    choices: [
                        {
                            delta: { content: chunk }
                        }
                    ]
                };
                res.write(`data: ${JSON.stringify(formattedChunk)}\n\n`);
                await new Promise(r => setTimeout(r, delay * 2));
            }
        }
        
        let lastPromise = Promise.resolve();
        
        
        let thinkingTagAdded = false;
        let thinkingBuffer = '';
        let thinkTagClosed = false;
        let directAccumulated = '';
        const customParserStream = new Transform({
            transform(chunk, encoding, callback) {
                buffer += textDecoder.decode(chunk, { stream: true });
                let lastProcessedIndex = 0;
                
                while (true) {
                    let braceCount = 0;
                    let startIndex = -1;
                    let endIndex = -1;
                    let inString = false;
                    
                    for (let i = lastProcessedIndex; i < buffer.length; i++) {
                        if (buffer[i] === '{') {
                            startIndex = i;
                            break;
                        }
                    }
                    if (startIndex === -1) break;
                    
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
                    if (endIndex === -1) break;
                    
                    const jsonString = buffer.substring(startIndex, endIndex + 1);
                    lastProcessedIndex = endIndex + 1;
                    
                    try {
                        const data = JSON.parse(jsonString);
                        let text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (text) {
                            // Sanitize any provider-sent thinking tags to avoid duplication or injection
                            text = text.replace(/<\/?think>/gi, '');
                            if (MANUAL_THINKING) {
                                // Ensure the opening think tag is sent exactly once at the start
                                if (!thinkingTagAdded) {
                                    if (DEBUG) console.log('🧠 Prepending <think> at start of stream');
                                    // Write the opener immediately as a single event to avoid buffering/delay
                                    const openerChunk = {
                                        choices: [
                                            {
                                                delta: { content: '<think> ' }
                                            }
                                        ]
                                    };
                                    res.write(`data: ${JSON.stringify(openerChunk)}\n\n`);
                                    if (DEBUG) console.log('✅ Wrote <think> opener to SSE');
                                    thinkingTagAdded = true;
                                }
                                
                                if (!thinkTagClosed) {
                                    // Buffer content until we detect a stop word to close thinking
                                    thinkingBuffer += text;
                                    
                                    let firstIndex = -1;
                                    for (const stopWord of stopWords) {
                                        const currentIndex = thinkingBuffer.indexOf(stopWord);
                                        if (currentIndex !== -1) {
                                            if (firstIndex === -1 || currentIndex < firstIndex) {
                                                firstIndex = currentIndex;
                                            }
                                        }
                                    }
                                    
                                    // Close as soon as a stop word is detected (including at index 0)
                                    if (firstIndex !== -1) {
                                        // Close thinking exactly once at the earliest detected stop word
                                        const contentToSend = thinkingBuffer.slice(0, firstIndex) + '</think>' + thinkingBuffer.slice(firstIndex);
                                        thinkingBuffer = '';
                                        thinkTagClosed = true; // Prevent any further closing attempts
                                        console.log('💡 Detected end of thinking segment, sending buffered content.');
                                        lastPromise = lastPromise.then(() => streamTextSlowly(contentToSend, res));
                                        // After closing the tag, do not buffer further; pass through subsequent content
                                        buffer = buffer.substring(lastProcessedIndex);
                                        lastProcessedIndex = 0; // Reset for the new, smaller buffer
                                        continue; // Continue to the next JSON object in the buffer
                                    }
                                } else {
                                    // Already closed: stream subsequent content directly without buffering
                                    const cleaned = text.replace(/<\/think>/gi, '');
                                    let newPart = cleaned;
                                    if (cleaned.startsWith(directAccumulated)) {
                                        newPart = cleaned.slice(directAccumulated.length);
                                    }
                                    directAccumulated = cleaned;
                                    if (newPart) {
                                        lastPromise = lastPromise.then(() => streamTextSlowly(newPart, res));
                                    }
                                }
                            } else {
                                // Queue the streaming to ensure sequential order
                                lastPromise = lastPromise.then(() => streamTextSlowly(text, res));
                            }
                        }
                        // This part handles the buffered content when no stop word is found yet
                        if (MANUAL_THINKING && !thinkTagClosed) {
                            const longestStopWordLength = Math.max(0, ...stopWords.map(sw => sw.length));
                            const safeLength = Math.max(0, thinkingBuffer.length - longestStopWordLength);
                            if (safeLength > 0) {
                                const safePart = thinkingBuffer.substring(0, safeLength);
                                thinkingBuffer = thinkingBuffer.substring(safeLength);
                                lastPromise = lastPromise.then(() => streamTextSlowly(safePart, res));
                            }
                        }
                    } catch (e) {
                        console.error(`❌ Error parsing JSON: ${e.message}`);
                    }
                }
                buffer = buffer.substring(lastProcessedIndex);
                callback();
            },
            
            flush(callback) {
                // Wait for all queued writes to complete before ending stream
                lastPromise.then(() => {
                    if (MANUAL_THINKING && thinkingBuffer.length > 0) {
                        return streamTextSlowly(thinkingBuffer, res);
                    }
                }).finally(() => {
                    const endChunk = {
                        choices: [
                            {
                                finish_reason: "stop"
                            }
                        ]
                    };
                    this.push(`data: ${JSON.stringify(endChunk)}\n\n`);
                    callback();
                });
            }
        });
        
        
        pipelineSteps.push(customParserStream, res);
        
        await pipeline(...pipelineSteps)
        .catch(err => {
            console.error('[❌ Gemini Streaming Pipeline Error]', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream from Gemini.' });
            } else {
                res.end();
            }
        });
        
        if (DEBUG) console.log('✅ Gemini streaming completed successfully.');
    } catch (err) {
        console.error('[❌ Gemini Streaming Error]', err.response ? err.response.data : err.message);
        if (!res.headersSent) {
            res.status(err.response?.data?.error?.code || 500).json({ error: `❌ Error: ${err.response?.data?.error?.message || err.message}` });
        } else {
            res.end();
        }
    }
}

// Gemini endpoint
app.post('/gemini', async (req, res) => {
    try {
        const clientBody = req.body;
        const isStreamingRequested = clientBody.stream;
        const geminiKey = extractApiKey(req);
        if (!geminiKey) {
            console.error('[❌ Gemini Error] No API key provided.');
            res.status(401).json({ error: 'Unauthorized: No API key provided.' });
            return;
        }
        
        const modelName = clientBody.model || DEFAULT_GEMINI_MODEL;
        // if (DEBUG) console.time('Gemini_Response_Time');
        if (DEBUG) console.log(`🔄 Request received on /gemini. Model: ${modelName}, Streaming: ${isStreamingRequested}`);
        const endpoint = isStreamingRequested ? 'streamGenerateContent' : 'generateContent';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:${endpoint}?key=${geminiKey}`;
        
        // console.log(`🔄 Temperature? ${clientBody.temperature}, Top K? ${clientBody.top_k}, Top P? ${clientBody.top_p}, Frequency Penalty? ${clientBody.frequency_penalty}, Presence Penalty? ${clientBody.presence_penalty}, Repetition Penalty? ${clientBody.repetition_penalty}`);
        let x = 0;
        // while (x < clientBody.messages.length) {
        //   console.log(`PART ${x}: ${clientBody.messages[x].content}`);
        //   x++;
        // }
        let systemPrompt = clientBody.messages[0].content.trim();
        // systemPrompt = systemPrompt.replace(/father|daddy|daughter|mother|cock|pussy|sister|ignore|moral|baby|family|prompt|request|affair|stepdaughter|stepsister|kinky|slutty/gi, '');
        // console.log(`🔄 System prompt received: ${systemPrompt}`);
        if (ENABLE_NSFW) { systemPrompt += `\n\n${NSFWPREFILL}`; }
        if (MANUAL_THINKING == false) {
            if (ENABLE_THINKING_TAGS) { systemPrompt += `\n\n${THINKING_PROMPT}`; }
            if (ENABLE_REMINDER) { systemPrompt += `\n\n${THINKING_REMINDER}`; }
        }
        
        const hasJailbreak = JAILBREAK_REGEX.test(systemPrompt);
        if (hasJailbreak && typeof JAILBREAK === 'string' && JAILBREAK.trim()) {
            systemPrompt = systemPrompt.replace(JAILBREAK_REGEX, JAILBREAK.trim());
        }
        
        let stopWords = [...DEFAULT_STOP_WORDS];
        const stopMatch = systemPrompt.match(STOP_REGEX);
        if (stopMatch && stopMatch[1]) {
            stopWords = stopMatch[1].split(',').map(s => s.trim());
            systemPrompt = systemPrompt.replace(STOP_REGEX, '');
        }
        
        // Prepare messages for Gemini API
        if (clientBody.messages.length > 0 && clientBody.messages[0].role === 'system') {
            messagesForGemini = clientBody.messages.slice(1);
        } else {
            // If no system prompt is found, use the entire message list
            messagesForGemini = clientBody.messages;
        }
        if (DEBUG_CONTENT) console.log('Messages prepared for Gemini:', messagesForGemini);
        
        const contents = messagesForGemini.map(m => {
            const role = m.role === 'system' || m.role === 'user' ? 'user' : 'model';
            return {
                role: role,
                parts: [{ text: m.content }]
            };
        });
        
        const requestBody = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: contents,
            generation_config: {
                temperature: clientBody.temperature || DEFAULT_TEMPERATURE,
                top_k: DEFAULT_TOP_K,
                top_p: DEFAULT_TOP_P,
                thinking_config: {
                    include_thoughts: false,
                    thinking_budget: THINKING_BUDGET,
                }
            },
            safety_settings: [
                { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
                { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE" },
                { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" },
                { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
                { "category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "BLOCK_NONE" }
            ]
        };
        
        if (isStreamingRequested) {
            //   await streamToGemini(res, url, requestBody, modelName);
            await streamToGemini(res, url, requestBody, modelName, geminiKey, stopWords);
            return;
        }
        
        const responseData = await routeToGemini(url, requestBody, stopWords);
        const content = responseData.choices[0].message.content;
        const finishReason = responseData.choices[0].finish_reason;
        
        if (DEBUG) console.log(`✅ Gemini response received. Finish Reason: ${finishReason}`);
        
        res.status(200).json({
            choices: [
                {
                    message: { role: 'assistant', content: content },
                    finish_reason: finishReason
                }
            ],
            created: responseData.created,
            id: responseData.id,
            model: modelName,
            object: 'chat.completion',
            usage: responseData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
        
    } catch (err) {
        console.error('[❌ Server Error on /gemini]', err.response ? err.response.data : err.message);
        const errorMessage = err.response?.data?.error?.message || err.message;
        res.status(err.response?.data?.error?.code || 500).json({
            message: `❌ Error: ${errorMessage}`,
        });
    }
});

async function routeToOpenRouter(req, clientBody) {
    const apiKey = extractApiKey(req);
    
    try {
        const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            { ...clientBody, stream: false },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': JANITOR_URL,
                    'X-Title': 'Shoddy Aria Extension'
                },
                httpsAgent: agent,
                timeout: DEFAULT_TIMEOUT
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
        if (DEBUG) console.log(`🔄 Request received on /openrouter. Streaming: ${isStreamingRequested}`);
        
        if (isStreamingRequested) {
            const apiKey = extractApiKey(req);
            try {
                const response = await axios.post(
                    'https://openrouter.ai/api/v1/chat/completions',
                    { ...clientBody, stream: true },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': JANITOR_URL,
                            'X-Title': 'Shoddy Aria Extension'
                        },
                        httpsAgent: agent,
                        responseType: 'stream',
                        timeout: DEFAULT_TIMEOUT
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
            
            console.log('✅ OpenRouter response received:', content);
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
        res.status(err.response?.data?.error?.code || 500).json({
            choices: [
                {
                    message: { role: 'assistant', content: `❌ Error: ${errorMessage}` },
                    finish_reason: 'error'
                }
            ]
        });
    }
});

// New endpoint for extracting character definitions
app.post('/definitions', async (req, res) => {
    try {
        const { messages } = req.body;
        
        // Manually adding a 1-second delay to prevent client timeouts
        // await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if messages array exists and has at least one message with content
        if (!messages || messages.length === 0 || !messages[0].content) {
            return res.status(400).json({ error: 'Invalid message format or no content provided.' });
        }
        
        // Get the content of the first message, which is the system prompt
        const content = messages[0].content;
        // console.log('🔄 Processing character definition:', content);
        // Create a structured response similar to other endpoints
        res.status(200).json({
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: content
                    }
                }
            ],
            created: Math.floor(Date.now() / 1000),
            id: `definition-${Date.now()}`,
            object: 'chat.completion'
        });
        
        if (DEBUG) console.log('✅ /definitions endpoint processed successfully.');
        
    } catch (err) {
        console.error('[❌ Server Error on /definitions]', err);
        res.status(500).json({ error: 'Failed to process character definition.' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Proxy server running now on PORT ${PORT}`);
});
