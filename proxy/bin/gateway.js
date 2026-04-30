#!/usr/bin/env node

/**
 * Codex Gateway — Interactive OpenAI Login for Claude Code
 * 
 * Uses the exact same endpoints as the official Codex CLI (codex-rs):
 *   - auth.openai.com/api/accounts/deviceauth/usercode
 *   - auth.openai.com/api/accounts/deviceauth/token
 *   - auth.openai.com/codex/device  (verification page)
 *
 * Then proxies Claude Code's Anthropic API calls → OpenAI API.
 *
 * Usage:
 *   node codex-gateway.js          # Login + launch
 *   node codex-gateway.js --login  # Force re-login
 *   node codex-gateway.js --setup  # Configure target model/endpoint
 *   node codex-gateway.js --serve  # Headless: run proxy only (for Docker)
 */

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

// ─── Codex Auth Constants (from codex-rs source) ────────────────────────────

const AUTH_ISSUER = 'https://auth.openai.com';
const DEVICE_USERCODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_VERIFY_URL = `${AUTH_ISSUER}/codex/device`;
const OAUTH_TOKEN_URL = `${AUTH_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(process.env.HOME || '~', '.codex-gateway');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
const PROXY_PORT = 18923;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {
    target_api_url: 'https://api.openai.com/v1/chat/completions',
    default_model: 'gpt-4o',
  };
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function loadToken() {
  if (fs.existsSync(TOKEN_FILE)) {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.expires_at && Date.now() < data.expires_at - 60000) {
      return data;
    }
  }
  return null;
}

function saveToken(tokenData) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`);
    else if (process.platform === 'linux') execSync(`xdg-open "${url}"`);
    else if (process.platform === 'win32') execSync(`start "${url}"`);
  } catch (e) { /* silent */ }
}

/**
 * HTTP POST using native https module.
 * Supports both JSON body (contentType=json) and form-encoded.
 */
function curlPost(url, data, contentType = 'json') {
  let body, ctHeader;
  if (contentType === 'json') {
    body = JSON.stringify(data);
    ctHeader = 'application/json';
  } else {
    body = new URLSearchParams(data).toString();
    ctHeader = 'application/x-www-form-urlencoded';
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqModule = parsed.protocol === 'https:' ? https : http;
    const req = reqModule.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': ctHeader,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(result.trim()));
        } catch (e) {
          reject(new Error(`Request failed: invalid JSON response`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Setup Wizard ────────────────────────────────────────────────────────────

async function runSetup() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    ⚙️  Codex Gateway — Settings                  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const existing = loadConfig();

  const targetApiUrl = await ask(`Target API URL [${existing.target_api_url}]: `)
    || existing.target_api_url;

  const defaultModel = await ask(`Default model [${existing.default_model}]: `)
    || existing.default_model;

  const config = { target_api_url: targetApiUrl, default_model: defaultModel };
  saveConfig(config);
  console.log(`\n✅ Settings saved to ${CONFIG_FILE}\n`);
}

// ─── Device Code Flow (matching codex-rs implementation) ─────────────────────

async function deviceCodeLogin() {
  console.log('\n  🔐 Starting OpenAI interactive login...\n');

  // Step 1: Request a device code via JSON POST (same as codex-rs)
  const deviceResp = await curlPost(DEVICE_USERCODE_URL, { client_id: CLIENT_ID });

  if (!deviceResp.device_auth_id || !deviceResp.user_code) {
    throw new Error(`Device code request failed: ${JSON.stringify(deviceResp)}`);
  }

  const {
    device_auth_id,
    user_code,
    interval: pollIntervalStr = '5',
    expires_at,
  } = deviceResp;

  // Step 2: Show the user code and open the browser
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log(`  │  Your login code is:  ${user_code.padEnd(24)}│`);
  console.log('  └─────────────────────────────────────────────────┘\n');
  console.log(`  1. Open: ${DEVICE_VERIFY_URL}`);
  console.log('  2. Enter the code above and sign in to your account.\n');
  console.log('  Waiting for browser login to complete...');

  openBrowser(DEVICE_VERIFY_URL);

  // Step 3: Poll for the authorization code
  const pollInterval = (parseInt(pollIntervalStr, 10) || 5) * 1000;
  const deadline = expires_at ? new Date(expires_at).getTime() : Date.now() + 900000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    try {
      const tokenResp = await curlPost(DEVICE_TOKEN_URL, {
        device_auth_id,
        user_code,
      });

      if (tokenResp.authorization_code) {
        // Got the auth code! Now exchange it for tokens via PKCE
        console.log('\n  ✅ Browser auth complete! Exchanging for token...');

        const { authorization_code, code_verifier, code_challenge } = tokenResp;
        const redirectUri = `${AUTH_ISSUER}/deviceauth/callback`;

        // Exchange auth code for real tokens
        const exchangeResp = await curlPost(OAUTH_TOKEN_URL, {
          grant_type: 'authorization_code',
          code: authorization_code,
          redirect_uri: redirectUri,
          client_id: CLIENT_ID,
          code_verifier: code_verifier,
        }, 'form');

        if (exchangeResp.access_token) {
          const tokenData = {
            access_token: exchangeResp.access_token,
            refresh_token: exchangeResp.refresh_token,
            id_token: exchangeResp.id_token,
            expires_at: Date.now() + ((exchangeResp.expires_in || 86400) * 1000),
          };
          saveToken(tokenData);
          console.log('  ✅ Login successful! Token cached.\n');
          return tokenData;
        } else {
          throw new Error(`Token exchange failed: ${JSON.stringify(exchangeResp)}`);
        }
      }
    } catch (e) {
      // If polling returns non-JSON (403/404 = pending), keep waiting
      if (e.message && e.message.includes('Request failed')) {
        process.stdout.write('.');
        continue;
      }
      // If it's a JSON parse error from a 403, keep polling
      if (e.message && e.message.includes('not valid JSON')) {
        process.stdout.write('.');
        continue;
      }
      throw e;
    }
  }

  throw new Error('Login timed out. Please try again.');
}

// ─── Refresh Token ───────────────────────────────────────────────────────────

async function refreshAccessToken(refreshToken) {
  try {
    const resp = await curlPost(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }, 'form');

    if (resp.access_token) {
      const tokenData = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token || refreshToken,
        id_token: resp.id_token,
        expires_at: Date.now() + ((resp.expires_in || 86400) * 1000),
      };
      saveToken(tokenData);
      return tokenData;
    }
  } catch (e) { /* fall through to re-login */ }
  return null;
}

// ─── Token Exchange: id_token → OpenAI API Key ──────────────────────────────
// Same as codex-rs obtain_api_key() in server.rs

function getAccountId(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return payload['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch (e) {
    return null;
  }
}

function mapMessagesToResponses(anthMessages) {
  const input = [];
  for (const m of anthMessages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        const texts = [];
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'tool_result') {
            const contentStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: contentStr });
          }
        }
        if (texts.length > 0) {
          input.push({ type: 'message', role: 'user', content: texts.join('\n') });
        }
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        input.push({ type: 'message', role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        const texts = [];
        for (const b of m.content) {
          if (b.type === 'text') texts.push(b.text);
          if (b.type === 'tool_use') {
            input.push({
              type: 'function_call',
              call_id: b.id,
              name: b.name,
              arguments: JSON.stringify(b.input || {})
            });
          }
        }
        if (texts.length > 0) {
          input.push({ type: 'message', role: 'assistant', content: texts.join('\n') });
        }
      }
    }
  }
  return input;
}

/**
 * Proxy OpenAI Responses API requests directly to the ChatGPT Codex backend.
 * Used by the Codex adapter when OPENAI_BASE_URL points here.
 * The request body is already in OpenAI Responses format — we just inject auth.
 */
function handleCodexPassthrough(config, accessToken, accountId, body, res) {
  try {
    const oaiReq = JSON.parse(body);

    // Allow model override but default to gateway config
    if (!oaiReq.model) oaiReq.model = config.default_model || 'gpt-5.4';
    oaiReq.store = false;

    const targetUrl = new URL(config.target_api_url);
    const postData = JSON.stringify(oaiReq);
    const isStream = oaiReq.stream !== false;

    const proxyReq = https.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId || '',
        'originator': 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/1.0'
      },
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        let errBody = '';
        proxyRes.on('data', d => errBody += d);
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(errBody);
        });
        return;
      }

      // Stream passthrough — forward SSE events as-is from ChatGPT backend
      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        proxyRes.on('data', chunk => res.write(chunk));
        proxyRes.on('end', () => res.end());
      } else {
        // Non-streaming: buffer and forward
        let responseBody = '';
        proxyRes.on('data', d => responseBody += d);
        proxyRes.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        });
      }
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
      }
    });

    proxyReq.write(postData);
    proxyReq.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message, type: 'invalid_request_error' } }));
  }
}

/**
 * Handle Anthropic-format requests by translating to OpenAI Responses API.
 * Used by the Claude adapter when ANTHROPIC_BASE_URL points here.
 */
function handleAnthropicTranslation(config, accessToken, accountId, body, res) {
  try {
    const anthReq = JSON.parse(body);

    const oaiPayload = {
      model: config.default_model || 'gpt-5.4',
      stream: true,
      store: false,
      instructions: typeof anthReq.system === 'string' ? anthReq.system : (JSON.stringify(anthReq.system) || ''),
      input: mapMessagesToResponses(anthReq.messages || []),
    };

    if (anthReq.tools?.length > 0) {
      oaiPayload.tools = anthReq.tools.map(t => {
        const params = t.input_schema || { type: 'object', properties: {} };
        // Conform to strict JSON schema
        params.additionalProperties = false;
        if (!params.required) {
          params.required = Object.keys(params.properties || {});
        }
        return {
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: params
        };
      });
    }

    const targetUrl = new URL(config.target_api_url);
    const postData = JSON.stringify(oaiPayload);

    const proxyReq = https.request(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId || '',
        'originator': 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/1.0'
      },
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        let errBody = '';
        proxyRes.on('data', d => errBody += d);
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errBody } }));
        });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      const emitSSE = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

      let buffer = '';
      let currentIndex = 0;
      let currentModel = oaiPayload.model;

      proxyRes.on('data', chunk => {
        buffer += chunk;
        let lines = buffer.split('\n');
        buffer = lines.pop();

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6);
          if (dataStr === '[DONE]') continue;
          
          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'response.created') {
              currentModel = data.response?.model || currentModel;
              emitSSE('message_start', {
                type: 'message_start',
                message: {
                  id: data.response?.id || 'msg_unknown',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: currentModel,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 0, output_tokens: 1 }
                }
              });
            } else if (data.type === 'response.output_item.added') {
              if (data.item?.type === 'message') {
                emitSSE('content_block_start', {
                  type: 'content_block_start',
                  index: currentIndex,
                  content_block: { type: 'text', text: '' }
                });
              } else if (data.item?.type === 'function_call') {
                emitSSE('content_block_start', {
                  type: 'content_block_start',
                  index: currentIndex,
                  content_block: { type: 'tool_use', id: data.item.call_id, name: data.item.name, input: {} }
                });
              }
            } else if (data.type === 'response.output_text.delta') {
              if (data.delta) {
                emitSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentIndex,
                  delta: { type: 'text_delta', text: data.delta }
                });
              }
            } else if (data.type === 'response.function_call_arguments.delta') {
              if (data.delta) {
                emitSSE('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentIndex,
                  delta: { type: 'input_json_delta', partial_json: data.delta }
                });
              }
            } else if (data.type === 'response.output_item.done') {
              emitSSE('content_block_stop', { type: 'content_block_stop', index: currentIndex });
              currentIndex++;
            } else if (data.type === 'response.completed') {
              const usage = data.response?.usage || { output_tokens: 15 };
              const outputs = data.response?.output || [];
              const stopReason = (outputs.length > 0 && outputs[outputs.length - 1].type === 'function_call') ? 'tool_use' : 'end_turn';
              emitSSE('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: usage.output_tokens }
              });
              emitSSE('message_stop', { type: 'message_stop' });
              res.end();
            }
          } catch (e) { /* ignore */ }
        }
      });

      proxyRes.on('end', () => res.end());
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
      }
    });

    proxyReq.write(postData);
    proxyReq.end();
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: e.message } }));
  }
}

function startProxy(config, accessToken, accountId) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Health check endpoint for liveness probes
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', mode: 'dual', model: config.default_model }));
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        return res.end('Not Found');
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const url = req.url || '/';

        // Route: OpenAI Responses API passthrough (for Codex adapter)
        if (url.startsWith('/v1/responses')) {
          handleCodexPassthrough(config, accessToken, accountId, body, res);
        }
        // Route: Everything else treated as Anthropic format (for Claude adapter)
        else {
          handleAnthropicTranslation(config, accessToken, accountId, body, res);
        }
      });
    });

    // Bind to loopback only. The proxy has no authentication of its
    // own (it relies on the OAuth token cached at ~/.codex-gateway), so
    // it must never be reachable from a non-local network. In the
    // Docker image Mission Control runs in the same container and
    // reaches us over container loopback, so 127.0.0.1 is sufficient.
    server.listen(PROXY_PORT, '127.0.0.1', () => {
      console.log(`  ✅ Proxy running on http://127.0.0.1:${PROXY_PORT}`);
      console.log(`  📡 Anthropic translation: POST http://127.0.0.1:${PROXY_PORT}/v1/messages (for Claude)`);
      console.log(`  📡 Codex passthrough:     POST http://127.0.0.1:${PROXY_PORT}/v1/responses (for Codex)`);
      console.log(`  💚 Health check:          GET  http://127.0.0.1:${PROXY_PORT}/health`);
      resolve(server);
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Headless poll for a usable token written by another process (the web
 * dashboard's device-code flow shares the same token.json). Resolves
 * once a fresh token appears or rejects if the deadline elapses.
 */
async function waitForToken(maxWaitMs = 24 * 60 * 60 * 1000, intervalMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const tok = loadToken();
    if (tok) {
      console.log('  ✅ Token found — proceeding');
      return tok;
    }
    // Try to refresh from a possibly-expired token on disk so the
    // dashboard doesn't have to do the device-code dance for every
    // container restart.
    if (fs.existsSync(TOKEN_FILE)) {
      try {
        const oldToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (oldToken?.refresh_token) {
          const refreshed = await refreshAccessToken(oldToken.refresh_token);
          if (refreshed) {
            console.log('  ✅ Token refreshed from disk');
            return refreshed;
          }
        }
      } catch { /* ignore */ }
    }
    await sleep(intervalMs);
  }
  throw new Error('timed out waiting for token (use the dashboard at :3000 to sign in)');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) {
    await runSetup();
    return;
  }

  const config = loadConfig();
  
  // Override for Codex responses API
  config.target_api_url = 'https://chatgpt.com/backend-api/codex/responses';
  config.default_model = 'gpt-5.4';

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     🚀 Codex Gateway — OpenAI Login for Claude  ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
  console.log(`  Model: ${config.default_model}  |  API: ${config.target_api_url}\n`);

  const isServe = args.includes('--serve');

  // Get token
  let tokenData = null;

  if (!args.includes('--login')) {
    tokenData = loadToken();
    if (tokenData) {
      console.log('  🔑 Using cached token (still valid)');
    }
  }

  if (!tokenData) {
    const oldToken = fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) : null;
    if (oldToken?.refresh_token && !args.includes('--login')) {
      console.log('  🔄 Token expired, refreshing...');
      tokenData = await refreshAccessToken(oldToken.refresh_token);
      if (tokenData) {
        console.log('  ✅ Token refreshed!');
      }
    }

    if (!tokenData) {
      if (isServe) {
        // Headless: poll for a token written by the web dashboard
        // login flow instead of opening a browser-based device code.
        console.log('  ⏳ No token yet — waiting for web dashboard login...');
        tokenData = await waitForToken();
      } else {
        tokenData = await deviceCodeLogin();
      }
    }
  }

  const bearerToken = tokenData.access_token;
  const accountId = getAccountId(tokenData.id_token);

  // Start proxy
  console.log('  🔄 Starting streaming proxy (Anthropic → ChatGPT Codex backend)...');
  const proxyServer = await startProxy(config, bearerToken, accountId);

  // Headless mode: serve the proxy and stop here. Used by the Docker
  // container, which runs the Next.js dashboard alongside.
  if (isServe) {
    console.log(`  ✅ Proxy listening on port ${PROXY_PORT}`);
    console.log('  (--serve mode: not launching Claude)');
    process.on('SIGINT', () => { proxyServer.close(); process.exit(0); });
    process.on('SIGTERM', () => { proxyServer.close(); process.exit(0); });
    return;
  }

  // Prepare isolated Claude config to bypass login screen
  const claudeConfigDir = path.join(CONFIG_DIR, 'claude-config');
  if (!fs.existsSync(claudeConfigDir)) {
    fs.mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  }

  // Generate a realistic-looking dummy API key (Claude validates format)
  const dummyKey = `sk-ant-api03-${crypto.randomBytes(36).toString('base64url')}-${crypto.randomBytes(18).toString('base64url')}`;

  // Write claude.json with hasCompletedOnboarding=true to skip TUI login
  const claudeJson = path.join(claudeConfigDir, '.claude.json');
  const claudeJsonData = { hasCompletedOnboarding: true };
  fs.writeFileSync(claudeJson, JSON.stringify(claudeJsonData, null, 2), { mode: 0o600 });

  // Create settings dir and apiKeyHelper
  const settingsDir = path.join(claudeConfigDir, '.claude');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  }

  // Write apiKeyHelper script
  const keyHelperScript = path.join(settingsDir, 'api-key-helper.sh');
  fs.writeFileSync(keyHelperScript, `#!/bin/sh\necho "${dummyKey}"\n`, { mode: 0o755 });

  // Write settings.json with apiKeyHelper
  const settingsJson = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsJson, JSON.stringify({
    apiKeyHelper: keyHelperScript,
  }, null, 2), { mode: 0o600 });

  // Launch claude
  console.log('  🚀 Launching Claude Code...\n');
  console.log('  ─────────────────────────────────────────────────\n');

  const claudeEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://localhost:${PROXY_PORT}`,
    ANTHROPIC_API_KEY: dummyKey,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };

  const claude = spawn('claude', args.filter(a => a !== '--login'), {
    stdio: 'inherit',
    env: claudeEnv,
  });

  claude.on('close', (code) => {
    proxyServer.close();
    process.exit(code || 0);
  });

  claude.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('\n  ❌ "claude" command not found. Install with: npm install -g @anthropic-ai/claude-code');
    } else {
      console.error(`\n  ❌ Error: ${err.message}`);
    }
    proxyServer.close();
    process.exit(1);
  });

  process.on('SIGINT', () => { claude.kill('SIGINT'); proxyServer.close(); });
  process.on('SIGTERM', () => { claude.kill('SIGTERM'); proxyServer.close(); });
}

main().catch(err => {
  console.error(`\n  ❌ Fatal: ${err.message}`);
  process.exit(1);
});
