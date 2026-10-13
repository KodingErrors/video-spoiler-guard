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
  const OUTSIDE_LABEL_RECHECK_MS = 5000;
  const DETACH_GRACE_MS = 5000;  // a player may take its <video> out for a moment
  const MASK_LIMIT_MS = 10000;   // longest a clock stays hidden while a source loads
  const LIVE_GROWTH_S = 60;      // a live stream's length grows by at most this per step

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
  let sessionChoices = {};
  let salt = "";
  let decision = { mode: "none", site: null, listed: null };
  let lastHref = location.href;
  let tickTimer = 0;
  let tickCount = 0;
  let stopped = false;

  // The page's own setting decides for its embedded players: "Off" on a page
  // covers a YouTube embed in it, and "On" covers an unlisted player frame.
  // An embed whose own site is listed follows its own entry otherwise.
  // A "Don't show this again – for this session" choice replaces the site's
  // setting until the browser closes. It is looked up for the same site the
  // dialog's options name (`scopeHost`), and never overrides a more specific
  // site entry.
  function computeDecision() {
    const d = siteDecision();
    if (!d.scopeHost) return d;
    const entry = settings ? VSG.findSite(VSG.resolveSites(settings), d.scopeHost) : null;
    return VSG.applySessionChoice(d, VSG.sessionChoiceFor(sessionChoices, d.scopeHost, entry));
  }

  // `listed` is the site entry that decides (if any) and `scopeHost` the host
  // the dialog's "Don't show this again" options apply to: the page the user
  // is on, except in an embed whose own site is listed and decides for it.
  function siteDecision() {
    if (!settings || !FRAME_HOST) return { mode: "none", site: null, listed: null, scopeHost: "" };
    const own = VSG.decide(settings, FRAME_HOST);
    const ownListed = own.mode === "on" || own.mode === "off" ? own.site : null;
    if (IS_TOP || TOP_HOST === FRAME_HOST) return { ...own, listed: ownListed, scopeHost: TOP_HOST };
    const top = VSG.decide(settings, TOP_HOST);
    if (top.mode === "off") return { mode: "off", site: top.site, listed: top.site, scopeHost: TOP_HOST };
    if (ownListed) return { ...own, listed: ownListed, scopeHost: FRAME_HOST };
    if (top.mode === "on") {
      return {
        mode: "on",
        site: { ...VSG.AUTO_SITE, hideProgress: top.site.hideProgress, ask: top.site.ask },
        listed: top.site,
        scopeHost: TOP_HOST,
      };
    }
    return { ...own, listed: null, scopeHost: TOP_HOST };
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

  // Elements allowed to call attachShadow(): custom elements and these.
  const SHADOW_HOSTS = new Set(["ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "DIV", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "MAIN", "NAV", "P", "SECTION", "SPAN"]);
  const closedRootOf = chromeApi.dom && chromeApi.dom.openOrClosedShadowRoot;

  // el.shadowRoot is cheap; chrome.dom.openOrClosedShadowRoot also reaches
  // closed roots (content scripts only) but costs a call into the extension
  // bindings, so it is only asked about elements that can host a root.
  function shadowOf(el) {
    const open = el.shadowRoot;
    if (open) return open;
    if (!closedRootOf || (!el.tagName.includes("-") && !SHADOW_HOSTS.has(el.tagName))) return null;
    try {
      return closedRootOf(el);
    } catch {
      return null;
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
    const [loaded, s, session] = await Promise.all([Store.loadSettings(), Store.getSalt(), Store.loadSessionChoices()]);
    settings = loaded;
    salt = s;
    sessionChoices = session;
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
      adIdle: false,        // idle only because an ad plays before the video
      adMode: false,        // guarded, and an ad is playing
      contentDuration: NaN, // the video's own length, kept through an ad
      cancelled: false,
      asked: false,
      container: null,
      texts: new Map(),     // Text -> { original, fake }
      attrs: new Map(),     // Element -> Map(attr -> { original, fake })
      hidden: new Map(),    // Element -> { value, priority }
      outside: [],          // duration labels outside the container
      outsideCheckedAt: 0,
      observed: [],         // roots the MutationObserver watches for this record
      masked: new Map(),    // Element -> { value, priority }, hidden while a source loads
      maskedAt: 0,
      remainingSpots: new WeakSet(), // elements known to show time left
      keyHref: "",
      detachedAt: 0,
      closePrompt: null,
    };
    records.set(video, record);
    for (const type of MEDIA_EVENTS) video.addEventListener(type, onMediaEvent, true);
    return record;
  }

  function untrack(record) {
    const wasApplied = record.status === "applied";
    restore(record);
    unmask(record);
    removeFromQueue(record);
    if (record.closePrompt) record.closePrompt();
    record.status = "removed";
    for (const type of MEDIA_EVENTS) record.video.removeEventListener(type, onMediaEvent, true);
    records.delete(record.video);
    observerDirty = true;
    if (wasApplied) reportStatus();
  }

  // The length tells apart videos that share a page address. It doesn't
  // depend on where the element sits in the DOM, on the CDN host or on the
  // quality being played, so a quality switch keeps the same fake length.
  function mediaId(video) {
    if (Number.isFinite(video.duration)) return "len:" + Math.round(video.duration);
    const src = video.currentSrc || video.src || "";
    if (/^https?:/i.test(src)) {
      try {
        return "src:" + VSG.hash53(new URL(src).pathname).toString(36);
      } catch {
        return "";
      }
    }
    return "";
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
  // Size only decides whether to start: a guarded video that shrinks into a
  // mini-player stays guarded.
  function worthGuarding(record) {
    const video = record.video;
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return false; // live streams have no end to spoil
    if (d < settings.minVideoMinutes * 60) return false;
    if (record.status === "applied") return true;
    return (inKnownPlayer(video) && isRendered(video)) || bigEnough(video);
  }

  // Another <video> counts as a separate player only when it is on screen,
  // has media, and sits beside this one: an ad SDK's video is hidden, idle,
  // or layered over the same box.
  function holdsOtherVideo(el, video) {
    const vr = video.getBoundingClientRect();
    for (const other of el.querySelectorAll("video")) {
      if (other === video || other.readyState === 0 || !isRendered(other)) continue;
      const r = other.getBoundingClientRect();
      if (r.width < MIN_SIZE.width || r.height < MIN_SIZE.height) continue;
      const w = Math.min(r.right, vr.right) - Math.max(r.left, vr.left);
      const h = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
      if (w > 0 && h > 0 && w * h >= 0.5 * Math.min(r.width * r.height, vr.width * vr.height)) continue;
      return true;
    }
    return false;
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
    // In fullscreen the controls fill the fullscreen element even when the
    // picture doesn't; a portrait video sits in a wider 16:9 box.
    const fs = document.fullscreenElement;
    const inFullscreen = !!fs && containsDeep(fs, video);
    const maxWidth = Math.max(vr.width * 1.25 + 40, vr.height * 1.78 + 40);
    const maxHeight = vr.height * 1.25 + 160;
    let best = video;
    let node = parentDeep(video);
    for (let depth = 0; node && depth < 12; depth++) {
      if (node === document.body || node === document.documentElement) break;
      const insideFullscreen = inFullscreen && containsDeep(fs, node);
      if (!insideFullscreen) {
        const r = node.getBoundingClientRect();
        if (r.width > maxWidth || r.height > maxHeight) break;
      }
      if (holdsOtherVideo(node, video)) break;
      best = node;
      if (node === fs) break;
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
      // A player that takes its <video> out for a moment (to move it into a
      // mini-player, or to remount it) leaves its controls on screen: keep
      // their fakes for a while instead of showing the real length.
      if (active() && record.status === "applied" && record.container && record.container.isConnected) {
        record.detachedAt = record.detachedAt || Date.now();
        if (Date.now() - record.detachedAt < DETACH_GRACE_MS) return;
      }
      untrack(record);
      return;
    }
    record.detachedAt = 0;
    if (!active()) {
      setStatus(record, "idle");
      return;
    }
    // While a source loads (readyState 0 from the moment src changes, even
    // before "emptied" fires), keep showing the fakes instead of the real
    // text; the new metadata decides what happens next.
    if (video.readyState === 0 || Number.isNaN(video.duration)) {
      if (record.status !== "applied") record.status = "idle";
      return;
    }
    if (record.masked.size && Date.now() - record.maskedAt > MASK_LIMIT_MS) unmask(record);

    // The key belongs to the media. It changes when a new source with a new
    // length loads, or when a site's own video id in the address changes;
    // never because the DOM moved, a query parameter changed, the quality
    // changed, or a live stream grew.
    const key = computeKey(record);
    const siteKeyed = !!(decision.site && decision.site.builtIn && key.startsWith(decision.site.id + ":"));
    const grown = video.duration - record.keyDuration;
    const growing = !!record.key && !record.reset && grown > 0 && grown <= LIVE_GROWTH_S;
    if (growing) record.keyDuration = video.duration;
    const lengthMoved = !growing && Number.isFinite(video.duration) && !(Math.abs(grown) <= 1);
    // A new source on the same page with the same length is the same video
    // in another quality or from another server.
    const sameVideo = record.reset && !!record.key && location.href === record.keyHref && Math.abs(grown) <= 1.5;
    if (sameVideo) {
      record.reset = false;
      record.keyDuration = video.duration;
    } else if (!record.key || record.reset || lengthMoved || (siteKeyed && key !== record.key)) {
      if (key !== record.key) changeKey(record, key);
      record.keyDuration = video.duration;
      record.keyHref = location.href;
      record.reset = false;
    }

    const applied = record.status === "applied";
    if (!applied && !worthGuarding(record)) {
      if (record.adIdle) observerDirty = true;
      record.adIdle = false;
      setStatus(record, "idle");
      return;
    }
    // While guarded, the container never shrinks (a mini-player, a resize,
    // the video briefly smaller than its box); it may only grow, e.g. to the
    // fullscreen element.
    let container = findContainer(video);
    if (applied && record.container && record.container.isConnected && containsDeep(record.container, video) && !containsDeep(container, record.container)) {
      container = record.container;
    }
    if (inAd(record, container)) {
      if (!applied) {
        // An ad before the video: nothing to protect yet.
        if (!record.adIdle || record.container !== container) observerDirty = true;
        record.adIdle = true;
        record.container = container;
        return;
      }
      // During an ad the guard stays on, but only for clocks that show the
      // video's own length; the ad's own clocks are left alone.
      if (!record.adMode) observerDirty = true;
      record.adMode = true;
      if (record.closePrompt) record.closePrompt();
      rewriteRecord(record);
      if (record.masked.size) unmask(record);
      return;
    }
    if (record.adMode) observerDirty = true;
    record.adMode = false;
    if (record.adIdle) observerDirty = true;
    record.adIdle = false;
    if (applied && !worthGuarding(record)) {
      setStatus(record, "idle");
      return;
    }
    record.contentDuration = video.duration;
    if (record.cancelled || cancelledKeys.has(record.key)) {
      setStatus(record, "cancelled");
      return;
    }

    // A site's video id comes from the address, which may still name the
    // previous video while the next one loads; mixing in the length keeps
    // that video's offset from carrying over to the next one.
    const seed = siteKeyed ? `${record.key}@len:${Math.round(record.keyDuration)}` : record.key;
    const offset = VSG.offsetSeconds(seed, salt, settings.minHours, settings.maxHours);
    // restore() and the rewrite below run in the same task, so nothing in
    // between is painted.
    if (record.status === "applied" && (offset !== record.offset || container !== record.container)) restore(record);
    if (record.status !== "applied" || container !== record.container) observerDirty = true;
    record.offset = offset;
    record.container = container;
    record.status = "applied";
    rewriteRecord(record);
    if (record.masked.size) unmask(record);
    hideProgress(record);
    maybeAsk(record);
    reportStatus();
  }

  // A different video now plays in this element. Its fakes are dropped
  // without writing the old real text back (that would show the previous
  // video's length until the page redraws); the page overwrites them.
  function changeKey(record, key) {
    if (record.closePrompt) record.closePrompt();
    removeFromQueue(record);
    if (record.key) askedKeys.delete(record.key);
    release(record);
    if (record.status === "applied") observerDirty = true;
    record.status = "idle";
    record.key = key;
    record.cancelled = false;
    record.asked = false;
    reportStatus();
  }

  function setStatus(record, status) {
    if (record.status === "applied" && status !== "applied") {
      if (record.closePrompt) record.closePrompt();
      restore(record);
      unmask(record);
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
    if (record.adMode) {
      // Only the video's own length is known during an ad.
      return { duration: record.contentDuration, offset: record.offset, currentTime: null, remainingUnsigned: false };
    }
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
    // A spot that showed time left before still does, even at the halfway
    // point where time left and elapsed time read the same.
    const spot = node.parentElement;
    const knownRemaining = !!spot && record.remainingSpots.has(spot);
    let result = VSG.rewriteClockDetailed(current, { ...ctx, knownRemaining });
    if (result === null && !ctx.remainingUnsigned && VSG.hasClock(current) && looksLikeRemaining(node)) {
      result = VSG.rewriteClockDetailed(current, { ...ctx, remainingUnsigned: true, knownRemaining: true });
    }
    if (result === null) {
      if (entry) record.texts.delete(node);
      return;
    }
    if (result.remaining && spot) record.remainingSpots.add(spot);
    writeText(record, node, current, result.text);
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

  // How close a label sits to a player: the depth of their nearest common
  // ancestor (deeper is closer).
  function closeness(label, container) {
    const depths = new Map();
    let depth = 0;
    for (let n = label; n; n = parentDeep(n)) depths.set(n, depth++);
    for (let n = container; n; n = parentDeep(n)) if (depths.has(n)) return depth - depths.get(n);
    return -1;
  }

  // Length labels that live outside the player container. Each label belongs
  // to the tracked player nearest to it in the page, so two players on one
  // page each keep their own label. Claims are re-checked every few seconds.
  function outsideLabels(record) {
    const site = decision.site;
    if (!site || !site.durationSelector) return [];
    const now = Date.now();
    const recheck = now - record.outsideCheckedAt >= OUTSIDE_LABEL_RECHECK_MS;
    const kept = record.outside.filter((l) => l.isConnected && !containsDeep(record.container, l));
    if (kept.length && !recheck) return kept;
    if (!recheck) return [];
    record.outsideCheckedAt = now;
    if (queryRoots(rootsFor(record, record.container), site.durationSelector).length) return [];
    let found = [];
    try {
      found = [...document.querySelectorAll(site.durationSelector)];
    } catch {
      return [];
    }
    if (!found.length) found = queryAllDeep(document, site.durationSelector);
    const players = [...records.values()].filter((r) => r.status !== "removed" && (r.container || r.video).isConnected);
    return found.filter((label) => {
      if (players.some((r) => r !== record && r.container && containsDeep(r.container, label))) return false;
      return nearestPlayer(label, players) === record;
    });
  }

  // The player a label belongs to: the one sharing its closest ancestor;
  // on a tie, the nearest player before it in the page (a title or length
  // line usually follows its player), else the first one.
  function nearestPlayer(label, players) {
    let best = [];
    let bestCloseness = -1;
    for (const r of players) {
      const c = closeness(label, r.container || r.video);
      if (c > bestCloseness) {
        best = [r];
        bestCloseness = c;
      } else if (c === bestCloseness) {
        best.push(r);
      }
    }
    if (best.length < 2) return best[0] || null;
    const before = best.filter((r) => (r.container || r.video).compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!before.length) return best[0];
    return before.reduce((a, b) => ((a.container || a.video).compareDocumentPosition(b.container || b.video) & Node.DOCUMENT_POSITION_FOLLOWING ? b : a));
  }

  function rewriteRecord(record) {
    if (record.status !== "applied" || !record.container) return;
    // Forget nodes the page has thrown away.
    for (const node of record.texts.keys()) if (!node.isConnected) record.texts.delete(node);
    for (const el of record.attrs.keys()) if (!el.isConnected) record.attrs.delete(el);
    const ctx = clockContext(record);
    rewriteSubtree(record, record.container, ctx);
    record.rootsAt = 0;
    const roots = rootsFor(record, record.container);
    // A shadow root appeared (or went) since the observer was set up.
    if (roots.length !== record.observed.length - record.outside.length || roots.some((r) => !record.observed.includes(r))) observerDirty = true;
    const outside = outsideLabels(record);
    if (outside.length !== record.outside.length || outside.some((l, i) => l !== record.outside[i])) {
      observerDirty = true;
      // Hand a dropped label back with its real text; the player it now
      // belongs to rewrites it with its own offset in this same pass.
      for (const label of record.outside) if (!outside.includes(label)) restoreWithin(record, label);
    }
    record.outside = outside;
    for (const label of record.outside) rewriteSubtree(record, label, ctx);
    if (!record.adMode) for (const label of labelsOf(record)) rewriteLabel(record, label);
  }

  // Puts back the real text this record wrote inside one subtree, so
  // another player can take that subtree over.
  function restoreWithin(record, root) {
    for (const [node, entry] of [...record.texts]) {
      if (!containsDeep(root, node)) continue;
      if (node.nodeValue === entry.fake) node.nodeValue = entry.original;
      record.texts.delete(node);
      if (textClaims.get(node) === record) textClaims.delete(node);
    }
  }

  // Forgets every rewrite without writing the real text back. Used when the
  // guard steps aside but will come back (an ad, a new video in the same
  // element), where showing the real text in between would give it away.
  function release(record) {
    for (const node of record.texts.keys()) if (textClaims.get(node) === record) textClaims.delete(node);
    record.texts.clear();
    for (const [el, map] of record.attrs) {
      const claims = attrClaims.get(el);
      if (claims) for (const name of map.keys()) if (claims.get(name) === record) claims.delete(name);
    }
    record.attrs.clear();
    record.outside = [];
    record.outsideCheckedAt = 0;
  }

  // While a new source loads, the player may already print the next video's
  // real length (it knows it from its own API) before the media reports it.
  // Such clocks are hidden until the metadata arrives, then rewritten.
  function maskWhileLoading(record, node) {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || record.masked.has(el)) return;
    const clock = VSG.lastClock(node.nodeType === Node.TEXT_NODE ? node.nodeValue : el.textContent);
    if (!clock || clock.value < Math.max(30, settings.minVideoMinutes * 60)) return; // "0:00" placeholders stay
    const entry = node.nodeType === Node.TEXT_NODE && record.texts.get(node);
    if (entry && entry.fake === node.nodeValue) return;
    record.masked.set(el, { value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") });
    el.style.setProperty("visibility", "hidden", "important");
    if (!record.maskedAt || record.masked.size === 1) record.maskedAt = Date.now();
  }

  function unmask(record) {
    for (const [el, prev] of record.masked) {
      if (prev.value) el.style.setProperty("visibility", prev.value, prev.priority);
      else el.style.removeProperty("visibility");
    }
    record.masked.clear();
    record.maskedAt = 0;
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
      record.observed = [];
      if (!record.container || (record.status !== "applied" && !record.adIdle)) continue;
      const options = record.status === "applied" ? APPLIED_OPTIONS : AD_OPTIONS;
      record.rootsAt = 0; // pick up shadow roots attached since the last walk
      const roots = rootsFor(record, record.container).slice();
      if (record.status === "applied") roots.push(...record.outside);
      for (const root of roots) observer.observe(root, options);
      record.observed = roots;
    }
  }

  function flushObserver() {
    if (observerDirty) rebuildObserver();
  }

  // The records a changed node may belong to, best first: the one that wrote
  // its fake, then players holding it from the innermost out. Players that
  // share one container are all included, the one already showing fakes
  // first, so a hidden ad or preload video can't take a label update away
  // from the video it belongs to.
  function ownersOf(node) {
    const claimed = textClaims.get(node);
    if (claimed && claimed.status === "applied") return [claimed];
    const holders = [];
    for (const record of records.values()) {
      if (!record.container || (record.status !== "applied" && !record.adIdle)) continue;
      const holds = containsDeep(record.container, node) || (record.status === "applied" && record.outside.some((l) => containsDeep(l, node)));
      if (holds) holders.push(record);
    }
    if (holders.length < 2) return holders;
    const depth = (r) => {
      let d = 0;
      for (let n = r.container; n; n = parentDeep(n)) d++;
      return d;
    };
    return holders.sort((a, b) => depth(b) - depth(a) || Number(rewrote(b)) - Number(rewrote(a)));
  }

  function handleMutation(record, m, reevaluate, progress) {
    if (record.status !== "applied") {
      reevaluate.add(record); // an ad marker may have gone away
      return;
    }
    if (m.type === "attributes" && m.attributeName === "class") {
      if (decision.site.adSelector) reevaluate.add(record); // an ad may have started
      return;
    }
    // A source is loading: hide any length the player prints until the
    // media's own length is known.
    if (Number.isNaN(record.video.duration) || record.video.readyState === 0) {
      if (m.type === "characterData") maskWhileLoading(record, m.target);
      else if (m.type === "childList") {
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) maskWhileLoading(record, added);
          else if (added.nodeType === Node.ELEMENT_NODE) walkTextNodes(added, (n) => maskWhileLoading(record, n));
        }
      }
      return;
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
            if (el.shadowRoot) observerDirty = true;
          });
          if (!record.adMode) for (const label of queryAllDeep(added, decision.site.durationSelector)) rewriteLabel(record, label);
        }
      }
      if (m.addedNodes.length && decision.site.hideProgress) progress.add(record);
    }
    if (m.type !== "attributes" && !record.adMode) {
      const label = labelContaining(record, m.target);
      if (label) rewriteLabel(record, label);
    }
  }

  // Runs as a microtask after the page changes the DOM and before the next
  // paint, so the real length never shows.
  function onMutations(mutations) {
    if (stopped) return;
    const reevaluate = new Set();
    const progress = new Set();
    for (const m of mutations) {
      for (const record of ownersOf(m.target)) handleMutation(record, m, reevaluate, progress);
    }
    for (const record of reevaluate) {
      // Only an ad starting or ending matters here.
      if (record.status === "applied" && inAd(record, record.container) === !!record.adMode) continue;
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
    if (!records.has(video)) resetScanBackoff();
    const record = track(video);
    if (event.type === "emptied" || event.type === "loadstart") {
      // A new source: keep the fakes on screen until its metadata arrives.
      record.reset = true;
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

  // Videos in the light DOM are found cheaply on every tick. Finding videos
  // inside shadow roots means walking the whole page, so that walk is cut
  // into slices of a few milliseconds (no long tasks on huge pages) and runs
  // less and less often, up to every 30 s, while it keeps finding nothing.
  const SCAN_SLICE_MS = 4;
  const SCAN_MIN_GAP_MS = 2000;
  const SCAN_MAX_GAP_MS = 30000;
  let deepScan = null; // { stack, videos, shadows }
  let scanGap = SCAN_MIN_GAP_MS;
  let nextScanAt = 0;
  let scanTimer = 0;

  function resetScanBackoff() {
    scanGap = SCAN_MIN_GAP_MS;
    nextScanAt = 0;
  }

  function startDeepScan() {
    if (deepScan || stopped || document.hidden || !document.documentElement) return;
    deepScan = { stack: [document.documentElement], videos: [], shadows: [] };
    scanSlice();
  }

  function scheduleSlice() {
    if (typeof requestIdleCallback === "function") scanTimer = requestIdleCallback(scanSlice, { timeout: 250 });
    else scanTimer = setTimeout(scanSlice, 16);
  }

  function scanSlice() {
    scanTimer = 0;
    const scan = deepScan;
    if (!scan || stopped) return;
    const end = performance.now() + SCAN_SLICE_MS;
    let visited = 0;
    while (scan.stack.length) {
      if ((++visited & 127) === 0 && performance.now() > end) {
        scheduleSlice();
        return;
      }
      const node = scan.stack.pop();
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === "VIDEO") scan.videos.push(node);
        const shadow = shadowOf(node);
        if (shadow) {
          scan.shadows.push(shadow);
          scan.stack.push(shadow);
        }
      }
      for (let child = node.lastElementChild; child; child = child.previousElementSibling) scan.stack.push(child);
    }
    deepScan = null;
    let found = 0;
    for (const root of scan.shadows) {
      if (!watchedRoots.has(root)) found++;
      watchRoot(root);
    }
    for (const video of scan.videos) {
      if (!video.isConnected || records.has(video)) continue;
      track(video);
      found++;
    }
    scanGap = found ? SCAN_MIN_GAP_MS : Math.min(scanGap * 2, SCAN_MAX_GAP_MS);
    nextScanAt = Date.now() + scanGap;
    if (found && active()) evaluateAll();
  }

  function stopDeepScan() {
    if (scanTimer) {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(scanTimer);
      clearTimeout(scanTimer);
    }
    scanTimer = 0;
    deepScan = null;
  }

  function discoverLight() {
    for (const video of document.querySelectorAll("video")) track(video);
  }

  function onUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    lastReported = null;
    resetScanBackoff();
    evaluateAll();
    reportStatus();
  }

  function tick() {
    if (!runtimeAlive()) {
      shutdown();
      return;
    }
    onUrlChange();
    if (!active()) return;
    discoverLight();
    if (Date.now() >= nextScanAt) startDeepScan();
    for (const record of [...records.values()]) {
      if (record.video.readyState >= 1 || record.status === "applied" || !record.video.isConnected) evaluate(record);
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
    if (record.video.paused || record.asked || askedKeys.has(record.key) || promptQueue.includes(record)) return;
    if (!rewrote(record)) return; // nothing on screen changed, e.g. built-in browser controls
    if (!bigEnough(record.video) && !inKnownPlayer(record.video)) return;
    record.asked = true;
    askedKeys.add(record.key);
    promptQueue.push(record);
    showNextPrompt();
  }

  function removeFromQueue(record) {
    const at = promptQueue.indexOf(record);
    if (at >= 0) promptQueue.splice(at, 1);
  }

  function forgetAsked(record) {
    record.asked = false;
    askedKeys.delete(record.key);
  }

  // A dialog waits while its tab is in the background, so its countdown
  // can't run out before the user has seen it.
  let waitingForVisible = false;
  function showWhenVisible() {
    if (waitingForVisible) return;
    waitingForVisible = true;
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      waitingForVisible = false;
      showNextPrompt();
    };
    document.addEventListener("visibilitychange", onVisible);
  }

  function showNextPrompt() {
    if (document.hidden && promptQueue.length && !promptOpen) {
      showWhenVisible();
      return;
    }
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
          remember(choice);
        }
        showNextPrompt();
      });
    }
  }

  // "Don't show this again": the button pressed (Keep hidden or Cancel) is
  // remembered for this website, for this browser session or permanently,
  // and the dialog stops appearing there.
  //   for this website: on a listed site, Keep stops the dialog and Cancel
  //     switches the site off; an unlisted site is added either way.
  //   for this session: the same, kept in session storage and forgotten
  //     when the browser closes.
  function remember(choice) {
    const writes = [];
    // Both options apply to the same site: its entry when one decides,
    // otherwise the page's host.
    const listed = decision.listed;
    const scope = decision.scopeHost || TOP_HOST;
    if (choice.website) {
      if (listed) writes.push(choice.cancel ? Store.setSiteEnabled(listed, false) : Store.setSiteAsk(listed, false));
      // Keep the protection the site had while it was auto-detected.
      else writes.push(Store.setCustomSite(scope, { enabled: !choice.cancel, ask: false, hideProgress: !!(decision.site && decision.site.hideProgress) }));
    }
    if (choice.session) {
      for (const domain of listed ? listed.domains : [scope]) writes.push(Store.setSessionChoice(domain, !choice.cancel));
    }
    for (const write of writes) {
      write.catch(() => {
        // Storage refused the write (quota); the dialog is already gone.
      });
    }
  }

  function rememberLabel() {
    const listed = decision.listed;
    if (listed) return listed.builtIn ? listed.name : listed.domains[0];
    return VSG.normalizeDomain(decision.scopeHost || TOP_HOST, { allowSingleLabel: true }) || "";
  }

  const PROMPT_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
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
    .options { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; }
    label { display: flex; gap: 8px; align-items: flex-start; color: var(--fg); cursor: pointer; }
    input { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent); }
    .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    button { font: inherit; font-weight: 600; min-height: 36px; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
    .cancel { background: transparent; color: var(--fg); border: 1px solid var(--line); }
    .keep { background: var(--accent); color: var(--accent-fg); border: 1px solid var(--accent); font-variant-numeric: tabular-nums; }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (max-height: 260px) {
      dialog { padding: 10px 12px; }
      h2 { font-size: 14px; margin: 0 0 2px; }
      p, label { font-size: 12.5px; line-height: 1.35; margin: 0 0 6px; }
      .options { gap: 2px; margin: 0 0 6px; }
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
    const option = (text) => {
      const box = document.createElement("input");
      box.type = "checkbox";
      const label = document.createElement("label");
      label.append(box, document.createTextNode(text));
      label.hidden = !where;
      return { box, label };
    };
    const forSession = option(`Don't show this again \u2013 for this session (${where})`);
    const forWebsite = option(`Don't show this again \u2013 for this website (${where})`);
    const options = document.createElement("div");
    options.className = "options";
    options.append(forSession.label, forWebsite.label);

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

    dialog.append(title, body, options, row);
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
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        dialog.close();
      } catch {
        // already closed
      }
      host.remove();
      const chosen = !interrupted && !!where;
      done({ cancel: cancelled, session: chosen && forSession.box.checked, website: chosen && forWebsite.box.checked, interrupted });
    };
    const startCountdown = () => {
      timer = setInterval(() => {
        left--;
        if (left <= 0) finish(false);
        else label();
      }, 1000);
    };
    if (left > 0) {
      if (document.hidden) timer = -1;
      else startCountdown();
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
      if (timer !== -1) clearInterval(timer);
      timer = 0;
      left = 0;
      label();
    };
    dialog.addEventListener("keydown", stopCountdown);
    dialog.addEventListener("pointerdown", stopCountdown);
    // Keys used in the dialog must not reach the page's shortcuts (Space
    // would also pause the video, arrows would seek it).
    for (const type of ["keydown", "keyup", "keypress"]) dialog.addEventListener(type, (e) => e.stopPropagation());
    // The countdown only runs while the tab is visible.
    const onVisibility = () => {
      if (!timer && left <= 0) return;
      if (document.hidden) {
        clearInterval(timer);
        timer = -1; // paused
      } else if (timer === -1) {
        timer = 0;
        startCountdown();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    cancel.addEventListener("click", () => finish(true));
    keep.addEventListener("click", () => finish(false));
    // Escape dismisses the dialog, which leaves the guard on.
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    // Closing because the guard was withdrawn writes nothing.
    record.closePrompt = (interrupted = true) => finish(false, interrupted);

    // The dialog only takes focus when this frame has it and nobody is
    // typing; otherwise (a field in use, or focus in another frame of the
    // page) it opens beside the page without taking keystrokes.
    const modal = document.hasFocus() && !isEditable(document.activeElement);
    // show() would move focus into the dialog, so a non-modal dialog is
    // opened by setting its attribute, which leaves focus where it is.
    const show = () => {
      try {
        if (modal) dialog.showModal();
        else dialog.setAttribute("open", "");
      } catch {
        dialog.setAttribute("open", "");
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
    if (area === "session") {
      if (!Object.keys(changes).some((k) => k.startsWith("session:"))) return;
      Store.loadSessionChoices()
        .then((choices) => {
          sessionChoices = choices;
          redecide();
        })
        .catch(() => {});
      return;
    }
    if (area !== "sync") return;
    Store.loadSettings()
      .then((loaded) => {
        settings = loaded;
        redecide();
      })
      .catch(() => {});
  }

  // Applies a change of settings or session choices to the page.
  function redecide() {
    const wasActive = active();
    decision = computeDecision();
    if (!wasActive && active()) {
      discoverLight();
      resetScanBackoff();
      startDeepScan();
    }
    evaluateAll();
    startTicking();
  }

  function onPageHide() {
    lastReported = null;
    send({ type: "vsg-status", guarding: false });
  }

  function onPageShow(event) {
    if (event.persisted) reportStatus();
  }

  // Coming back to the tab rescans soon, since the page may have changed.
  function onVisibilityChange() {
    if (document.hidden || !active()) return;
    resetScanBackoff();
  }

  // The Navigation API reports pushState/replaceState as they happen, so a
  // new address is seen before the next video's metadata, not up to a
  // second later.
  const navigationApi = globalThis.navigation;

  // Puts every page back the way it was. Used when this copy is orphaned by
  // an extension update or removal.
  function shutdown() {
    if (stopped) return;
    for (const record of [...records.values()]) untrack(record);
    stopped = true;
    clearInterval(tickTimer);
    stopDeepScan();
    observer.disconnect();
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, onMediaEvent, true);
    removeEventListener("pagehide", onPageHide);
    removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (navigationApi) navigationApi.removeEventListener("currententrychange", onUrlChange);
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
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (navigationApi && navigationApi.addEventListener) navigationApi.addEventListener("currententrychange", onUrlChange);
  chromeApi.storage.onChanged.addListener(onStorageChange);

  loadState()
    .then(() => {
      startTicking();
      if (active()) {
        discoverLight();
        startDeepScan();
        evaluateAll();
      }
    })
    .catch(() => {});
})();
