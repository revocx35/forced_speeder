// Isolated-world content script (every frame). Bridges settings from storage to
// page-hook.js, handles the S / D / R keys and draws the speed overlay.
'use strict';

(() => {
  const CONFIG_EVENT = 'forced-speeder:config';
  const READY_EVENT = 'forced-speeder:ready';
  const MEDIA_EVENT = 'forced-speeder:media';

  let settings = null;
  // True once this frame, or any other frame in the tab, has a media element.
  // Keys are only taken over on such tabs, so typing "d" elsewhere is untouched.
  let tabHasMedia = false;

  function pushConfig() {
    if (!settings) return;
    const detail = JSON.stringify({
      active: FS.isActive(settings),
      speed: settings.speed,
      audio: settings.audio,
    });
    document.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail }));
  }

  FS.get().then((s) => {
    settings = s;
    pushConfig();
  });

  document.addEventListener(READY_EVENT, pushConfig);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !settings) return;
    const before = settings;
    settings = { ...settings };
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue === undefined ? FS.DEFAULTS[key] : newValue;
    }
    pushConfig();
    const speedShown = (s) => (s.enabled ? s.speed : 1);
    if (speedShown(before) !== speedShown(settings)) showOverlay(speedShown(settings));
  });

  // --- tab-wide "has media" flag ---------------------------------------------

  document.addEventListener(MEDIA_EVENT, () => {
    if (tabHasMedia) return;
    tabHasMedia = true;
    // Tell the other frames (e.g. the top page when the video is in an iframe).
    browser.runtime.sendMessage({ type: 'media-found' }).catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'tab-has-media') tabHasMedia = true;
  });

  // --- keyboard shortcuts ----------------------------------------------------

  const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'email', 'url', 'tel', 'password', 'number',
    'date', 'datetime-local', 'month', 'time', 'week',
  ]);

  function isTyping(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.isContentEditable) return true;
    const tag = el.localName;
    if (tag === 'textarea' || tag === 'select') return true;
    return tag === 'input' && TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
  }

  window.addEventListener('keydown', (e) => {
    if (!settings || !settings.enabled || !settings.shortcuts || !tabHasMedia) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing || isTyping(e)) return;
    if (typeof e.key !== 'string') return; // e.g. synthetic autofill events
    const key = e.key.toLowerCase();
    let next;
    if (key === 'd') next = FS.step(settings.speed, +1);
    else if (key === 's') next = FS.step(settings.speed, -1);
    else if (key === 'r') next = settings.speed !== 1 ? 1 : settings.lastSpeed;
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat && key === 'r') return;
    // Update locally right away so quick repeated presses each count.
    next = FS.clamp(next);
    settings = { ...settings, speed: next, lastSpeed: next !== 1 ? next : settings.lastSpeed };
    pushConfig();
    showOverlay(next);
    FS.setSpeed(next);
  }, true);

  // --- overlay ---------------------------------------------------------------

  let overlayHost = null;
  let overlayLabel = null;
  let overlayTimer = 0;

  function largestVisibleVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function showOverlay(speed) {
    if (!settings.overlay || document.visibilityState !== 'visible') return;
    const video = largestVisibleVideo();
    if (!video) return;

    if (!overlayHost) {
      overlayHost = document.createElement('div');
      const root = overlayHost.attachShadow({ mode: 'closed' });
      overlayLabel = document.createElement('div');
      const style = document.createElement('style');
      style.textContent = `
        div {
          position: fixed; z-index: 2147483647; pointer-events: none;
          padding: 4px 10px; border-radius: 6px;
          font: 600 15px/1.3 system-ui, sans-serif; color: #fff;
          background: rgba(0, 0, 0, 0.72);
          transition: opacity 0.3s;
        }`;
      root.append(style, overlayLabel);
    }

    // In fullscreen only the fullscreen element's subtree is painted.
    const fs = document.fullscreenElement;
    const parent = fs && fs !== video && fs.localName !== 'video' ? fs : document.documentElement;
    if (overlayHost.parentNode !== parent) parent.append(overlayHost);

    const r = video.getBoundingClientRect();
    overlayLabel.textContent = FS.format(speed);
    overlayLabel.style.left = `${Math.max(0, r.left) + 10}px`;
    overlayLabel.style.top = `${Math.max(0, r.top) + 10}px`;
    overlayLabel.style.opacity = '1';
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      overlayLabel.style.opacity = '0';
    }, 1200);
  }
})();
