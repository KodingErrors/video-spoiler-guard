// Unit tests for the pure logic in lib.js. Run: node --test video-spoiler-guard/tests/
import test from "node:test";
import assert from "node:assert/strict";

await import("../lib.js");
const VSG = globalThis.VSG;

test("formatClock covers every player style", () => {
  assert.equal(VSG.formatClock(125, "m"), "2:05");
  assert.equal(VSG.formatClock(125, "mm"), "02:05");
  assert.equal(VSG.formatClock(125, "h"), "0:02:05");
  assert.equal(VSG.formatClock(125, "hh"), "00:02:05");
  assert.equal(VSG.formatClock(3725, "m"), "1:02:05");
  assert.equal(VSG.formatClock(3725, "mm"), "01:02:05");
  assert.equal(VSG.formatClock(3725, "tm"), "62:05");
  assert.equal(VSG.formatClock(3725.9, "m"), "1:02:05");
});

const ctx = (extra = {}) => ({ duration: 3725, offset: 7200, ...extra });

test("rewrites the total length in a combined time display", () => {
  assert.equal(VSG.rewriteClockText("0:12:34 / 1:02:05", ctx()), "0:12:34 / 3:02:05");
  assert.equal(VSG.rewriteClockText("1:02:05", ctx()), "3:02:05");
});

test("keeps the player's own style", () => {
  assert.equal(VSG.rewriteClockText("01:02:05", ctx()), "03:02:05");
  assert.equal(VSG.rewriteClockText("62:05", ctx()), "182:05");
  assert.equal(VSG.rewriteClockText("2:05", { duration: 125, offset: 7200 }), "2:02:05");
  assert.equal(VSG.rewriteClockText("0:02:05", { duration: 125, offset: 7200 }), "2:02:05");
  assert.equal(VSG.rewriteClockText("02:05", { duration: 125, offset: 7200 }), "02:02:05");
});

test("only matches whole clock tokens", () => {
  assert.equal(VSG.rewriteClockText("11:02:05", ctx()), null);
  assert.equal(VSG.rewriteClockText("1:02:05:00", ctx()), null);
  assert.equal(VSG.rewriteClockText("at 21:02:05 today", ctx()), null);
  assert.equal(VSG.rewriteClockText("1:02:06", { duration: 3725.2, offset: 7200 }), "3:02:06", "ceil of a fractional length");
  assert.equal(VSG.rewriteClockText("no clock here", ctx()), null);
});

test("is idempotent: rewritten text never matches again", () => {
  const once = VSG.rewriteClockText("0:12:34 / 1:02:05", ctx());
  assert.equal(VSG.rewriteClockText(once, ctx()), null);
});

test("rewrites signed remaining time and, when asked, unsigned remaining time", () => {
  // 3725 - 725 = 3000 s left = 50:00
  assert.equal(VSG.rewriteClockText("-50:00", ctx({ currentTime: 725 })), "-2:50:00");
  assert.equal(VSG.rewriteClockText("−50:00", ctx({ currentTime: 725 })), "−2:50:00");
  assert.equal(VSG.rewriteClockText("-49:59", ctx({ currentTime: 725.4 })), "-2:49:59", "one second of drift");
  assert.equal(VSG.rewriteClockText("50:00", ctx({ currentTime: 725 })), null, "unsigned is elapsed time by default");
  assert.equal(VSG.rewriteClockText("50:00", ctx({ currentTime: 725, remainingUnsigned: true })), "2:50:00");
});

test("does nothing without a usable duration or offset", () => {
  assert.equal(VSG.rewriteClockText("1:02:05", { duration: Infinity, offset: 7200 }), null);
  assert.equal(VSG.rewriteClockText("1:02:05", { duration: 3725, offset: 0 }), null);
  assert.equal(VSG.rewriteClockText("", ctx()), null);
});

test("mentionsDuration finds a length inside label text", () => {
  assert.equal(VSG.mentionsDuration("0:10 of 1:02:05", 3725), true);
  assert.equal(VSG.mentionsDuration("0:10 of 11:02:05", 3725), false);
});

test("normalizeDomain accepts hosts and links and rejects junk", () => {
  assert.equal(VSG.normalizeDomain("Example.com"), "example.com");
  assert.equal(VSG.normalizeDomain("www.example.com"), "example.com");
  assert.equal(VSG.normalizeDomain("https://www.example.com/watch?v=1"), "example.com");
  assert.equal(VSG.normalizeDomain("*.example.com"), "example.com");
  assert.equal(VSG.normalizeDomain("video.example.co.uk."), "video.example.co.uk");
  assert.equal(VSG.normalizeDomain("localhost"), "localhost");
  assert.equal(VSG.normalizeDomain("bücher.de"), "xn--bcher-kva.de");
  assert.equal(VSG.normalizeDomain("not a site"), null);
  assert.equal(VSG.normalizeDomain("example"), null);
  assert.equal(VSG.normalizeDomain(""), null);
  assert.equal(VSG.normalizeDomain(42), null);
});

test("normalizeSettings applies defaults and limits", () => {
  const s = VSG.normalizeSettings({});
  assert.equal(s.autoDetect, true);
  assert.equal(s.minHours, 2);
  assert.equal(s.maxHours, 6);
  assert.equal(s.builtins.youtube.enabled, true);
  assert.deepEqual(s.customSites, []);

  const t = VSG.normalizeSettings({ minHours: 9, maxHours: 3, confirmSeconds: 999, minVideoMinutes: "abc" });
  assert.equal(t.minHours, 3);
  assert.equal(t.maxHours, 9);
  assert.equal(t.confirmSeconds, 120);
  assert.equal(t.minVideoMinutes, VSG.DEFAULTS.minVideoMinutes);
});

test("normalizeSettings reads per-site keys and skips bad ones", () => {
  const s = VSG.normalizeSettings({
    "builtin:twitch": { enabled: false, hideProgress: true },
    "site:www.Example.com": { enabled: false, durationSelector: " .dur " },
    "site:not a site": { enabled: true },
    "site:broken.example": "nope",
  });
  assert.deepEqual(s.builtins.twitch, { enabled: false, ask: true, hideProgress: true });
  assert.equal(s.customSites.length, 1);
  assert.equal(s.customSites[0].domain, "example.com");
  assert.equal(s.customSites[0].enabled, false);
  assert.equal(s.customSites[0].durationSelector, ".dur");
});

test("findSite matches subdomains and prefers the most specific entry", () => {
  const settings = VSG.normalizeSettings({ "site:gaming.youtube.com": { enabled: false }, "site:youtube.com": { enabled: false } });
  const sites = VSG.resolveSites(settings);
  assert.equal(VSG.findSite(sites, "www.youtube.com").key, "site:youtube.com", "an added site overrides the built-in");
  assert.equal(VSG.findSite(sites, "gaming.youtube.com").key, "site:gaming.youtube.com");
  assert.equal(VSG.findSite(sites, "player.twitch.tv").id, "twitch");
  assert.equal(VSG.findSite(sites, "notyoutube.com"), null);
});

test("decide picks on, off, auto or none", () => {
  const base = VSG.normalizeSettings({ "builtin:twitch": { enabled: false } });
  assert.equal(VSG.decide(base, "www.youtube.com").mode, "on");
  assert.equal(VSG.decide(base, "www.twitch.tv").mode, "off");
  assert.equal(VSG.decide(base, "example.org").mode, "auto");
  assert.equal(VSG.decide(VSG.normalizeSettings({ autoDetect: false }), "example.org").mode, "none");
  assert.equal(VSG.decide(VSG.normalizeSettings({ autoHideProgress: true }), "example.org").site.hideProgress, true);
});

test("videoKey finds the video id per site and ignores tracking params", () => {
  const loc = (href) => new URL(href);
  assert.equal(VSG.videoKey("youtube", loc("https://www.youtube.com/watch?v=abcDEF12345&t=30s")), "youtube:abcDEF12345");
  assert.equal(VSG.videoKey("youtube", loc("https://www.youtube-nocookie.com/embed/abcDEF12345?start=4")), "youtube:abcDEF12345");
  assert.equal(VSG.videoKey("youtube", loc("https://m.youtube.com/watch?v=abcDEF12345")), "youtube:abcDEF12345");
  assert.equal(VSG.videoKey("twitch", loc("https://www.twitch.tv/videos/123456789?t=1h2m")), "twitch:v123456789");
  assert.equal(VSG.videoKey("twitch", loc("https://player.twitch.tv/?video=v123456789&parent=x.com")), "twitch:v123456789");
  assert.equal(VSG.videoKey("twitch", loc("https://clips.twitch.tv/FancyClipSlug")), "twitch:cFancyClipSlug");
  assert.equal(VSG.videoKey("vimeo", loc("https://player.vimeo.com/video/76979871?h=abc")), "vimeo:76979871");
  assert.equal(VSG.videoKey("", loc("https://www.example.org/watch/42/?utm_source=x&id=7&t=10")), "example.org/watch/42?id=7");
  assert.equal(VSG.videoKey("", loc("https://example.org/a"), "len:3725"), "example.org/a@len:3725", "media tells apart videos on one page");
  assert.equal(VSG.videoKey("youtube", loc("https://www.youtube.com/watch?v=abcDEF12345"), "len:3725"), "youtube:abcDEF12345", "a site id ignores media");
  assert.equal(VSG.videoKey("netflix", loc("https://www.netflix.com/watch/81678254?trackId=1")), "netflix:81678254");
  assert.equal(VSG.videoKey("bilibili", loc("https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=a")), "bilibili:BV1xx411c7mDp2");
  assert.equal(VSG.videoKey("x", loc("https://x.com/someone/status/1790000000000000000/video/1")), "x:1790000000000000000");
  assert.equal(VSG.videoKey("vimeo", loc("https://vimeo.com/showcase/11223344/video/987654321")), "vimeo:987654321");
  assert.equal(VSG.videoKey("reddit", loc("https://www.reddit.com/")), "reddit.com", "a feed falls back to the page");
});

test("offsetSeconds is stable per video, inside the range, and changes with the salt", () => {
  const a = VSG.offsetSeconds("youtube:abc", "salt-1", 2, 6);
  assert.equal(a, VSG.offsetSeconds("youtube:abc", "salt-1", 2, 6));
  for (let i = 0; i < 500; i++) {
    const s = VSG.offsetSeconds("video-" + i, "salt-1", 2, 6);
    assert.ok(s >= 7200 && s <= 21600, `offset ${s} out of range`);
  }
  const spread = new Set(Array.from({ length: 200 }, (_, i) => Math.floor(VSG.offsetSeconds("v" + i, "s", 2, 6) / 3600)));
  assert.deepEqual([...spread].sort(), [2, 3, 4, 5], "offsets spread across the range");
  const differs = Array.from({ length: 20 }, (_, i) => VSG.offsetSeconds("v" + i, "salt-1", 2, 6) !== VSG.offsetSeconds("v" + i, "salt-2", 2, 6));
  assert.ok(differs.filter(Boolean).length >= 18);
  assert.equal(VSG.offsetSeconds("x", "s", 3, 3), 10800);
});

test("describeHours reads naturally", () => {
  assert.equal(VSG.describeHours(2, 6), "2 to 6 hours");
  assert.equal(VSG.describeHours(1, 1), "1 hour");
  assert.equal(VSG.describeHours(1.5, 2.5), "1.5 to 2.5 hours");
});

test("parseClock reads value and style", () => {
  assert.deepEqual(VSG.parseClock("1:02:05"), { sign: "", value: 3725, style: "h" });
  assert.deepEqual(VSG.parseClock("01:02:05"), { sign: "", value: 3725, style: "hh" });
  assert.deepEqual(VSG.parseClock("62:05"), { sign: "", value: 3725, style: "tm" });
  assert.deepEqual(VSG.parseClock("02:05"), { sign: "", value: 125, style: "mm" });
  assert.deepEqual(VSG.parseClock("-2:05"), { sign: "-", value: 125, style: "m" });
  assert.equal(VSG.parseClock("1:75"), null);
  assert.equal(VSG.parseClock("hello"), null);
});

test("rewriteLastClock adds the offset to the label's last clock", () => {
  assert.equal(VSG.rewriteLastClock("1:00:00", 7200), "3:00:00");
  assert.equal(VSG.rewriteLastClock("0:05 / 0:19", 7200), "0:05 / 2:00:19");
  assert.equal(VSG.rewriteLastClock("01:00:00", 3600), "02:00:00");
  assert.equal(VSG.rewriteLastClock("-12:34", 7200), "-2:12:34");
  assert.equal(VSG.rewriteLastClock("Live", 7200), null);
  assert.equal(VSG.hasClock("Live"), false);
  assert.equal(VSG.hasClock("0:19"), true);
});


test("built-in sites start on and asking, and decide passes the ask option through", () => {
  const s = VSG.normalizeSettings({ "builtin:youtube": { ask: false } });
  assert.equal(VSG.decide(s, "www.youtube.com").site.ask, false);
  assert.equal(VSG.decide(s, "www.twitch.tv").site.ask, true);
  assert.equal(VSG.decide(s, "example.org").site.ask, true);
  const c = VSG.normalizeSettings({ "site:example.org": { enabled: true, ask: false } });
  assert.equal(VSG.decide(c, "video.example.org").site.ask, false);
  assert.ok(!VSG.BUILTIN_SITES.some((b) => b.id === "disneyplus"), "Disney+ reports no length, so it isn't offered");
});

test("en-dash remaining time and four-digit minute clocks", () => {
  assert.equal(VSG.rewriteClockText("\u201350:00", { duration: 3725, offset: 7200, currentTime: 725 }), "\u20132:50:00");
  assert.deepEqual(VSG.parseClock("1260:00"), { sign: "", value: 75600, style: "tm" });
  assert.equal(VSG.rewriteLastClock("1260:00", 3600), "1320:00");
});

test("lastClock finds the last clock and where it is", () => {
  const c = VSG.lastClock("0:05 / 1:00:00");
  assert.equal(c.value, 3600);
  assert.equal(c.index, 7);
  assert.equal(VSG.lastClock("LIVE"), null);
});

test("at the halfway point an elapsed clock is never mistaken for time left", () => {
  const at = { duration: 3725, offset: 12345, currentTime: 1862.3, remainingUnsigned: true };
  // "elapsed / remaining" (Prime Video): only the last clock is time left.
  assert.equal(VSG.rewriteClockText("31:02 / 31:03", at), "31:02 / 3:56:48");
  // A lone clock that could be either is left alone...
  assert.equal(VSG.rewriteClockText("31:02", at), null);
  // ...unless that spot is known to show time left.
  assert.equal(VSG.rewriteClockText("31:02", { ...at, knownRemaining: true }), "3:56:47");
  // Away from the midpoint nothing changes.
  const early = { ...at, currentTime: 600 };
  assert.equal(VSG.rewriteClockText("10:00 / 52:05", early), "10:00 / 4:17:50");
  assert.equal(VSG.rewriteClockText("52:05", early), "4:17:50");
  assert.equal(VSG.rewriteClockDetailed("52:05", early).remaining, true);
  assert.equal(VSG.rewriteClockDetailed("1:02:05", early).remaining, false);
});

test("single-word hosts are accepted from page addresses but not when typed", () => {
  assert.equal(VSG.normalizeDomain("jellyfin"), null);
  assert.equal(VSG.normalizeDomain("jellyfin", { allowSingleLabel: true }), "jellyfin");
  assert.equal(VSG.normalizeDomain("http://jellyfin:8096/web/", { allowSingleLabel: true }), "jellyfin");
  assert.equal(VSG.normalizeDomain("media_server.lan"), "media_server.lan");
  const s = VSG.normalizeSettings({ "site:jellyfin": { enabled: false } });
  assert.equal(VSG.decide(s, "jellyfin").mode, "off");
});

test("a session choice overrides the site until the browser closes", () => {
  const s = VSG.normalizeSettings({});
  const choices = { "youtube.com": { guard: true }, "example.org": { guard: false } };
  const yt = VSG.applySessionChoice(VSG.decide(s, "www.youtube.com"), VSG.sessionChoiceFor(choices, "www.youtube.com"));
  assert.equal(yt.mode, "on");
  assert.equal(yt.site.ask, false, "no dialog for the rest of the session");
  assert.equal(yt.site.id, "youtube", "keeps the site's player knowledge");
  const ex = VSG.applySessionChoice(VSG.decide(s, "videos.example.org"), VSG.sessionChoiceFor(choices, "videos.example.org"));
  assert.equal(ex.mode, "off");
  // A site switched off stays off; auto-detect off leaves unlisted sites alone.
  const off = VSG.normalizeSettings({ "builtin:youtube": { enabled: false } });
  assert.equal(VSG.applySessionChoice(VSG.decide(off, "www.youtube.com"), { guard: true }).mode, "off");
  const none = VSG.normalizeSettings({ autoDetect: false });
  assert.equal(VSG.applySessionChoice(VSG.decide(none, "example.net"), { guard: true }).mode, "none");
  assert.equal(VSG.sessionChoiceFor(choices, "twitch.tv"), null);
});
