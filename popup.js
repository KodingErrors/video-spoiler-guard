// Toolbar popup: this site's setting, the auto-detect switch, the site list
// and a box for adding sites.
(async function () {
  "use strict";

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const { siteRow, addSite, reportError, rerenderList } = globalThis.VSGUI;
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

  function asks(decision) {
    if (!settings.autoDetect) return false;
    return decision.mode === "auto" || (decision.mode === "on" && decision.site.ask !== false);
  }

  function hintFor(decision) {
    const hours = VSG.describeHours(settings.minHours, settings.maxHours);
    switch (decision.mode) {
      case "on":
        return asks(decision)
          ? `Videos here show their length plus ${hours}, and a dialog lets you cancel when one starts.`
          : `Videos here always show their length plus ${hours}. No dialog.`;
      case "off": return "Videos here are never changed, even with auto-detect on.";
      case "auto": return "Not in your list, so auto-detect covers it: the guard turns on when a video plays, and a dialog lets you cancel.";
      default: return "Not in your list, and auto-detect is off, so videos here aren't changed.";
    }
  }

  // What "Default" leads to: removing an added entry hands the host to a
  // parent entry if there is one (e.g. YouTube for gaming.youtube.com),
  // otherwise to auto-detect.
  function defaultLabel(site) {
    let fallback = settings;
    if (site && !site.builtIn) {
      fallback = { ...settings, customSites: settings.customSites.filter((c) => c.domain !== site.domains[0]) };
    }
    const result = VSG.decide(fallback, host);
    if (result.mode === "auto") return "Default (ask)";
    if (result.mode === "none") return "Default (off)";
    const name = result.site.builtIn ? result.site.name : result.site.domains[0];
    return `Default (${name}: ${result.mode})`;
  }

  function renderHere() {
    $("here").hidden = !host;
    $("here-unsupported").hidden = !!host;
    if (!host) return;
    const decision = VSG.decide(settings, host);
    const site = decision.mode === "on" || decision.mode === "off" ? decision.site : null;
    const domain = VSG.normalizeDomain(host) || host;
    // Name the entry that applies, which may be a parent domain.
    const entry = site ? (site.builtIn ? site.name : site.domains[0]) : null;
    $("here-host").textContent = entry && entry !== domain ? `${entry} (${domain})` : domain;
    const [cls, text] = PILL[decision.mode];
    const pill = $("here-pill");
    pill.className = "pill " + cls;
    pill.textContent = text;
    $("here-hint").textContent = hintFor(decision);
    // Built-in sites are always listed, so they are only on or off. The third
    // choice removes an added site, which hands it back to auto-detect.
    $("here-auto-wrap").hidden = !!(site && site.builtIn);
    $("here-auto-label").textContent = defaultLabel(site);
    const value = site ? (site.enabled ? "on" : "off") : "auto";
    for (const input of document.querySelectorAll('input[name="here"]')) input.checked = input.value === value;
    // The dialog option only matters for a listed site that is on.
    $("here-ask-row").hidden = !(site && site.enabled && settings.autoDetect);
    $("here-ask").checked = !!(site && site.ask !== false);
  }

  function renderSites() {
    const list = $("sites");
    rerenderList(list, () => {
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
    $("here-error").textContent = "";
    write.catch((err) => {
      reportError($("here-error"), err);
      renderHere(); // put the choice back to what is actually saved
    });
  });

  $("here-ask").addEventListener("change", (e) => {
    const site = host && VSG.findSite(VSG.resolveSites(settings), host);
    if (site) {
      Store.setSiteAsk(site, e.target.checked).catch((err) => {
        reportError($("here-error"), err);
        renderHere();
      });
    }
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
