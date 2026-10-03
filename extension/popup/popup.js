'use strict';

const PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const $ = (id) => document.getElementById(id);

let settings = { ...FS.DEFAULTS };

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = FS.format(p);
  b.dataset.speed = p;
  b.addEventListener('click', () => FS.setSpeed(p));
  $('presets').append(b);
}

function render() {
  const { enabled, speed } = settings;
  $('enabled').checked = enabled;
  $('controls').classList.toggle('off', !enabled);
  if (document.activeElement !== $('speed')) $('speed').value = speed.toFixed(2);
  $('slider').value = Math.min(speed, 4);
  for (const b of $('presets').children) {
    b.classList.toggle('current', Number(b.dataset.speed) === speed);
  }
  for (const key of ['shortcuts', 'overlay', 'audio']) $(key).checked = settings[key];

  let status;
  if (!enabled) status = 'Off: sites control the speed.';
  else if (speed === 1) status = '1×: sites control the speed.';
  else if (speed > 4) status = `Forcing ${FS.format(speed)} on every video. Firefox mutes sound above 4×.`;
  else status = `Forcing ${FS.format(speed)} on every video.`;
  $('status').textContent = status;
}

$('slower').addEventListener('click', () => FS.setSpeed(FS.step(settings.speed, -1)));
$('faster').addEventListener('click', () => FS.setSpeed(FS.step(settings.speed, +1)));
$('slider').addEventListener('input', (e) => FS.setSpeed(e.target.value));
// A typed speed is applied on Enter or when the field loses focus.
$('speed').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
$('speed').addEventListener('blur', (e) => {
  const typed = Number(e.target.value);
  if (e.target.value !== '' && typed > 0 && FS.clamp(typed) !== settings.speed) FS.setSpeed(typed);
  else render();
});
$('enabled').addEventListener('change', (e) => browser.storage.local.set({ enabled: e.target.checked }));
for (const key of ['shortcuts', 'overlay', 'audio']) {
  $(key).addEventListener('change', (e) => browser.storage.local.set({ [key]: e.target.checked }));
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    settings[key] = newValue === undefined ? FS.DEFAULTS[key] : newValue;
  }
  render();
});

FS.get().then((s) => {
  settings = s;
  render();
});
