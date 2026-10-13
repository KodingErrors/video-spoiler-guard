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
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
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
  const sessionChoice = () => VSG.sessionChoiceFor(sessionChoices, host);
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
      $("here-session-text").textContent = choice.guard
        ? "This session: hidden without the dialog."
        : "This session: videos here are left alone.";
    }
  }

  function fail(err) {
    $("here-error").textContent = err && err.message ? err.message : "That change couldn't be saved. Try again.";
    render(); // put the controls back to what is actually saved
  }

  // Switching the site on or off is a fresh choice, so it also replaces any
  // choice made for this session.
  $("here-toggle").addEventListener("change", async (e) => {
    $("here-error").textContent = "";
    const on = e.target.checked;
    const site = listedSite();
    try {
      const choice = sessionChoice();
      if (choice) await Store.clearSessionChoice(Object.keys(sessionChoices).find((d) => sessionChoices[d] === choice));
      if (site) await Store.setSiteEnabled(site, on);
      else if (on !== guarding(siteDecision())) await Store.setCustomSite(host, { enabled: on });
    } catch (err) {
      fail(err);
    }
  });

  $("here-ask").addEventListener("change", (e) => {
    $("here-error").textContent = "";
    const site = listedSite();
    const write = site ? Store.setSiteAsk(site, e.target.checked) : Store.setCustomSite(host, { enabled: true, ask: e.target.checked });
    write.catch(fail);
  });

  $("here-session-clear").addEventListener("click", () => {
    const choice = sessionChoice();
    const key = Object.keys(sessionChoices).find((d) => sessionChoices[d] === choice);
    if (key) Store.clearSessionChoice(key).catch(fail);
  });

  $("open-dashboard").addEventListener("click", () => chrome.runtime.openOptionsPage());

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "sync") settings = await Store.loadSettings();
    else if (area === "session") sessionChoices = await Store.loadSessionChoices();
    else return;
    render();
  });

  render();
})();
