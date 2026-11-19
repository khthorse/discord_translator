import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const port = Math.max(1, Number(process.env.OVERLAY_RELAY_PORT) || 8765);
const clients = new Set();
const availableLanguages = new Map();

function languageDisplayName(code) {
  try {
    const normalized = code.includes('-')
      ? code.split('-')[0] + '-' + code.split('-').slice(1).join('-').toUpperCase()
      : code;
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized) || code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function getLanguageList() {
  return [...availableLanguages.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastLanguageList() {
  const packet = JSON.stringify({ type: 'languages', data: getLanguageList() });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(packet);
  }
}

function loadTokens() {
  const raw = String(process.env.OVERLAY_RELAY_TOKENS || '');
  const tokens = new Map();

  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;

    const label = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();

    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(label) || token.length < 32) {
      console.warn('[OVERLAY] Ignoring an invalid relay credential entry.');
      continue;
    }

    if (tokens.has(label)) {
      console.warn(`[OVERLAY] Duplicate relay label "${label}" ignored.`);
      continue;
    }

    tokens.set(label, Buffer.from(token, 'utf8'));
  }

  return tokens;
}

const credentials = loadTokens();

function findCredential(candidate) {
  if (typeof candidate !== 'string' || !candidate || !credentials.size) return null;

  const received = Buffer.from(candidate, 'utf8');

  for (const [label, expected] of credentials) {
    if (expected.length === received.length && timingSafeEqual(expected, received)) {
      return label;
    }
  }

  return null;
}

let httpServer = null;
let webSocketServer = null;

export function startOverlayRelay() {
  if (!credentials.size) {
    console.warn(
      '[OVERLAY] Relay disabled. Add one or more unique label:token entries to OVERLAY_RELAY_TOKENS.',
    );
    return false;
  }

  if (httpServer) return true;

  httpServer = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('Wookie overlay relay is running.\\n');
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found.\\n');
  });

  webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;

    try {
      pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/overlay') {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (webSocket) => {
    let authenticated = false;
    let credentialLabel = null;

    const authTimeout = setTimeout(() => {
      if (!authenticated) webSocket.close(4001, 'Authentication timeout');
    }, 8000);

    webSocket.on('message', (raw) => {
      if (authenticated) {
        webSocket.close(1008, 'Unexpected client message');
        return;
      }

      let packet;

      try {
        packet = JSON.parse(raw.toString('utf8'));
      } catch {
        webSocket.close(1008, 'Invalid authentication packet');
        return;
      }

      credentialLabel = packet?.type === 'authenticate'
        ? findCredential(packet.token)
        : null;

      if (!credentialLabel) {
        webSocket.close(4003, 'Authentication failed');
        return;
      }

      authenticated = true;
      clearTimeout(authTimeout);
      clients.add(webSocket);

      webSocket.send(JSON.stringify({ type: 'ready' }));
      webSocket.send(JSON.stringify({ type: 'languages', data: getLanguageList() }));
      console.log(`[OVERLAY] Authenticated client connected: ${credentialLabel}`);
    });

    webSocket.on('close', () => {
      clearTimeout(authTimeout);

      if (clients.delete(webSocket)) {
        console.log(`[OVERLAY] Client disconnected: ${credentialLabel || 'unknown'}`);
      }
    });

    webSocket.on('error', (error) => {
      console.warn('[OVERLAY] WebSocket error:', error.message);
    });
  });

  httpServer.on('error', (error) => {
    console.error('[OVERLAY] Relay server error:', error);
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.log(`[OVERLAY] Relay listening on http://127.0.0.1:${port}`);
  });

  return true;
}


export function setOverlayLanguages(languages) {
  if (!Array.isArray(languages)) return;
  availableLanguages.clear();
  for (const item of languages) {
    const code = String(typeof item === 'string' ? item : item?.code || '').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(code)) continue;
    const name = String(typeof item === 'object' && item?.name
      ? item.name
      : languageDisplayName(code)).slice(0, 60);
    const flag = String(typeof item === 'object' && item?.flag
      ? item.flag
      : '🌐').slice(0, 8);
    availableLanguages.set(code, { code, name, flag });
  }
  broadcastLanguageList();
}

export function broadcastOverlayMessage(message) {
  if (!message || typeof message !== 'object') return;

  const language = String(message.language || '').toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(language)) return;

  const name = languageDisplayName(language);
  const flag = String(message.flag || '🌐').slice(0, 8);
  const previousLanguage = availableLanguages.get(language);
  availableLanguages.set(language, { code: language, name, flag });
  if (!previousLanguage || previousLanguage.flag !== flag || previousLanguage.name !== name) {
    broadcastLanguageList();
  }

  const packet = JSON.stringify({
    type: 'message',
    data: {
      language,
      channelName: name.slice(0, 40),
      languageName: name,
      flag,
      author: String(message.author || 'Unknown').slice(0, 100),
      content: String(message.content || '').slice(0, 1800),
      timestamp: message.timestamp || new Date().toISOString(),
      messageId: String(message.messageId || '').slice(0, 100),
      source: 'relay',
    },
  });

  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;

    try {
      client.send(packet);
    } catch (error) {
      console.warn('[OVERLAY] Could not send to a connected overlay:', error.message);
    }
  }
}

export function stopOverlayRelay() {
  for (const client of clients) client.close(1001, 'Relay shutting down');
  clients.clear();

  webSocketServer?.close();
  httpServer?.close();

  webSocketServer = null;
  httpServer = null;
}
