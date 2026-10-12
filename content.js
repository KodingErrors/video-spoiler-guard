// Runs in every frame of every page (see manifest.json). It stays idle unless
// the page's site is switched on, or auto-detect is on and the site is not
// listed. While guarding a video it rewrites every clock in the player that
// shows the real total length (or time remaining) so it includes a fake
// 2-6 hours, and puts the real text back when the guard is turned off.
(function () {
  "use strict";

  // The isolated world is per extension, so this survives a second injection.
  if (globalThis.__videoSpoilerGuard) return;
  globalThis.__videoSpoilerGuard = true;

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const chromeApi = globalThis.chrome;

  const ATTRS = ["aria-valuetext", "aria-label", "title", "data-tooltip", "data-title"];
  const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "playing", "play", "emptied", "loadstart"];
  const MIN_AUTO_SIZE = { width: 200, height: 112 }; // smaller videos are previews or ads
  const TICK_MS = 1000;
  const DEEP_SCAN_EVERY = 4; // ticks

  let settings = null;
  let salt = "";
  let decision = { mode: "none", site: null };
  let lastHref = location.href;
  let tickTimer = 0;
  let tickCount = 0;

  /** @type {Map<HTMLVideoElement, object>} */
  const records = new Map();
  const cancelledKeys = new Set(); // "Cancel" in the dialog, for this page visit
  const askedKeys = new Set();     // the dialog has been shown for this video

  // ---- Shadow-DOM-aware tree helpers --------------------------------------

  // chrome.dom.openOrClosedShadowRoot reaches closed roots too; it exists in
  // content scripts only.
  function shadowOf(el) {
    try {
      return chromeApi.dom && chromeApi.dom.openOrClosedShadowRoot ? chromeApi.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
    } catch {
      return el.shadowRoot || null;
    }
  }

  function parentDeep(node) {
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.host ? parent.host : null;
  }

  function closestDeep(el, selector) {
    let node = el;
    while (node) {
      let found = null;
      try {
        found = node.closest(selector);
      } catch {
        return null;
      }
      if (found) return found;
      const rootNode = node.getRootNode();
      node = rootNode && rootNode.host ? rootNode.host : null;
    }
    return null;
  }

  function containsDeep(ancestor, node) {
    while (node) {
      if (node === ancestor) return true;
      node = node.parentNode || (node.host ? node.host : null);
    }
    return false;
  }

  // Visits every element under root (inclusive), descending into shadow roots.
  function walkElements(root, visit, shadowRoots) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) {
        visit(node);
        const shadow = shadowOf(node);
        if (shadow) {
          if (shadowRoots) shadowRoots.push(shadow);
          stack.push(shadow);
        }
      }
      for (let child = node.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
    }
  }

  function walkTextNodes(root, visit) {
    const scan = (base) => {
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) visit(n);
    };
    if (root.nodeType === Node.TEXT_NODE) return visit(root);
    scan(root);
    const shadows = [];
    walkElements(root, () => {}, shadows);
    shadows.forEach(scan);
  }

  function queryAllDeep(root, selector) {
    const out = [];
    if (!selector) return out;
    const roots = [root];
    walkElements(root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root, () => {}, roots);
    for (const r of roots) {
      try {
        if (r.nodeType === Node.ELEMENT_NODE && r.matches(selector)) out.push(r);
        r.querySelectorAll(selector).forEach((el) => out.push(el));
      } catch {
        return [];
      }
    }
    return [...new Set(out)];
  }

  function findVideosDeep() {
    const found = new Set(document.querySelectorAll("video"));
    const hosts = document.querySelectorAll("*");
    for (const el of hosts) {
      if (!el.tagName.includes("-") && !el.shadowRoot) continue;
      const shadow = shadowOf(el);
      if (!shadow) continue;
      walkElements(shadow.host, (node) => {
        if (node.tagName === "VIDEO") found.add(node);
      });
    }
    return found;
  }

  // ---- Settings ------------------------------------------------------------

  async function loadState() {
    const [loaded, s] = await Promise.all([Store.loadSettings(), Store.getSalt()]);
    settings = loaded;
    salt = s;
    decision = VSG.decide(settings, location.hostname);
  }

  function active() {
    return decision.mode === "on" || decision.mode === "auto";
  }

  // ---- Per-video records --------------------------------------------------

  function track(video) {
    if (!(video instanceof HTMLVideoElement)) return null;
    let record = records.get(video);
    if (record) return record;
    record = {
      video,
      key: "",
      offset: 0,
      status: "idle",
      container: null,
      texts: new Map(),     // Text -> { original, fake }
      attrs: new Map(),     // Element -> Map(attr -> { original, fake })
      hidden: new Map(),    // Element -> { value, priority }
      outside: [],          // duration labels outside the container
    };
    records.set(video, record);
    for (const type of MEDIA_EVENTS) video.addEventListener(type, onMediaEvent, true);
    return record;
  }

  function untrack(record) {
    restore(record);
    for (const type of MEDIA_EVENTS) record.video.removeEventListener(type, onMediaEvent, true);
    records.delete(record.video);
  }

  function videoIndex(video) {
    const all = [...document.querySelectorAll("video")];
    const i = all.indexOf(video);
    return i < 0 ? 0 : i;
  }

  // Ads either mark the player (YouTube's .ad-showing) or render a marker
  // inside it (Twitch's ad label), so check ancestors and descendants.
  function inAd(record, container) {
    const selector = decision.site && decision.site.adSelector;
    if (!selector) return false;
    if ([record.video, container].some((el) => el && closestDeep(el, selector))) return true;
    return !!container && queryAllDeep(container, selector).length > 0;
  }

  function bigEnough(video) {
    const rect = video.getBoundingClientRect();
    if (document.fullscreenElement && containsDeep(document.fullscreenElement, video)) return true;
    return rect.width >= MIN_AUTO_SIZE.width && rect.height >= MIN_AUTO_SIZE.height;
  }

  function eligible(record, container) {
    const d = record.video.duration;
    if (!Number.isFinite(d) || d <= 0) return false; // live streams have no end to spoil
    if (d < settings.minVideoMinutes * 60) return false;
    if (inAd(record, container)) return false;
    if (decision.mode === "auto" && !bigEnough(record.video)) return false;
    return true;
  }

  // The element that holds the player's controls: the site's player element
  // when we know it, otherwise the largest ancestor that is still roughly the
  // video's size (controls overlay the video or sit just under it).
  function findContainer(video) {
    const site = decision.site;
    if (site && site.playerSelector) {
      const player = closestDeep(video, site.playerSelector);
      if (player) return player;
    }
    const vr = video.getBoundingClientRect();
    let best = parentDeep(video) || video;
    let node = best;
    for (let depth = 0; node && depth < 12; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const r = node.getBoundingClientRect();
      if (vr.width > 0) {
        if (r.width > vr.width * 1.25 + 40 || r.height > vr.height * 1.25 + 160) break;
      } else if (depth >= 4) {
        break;
      }
      best = node;
      node = parentDeep(node);
    }
    return best;
  }

  function keyFor(record) {
    const site = decision.site;
    return VSG.videoKey(site && site.builtIn ? site.id : "", location, videoIndex(record.video));
  }

  // Decides whether this video should be guarded right now and brings the
  // page in line with that.
  function evaluate(record) {
    const video = record.video;
    if (!video.isConnected) {
      untrack(record);
      return;
    }
    if (!active()) {
      setStatus(record, "idle");
      return;
    }

    const key = keyFor(record);
    if (key !== record.key) {
      restore(record);
      record.key = key;
      record.status = "idle";
    }
    const container = findContainer(video);
    if (!eligible(record, container)) {
      setStatus(record, "idle");
      return;
    }
    if (cancelledKeys.has(key)) {
      setStatus(record, "cancelled");
      return;
    }

    const offset = VSG.offsetSeconds(key, salt, settings.minHours, settings.maxHours);
    if (record.status === "applied" && (offset !== record.offset || container !== record.container)) restore(record);
    record.offset = offset;
    record.container = container;
    record.status = "applied";
    rewriteRecord(record);
    hideProgress(record);
    rebuildObserver();
    maybeAsk(record);
    reportStatus();
  }

  function setStatus(record, status) {
    if (record.status === "applied") {
      restore(record);
      rebuildObserver();
    }
    record.status = status;
    reportStatus();
  }

  function evaluateAll() {
    for (const record of [...records.values()]) evaluate(record);
  }

  // ---- Rewriting ----------------------------------------------------------

  function clockContext(record) {
    return {
      duration: record.video.duration,
      offset: record.offset,
      currentTime: record.video.currentTime,
      remainingUnsigned: !!(decision.site && decision.site.remainingUnsigned),
    };
  }

  function rewriteText(record, node, ctx) {
    const current = node.nodeValue;
    const entry = record.texts.get(node);
    if (entry && current === entry.fake) return;
    const next = VSG.rewriteClockText(current, ctx);
    if (next === null) {
      if (entry) record.texts.delete(node);
      return;
    }
    record.texts.set(node, { original: current, fake: next });
    node.nodeValue = next;
  }

  function rewriteAttr(record, el, name, ctx) {
    const current = el.getAttribute(name);
    if (current === null) return;
    let map = record.attrs.get(el);
    const entry = map && map.get(name);
    if (entry && current === entry.fake) return;
    const next = VSG.rewriteClockText(current, ctx);
    if (next === null) {
      if (entry) map.delete(name);
      return;
    }
    if (!map) record.attrs.set(el, (map = new Map()));
    map.set(name, { original: current, fake: next });
    el.setAttribute(name, next);
  }

  function rewriteSubtree(record, root, ctx) {
    if (root.nodeType === Node.TEXT_NODE) {
      rewriteText(record, root, ctx);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    walkTextNodes(root, (n) => rewriteText(record, n, ctx));
    walkElements(root, (el) => {
      for (const name of ATTRS) if (el.hasAttribute(name)) rewriteAttr(record, el, name, ctx);
    });
  }

  // The site's own duration label: its last clock is the total length even
  // when it disagrees with <video>.duration, so add the offset to that clock.
  function rewriteLabel(record, label) {
    const nodes = [];
    walkTextNodes(label, (n) => {
      if (VSG.hasClock(n.nodeValue)) nodes.push(n);
    });
    const node = nodes[nodes.length - 1];
    if (!node) return;
    const current = node.nodeValue;
    const entry = record.texts.get(node);
    if (entry && current === entry.fake) return;
    const next = VSG.rewriteLastClock(current, record.offset);
    if (next === null || next === current) return;
    record.texts.set(node, { original: current, fake: next });
    node.nodeValue = next;
  }

  function labelsOf(record) {
    const site = decision.site;
    if (!site || !site.durationSelector || !record.container) return [];
    return queryAllDeep(record.container, site.durationSelector).concat(record.outside);
  }

  function labelContaining(record, node) {
    const site = decision.site;
    if (!site || !site.durationSelector) return null;
    const start = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || (node.parentNode && node.parentNode.host);
    if (!start) return null;
    const label = closestDeep(start, site.durationSelector);
    return label && (containsDeep(record.container, label) || record.outside.includes(label)) ? label : null;
  }

  // Labels matched by the site's duration selector that live outside the
  // player container (only trusted when this is the page's only guarded video).
  function outsideLabels(record) {
    const site = decision.site;
    if (!site || !site.durationSelector) return [];
    const inside = queryAllDeep(record.container, site.durationSelector);
    if (inside.length) return [];
    const guarded = [...records.values()].filter((r) => r.status === "applied");
    if (guarded.length !== 1 || guarded[0] !== record) return [];
    return queryAllDeep(document, site.durationSelector);
  }

  function rewriteRecord(record) {
    if (record.status !== "applied" || !record.container) return;
    const ctx = clockContext(record);
    rewriteSubtree(record, record.container, ctx);
    record.outside = outsideLabels(record);
    for (const label of record.outside) rewriteSubtree(record, label, ctx);
    for (const label of labelsOf(record)) rewriteLabel(record, label);
  }

  function restore(record) {
    for (const [node, entry] of record.texts) if (node.nodeValue === entry.fake) node.nodeValue = entry.original;
    record.texts.clear();
    for (const [el, map] of record.attrs) {
      for (const [name, entry] of map) if (el.getAttribute(name) === entry.fake) el.setAttribute(name, entry.original);
    }
    record.attrs.clear();
    for (const [el, prev] of record.hidden) {
      if (prev.value) el.style.setProperty("opacity", prev.value, prev.priority);
      else el.style.removeProperty("opacity");
    }
    record.hidden.clear();
    record.outside = [];
  }

  // ---- Progress bar --------------------------------------------------------

  function looksLikeSeekBar(el, duration) {
    const role = el.getAttribute("role");
    const isRange = el.tagName === "INPUT" && el.type === "range";
    if (!isRange && el.tagName !== "PROGRESS" && role !== "slider" && role !== "progressbar") return false;
    const max = Number(isRange || el.tagName === "PROGRESS" ? el.max : el.getAttribute("aria-valuemax"));
    if (Number.isFinite(max) && Math.abs(max - duration) <= 2) return true;
    if (VSG.mentionsDuration(el.getAttribute("aria-valuetext") || "", duration)) return true;
    const label = `${el.getAttribute("aria-label") || ""} ${el.className || ""}`;
    return /seek|progress|scrub|timeline|position/i.test(label);
  }

  function hideProgress(record) {
    const site = decision.site;
    if (!site || !site.hideProgress || record.status !== "applied") return;
    let targets = site.progressSelector ? queryAllDeep(record.container, site.progressSelector) : [];
    if (!targets.length) {
      targets = [];
      walkElements(record.container, (el) => {
        if (looksLikeSeekBar(el, record.video.duration)) targets.push(el);
      });
    }
    for (const el of targets) {
      if (record.hidden.has(el)) {
        if (el.style.getPropertyValue("opacity") !== "0") el.style.setProperty("opacity", "0", "important");
        continue;
      }
      record.hidden.set(el, { value: el.style.getPropertyValue("opacity"), priority: el.style.getPropertyPriority("opacity") });
      el.style.setProperty("opacity", "0", "important");
    }
  }

  // ---- Watching the DOM ----------------------------------------------------

  const observer = new MutationObserver(onMutations);

  function rebuildObserver() {
    observer.disconnect();
    const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS };
    for (const record of records.values()) {
      if (record.status !== "applied" || !record.container) continue;
      const roots = [record.container];
      walkElements(record.container, () => {}, roots);
      for (const label of record.outside) roots.push(label);
      for (const root of roots) observer.observe(root, options);
    }
  }

  // Runs as a microtask after the page changes the DOM and before the next
  // paint, so the real length never shows.
  function onMutations(mutations) {
    const applied = [...records.values()].filter((r) => r.status === "applied" && r.container);
    if (!applied.length) return;
    let needRebuild = false;
    for (const m of mutations) {
      const record = applied.find((r) => containsDeep(r.container, m.target) || r.outside.some((l) => containsDeep(l, m.target)));
      if (!record) continue;
      const ctx = clockContext(record);
      if (m.type === "characterData") {
        rewriteText(record, m.target, ctx);
      } else if (m.type === "attributes") {
        rewriteAttr(record, m.target, m.attributeName, ctx);
      } else {
        for (const added of m.addedNodes) {
          rewriteSubtree(record, added, ctx);
          if (added.nodeType === Node.ELEMENT_NODE) {
            walkElements(added, (el) => {
              if (shadowOf(el)) needRebuild = true;
            });
            for (const label of queryAllDeep(added, decision.site.durationSelector)) rewriteLabel(record, label);
          }
        }
        if (decision.site && decision.site.hideProgress && m.addedNodes.length) hideProgress(record);
      }
      if (m.type !== "attributes") {
        const label = labelContaining(record, m.target);
        if (label) rewriteLabel(record, label);
      }
    }
    if (needRebuild) rebuildObserver();
  }

  // ---- Discovering videos ---------------------------------------------------

  function onMediaEvent(event) {
    if (!settings) return;
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (!active() && !records.has(video)) return;
    const record = track(video);
    if (event.type === "emptied" || event.type === "loadstart") {
      if (record.status === "applied") setStatus(record, "idle");
      return;
    }
    evaluate(record);
    if (event.type === "playing") maybeAsk(record);
  }

  function scan(deep) {
    const videos = deep ? findVideosDeep() : document.querySelectorAll("video");
    for (const video of videos) {
      const record = track(video);
      if (record && record.status !== "applied" && video.readyState >= 1) evaluate(record);
    }
  }

  function tick() {
    tickCount++;
    if (location.href !== lastHref) {
      lastHref = location.href;
      evaluateAll();
    }
    if (!active()) return;
    scan(tickCount % DEEP_SCAN_EVERY === 0);
    for (const record of [...records.values()]) {
      if (!record.video.isConnected) {
        untrack(record);
        continue;
      }
      if (record.status === "applied") {
        evaluate(record); // picks up container swaps and ad breaks
      } else if (record.status === "idle" && record.video.readyState >= 1) {
        evaluate(record);
      }
    }
  }

  function startTicking() {
    if (!tickTimer && active()) tickTimer = setInterval(tick, TICK_MS);
    if (tickTimer && !active() && !records.size) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  }

  // ---- Auto-detect dialog ---------------------------------------------------

  const promptQueue = [];
  let promptOpen = false;

  function maybeAsk(record) {
    if (decision.mode !== "auto" || record.status !== "applied") return;
    if (record.video.paused || askedKeys.has(record.key)) return;
    if (window.top !== window && !bigEnough(record.video)) return;
    askedKeys.add(record.key);
    promptQueue.push(record);
    showNextPrompt();
  }

  function showNextPrompt() {
    if (promptOpen) return;
    const record = promptQueue.shift();
    if (!record) return;
    if (record.status !== "applied") {
      showNextPrompt();
      return;
    }
    promptOpen = true;
    openPrompt(record, (choice) => {
      promptOpen = false;
      if (choice.cancel) {
        cancelledKeys.add(record.key);
        setStatus(record, "cancelled");
      }
      if (choice.remember) {
        Store.setCustomSite(location.hostname, { enabled: !choice.cancel }).catch(() => {});
      }
      showNextPrompt();
    });
  }

  const PROMPT_CSS = `
    :host { all: initial; }
    dialog {
      --bg: #ffffff; --fg: #1b1f27; --muted: #5b6474; --line: #d9dde5; --accent: #5b3fd6; --accent-fg: #ffffff;
      box-sizing: border-box; width: min(400px, calc(100vw - 24px)); max-width: none; margin: auto;
      padding: 20px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.25);
    }
    @media (prefers-color-scheme: dark) {
      dialog { --bg: #1d212b; --fg: #eceef3; --muted: #a2a9b8; --line: #343a48; --accent: #9d87ff; --accent-fg: #15121f; }
    }
    dialog::backdrop { background: rgba(10, 12, 18, .35); }
    h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.3; }
    p { margin: 0 0 14px; color: var(--muted); }
    label { display: flex; gap: 8px; align-items: center; margin: 0 0 16px; color: var(--fg); cursor: pointer; }
    input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
    .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    button { font: inherit; font-weight: 600; min-height: 36px; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
    .cancel { background: transparent; color: var(--fg); border: 1px solid var(--line); }
    .keep { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); font-variant-numeric: tabular-nums; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;

  function openPrompt(record, done) {
    const host = document.createElement("video-spoiler-guard-prompt");
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PROMPT_CSS;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-labelledby", "vsg-title");

    const title = document.createElement("h2");
    title.id = "vsg-title";
    title.textContent = "Video length hidden";
    const body = document.createElement("p");
    const domain = VSG.normalizeDomain(location.hostname) || location.hostname;
    body.textContent = `The player now shows this video's length plus a random ${VSG.describeHours(settings.minHours, settings.maxHours)}. Cancel to see the real length.`;

    const remember = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    remember.append(box, document.createTextNode(`Remember my choice for ${domain}`));

    const row = document.createElement("div");
    row.className = "row";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel";
    cancel.textContent = "Cancel";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "keep";
    row.append(cancel, keep);

    dialog.append(title, body, remember, row);
    shadow.append(style, dialog);
    (document.body || document.documentElement).appendChild(host);

    let left = settings.confirmSeconds;
    const label = () => {
      keep.textContent = left > 0 ? `Keep hidden (${left})` : "Keep hidden";
    };
    label();
    let finished = false;
    const finish = (cancelled) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try {
        dialog.close();
      } catch {}
      host.remove();
      done({ cancel: cancelled, remember: box.checked });
    };
    const timer = left > 0
      ? setInterval(() => {
          left--;
          if (left <= 0) finish(false);
          else label();
        }, 1000)
      : 0;

    // Any interaction stops the countdown so a choice in progress isn't cut off.
    const stopCountdown = () => {
      if (!timer) return;
      clearInterval(timer);
      left = 0;
      label();
    };
    box.addEventListener("change", stopCountdown);
    cancel.addEventListener("click", () => finish(true));
    keep.addEventListener("click", () => finish(false));
    // Escape dismisses the dialog, which leaves the guard on.
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    record.video.addEventListener("emptied", () => finish(false), { once: true });

    try {
      dialog.showModal();
    } catch {
      dialog.show();
    }
    keep.focus();
  }

  // ---- Toolbar badge --------------------------------------------------------

  let lastReported = null;
  function reportStatus() {
    const guarding = [...records.values()].some((r) => r.status === "applied");
    if (guarding === lastReported) return;
    lastReported = guarding;
    try {
      chromeApi.runtime.sendMessage({ type: "vsg-status", guarding }).catch(() => {});
    } catch {
      // The extension was reloaded; this copy of the script is orphaned.
    }
  }

  // ---- Start ----------------------------------------------------------------

  // Capture listeners on the document see media events from every <video> in
  // the light DOM before the page's own handlers update their labels.
  for (const type of MEDIA_EVENTS) document.addEventListener(type, onMediaEvent, true);

  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.salt) {
      salt = changes.salt.newValue || salt;
      evaluateAll();
      return;
    }
    if (area !== "sync") return;
    Store.loadSettings().then((loaded) => {
      settings = loaded;
      decision = VSG.decide(settings, location.hostname);
      evaluateAll();
      startTicking();
      if (active()) scan(true);
    });
  });

  loadState()
    .then(() => {
      startTicking();
      if (!active()) return;
      scan(true);
    })
    .catch(() => {});
})();
