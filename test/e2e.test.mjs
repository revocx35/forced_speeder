// End-to-end tests: real Firefox (headless) with the extension installed, test
// pages served from two local origins. Speeds are checked by how fast
// video.currentTime actually advances, not by what playbackRate reports.
//
//   npm test                       (builds dist/*.zip first, then runs this)
//   FIREFOX_BIN=/path/to/firefox   to pick a Firefox binary
//   HEADED=1                       to watch it run
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, Key, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fixtures = path.join(here, 'fixtures');
const ADDON_ID = 'forced-speeder@revocx35.github.io';
const UUID = '6f4a3c2e-9b1d-4e8a-a7c5-0d2f1e3b4a59';
const POPUP = `moz-extension://${UUID}/popup/popup.html`;
const TOLERANCE = 0.15;

function addonPath() {
  const dist = path.join(root, 'dist');
  const built = fs.existsSync(dist) && fs.readdirSync(dist).find((f) => f.endsWith('.zip'));
  return built ? path.join(dist, built) : path.join(root, 'extension');
}

// Static file server with Range support (Firefox streams video with ranges).
function serve() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(fixtures, name);
    if (!file.startsWith(fixtures) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const type = file.endsWith('.webm') ? 'video/webm' : 'text/html; charset=utf-8';
    const size = fs.statSync(file).size;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Forced Speeder in Firefox', () => {
  let driver;
  let siteA; // two ports = two origins, for the cross-origin iframe case
  let siteB;
  let popupTab;
  let pageTab;

  before(async () => {
    const [a, b] = await Promise.all([serve(), serve()]);
    siteA = a;
    siteB = b;

    const options = new firefox.Options()
      .setPreference('extensions.webextensions.uuids', JSON.stringify({ [ADDON_ID]: UUID }))
      .setPreference('media.autoplay.default', 0)
      .setPreference('media.autoplay.blocking_policy', 0);
    if (!process.env.HEADED) options.addArguments('-headless');
    if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);

    // System access lets the test open the popup page from the browser chrome.
    const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
    driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .setFirefoxService(service)
      .build();
    await driver.manage().setTimeouts({ script: 30000 });
    await driver.installAddon(addonPath(), true);

    // The popup page is opened in its own window. WebDriver refuses to navigate
    // to moz-extension:// URLs, so load it from the browser chrome instead.
    pageTab = await driver.getWindowHandle();
    await driver.switchTo().newWindow('window');
    popupTab = await driver.getWindowHandle();
    await driver.setContext(firefox.Context.CHROME);
    await driver.executeScript('Services.wm.getMostRecentWindow("navigator:browser").openTrustedLinkIn(arguments[0], "current")', POPUP);
    await driver.setContext(firefox.Context.CONTENT);
    const speedInput = await driver.wait(until.elementLocated(By.id('speed')), 5000);
    await driver.wait(async () => (await speedInput.getAttribute('value')) === '1.00', 5000);
    await driver.switchTo().window(pageTab);
  });

  after(async () => {
    await driver?.quit();
    siteA?.close();
    siteB?.close();
  });

  const urlA = (p) => `http://127.0.0.1:${siteA.address().port}/${p}`;
  const urlB = (p) => `http://127.0.0.1:${siteB.address().port}/${p}`;

  // Run fn in the popup tab, then come back to the page (and frame) we were on.
  async function inPopup(fn) {
    await driver.switchTo().window(popupTab);
    try {
      return await fn();
    } finally {
      await driver.switchTo().window(pageTab);
    }
  }

  async function popupSpeed() {
    return inPopup(async () => Number(await driver.findElement(By.id('speed')).getAttribute('value')));
  }

  async function setSpeed(speed) {
    await inPopup(async () => {
      const input = await driver.findElement(By.id('speed'));
      // Select the current value, then type over it like a user would.
      await driver.executeScript('arguments[0].focus(); arguments[0].select();', input);
      await driver.actions().sendKeys(String(speed), Key.ENTER).perform();
      await driver.wait(async () => Number(await input.getAttribute('value')) === speed, 3000);
    });
  }

  async function setEnabled(on) {
    await inPopup(async () => {
      const box = await driver.findElement(By.id('enabled'));
      if ((await box.isSelected()) !== on) await box.click();
    });
  }

  // Plays the video from the start and measures media seconds per real second.
  async function measure(videoExpr = 'document.querySelector("video")') {
    const result = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      const v = ${videoExpr};
      v.currentTime = 0;
      v.play().then(() => {
        setTimeout(() => {
          const c0 = v.currentTime, t0 = performance.now();
          setTimeout(() => {
            done({
              rate: (v.currentTime - c0) / ((performance.now() - t0) / 1000),
              reported: v.playbackRate,
              paused: v.paused,
            });
          }, 2000);
        }, 600);
      }, (e) => done({ error: String(e) }));
    `);
    assert.equal(result.error, undefined, `play() failed: ${result.error}`);
    assert.equal(result.paused, false, 'video was paused');
    return result;
  }

  function assertRate(actual, expected) {
    assert.ok(
      Math.abs(actual - expected) <= expected * TOLERANCE,
      `expected real speed ~${expected}x, measured ${actual.toFixed(2)}x`,
    );
  }

  it('baseline: without forcing the video plays at 1x', async () => {
    await driver.get(urlA('plain.html'));
    const r = await measure();
    assertRate(r.rate, 1);
  });

  it('control: the locked page undoes a normal speed change', async () => {
    // Proves the lock works, so the forcing tests below mean something.
    await driver.get(urlA('locked.html'));
    await driver.executeScript('document.querySelector("video").playbackRate = 2');
    const r = await measure();
    assertRate(r.rate, 1);
    assert.ok((await driver.executeScript('return window.detections')) > 0, 'lock never fired');
  });

  it('forces 2x on a plain video, chosen with a popup preset', async () => {
    await inPopup(async () => {
      await driver.findElement(By.xpath('//div[@id="presets"]/button[.="2×"]')).click();
      await driver.wait(async () => (await driver.findElement(By.id('speed')).getAttribute('value')) === '2.00', 3000);
    });
    await driver.get(urlA('plain.html'));
    const r = await measure();
    assertRate(r.rate, 2);
  });

  it('a site that resets and polls the speed can neither undo nor detect it', async () => {
    await driver.get(urlA('locked.html'));
    const r = await measure();
    assertRate(r.rate, 2);
    assert.equal(r.reported, 1, 'site should still read playbackRate 1');
    const seen = await driver.executeScript('return { d: window.detections, rates: [...new Set(window.seenRates)] }');
    assert.equal(seen.d, 0, 'site detected the changed speed');
    assert.deepEqual(seen.rates, [1]);
  });

  it('forces the speed inside a cross-origin iframe (like a YouTube embed)', async () => {
    await driver.get(`${urlA('embed.html')}?frame=${encodeURIComponent(urlB('locked.html'))}`);
    const frame = await driver.wait(until.elementLocated(By.id('player')), 5000);
    await driver.switchTo().frame(frame);
    await driver.wait(async () => driver.executeScript('return document.readyState === "complete"'), 5000);
    const r = await measure();
    assertRate(r.rate, 2);
    assert.equal(await driver.executeScript('return window.detections'), 0);
    await driver.switchTo().defaultContent();
  });

  it('S / D / R keys work from the top page when the video is in an iframe', async () => {
    // Still on embed.html. Focus the top page, not the iframe.
    await driver.findElement(By.css('p')).click();
    const body = await driver.findElement(By.css('body'));
    await body.sendKeys('d');
    await driver.wait(async () => (await popupSpeed()) === 2.25, 3000, 'D did not speed up');
    await body.sendKeys('s', 's');
    await driver.wait(async () => (await popupSpeed()) === 1.75, 3000, 'S did not slow down');
    await body.sendKeys('r');
    await driver.wait(async () => (await popupSpeed()) === 1, 3000, 'R did not reset to 1x');
    await body.sendKeys('r');
    await driver.wait(async () => (await popupSpeed()) === 1.75, 3000, 'R did not restore last speed');

    // Typing in a text field must not be hijacked.
    const input = await driver.findElement(By.id('text'));
    await input.sendKeys('dsr');
    assert.equal(await input.getAttribute('value'), 'dsr');
    assert.equal(await popupSpeed(), 1.75);

    await driver.switchTo().frame(await driver.findElement(By.id('player')));
    const r = await measure();
    assertRate(r.rate, 1.75);
    await driver.switchTo().defaultContent();
  });

  it('keys are left alone on pages without any video', async () => {
    await driver.get(urlA('novideo.html'));
    await driver.findElement(By.css('body')).sendKeys('d');
    await sleep(300);
    assert.equal(await popupSpeed(), 1.75);
  });

  it('reaches a video inside a closed shadow root', async () => {
    await setSpeed(3);
    await driver.get(urlA('shadow.html'));
    const r = await measure('window.player');
    assertRate(r.rate, 3);
  });

  it('speeds above 4x work (up to 16x)', async () => {
    await setSpeed(8);
    await driver.get(urlA('plain.html'));
    const r = await measure();
    assertRate(r.rate, 8);
  });

  it('at 1x, and when switched off, the site controls the speed again', async () => {
    await setSpeed(1);
    await driver.get(urlA('plain.html'));
    await driver.executeScript('document.querySelector("video").playbackRate = 1.5');
    let r = await measure();
    assertRate(r.rate, 1.5);
    assert.equal(r.reported, 1.5);

    // Forcing again: real speed is ours, the site still reads its own 1.5.
    await setSpeed(2.5);
    r = await measure();
    assertRate(r.rate, 2.5);
    assert.equal(r.reported, 1.5);

    // Master switch off: back to what the site asked for.
    await setEnabled(false);
    r = await measure();
    assertRate(r.rate, 1.5);
    assert.equal(r.reported, 1.5);
    await setEnabled(true);
    r = await measure();
    assertRate(r.rate, 2.5);
  });
});
