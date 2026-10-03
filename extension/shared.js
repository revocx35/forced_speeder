// Settings and speed helpers shared by the popup, background and content scripts.
'use strict';

const FS = {
  MIN_SPEED: 0.25,
  MAX_SPEED: 16,
  STEP: 0.25,

  DEFAULTS: {
    enabled: true,   // master switch
    speed: 1,        // 1 = hands off, anything else is forced on every video
    lastSpeed: 2,    // what "R" toggles back to
    shortcuts: true, // S / D / R keys on pages with media
    overlay: true,   // flash the new speed over the video
    audio: false,    // also force <audio> elements, not just <video>
  },

  clamp(v) {
    v = Number(v);
    if (!Number.isFinite(v)) return 1;
    v = Math.min(FS.MAX_SPEED, Math.max(FS.MIN_SPEED, v));
    return Math.round(v * 100) / 100;
  },

  // Move one STEP up or down, snapping to the STEP grid (1.3 -> 1.5, 1.3 -> 1.25).
  step(speed, dir) {
    const n = speed / FS.STEP;
    const snapped = dir > 0 ? Math.floor(n + 1e-6) + 1 : Math.ceil(n - 1e-6) - 1;
    return FS.clamp(snapped * FS.STEP);
  },

  // Forcing is on only when enabled and not at 1x; at 1x the site keeps full control.
  isActive(s) {
    return Boolean(s.enabled) && Math.abs(s.speed - 1) > 1e-9;
  },

  format(speed) {
    return (Math.round(speed * 100) / 100).toString() + '×';
  },

  async get() {
    return browser.storage.local.get(FS.DEFAULTS);
  },

  // Store a new speed; remember it for the R toggle when it isn't 1x.
  async setSpeed(speed) {
    speed = FS.clamp(speed);
    const patch = { speed };
    if (speed !== 1) patch.lastSpeed = speed;
    await browser.storage.local.set(patch);
    return speed;
  },
};
