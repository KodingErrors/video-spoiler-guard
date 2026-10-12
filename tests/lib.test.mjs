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
  assert.deepEqual(s.builtins.twitch, { enabled: false, hideProgress: true });
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
  assert.equal(VSG.videoKey("", loc("https://example.org/a"), 2), "example.org/a#2");
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
