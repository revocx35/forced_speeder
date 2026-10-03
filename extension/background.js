// Relays "this tab has a video" between frames and keeps the toolbar badge in sync.
'use strict';

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'media-found' && sender.tab) {
    // No frameId: delivered to every frame in the tab.
    browser.tabs.sendMessage(sender.tab.id, { type: 'tab-has-media' }).catch(() => {});
  }
});

async function updateBadge() {
  const s = await FS.get();
  const active = FS.isActive(s);
  await browser.action.setBadgeText({ text: active ? FS.format(s.speed) : '' });
  await browser.action.setBadgeBackgroundColor({ color: '#d0451b' });
  await browser.action.setBadgeTextColor({ color: '#ffffff' });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('speed' in changes || 'enabled' in changes)) updateBadge();
});
browser.runtime.onStartup.addListener(updateBadge);
browser.runtime.onInstalled.addListener(updateBadge);
