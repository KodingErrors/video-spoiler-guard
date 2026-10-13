// Regression checks for problems found in review, one page per problem.
// Like e2e.cjs it loads the unpacked extension into Chromium and serves mock
// players for real-looking URLs. Needs Playwright and ffmpeg.
//
//   NODE_PATH="$(npm root -g)" node tests/e2e-regressions.cjs
"use strict";

const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const EXT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vsg-reg-"));

function makeVideo(name, seconds) {
  const file = path.join(TMP, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x335577:s=320x180:r=1", "-t", String(seconds), "-c:v", "libvpx", "-b:v", "20k", "-g", "60", file]);
  return fs.readFileSync(file);
}

// long = 1:02:05 (3725 s), long2 = 1:23:20 (5000 s), short = 0:20
const VIDEOS = { "long.webm": makeVideo("long.webm", 3725), "long2.webm": makeVideo("long2.webm", 5000), "short.webm": makeVideo("short.webm", 20) };
VIDEOS["long-1080.webm"] = VIDEOS["long.webm"];

const PLAYER_JS = `
  const fmt = (t) => { t = Math.floor(t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0'); };
  function wire(root, v) {
    v = v || root.querySelector('video');
    const sync = () => {
      if (!isFinite(v.duration)) return;
      root.querySelectorAll('[data-total]').forEach((n) => (n.textContent = fmt(v.duration)));
      root.querySelectorAll('[data-combined]').forEach((n) => (n.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration)));
      root.querySelectorAll('[data-elapsed-left]').forEach((n) => (n.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration - v.currentTime)));
    };
    ['loadedmetadata', 'durationchange', 'timeupdate'].forEach((e) => v.addEventListener(e, sync));
    return sync;
  }
  window.seen = [];
  // Hidden text counts as not shown.
  window.sample = (sel, ms) => { const t = setInterval(() => { const n = document.querySelector(sel); if (n) window.seen.push(getComputedStyle(n).visibility === 'hidden' ? '(hidden)' : n.textContent); }, 10); if (ms) setTimeout(() => clearInterval(t), ms); return t; };
  window.prompts = 0;
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeName === 'VIDEO-SPOILER-GUARD-PROMPT') window.prompts++; }))).observe(document.documentElement, { childList: true });
`;

const ytPage = (src, extra = "") => `
  <div id="movie_player" class="html5-video-player" style="width:640px;height:360px;position:relative">
    <video src="${src}" muted autoplay style="width:640px;height:360px"></video>
    <div class="ytp-chrome-bottom"><span class="ytp-time-duration" data-total></span></div>
  </div>
  <script>${PLAYER_JS}; wire(document.getElementById('movie_player')); ${extra}</script>`;

function bigPage() {
  // About 60 000 elements and 300 shadow roots, and no video at all.
  let rows = "";
  for (let i = 0; i < 6000; i++) rows += `<div class="r"><span>${i}</span><span>a</span><span>b</span><span>c</span><i>d</i><b>e</b><em>f</em><u>g</u><s>h</s></div>`;
  return `<div id="big">${rows}</div><script>
    customElements.define('x-card', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div><span>card</span></div>'; } });
    for (let i = 0; i < 300; i++) document.body.appendChild(document.createElement('x-card'));
    window.longTasks = [];
    setTimeout(() => new PerformanceObserver((l) => l.getEntries().forEach((e) => window.longTasks.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }), 1500);
  </script>`;
}

const PAGES = {
  "https://big.example.com/": bigPage(),
  // Prime Video's clock reads "elapsed / remaining".
  "https://www.amazon.com/gp/video/detail/B0TEST": `
    <div id="dv-web-player" style="width:640px;height:400px"><video src="/vsg/long.webm" muted style="width:640px;height:360px"></video>
      <div class="atvwebplayersdk-timeindicator-text" data-elapsed-left></div></div>
    <script>${PLAYER_JS}; wire(document.getElementById('dv-web-player'));
      const v = document.querySelector('video'); v.addEventListener('loadedmetadata', () => { v.currentTime = 1856; v.play(); }, { once: true });</script>`,
  // Video.js with a hidden IMA ad video inside the player.
  "https://ima.example.com/v": `
    <div class="video-js" style="width:640px;height:400px"><video id="main" src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video>
      <div id="ima-ad-container" style="display:none"><video src="/vsg/short.webm" muted></video></div>
      <div class="vjs-control-bar"><span data-combined></span></div></div>
    <script>${PLAYER_JS}; wire(document.querySelector('.video-js'), document.getElementById('main'));</script>`,
  // A portrait video centred in a 16:9 box.
  "https://portrait.example.com/v": `
    <div id="box" style="width:640px;height:400px;background:#000;display:flex;flex-direction:column;align-items:center">
      <video src="/vsg/long.webm" muted autoplay style="width:202px;height:360px"></video><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('box'));</script>`,
  // A live DVR stream: MediaSource whose length grows every second.
  "https://live.example.tv/dvr": `
    <div id="p" style="width:640px;height:400px"><video muted autoplay style="width:640px;height:360px"></video><span data-total></span></div>
    <script>${PLAYER_JS}; const v = document.querySelector('video'); wire(document.getElementById('p'));
      const ms = new MediaSource(); v.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', async () => {
        const sb = ms.addSourceBuffer('video/webm; codecs="vp8"');
        sb.appendBuffer(await (await fetch('/vsg/long.webm')).arrayBuffer());
        sb.addEventListener('updateend', () => { window.grow = setInterval(() => { if (!sb.updating) ms.duration = ms.duration + 4; }, 1000); }, { once: true });
      });</script>`,
  "https://www.youtube.com/watch?v=adtestVID01": ytPage("/vsg/long.webm", `
    window.startAd = () => { document.getElementById('movie_player').classList.add('ad-showing'); sample('.ytp-time-duration', 600); setTimeout(() => { document.querySelector('.ytp-time-duration').textContent = '0:30'; }, 400); };`),
  "https://www.youtube.com/watch?v=spaVIDEO001": ytPage("/vsg/long.webm", `
    window.lateNav = () => { const v = document.querySelector('video'); sample('.ytp-time-duration', 2000);
      v.addEventListener('loadedmetadata', () => setTimeout(() => history.pushState({}, '', '/watch?v=spaVIDEO002'), 50), { once: true });
      v.src = '/vsg/long2.webm'; };
    window.knownLengthNav = () => { const v = document.querySelector('video'); sample('.ytp-time-duration', 2500);
      history.pushState({}, '', '/watch?v=spaVIDEO003'); v.src = '/vsg/long2.webm?slow=1';
      document.querySelector('.ytp-time-duration').textContent = '1:23:20'; };`),
  "https://plyr.example.com/movie/7": `
    <div id="p" style="width:640px;height:400px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));
      window.switchQuality = () => { const v = document.querySelector('video'); const t = v.currentTime; v.src = '/vsg/long-1080.webm'; v.currentTime = t; v.play(); };</script>`,
  "https://keys.example.org/v": `
    <div id="p" style="width:640px;height:400px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));
      document.addEventListener('keydown', (e) => { if (e.key === ' ') { const v = document.querySelector('video'); v.paused ? v.play() : v.pause(); e.preventDefault(); } });</script>`,
  "https://swap.example.com/v": `
    <div id="p" style="width:640px;height:400px"><div id="slot"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video></div><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));
      window.detach = () => { const v = document.querySelector('video'); v.remove(); sample('[data-combined]', 2500); setTimeout(() => document.getElementById('slot').appendChild(v), 2000); };
      window.shrink = () => { const v = document.querySelector('video'); v.style.width = '192px'; v.style.height = '108px'; };</script>`,
  "https://twoep.example.net/v": `
    <div id="a" style="width:640px;height:400px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-combined></span></div>
    <div style="height:300px"></div><p id="la">Episode 1: <span class="dur" data-total-a></span></p>
    <div id="b" style="width:640px;height:400px"><video src="/vsg/long2.webm" muted autoplay style="width:640px;height:360px"></video><span data-combined></span></div>
    <div style="height:300px"></div><p id="lb">Episode 2: <span class="dur" data-total-b></span></p>
    <script>${PLAYER_JS}; wire(document.getElementById('a')); wire(document.getElementById('b'));
      const [va, vb] = document.querySelectorAll('video');
      va.addEventListener('loadedmetadata', () => (document.querySelector('[data-total-a]').textContent = fmt(va.duration)));
      vb.addEventListener('loadedmetadata', () => (document.querySelector('[data-total-b]').textContent = fmt(vb.duration)));</script>`,
  "https://blog.example.com/typing": `
    <input id="q" style="width:300px"><iframe id="f" src="https://player.example.net/embed/late" style="width:700px;height:420px;border:0"></iframe>`,
  "https://player.example.net/embed/late": `
    <div id="p" style="width:640px;height:400px"><video src="/vsg/long.webm" muted style="width:640px;height:360px"></video><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p')); setTimeout(() => document.querySelector('video').play(), 1500);</script>`,
  "http://jellyfin/web/": `
    <div id="p" style="width:640px;height:400px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video><span data-combined></span></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));</script>`,
  "https://hideprog.example.org/v": `
    <div id="p" style="width:640px;height:400px"><video src="/vsg/long.webm" muted autoplay style="width:640px;height:360px"></video>
      <span data-combined></span><div role="slider" aria-label="Seek" style="height:6px;background:blue"></div></div>
    <script>${PLAYER_JS}; wire(document.getElementById('p'));</script>`,
  "https://blog2.example.com/two": `
    <iframe id="e1" src="https://www.youtube.com/embed/aaaaaaaaaaa" style="width:700px;height:420px;border:0"></iframe>
    <iframe id="e2" src="https://www.youtube.com/embed/bbbbbbbbbbb" style="width:700px;height:420px;border:0"></iframe>`,
  "https://www.youtube.com/embed/aaaaaaaaaaa": ytPage("/vsg/long.webm"),
  "https://blog3.example.com/embed": `
    <iframe id="yt" src="https://www.youtube.com/embed/ccccccccccc" style="width:700px;height:420px;border:0"></iframe>`,
  "https://www.youtube.com/embed/ccccccccccc": ytPage("/vsg/long.webm"),
  "https://www.youtube.com/embed/bbbbbbbbbbb": ytPage("/vsg/long2.webm"),
};

const parseClock = (text) => String(text).trim().replace(/^[-\u2212]/, "").split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
const totalOf = (combined) => parseClock(String(combined).split("/").pop());
const isFake = (text, real) => {
  const shown = parseClock(text);
  return shown >= real + 7200 && shown <= real + 21600;
};
const fmt = (t) => {
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
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
    if (file) {
      if (url.searchParams.get("slow")) await new Promise((r) => setTimeout(r, 1200));
      // Byte ranges, so the player can seek.
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] || "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
        return route.fulfill({ status: 206, contentType: "video/webm", body: file.subarray(start, end + 1), headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${file.length}` } });
      }
      return route.fulfill({ status: 200, contentType: "video/webm", body: file, headers: { "accept-ranges": "bytes" } });
    }
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
  const ready = (page, sel) => page.waitForFunction((s) => (document.querySelector(s) || {}).textContent, sel, { timeout: 10000 });
  const open = async (url) => {
    const page = await context.newPage();
    await page.goto(url);
    return page;
  };
  // Most checks don't need the dialog.
  await setStorage({ "builtin:youtube": { enabled: true, ask: false }, "builtin:primevideo": { enabled: true, ask: false } });

  await check("A huge page with no video gets no long tasks from the extension", async () => {
    const page = await open("https://big.example.com/");
    await page.waitForTimeout(9000);
    const tasks = await page.evaluate(() => window.longTasks);
    assert.ok(Math.max(0, ...tasks) < 50, `long tasks: ${tasks.join(", ")}`);
    await page.close();
  });

  await check("Prime Video: the elapsed clock never jumps at the halfway point", async () => {
    const page = await open("https://www.amazon.com/gp/video/detail/B0TEST");
    await page.waitForFunction(() => document.querySelector("video").currentTime > 1856, null, { timeout: 10000 });
    await page.evaluate(() => sample(".atvwebplayersdk-timeindicator-text"));
    await page.waitForTimeout(11000); // crosses 1862.5 s, the midpoint of 3725 s
    const seen = await page.evaluate(() => window.seen);
    const elapsed = seen.map((t) => parseInt(t.split("/")[0], 10));
    assert.ok(seen.length > 100, `samples ${seen.length}`);
    assert.ok(seen.every((t) => !/^\d+:\d\d:\d\d \//.test(t)), `elapsed jumped: ${[...new Set(seen.filter((t) => /^\d+:\d\d:\d\d \//.test(t)))].join(", ")}`);
    assert.ok(seen.every((t) => isFake(t.split("/")[1], 1862)), `time left not guarded: ${[...new Set(seen)].slice(0, 5)}`);
    assert.ok(elapsed.every((m) => m === 30 || m === 31), "elapsed reads 30:xx or 31:xx");
    await page.close();
  });

  await check("A player with a hidden ad video inside is still guarded", async () => {
    const page = await open("https://ima.example.com/v");
    await ready(page, "[data-combined]");
    await page.waitForTimeout(800);
    assert.ok(isFake(totalOf(await page.textContent("[data-combined]")) ? (await page.textContent("[data-combined]")).split("/")[1] : "", 3725), await page.textContent("[data-combined]"));
    await page.close();
  });

  await check("A portrait video in a 16:9 box is guarded", async () => {
    const page = await open("https://portrait.example.com/v");
    await ready(page, "[data-combined]");
    await page.waitForTimeout(800);
    assert.ok(isFake((await page.textContent("[data-combined]")).split("/")[1], 3725), await page.textContent("[data-combined]"));
    await page.close();
  });

  await check("A live stream whose length grows keeps one offset and asks once", async () => {
    const page = await open("https://live.example.tv/dvr");
    await page.waitForFunction(() => window.grow, null, { timeout: 10000 });
    const offsets = new Set();
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      const [label, duration] = await page.evaluate(() => [document.querySelector("[data-total]").textContent, document.querySelector("video").duration]);
      if (label) offsets.add(Math.round((parseClock(label) - Math.floor(duration)) / 5));
    }
    assert.ok(offsets.size <= 2, `offset moved: ${[...offsets].join(", ")}`);
    assert.ok((await page.evaluate(() => window.prompts)) <= 1, `dialogs: ${await page.evaluate(() => window.prompts)}`);
    await page.close();
  });

  await check("An ad starting mid-video never shows the real length", async () => {
    const page = await open("https://www.youtube.com/watch?v=adtestVID01");
    await ready(page, ".ytp-time-duration");
    await page.waitForTimeout(600);
    await page.evaluate(() => window.startAd());
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => window.seen);
    assert.ok(!seen.includes("1:02:05"), `real length shown: ${[...new Set(seen)].join(", ")}`);
    await page.close();
  });

  await check("SPA navigation with a late address change never reuses the old offset", async () => {
    const page = await open("https://www.youtube.com/watch?v=spaVIDEO001");
    await ready(page, ".ytp-time-duration");
    await page.waitForTimeout(500);
    const oldOffset = parseClock(await page.textContent(".ytp-time-duration")) - 3725;
    await page.evaluate(() => window.lateNav());
    await page.waitForTimeout(2200);
    const seen = await page.evaluate(() => window.seen);
    assert.ok(!seen.includes(fmt(5000 + oldOffset)), `old offset reused: ${[...new Set(seen)].join(", ")}`);
    assert.ok(!seen.includes("1:23:20"), "real length shown");
    await page.close();
  });

  await check("A player that prints the next length before it loads never shows it", async () => {
    const page = await open("https://www.youtube.com/watch?v=spaVIDEO001");
    await ready(page, ".ytp-time-duration");
    await page.waitForTimeout(500);
    await page.evaluate(() => window.knownLengthNav());
    await page.waitForTimeout(2700);
    const seen = await page.evaluate(() => window.seen);
    assert.ok(!seen.includes("1:23:20"), `real length shown: ${[...new Set(seen)].join(", ")}`);
    assert.ok(isFake(await page.textContent(".ytp-time-duration"), 5000), await page.textContent(".ytp-time-duration"));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".ytp-time-duration")).visibility), "visible");
    await page.close();
  });

  await check("Switching quality keeps the same fake length and asks no second time", async () => {
    const page = await open("https://plyr.example.com/movie/7");
    await page.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 6000 });
    await page.keyboard.press("Escape");
    const before = (await page.textContent("[data-combined]")).split("/")[1].trim();
    await page.evaluate(() => window.switchQuality());
    await page.waitForTimeout(1500);
    const after = (await page.textContent("[data-combined]")).split("/")[1].trim();
    assert.equal(after, before);
    assert.equal(await page.evaluate(() => window.prompts), 1);
    await page.close();
  });

  await check("Keys pressed in the dialog don't reach the page's shortcuts", async () => {
    const page = await open("https://keys.example.org/v");
    await page.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 6000 });
    await page.keyboard.press("Tab"); // "for this session"
    await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => document.querySelector("video").paused), false, "Space paused the video");
    await page.keyboard.press("Escape");
    await page.close();
  });

  await check("Taking the <video> out for a moment doesn't show the real length", async () => {
    await setStorage({ "site:swap.example.com": { enabled: true, ask: false } });
    const page = await open("https://swap.example.com/v");
    await ready(page, "[data-combined]");
    await page.waitForTimeout(600);
    await page.evaluate(() => window.detach());
    await page.waitForTimeout(2800);
    const seen = await page.evaluate(() => window.seen);
    assert.ok(seen.every((t) => !t.endsWith("/ 1:02:05")), `real length shown: ${[...new Set(seen)].slice(0, 4)}`);
    await page.evaluate(() => window.shrink());
    await page.waitForTimeout(1500);
    assert.ok(isFake((await page.textContent("[data-combined]")).split("/")[1], 3725), "a shrunken video stays guarded");
    await removeStorage("site:swap.example.com");
    await page.close();
  });

  await check("Two players on one page each keep their own outside label", async () => {
    await setStorage({ "site:twoep.example.net": { enabled: true, ask: false, durationSelector: ".dur" } });
    const page = await open("https://twoep.example.net/v");
    await page.waitForTimeout(3500);
    const [a, b, la, lb] = await page.evaluate(() => [
      document.querySelector("#a [data-combined]").textContent,
      document.querySelector("#b [data-combined]").textContent,
      document.querySelector("[data-total-a]").textContent,
      document.querySelector("[data-total-b]").textContent,
    ]);
    assert.equal(parseClock(la) - 3725, totalOf(a) - 3725, `A: ${la} vs ${a}`);
    assert.equal(parseClock(lb) - 5000, totalOf(b) - 5000, `B: ${lb} vs ${b}`);
    await removeStorage("site:twoep.example.net");
    await page.close();
  });

  await check("A dialog in an embed doesn't take keystrokes from the page", async () => {
    const page = await open("https://blog.example.com/typing");
    await page.focus("#q");
    for (let i = 0; i < 30; i++) {
      await page.keyboard.type("a");
      await page.waitForTimeout(100);
    }
    assert.equal(await page.inputValue("#q"), "a".repeat(30));
    assert.equal(await page.evaluate(() => document.activeElement.id), "q");
    await page.close();
  });

  await check("Remember works on a single-word host such as jellyfin", async () => {
    const page = await open("http://jellyfin/web/");
    await page.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 6000 });
    for (const key of ["Tab", "Tab", "Space", "Tab", "Enter"]) await page.keyboard.press(key); // "for this website", then Cancel
    await page.waitForTimeout(400);
    assert.equal((await getStorage())["site:jellyfin"]?.enabled, false);
    await removeStorage("site:jellyfin");
    await page.close();
  });

  await check("Remember + Keep keeps the progress bar hidden", async () => {
    await setStorage({ autoHideProgress: true });
    const page = await open("https://hideprog.example.org/v");
    await page.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 6000 });
    for (const key of ["Tab", "Tab", "Space", "Tab", "Tab", "Enter"]) await page.keyboard.press(key); // "for this website", then Keep hidden
    await page.waitForTimeout(600);
    assert.equal((await getStorage())["site:hideprog.example.org"]?.hideProgress, true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("[role=slider]")).opacity), "0");
    await setStorage({ autoHideProgress: false });
    await removeStorage("site:hideprog.example.org");
    await page.close();
  });

  await check("The badge stays ON when the service worker restarts", async () => {
    const page = await open("https://blog2.example.com/two");
    await page.waitForTimeout(2500);
    const badge = () => optionsPage.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: "https://blog2.example.com/*" });
      return chrome.action.getBadgeText({ tabId: tab.id });
    });
    assert.equal(await badge(), "ON");
    const cdp = await context.newCDPSession(optionsPage);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await page.frameLocator("#e1").locator("video").evaluate((v) => v.remove());
    await page.waitForTimeout(7000); // past the detach grace period
    assert.equal(await badge(), "ON");
    await page.close();
  });

  await check("Dashboard: adding a subdomain of a built-in site says it's covered", async () => {
    await optionsPage.reload();
    await optionsPage.fill("#add-domain", "https://m.youtube.com/watch?v=abcDEF12345");
    await optionsPage.click("#add-form button[type=submit]");
    await optionsPage.waitForTimeout(300);
    assert.match(await optionsPage.textContent("#add-error"), /YouTube already covers m\.youtube\.com/);
    assert.equal((await getStorage())["site:m.youtube.com"], undefined);
  });

  await check("Popup: a subdomain entry is named as what applies, and switches on", async () => {
    await setStorage({ "site:gaming.youtube.com": { enabled: false } });
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      chrome.tabs.query = async () => [{ url: "https://gaming.youtube.com/watch?v=x" }];
    });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(400);
    assert.equal(await popup.textContent("#here-host"), "gaming.youtube.com");
    assert.equal(await popup.isChecked("#here-toggle"), false);
    await popup.click("#here-toggle");
    await popup.waitForTimeout(300);
    assert.equal((await getStorage())["site:gaming.youtube.com"]?.enabled, true);
    await removeStorage("site:gaming.youtube.com");
    await popup.close();
  });

  await check("Options: sites whose names differ only in punctuation get separate controls", async () => {
    await setStorage({ "site:my-site.com": { enabled: true }, "site:my.site.com": { enabled: true } });
    await optionsPage.reload();
    await optionsPage.locator('#sites li[data-key="site:my.site.com"] .site-name').click();
    await optionsPage.waitForTimeout(300);
    const stored = await getStorage();
    assert.equal(stored["site:my.site.com"].enabled, false);
    assert.equal(stored["site:my-site.com"].enabled, true);
    await removeStorage(["site:my-site.com", "site:my.site.com"]);
  });

  await check("Options: a half-typed selector survives an unrelated settings change", async () => {
    await setStorage({ "site:typing.example.net": { enabled: true } });
    await optionsPage.reload();
    const row = optionsPage.locator('#sites li[data-key="site:typing.example.net"]');
    await row.locator("summary").click();
    const field = row.locator('input[id^="durationSelector-"]');
    await field.click();
    await optionsPage.keyboard.type(".player .time-to");
    await setStorage({ "builtin:twitch": { enabled: true, ask: true } });
    await optionsPage.waitForTimeout(300);
    await optionsPage.keyboard.type("tal");
    assert.equal(await optionsPage.locator('#sites li[data-key="site:typing.example.net"] input[id^="durationSelector-"]').inputValue(), ".player .time-total");
    assert.equal((await getStorage())["site:typing.example.net"].durationSelector, undefined, "nothing saved mid-typing");
    await removeStorage("site:typing.example.net");
  });

  const getSession = () => optionsPage.evaluate(() => chrome.storage.session.get(null));
  const clearSession = () => optionsPage.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith("session:")));
  });
  const popupFor = async (url) => {
    const popup = await context.newPage();
    await popup.addInitScript((u) => {
      chrome.tabs.query = async () => [{ url: u }];
    }, url);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(400);
    return popup;
  };

  await check("In an embed, both 'Don't show this again' options apply to the embed's site", async () => {
    await setStorage({ "builtin:youtube": { enabled: true, ask: true }, confirmSeconds: 0 });
    const page = await open("https://blog3.example.com/embed");
    const frame = page.frame({ url: /youtube\.com\/embed/ });
    await frame.waitForSelector("video-spoiler-guard-prompt", { state: "attached", timeout: 8000 });
    await page.focus("#yt");
    for (const key of ["Tab", "Space", "Tab", "Tab", "Enter"]) await page.keyboard.press(key); // "for this session", then Cancel
    await page.waitForTimeout(500);
    const session = await getSession();
    assert.equal(session["session:youtube.com"]?.guard, false, JSON.stringify(session));
    assert.equal(session["session:blog3.example.com"], undefined, "not split onto the page around the embed");
    await clearSession();
    await setStorage({ "builtin:youtube": { enabled: true, ask: false }, confirmSeconds: 10 });
    await page.close();
  });

  await check("Popup: a session choice that isn't in effect says so", async () => {
    await optionsPage.evaluate(() => chrome.storage.session.set({ "session:youtube.com": { guard: true, at: 1 } }));
    await setStorage({ "builtin:youtube": { enabled: false, ask: false } });
    const popup = await popupFor("https://www.youtube.com/watch?v=abcDEF12345");
    assert.match(await popup.textContent("#here-session-text"), /isn't in effect/);
    assert.equal(await popup.textContent("#here-pill"), "Off");
    await popup.close();
    // Switching the site on from the dashboard replaces the session choice.
    await optionsPage.reload();
    await optionsPage.click("#site-builtin_3ayoutube");
    await optionsPage.waitForTimeout(500);
    assert.equal((await getStorage())["builtin:youtube"]?.enabled, true);
    assert.equal((await getSession())["session:youtube.com"], undefined);
    await setStorage({ "builtin:youtube": { enabled: true, ask: false } });
  });

  await check("Popup: the Chrome Web Store is shown as a page that can't be guarded", async () => {
    const popup = await popupFor("https://chromewebstore.google.com/detail/some-extension/abcdef");
    assert.equal(await popup.isVisible("#here-unsupported"), true);
    assert.equal(await popup.isVisible("#here"), false);
    await popup.close();
  });

  await check("Popup: changing an auto-detected site keeps its progress-bar hiding", async () => {
    await setStorage({ autoHideProgress: true });
    const popup = await popupFor("https://autosite.example.org/watch/1");
    await popup.click("#here-ask");
    await popup.waitForTimeout(400);
    const stored = (await getStorage())["site:autosite.example.org"];
    assert.equal(stored?.ask, false);
    assert.equal(stored?.hideProgress, true);
    await removeStorage("site:autosite.example.org");
    await setStorage({ autoHideProgress: false });
    await popup.close();
  });

  await check("Options: a rejected number of hours is reset in the field", async () => {
    await optionsPage.reload();
    await optionsPage.fill("#max-hours", "100");
    await optionsPage.press("#max-hours", "Enter");
    await optionsPage.waitForTimeout(900);
    assert.equal(await optionsPage.inputValue("#max-hours"), "6");
    assert.match(await optionsPage.textContent("#time-error"), /0 to 48/);
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
