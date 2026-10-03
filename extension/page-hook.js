// Runs in the page's own JavaScript world (manifest "world": "MAIN") at
// document_start, before any site script, in every frame.
//
// While a speed other than 1x is forced:
//   * the site's writes to video.playbackRate are recorded but not applied,
//   * reads of video.playbackRate return what the site last wrote (so a site that
//     checks "is the rate still 1?" sees 1),
//   * real "ratechange" events are hidden from the site,
//   * the real rate is re-applied whenever the browser or site resets it.
// At 1x (or when disabled) everything is passed straight through to the browser.
//
// Settings arrive from content.js (isolated world) as a CustomEvent on document.
(() => {
  'use strict';

  // Grab the browser's own implementations before any site script can replace them.
  const apply = Reflect.apply;
  const proto = HTMLMediaElement.prototype;
  const rateDesc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
  const nativeGetRate = rateDesc.get;
  const nativeSetRate = rateDesc.set;
  const nativePlay = proto.play;
  const qsa = Document.prototype.querySelectorAll;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, 'localName').get;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const stopImmediate = Event.prototype.stopImmediatePropagation;
  const eventTarget = Object.getOwnPropertyDescriptor(Event.prototype, 'target').get;
  const eventDetail = Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail').get;
  const NativeEvent = Event;
  const NativeCustomEvent = CustomEvent;
  const NativeWeakRef = WeakRef;
  const parse = JSON.parse;
  const setTimer = setTimeout;
  const setIntervalTimer = setInterval;
  const clearIntervalTimer = clearInterval;
  const isFinite = Number.isFinite;

  const CONFIG_EVENT = 'forced-speeder:config';
  const READY_EVENT = 'forced-speeder:ready';
  const MEDIA_EVENT = 'forced-speeder:media';

  let config = { active: false, speed: 1, audio: false };
  // Per element: { pageRate } = the rate the site believes is set (only while forcing).
  const states = new WeakMap();
  const tracked = new Set(); // WeakRefs to every media element we've seen
  const synthetic = new WeakSet(); // ratechange events we fire for the site's benefit
  let reportedMedia = false;
  let sweepTimer = 0;

  const isMedia = (el) => el instanceof HTMLMediaElement;
  const isForced = (el) => config.active && (config.audio || apply(localName, el, []) === 'video');

  function track(el) {
    let s = states.get(el);
    if (!s) {
      s = { pageRate: undefined };
      states.set(el, s);
      tracked.add(new NativeWeakRef(el));
      if (!reportedMedia) {
        reportedMedia = true;
        apply(dispatch, document, [new NativeCustomEvent(MEDIA_EVENT)]);
      }
    }
    return s;
  }

  // Make the real rate match the forced speed (no-op when not forcing).
  function enforce(el) {
    if (!isForced(el)) return;
    const s = track(el);
    const real = apply(nativeGetRate, el, []);
    if (s.pageRate === undefined) s.pageRate = real;
    if (real !== config.speed) {
      try {
        apply(nativeSetRate, el, [config.speed]);
      } catch (_) {
        // Out-of-range for this browser; leave the element alone.
      }
    }
  }

  // Hand control back to the site: put back the rate it thinks is set.
  function release(el) {
    const s = states.get(el);
    if (!s || s.pageRate === undefined) return;
    const want = s.pageRate;
    s.pageRate = undefined;
    if (apply(nativeGetRate, el, []) !== want) {
      try {
        apply(nativeSetRate, el, [want]);
      } catch (_) {}
    }
  }

  function eachMedia(fn) {
    for (const ref of tracked) {
      const el = ref.deref();
      if (el) fn(el);
      else tracked.delete(ref);
    }
    for (const el of apply(qsa, document, ['video, audio'])) {
      if (!states.has(el)) {
        track(el);
        fn(el);
      }
    }
  }

  // Safety net for anything that slips past the hooks and events below
  // (elements in shadow DOM, detached players, internal resets on new sources).
  function updateSweep() {
    if (config.active && !sweepTimer) {
      sweepTimer = apply(setIntervalTimer, window, [() => eachMedia(enforce), 1000]);
    } else if (!config.active && sweepTimer) {
      apply(clearIntervalTimer, window, [sweepTimer]);
      sweepTimer = 0;
    }
  }

  // --- property hooks ------------------------------------------------------

  const hooks = {
    get playbackRate() {
      if (!isForced(this)) return apply(nativeGetRate, this, []);
      enforce(this);
      return states.get(this).pageRate;
    },
    set playbackRate(value) {
      if (!isForced(this)) {
        apply(nativeSetRate, this, [value]);
        return;
      }
      const n = +value;
      if (!isFinite(n)) {
        // Same error the browser throws, so the site can't tell the difference.
        apply(nativeSetRate, this, [value]);
        return;
      }
      enforce(this);
      const s = states.get(this);
      if (s.pageRate !== n) {
        s.pageRate = n;
        // The browser would announce the change; do the same with the fake value.
        const el = this;
        apply(setTimer, window, [() => {
          const ev = new NativeEvent('ratechange');
          synthetic.add(ev);
          apply(dispatch, el, [ev]);
        }, 0]);
      }
    },
    play() {
      track(this);
      enforce(this);
      return apply(nativePlay, this, arguments);
    },
  };

  const hooked = Object.getOwnPropertyDescriptor(hooks, 'playbackRate');
  Object.defineProperty(proto, 'playbackRate', {
    get: hooked.get,
    set: hooked.set,
    enumerable: rateDesc.enumerable,
    configurable: true,
  });
  Object.defineProperty(proto, 'play', {
    value: hooks.play,
    writable: true,
    enumerable: Object.getOwnPropertyDescriptor(proto, 'play').enumerable,
    configurable: true,
  });

  // --- events --------------------------------------------------------------

  // Registered on window in the capture phase before any site code exists, so
  // these run first for every media event in the document.
  addListener.call(window, 'ratechange', (e) => {
    const el = apply(eventTarget, e, []);
    if (!isMedia(el) || synthetic.has(e)) return;
    if (isForced(el)) {
      apply(stopImmediate, e, []);
      enforce(el);
    }
  }, true);

  for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'seeked']) {
    addListener.call(window, type, (e) => {
      const el = apply(eventTarget, e, []);
      if (!isMedia(el)) return;
      track(el);
      enforce(el);
    }, true);
  }

  addListener.call(document, CONFIG_EVENT, (e) => {
    let next;
    try {
      next = parse(apply(eventDetail, e, []));
    } catch (_) {
      return;
    }
    const speed = +next.speed;
    if (!isFinite(speed) || speed <= 0) return;
    const wasActive = config.active;
    config = { active: Boolean(next.active), speed, audio: Boolean(next.audio) };
    if (config.active) {
      // Elements no longer covered (e.g. audio switched off) go back to the site.
      eachMedia((el) => (isForced(el) ? enforce(el) : release(el)));
    } else if (wasActive) {
      eachMedia(release);
    }
    updateSweep();
  });

  // In case content.js already has settings waiting for us.
  apply(dispatch, document, [new NativeCustomEvent(READY_EVENT)]);
})();
