// Toolbar popup: the setting for the site in the current tab only. Every
// other site, and everything else, is configured on the dashboard.
(async function () {
  "use strict";

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const $ = (id) => document.getElementById(id);

  let settings = await Store.loadSettings();
  let sessionChoices = await Store.loadSessionChoices();

  // The active tab's host. "activeTab" grants the URL while the popup is open.
  let host = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    // Chrome never lets extensions run in the Web Store.
    const webStore = url.hostname === "chromewebstore.google.com" || (url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));
    if ((url.protocol === "http:" || url.protocol === "https:") && !webStore) host = url.hostname;
  } catch {
    host = null;
  }
  const domain = host ? VSG.normalizeDomain(host, { allowSingleLabel: true }) || host : "";

  const PILL = {
    on: ["on", "Guarding"],
    off: ["off", "Off"],
    auto: ["auto", "Auto-detect"],
    none: ["none", "Not guarded"],
  };

  const siteDecision = () => VSG.decide(settings, host);
  const entryFor = () => VSG.findSite(VSG.resolveSites(settings), host);
  const sessionChoice = () => VSG.sessionChoiceFor(sessionChoices, host, entryFor());
  // The stored keys behind this site's session choice: the one found, plus
  // the other domains of its entry (a choice made on YouTube is stored for
  // youtube.com and youtube-nocookie.com).
  const sessionKeys = () => {
    const choice = sessionChoice();
    if (!choice) return [];
    const entry = entryFor();
    return Object.keys(sessionChoices).filter((d) => sessionChoices[d] === choice || (entry && entry.domains.includes(d)));
  };
  // What auto-detect gave an unlisted site, kept when it gets an entry.
  const autoProtection = () => {
    const d = siteDecision();
    return { hideProgress: !!(d.mode === "auto" && d.site && d.site.hideProgress) };
  };
  const effective = () => VSG.applySessionChoice(siteDecision(), sessionChoice());
  const guarding = (d) => d.mode === "on" || d.mode === "auto";
  // The entry that sets this site, if it is listed (possibly a parent domain).
  const listedSite = () => {
    const d = siteDecision();
    return d.mode === "on" || d.mode === "off" ? d.site : null;
  };

  function hintFor(decision) {
    const hours = VSG.describeHours(settings.minHours, settings.maxHours);
    if (decision.session) {
      return decision.mode === "on"
        ? `Lengths show plus ${hours}, with no dialog, until you close the browser.`
        : "Videos here are left alone until you close the browser.";
    }
    switch (decision.mode) {
      case "on":
        return decision.site.ask !== false && settings.autoDetect
          ? `Lengths show plus ${hours}; a dialog lets you cancel when a video starts.`
          : `Lengths show plus ${hours}, with no dialog.`;
      case "auto": return `Found by auto-detect: lengths show plus ${hours}, and a dialog lets you cancel.`;
      case "off": return "Videos here are never changed.";
      default: return "Auto-detect is off and this site isn't switched on.";
    }
  }

  function render() {
    $("here").hidden = !host;
    $("here-unsupported").hidden = !!host;
    $("range").textContent = `Adds ${VSG.describeHours(settings.minHours, settings.maxHours)}`;
    if (!host) return;
    const decision = effective();
    const site = listedSite();
    const entry = site ? (site.builtIn ? site.name : site.domains[0]) : null;
    $("here-host").textContent = entry && entry !== domain ? `${entry} (${domain})` : domain;
    const [cls, text] = PILL[decision.mode];
    const pill = $("here-pill");
    pill.className = "pill " + cls;
    pill.textContent = decision.session ? `${text} (this session)` : text;
    $("here-hint").textContent = hintFor(decision);
    $("here-toggle").checked = guarding(decision);

    // The dialog option matters while this site is guarded and auto-detect
    // is on; a session choice already decides it until the browser closes.
    const choice = sessionChoice();
    $("here-ask-row").hidden = !(guarding(decision) && settings.autoDetect && !choice);
    $("here-ask").checked = siteDecision().mode === "auto" || !!(site && site.ask !== false);
    $("here-session").hidden = !choice;
    if (choice) {
      $("here-session-text").textContent = !decision.session
        ? "Your choice for this session isn't in effect while this site is off."
        : choice.guard
          ? "This session: hidden without the dialog."
          : "This session: videos here are left alone.";
    }
  }

  function fail(err) {
    $("here-error").textContent = err && err.message ? err.message : "That change couldn't be saved. Try again.";
    render(); // put the controls back to what is actually saved
  }

  // Switching the site on or off is a fresh choice, so it also replaces any
  // choice made for this session. The lasting setting is saved first, so a
  // failed save leaves the session choice in place.
  $("here-toggle").addEventListener("change", async (e) => {
    $("here-error").textContent = "";
    const on = e.target.checked;
    const site = listedSite();
    const keys = sessionKeys();
    try {
      if (site) await Store.setSiteEnabled(site, on);
      else if (on !== guarding(siteDecision())) await Store.setCustomSite(host, { enabled: on, ...autoProtection() });
      for (const key of keys) await Store.clearSessionChoice(key);
    } catch (err) {
      fail(err);
    }
  });

  $("here-ask").addEventListener("change", (e) => {
    $("here-error").textContent = "";
    const site = listedSite();
    const write = site ? Store.setSiteAsk(site, e.target.checked) : Store.setCustomSite(host, { enabled: true, ask: e.target.checked, ...autoProtection() });
    write.catch(fail);
  });

  $("here-session-clear").addEventListener("click", () => {
    for (const key of sessionKeys()) Store.clearSessionChoice(key).catch(fail);
  });

  $("open-dashboard").addEventListener("click", () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "sync") settings = await Store.loadSettings();
    else if (area === "session" && Object.keys(changes).some((k) => k.startsWith("session:"))) sessionChoices = await Store.loadSessionChoices();
    else return;
    render();
  });

  render();
})();
