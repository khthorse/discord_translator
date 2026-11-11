const settingsOnly = new URLSearchParams(window.location.search).get('settings') === '1';
const overlay = document.getElementById('overlay');

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
}

function clearSubtitleTimers() {
  for (const timer of subtitleTimers) {
    clearTimeout(timer);
  }

  subtitleTimers = [];
}

/* Apply settings */

function applySettings() {
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

  modeButton.textContent = isSubtitle
    ? 'HUD MODE'
    : 'SUBTITLES';

  hudModeButton.classList.toggle('active', !isSubtitle);
  subtitleModeButton.classList.toggle('active', isSubtitle);

  footerMode.textContent = isSubtitle
    ? 'SUBTITLE MODE'
    : 'GAMING HUD';

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
  window.wookie.openSettings();
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
    title.textContent = 'Waiting for translations';

    const description = document.createElement('span');
    description.textContent =
      'Messages from your selected Discord channels will appear here.';

    empty.append(icon, title, description);
    messagesContainer.appendChild(empty);
  } else {
    for (const message of visibleMessages) {
      messagesContainer.appendChild(createHudMessage(message));
    }
  }

  messageCounter.textContent =
    `${visibleMessages.length} MESSAGES`;

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

/* Initial setup */

applySettings();
window.wookie.setMode(settings.mode);