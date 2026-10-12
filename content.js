// Runs in every frame of every page (see manifest.json). It stays idle unless
// the page's site is switched on, or auto-detect is on and the site is not
// switched off. While guarding a video it rewrites every clock in the player
// that shows the real total length (or time remaining) so it includes a fake
// 2-6 hours, and puts the real text back when the guard is turned off.
(function () {
  "use strict";

  const chromeApi = globalThis.chrome;
  const runtimeAlive = () => {
    try {
      return !!(chromeApi.runtime && chromeApi.runtime.id);
    } catch {
      return false;
    }
  };

  // After an update the extension injects itself into open tabs again. An
  // older copy that is still connected wins; an orphaned one is shut down.
  const previous = globalThis.__videoSpoilerGuard;
  if (previous) {
    if (previous.alive()) return;
    try {
      previous.shutdown();
    } catch {
      // Nothing more can be done for the old copy.
    }
  }

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;

  // Attributes that can carry a visible or tooltip clock. Only clock-shaped
  // values are ever changed, so a numeric aria-valuemax is left alone.
  const ATTRS = ["aria-valuetext", "aria-valuemax", "aria-label", "title", "data-tooltip", "data-title"];
  const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "playing", "play", "emptied", "loadstart"];
  const MIN_SIZE = { width: 200, height: 112 }; // smaller videos are previews or ads
  const TICK_MS = 1000;
  const DEEP_SCAN_EVERY = 2; // ticks
  const OUTSIDE_LABEL_RECHECK_MS = 5000;

  // ---- Which site this frame belongs to ---------------------------------

  function hostFromOrigin(origin) {
    try {
      return origin && origin !== "null" ? new URL(origin).hostname : "";
    } catch {
      return "";
    }
  }

  const ancestors = location.ancestorOrigins || [];
  const IS_TOP = window.top === window;
  // about:blank and srcdoc frames have no host of their own; they belong to
  // the page that made them. A sandboxed frame with an opaque origin gets "".
  const FRAME_HOST = location.hostname || hostFromOrigin(self.origin) || hostFromOrigin(ancestors[0]);
  const TOP_HOST = IS_TOP ? FRAME_HOST : hostFromOrigin(ancestors[ancestors.length - 1]) || FRAME_HOST;

  let settings = null;
  let salt = "";
  let decision = { mode: "none", site: null, listed: null };
  let lastHref = location.href;
  let tickTimer = 0;
  let tickCount = 0;
  let stopped = false;

  // The page's own setting decides for its embedded players: "Off" on a page
  // covers a YouTube embed in it, and "On" covers an unlisted player frame.
  // An embed whose own site is listed follows its own entry otherwise.
  function computeDecision() {
    if (!settings || !FRAME_HOST) return { mode: "none", site: null, listed: null };
    const own = VSG.decide(settings, FRAME_HOST);
    const ownListed = own.mode === "on" || own.mode === "off" ? own.site : null;
    if (IS_TOP || TOP_HOST === FRAME_HOST) return { ...own, listed: ownListed };
    const top = VSG.decide(settings, TOP_HOST);
    if (top.mode === "off") return { mode: "off", site: top.site, listed: top.site };
    if (ownListed) return { ...own, listed: ownListed };
    if (top.mode === "on") {
      return {
        mode: "on",
        site: { ...VSG.AUTO_SITE, hideProgress: top.site.hideProgress, ask: top.site.ask },
        listed: top.site,
      };
    }
    return { ...own, listed: null };
  }

  function active() {
    return decision.mode === "on" || decision.mode === "auto";
  }

  // The dialog belongs to auto-detect: it shows on unlisted sites, and on
  // listed sites unless the user chose not to be asked there.
  function shouldAsk() {
    if (!settings || !settings.autoDetect) return false;
    if (decision.mode === "auto") return true;
    return decision.mode === "on" && decision.site.ask !== false;
  }

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
      node = node.parentNode || node.host || null;
    }
    return false;
  }

  // Visits every element under root (inclusive), descending into shadow
  // roots, which are collected into `shadowRoots` when given.
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
    if (root.nodeType === Node.TEXT_NODE) {
      visit(root);
      return;
    }
    const scan = (base) => {
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) visit(n);
    };
    scan(root);
    const shadows = [];
    walkElements(root, () => {}, shadows);
    shadows.forEach(scan);
  }

  function queryAllDeep(root, selector) {
    const out = new Set();
    if (!selector || !root) return [];
    const roots = [root];
    walkElements(root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root, () => {}, roots);
    for (const r of roots) {
      try {
        if (r.nodeType === Node.ELEMENT_NODE && r.matches(selector)) out.add(r);
        r.querySelectorAll(selector).forEach((el) => out.add(el));
      } catch {
        return [];
      }
    }
    return [...out];
  }

  // A player's container plus every shadow root inside it, refreshed at most
  // once a second, so per-mutation checks don't walk the whole player.
  function rootsFor(record, container) {
    const now = Date.now();
    if (record.roots && record.rootsContainer === container && now - record.rootsAt < 1000) return record.roots;
    const roots = [container];
    walkElements(container, () => {}, roots);
    record.roots = roots;
    record.rootsContainer = container;
    record.rootsAt = now;
    return roots;
  }

  function queryRoots(roots, selector) {
    const out = new Set();
    if (!selector) return [];
    for (const r of roots) {
      try {
        if (r.nodeType === Node.ELEMENT_NODE && r.matches(selector)) out.add(r);
        r.querySelectorAll(selector).forEach((el) => out.add(el));
      } catch {
        return [];
      }
    }
    return [...out];
  }

  function isRendered(el) {
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // ---- Settings ------------------------------------------------------------

  async function loadState() {
    const [loaded, s] = await Promise.all([Store.loadSettings(), Store.getSalt()]);
    settings = loaded;
    salt = s;
    decision = computeDecision();
  }

  // ---- Per-video records --------------------------------------------------

  /** @type {Map<HTMLVideoElement, object>} */
  const records = new Map();
  const cancelledKeys = new Set(); // "Cancel" in the dialog, for this page visit
  const askedKeys = new Set();     // the dialog has been shown for this video
  // Which record wrote the fake text a node shows, so two players that can
  // both reach one label never stack their offsets on each other.
  const textClaims = new WeakMap(); // Text -> record
  const attrClaims = new WeakMap(); // Element -> Map(attr -> record)

  function track(video) {
    if (!(video instanceof HTMLVideoElement)) return null;
    let record = records.get(video);
    if (record) return record;
    record = {
      video,
      key: "",
      keyDuration: NaN,
      reset: true,          // a new source is loading; take a new key once it has metadata
      offset: 0,
      status: "idle",       // idle | applied | cancelled | removed
      adIdle: false,        // idle only because an ad is playing
      cancelled: false,
      asked: false,
      container: null,
      texts: new Map(),     // Text -> { original, fake }
      attrs: new Map(),     // Element -> Map(attr -> { original, fake })
      hidden: new Map(),    // Element -> { value, priority }
      outside: [],          // duration labels outside the container
      outsideCheckedAt: 0,
      closePrompt: null,
    };
    records.set(video, record);
    for (const type of MEDIA_EVENTS) video.addEventListener(type, onMediaEvent, true);
    return record;
  }

  function untrack(record) {
    const wasApplied = record.status === "applied";
    restore(record);
    if (record.closePrompt) record.closePrompt();
    record.status = "removed";
    for (const type of MEDIA_EVENTS) record.video.removeEventListener(type, onMediaEvent, true);
    records.delete(record.video);
    observerDirty = true;
    if (wasApplied) reportStatus();
  }

  // The media file, or failing that its length, tells apart videos that
  // share a page address. Neither depends on where the element sits in the DOM.
  function mediaId(video) {
    const src = video.currentSrc || video.src || "";
    if (/^https?:/i.test(src)) {
      try {
        const url = new URL(src);
        return "src:" + VSG.hash53(url.origin + url.pathname).toString(36);
      } catch {
        // fall through to the length
      }
    }
    return Number.isFinite(video.duration) ? "len:" + Math.round(video.duration) : "";
  }

  function computeKey(record) {
    const site = decision.site;
    return VSG.videoKey(site && site.builtIn ? site.id : "", location, mediaId(record.video));
  }

  // Ads either mark the player (YouTube's .ad-showing) or show a marker
  // inside it (Twitch's ad label), so check ancestors and visible descendants.
  function inAd(record, container) {
    const selector = decision.site && decision.site.adSelector;
    if (!selector) return false;
    if ([record.video, container].some((el) => el && closestDeep(el, selector))) return true;
    return !!container && queryRoots(rootsFor(record, container), selector).some(isRendered);
  }

  function bigEnough(video) {
    if (document.fullscreenElement && containsDeep(document.fullscreenElement, video)) return true;
    const rect = video.getBoundingClientRect();
    return rect.width >= MIN_SIZE.width && rect.height >= MIN_SIZE.height;
  }

  function inKnownPlayer(video) {
    const site = decision.site;
    return !!(site && site.playerSelector && closestDeep(video, site.playerSelector));
  }

  // Cheap checks first; the container is only looked up for videos that pass.
  function worthGuarding(video) {
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return false; // live streams have no end to spoil
    if (d < settings.minVideoMinutes * 60) return false;
    return inKnownPlayer(video) || bigEnough(video);
  }

  function holdsOtherVideo(el, video) {
    const videos = el.querySelectorAll("video");
    return videos.length > 1 || (videos.length === 1 && videos[0] !== video);
  }

  // The element that holds the player's controls: the site's player element
  // when we know it, otherwise the largest ancestor that is still roughly the
  // video's size (controls overlay the video or sit just under it) and holds
  // no other video.
  function findContainer(video) {
    const site = decision.site;
    if (site && site.playerSelector) {
      const player = closestDeep(video, site.playerSelector);
      if (player) return player;
    }
    const vr = video.getBoundingClientRect();
    let best = video;
    let node = parentDeep(video);
    for (let depth = 0; node && depth < 12; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const r = node.getBoundingClientRect();
      if (r.width > vr.width * 1.25 + 40 || r.height > vr.height * 1.25 + 160) break;
      if (holdsOtherVideo(node, video)) break;
      best = node;
      node = parentDeep(node);
    }
    return best;
  }

  // Decides whether this video should be guarded right now and brings the
  // page in line with that.
  function evaluate(record) {
    if (stopped || record.status === "removed") return;
    const video = record.video;
    if (!video.isConnected) {
      untrack(record);
      return;
    }
    if (!active()) {
      setStatus(record, "idle");
      return;
    }
    // While a new source loads, keep showing the fakes instead of flashing
    // the real text; the new metadata decides what happens next.
    if (record.reset && (video.readyState === 0 || Number.isNaN(video.duration))) {
      if (record.status !== "applied") record.status = "idle";
      return;
    }

    // The key belongs to the media: it changes when a new source loads, when
    // the length changes, or when a site's own video id in the address
    // changes, never because the DOM or an unrelated query parameter moved.
    const key = computeKey(record);
    const siteKeyed = !!(decision.site && decision.site.builtIn && key.startsWith(decision.site.id + ":"));
    const lengthMoved = Number.isFinite(video.duration) && Math.abs(video.duration - record.keyDuration) > 1;
    if (!record.key || record.reset || lengthMoved || (siteKeyed && key !== record.key)) {
      if (key !== record.key) {
        if (record.closePrompt) record.closePrompt();
        restore(record);
        if (record.status === "applied") observerDirty = true;
        record.status = "idle";
        record.key = key;
        record.cancelled = false;
        record.asked = false;
      }
      record.keyDuration = video.duration;
      record.reset = false;
    }

    if (!worthGuarding(video)) {
      if (record.adIdle) observerDirty = true;
      record.adIdle = false;
      setStatus(record, "idle");
      return;
    }
    const container = findContainer(video);
    if (inAd(record, container)) {
      setStatus(record, "idle");
      if (!record.adIdle || record.container !== container) observerDirty = true;
      record.adIdle = true;
      record.container = container;
      return;
    }
    if (record.adIdle) observerDirty = true;
    record.adIdle = false;
    if (record.cancelled || cancelledKeys.has(record.key)) {
      setStatus(record, "cancelled");
      return;
    }

    const offset = VSG.offsetSeconds(record.key, salt, settings.minHours, settings.maxHours);
    if (record.status === "applied" && (offset !== record.offset || container !== record.container)) restore(record);
    if (record.status !== "applied" || container !== record.container) observerDirty = true;
    record.offset = offset;
    record.container = container;
    record.status = "applied";
    rewriteRecord(record);
    hideProgress(record);
    maybeAsk(record);
    reportStatus();
  }

  function setStatus(record, status) {
    if (record.status === "applied" && status !== "applied") {
      if (record.closePrompt) record.closePrompt();
      restore(record);
      observerDirty = true;
    }
    record.status = status;
    reportStatus();
  }

  function evaluateAll() {
    for (const record of [...records.values()]) evaluate(record);
    flushObserver();
  }

  // True once something on the page actually shows the fake length.
  function rewrote(record) {
    return record.texts.size > 0 || record.attrs.size > 0;
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

  // Video.js, Brightcove and similar players print time left as "-" in one
  // span and an unsigned clock in the next, inside an element named for it.
  function looksLikeRemaining(node) {
    let el = node.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
      const words = `${el.getAttribute("class") || ""} ${el.getAttribute("aria-label") || ""} ${el.id || ""}`;
      if (/remain|time-?left|countdown/i.test(words)) return true;
    }
    const before = node.previousSibling || (node.parentElement && node.parentElement.previousSibling);
    return !!before && /[-−–]\s*$/.test(before.textContent || "");
  }

  function claimedByOther(record, node, current) {
    const owner = textClaims.get(node);
    if (!owner || owner === record || owner.status !== "applied") return false;
    const entry = owner.texts.get(node);
    return !!entry && entry.fake === current;
  }

  function writeText(record, node, current, next) {
    record.texts.set(node, { original: current, fake: next });
    textClaims.set(node, record);
    node.nodeValue = next;
  }

  function rewriteText(record, node, ctx) {
    const current = node.nodeValue;
    const entry = record.texts.get(node);
    if (entry && current === entry.fake) return;
    if (claimedByOther(record, node, current)) return;
    let next = VSG.rewriteClockText(current, ctx);
    if (next === null && !ctx.remainingUnsigned && VSG.hasClock(current) && looksLikeRemaining(node)) {
      next = VSG.rewriteClockText(current, { ...ctx, remainingUnsigned: true });
    }
    if (next === null) {
      if (entry) record.texts.delete(node);
      return;
    }
    writeText(record, node, current, next);
  }

  function rewriteAttr(record, el, name, ctx) {
    const current = el.getAttribute(name);
    if (current === null) return;
    let map = record.attrs.get(el);
    const entry = map && map.get(name);
    if (entry && current === entry.fake) return;
    const claims = attrClaims.get(el);
    const owner = claims && claims.get(name);
    if (owner && owner !== record && owner.status === "applied") {
      const theirs = owner.attrs.get(el);
      if (theirs && theirs.get(name) && theirs.get(name).fake === current) return;
    }
    const next = VSG.rewriteClockText(current, ctx);
    if (next === null) {
      if (entry) map.delete(name);
      return;
    }
    if (!map) record.attrs.set(el, (map = new Map()));
    map.set(name, { original: current, fake: next });
    if (!claims) attrClaims.set(el, new Map([[name, record]]));
    else claims.set(name, record);
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

  // A clock in the site's own length label is offset only when it can be
  // this video's length (or time left): this skips "0:00" placeholders and
  // elapsed time, which would otherwise give the offset away.
  function plausibleLabelClock(record, clock) {
    const d = record.video.duration;
    if (!Number.isFinite(d)) return false;
    const remaining = d - record.video.currentTime;
    if (clock.sign || decision.site.labelKind === "remaining") {
      return clock.value <= remaining + 30 && (clock.value >= 30 || record.video.currentTime > 0);
    }
    return clock.value >= 30 && Math.abs(clock.value - d) <= Math.max(900, d * 0.25);
  }

  // The site's own length label: its last clock is the length even when it
  // disagrees with <video>.duration (server-side ads make the media longer),
  // so add the offset to that clock.
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
    if (claimedByOther(record, node, current)) return;
    const clock = VSG.lastClock(current);
    if (!clock || !plausibleLabelClock(record, clock)) return;
    const next = VSG.rewriteLastClock(current, record.offset);
    if (next === null || next === current) return;
    writeText(record, node, current, next);
  }

  function labelsOf(record) {
    const site = decision.site;
    if (!site || !site.durationSelector || !record.container) return [];
    return queryRoots(rootsFor(record, record.container), site.durationSelector).concat(record.outside);
  }

  function labelContaining(record, node) {
    const site = decision.site;
    if (!site || !site.durationSelector) return null;
    const start = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || (node.parentNode && node.parentNode.host);
    if (!start) return null;
    const label = closestDeep(start, site.durationSelector);
    return label && (containsDeep(record.container, label) || record.outside.includes(label)) ? label : null;
  }

  // Length labels that live outside the player container. A record keeps a
  // label it has claimed; a new claim is only made when this is the page's
  // only guarded video, so the label can't belong to another one.
  function outsideLabels(record) {
    const site = decision.site;
    if (!site || !site.durationSelector) return [];
    const kept = record.outside.filter((l) => l.isConnected && !containsDeep(record.container, l));
    if (kept.length) return kept;
    const now = Date.now();
    if (now - record.outsideCheckedAt < OUTSIDE_LABEL_RECHECK_MS) return [];
    record.outsideCheckedAt = now;
    if (queryRoots(rootsFor(record, record.container), site.durationSelector).length) return [];
    const others = [...records.values()].filter((r) => r !== record && r.status === "applied");
    if (others.length) return [];
    let found = [];
    try {
      found = [...document.querySelectorAll(site.durationSelector)];
    } catch {
      return [];
    }
    if (!found.length) found = queryAllDeep(document, site.durationSelector);
    return found;
  }

  function rewriteRecord(record) {
    if (record.status !== "applied" || !record.container) return;
    // Forget nodes the page has thrown away.
    for (const node of record.texts.keys()) if (!node.isConnected) record.texts.delete(node);
    for (const el of record.attrs.keys()) if (!el.isConnected) record.attrs.delete(el);
    const ctx = clockContext(record);
    rewriteSubtree(record, record.container, ctx);
    const known = record.roots ? record.roots.length : 0;
    record.rootsAt = 0;
    if (rootsFor(record, record.container).length !== known) observerDirty = true; // a shadow root appeared
    const outside = outsideLabels(record);
    if (outside.length !== record.outside.length || outside.some((l, i) => l !== record.outside[i])) observerDirty = true;
    record.outside = outside;
    for (const label of record.outside) rewriteSubtree(record, label, ctx);
    for (const label of labelsOf(record)) rewriteLabel(record, label);
  }

  function restore(record) {
    for (const [node, entry] of record.texts) {
      if (node.nodeValue === entry.fake) node.nodeValue = entry.original;
      if (textClaims.get(node) === record) textClaims.delete(node);
    }
    record.texts.clear();
    for (const [el, map] of record.attrs) {
      const claims = attrClaims.get(el);
      for (const [name, entry] of map) {
        if (el.getAttribute(name) === entry.fake) el.setAttribute(name, entry.original);
        if (claims && claims.get(name) === record) claims.delete(name);
      }
    }
    record.attrs.clear();
    unhideProgress(record);
    record.outside = [];
    record.outsideCheckedAt = 0;
  }

  // ---- Progress bar --------------------------------------------------------

  // An attribute as the page wrote it, before any rewrite of ours.
  function originalAttr(record, el, name) {
    const current = el.getAttribute(name);
    const map = record.attrs.get(el);
    const entry = map && map.get(name);
    return entry && current === entry.fake ? entry.original : current;
  }

  function looksLikeSeekBar(record, el) {
    const duration = record.video.duration;
    const role = el.getAttribute("role");
    const isRange = el.tagName === "INPUT" && el.type === "range";
    if (!isRange && el.tagName !== "PROGRESS" && role !== "slider" && role !== "progressbar") return false;
    const words = `${el.getAttribute("class") || ""} ${originalAttr(record, el, "aria-label") || ""} ${el.id || ""}`;
    if (/volume|\bvol\b|loading|spinner|buffer/i.test(words)) return false;
    const max = Number(isRange || el.tagName === "PROGRESS" ? el.max : originalAttr(record, el, "aria-valuemax"));
    if (Number.isFinite(max) && max > 0 && Math.abs(max - duration) <= 2) return true;
    if (VSG.mentionsDuration(originalAttr(record, el, "aria-valuetext") || "", duration)) return true;
    return /(^|[\s_-])(seek|scrub|timeline|progress)/i.test(words);
  }

  function hideProgress(record) {
    const site = decision.site;
    if (!site || !site.hideProgress) {
      unhideProgress(record);
      return;
    }
    if (record.status !== "applied") return;
    let targets = site.progressSelector ? queryRoots(rootsFor(record, record.container), site.progressSelector) : [];
    if (!targets.length) {
      walkElements(record.container, (el) => {
        if (looksLikeSeekBar(record, el)) targets.push(el);
      });
    }
    for (const el of targets) {
      if (!record.hidden.has(el)) {
        record.hidden.set(el, { value: el.style.getPropertyValue("opacity"), priority: el.style.getPropertyPriority("opacity") });
      }
      if (el.style.getPropertyValue("opacity") !== "0") el.style.setProperty("opacity", "0", "important");
    }
  }

  function unhideProgress(record) {
    for (const [el, prev] of record.hidden) {
      if (prev.value) el.style.setProperty("opacity", prev.value, prev.priority);
      else el.style.removeProperty("opacity");
    }
    record.hidden.clear();
  }

  // ---- Watching the DOM ----------------------------------------------------

  const APPLIED_OPTIONS = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat("class") };
  const AD_OPTIONS = { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"] };
  const observer = new MutationObserver(onMutations);
  let observerDirty = false;

  function rebuildObserver() {
    observerDirty = false;
    observer.disconnect();
    for (const record of records.values()) {
      if (!record.container || (record.status !== "applied" && !record.adIdle)) continue;
      const options = record.status === "applied" ? APPLIED_OPTIONS : AD_OPTIONS;
      record.rootsAt = 0; // pick up shadow roots attached since the last walk
      const roots = rootsFor(record, record.container).slice();
      if (record.status === "applied") roots.push(...record.outside);
      for (const root of roots) observer.observe(root, options);
    }
  }

  function flushObserver() {
    if (observerDirty) rebuildObserver();
  }

  // The record a changed node belongs to: the one that wrote its fake, else
  // the innermost player container that holds it.
  function ownerOf(node) {
    const claimed = textClaims.get(node);
    if (claimed && claimed.status === "applied") return claimed;
    let best = null;
    for (const record of records.values()) {
      if (!record.container || (record.status !== "applied" && !record.adIdle)) continue;
      const holds = containsDeep(record.container, node) || (record.status === "applied" && record.outside.some((l) => containsDeep(l, node)));
      if (!holds) continue;
      if (!best || containsDeep(best.container, record.container)) best = record;
    }
    return best;
  }

  // Runs as a microtask after the page changes the DOM and before the next
  // paint, so the real length never shows.
  function onMutations(mutations) {
    if (stopped) return;
    const reevaluate = new Set();
    const progress = new Set();
    for (const m of mutations) {
      const record = ownerOf(m.target);
      if (!record) continue;
      if (record.status !== "applied") {
        reevaluate.add(record); // an ad marker may have gone away
        continue;
      }
      if (m.type === "attributes" && m.attributeName === "class") {
        if (decision.site.adSelector) reevaluate.add(record); // an ad may have started
        continue;
      }
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
              if (shadowOf(el)) observerDirty = true;
            });
            for (const label of queryAllDeep(added, decision.site.durationSelector)) rewriteLabel(record, label);
          }
        }
        if (m.addedNodes.length && decision.site.hideProgress) progress.add(record);
      }
      if (m.type !== "attributes") {
        const label = labelContaining(record, m.target);
        if (label) rewriteLabel(record, label);
      }
    }
    for (const record of reevaluate) {
      if (record.status === "applied" && !inAd(record, record.container)) continue;
      evaluate(record);
    }
    for (const record of progress) hideProgress(record);
    flushObserver();
  }

  // ---- Discovering videos ---------------------------------------------------

  const seenEvents = new WeakSet();
  const watchedRoots = new WeakSet();

  function onMediaEvent(event) {
    if (stopped || !settings || seenEvents.has(event)) return;
    seenEvents.add(event);
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    if (!active() && !records.has(video)) return;
    const record = track(video);
    if (event.type === "emptied" || event.type === "loadstart") {
      // A new source: keep the fakes on screen until its metadata arrives.
      record.reset = true;
      if (record.closePrompt) record.closePrompt(true);
      return;
    }
    evaluate(record);
    flushObserver();
  }

  // Media events don't cross shadow boundaries, so each shadow root gets the
  // same capture listeners as the document once it has been found.
  function watchRoot(root) {
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    for (const type of MEDIA_EVENTS) root.addEventListener(type, onMediaEvent, true);
  }

  function discover(deep) {
    const found = new Set(document.querySelectorAll("video"));
    if (deep && document.documentElement) {
      const shadows = [];
      walkElements(document.documentElement, (el) => {
        if (el.tagName === "VIDEO") found.add(el);
      }, shadows);
      shadows.forEach(watchRoot);
    }
    for (const video of found) track(video);
  }

  function tick() {
    if (!runtimeAlive()) {
      shutdown();
      return;
    }
    tickCount++;
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastReported = null;
      evaluateAll();
      reportStatus();
    }
    if (!active()) return;
    discover(tickCount % DEEP_SCAN_EVERY === 0 && !document.hidden);
    for (const record of [...records.values()]) {
      if (record.video.readyState >= 1 || record.status === "applied") evaluate(record);
      else if (!record.video.isConnected) untrack(record);
    }
    flushObserver();
  }

  function startTicking() {
    if (!tickTimer && active()) tickTimer = setInterval(tick, TICK_MS);
  }

  // ---- The dialog -------------------------------------------------------------

  const promptQueue = [];
  let promptOpen = false;

  function maybeAsk(record) {
    if (!shouldAsk() || record.status !== "applied") return;
    if (record.video.paused || record.asked || askedKeys.has(record.key)) return;
    if (!rewrote(record)) return; // nothing on screen changed, e.g. built-in browser controls
    if (!bigEnough(record.video) && !inKnownPlayer(record.video)) return;
    record.asked = true;
    askedKeys.add(record.key);
    promptQueue.push(record);
    showNextPrompt();
  }

  function forgetAsked(record) {
    record.asked = false;
    askedKeys.delete(record.key);
  }

  function showNextPrompt() {
    while (!promptOpen && promptQueue.length) {
      const record = promptQueue.shift();
      if (record.status !== "applied") {
        forgetAsked(record); // ask again when it is guarded again
        continue;
      }
      promptOpen = true;
      const key = record.key;
      openPrompt(record, (choice) => {
        promptOpen = false;
        record.closePrompt = null;
        if (choice.interrupted) {
          if (record.key === key) forgetAsked(record);
        } else {
          if (choice.cancel && record.key === key) {
            record.cancelled = true;
            cancelledKeys.add(key);
            setStatus(record, "cancelled");
          }
          if (choice.remember) remember(choice.cancel);
        }
        showNextPrompt();
      });
    }
  }

  // "Remember my choice": on a listed site, Keep stops the dialog there and
  // Cancel switches the site off; on an unlisted site it adds the site.
  function remember(cancelled) {
    const listed = decision.listed;
    let write;
    if (listed) write = cancelled ? Store.setSiteEnabled(listed, false) : Store.setSiteAsk(listed, false);
    else write = Store.setCustomSite(TOP_HOST, { enabled: !cancelled, ask: false });
    write.catch(() => {
      // Storage refused the write (quota); the dialog is already gone.
    });
  }

  function rememberLabel() {
    const listed = decision.listed;
    if (listed) return listed.builtIn ? listed.name : listed.domains[0];
    return VSG.normalizeDomain(TOP_HOST) || "";
  }

  const PROMPT_CSS = `
    :host { all: initial; }
    dialog {
      --bg: #ffffff; --fg: #1b1f27; --muted: #5b6474; --line: #d9dde5; --accent: #5b3fd6; --accent-fg: #ffffff;
      box-sizing: border-box; width: min(400px, calc(100vw - 24px)); max-width: none; max-height: calc(100vh - 16px);
      margin: auto; padding: 20px; overflow: auto; visibility: visible;
      border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--fg);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; text-align: left;
      box-shadow: 0 8px 28px rgba(0,0,0,.25);
    }
    dialog:not(:modal) { position: fixed; inset: auto 16px 16px auto; margin: 0; z-index: 2147483647; }
    dialog:focus { outline: none; }
    @media (prefers-color-scheme: dark) {
      dialog { --bg: #1d212b; --fg: #eceef3; --muted: #a2a9b8; --line: #343a48; --accent: #9d87ff; --accent-fg: #15121f; }
    }
    dialog::backdrop { background: rgba(10, 12, 18, .35); }
    h2 { margin: 0 0 6px; font-size: 16px; line-height: 1.3; font-weight: 700; }
    p { margin: 0 0 14px; color: var(--muted); }
    label { display: flex; gap: 8px; align-items: center; margin: 0 0 16px; color: var(--fg); cursor: pointer; }
    input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
    .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    button { font: inherit; font-weight: 600; min-height: 36px; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
    .cancel { background: transparent; color: var(--fg); border: 1px solid var(--line); }
    .keep { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); font-variant-numeric: tabular-nums; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-height: 260px) {
      dialog { padding: 10px 12px; }
      h2 { font-size: 14px; margin: 0 0 2px; }
      p, label { font-size: 12.5px; line-height: 1.35; margin: 0 0 6px; }
      button { min-height: 28px; padding: 2px 10px; font-size: 12.5px; }
    }
  `;

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    return el.tagName === "INPUT" && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type);
  }

  function openPrompt(record, done) {
    const host = document.createElement("video-spoiler-guard-prompt");
    host.style.cssText = "all: initial !important; display: block !important; position: fixed !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PROMPT_CSS;
    const dialog = document.createElement("dialog");
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-labelledby", "vsg-title");
    dialog.setAttribute("aria-describedby", "vsg-body");

    const title = document.createElement("h2");
    title.id = "vsg-title";
    title.textContent = "Video length hidden";
    const body = document.createElement("p");
    body.id = "vsg-body";
    body.textContent = `The player now shows this video's length plus a random ${VSG.describeHours(settings.minHours, settings.maxHours)}. Cancel to see the real length.`;

    const where = rememberLabel();
    const box = document.createElement("input");
    box.type = "checkbox";
    const remember = document.createElement("label");
    remember.append(box, document.createTextNode(`Remember my choice for ${where}`));
    remember.hidden = !where;

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
    document.documentElement.appendChild(host);

    let left = settings.confirmSeconds;
    const label = () => {
      keep.textContent = left > 0 ? `Keep hidden (${left})` : "Keep hidden";
    };
    label();
    let finished = false;
    let timer = 0;
    const finish = (cancelled, interrupted = false) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearInterval(watch);
      document.removeEventListener("fullscreenchange", onFullscreen, true);
      try {
        dialog.close();
      } catch {
        // already closed
      }
      host.remove();
      done({ cancel: cancelled, remember: !interrupted && box.checked && !!where, interrupted });
    };
    if (left > 0) {
      timer = setInterval(() => {
        left--;
        if (left <= 0) finish(false);
        else label();
      }, 1000);
    }
    // The page may remove our element (a framework re-rendering <html>), which
    // closes the dialog without any event.
    const watch = setInterval(() => {
      if (!host.isConnected) finish(false, true);
    }, 1000);

    // Any key or click inside stops the countdown, so a choice in progress
    // isn't cut off.
    const stopCountdown = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = 0;
      left = 0;
      label();
    };
    dialog.addEventListener("keydown", stopCountdown);
    dialog.addEventListener("pointerdown", stopCountdown);
    cancel.addEventListener("click", () => finish(true));
    keep.addEventListener("click", () => finish(false));
    // Escape dismisses the dialog, which leaves the guard on.
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    // Closing because the guard was withdrawn writes nothing.
    record.closePrompt = (interrupted = true) => finish(false, interrupted);

    // Someone typing keeps their focus; the dialog then opens beside the page
    // instead of blocking it.
    const modal = !isEditable(document.activeElement);
    const show = () => {
      try {
        if (modal) dialog.showModal();
        else dialog.show();
      } catch {
        dialog.show();
      }
    };
    // A dialog opened before the video went fullscreen would sit under it.
    const onFullscreen = () => {
      if (!modal || !dialog.open) return;
      dialog.close();
      show();
      dialog.focus();
    };
    document.addEventListener("fullscreenchange", onFullscreen, true);
    show();
    if (modal) dialog.focus();
  }

  // ---- Toolbar badge --------------------------------------------------------

  let lastReported = null;
  function send(message) {
    try {
      chromeApi.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension was reloaded; this copy of the script is orphaned.
    }
  }

  function reportStatus() {
    const guarding = [...records.values()].some((r) => r.status === "applied" && rewrote(r));
    if (guarding === lastReported) return;
    lastReported = guarding;
    send({ type: "vsg-status", guarding });
  }

  // ---- Start and stop ----------------------------------------------------------

  function onStorageChange(changes, area) {
    if (stopped) return;
    if (area === "local" && changes.salt) {
      salt = changes.salt.newValue || salt;
      evaluateAll();
      return;
    }
    if (area !== "sync") return;
    Store.loadSettings()
      .then((loaded) => {
        const wasActive = active();
        settings = loaded;
        decision = computeDecision();
        if (!wasActive && active()) discover(true);
        evaluateAll();
        startTicking();
      })
      .catch(() => {});
  }

  function onPageHide() {
    lastReported = null;
    send({ type: "vsg-status", guarding: false });
  }

  function onPageShow(event) {
    if (event.persisted) reportStatus();
  }

  // Puts every page back the way it was. Used when this copy is orphaned by
  // an extension update or removal.
  function shutdown() {
    if (stopped) return;
    for (const record of [...records.values()]) untrack(record);
    stopped = true;
    clearInterval(tickTimer);
    observer.disconnect();
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMediaEvent, true);
    removeEventListener("pagehide", onPageHide);
    removeEventListener("pageshow", onPageShow);
    try {
      chromeApi.storage.onChanged.removeListener(onStorageChange);
    } catch {
      // The API is gone with the extension.
    }
    if (globalThis.__videoSpoilerGuard === api) delete globalThis.__videoSpoilerGuard;
  }

  const api = { alive: () => runtimeAlive() && !stopped, shutdown };
  globalThis.__videoSpoilerGuard = api;

  // Capture listeners on the document see media events from every <video> in
  // the light DOM before the page's own handlers update their labels.
  for (const type of MEDIA_EVENTS) document.addEventListener(type, onMediaEvent, true);
  addEventListener("pagehide", onPageHide);
  addEventListener("pageshow", onPageShow);
  chromeApi.storage.onChanged.addListener(onStorageChange);

  loadState()
    .then(() => {
      startTicking();
      if (active()) {
        discover(true);
        evaluateAll();
      }
    })
    .catch(() => {});
})();
