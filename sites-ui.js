// Small DOM helpers shared by the popup and options page. Everything is built
// with createElement/textContent, never innerHTML, because site names and
// selectors are typed by the user.
(function (root) {
  "use strict";

  const VSG = root.VSG;
  const Store = root.VSGStore;

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== "string") node[key] = value;
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  // Shows a failed storage write next to the control instead of failing silently.
  function reportError(target, error) {
    if (!target) return;
    target.textContent = error && error.message ? error.message : "That change couldn't be saved. Try again.";
  }

  function slug(site) {
    return site.key.replace(/[^a-z0-9]+/gi, "-");
  }

  // One row of the site list: name, domains and an on/off switch, plus a
  // remove button for sites the user added.
  function siteRow(site, { errorTarget, extra } = {}) {
    const inputId = "site-" + slug(site);
    const toggle = el("input", {
      type: "checkbox",
      class: "switch",
      id: inputId,
      checked: site.enabled,
      onchange: (e) => Store.setSiteEnabled(site, e.target.checked).catch((err) => reportError(errorTarget, err)),
    });
    const name = el("span", { class: "site-name" }, site.name, site.builtIn ? null : el("span", { class: "badge-custom", text: "Added" }));
    const domains = el("span", { class: "site-domains", text: site.domains.join(", ") });
    const label = el("label", { class: "switch-row", for: inputId }, el("span", null, name, domains), toggle);
    const remove = site.builtIn
      ? null
      : el("button", {
          type: "button",
          class: "icon-btn",
          id: "remove-" + slug(site),
          "aria-label": `Remove ${site.name}`,
          title: `Remove ${site.name}`,
          text: "×",
          onclick: () => Store.removeCustomSite(site.domains[0]).catch((err) => reportError(errorTarget, err)),
        });
    if (extra) {
      return el("li", { "data-key": site.key }, el("div", { class: "site-main" }, label, extra), remove);
    }
    return el("li", { "data-key": site.key }, label, remove);
  }

  // Adds a site typed by the user. Returns a message to show, or "" on success.
  async function addSite(input, settings, patch = {}) {
    const domain = VSG.normalizeDomain(input);
    if (!domain) return "Enter a site such as example.com.";
    const sites = VSG.resolveSites(settings);
    const exact = sites.find((s) => s.domains.includes(domain));
    if (exact && exact.builtIn) {
      if (!exact.enabled) await Store.setSiteEnabled(exact, true);
      return `${exact.name} is already in the list${exact.enabled ? "" : ", and it's now on"}.`;
    }
    await Store.setCustomSite(domain, { enabled: true, ...patch });
    return "";
  }

  // Re-renders a site list in place while keeping what the user was doing:
  // the focused control, which "details" panels are open, and the scroll
  // position. When the focused row went away (a site was removed), focus
  // moves to the row that took its place.
  function rerenderList(list, build) {
    const active = document.activeElement;
    const inList = active && list.contains(active);
    const focusedId = inList ? active.id : null;
    const rows = [...list.querySelectorAll("li[data-key]")];
    const focusedRow = inList ? rows.findIndex((li) => li.contains(active)) : -1;
    const open = new Set(rows.filter((li) => li.querySelector("details[open]")).map((li) => li.dataset.key));
    const top = list.scrollTop;
    build();
    for (const li of list.querySelectorAll("li[data-key]")) {
      const details = li.querySelector("details");
      if (details && open.has(li.dataset.key)) details.open = true;
    }
    list.scrollTop = top;
    if (!inList) return;
    const again = focusedId && document.getElementById(focusedId);
    if (again) {
      again.focus();
      return;
    }
    const next = list.querySelectorAll("li[data-key]")[Math.max(0, focusedRow)] || list.querySelector("li[data-key]:last-child");
    const target = next && next.querySelector(".switch");
    if (target) target.focus();
  }

  root.VSGUI = Object.freeze({ el, siteRow, addSite, reportError, rerenderList, slug });
})(globalThis);
