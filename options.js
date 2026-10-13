// Options page: every setting, the full site list with per-site dialog and
// progress-bar options and selectors, and the add-a-site form.
(async function () {
  "use strict";

  const VSG = globalThis.VSG;
  const Store = globalThis.VSGStore;
  const { el, siteRow, addSite, reportError, rerenderList, slug } = globalThis.VSGUI;
  const $ = (id) => document.getElementById(id);

  let settings = await Store.loadSettings();

  // ---- Numbers ---------------------------------------------------------

  // Number fields save a moment after the last change (or on leaving the
  // field), and only when the value changed: every spinner click fires
  // "change", and Chrome allows 120 sync writes a minute.
  function debounced(save, wait = 500) {
    let timer = 0;
    const run = () => {
      clearTimeout(timer);
      timer = 0;
      save();
    };
    return {
      schedule: () => {
        clearTimeout(timer);
        timer = setTimeout(run, wait);
      },
      flush: () => {
        if (timer) run();
      },
    };
  }

  function bindNumber(id, key, limits, errorId) {
    const input = $(id);
    const error = $(errorId);
    const saver = debounced(() => {
      error.textContent = "";
      const value = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(value) || value < limits[0] || value > limits[1]) {
        error.textContent = `Enter a number from ${limits[0]} to ${limits[1]}.`;
        input.value = settings[key];
        return;
      }
      if (value === settings[key]) return;
      Store.setGlobal({ [key]: value }).catch((err) => {
        reportError(error, err);
        input.value = settings[key];
      });
    });
    input.addEventListener("change", saver.schedule);
    input.addEventListener("blur", saver.flush);
  }

  bindNumber("confirm-seconds", "confirmSeconds", VSG.LIMITS.confirmSeconds, "auto-error");
  bindNumber("min-video-minutes", "minVideoMinutes", VSG.LIMITS.minVideoMinutes, "auto-error");

  // The two ends of the range are saved together so min never exceeds max.
  let changedEnd = "min";
  const rangeSaver = debounced(() => {
    const error = $("time-error");
    error.textContent = "";
    let min = Number($("min-hours").value);
    let max = Number($("max-hours").value);
    const [lo, hi] = VSG.LIMITS.hours;
    if (![min, max].every((n) => Number.isFinite(n) && n >= lo && n <= hi)) {
      error.textContent = `Enter hours from ${lo} to ${hi}.`;
      renderNumbers(true);
      return;
    }
    if (min > max) {
      if (changedEnd === "min") max = min;
      else min = max;
    }
    if (max === 0) {
      error.textContent = "The most fake time has to be more than 0 hours.";
      renderNumbers(true);
      return;
    }
    if (min === settings.minHours && max === settings.maxHours) return;
    Store.setGlobal({ minHours: min, maxHours: max }).catch((err) => {
      reportError(error, err);
      renderNumbers(true);
    });
  });
  for (const [id, end] of [["min-hours", "min"], ["max-hours", "max"]]) {
    $(id).addEventListener("change", () => {
      changedEnd = end;
      rangeSaver.schedule();
    });
    $(id).addEventListener("blur", rangeSaver.flush);
  }

  $("reset-salt").addEventListener("click", async () => {
    await Store.resetSalt();
    const status = $("time-status");
    status.textContent = "Every video now gets a new fake length.";
    setTimeout(() => (status.textContent = ""), 4000);
  });

  // ---- Switches --------------------------------------------------------

  $("auto-detect").addEventListener("change", (e) => {
    Store.setGlobal({ autoDetect: e.target.checked }).catch((err) => reportError($("auto-error"), err));
  });
  $("auto-hide-progress").addEventListener("change", (e) => {
    Store.setGlobal({ autoHideProgress: e.target.checked }).catch((err) => reportError($("auto-error"), err));
  });

  // ---- Site list -------------------------------------------------------

  function checkbox(id, checked, label, onchange) {
    return el("label", { class: "check", for: id }, el("input", { type: "checkbox", id, checked, onchange }), label);
  }

  function siteExtras(site) {
    const errorTarget = $("sites-error");
    const key = slug(site);
    const ask = checkbox(`ask-${key}`, site.ask !== false, "Show the dialog when a video starts (with auto-detect on)", (e) =>
      Store.setSiteAsk(site, e.target.checked).catch((err) => reportError(errorTarget, err)),
    );
    const hide = checkbox(
      `hide-${key}`,
      site.hideProgress,
      site.progressSelector ? "Hide the progress bar" : "Hide the progress bar (best effort)",
      (e) => Store.setSiteHideProgress(site, e.target.checked).catch((err) => reportError(errorTarget, err)),
    );
    if (site.builtIn) return el("div", { class: "site-extra" }, ask, hide);

    const selectorField = (label, field, value) => {
      const id = `${field}-${key}`;
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
            // A field removed by a re-render fires "change"; its text lives
            // on in the new field, which saves it when the user is done.
            if (!e.target.isConnected) return;
            const selector = e.target.value.trim();
            if (selector && !validSelector(selector)) {
              reportError(errorTarget, new Error(`"${selector}" isn't a valid CSS selector.`));
              return;
            }
            errorTarget.textContent = "";
            Store.setCustomSite(site.domains[0], { [field]: selector }).catch((err) => reportError(errorTarget, err));
          },
        }),
      );
    };
    const details = el(
      "details",
      { open: !!(site.durationSelector || site.progressSelector) },
      el("summary", { text: "CSS selectors" }),
      el(
        "div",
        { class: "selectors" },
        selectorField("Duration label", "durationSelector", site.durationSelector),
        selectorField("Progress bar to hide", "progressSelector", site.progressSelector),
      ),
    );
    return el("div", { class: "site-extra" }, ask, hide, details);
  }

  function validSelector(selector) {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  // While a selector is being typed, the list waits to re-render until the
  // field is left, so the text isn't saved half-typed or moved around.
  let renderWhenDone = false;
  function typingInList() {
    const active = document.activeElement;
    return !!active && $("sites").contains(active) && active.tagName === "INPUT" && active.type === "text";
  }
  $("sites").addEventListener("focusout", () => {
    if (!renderWhenDone) return;
    setTimeout(() => {
      if (typingInList()) return;
      renderWhenDone = false;
      renderSites();
    });
  });

  function renderSites() {
    if (typingInList()) {
      renderWhenDone = true;
      return;
    }
    const query = $("filter").value.trim().toLowerCase();
    const sites = VSG.resolveSites(settings).filter(
      (s) => !query || s.name.toLowerCase().includes(query) || s.domains.some((d) => d.includes(query)),
    );
    const list = $("sites");
    rerenderList(list, () => {
      list.replaceChildren(...sites.map((site) => siteRow(site, { errorTarget: $("sites-error"), extra: siteExtras(site) })));
      if (!sites.length) list.append(el("li", { class: "hint", text: "No sites match." }));
    });
  }

  // `force` resets even the focused field, after a value was rejected.
  function renderNumbers(force = false) {
    for (const [id, key] of [["confirm-seconds", "confirmSeconds"], ["min-video-minutes", "minVideoMinutes"], ["min-hours", "minHours"], ["max-hours", "maxHours"]]) {
      // Don't overwrite a number the user is in the middle of typing.
      if (force || document.activeElement !== $(id)) $(id).value = settings[key];
    }
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
      if (!message) $("add-form").reset();
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
