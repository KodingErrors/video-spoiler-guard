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
    const clean = VSG.normalizeDomain(domain);
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
    getSalt,
    resetSalt,
  });
})(globalThis);
