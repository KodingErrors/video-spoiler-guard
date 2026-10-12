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

  function idFor(site) {
    return "site-" + site.key.replace(/[^a-z0-9]+/gi, "-");
  }

  // One row of the site list: name, domains and an on/off switch, plus a
  // remove button for sites the user added.
  function siteRow(site, { errorTarget, extra } = {}) {
    const inputId = idFor(site);
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

  // Keeps an element's scroll position across a re-render.
  function preserveScroll(node, render) {
    const top = node ? node.scrollTop : 0;
    render();
    if (node) node.scrollTop = top;
  }

  root.VSGUI = Object.freeze({ el, siteRow, addSite, reportError, preserveScroll });
})(globalThis);
