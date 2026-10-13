// End-to-end check: loads the unpacked extension into Chromium and drives it
// against mock players served for real-looking URLs. Needs Playwright and
// ffmpeg; not part of any CI run.
//
//   NODE_PATH="$(npm root -g)" node tests/e2e.cjs
"use strict";

const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const EXT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vsg-e2e-"));

function makeVideo(name, seconds) {
  const file = path.join(TMP, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=320x180:r=1", "-t", String(seconds), "-c:v", "libvpx", "-b:v", "20k", "-g", "900", file]);
  return fs.readFileSync(file);
}

// long = 1:02:05, long2 = 1:23:20, short = 0:20
const VIDEOS = { "long.webm": makeVideo("long.webm", 3725), "long2.webm": makeVideo("long2.webm", 5000), "short.webm": makeVideo("short.webm", 20) };
const REAL = { long: "1:02:05", long2: "1:23:20" };

// Shared page script: a tiny player that writes its own clock labels the way
// real players do, from the <video> element's events.
const PLAYER_JS = `
  const fmt = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0'); };
  function wire(root) {
    const v = root.querySelector('video');
    const sync = () => {
      if (!isFinite(v.duration)) return;
      root.querySelectorAll('[data-total]').forEach((n) => (n.textContent = fmt(v.duration)));
      root.querySelectorAll('[data-combined]').forEach((n) => (n.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration)));
      root.querySelectorAll('[data-left]').forEach((n) => (n.textContent = '-' + fmt(v.duration - v.currentTime)));
      root.querySelectorAll('[data-left-unsigned]').forEach((n) => (n.textContent = fmt(v.duration - v.currentTime)));
      root.querySelectorAll('[role=slider]').forEach((n) => { n.setAttribute('aria-valuemax', Math.floor(v.duration)); n.setAttribute('aria-valuetext', fmt(v.currentTime) + ' of ' + fmt(v.duration)); });
    };
    ['loadedmetadata', 'durationchange', 'timeupdate'].forEach((e) => v.addEventListener(e, sync));
  }
  // Records every value a label shows, to prove the real one never appears.
  window.seen = [];
  window.sample = (sel) => setInterval(() => { const n = document.querySelector(sel); if (n) window.seen.push(n.textContent); }, 15);
`;

const YT_PLAYER = (src) => `
  <div id="movie_player" class="html5-video-player" style="width:640px;height:360px;position:relative">
    <video src="${src}" muted autoplay style="width:640px;height:360px"></video>
    <div class="ytp-chrome-bottom"><span class="ytp-time-current">0:00</span> / <span class="ytp-time-duration" data-total></span>
      <div class="ytp-progress-bar-container" style="height:5px;background:red"></div></div>
  </div>
  <script>${PLAYER_JS}; wire(document.getElementById('movie_player'));</script>`;

const PAGES = {
  "https://www.youtube.com/watch?v=abcDEF12345": YT_PLAYER("/vsg/long.webm") + `
    <script>window.navigateTo = (id, src) => { history.pushState({}, '', '/watch?v=' + id); document.querySelector('video').src = src; };
      window.reloadSource = () => { const v = document.querySelector('video'); sample('.ytp-time-duration'); v.src = '/vsg/long.webm?again=1'; };</script>`,
  "https://www.youtube.com/embed/abcDEF12345": YT_PLAYER("/vsg/long.webm"),
  "https://www.youtube.com/watch?v=shortVID001": YT_PLAYER("/vsg/short.webm"),
  // A player in an about:blank-style srcdoc frame on a YouTube page.
  "https://www.youtube.com/srcdoc-test": `
    <iframe id="f" style="width:700px;height:420px;border:0" srcdoc="<div id=p style='width:640px;height:390px'><video src='/vsg/long.webm' muted autoplay style='width:640px;height:360px'></video><span data-total></span></div><script>${PLAYER_JS.replace(/"/g, "&quot;")}; wire(document.getElementById('p'));</script>"></iframe>`,
  "https://blog.example.com/post": `
    <h1>Blog post</h1><iframe id="yt" src="https://www.youtube.com/embed/abcDEF12345" style="width:700px;height:420px;border:0"></iframe>`,
  "https://videos.example.org/watch/1": `
    <div id="slot"></div>
    <div id="player" style="width:640px;height:400px">
      <video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px;display:block"></video>
      <div class="controls"><span data-combined></span> <span data-left></span>
        <div role="slider" aria-label="Seek" style="height:6px;background:blue"></div></div>
    </div>
    <p>Article text mentioning 1:02:05 outside the player must stay.</p>
    <script>${PLAYER_JS}; wire(document.getElementById('player'));
      window.prependVideo = () => { document.getElementById('slot').innerHTML = '<div style="width:640px;height:360px"><video src="/vsg/long2.webm" muted autoplay style="width:640px;height:360px"></video></div>'; };
    </script>`,
  // Video.js prints time left as "-" in one span and the clock in the next.
  "https://vjs.example.net/v": `
    <div id="vjs" class="video-js" style="width:640px;height:400px">
      <video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video>
      <div class="vjs-control-bar"><div class="vjs-remaining-time"><span class="vjs-control-text">Remaining Time </span><span aria-hidden="true">-</span><span class="vjs-remaining-time-display" data-left-unsigned></span></div></div>
    </div>
    <script>${PLAYER_JS}; wire(document.getElementById('vjs'));</script>`,
  // A custom site whose length label starts as a "0:00" placeholder.
  "https://late.example.net/v": `
    <div id="p" style="width:640px;height:400px">
      <video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video>
      <span class="dur">0:00</span>
    </div>
    <script>${PLAYER_JS}; window.fill = () => { document.querySelector('.dur').textContent = fmt(document.querySelector('video').duration); };</script>`,
  "https://shadow.example.net/v": `
    <fancy-player></fancy-player><closed-player></closed-player>
    <script>${PLAYER_JS};
      const markup = '<div style="width:640px;height:390px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-total></span></div>';
      customElements.define('fancy-player', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = markup; wire(r); } });
      customElements.define('closed-player', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = markup; wire(r); window.closedRoot = r; } });
    </script>`,
};

const parseClock = (text) => text.trim().replace(/^[-−]/, "").split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
const isFake = (text, real) => {
  const shown = parseClock(text);
  return shown >= real + 7200 && shown <= real + 21600;
};

async function main() {
  const context = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--autoplay-policy=no-user-gesture-required"],
  });
  await context.route(/.*/, async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
    const file = url.pathname.startsWith("/vsg/") && VIDEOS[url.pathname.slice(5)];
    if (file) return route.fulfill({ status: 200, contentType: "video/webm", body: file, headers: { "accept-ranges": "none" } });
    const page = PAGES[url.origin + url.pathname + url.search] ?? PAGES[url.origin + url.pathname];
    if (page) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><body>${page}</body>` });
    return route.fulfill({ status: 404, body: "" });
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extId = new URL(worker.url()).host;
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(["PASS", name]);
    } catch (err) {
      results.push(["FAIL", name, err.message.split("\n").slice(0, 3).join(" ")]);
    }
  };
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  const setStorage = (items) => optionsPage.evaluate((i) => chrome.storage.sync.set(i), items);
  const removeStorage = (keys) => optionsPage.evaluate((k) => chrome.storage.sync.remove(k), keys);
  const getStorage = () => optionsPage.evaluate(() => chrome.storage.sync.get(null));
  const prompt = (page) => page.locator("video-spoiler-guard-prompt");
  const waitPrompt = (page) => page.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 6000 });
  const waitNoPrompt = (page) => page.waitForSelector("video-spoiler-guard-prompt", { state: "detached", timeout: 4000 });
  // Focus starts on the dialog itself. Tab order: "Don't show this again –
  // for this session", "– for this website", Cancel, Keep hidden.
  const press = async (page, ...keys) => {
    for (const key of keys) await page.keyboard.press(key);
  };
  const clickCancel = (page) => press(page, "Tab", "Tab", "Tab", "Enter");
  const getSession = () => optionsPage.evaluate(() => chrome.storage.session.get(null));
  // The popup reads the active tab's address; point it at a page instead.
  const openPopupFor = async (url) => {
    const popup = await context.newPage();
    await popup.addInitScript((u) => {
      chrome.tabs.query = async () => [{ url: u }];
    }, url);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(300);
    return popup;
  };
  const ready = (page, sel) => page.waitForFunction((s) => (document.querySelector(s) || {}).textContent, sel, { timeout: 10000 });

  // ---- 1. A listed site (YouTube) ----
  const yt = await context.newPage();
  await yt.goto("https://www.youtube.com/watch?v=abcDEF12345");
  await check("YouTube: duration label shows real length + 2-6 h", async () => {
    await ready(yt, ".ytp-time-duration");
    await yt.waitForTimeout(300);
    assert.ok(isFake(await yt.textContent(".ytp-time-duration"), 3725), await yt.textContent(".ytp-time-duration"));
  });
  await check("YouTube: the dialog appears on a listed site while auto-detect is on", async () => {
    await waitPrompt(yt);
    await yt.keyboard.press("Escape");
    await waitNoPrompt(yt);
    assert.ok(isFake(await yt.textContent(".ytp-time-duration"), 3725), "Escape keeps the guard");
  });
  const firstShown = await yt.textContent(".ytp-time-duration");
  await check("YouTube: same video keeps the same fake length after reload", async () => {
    await yt.reload();
    await ready(yt, ".ytp-time-duration");
    await yt.waitForTimeout(300);
    assert.equal(await yt.textContent(".ytp-time-duration"), firstShown);
  });
  await check("YouTube: 'Don't show this again – for this website' + Keep stops the dialog there", async () => {
    await waitPrompt(yt);
    await press(yt, "Tab", "Tab", "Space", "Tab", "Tab", "Enter"); // tick "for this website", then Keep hidden
    await yt.waitForTimeout(300);
    assert.equal((await getStorage())["builtin:youtube"]?.ask, false);
    await yt.reload();
    await ready(yt, ".ytp-time-duration");
    await yt.waitForTimeout(1800);
    assert.equal(await prompt(yt).count(), 0);
    assert.ok(isFake(await yt.textContent(".ytp-time-duration"), 3725));
  });
  await check("YouTube: reloading the source never flashes the real length", async () => {
    await yt.evaluate(() => window.reloadSource());
    await yt.waitForTimeout(1500);
    const seen = await yt.evaluate(() => window.seen);
    assert.ok(seen.length > 20, `sampled ${seen.length}`);
    assert.ok(!seen.includes(REAL.long), `real length appeared: ${[...new Set(seen)].join(", ")}`);
  });
  await check("YouTube: SPA navigation to another video re-guards with the new length", async () => {
    await yt.evaluate(() => window.navigateTo("zzzZZZ99999", "/vsg/long2.webm"));
    await yt.waitForFunction(() => document.querySelector("video").duration > 4000);
    await yt.waitForTimeout(400);
    assert.ok(isFake(await yt.textContent(".ytp-time-duration"), 5000), await yt.textContent(".ytp-time-duration"));
  });
  await check("YouTube: hide progress bar on, then off again", async () => {
    await setStorage({ "builtin:youtube": { enabled: true, ask: false, hideProgress: true } });
    await yt.waitForTimeout(400);
    const opacity = () => yt.evaluate(() => getComputedStyle(document.querySelector(".ytp-progress-bar-container")).opacity);
    assert.equal(await opacity(), "0");
    await setStorage({ "builtin:youtube": { enabled: true, ask: false, hideProgress: false } });
    await yt.waitForTimeout(400);
    assert.equal(await opacity(), "1");
  });
  await check("YouTube: switching the site off restores the real length", async () => {
    await setStorage({ "builtin:youtube": { enabled: false, ask: false } });
    await yt.waitForTimeout(400);
    assert.equal(await yt.textContent(".ytp-time-duration"), REAL.long2);
    await setStorage({ "builtin:youtube": { enabled: true, ask: false } });
    await yt.waitForTimeout(400);
    assert.notEqual(await yt.textContent(".ytp-time-duration"), REAL.long2);
  });

  // ---- 2. Short videos ----
  const ytShort = await context.newPage();
  await ytShort.goto("https://www.youtube.com/watch?v=shortVID001");
  await check("Short video (20 s) is not changed", async () => {
    await ready(ytShort, ".ytp-time-duration");
    await ytShort.waitForTimeout(400);
    assert.equal(await ytShort.textContent(".ytp-time-duration"), "0:20");
  });
  await ytShort.close();

  // ---- 3. Frames ----
  await check("A page switched off covers the YouTube embed inside it", async () => {
    await setStorage({ "site:blog.example.com": { enabled: false } });
    const blog = await context.newPage();
    await blog.goto("https://blog.example.com/post");
    const frame = blog.frameLocator("#yt");
    await blog.waitForTimeout(2000);
    assert.equal(await frame.locator(".ytp-time-duration").textContent(), REAL.long);
    await removeStorage("site:blog.example.com");
    await blog.waitForTimeout(800);
    assert.ok(isFake(await frame.locator(".ytp-time-duration").textContent(), 3725), "guarded again once the page is back to default");
    await blog.close();
  });
  await check("A srcdoc frame follows its page's setting", async () => {
    await setStorage({ "builtin:youtube": { enabled: false, ask: false } });
    const page = await context.newPage();
    await page.goto("https://www.youtube.com/srcdoc-test");
    await page.waitForTimeout(2000);
    assert.equal(await page.frameLocator("#f").locator("[data-total]").textContent(), REAL.long);
    await setStorage({ "builtin:youtube": { enabled: true, ask: false } });
    await page.waitForTimeout(800);
    assert.ok(isFake(await page.frameLocator("#f").locator("[data-total]").textContent(), 3725));
    await page.close();
  });

  // ---- 4. Unlisted site with auto-detect ----
  const generic = await context.newPage();
  await generic.goto("https://videos.example.org/watch/1");
  await check("Auto-detect: combined and remaining clocks rewritten, outside text untouched", async () => {
    await ready(generic, "[data-combined]");
    await generic.waitForTimeout(400);
    const combined = await generic.textContent("[data-combined]");
    assert.ok(isFake(combined.split("/")[1], 3725), combined);
    const left = await generic.textContent("[data-left]");
    assert.ok(parseClock(left) > 7000, left);
    assert.match(await generic.textContent("p"), /1:02:05/);
    const valuetext = await generic.getAttribute("[role=slider]", "aria-valuetext");
    assert.ok(!/\b1:02:05\b/.test(valuetext), valuetext);
  });
  await check("Auto-detect: dialog appears; Cancel restores the real length", async () => {
    await waitPrompt(generic);
    await clickCancel(generic);
    await waitNoPrompt(generic);
    await generic.waitForTimeout(300);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/);
  });
  await check("Auto-detect: a video added above a cancelled one doesn't undo Cancel", async () => {
    await generic.evaluate(() => window.prependVideo());
    await generic.waitForTimeout(2500);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/, "the cancelled video stays real");
  });
  await check("Auto-detect: 'for this session' + Keep hides lengths without the dialog until the browser closes", async () => {
    await generic.reload();
    await waitPrompt(generic);
    await press(generic, "Tab", "Space", "Tab", "Tab", "Tab", "Enter"); // tick "for this session", then Keep hidden
    await generic.waitForTimeout(400);
    assert.deepEqual((await getSession())["session:videos.example.org"]?.guard, true);
    assert.equal((await getStorage())["site:videos.example.org"], undefined, "nothing saved permanently");
    await generic.reload();
    await ready(generic, "[data-combined]");
    await generic.waitForTimeout(1500);
    assert.equal(await prompt(generic).count(), 0);
    assert.ok(isFake((await generic.textContent("[data-combined]")).split("/")[1], 3725));
    // The dashboard lists it and can forget it.
    await optionsPage.reload();
    await optionsPage.waitForSelector('#session-list li[data-domain="videos.example.org"]');
    await optionsPage.click('#session-list li[data-domain="videos.example.org"] button');
    await optionsPage.waitForTimeout(300);
    assert.equal((await getSession())["session:videos.example.org"], undefined);
  });
  await check("Auto-detect: 'for this session' + Cancel leaves the site alone for the session", async () => {
    await generic.reload();
    await waitPrompt(generic);
    await press(generic, "Tab", "Space", "Tab", "Tab", "Enter"); // tick "for this session", then Cancel
    await generic.waitForTimeout(400);
    assert.equal((await getSession())["session:videos.example.org"]?.guard, false);
    await generic.reload();
    await ready(generic, "[data-combined]");
    await generic.waitForTimeout(1500);
    assert.equal(await prompt(generic).count(), 0);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/);
    await optionsPage.evaluate(() => chrome.storage.session.remove("session:videos.example.org"));
  });
  await check("Auto-detect: 'for this website' + Cancel switches the site off", async () => {
    await setStorage({ confirmSeconds: 0 });
    await generic.reload();
    await waitPrompt(generic);
    await press(generic, "Tab", "Tab", "Space", "Tab", "Enter"); // tick "for this website", then Cancel
    await generic.waitForTimeout(400);
    assert.equal((await getStorage())["site:videos.example.org"]?.enabled, false);
    await generic.reload();
    await ready(generic, "[data-combined]");
    await generic.waitForTimeout(1500);
    assert.equal(await prompt(generic).count(), 0);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/);
    await removeStorage("site:videos.example.org");
    await setStorage({ confirmSeconds: 10 });
  });
  await check("Turning auto-detect off leaves unlisted sites alone", async () => {
    await setStorage({ autoDetect: false });
    await generic.reload();
    await ready(generic, "[data-combined]");
    await generic.waitForTimeout(1200);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/);
    assert.equal(await prompt(generic).count(), 0);
    await setStorage({ autoDetect: true });
  });

  // ---- 5. Player shapes ----
  await check("Video.js-style split remaining time is rewritten", async () => {
    const page = await context.newPage();
    await page.goto("https://vjs.example.net/v");
    await ready(page, "[data-left-unsigned]");
    await page.waitForTimeout(500);
    assert.ok(parseClock(await page.textContent("[data-left-unsigned]")) > 7000, await page.textContent("[data-left-unsigned]"));
    await page.close();
  });
  await check("A '0:00' placeholder in a site's label is never offset", async () => {
    await setStorage({ "site:late.example.net": { enabled: true, ask: false, durationSelector: ".dur" } });
    const page = await context.newPage();
    await page.goto("https://late.example.net/v");
    await page.waitForFunction(() => document.querySelector("video").duration > 0);
    await page.waitForTimeout(1500);
    assert.equal(await page.textContent(".dur"), "0:00");
    await page.evaluate(() => window.fill());
    await page.waitForTimeout(100);
    assert.ok(isFake(await page.textContent(".dur"), 3725), await page.textContent(".dur"));
    await removeStorage("site:late.example.net");
    await page.close();
  });
  await check("Shadow DOM: open and closed players are guarded, each with its own length", async () => {
    const page = await context.newPage();
    await page.goto("https://shadow.example.net/v");
    await page.waitForTimeout(2500);
    const open = await page.evaluate(() => document.querySelector("fancy-player").shadowRoot.querySelector("[data-total]").textContent);
    const closed = await page.evaluate(() => window.closedRoot.querySelector("[data-total]").textContent);
    assert.ok(isFake(open, 3725), `open: ${open}`);
    assert.ok(isFake(closed, 3725), `closed: ${closed}`);
    await page.close();
  });

  // ---- 6. Popup and options ----
  await check("Popup shows only the site you're on, and switches it", async () => {
    const popup = await openPopupFor("https://www.twitch.tv/videos/123456789");
    assert.equal(await popup.locator("#sites, #add-form, #auto-detect").count(), 0, "no site list, add box or global switches");
    assert.match(await popup.textContent("#here-host"), /^Twitch \(twitch\.tv\)$/);
    assert.equal(await popup.isChecked("#here-toggle"), true);
    await popup.click("#here-toggle");
    await popup.waitForTimeout(300);
    assert.equal((await getStorage())["builtin:twitch"]?.enabled, false);
    assert.equal(await popup.textContent("#here-pill"), "Off");
    await popup.click("#here-toggle");
    await popup.waitForTimeout(300);
    assert.equal((await getStorage())["builtin:twitch"]?.enabled, true);
    await popup.close();
  });
  await check("Popup switches an unlisted site off and on", async () => {
    const popup = await openPopupFor("https://clips.example.net/watch/1");
    assert.equal(await popup.isChecked("#here-toggle"), true, "auto-detect covers it");
    await popup.click("#here-toggle");
    await popup.waitForTimeout(300);
    assert.equal((await getStorage())["site:clips.example.net"]?.enabled, false);
    await removeStorage("site:clips.example.net");
    await popup.close();
  });
  await check("Popup opens the dashboard", async () => {
    // Chrome focuses an already open dashboard instead of opening another,
    // so check the call itself.
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      chrome.tabs.query = async () => [{ url: "https://www.youtube.com/watch?v=abcDEF12345" }];
      window.opened = 0;
      chrome.runtime.openOptionsPage = () => {
        window.opened++;
        return Promise.resolve();
      };
    });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.click("#open-dashboard");
    assert.equal(await popup.evaluate(() => window.opened), 1);
    assert.match(await optionsPage.title(), /dashboard/i);
    await popup.close();
  });
  await check("Dashboard lists built-in sites and adds a site", async () => {
    await optionsPage.reload();
    const names = await optionsPage.locator("#sites .site-name").allTextContents();
    assert.ok(names.some((n) => n.startsWith("YouTube")) && names.some((n) => n.startsWith("Twitch")), names.join());
    await optionsPage.fill("#add-domain", "https://www.Some-Video-Site.com/watch/9");
    await optionsPage.click("#add-form button[type=submit]");
    await optionsPage.waitForSelector('#sites li[data-key="site:some-video-site.com"]');
    await optionsPage.fill("#add-domain", "nonsense");
    await optionsPage.click("#add-form button[type=submit]");
    assert.match(await optionsPage.textContent("#add-error"), /example\.com/);
  });
  await check("Options page toggles, asks and removes an added site", async () => {
    await optionsPage.reload();
    const row = optionsPage.locator('#sites li[data-key="site:some-video-site.com"]');
    await row.locator(".switch").click();
    await row.locator('input[id^="ask-"]').click();
    await optionsPage.waitForTimeout(300);
    const stored = (await getStorage())["site:some-video-site.com"];
    assert.equal(stored.enabled, false);
    assert.equal(stored.ask, false);
    await row.locator(".icon-btn").click();
    await optionsPage.waitForTimeout(300);
    assert.equal((await getStorage())["site:some-video-site.com"], undefined);
  });
  await check("Options page saves a number once, after the last change", async () => {
    await optionsPage.focus("#min-video-minutes");
    for (let i = 0; i < 6; i++) await optionsPage.keyboard.press("ArrowUp");
    await optionsPage.waitForTimeout(800);
    assert.equal((await getStorage()).minVideoMinutes, 4);
    await setStorage({ minVideoMinutes: 1 });
  });

  await context.close();
  for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? "\n      " + detail : ""}`);
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
