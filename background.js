// Service worker: creates the per-install salt for fake lengths, injects the
// guard into tabs that were already open when the extension was installed or
// updated, and shows an "ON" badge on tabs where a video is being guarded.
"use strict";

importScripts("lib.js");

const CONTENT_SCRIPTS = ["lib.js", "storage.js", "content.js"];

// "Don't show this again – for this session" choices live in session
// storage, which is cleared when the browser closes. Content scripts can
// only read it once the extension allows that, on every worker start.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
// Starting with the browser grants that access before restored tabs need it.
chrome.runtime.onStartup.addListener(() => {});

// Content scripts that run before access is granted read and write their
// session choices through here instead.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || !sender.tab) return false;
  if (message.type === "vsg-session-get") {
    chrome.storage.session.get(null).then(reply, () => reply({}));
    return true;
  }
  if (message.type === "vsg-session-set" && typeof message.key === "string" && message.key.startsWith("session:")) {
    chrome.storage.session.set({ [message.key]: message.value }).then(() => reply(true), () => reply(false));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { salt } = await chrome.storage.local.get("salt");
  if (!salt) await chrome.storage.local.set({ salt: globalThis.VSG.randomSalt() });

  // Chrome only runs manifest content scripts in pages loaded after install,
  // so open tabs would otherwise stay unguarded until reloaded. After an
  // update the old copy in each tab notices it is orphaned and steps aside.
  if (reason !== "install" && reason !== "update") return;
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_SCRIPTS })
      .catch(() => {
        // Pages the extension can't script, such as the Chrome Web Store.
      });
  }
});

// Which frames of each tab are guarding a video, kept in session storage
// because the service worker is stopped when idle and would forget a Map.
const badgeKey = (tabId) => `badge:${tabId}`;

async function guardingFrames(tabId) {
  const stored = (await chrome.storage.session.get(badgeKey(tabId)))[badgeKey(tabId)];
  return new Set(Array.isArray(stored) ? stored : []);
}

async function saveFrames(tabId, frames) {
  if (frames.size) await chrome.storage.session.set({ [badgeKey(tabId)]: [...frames] });
  else await chrome.storage.session.remove(badgeKey(tabId));
}

function paintBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#5b3fd6" }).catch(() => {});
}

// Reports from one tab are applied one after another, so two frames
// reporting at once can't overwrite each other's update.
const queues = new Map();
function inOrder(tabId, work) {
  const next = (queues.get(tabId) || Promise.resolve()).then(work, work);
  queues.set(tabId, next.catch(() => {}));
  return next;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "vsg-status" || !sender.tab) return;
  const tabId = sender.tab.id;
  inOrder(tabId, async () => {
    const frames = await guardingFrames(tabId);
    if (message.guarding) frames.add(sender.frameId);
    else frames.delete(sender.frameId);
    await saveFrames(tabId, frames);
    paintBadge(tabId, frames.size > 0);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inOrder(tabId, () => chrome.storage.session.remove(badgeKey(tabId)))
    .catch(() => {})
    .finally(() => queues.delete(tabId));
});

// A new page in the tab starts with no guarded frames; content scripts
// report again after loads and same-page navigations.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading") return;
  inOrder(tabId, async () => {
    await chrome.storage.session.remove(badgeKey(tabId));
    paintBadge(tabId, false);
  }).catch(() => {});
});
