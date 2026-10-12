// Service worker: creates the per-install salt for fake lengths and shows an
// "ON" badge on tabs where a video is being guarded.
"use strict";

importScripts("lib.js");

chrome.runtime.onInstalled.addListener(async () => {
  const { salt } = await chrome.storage.local.get("salt");
  if (!salt) await chrome.storage.local.set({ salt: globalThis.VSG.randomSalt() });
});

// tabId -> Set of frameIds currently guarding a video. Lost when the worker
// sleeps, which only matters if a tab has several guarding frames.
const guardingFrames = new Map();

function paintBadge(tabId) {
  const on = (guardingFrames.get(tabId) || new Set()).size > 0;
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#5b3fd6" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "vsg-status" || !sender.tab) return;
  const tabId = sender.tab.id;
  const frames = guardingFrames.get(tabId) || new Set();
  if (message.guarding) frames.add(sender.frameId);
  else frames.delete(sender.frameId);
  guardingFrames.set(tabId, frames);
  paintBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => guardingFrames.delete(tabId));

// A new page in the tab starts with no guarded frames; its content script
// reports again once it guards something.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading") return;
  guardingFrames.delete(tabId);
  paintBadge(tabId);
});
