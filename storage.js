// chrome.storage helpers shared by the content script, popup and options page.
// Loaded as a classic script after lib.js; defines globalThis.VSGStore.
(function (root) {
  "use strict";

  const VSG = root.VSG;
  const sync = () => root.chrome.storage.sync;
  const local = () => root.chrome.storage.local;

  async function loadSettings() {
    return VSG.normalizeSettings(await sync().get(null));
  }

  // Read-modify-write of one key, so two pages editing different sites at
  // the same time don't overwrite each other.
  async function mergeKey(key, patch) {
    const current = (await sync().get(key))[key];
    const next = { ...(current && typeof current === "object" ? current : {}), ...patch };
    await sync().set({ [key]: next });
    return next;
  }

  function setGlobal(patch) {
    return sync().set(patch);
  }

  function setBuiltin(id, patch) {
    return mergeKey("builtin:" + id, patch);
  }

  // Adds the site when it is not listed yet.
  function setCustomSite(domain, patch) {
    // Called with page hosts (which may be single words like "jellyfin") and
    // with domains the add-site form has already checked.
    const clean = VSG.normalizeDomain(domain, { allowSingleLabel: true });
    if (!clean) return Promise.reject(new Error("That isn't a web address."));
    return sync()
      .get("site:" + clean)
      .then((got) => mergeKey("site:" + clean, got["site:" + clean] ? patch : { enabled: true, addedAt: Date.now(), ...patch }));
  }

  function removeCustomSite(domain) {
    return sync().remove("site:" + domain);
  }

  // Turns a listed site (built-in or added) on or off by its settings key.
  function setSiteEnabled(site, enabled) {
    return site.builtIn ? setBuiltin(site.id, { enabled }) : setCustomSite(site.domains[0], { enabled });
  }

  function setSiteHideProgress(site, hideProgress) {
    return site.builtIn ? setBuiltin(site.id, { hideProgress }) : setCustomSite(site.domains[0], { hideProgress });
  }

  // Whether the dialog is shown on this site while auto-detect is on.
  function setSiteAsk(site, ask) {
    return site.builtIn ? setBuiltin(site.id, { ask }) : setCustomSite(site.domains[0], { ask });
  }

  // ---- This browser session ----------------------------------------------
  // "session:<domain>" -> { guard: true|false }: the dialog's "Don't show
  // this again – for this session" choice for one site, kept in session
  // storage so it is forgotten when the browser closes.

  // Content scripts can read session storage once the service worker has
  // allowed it; before that, the worker reads it for them.
  async function sessionGetAll() {
    try {
      return await root.chrome.storage.session.get(null);
    } catch {
      try {
        return (await root.chrome.runtime.sendMessage({ type: "vsg-session-get" })) || {};
      } catch {
        return {};
      }
    }
  }

  async function sessionSet(key, value) {
    try {
      await root.chrome.storage.session.set({ [key]: value });
    } catch {
      const ok = await root.chrome.runtime.sendMessage({ type: "vsg-session-set", key, value });
      if (!ok) throw new Error("That choice couldn't be saved for this session.");
    }
  }

  async function loadSessionChoices() {
    const all = await sessionGetAll();
    const choices = {};
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith("session:") || !value || typeof value !== "object") continue;
      choices[key.slice(8)] = { guard: value.guard !== false, at: typeof value.at === "number" ? value.at : 0 };
    }
    return choices;
  }

  function setSessionChoice(domain, guard) {
    const clean = VSG.normalizeDomain(domain, { allowSingleLabel: true });
    if (!clean) return Promise.reject(new Error("That isn't a web address."));
    return sessionSet("session:" + clean, { guard: !!guard, at: Date.now() });
  }

  function clearSessionChoice(domain) {
    return root.chrome.storage.session.remove("session:" + domain);
  }

  async function getSalt() {
    const { salt } = await local().get("salt");
    if (typeof salt === "string" && salt) return salt;
    const fresh = VSG.randomSalt();
    await local().set({ salt: fresh });
    return fresh;
  }

  function resetSalt() {
    return local().set({ salt: VSG.randomSalt() });
  }

  root.VSGStore = Object.freeze({
    loadSettings,
    setGlobal,
    setBuiltin,
    setCustomSite,
    removeCustomSite,
    setSiteEnabled,
    setSiteHideProgress,
    setSiteAsk,
    loadSessionChoices,
    setSessionChoice,
    clearSessionChoice,
    getSalt,
    resetSalt,
  });
})(globalThis);
