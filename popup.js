// Toolbar popup: this site's setting, the auto-detect switch, the site list
// and a box for adding sites.
(async function () {
  "use strict";

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const { siteRow, addSite, reportError, preserveScroll } = globalThis.VSGUI;
  const $ = (id) => document.getElementById(id);

  const errorBox = $("add-error");
  let settings = await Store.loadSettings();

  // The active tab's host. "activeTab" grants the URL while the popup is open.
  let host = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    host = null;
  }

  const PILL = {
    on: ["on", "Guarding"],
    off: ["off", "Off"],
    auto: ["auto", "Auto-detect"],
    none: ["none", "Not guarded"],
  };

  function hintFor(decision) {
    const hours = VSG.describeHours(settings.minHours, settings.maxHours);
    switch (decision.mode) {
      case "on": return `Videos here always show their length plus ${hours}. No dialog.`;
      case "off": return "Videos here are never changed, even with auto-detect on.";
      case "auto": return "Not in your list. When a video plays, the guard turns on and a dialog lets you cancel.";
      default: return "Not in your list, and auto-detect is off, so videos here aren't changed.";
    }
  }

  function renderHere() {
    $("here").hidden = !host;
    $("here-unsupported").hidden = !!host;
    if (!host) return;
    const decision = VSG.decide(settings, host);
    const site = decision.site && decision.site.id !== "auto" ? decision.site : null;
    const domain = VSG.normalizeDomain(host) || host;
    $("here-host").textContent = site && site.builtIn ? `${site.name} (${domain})` : domain;
    const [cls, text] = PILL[decision.mode];
    const pill = $("here-pill");
    pill.className = "pill " + cls;
    pill.textContent = text;
    $("here-hint").textContent = hintFor(decision);
    // Built-in sites are always listed, so they are only on or off.
    $("here-auto-wrap").hidden = !!(site && site.builtIn);
    const value = site ? (site.enabled ? "on" : "off") : "auto";
    for (const input of document.querySelectorAll('input[name="here"]')) input.checked = input.value === value;
  }

  function renderSites() {
    const list = $("sites");
    preserveScroll(list, () => {
      list.replaceChildren(...VSG.resolveSites(settings).map((site) => siteRow(site, { errorTarget: errorBox })));
    });
  }

  function render() {
    renderHere();
    $("auto-detect").checked = settings.autoDetect;
    renderSites();
    $("range").textContent = `Adds ${VSG.describeHours(settings.minHours, settings.maxHours)}`;
  }

  $("here-choice").addEventListener("change", (e) => {
    if (!host) return;
    const site = VSG.findSite(VSG.resolveSites(settings), host);
    const choice = e.target.value;
    let write;
    if (choice === "auto") write = site && !site.builtIn ? Store.removeCustomSite(site.domains[0]) : Promise.resolve();
    else if (site) write = Store.setSiteEnabled(site, choice === "on");
    else write = Store.setCustomSite(host, { enabled: choice === "on" });
    write.catch((err) => reportError(errorBox, err));
  });

  $("auto-detect").addEventListener("change", (e) => {
    Store.setGlobal({ autoDetect: e.target.checked }).catch((err) => reportError(errorBox, err));
  });

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("add-domain");
    errorBox.textContent = "";
    try {
      const message = await addSite(input.value, settings);
      errorBox.textContent = message;
      if (!message) input.value = "";
    } catch (err) {
      reportError(errorBox, err);
    }
  });

  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;
    settings = await Store.loadSettings();
    render();
  });

  render();
})();
