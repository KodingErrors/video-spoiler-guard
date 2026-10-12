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

const VIDEOS = { "long.webm": makeVideo("long.webm", 3725), "long2.webm": makeVideo("long2.webm", 5000), "short.webm": makeVideo("short.webm", 20) };

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
      root.querySelectorAll('[role=slider]').forEach((n) => { n.setAttribute('aria-valuemax', Math.floor(v.duration)); n.setAttribute('aria-valuetext', fmt(v.currentTime) + ' of ' + fmt(v.duration)); });
    };
    ['loadedmetadata', 'durationchange', 'timeupdate'].forEach((e) => v.addEventListener(e, sync));
  }
`;

const PAGES = {
  "https://www.youtube.com/watch?v=abcDEF12345": `
    <div id="movie_player" class="html5-video-player" style="width:640px;height:360px;position:relative">
      <video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video>
      <div class="ytp-chrome-bottom"><span class="ytp-time-current">0:00</span> / <span class="ytp-time-duration" data-total></span>
        <div class="ytp-progress-bar-container" style="height:5px;background:red"></div></div>
    </div>
    <script>${PLAYER_JS}; wire(document.getElementById('movie_player'));
      window.navigateTo = (id, src) => { history.pushState({}, '', '/watch?v=' + id); document.querySelector('video').src = src; };
    </script>`,
  "https://www.youtube.com/watch?v=shortVID001": `
    <div class="html5-video-player" id="p" style="width:640px;height:360px"><video src="/vsg/short.webm" muted autoplay style="width:640px;height:360px"></video>
      <span class="ytp-time-duration" data-total></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));</script>`,
  "https://videos.example.org/watch/1": `
    <div id="player" style="width:640px;height:400px">
      <video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px;display:block"></video>
      <div class="controls"><span data-combined></span> <span data-left></span>
        <div role="slider" aria-label="Seek" style="height:6px;background:blue"></div></div>
    </div>
    <p>Article text mentioning 1:02:05 outside the player must stay.</p>
    <script>${PLAYER_JS}; wire(document.getElementById('player'));</script>`,
  "https://shadow.example.net/v": `
    <fancy-player></fancy-player><closed-player></closed-player>
    <script>${PLAYER_JS};
      const markup = '<div style="width:640px;height:390px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-total></span></div>';
      customElements.define('fancy-player', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); r.innerHTML = markup; wire(r); } });
      customElements.define('closed-player', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'closed' }); r.innerHTML = markup.replace('long.webm', 'long2.webm'); wire(r); window.closedRoot = r; } });
    </script>`,
};

const parseClock = (text) => text.trim().split(":").map(Number).reduce((a, n) => a * 60 + n, 0);

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
      results.push(["FAIL", name, err.message]);
    }
  };
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  const setStorage = (items) => optionsPage.evaluate((i) => chrome.storage.sync.set(i), items);
  const getStorage = () => optionsPage.evaluate(() => chrome.storage.sync.get(null));

  // 1. Built-in site: guarded silently, length grows by 2-6 hours.
  const yt = await context.newPage();
  await yt.goto("https://www.youtube.com/watch?v=abcDEF12345");
  await check("YouTube: duration label shows real length + 2-6 h", async () => {
    await yt.waitForFunction(() => document.querySelector(".ytp-time-duration").textContent.length > 0);
    await yt.waitForTimeout(300);
    const shown = parseClock(await yt.textContent(".ytp-time-duration"));
    assert.ok(shown >= 3725 + 7200 && shown <= 3725 + 21600, `shown ${shown}`);
  });
  await check("YouTube: no dialog on a listed site", async () => {
    assert.equal(await yt.locator("video-spoiler-guard-prompt").count(), 0);
  });
  const firstShown = await yt.textContent(".ytp-time-duration");
  await check("YouTube: same video keeps the same fake length after reload", async () => {
    await yt.reload();
    await yt.waitForFunction(() => document.querySelector(".ytp-time-duration").textContent.length > 0);
    await yt.waitForTimeout(300);
    assert.equal(await yt.textContent(".ytp-time-duration"), firstShown);
  });
  await check("YouTube: SPA navigation to another video re-guards with the new length", async () => {
    await yt.evaluate(() => window.navigateTo("zzzZZZ99999", "/vsg/long2.webm"));
    await yt.waitForFunction(() => document.querySelector("video").duration > 4000);
    await yt.waitForTimeout(400);
    const shown = parseClock(await yt.textContent(".ytp-time-duration"));
    assert.ok(shown >= 5000 + 7200 && shown <= 5000 + 21600, `shown ${shown}`);
  });
  await check("YouTube: hide progress bar option", async () => {
    await setStorage({ "builtin:youtube": { enabled: true, hideProgress: true } });
    await yt.waitForTimeout(400);
    assert.equal(await yt.evaluate(() => getComputedStyle(document.querySelector(".ytp-progress-bar-container")).opacity), "0");
  });
  await check("YouTube: switching the site off restores the real length", async () => {
    await setStorage({ "builtin:youtube": { enabled: false, hideProgress: true } });
    await yt.waitForTimeout(400);
    assert.equal(await yt.textContent(".ytp-time-duration"), "1:23:20");
    assert.equal(await yt.evaluate(() => getComputedStyle(document.querySelector(".ytp-progress-bar-container")).opacity), "1");
    await setStorage({ "builtin:youtube": { enabled: true, hideProgress: false } });
    await yt.waitForTimeout(400);
    assert.notEqual(await yt.textContent(".ytp-time-duration"), "1:23:20");
  });

  // 2. Short videos are left alone.
  const ytShort = await context.newPage();
  await ytShort.goto("https://www.youtube.com/watch?v=shortVID001");
  await check("Short video (20 s) is not changed", async () => {
    await ytShort.waitForFunction(() => document.querySelector(".ytp-time-duration").textContent.length > 0);
    await ytShort.waitForTimeout(400);
    assert.equal(await ytShort.textContent(".ytp-time-duration"), "0:20");
  });
  await ytShort.close();

  // 3. Unlisted site with auto-detect: guarded, dialog shown, Cancel restores.
  const generic = await context.newPage();
  await generic.goto("https://videos.example.org/watch/1");
  await check("Auto-detect: combined and remaining clocks rewritten, outside text untouched", async () => {
    await generic.waitForFunction(() => document.querySelector("[data-combined]").textContent.length > 0);
    await generic.waitForTimeout(400);
    const combined = await generic.textContent("[data-combined]");
    const total = parseClock(combined.split("/")[1]);
    assert.ok(total >= 3725 + 7200 && total <= 3725 + 21600, combined);
    const left = await generic.textContent("[data-left]");
    assert.ok(parseClock(left.slice(1)) > 7000, left);
    assert.match(await generic.textContent("p"), /1:02:05/);
    const valuetext = await generic.getAttribute("[role=slider]", "aria-valuetext");
    assert.ok(!/\b1:02:05\b/.test(valuetext), valuetext);
  });
  await check("Auto-detect: dialog appears when playback is detected", async () => {
    await generic.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 5000 });
  });
  await check("Auto-detect: Cancel in the dialog restores the real length", async () => {
    await generic.keyboard.press("Shift+Tab"); // from "Keep hidden" to "Cancel"
    await generic.keyboard.press("Enter");
    await generic.waitForSelector("video-spoiler-guard-prompt", { state: "detached", timeout: 3000 });
    await generic.waitForTimeout(300);
    const combined = await generic.textContent("[data-combined]");
    assert.match(combined, /\/ 1:02:05$/);
  });

  // 4. Dialog: Escape keeps it; "Remember" adds the site.
  await check("Auto-detect: Escape keeps the guard, Remember + Keep adds the site as on", async () => {
    await generic.reload();
    await generic.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 5000 });
    await generic.keyboard.press("Escape");
    await generic.waitForSelector("video-spoiler-guard-prompt", { state: "detached", timeout: 3000 });
    const combined = await generic.textContent("[data-combined]");
    assert.ok(!/\/ 1:02:05$/.test(combined), combined);

    await setStorage({ confirmSeconds: 0 });
    await generic.reload();
    await generic.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 5000 });
    await generic.keyboard.press("Shift+Tab");
    await generic.keyboard.press("Shift+Tab"); // the Remember checkbox
    await generic.keyboard.press("Space");
    await generic.keyboard.press("Tab");
    await generic.keyboard.press("Tab"); // Keep hidden
    await generic.keyboard.press("Enter");
    await generic.waitForTimeout(400);
    const stored = await getStorage();
    assert.equal(stored["site:videos.example.org"]?.enabled, true, JSON.stringify(stored));
  });
  await check("A remembered site is guarded without a dialog", async () => {
    await generic.reload();
    await generic.waitForFunction(() => document.querySelector("[data-combined]").textContent.length > 0);
    await generic.waitForTimeout(1500);
    assert.equal(await generic.locator("video-spoiler-guard-prompt").count(), 0);
    assert.ok(!/\/ 1:02:05$/.test(await generic.textContent("[data-combined]")));
  });
  await check("Turning auto-detect off leaves unlisted sites alone", async () => {
    await setStorage({ autoDetect: false, "site:videos.example.org": null });
    await optionsPage.evaluate(() => chrome.storage.sync.remove("site:videos.example.org"));
    await generic.reload();
    await generic.waitForFunction(() => document.querySelector("[data-combined]").textContent.length > 0);
    await generic.waitForTimeout(1200);
    assert.match(await generic.textContent("[data-combined]"), /\/ 1:02:05$/);
    assert.equal(await generic.locator("video-spoiler-guard-prompt").count(), 0);
    await setStorage({ autoDetect: true });
  });

  // 5. Players inside open and closed shadow roots.
  const shadow = await context.newPage();
  await shadow.goto("https://shadow.example.net/v");
  await check("Shadow DOM: open and closed shadow-root players are guarded", async () => {
    await shadow.waitForTimeout(2500);
    const open = await shadow.evaluate(() => document.querySelector("fancy-player").shadowRoot.querySelector("[data-total]").textContent);
    const closed = await shadow.evaluate(() => window.closedRoot.querySelector("[data-total]").textContent);
    assert.ok(parseClock(open) >= 3725 + 7200, `open: ${open}`);
    assert.ok(parseClock(closed) >= 5000 + 7200, `closed: ${closed}`);
  });

  // 6. Popup and options pages render and add sites.
  await check("Popup lists built-in sites and adds a site", async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector("#sites li");
    const names = await popup.locator("#sites .site-name").allTextContents();
    assert.ok(names.some((n) => n.startsWith("YouTube")) && names.some((n) => n.startsWith("Twitch")), names.join());
    await popup.fill("#add-domain", "https://www.Some-Video-Site.com/watch/9");
    await popup.click("#add-form button");
    await popup.waitForSelector('#sites li[data-key="site:some-video-site.com"]');
    await popup.fill("#add-domain", "nonsense");
    await popup.click("#add-form button");
    assert.match(await popup.textContent("#add-error"), /example\.com/);
    await popup.close();
  });
  await check("Options page toggles and removes an added site", async () => {
    await optionsPage.reload();
    const row = optionsPage.locator('#sites li[data-key="site:some-video-site.com"]');
    await row.locator(".switch").click();
    await optionsPage.waitForTimeout(200);
    assert.equal((await getStorage())["site:some-video-site.com"].enabled, false);
    await row.locator(".icon-btn").click();
    await optionsPage.waitForTimeout(200);
    assert.equal((await getStorage())["site:some-video-site.com"], undefined);
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
