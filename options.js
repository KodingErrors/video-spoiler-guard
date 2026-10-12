// Options page: every setting, the full site list with per-site progress-bar
// hiding and selectors, and the add-a-site form.
(async function () {
  "use strict";

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const { el, siteRow, addSite, reportError } = globalThis.VSGUI;
  const $ = (id) => document.getElementById(id);

  let settings = await Store.loadSettings();

  // ---- Numbers ---------------------------------------------------------

  function bindNumber(id, key, limits, errorId) {
    const input = $(id);
    input.addEventListener("change", () => {
      const error = $(errorId);
      if (error) error.textContent = "";
      const value = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(value) || value < limits[0] || value > limits[1]) {
        if (error) error.textContent = `Enter a number from ${limits[0]} to ${limits[1]}.`;
        input.value = settings[key];
        return;
      }
      Store.setGlobal({ [key]: value }).catch((err) => reportError(error, err));
    });
  }

  bindNumber("confirm-seconds", "confirmSeconds", VSG.LIMITS.confirmSeconds, "sites-error");
  bindNumber("min-video-minutes", "minVideoMinutes", VSG.LIMITS.minVideoMinutes, "sites-error");

  // The two ends of the range are saved together so min never exceeds max.
  function saveRange(changed) {
    const error = $("time-error");
    error.textContent = "";
    let min = Number($("min-hours").value);
    let max = Number($("max-hours").value);
    const [lo, hi] = VSG.LIMITS.hours;
    if (![min, max].every((n) => Number.isFinite(n) && n >= lo && n <= hi)) {
      error.textContent = `Enter hours from ${lo} to ${hi}.`;
      renderNumbers();
      return;
    }
    if (min > max) {
      if (changed === "min") max = min;
      else min = max;
    }
    if (max === 0) {
      error.textContent = "The most fake time has to be more than 0 hours.";
      renderNumbers();
      return;
    }
    Store.setGlobal({ minHours: min, maxHours: max }).catch((err) => reportError(error, err));
  }
  $("min-hours").addEventListener("change", () => saveRange("min"));
  $("max-hours").addEventListener("change", () => saveRange("max"));

  $("reset-salt").addEventListener("click", async () => {
    await Store.resetSalt();
    const status = $("time-status");
    status.textContent = "Every video now gets a new fake length.";
    setTimeout(() => (status.textContent = ""), 4000);
  });

  // ---- Switches --------------------------------------------------------

  $("auto-detect").addEventListener("change", (e) => {
    Store.setGlobal({ autoDetect: e.target.checked }).catch((err) => reportError($("sites-error"), err));
  });
  $("auto-hide-progress").addEventListener("change", (e) => {
    Store.setGlobal({ autoHideProgress: e.target.checked }).catch((err) => reportError($("sites-error"), err));
  });

  // ---- Site list -------------------------------------------------------

  function siteExtras(site) {
    const errorTarget = $("sites-error");
    const hideId = `hide-${site.key.replace(/[^a-z0-9]+/gi, "-")}`;
    const hide = el(
      "label",
      { class: "check", for: hideId },
      el("input", {
        type: "checkbox",
        id: hideId,
        checked: site.hideProgress,
        onchange: (e) => Store.setSiteHideProgress(site, e.target.checked).catch((err) => reportError(errorTarget, err)),
      }),
      site.progressSelector ? "Hide the progress bar" : "Hide the progress bar (best effort)",
    );
    if (site.builtIn) return el("div", { class: "site-extra" }, hide);

    const selectorField = (label, key, value) => {
      const id = `${key}-${site.key.replace(/[^a-z0-9]+/gi, "-")}`;
      return el(
        "label",
        { for: id },
        label,
        el("input", {
          class: "field",
          id,
          type: "text",
          spellcheck: "false",
          value,
          onchange: (e) => {
            const selector = e.target.value.trim();
            if (selector && !validSelector(selector)) {
              reportError(errorTarget, new Error(`"${selector}" isn't a valid CSS selector.`));
              return;
            }
            errorTarget.textContent = "";
            Store.setCustomSite(site.domains[0], { [key]: selector }).catch((err) => reportError(errorTarget, err));
          },
        }),
      );
    };
    const open = !!(site.durationSelector || site.progressSelector);
    const details = el(
      "details",
      { open },
      el("summary", { text: "CSS selectors" }),
      el(
        "div",
        { class: "selectors" },
        selectorField("Duration label", "durationSelector", site.durationSelector),
        selectorField("Progress bar to hide", "progressSelector", site.progressSelector),
      ),
    );
    return el("div", { class: "site-extra" }, hide, details);
  }

  function validSelector(selector) {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  function renderSites() {
    const query = $("filter").value.trim().toLowerCase();
    const sites = VSG.resolveSites(settings).filter(
      (s) => !query || s.name.toLowerCase().includes(query) || s.domains.some((d) => d.includes(query)),
    );
    const list = $("sites");
    // Keep focus on the control being used when storage echoes the change.
    const focusedId = document.activeElement && list.contains(document.activeElement) ? document.activeElement.id : null;
    list.replaceChildren(...sites.map((site) => siteRow(site, { errorTarget: $("sites-error"), extra: siteExtras(site) })));
    if (!sites.length) list.append(el("li", { class: "hint", text: "No sites match." }));
    if (focusedId) $(focusedId)?.focus();
  }

  function renderNumbers() {
    $("confirm-seconds").value = settings.confirmSeconds;
    $("min-video-minutes").value = settings.minVideoMinutes;
    $("min-hours").value = settings.minHours;
    $("max-hours").value = settings.maxHours;
  }

  function render() {
    $("auto-detect").checked = settings.autoDetect;
    $("auto-hide-progress").checked = settings.autoHideProgress;
    renderNumbers();
    renderSites();
  }

  $("filter").addEventListener("input", renderSites);

  // ---- Add a site ------------------------------------------------------

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = $("add-error");
    error.textContent = "";
    const durationSelector = $("add-duration").value.trim();
    const progressSelector = $("add-progress").value.trim();
    for (const selector of [durationSelector, progressSelector]) {
      if (selector && !validSelector(selector)) {
        error.textContent = `"${selector}" isn't a valid CSS selector.`;
        return;
      }
    }
    try {
      const patch = {};
      if (durationSelector) patch.durationSelector = durationSelector;
      if (progressSelector) patch.progressSelector = progressSelector;
      const message = await addSite($("add-domain").value, settings, patch);
      error.textContent = message;
      if (!message) {
        $("add-form").reset();
      }
    } catch (err) {
      reportError(error, err);
    }
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "sync") return;
    settings = await Store.loadSettings();
    render();
  });

  render();
})();
