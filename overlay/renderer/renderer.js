const settingsOnly = new URLSearchParams(window.location.search).get('settings') === '1';
const uiLanguageSelect = document.getElementById('uiLanguage');
const overlay = document.getElementById('overlay');
const topbar = document.querySelector('.topbar');

const messagesContainer = document.getElementById('messages');
const subtitlesContainer = document.getElementById('subtitles');

const hudContent = document.getElementById('hudContent');
const subtitleContent = document.getElementById('subtitleContent');
const settingsPanel = document.getElementById('settingsPanel');

const connectionRow = document.getElementById('connectionRow');
const overlayFooter = document.getElementById('overlayFooter');

const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');

const messageCounter = document.getElementById('messageCounter');
const footerMode = document.getElementById('footerMode');

const modeButton = document.getElementById('modeButton');
const hudModeButton = document.getElementById('hudModeButton');
const subtitleModeButton = document.getElementById('subtitleModeButton');

const settingsButton = document.getElementById('settingsButton');
const closeSettingsButton = document.getElementById('closeSettingsButton');

const clearButton = document.getElementById('clearButton');
const closeButton = document.getElementById('closeButton');
const minimizeButton = document.getElementById('minimizeButton');

const resetWindowSizesButton =
  document.getElementById('resetWindowSizesButton');

const connectionModeSelect = document.getElementById('connectionMode');
const relayUrlInput = document.getElementById('relayUrl');
const relayTokenInput = document.getElementById('relayToken');
const saveRelaySettingsButton = document.getElementById('saveRelaySettingsButton');
const relayCredentialStatus = document.getElementById('relayCredentialStatus');
const relaySettingsStatus = document.getElementById('relaySettingsStatus');

const languageEn = document.getElementById('languageEn');
const languageEs = document.getElementById('languageEs');

const hudBackgroundSlider = document.getElementById('hudBackgroundSlider');
const hudBackgroundValue = document.getElementById('hudBackgroundValue');

const hudFontSlider = document.getElementById('hudFontSlider');
const hudFontValue = document.getElementById('hudFontValue');

const subtitleTransparent = document.getElementById('subtitleTransparent');

const subtitleWindowSlider =
  document.getElementById('subtitleWindowSlider');

const subtitleWindowValue =
  document.getElementById('subtitleWindowValue');

const bubbleOpacitySlider =
  document.getElementById('bubbleOpacitySlider');

const bubbleOpacityValue =
  document.getElementById('bubbleOpacityValue');

const subtitleFontSlider =
  document.getElementById('subtitleFontSlider');

const subtitleFontValue =
  document.getElementById('subtitleFontValue');

const durationSlider = document.getElementById('durationSlider');
const durationValue = document.getElementById('durationValue');

const subtitleFade = document.getElementById('subtitleFade');

const mergePauseSlider =
  document.getElementById('mergePauseSlider');

const mergePauseValue =
  document.getElementById('mergePauseValue');

const subtitleWidthSlider =
  document.getElementById('subtitleWidthSlider');

const subtitleWidthValue =
  document.getElementById('subtitleWidthValue');

const historySlider = document.getElementById('historySlider');
const historyValue = document.getElementById('historyValue');

const autoScrollCheckbox = document.getElementById('autoScroll');
const positionLockCheckbox = document.getElementById('positionLock');

const DEFAULT_SETTINGS = {
  mode: 'hud',
  uiLanguage: 'en',
  languages: ['en', 'es'],
  historyLimit: 30,
  autoScroll: true,
  positionLocked: false,

  hud: {
    backgroundOpacity: 84,
    fontSize: 13
  },

  subtitle: {
    transparent: true,
    windowOpacity: 78,
    bubbleOpacity: 78,
    fontSize: 15,
    duration: 12,
    fade: true,
    mergePause: 5,
    width: 680
  }
};

function loadSettings() {
  try {
    const saved = JSON.parse(
      localStorage.getItem('wookie-settings') || '{}'
    );

    return {
      ...DEFAULT_SETTINGS,
      ...saved,

      languages: Array.isArray(saved.languages)
        ? saved.languages
        : [...DEFAULT_SETTINGS.languages],

      hud: {
        ...DEFAULT_SETTINGS.hud,
        ...(saved.hud || {}),

        backgroundOpacity:
          saved.hud?.backgroundOpacity ?? saved.opacity ?? 84,

        fontSize:
          saved.hud?.fontSize ?? saved.fontSize ?? 13
      },

      subtitle: {
        ...DEFAULT_SETTINGS.subtitle,
        ...(saved.subtitle || {}),

        duration:
          saved.subtitle?.duration ?? saved.subtitleDuration ?? 12,

        mergePause:
          saved.subtitle?.mergePause ?? 5
      }
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

let settings = loadSettings();

const UI_TEXT = {"en":{"interfaceLanguage":"INTERFACE LANGUAGE","displayMode":"DISPLAY MODE","hud":"HUD","subtitles":"SUBTITLES","connectionSource":"CONNECTION SOURCE","messageSource":"MESSAGE SOURCE","discordExisting":"Discord (existing)","relayFriends":"Relay (friends)","bothSources":"Both (test / deduplicate)","connectionDescription":"Discord uses the Discord desktop app. Relay receives messages from the host PC.","connectionDescription2":"Both listens to both and filters matching Discord message IDs.","relayUrl":"RELAY WEBSOCKET URL","relayToken":"PERSONAL RELAY ACCESS TOKEN","tokenPlaceholder":"Paste your private token","tokenSecure":"Token is stored using Windows secure storage and is never shown again.","saveConnection":"SAVE CONNECTION SETTINGS","translationLanguages":"TRANSLATION LANGUAGES","english":"English","spanish":"Spanish","gamingHud":"GAMING HUD","hudBackgroundOpacity":"HUD BACKGROUND OPACITY","hudFontSize":"HUD FONT SIZE","autoScroll":"Auto-scroll in HUD mode","subtitleMode":"SUBTITLE MODE","hideBackground":"Hide window background until hovered","hoverBackgroundOpacity":"HOVER WINDOW BACKGROUND OPACITY","subtitleBubbleOpacity":"SUBTITLE BUBBLE OPACITY","subtitleFontSize":"SUBTITLE FONT SIZE","subtitleDisplayTime":"SUBTITLE DISPLAY TIME","fadeOlderSubtitles":"Gradually fade older subtitles","messageAccumulationPause":"MESSAGE ACCUMULATION PAUSE","mergePauseDescription":"How long to wait between messages from the same speaker before starting a new subtitle bubble.","subtitleWindowWidth":"SUBTITLE WINDOW WIDTH","general":"GENERAL","messageHistoryLimit":"MESSAGE HISTORY LIMIT","lockWindowPosition":"Lock window position","windows":"WINDOWS","windowSizeDescription":"HUD and subtitle window sizes are saved separately. Resetting restores their default dimensions.","restoreWindowSizes":"RESTORE DEFAULT WINDOW SIZES","settingsAutoSaved":"Settings are saved automatically.","liveTranslator":"LIVE TRANSLATOR","liveTranslations":"LIVE TRANSLATIONS","waitingTranslations":"Waiting for translations","emptyMessages":"Messages from selected Discord channels will appear here.","settingsTitle":"WOOKIE SETTINGS","settingsSubtitle":"Configure your translation overlay","wookieTranslator":"WOOKIE TRANSLATOR","titleSwitchMode":"Switch display mode","titleSettings":"Settings","titleClear":"Clear messages","titleMinimize":"Minimize","titleClose":"Close","titleBack":"Back to overlay"},"es":{"interfaceLanguage":"IDIOMA DE LA INTERFAZ","displayMode":"MODO DE VISUALIZACIÓN","hud":"HUD","subtitles":"SUBTÍTULOS","connectionSource":"FUENTE DE CONEXIÓN","messageSource":"ORIGEN DE LOS MENSAJES","discordExisting":"Discord (actual)","relayFriends":"Relay (amigos)","bothSources":"Ambos (prueba / eliminar duplicados)","connectionDescription":"Discord utiliza la aplicación de escritorio de Discord. Relay recibe mensajes del PC anfitrión.","connectionDescription2":"Ambos escucha las dos fuentes y filtra los mensajes de Discord duplicados.","relayUrl":"URL DE WEBSOCKET DE RELAY","relayToken":"TOKEN PERSONAL DE ACCESO A RELAY","tokenPlaceholder":"Pega tu token privado","tokenSecure":"El token se guarda de forma segura en Windows y no volverá a mostrarse.","saveConnection":"GUARDAR AJUSTES DE CONEXIÓN","translationLanguages":"IDIOMAS DE TRADUCCIÓN","english":"Inglés","spanish":"Español","gamingHud":"HUD PARA JUEGOS","hudBackgroundOpacity":"OPACIDAD DEL FONDO DEL HUD","hudFontSize":"TAMAÑO DE FUENTE DEL HUD","autoScroll":"Desplazamiento automático en modo HUD","subtitleMode":"MODO DE SUBTÍTULOS","hideBackground":"Ocultar el fondo de la ventana hasta pasar el cursor","hoverBackgroundOpacity":"OPACIDAD DEL FONDO AL PASAR EL CURSOR","subtitleBubbleOpacity":"OPACIDAD DE LOS GLOBOS DE SUBTÍTULOS","subtitleFontSize":"TAMAÑO DE FUENTE DE LOS SUBTÍTULOS","subtitleDisplayTime":"DURACIÓN DE LOS SUBTÍTULOS","fadeOlderSubtitles":"Desvanecer gradualmente los subtítulos anteriores","messageAccumulationPause":"PAUSA ENTRE MENSAJES","mergePauseDescription":"Tiempo de espera entre mensajes del mismo hablante antes de crear un nuevo globo de subtítulos.","subtitleWindowWidth":"ANCHO DE LA VENTANA DE SUBTÍTULOS","general":"GENERAL","messageHistoryLimit":"LÍMITE DEL HISTORIAL DE MENSAJES","lockWindowPosition":"Bloquear la posición de la ventana","windows":"VENTANAS","windowSizeDescription":"Los tamaños de las ventanas HUD y de subtítulos se guardan por separado. Al restablecerlos, se recuperan sus dimensiones predeterminadas.","restoreWindowSizes":"RESTABLECER TAMAÑOS PREDETERMINADOS","settingsAutoSaved":"Los ajustes se guardan automáticamente.","liveTranslator":"TRADUCTOR EN DIRECTO","liveTranslations":"TRADUCCIONES EN DIRECTO","waitingTranslations":"Esperando traducciones","emptyMessages":"Los mensajes de los canales de Discord seleccionados aparecerán aquí.","settingsTitle":"AJUSTES DE WOOKIE","settingsSubtitle":"Configura tu superposición de traducción","wookieTranslator":"TRADUCTOR WOOKIE","titleSwitchMode":"Cambiar modo de visualización","titleSettings":"Ajustes","titleClear":"Borrar mensajes","titleMinimize":"Minimizar","titleClose":"Cerrar","titleBack":"Volver a la superposición"}};
function translate(key) {
  const lang = settings.uiLanguage === 'es' ? 'es' : 'en';
  return UI_TEXT[lang][key] || UI_TEXT.en[key] || key;
}
function applyTranslations() {
  const lang = settings.uiLanguage === 'es' ? 'es' : 'en';
  document.documentElement.lang = lang;
  uiLanguageSelect.value = lang;
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const node = Array.from(element.childNodes).find(item => item.nodeType === Node.TEXT_NODE && item.textContent.trim());
    if (node) {
      const lead = node.textContent.match(/^\s*/)?.[0] || '';
      const tail = node.textContent.match(/\s*$/)?.[0] || '';
      node.textContent = lead + translate(element.dataset.i18n) + tail;
    } else element.textContent = translate(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(element => element.title = translate(element.dataset.i18nTitle));
  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => element.placeholder = translate(element.dataset.i18nPlaceholder));
}

let messageStore = [];
let subtitleGroups = [];
let subtitleTimers = [];

let nextSubtitleId = 1;
let settingsOpen = settingsOnly;

function saveSettings() {
  localStorage.setItem(
    'wookie-settings',
    JSON.stringify(settings)
  );

  // Settings are edited in a separate BrowserWindow, so apply them to the
  // main overlay immediately as well. The main window ignores its own echo.
  if (settingsOnly) {
    window.wookie.publishSettings(settings);
  }
}

function clearSubtitleTimers() {
  for (const timer of subtitleTimers) {
    clearTimeout(timer);
  }

  subtitleTimers = [];
}

/* Apply settings */

function applySettings() {
  applyTranslations();
  document.documentElement.style.setProperty(
    '--hud-background-opacity',
    String(settings.hud.backgroundOpacity / 100)
  );

  document.documentElement.style.setProperty(
    '--hud-font-size',
    `${settings.hud.fontSize}px`
  );

  document.documentElement.style.setProperty(
    '--subtitle-window-opacity',
    String(settings.subtitle.windowOpacity / 100)
  );

  document.documentElement.style.setProperty(
    '--bubble-opacity',
    String(settings.subtitle.bubbleOpacity / 100)
  );

  document.documentElement.style.setProperty(
    '--subtitle-font-size',
    `${settings.subtitle.fontSize}px`
  );

  document.documentElement.style.setProperty(
    '--subtitle-max-width',
    `${settings.subtitle.width}px`
  );

  languageEn.checked = settings.languages.includes('en');
  languageEs.checked = settings.languages.includes('es');

  hudBackgroundSlider.value = settings.hud.backgroundOpacity;
  hudBackgroundValue.textContent =
    `${settings.hud.backgroundOpacity}%`;

  hudFontSlider.value = settings.hud.fontSize;
  hudFontValue.textContent =
    `${settings.hud.fontSize}px`;

  subtitleTransparent.checked = settings.subtitle.transparent;

  subtitleWindowSlider.value = settings.subtitle.windowOpacity;
  subtitleWindowValue.textContent =
    `${settings.subtitle.windowOpacity}%`;

  subtitleWindowSlider.disabled = settings.subtitle.transparent;

  bubbleOpacitySlider.value = settings.subtitle.bubbleOpacity;
  bubbleOpacityValue.textContent =
    `${settings.subtitle.bubbleOpacity}%`;

  subtitleFontSlider.value = settings.subtitle.fontSize;
  subtitleFontValue.textContent =
    `${settings.subtitle.fontSize}px`;

  durationSlider.value = settings.subtitle.duration;
  durationValue.textContent =
    `${settings.subtitle.duration}s`;

  subtitleFade.checked = settings.subtitle.fade;

  mergePauseSlider.value = settings.subtitle.mergePause;
  mergePauseValue.textContent =
    `${settings.subtitle.mergePause}s`;

  subtitleWidthSlider.value = settings.subtitle.width;
  subtitleWidthValue.textContent =
    `${settings.subtitle.width}px`;

  historySlider.value = settings.historyLimit;
  historyValue.textContent = settings.historyLimit;

  autoScrollCheckbox.checked = settings.autoScroll;
  positionLockCheckbox.checked = settings.positionLocked;

  overlay.classList.toggle(
    'position-locked',
    settings.positionLocked
  );

  setMode(settings.mode, false);

  renderHud();
  renderSubtitles();
}

/* Display modes */

function setMode(mode, notifyMain = true) {
  settings.mode = mode === 'subtitle' ? 'subtitle' : 'hud';

  const isSubtitle = settings.mode === 'subtitle';

  overlay.classList.toggle('subtitle-mode', isSubtitle);
  overlay.classList.toggle('hud-mode', !isSubtitle);

  overlay.classList.toggle(
    'subtitle-transparent',
    isSubtitle && settings.subtitle.transparent
  );

  if (!isSubtitle) {
    overlay.classList.remove('window-resizing');
  }

  modeButton.textContent = isSubtitle ? (settings.uiLanguage === 'es' ? 'MODO HUD' : 'HUD MODE') : translate('subtitles');

  hudModeButton.classList.toggle('active', !isSubtitle);
  subtitleModeButton.classList.toggle('active', isSubtitle);

  footerMode.textContent = isSubtitle ? (settings.uiLanguage === 'es' ? 'MODO SUBTÍTULOS' : 'SUBTITLE MODE') : translate('gamingHud');

  if (!settingsOpen) {
    hudContent.classList.toggle('hidden', isSubtitle);
    subtitleContent.classList.toggle('hidden', !isSubtitle);
  }

  if (notifyMain) {
    saveSettings();
    window.wookie.setMode(settings.mode);
  }

  renderHud();
  renderSubtitles();
}

/* Separate settings window */

function openSettings() {
  if (settingsOnly) {
    window.wookie.closeSettings();
  } else {
    window.wookie.openSettings();
  }
}

function closeSettings() {
  window.wookie.closeSettings();
}

if (settingsOnly) {
  document.body.classList.add('settings-window');
  overlay.classList.add('settings-open');
  settingsPanel.classList.remove('hidden');
}

settingsButton.addEventListener('click', openSettings);
closeSettingsButton.addEventListener('click', closeSettings);

// The title bar must remain a normal hit-testable area for hover detection.
// Implement dragging manually so hover and drag can work at the same time.
if (!settingsOnly && topbar) {
  let draggingWindow = false;

  topbar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button, input, a')) return;
    if (overlay.classList.contains('position-locked')) return;

    draggingWindow = true;
    topbar.setPointerCapture(event.pointerId);
    window.wookie.startWindowDrag(event.screenX, event.screenY);
    event.preventDefault();
  });

  topbar.addEventListener('pointermove', event => {
    if (!draggingWindow) return;
    window.wookie.moveWindowDrag(event.screenX, event.screenY);
  });

  const stopWindowDrag = () => {
    if (!draggingWindow) return;
    draggingWindow = false;
    window.wookie.endWindowDrag();
  };

  topbar.addEventListener('pointerup', stopWindowDrag);
  topbar.addEventListener('pointercancel', stopWindowDrag);
  topbar.addEventListener('lostpointercapture', stopWindowDrag);
}

/* Status */

function updateStatus(status) {
  statusText.textContent = status.text;

  statusDot.className = 'status-dot';

  if (status.type === 'success') {
    statusDot.classList.add('success');
  } else if (status.type === 'error') {
    statusDot.classList.add('error');
  }
}

/* Messages */

function formatTime(timestamp) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isLanguageEnabled(message) {
  return settings.languages.includes(message.language);
}

function parseWookieMessage(content) {
  const formatted = content.match(
    /^\*\*(.+?):\*\*\s*([\s\S]*)$/
  );

  if (formatted) {
    return {
      author: formatted[1],
      content: formatted[2]
    };
  }

  return {
    author: '',
    content
  };
}

function receiveMessage(data) {
  if (!isLanguageEnabled(data)) return;

  const parsed = parseWookieMessage(data.content);

  const message = {
    ...data,
    displayAuthor: parsed.author || data.author || 'Unknown',
    displayContent: parsed.content,
    receivedAt: Date.now()
  };

  messageStore.push(message);

  while (messageStore.length > settings.historyLimit) {
    messageStore.shift();
  }

  addSubtitleMessage(message);

  renderHud();
  renderSubtitles();
}

function addSubtitleMessage(message) {
  const now = Date.now();

  const speakerKey = message.displayAuthor
    .trim()
    .toLowerCase();

  const lastGroup = subtitleGroups[subtitleGroups.length - 1];

  const pauseMs = settings.subtitle.mergePause * 1000;

  const canAppend =
    lastGroup &&
    lastGroup.speakerKey === speakerKey &&
    lastGroup.language === message.language &&
    now - lastGroup.lastMessageAt <= pauseMs;

  if (canAppend) {
    lastGroup.content += ` ${message.displayContent}`;
    lastGroup.lastMessageAt = now;
    lastGroup.receivedAt = now;
  } else {
    subtitleGroups.push({
      id: nextSubtitleId++,
      speakerKey,
      language: message.language,
      flag: message.flag,
      author: message.displayAuthor,
      content: message.displayContent,
      receivedAt: now,
      lastMessageAt: now
    });
  }

  while (subtitleGroups.length > settings.historyLimit) {
    subtitleGroups.shift();
  }
}

function createHudMessage(data) {
  const message = document.createElement('article');
  message.className = 'message';

  const top = document.createElement('div');
  top.className = 'message-top';

  const channel = document.createElement('span');
  channel.className = 'message-channel';
  channel.textContent =
    `${data.flag} ${data.channelName.toUpperCase()}`;

  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(data.timestamp);

  top.append(channel, time);

  const author = document.createElement('div');
  author.className = 'message-author';
  author.textContent = data.displayAuthor;

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = data.displayContent;

  message.append(top, author, content);

  return message;
}

function renderHud() {
  messagesContainer.innerHTML = '';

  const visibleMessages = messageStore.filter(isLanguageEnabled);

  if (visibleMessages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '◈';

    const title = document.createElement('strong');
    title.textContent = translate('waitingTranslations');

    const description = document.createElement('span');
    description.textContent =
      translate('emptyMessages');

    empty.append(icon, title, description);
    messagesContainer.appendChild(empty);
  } else {
    for (const message of visibleMessages) {
      messagesContainer.appendChild(createHudMessage(message));
    }
  }

  messageCounter.textContent = settings.uiLanguage === 'es' ? `${visibleMessages.length} MENSAJES` : `${visibleMessages.length} MESSAGES`;

  if (settings.autoScroll) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function renderSubtitles() {
  clearSubtitleTimers();
  subtitlesContainer.innerHTML = '';

  const now = Date.now();
  const duration = settings.subtitle.duration * 1000;

  subtitleGroups = subtitleGroups.filter(group => {
    return (
      isLanguageEnabled({ language: group.language }) &&
      now - group.receivedAt < duration
    );
  });

  for (const group of subtitleGroups) {
    const age = now - group.receivedAt;
    const remaining = Math.max(0, duration - age);

    const bubble = document.createElement('article');
    bubble.className = 'subtitle-message';

    const author = document.createElement('div');
    author.className = 'message-author';
    author.textContent = `${group.flag} ${group.author}`;

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = group.content;

    bubble.append(author, content);
    subtitlesContainer.appendChild(bubble);

    if (settings.subtitle.fade) {
      const fadeAt = Math.max(0, duration * 0.65 - age);

      subtitleTimers.push(
        setTimeout(() => {
          bubble.classList.add('fading');
        }, fadeAt)
      );
    }

    subtitleTimers.push(
      setTimeout(() => {
        subtitleGroups = subtitleGroups.filter(
          item => item.id !== group.id
        );

        renderSubtitles();
      }, remaining)
    );
  }

  if (settings.autoScroll) {
    subtitlesContainer.scrollTop = 0;
  }
}

function clearMessages() {
  messageStore = [];
  subtitleGroups = [];

  clearSubtitleTimers();

  renderHud();
  renderSubtitles();
}

/* Mode controls */

modeButton.addEventListener('click', () => {
  setMode(settings.mode === 'hud' ? 'subtitle' : 'hud');
});

hudModeButton.addEventListener('click', () => {
  setMode('hud');
});

subtitleModeButton.addEventListener('click', () => {
  setMode('subtitle');
});

/* Connection source settings */

async function loadRelaySettings() {
  try {
    const config = await window.wookie.getRelayConfig();
    connectionModeSelect.value = config.mode || 'discord';
    relayUrlInput.value = config.url || '';
    relayCredentialStatus.textContent = config.hasToken
      ? (settings.uiLanguage === 'es' ? 'Hay un token personal guardado de forma segura. Deja el campo vacío para seguir utilizándolo.' : 'A personal token is saved securely. Leave the token field empty to keep using it.')
      : (settings.uiLanguage === 'es' ? 'Todavía no hay ningún token guardado. Cada amigo necesita su propio token privado.' : 'No token saved yet. Each friend needs their own private token.');
  } catch (error) {
    relaySettingsStatus.textContent = settings.uiLanguage === 'es' ? `No se pudieron cargar los ajustes de relay: ${error.message}` : `Could not load relay settings: ${error.message}`;
  }
}

saveRelaySettingsButton.addEventListener('click', async () => {
  saveRelaySettingsButton.disabled = true;
  relaySettingsStatus.textContent = settings.uiLanguage === 'es' ? 'Guardando ajustes de conexión...' : 'Saving connection settings...';

  try {
    const result = await window.wookie.saveRelayConfig({
      mode: connectionModeSelect.value,
      url: relayUrlInput.value,
      token: relayTokenInput.value
    });

    if (!result.ok) {
      relaySettingsStatus.textContent = result.error || (settings.uiLanguage === 'es' ? 'No se pudieron guardar los ajustes.' : 'Could not save settings.');
      return;
    }

    relayTokenInput.value = '';
    relayCredentialStatus.textContent = result.hasToken
      ? (settings.uiLanguage === 'es' ? 'Token personal guardado de forma segura.' : 'Personal token saved securely.')
      : (settings.uiLanguage === 'es' ? 'No hay ningún token de relay guardado.' : 'No relay token saved.');
    relaySettingsStatus.textContent = settings.uiLanguage === 'es' ? 'Guardado. Modo de conexión actualizado.' : 'Saved. Connection mode updated.';
  } catch (error) {
    relaySettingsStatus.textContent = settings.uiLanguage === 'es' ? `No se pudieron guardar los ajustes: ${error.message}` : `Could not save settings: ${error.message}`;
  } finally {
    saveRelaySettingsButton.disabled = false;
  }
});

void loadRelaySettings();

uiLanguageSelect.addEventListener('change', () => {
  settings.uiLanguage = uiLanguageSelect.value === 'es' ? 'es' : 'en';
  saveSettings();
  applySettings();
  void loadRelaySettings();
});

/* Language filters */

function updateLanguages() {
  settings.languages = [];

  if (languageEn.checked) settings.languages.push('en');
  if (languageEs.checked) settings.languages.push('es');

  saveSettings();

  renderHud();
  renderSubtitles();
}

languageEn.addEventListener('change', updateLanguages);
languageEs.addEventListener('change', updateLanguages);

/* HUD settings */

hudBackgroundSlider.addEventListener('input', () => {
  settings.hud.backgroundOpacity =
    Number(hudBackgroundSlider.value);

  hudBackgroundValue.textContent =
    `${settings.hud.backgroundOpacity}%`;

  document.documentElement.style.setProperty(
    '--hud-background-opacity',
    String(settings.hud.backgroundOpacity / 100)
  );

  saveSettings();
});

hudFontSlider.addEventListener('input', () => {
  settings.hud.fontSize = Number(hudFontSlider.value);

  hudFontValue.textContent =
    `${settings.hud.fontSize}px`;

  document.documentElement.style.setProperty(
    '--hud-font-size',
    `${settings.hud.fontSize}px`
  );

  saveSettings();
});

/* Subtitle background */

subtitleTransparent.addEventListener('change', () => {
  settings.subtitle.transparent = subtitleTransparent.checked;

  overlay.classList.toggle(
    'subtitle-transparent',
    settings.mode === 'subtitle' &&
    settings.subtitle.transparent
  );

  subtitleWindowSlider.disabled =
    settings.subtitle.transparent;

  saveSettings();
});

subtitleWindowSlider.addEventListener('input', () => {
  settings.subtitle.windowOpacity =
    Number(subtitleWindowSlider.value);

  subtitleWindowValue.textContent =
    `${settings.subtitle.windowOpacity}%`;

  document.documentElement.style.setProperty(
    '--subtitle-window-opacity',
    String(settings.subtitle.windowOpacity / 100)
  );

  saveSettings();
});

/* Subtitle bubble opacity */

bubbleOpacitySlider.addEventListener('input', () => {
  settings.subtitle.bubbleOpacity =
    Number(bubbleOpacitySlider.value);

  bubbleOpacityValue.textContent =
    `${settings.subtitle.bubbleOpacity}%`;

  document.documentElement.style.setProperty(
    '--bubble-opacity',
    String(settings.subtitle.bubbleOpacity / 100)
  );

  saveSettings();
});

/* Subtitle font */

subtitleFontSlider.addEventListener('input', () => {
  settings.subtitle.fontSize =
    Number(subtitleFontSlider.value);

  subtitleFontValue.textContent =
    `${settings.subtitle.fontSize}px`;

  document.documentElement.style.setProperty(
    '--subtitle-font-size',
    `${settings.subtitle.fontSize}px`
  );

  saveSettings();
  renderSubtitles();
});

/* Subtitle duration */

durationSlider.addEventListener('input', () => {
  settings.subtitle.duration =
    Number(durationSlider.value);

  durationValue.textContent =
    `${settings.subtitle.duration}s`;

  saveSettings();
  renderSubtitles();
});

/* Subtitle fade */

subtitleFade.addEventListener('change', () => {
  settings.subtitle.fade = subtitleFade.checked;

  saveSettings();
  renderSubtitles();
});

/* Accumulation pause */

mergePauseSlider.addEventListener('input', () => {
  settings.subtitle.mergePause =
    Number(mergePauseSlider.value);

  mergePauseValue.textContent =
    `${settings.subtitle.mergePause}s`;

  saveSettings();
});

/* Subtitle window width */

subtitleWidthSlider.addEventListener('input', () => {
  settings.subtitle.width =
    Number(subtitleWidthSlider.value);

  subtitleWidthValue.textContent =
    `${settings.subtitle.width}px`;

  document.documentElement.style.setProperty(
    '--subtitle-max-width',
    `${settings.subtitle.width}px`
  );

  if (settings.mode === 'subtitle') {
    window.wookie.setSubtitleSize(settings.subtitle.width);
  }

  saveSettings();
});

/* General settings */

historySlider.addEventListener('input', () => {
  settings.historyLimit = Number(historySlider.value);

  historyValue.textContent = settings.historyLimit;

  while (messageStore.length > settings.historyLimit) {
    messageStore.shift();
  }

  while (subtitleGroups.length > settings.historyLimit) {
    subtitleGroups.shift();
  }

  saveSettings();

  renderHud();
  renderSubtitles();
});

autoScrollCheckbox.addEventListener('change', () => {
  settings.autoScroll = autoScrollCheckbox.checked;
  saveSettings();
});

positionLockCheckbox.addEventListener('change', () => {
  settings.positionLocked = positionLockCheckbox.checked;

  overlay.classList.toggle(
    'position-locked',
    settings.positionLocked
  );

  saveSettings();
});

/* Window size reset */

resetWindowSizesButton.addEventListener('click', () => {
  window.wookie.resetWindowSizes();
});

/* Main overlay controls */

clearButton.addEventListener('click', () => {
  window.wookie.clear();
});

closeButton.addEventListener('click', () => {
  window.wookie.close();
});

minimizeButton.addEventListener('click', () => {
  window.wookie.minimize();
});

/* Main process events */

window.wookie.onMessage(receiveMessage);
window.wookie.onStatus(updateStatus);
window.wookie.onClearMessages(clearMessages);

window.wookie.onWindowResizing(resizing => {
  if (settings.mode !== 'subtitle' || settingsOpen) return;

  overlay.classList.toggle('window-resizing', resizing);
});

window.wookie.onModeChanged(mode => {
  setMode(mode, false);
});

// Receive settings edited in the floating settings window.
if (!settingsOnly) {
  window.wookie.onSettingsChanged(nextSettings => {
    if (!nextSettings || typeof nextSettings !== 'object') return;

    settings = {
      ...settings,
      ...nextSettings,
      hud: { ...settings.hud, ...(nextSettings.hud || {}) },
      subtitle: { ...settings.subtitle, ...(nextSettings.subtitle || {}) }
    };

    saveSettings();
    applySettings();
  });
}

/* Initial setup */

applySettings();
window.wookie.setMode(settings.mode);