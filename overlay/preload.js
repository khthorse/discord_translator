const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wookie', {
  onMessage(callback) {
    ipcRenderer.on('rpc:message', (_event, message) => {
      callback(message);
    });
  },

  onStatus(callback) {
    ipcRenderer.on('rpc:status', (_event, status) => {
      callback(status);
    });
  },

  onClearMessages(callback) {
    ipcRenderer.on('overlay:clear-messages', callback);
  },

  onModeChanged(callback) {
    ipcRenderer.on('overlay:mode-changed', (_event, mode) => {
      callback(mode);
    });
  },

  onRequestSubtitleResize(callback) {
    ipcRenderer.on('overlay:request-subtitle-resize', callback);
  },

  onWindowResizing(callback) {
    ipcRenderer.on('overlay:window-resizing', (_event, resizing) => {
      callback(resizing);
    });
  },

  onSettingsChanged(callback) {
    ipcRenderer.on('overlay:settings-changed', (_event, settings) => {
      callback(settings);
    });
  },

  close() {
    ipcRenderer.send('overlay:close');
  },

  minimize() {
    ipcRenderer.send('overlay:minimize');
  },

  clear() {
    ipcRenderer.send('overlay:clear');
  },

  setMode(mode) {
    ipcRenderer.send('overlay:set-mode', mode);
  },

  setPositionLock(locked) {
    ipcRenderer.send('overlay:set-position-lock', locked);
  },

  startWindowDrag(screenX, screenY) {
    ipcRenderer.send('overlay:drag-start', { screenX, screenY });
  },

  moveWindowDrag(screenX, screenY) {
    ipcRenderer.send('overlay:drag-move', { screenX, screenY });
  },

  endWindowDrag() {
    ipcRenderer.send('overlay:drag-end');
  },

  setSubtitleSize(width, height) {
    ipcRenderer.send('overlay:set-subtitle-size', {
      width,
      height
    });
  },

  openSettings() {
    ipcRenderer.send('overlay:toggle-settings');
  },

  publishSettings(settings) {
    ipcRenderer.send('overlay:settings-changed', settings);
  },

  closeSettings() {
    ipcRenderer.send('overlay:close-settings');
  },

  resetWindowSizes() {
    ipcRenderer.send('overlay:reset-window-sizes');
  }
});