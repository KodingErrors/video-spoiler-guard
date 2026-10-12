// Pure logic shared by the content script, popup and options page. No DOM or
// chrome.* access here, so it can be unit tested in Node (see tests/).
//
// Loaded as a classic script: in the extension it defines globalThis.VSG, and
// under Node it is also exported through module.exports.
(function (root) {
  "use strict";

  // ---- Settings -----------------------------------------------------------

  const DEFAULTS = Object.freeze({
    autoDetect: true,        // guard videos on sites that are not in the list, after asking
    minHours: 2,             // smallest amount of fake time added
    maxHours: 6,             // largest amount of fake time added
    minVideoMinutes: 1,      // shorter videos are left alone (ads, previews, clips)
    confirmSeconds: 10,      // the auto-detect dialog keeps the guard on after this long; 0 = wait for a click
    autoHideProgress: false, // also hide progress bars on auto-detected sites
  });

  const LIMITS = Object.freeze({
    hours: [0, 48],
    minVideoMinutes: [0, 600],
    confirmSeconds: [0, 120],
  });

  // Built-in sites. Every site also gets the generic text matcher, so the
  // selectors only need to cover what that matcher cannot find on its own.
  //   playerSelector    closest ancestor of the <video> that holds its controls
  //   durationSelector  element whose text is the total length
  //   progressSelector  seek bar to make invisible when "Hide progress bar" is on
  //   adSelector        matches while an ad plays in the same <video> element
  //   remainingUnsigned the player shows time left without a leading minus sign
  const site = (id, name, domains, extra = {}) =>
    Object.freeze({
      id,
      name,
      domains: Object.freeze(domains),
      defaultEnabled: true,
      playerSelector: "",
      durationSelector: "",
      progressSelector: "",
      adSelector: "",
      remainingUnsigned: false,
      ...extra,
    });

  const BUILTIN_SITES = Object.freeze([
    // Desktop player (.ytp-*, incl. the 2025 "Delhi" redesign) and the newer
    // mobile/embed player (.ytw*, yt-progress-bar). Seek-bar hover tooltips
    // show the time under the pointer, so they hide with the bar.
    site("youtube", "YouTube", ["youtube.com", "youtube-nocookie.com"], {
      playerSelector: ".html5-video-player",
      durationSelector: ".ytp-time-duration, .ytwPlayerTimeDisplayTimeSecond",
      progressSelector: ".ytp-progress-bar-container, .ytp-tooltip.ytp-preview, .ytp-fine-scrubbing-container, yt-progress-bar",
      adSelector: ".ad-showing, .ad-interrupting",
    }),
    // data-a-target attributes are Twitch's test hooks and stable for years.
    site("twitch", "Twitch", ["twitch.tv"], {
      playerSelector: '[data-a-target="video-player"]',
      durationSelector: '[data-a-target="player-seekbar-duration"]',
      progressSelector: '[data-a-target="player-seekbar"], [data-test-selector="vod-seekbar-preview-overlay-wrapper"], .vod-seekbar-preview-overlay__wrapper',
      adSelector: '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]',
    }),
    site("kick", "Kick", ["kick.com"]),
    site("vimeo", "Vimeo", ["vimeo.com"]),
    site("dailymotion", "Dailymotion", ["dailymotion.com", "dai.ly"]),
    site("rumble", "Rumble", ["rumble.com"]),
    site("netflix", "Netflix", ["netflix.com"], { remainingUnsigned: true }),
    site("primevideo", "Prime Video", ["primevideo.com"]),
    site("disneyplus", "Disney+", ["disneyplus.com"]),
    site("max", "Max", ["max.com", "hbomax.com"]),
    site("hulu", "Hulu", ["hulu.com"]),
    site("crunchyroll", "Crunchyroll", ["crunchyroll.com"]),
    site("paramountplus", "Paramount+", ["paramountplus.com"]),
    site("peacock", "Peacock", ["peacocktv.com"]),
    site("facebook", "Facebook", ["facebook.com"]),
    site("x", "X (Twitter)", ["x.com", "twitter.com"]),
    site("reddit", "Reddit", ["reddit.com"]),
    site("bilibili", "Bilibili", ["bilibili.com"]),
  ]);

  function clampNumber(value, [min, max], fallback) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  // Selectors typed by people are tried with querySelectorAll inside a
  // try/catch in the content script; here we only bound their size.
  function cleanSelector(value) {
    return typeof value === "string" ? value.trim().slice(0, 500) : "";
  }

  // Settings live in chrome.storage.sync as flat keys so no single item gets
  // near the 8 KB per-item quota:
  //   autoDetect, minHours, maxHours, minVideoMinutes, confirmSeconds, autoHideProgress
  //   "builtin:<id>" -> { enabled, hideProgress }
  //   "site:<domain>" -> { enabled, hideProgress, durationSelector, progressSelector, addedAt }
  function normalizeSettings(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    let minHours = clampNumber(raw.minHours, LIMITS.hours, DEFAULTS.minHours);
    let maxHours = clampNumber(raw.maxHours, LIMITS.hours, DEFAULTS.maxHours);
    if (maxHours < minHours) [minHours, maxHours] = [maxHours, minHours];

    const builtins = {};
    for (const site of BUILTIN_SITES) {
      const o = raw["builtin:" + site.id] || {};
      builtins[site.id] = {
        enabled: bool(o.enabled, site.defaultEnabled !== false),
        hideProgress: bool(o.hideProgress, false),
      };
    }

    const customSites = [];
    for (const key of Object.keys(raw)) {
      if (!key.startsWith("site:")) continue;
      const domain = normalizeDomain(key.slice(5));
      const o = raw[key];
      if (!domain || !o || typeof o !== "object") continue;
      customSites.push({
        domain,
        enabled: bool(o.enabled, true),
        hideProgress: bool(o.hideProgress, false),
        durationSelector: cleanSelector(o.durationSelector),
        progressSelector: cleanSelector(o.progressSelector),
        addedAt: typeof o.addedAt === "number" ? o.addedAt : 0,
      });
    }
    customSites.sort((a, b) => a.domain.localeCompare(b.domain));

    return {
      autoDetect: bool(raw.autoDetect, DEFAULTS.autoDetect),
      minHours,
      maxHours,
      minVideoMinutes: clampNumber(raw.minVideoMinutes, LIMITS.minVideoMinutes, DEFAULTS.minVideoMinutes),
      confirmSeconds: Math.round(clampNumber(raw.confirmSeconds, LIMITS.confirmSeconds, DEFAULTS.confirmSeconds)),
      autoHideProgress: bool(raw.autoHideProgress, DEFAULTS.autoHideProgress),
      builtins,
      customSites,
    };
  }

  // One list of every site the user can toggle, built-ins first.
  function resolveSites(settings) {
    const builtins = BUILTIN_SITES.map((site) => ({
      ...site,
      builtIn: true,
      key: "builtin:" + site.id,
      enabled: settings.builtins[site.id].enabled,
      hideProgress: settings.builtins[site.id].hideProgress,
    }));
    const custom = settings.customSites.map((c) => ({
      id: "site:" + c.domain,
      key: "site:" + c.domain,
      name: c.domain,
      domains: [c.domain],
      builtIn: false,
      enabled: c.enabled,
      hideProgress: c.hideProgress,
      playerSelector: "",
      durationSelector: c.durationSelector,
      progressSelector: c.progressSelector,
      adSelector: "",
      remainingUnsigned: false,
    }));
    return builtins.concat(custom);
  }

  // ---- Domains ------------------------------------------------------------

  // Accepts "example.com", "www.example.com", "https://example.com/watch?x"
  // or "*.example.com" and returns "example.com", or null when it is not a
  // usable host name.
  function normalizeDomain(input) {
    if (typeof input !== "string") return null;
    let text = input.trim().toLowerCase();
    if (!text) return null;
    text = text.replace(/^\*\./, "");
    let host;
    try {
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : "http://" + text).hostname;
    } catch {
      return null;
    }
    host = host.replace(/\.$/, "").replace(/^www\./, "");
    if (!host || host.length > 253) return null;
    if (/^\[[0-9a-f:.]+\]$/.test(host)) return host; // IPv6 literal
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    if (host !== "localhost" && !host.includes(".")) return null;
    if (host.split(".").some((label) => label === "" || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
    return host;
  }

  function hostMatches(hostname, domain) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return host === domain || host.endsWith("." + domain);
  }

  // The most specific matching site wins; on a tie a site the user added
  // beats a built-in, so people can override a built-in for one subdomain.
  function findSite(sites, hostname) {
    let best = null;
    let bestLength = -1;
    for (const site of sites) {
      for (const domain of site.domains) {
        if (!hostMatches(hostname, domain)) continue;
        const better = domain.length > bestLength || (domain.length === bestLength && best && best.builtIn && !site.builtIn);
        if (better) {
          best = site;
          bestLength = domain.length;
        }
      }
    }
    return best;
  }

  const AUTO_SITE = Object.freeze({
    id: "auto",
    name: "Auto-detected",
    domains: [],
    builtIn: false,
    playerSelector: "",
    durationSelector: "",
    progressSelector: "",
    adSelector: "",
    remainingUnsigned: false,
  });

  // What the content script should do on this host:
  //   on   - listed and switched on: guard silently
  //   off  - listed and switched off: never touch the page
  //   auto - not listed, auto-detect on: guard, then ask in a dialog
  //   none - not listed, auto-detect off: do nothing
  function decide(settings, hostname) {
    const site = findSite(resolveSites(settings), hostname);
    if (site) return { mode: site.enabled ? "on" : "off", site };
    if (settings.autoDetect) {
      return { mode: "auto", site: { ...AUTO_SITE, hideProgress: settings.autoHideProgress } };
    }
    return { mode: "none", site: null };
  }

  // ---- Clock text ---------------------------------------------------------

  const two = (n) => String(n).padStart(2, "0");

  // Styles cover the clock formats players use:
  //   m   2:05 / 1:02:05   (hours appear only when needed; most players)
  //   mm  02:05 / 01:02:05 (zero-padded)
  //   h   0:02:05          (hours always shown)
  //   hh  00:02:05
  //   tm  62:05            (total minutes, no hours field)
  function formatClock(seconds, style) {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    switch (style) {
      case "h": return `${h}:${two(m)}:${two(s)}`;
      case "hh": return `${two(h)}:${two(m)}:${two(s)}`;
      case "mm": return h ? `${two(h)}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
      case "tm": return `${Math.floor(total / 60)}:${two(s)}`;
      default: return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
    }
  }

  const STYLES = ["m", "mm", "h", "hh", "tm"];

  // Players floor, round or ceil fractional durations, so try all three.
  function roundings(seconds) {
    return [...new Set([Math.floor(seconds), Math.round(seconds), Math.ceil(seconds)])].filter((n) => n >= 0);
  }

  // Map of clock text -> seconds value it shows, in every style.
  function clockVariants(values) {
    const out = new Map();
    for (const value of values) {
      for (const style of STYLES) {
        const text = formatClock(value, style);
        if (!out.has(text)) out.set(text, { value, style });
      }
    }
    return out;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Rewrites every clock in `text` that shows the real total length (and,
  // when currentTime is given, the real time remaining) so it includes the
  // offset. Returns the new text, or null when nothing matched.
  //
  // Matches are whole clock tokens: "3:45:10" is never matched inside
  // "13:45:10" or "3:45:10:00". Remaining time needs a leading minus sign
  // unless `remainingUnsigned` is set, because an unsigned remaining clock is
  // indistinguishable from elapsed time.
  function rewriteClockText(text, { duration, offset, currentTime = null, remainingUnsigned = false }) {
    if (typeof text !== "string" || !text || !(duration > 0) || !(offset > 0)) return null;
    if (!/\d:\d\d/.test(text)) return null;

    const totals = clockVariants(roundings(duration));
    const remaining = new Map();
    if (typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime > 0 && currentTime < duration) {
      const left = duration - currentTime;
      const values = new Set();
      for (const v of roundings(left)) for (const d of [-1, 0, 1]) if (v + d >= 0) values.add(v + d);
      for (const [clock, info] of clockVariants([...values])) {
        if (!totals.has(clock)) remaining.set(clock, info);
      }
    }

    const tokens = [];
    for (const clock of totals.keys()) tokens.push(clock);
    for (const clock of remaining.keys()) tokens.push("-" + clock, "\u2212" + clock);
    if (remainingUnsigned) for (const clock of remaining.keys()) tokens.push(clock);
    tokens.sort((a, b) => b.length - a.length);

    const pattern = new RegExp(`(?<![\\d:.])(?:${tokens.map(escapeRegExp).join("|")})(?![\\d:])`, "g");
    let changed = false;
    const result = text.replace(pattern, (match) => {
      const sign = match[0] === "-" || match[0] === "\u2212" ? match[0] : "";
      const clock = sign ? match.slice(1) : match;
      const info = sign ? remaining.get(clock) : totals.get(clock) || remaining.get(clock);
      if (!info) return match;
      changed = true;
      return sign + formatClock(info.value + offset, info.style);
    });
    return changed ? result : null;
  }

  const CLOCK_TOKEN = /(?<![\d:.])([-−]?)(?:(\d{1,3}):)?(\d{1,3}):(\d{2})(?![\d:])/g;

  // Reads one clock token ("1:02:05", "01:02:05", "62:05", "-12:34") into
  // its value in seconds and the style it was written in.
  function parseClock(token) {
    CLOCK_TOKEN.lastIndex = 0;
    const m = CLOCK_TOKEN.exec(token);
    if (!m) return null;
    const [, sign, hours, minutes, seconds] = m;
    if (Number(seconds) > 59) return null;
    let style;
    if (hours !== undefined) {
      if (Number(minutes) > 59) return null;
      style = hours.length === 2 && hours[0] === "0" ? "hh" : "h";
    } else if (Number(minutes) >= 60) {
      style = "tm";
    } else {
      style = minutes.length === 2 && minutes[0] === "0" ? "mm" : "m";
    }
    const value = Number(hours || 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    return { sign, value, style };
  }

  // For an element the site is known to use as its duration label: adds the
  // offset to the LAST clock in the text, whatever value it shows. Used when
  // <video>.duration and the label disagree (YouTube's server-side ads make
  // the media longer than the video). Returns null when there is no clock.
  function rewriteLastClock(text, offset) {
    if (typeof text !== "string" || !(offset > 0)) return null;
    let last = null;
    CLOCK_TOKEN.lastIndex = 0;
    for (let m = CLOCK_TOKEN.exec(text); m; m = CLOCK_TOKEN.exec(text)) last = { index: m.index, token: m[0] };
    if (!last) return null;
    const clock = parseClock(last.token);
    if (!clock) return null;
    const fake = clock.sign + formatClock(clock.value + offset, clock.style);
    return text.slice(0, last.index) + fake + text.slice(last.index + last.token.length);
  }

  function hasClock(text) {
    CLOCK_TOKEN.lastIndex = 0;
    return typeof text === "string" && CLOCK_TOKEN.test(text);
  }

  // True when the text holds a clock showing this duration (used to find
  // progress sliders whose aria-valuetext names the length).
  function mentionsDuration(text, duration) {
    if (typeof text !== "string" || !(duration > 0)) return false;
    for (const clock of clockVariants(roundings(duration)).keys()) {
      if (new RegExp(`(?<![\\d:.])${escapeRegExp(clock)}(?![\\d:])`).test(text)) return true;
    }
    return false;
  }

  // ---- Per-video identity and offset -------------------------------------

  const TRACKING_PARAMS = /^(utm_.*|t|time|start|si|feature|fbclid|gclid|ref|ref_src|ab_channel|pp|list|index|autoplay|muted|mute)$/i;

  // A stable id for the video playing at this location, so it always gets
  // the same fake length. `loc` is { hostname, pathname, search }.
  function videoKey(siteId, loc, index = 0) {
    const host = String(loc.hostname || "").toLowerCase().replace(/^www\./, "");
    const path = loc.pathname || "/";
    const params = new URLSearchParams(loc.search || "");
    let id = null;
    switch (siteId) {
      case "youtube": {
        const m = path.match(/^\/(?:embed|shorts|live|v|e)\/([\w-]{6,})/);
        id = path === "/watch" ? params.get("v") : m && m[1];
        if (id) id = "youtube:" + id;
        break;
      }
      case "twitch": {
        const vod = path.match(/^\/videos\/(\d+)/) || (params.get("video") || "").match(/^v?(\d+)$/);
        const clip = path.match(/\/clip\/([\w-]+)/) || (host.startsWith("clips.") && path.match(/^\/([\w-]+)/)) || (params.get("clip") || "").match(/^([\w-]+)$/);
        if (vod) id = "twitch:v" + vod[1];
        else if (clip) id = "twitch:c" + clip[1];
        break;
      }
      case "vimeo": {
        const m = path.match(/(?:^|\/)(\d{5,})(?:\/|$)/);
        if (m) id = "vimeo:" + m[1];
        break;
      }
      case "dailymotion": {
        const m = path.match(/\/video\/([a-z0-9]+)/i) || (params.get("video") || "").match(/^([a-z0-9]+)$/i);
        if (m) id = "dailymotion:" + m[1];
        break;
      }
      case "kick": {
        const m = path.match(/\/videos?\/([0-9a-f-]{8,})/i);
        if (m) id = "kick:" + m[1];
        break;
      }
      default:
        break;
    }
    if (!id) {
      const kept = [...params.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
      const query = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
      id = host + path.replace(/\/+$/, "") + query;
    }
    return index > 0 ? `${id}#${index}` : id;
  }

  // cyrb53: a small, well-mixed 53-bit string hash.
  function hash53(text, seed = 0) {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  // The fake time for a video is derived from its key and a random salt kept
  // in local storage: the same video always gets the same offset (no lookup,
  // so nothing flashes while waiting on storage), but nobody can predict it.
  // "Pick new fake lengths" in the options replaces the salt.
  function offsetSeconds(key, salt, minHours, maxHours) {
    const fraction = hash53(String(salt) + "|" + key) / 2 ** 53;
    const min = Math.round(minHours * 3600);
    const max = Math.round(maxHours * 3600);
    return min + Math.round(fraction * (max - min));
  }

  function randomSalt() {
    const bytes = new Uint8Array(16);
    root.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function describeHours(minHours, maxHours) {
    const h = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));
    if (minHours === maxHours) return `${h(minHours)} hour${minHours === 1 ? "" : "s"}`;
    return `${h(minHours)} to ${h(maxHours)} hours`;
  }

  const VSG = Object.freeze({
    DEFAULTS,
    LIMITS,
    BUILTIN_SITES,
    AUTO_SITE,
    normalizeSettings,
    resolveSites,
    normalizeDomain,
    hostMatches,
    findSite,
    decide,
    formatClock,
    rewriteClockText,
    rewriteLastClock,
    parseClock,
    hasClock,
    mentionsDuration,
    videoKey,
    hash53,
    offsetSeconds,
    randomSalt,
    describeHours,
  });

  root.VSG = VSG;
  if (typeof module === "object" && module.exports) module.exports = VSG;
})(typeof globalThis !== "undefined" ? globalThis : this);
