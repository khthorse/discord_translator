const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen
} = require('electron');

const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

const REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  'http://127.0.0.1:42813/callback';

const CHANNELS = [
  {
    id: '1569427932068323398',
    code: 'en',
    name: 'English',
    flag: '🇺🇸'
  },
  {
    id: '1569428319651364884',
    code: 'es',
    name: 'Spanish',
    flag: '🇪🇸'
  }
];

const CHANNEL_IDS = CHANNELS.map(channel => channel.id);

const DEFAULT_MODE_BOUNDS = {
  hud: { width: 440, height: 520 },
  subtitle: { width: 680, height: 90 }
};

let mainWindow = null;
let settingsWindow = null;

let socket = null;
let buffer = Buffer.alloc(0);

let connected = false;
let authenticated = false;
let authorizeNonce = null;

let reconnectTimer = null;
let reconnectAttempts = 0;

let currentMode = 'hud';

let modeBounds = {
  hud: { ...DEFAULT_MODE_BOUNDS.hud },
  subtitle: { ...DEFAULT_MODE_BOUNDS.subtitle }
};

let settingsOpen = false;

let resizeFeedbackTimer = null;
let savePositionTimer = null;

const statePath = path.join(
  app.getPath('userData'),
  'window-state.json'
);

/* Window state */

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function validDimension(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.max(min, Math.min(max, Math.round(number)));
}

function isPositionVisible(saved, fallbackWidth = 440, fallbackHeight = 520) {
  if (
    !Number.isFinite(saved?.x) ||
    !Number.isFinite(saved?.y)
  ) {
    return false;
  }

  const width = saved.width || fallbackWidth;
  const height = saved.height || fallbackHeight;

  return screen.getAllDisplays().some(display => {
    const area = display.workArea;

    return (
      saved.x < area.x + area.width &&
      saved.x + width > area.x &&
      saved.y < area.y + area.height &&
      saved.y + height > area.y
    );
  });
}

function getSavedBoundsForState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.getBounds();
  }

  return null;
}

function saveWindowState() {
  try {
    const bounds = getSavedBoundsForState();

    const state = {
      lastMode: currentMode,
      modeBounds
    };

    if (bounds) {
      state.x = bounds.x;
      state.y = bounds.y;
      state.width = bounds.width;
      state.height = bounds.height;
    }

    fs.writeFileSync(
      statePath,
      JSON.stringify(state, null, 2)
    );
  } catch (error) {
    console.error(
      'Could not save window state:',
      error.message
    );
  }
}

function scheduleSavePosition() {
  clearTimeout(savePositionTimer);

  savePositionTimer = setTimeout(() => {
    saveWindowState();
  }, 400);
}

/* Status */

function sendStatus(text, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rpc:status', {
      text,
      type
    });
  }

  console.log(`[${type.toUpperCase()}] ${text}`);
}

/* Discord RPC */

function sendPacket(opcode, data) {
  if (!socket || socket.destroyed) return;

  const payload = Buffer.from(
    JSON.stringify(data),
    'utf8'
  );

  const header = Buffer.alloc(8);

  header.writeUInt32LE(opcode, 0);
  header.writeUInt32LE(payload.length, 4);

  socket.write(Buffer.concat([header, payload]));
}

function sendCommand(cmd, args = {}, evt) {
  const nonce = `${Date.now()}-${Math.random()}`;

  const packet = { cmd, args, nonce };

  if (evt) packet.evt = evt;

  sendPacket(1, packet);

  return nonce;
}

async function exchangeCode(code) {
  const response = await fetch(
    'https://discord.com/api/oauth2/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description ||
      data.error ||
      `HTTP ${response.status}`
    );
  }

  return data;
}

function publishMessage(channelId, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const channel = CHANNELS.find(
    item => item.id === channelId
  );

  mainWindow.webContents.send('rpc:message', {
    channelId,
    language: channel?.code || 'unknown',
    channelName: channel?.name || 'Discord',
    flag: channel?.flag || '🌐',
    author: message.author?.username || 'Unknown',
    content: message.content || '',
    timestamp: message.timestamp || new Date().toISOString(),
    messageId: message.id || ''
  });
}

async function handleMessage(message) {
  if (message.evt === 'READY') {
    sendStatus(
      'Connected to Discord. Requesting authorization...'
    );

    authorizeNonce = sendCommand('AUTHORIZE', {
      client_id: CLIENT_ID,
      scopes: ['rpc', 'identify', 'messages.read']
    });

    return;
  }

  if (message.evt === 'ERROR') {
    sendStatus(
      message.data?.message || 'Unknown Discord RPC error',
      'error'
    );
    return;
  }

  if (message.cmd === 'AUTHORIZE') {
    if (message.nonce !== authorizeNonce) return;

    const code = message.data?.code;

    if (!code) {
      sendStatus(
        'Discord did not return an authorization code.',
        'error'
      );
      return;
    }

    sendStatus('Authorization accepted. Signing in...');

    try {
      const token = await exchangeCode(code);

      if (!token.access_token) {
        throw new Error('No access token returned.');
      }

      sendCommand('AUTHENTICATE', {
        access_token: token.access_token
      });
    } catch (error) {
      sendStatus(
        `Token exchange failed: ${error.message}`,
        'error'
      );
    }

    return;
  }

  if (message.cmd === 'AUTHENTICATE') {
    const scopes = message.data?.scopes || [];

    if (!scopes.includes('messages.read')) {
      sendStatus(
        'Discord did not grant messages.read.',
        'error'
      );
      return;
    }

    authenticated = true;
    reconnectAttempts = 0;

    sendStatus(
      'Connected! Listening for Wookie messages.',
      'success'
    );

    for (const channelId of CHANNEL_IDS) {
      sendCommand(
        'SUBSCRIBE',
        { channel_id: channelId },
        'MESSAGE_CREATE'
      );
    }

    return;
  }

  if (message.cmd === 'SUBSCRIBE') {
    console.log('Subscription response:', message.data);
    return;
  }

  if (message.evt === 'MESSAGE_CREATE') {
    if (!authenticated) return;

    const data = message.data;
    const discordMessage = data?.message;

    if (!discordMessage) return;

    const channelId = data.channel_id;

    if (!CHANNEL_IDS.includes(channelId)) return;
    if (!discordMessage.author?.bot) return;

    const botUserId = process.env.DISCORD_BOT_USER_ID || '';

    if (
      botUserId &&
      discordMessage.author.id !== botUserId
    ) {
      return;
    }

    if (!discordMessage.content) return;

    publishMessage(channelId, discordMessage);
  }
}

/* Discord reconnect */

function scheduleReconnect() {
  if (reconnectTimer || app.isQuitting) return;

  const delay = Math.min(
    1000 * Math.pow(2, reconnectAttempts),
    15000
  );

  reconnectAttempts++;

  sendStatus(
    `Discord disconnected. Reconnecting in ${Math.ceil(delay / 1000)} seconds...`,
    'error'
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    sendStatus(
      'Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET.',
      'error'
    );
    return;
  }

  if (connected) return;

  let pipeIndex = 0;

  function tryPipe() {
    if (pipeIndex > 9) {
      scheduleReconnect();
      return;
    }

    const currentIndex = pipeIndex++;
    const pipe = `\\\\?\\pipe\\discord-ipc-${currentIndex}`;

    const candidate = net.createConnection(pipe);

    candidate.once('connect', () => {
      socket = candidate;
      connected = true;
      buffer = Buffer.alloc(0);

      sendStatus('Discord desktop found. Connecting...');

      sendPacket(0, {
        v: 1,
        client_id: CLIENT_ID
      });
    });

    candidate.on('error', error => {
      if (socket === candidate) {
        console.error(
          'Discord IPC error:',
          error.message
        );
      }

      if (!connected) {
        candidate.destroy();
        tryPipe();
      }
    });

    candidate.on('close', () => {
      if (socket !== candidate) return;

      socket = null;
      connected = false;
      authenticated = false;
      authorizeNonce = null;

      if (!app.isQuitting) {
        scheduleReconnect();
      }
    });

    candidate.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);

        if (buffer.length < 8 + length) break;

        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);

        if (opcode === 1) {
          try {
            const rpcMessage = JSON.parse(
              payload.toString('utf8')
            );

            void handleMessage(rpcMessage).catch(error => {
              sendStatus(
                `RPC error: ${error.message}`,
                'error'
              );
            });
          } catch (error) {
            console.error(
              'RPC parsing error:',
              error.message
            );
          }
        }

        if (opcode === 3) {
          const pong = Buffer.alloc(8 + length);

          pong.writeUInt32LE(4, 0);
          pong.writeUInt32LE(length, 4);
          payload.copy(pong, 8);

          candidate.write(pong);
        }

        if (opcode === 2) {
          candidate.destroy();
          break;
        }
      }
    });
  }

  tryPipe();
}

/* Display mode */

function setMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const nextMode = mode === 'subtitle'
    ? 'subtitle'
    : 'hud';

  if (nextMode !== currentMode) {
    const bounds = mainWindow.getBounds();

    modeBounds[currentMode] = {
      width: bounds.width,
      height: bounds.height
    };

    currentMode = nextMode;

    const target = modeBounds[currentMode];

    mainWindow.setMinimumSize(
      currentMode === 'subtitle' ? 320 : 300,
      currentMode === 'subtitle' ? 70 : 150
    );

    mainWindow.setSize(
      target.width,
      target.height,
      true
    );
  }

  mainWindow.webContents.send(
    'overlay:mode-changed',
    currentMode
  );

  scheduleSavePosition();
}

function toggleMode() {
  setMode(currentMode === 'hud' ? 'subtitle' : 'hud');
}

function toggleVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

/* Separate floating settings window */

function positionSettingsWindow() {
  if (
    !mainWindow || mainWindow.isDestroyed() ||
    !settingsWindow || settingsWindow.isDestroyed()
  ) return;

  const main = mainWindow.getBounds();
  const display = screen.getDisplayMatching(main);
  const area = display.workArea;
  const settingsWidth = 390;
  const settingsHeight = Math.min(720, area.height);

  let x = main.x + main.width + 10;
  if (x + settingsWidth > area.x + area.width) {
    x = main.x - settingsWidth - 10;
  }
  x = Math.max(area.x, Math.min(x, area.x + area.width - settingsWidth));

  let y = Math.max(
    area.y,
    Math.min(main.y, area.y + area.height - settingsHeight)
  );

  settingsWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: settingsWidth,
    height: settingsHeight
  });
}

function openSettingsView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    positionSettingsWindow();
    return;
  }

  settingsOpen = true;

  settingsWindow = new BrowserWindow({
    width: 390,
    height: 680,
    parent: mainWindow,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  settingsWindow.setAlwaysOnTop(true, 'floating');
  settingsWindow.setVisibleOnAllWorkspaces(true);

  settingsWindow.once('ready-to-show', () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    positionSettingsWindow();
    settingsWindow.show();
    settingsWindow.focus();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
    settingsOpen = false;

    if (mainWindow && !mainWindow.isDestroyed() && !app.isQuitting) {
      mainWindow.focus();
    }
  });

  settingsWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    { query: { settings: '1' } }
  ).catch(error => {
    console.error('[SETTINGS] Failed to load settings window:', error);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });
}

function closeSettingsView() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsOpen = false;
    return;
  }

  settingsWindow.close();
}

/* Subtitle dimensions */

ipcMain.on('overlay:set-subtitle-size', (_event, dimensions) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const currentBounds = mainWindow.getBounds();

  const width = validDimension(
    dimensions?.width,
    currentBounds.width,
    320,
    900
  );

  const height = validDimension(
    dimensions?.height,
    currentBounds.height,
    70,
    900
  );

  modeBounds.subtitle = { width, height };

  if (currentMode === 'subtitle') {
    mainWindow.setSize(width, height, true);
  }

  scheduleSavePosition();
});

/* Reset window dimensions */

ipcMain.on('overlay:reset-window-sizes', () => {
  modeBounds = {
    hud: { ...DEFAULT_MODE_BOUNDS.hud },
    subtitle: { ...DEFAULT_MODE_BOUNDS.subtitle }
  };

  if (
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    const target = modeBounds[currentMode];

    mainWindow.setMinimumSize(
      currentMode === 'subtitle' ? 320 : 300,
      currentMode === 'subtitle' ? 70 : 150
    );

    mainWindow.setSize(
      target.width,
      target.height,
      true
    );
  }

  scheduleSavePosition();
});

/* Main window */

function createWindow() {
  const saved = readWindowState();

  currentMode =
    saved.lastMode === 'subtitle' ? 'subtitle' : 'hud';

  modeBounds = {
    hud: {
      width: validDimension(
        saved.modeBounds?.hud?.width,
        DEFAULT_MODE_BOUNDS.hud.width,
        300,
        1600
      ),
      height: validDimension(
        saved.modeBounds?.hud?.height,
        DEFAULT_MODE_BOUNDS.hud.height,
        150,
        1600
      )
    },

    subtitle: {
      width: validDimension(
        saved.modeBounds?.subtitle?.width,
        DEFAULT_MODE_BOUNDS.subtitle.width,
        320,
        1600
      ),
      height: validDimension(
        saved.modeBounds?.subtitle?.height,
        DEFAULT_MODE_BOUNDS.subtitle.height,
        70,
        900
      )
    }
  };

  if (!saved.modeBounds && Number.isFinite(saved.width)) {
    modeBounds[currentMode] = {
      width: validDimension(
        saved.width,
        DEFAULT_MODE_BOUNDS[currentMode].width,
        currentMode === 'subtitle' ? 320 : 300,
        1600
      ),
      height: validDimension(
        saved.height,
        DEFAULT_MODE_BOUNDS[currentMode].height,
        currentMode === 'subtitle' ? 70 : 150,
        1600
      )
    };
  }

  const validPosition = isPositionVisible(
    saved,
    modeBounds[currentMode].width,
    modeBounds[currentMode].height
  );

  const initialBounds = modeBounds[currentMode];

  mainWindow = new BrowserWindow({
    width: initialBounds.width,
    height: initialBounds.height,

    minWidth: currentMode === 'subtitle' ? 320 : 300,
    minHeight: currentMode === 'subtitle' ? 70 : 150,

    ...(validPosition
      ? { x: saved.x, y: saved.y }
      : { center: true }),

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',

    alwaysOnTop: true,
    resizable: true,
    maximizable: false,
    minimizable: true,
    hasShadow: false,

    show: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true);

  let hasShown = false;

  function showOverlay() {
    if (hasShown || !mainWindow || mainWindow.isDestroyed()) return;

    hasShown = true;
    mainWindow.show();
    mainWindow.focus();

    console.log(
      '[WINDOW] Overlay shown:',
      mainWindow.getBounds()
    );
  }

  mainWindow.once('ready-to-show', showOverlay);

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, code, description) => {
      console.error(
        '[RENDERER] Failed to load:',
        code,
        description
      );

      showOverlay();
    }
  );

  mainWindow.webContents.on(
    'render-process-gone',
    (_event, details) => {
      console.error('[RENDERER] Process exited:', details);
    }
  );

  mainWindow.webContents.on(
    'console-message',
    (_event, details) => {
      if (details.level >= 2) {
        console.error('[RENDERER] Console error:', details.message);
      }
    }
  );

  mainWindow.loadFile(
    path.join(__dirname, 'renderer', 'index.html')
  ).catch(error => {
    console.error('[WINDOW] Failed to load HTML:', error);
    showOverlay();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[RENDERER] HTML loaded successfully.');

    showOverlay();
    connect();
  });

  mainWindow.on('move', () => {
    scheduleSavePosition();
    positionSettingsWindow();
  });

  mainWindow.on('resize', () => {
    scheduleSavePosition();
    positionSettingsWindow();

    if (currentMode === 'subtitle') {
      mainWindow.webContents.send(
        'overlay:window-resizing',
        true
      );

      clearTimeout(resizeFeedbackTimer);

      resizeFeedbackTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            'overlay:window-resizing',
            false
          );
        }
      }, 500);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* IPC */

ipcMain.on('overlay:close', () => {
  app.quit();
});

ipcMain.on('overlay:minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('overlay:clear', () => {
  mainWindow?.webContents.send('overlay:clear-messages');
});

ipcMain.on('overlay:set-mode', (_event, mode) => {
  setMode(mode);
});

// Settings window controls. These event names must match preload.js.
ipcMain.on('overlay:open-settings', () => {
  openSettingsView();
});

ipcMain.on('overlay:close-settings', () => {
  closeSettingsView();
});

// Keep the older combined event available for compatibility.
ipcMain.on('overlay:set-settings-open', (_event, open) => {
  if (open) {
    openSettingsView();
  } else {
    closeSettingsView();
  }
});

/* App lifecycle */

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register(
    'Control+Shift+W',
    toggleVisibility
  );

  globalShortcut.register(
    'Control+Shift+S',
    toggleMode
  );
});

app.on('before-quit', () => {
  app.isQuitting = true;

  clearTimeout(reconnectTimer);
  clearTimeout(savePositionTimer);
  clearTimeout(resizeFeedbackTimer);

  globalShortcut.unregisterAll();

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy();
  }

  if (socket && !socket.destroyed) {
    socket.destroy();
  }

  saveWindowState();
});

app.on('window-all-closed', () => {
  app.quit();
});