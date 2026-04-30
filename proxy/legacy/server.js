require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Try to use 'open' if available to pop browser
let open;
try { open = (...args) => import('open').then(({default: openApp}) => openApp(...args)); } catch(e) {}

// Global credential cache for OAuth
let cachedToken = null;
let tokenExpiresAt = 0;

async function getOAuthToken() {
    // Return cache if it's still alive for at least a minute
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedToken;
    }

    const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
    const OAUTH_AUTHORIZE_URL = process.env.OAUTH_AUTHORIZE_URL;
    const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL;
    const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3001/callback';

    if (!OAUTH_CLIENT_ID || !OAUTH_AUTHORIZE_URL || !OAUTH_TOKEN_URL) {
        throw new Error("Missing OAuth configs in .env (CLIENT_ID, AUTHORIZE_URL, TOKEN_URL)");
    }

    console.log('[PROXY] Handshake required: Waiting for User Login in Browser...');
    
    // Construct local Auth server to catch the callback
    return new Promise((resolve, reject) => {
        const authApp = express();
        let server;
        
        authApp.get('/callback', async (req, res) => {
            const code = req.query.code;
            if (!code) {
                res.status(400).send("No Auth Code found. Close window and try again.");
                return reject(new Error("No auth code"));
            }
            res.send("<h1>Login Successful!</h1><p>You can close this window and return to your terminal.</p>");
            
            // Swap code for token
            try {
                console.log('[PROXY] Exchanging code for Access Token...');
                const tokenRes = await axios.post(OAUTH_TOKEN_URL, new URLSearchParams({
                    client_id: OAUTH_CLIENT_ID,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: OAUTH_REDIRECT_URI
                }).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                cachedToken = tokenRes.data.access_token;
                tokenExpiresAt = Date.now() + ((tokenRes.data.expires_in || 3600) * 1000);
                
                server.close();
                resolve(cachedToken);
            } catch (err) {
                console.error('[PROXY] Token exchange failed!', err.response?.data || err.message);
                server.close();
                reject(err);
            }
        });

        server = authApp.listen(3001, () => {
            const authUrl = `${OAUTH_AUTHORIZE_URL}?response_type=code&client_id=${OAUTH_CLIENT_ID}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`;
            console.log(`[PROXY] Serving local callback on ${OAUTH_REDIRECT_URI}`);
            console.log(`[PROXY] Opening browser to: ${authUrl}`);
            if (open) {
                open(authUrl).catch(e => console.log('Could not open browser automatically, please click the link above'));
            } else {
                console.log('Please click the link above to authenticate.');
            }
        });
    });
}


const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Support large context windows

// Load configuration
const TARGET_API_URL = process.env.TARGET_API_URL || 'https://api.openai.com/v1/chat/completions';

// 1. Translation: Anthropic Tool to OpenAI Function
function mapToolToOpenAI(tool) {
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema || {}
        }
    };
}

// 2. Translation: Anthropic Message to OpenAI Message
function mapMessageToOpenAI(msg) {
    let content = "";
    let tool_calls = [];

    if (Array.isArray(msg.content)) {
        for (let block of msg.content) {
            if (block.type === 'text') {
                content += block.text + "\n";
            } else if (block.type === 'tool_use') {
                tool_calls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                        name: block.name,
                        arguments: JSON.stringify(block.input || {})
                    }
                });
            } else if (block.type === 'tool_result') {
                // OpenAI splits tool calls and results differently.
                // In a robust implementation, this would map to a tool result message.
                content += `\\n[Tool Result for ${block.tool_use_id}]: ${block.content}`;
            }
        }
    } else {
        content = msg.content;
    }

    const result = {
        role: msg.role || 'user',
        content: content.trim()
    };

    if (tool_calls.length > 0) {
        result.tool_calls = tool_calls;
    }
    
    // Quick role fix for OpenAI (system/user/assistant/tool)
    if (result.role !== 'user' && result.role !== 'assistant' && result.role !== 'system' && result.role !== 'tool') {
        result.role = 'user'; // fallback
    }

    return result;
}

// 3. Translation: OpenAI Response to Anthropic Shape
function mapResponseToAnthropic(openaiRes) {
    const choice = openaiRes.choices[0];
    const message = choice.message;
    
    let anthropicContent = [];
    
    if (message.content) {
        anthropicContent.push({
            type: 'text',
            text: message.content
        });
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
        message.tool_calls.forEach(tc => {
            let input = {};
            try { input = JSON.parse(tc.function.arguments); } catch(e) {}
            anthropicContent.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: input
            });
        });
    }

    return {
        id: openaiRes.id,
        type: "message",
        role: "assistant",
        model: openaiRes.model,
        content: anthropicContent,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
        usage: {
            input_tokens: openaiRes.usage.prompt_tokens,
            output_tokens: openaiRes.usage.completion_tokens
        }
    };
}

// Main Proxy Endpoint
app.post('/v1/messages', async (req, res) => {
    try {
        const { system, messages, tools, max_tokens, temperature, model } = req.body;
        console.log(`[PROXY] Received request for model: ${model}`);

        // Build OpenAI payload
        const oaiMessages = [];
        
        // Anthropic passes system prompt at root, OpenAI passes as top message
        if (system) {
            let sysContent = typeof system === 'string' ? system : JSON.stringify(system);
            oaiMessages.push({ role: 'system', content: sysContent });
        }

        // Map conversation
        if (messages) {
            messages.forEach(m => oaiMessages.push(mapMessageToOpenAI(m)));
        }

        const oaiPayload = {
            model: model || "gpt-4-turbo",
            messages: oaiMessages,
            max_tokens: max_tokens || 4096,
            temperature: temperature || 0
        };

        if (tools && tools.length > 0) {
            oaiPayload.tools = tools.map(mapToolToOpenAI);
        }

        console.log('[PROXY] Forwarding to LLM...', oaiPayload.model);

        let headers = {
            'Content-Type': 'application/json'
        };

        const token = await getOAuthToken();
        headers['Authorization'] = `Bearer ${token}`;

        // Forward to the non-streaming API
        const response = await axios.post(TARGET_API_URL, oaiPayload, { headers });

        const proxiedResponse = mapResponseToAnthropic(response.data);
        console.log('[PROXY] Received LLM output, translating to Anthropic signature.');

        // Notice: Claude-code relies heavily on streaming. If it requests stream: true, 
        // we'd need to emit Server Sent Events (SSE). 
        // This MVP version returns a sync object, so the client might need `stream: false` config.
        res.json(proxiedResponse);

    } catch (error) {
        console.error('[PROXY ERROR]', error?.response?.data || error.message);
        const errPayload = {
            type: "error",
            error: {
                type: "api_error",
                message: error?.response?.data?.error?.message || error.message
            }
        };
        res.status(500).json(errPayload);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[PROXY] Anthropic-to-Codex shim started on http://localhost:${PORT}`);
    console.log(`[PROXY] Ensure your Target API Key is set in the environment.`);
});
