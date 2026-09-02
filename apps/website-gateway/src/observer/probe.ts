/**
 * The only script evaluated in the observed page. It returns bounded structural
 * facts: which authentication affordances exist, and which GET forms with named
 * controls are present. It never returns text content, values, cookies, storage
 * or URLs beyond the page's own origin-relative form actions.
 */
export const WEBSITE_PROBE_SCRIPT = `(() => {
  const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
  const text = (node) => (node && node.textContent ? node.textContent.trim().slice(0, 64).toLowerCase() : "");
  const signals = new Set();
  const nodes = Array.prototype.slice.call(document.querySelectorAll("a,button,[role=button]"), 0, 300);
  let signIn = false;
  for (const node of nodes) {
    const label = text(node);
    if (/sign\\s?out|log\\s?out/.test(label)) signals.add("logout_control");
    else if (/account|profile|my\\s|dashboard/.test(label)) signals.add("account_control");
    if (/sign\\s?in|log\\s?in/.test(label)) signIn = true;
  }
  if (document.querySelector("[data-authenticated=true],[aria-label*='signed in' i]")) {
    signals.add("authenticated_status");
  }
  const forms = [];
  const elements = Array.prototype.slice.call(document.forms, 0, 25);
  for (const form of elements) {
    const method = (form.getAttribute("method") || "GET").toUpperCase();
    if (method !== "GET") continue;
    let action;
    try { action = new URL(form.getAttribute("action") || location.href, location.href); } catch { continue; }
    if (action.origin !== location.origin) continue;
    const controls = [];
    for (const control of Array.prototype.slice.call(form.elements, 0, 25)) {
      const name = control.getAttribute && control.getAttribute("name");
      if (!bounded(name, 128) || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) continue;
      controls.push({ name, required: Boolean(control.required) });
    }
    if (controls.length === 0) continue;
    const label = bounded(form.getAttribute("aria-label"), 120) ? form.getAttribute("aria-label") : "Form";
    forms.push({ action: action.origin + action.pathname, controls, label });
  }
  return JSON.stringify({
    signals: Array.prototype.slice.call(signals, 0, 3),
    signIn,
    forms,
    url: location.origin + location.pathname,
    origin: location.origin,
  });
})()`;
