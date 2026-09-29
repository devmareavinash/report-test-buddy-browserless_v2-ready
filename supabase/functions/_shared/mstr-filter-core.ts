/**
 * RTB FILTER CORE — single source of truth for MSTR prompt/filter handling.
 *
 * Every generated script (KPI, Grid, Chart/Show Data) embeds this block instead
 * of carrying its own copy of `selectByLabel`. It fixes four defects that made
 * scripts report `ok: true` while scraping a wrongly-filtered (or errored) page:
 *
 *   1. BOUNDED BINDING  — a label's dropdown is searched only between that label
 *      and the NEXT filter label on the same row. The old code scanned every
 *      selector to the right on the row and then let option *content* win, so
 *      "Region" happily bound to the Territory selector when Region's list had
 *      no "Total" but Territory's did. Nearest-by-distance now wins, always.
 *   2. VERIFIED PICKS   — after clicking, the selector is read back and compared
 *      to the requested value. Two attempts, then a hard FILTER_NOT_APPLIED.
 *   3. CASCADE WAITS    — after Area/Region changes, wait for the dependent
 *      prompt's option list to actually change (MSTR often shows no spinner for
 *      this), instead of racing the repopulate and triggering a server error.
 *   4. ERROR DIALOG     — "An error has occurred" is detected, Show Details is
 *      captured, OK is clicked, and the pick is retried / failed. Nothing is
 *      ever scraped while the modal is up.
 *
 * Contract for the embedding template — these must already exist in scope:
 *      page, sleep(ms), waitForLoadingToFinish(maxMs)
 * Exposed to the template (drop-in replacements, same names as before):
 *      selectByLabel(label, value)        -> { ok, verified, via, error, ... }
 *      applyFiltersVerified(filters, geo) -> { ok, debug, error, final_state }
 *      __rtbCheckErrorDialog(dismiss)     -> null | { error, details }
 *      __rtbReadFilter(label)             -> string | null
 *
 * String.raw is required: the body contains regex escapes (\s, \d) that a normal
 * template literal would eat.
 */

export const FILTER_CORE_VERSION = "2.0.0";

/** Markers so non-TS artifacts (reference .js files) can have this block swapped in. */
export const FILTER_CORE_START = "// @@RTB_FILTER_CORE_START@@";
export const FILTER_CORE_END = "// @@RTB_FILTER_CORE_END@@";

export const FILTER_CORE_JS = String.raw`// @@RTB_FILTER_CORE_START@@
  /* RTB FILTER CORE v2 — bounded binding + verified picks + cascade waits + error-dialog guard.
     Requires in scope: page, sleep, waitForLoadingToFinish. Do not hand-edit; fix mstr-filter-core.ts. */

  // Labels that can share a filter row. Runtime combination keys are merged in so
  // a dossier-specific prompt still bounds its neighbours correctly.
  const __rtbFilterLabels = (() => {
    const base = [
      'Brand', 'Area', 'Region', 'Territory', 'Territory Type', 'Time Bucket',
      'Speciality', 'Specialty', 'Product', 'Channel', 'Segment', 'Metric',
      'View', 'Period', 'Time Period', 'Geography', 'Customer Type'
    ];
    try {
      if (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations)) {
        for (const combo of __filterCombinations) {
          const f = (combo && combo.filters) || {};
          for (const k of Object.keys(f)) if (k && base.indexOf(k) === -1) base.push(k);
        }
      }
    } catch (_) {}
    return base;
  })();

  // Parent -> child prompt. Changing the parent repopulates the child.
  const __rtbGeoChain = { 'Area': 'Region', 'Region': 'Territory' };

  function __rtbHelpersFactory(KNOWN_LABELS) {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const code = s => norm(s).split(/\s+/)[0] || '';
    const getDirectText = el => {
      let t = '';
      for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
      return t.trim();
    };
    const isVisible = el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };

    function findLabelEl(label) {
      let best = null, bestArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (norm(getDirectText(el)) !== norm(label)) continue;
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a < bestArea) { best = el; bestArea = a; }
      }
      return best;
    }

    // FIX 1: stop the search at the next filter label on the same row.
    function rightBoundary(lr) {
      let min = lr.left + 420;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const t = norm(getDirectText(el));
        if (!t) continue;
        let known = false;
        for (const l of KNOWN_LABELS) if (norm(l) === t) { known = true; break; }
        if (!known) continue;
        const r = el.getBoundingClientRect();
        if (Math.abs(r.top - lr.top) > 40) continue;
        if (r.left <= lr.left + 5) continue;
        if (r.left < min) min = r.left;
      }
      return min;
    }

    function bindSelector(label) {
      const labelEl = findLabelEl(label);
      if (!labelEl) return { error: 'Label not found: ' + label };
      const lr = labelEl.getBoundingClientRect();
      const rb = rightBoundary(lr);
      const inBand = r => Math.abs(r.top - lr.top) <= 40 && r.left >= lr.left - 10 && r.left < rb;

      let best = null, bd = Infinity;
      for (const s of Array.from(document.querySelectorAll('select'))) {
        if (!isVisible(s)) continue;
        const r = s.getBoundingClientRect();
        if (!inBand(r)) continue;
        const d = r.left - lr.left;
        if (d < bd) { best = s; bd = d; }
      }
      if (best) return { kind: 'select', el: best, lr: lr, rb: rb };

      best = null; bd = Infinity;
      for (const s of Array.from(document.querySelectorAll('.mstrmojo-DocSelector, [class*="DocSelector"]'))) {
        if (!isVisible(s)) continue;
        const r = s.getBoundingClientRect();
        if (!inBand(r)) continue;
        const d = r.left - lr.left;
        if (d < bd) { best = s; bd = d; }   // nearest wins; option content never overrides position
      }
      if (best) return { kind: 'legacy', el: best, lr: lr, rb: rb };

      // The band above assumes "selector sits to the RIGHT of its label", which is
      // the Performance filter-bar layout. Geography Details adds a View By prompt
      // and wraps, so Territory's selector can sit BELOW its label or inside a
      // shared container. Fall back rather than failing the whole run.
      const SEL_CSS = 'select, .mstrmojo-DocSelector, [class*="DocSelector"]';
      const kindOf = (el) => (el.tagName === 'SELECT' ? 'select' : 'legacy');
      const taken = () => {
        const out = [];
        for (const l of KNOWN_LABELS) {
          if (norm(l) === norm(label)) continue;
          const le = findLabelEl(l);
          if (le) out.push(le.getBoundingClientRect());
        }
        return out;
      };
      const otherLabels = taken();
      const closerToAnotherLabel = (r) => {
        const dMe = Math.abs(r.top - lr.top) + Math.abs(r.left - lr.left);
        for (const o of otherLabels) {
          const dO = Math.abs(r.top - o.top) + Math.abs(r.left - o.left);
          if (dO < dMe) return true;
        }
        return false;
      };

      // Tier B: a selector inside the label's own filter container.
      const box = labelEl.closest('[class*="Selector" i], [class*="Prompt" i], [class*="filter" i], [class*="Panel" i]');
      if (box) {
        for (const s2 of Array.from(box.querySelectorAll(SEL_CSS))) {
          if (!isVisible(s2)) continue;
          const r = s2.getBoundingClientRect();
          if (closerToAnotherLabel(r)) continue;
          return { kind: kindOf(s2), el: s2, lr: lr, rb: rb, via_bind: 'container' };
        }
      }

      // Tier C: stacked layout — selector directly BELOW the label, overlapping it
      // horizontally. Never steal one that belongs to a nearer label.
      best = null; bd = Infinity;
      for (const s2 of Array.from(document.querySelectorAll(SEL_CSS))) {
        if (!isVisible(s2)) continue;
        const r = s2.getBoundingClientRect();
        const dy = r.top - lr.top;
        if (dy < -10 || dy > 140) continue;
        const overlaps = r.left < lr.right + 40 && r.right > lr.left - 40;
        if (!overlaps) continue;
        if (closerToAnotherLabel(r)) continue;
        if (dy < bd) { best = s2; bd = dy; }
      }
      if (best) return { kind: kindOf(best), el: best, lr: lr, rb: rb, via_bind: 'stacked' };

      // Still nothing: report what WAS nearby so the next run is diagnosable.
      const near = [];
      for (const s2 of Array.from(document.querySelectorAll(SEL_CSS))) {
        if (!isVisible(s2)) continue;
        const r = s2.getBoundingClientRect();
        near.push({
          dx: Math.round(r.left - lr.left),
          dy: Math.round(r.top - lr.top),
          w: Math.round(r.width),
          cls: String(s2.className || '').slice(0, 40),
          text: norm(s2.innerText || s2.textContent || '').slice(0, 40),
        });
      }
      near.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy)));
      return {
        error: 'No selector bound to label: ' + label,
        label_rect: { top: Math.round(lr.top), left: Math.round(lr.left), right: Math.round(lr.right) },
        right_boundary: Math.round(rb),
        nearest_selectors: near.slice(0, 6),
      };
    }

    function valueNode(sel) {
      const r = sel.getBoundingClientRect();
      let best = null, bestScore = Infinity;
      for (const c of Array.from(sel.querySelectorAll('*'))) {
        if (!isVisible(c)) continue;
        const t = getDirectText(c);
        if (!t) continue;
        const cr = c.getBoundingClientRect();
        if (cr.top < r.top - 2 || cr.bottom > r.bottom + 2) continue;  // closed box only
        const score = (cr.top - r.top) + (cr.left - r.left);
        if (score < bestScore) { bestScore = score; best = c; }
      }
      return best;
    }

    function readValue(label) {
      const b = bindSelector(label);
      if (b.error) return { error: b.error };
      if (b.kind === 'select') {
        const o = b.el.options[b.el.selectedIndex];
        return { value: (o ? o.textContent : '').trim() };
      }
      const vn = valueNode(b.el);
      if (vn) return { value: getDirectText(vn) };
      return { value: (b.el.innerText || '').split('\n')[0].trim() };
    }

    function listOptions(label) {
      const b = bindSelector(label);
      if (b.error) return { error: b.error, options: [] };
      const out = [];
      if (b.kind === 'select') {
        for (const o of Array.from(b.el.options)) {
          const t = o.textContent.trim();
          if (t && out.indexOf(t) === -1) out.push(t);
        }
        return { options: out };
      }
      for (const c of Array.from(b.el.querySelectorAll('*'))) {
        const t = getDirectText(c);
        if (t && t.length <= 60 && out.indexOf(t) === -1) out.push(t);
      }
      return { options: out };
    }

    function fingerprint(label) {
      const r = listOptions(label);
      return r.error ? ('ERR:' + r.error) : r.options.join('|');
    }

    function openSelector(label) {
      const b = bindSelector(label);
      if (b.error) return b;
      if (b.kind === 'select') return { kind: 'select', opened: false };
      const target = valueNode(b.el) || b.el;
      const r = target.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width - 8, clientY: r.top + r.height / 2 };
      for (const type of ['mousedown', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(type, o));
      return { kind: 'legacy', opened: true };
    }

    function matchIn(nodes, opt) {
      const no = norm(opt), oc = code(opt);
      let exact = null, codeM = null, contains = null;
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(getDirectText(el)) || norm(el.textContent || '');
        if (!t || t.length > 60) continue;
        if (t === no) { if (!exact) exact = el; }
        else if (oc && code(t) === oc) { if (!codeM) codeM = el; }
        else if (t.indexOf(no) !== -1) { if (!contains) contains = el; }
      }
      return exact || codeM || contains;
    }

    // MSTR usually renders the open list in a body-level popup, outside the selector box.
    function pickInPopup(opt) {
      const nodes = Array.from(document.querySelectorAll(
        '[role="option"], [role="menuitem"], [role="listbox"] *, .mstrmojo-ListBase *, [class*="popup" i] li, [class*="dropdown" i] li, li'
      ));
      const el = matchIn(nodes, opt);
      if (!el) return null;
      el.click();
      return { clicked: true, via: 'popup', option: (getDirectText(el) || el.textContent || '').trim().slice(0, 60) };
    }

    function pickInSelector(label, opt) {
      const b = bindSelector(label);
      if (b.error) return b;
      if (b.kind === 'select') {
        const opts = Array.from(b.el.options);
        let m = null;
        for (const o of opts) if (norm(o.textContent) === norm(opt)) { m = o; break; }
        if (!m) for (const o of opts) if (code(o.textContent) === code(opt)) { m = o; break; }
        if (!m) for (const o of opts) if (norm(o.textContent).indexOf(norm(opt)) !== -1) { m = o; break; }
        if (!m) return { error: 'Option not in list', options: opts.map(o => o.textContent.trim()) };
        b.el.value = m.value;
        b.el.dispatchEvent(new Event('input', { bubbles: true }));
        b.el.dispatchEvent(new Event('change', { bubbles: true }));
        return { clicked: true, via: 'native-select', option: m.textContent.trim() };
      }
      const el = matchIn(Array.from(b.el.querySelectorAll('*')), opt);
      if (!el) return { error: 'Option not found inside bound selector' };
      el.click();
      return { clicked: true, via: 'legacy-scoped', option: (getDirectText(el) || el.textContent || '').trim().slice(0, 60) };
    }

    // FIX 4: MSTR error modal — capture Show Details, then dismiss.
    function errorDialog(dismiss) {
      const nodes = Array.from(document.querySelectorAll('div, section, [role="dialog"], [class*="dialog" i], [class*="modal" i]'));
      let dlg = null, area = Infinity;
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        if (!/an error has occurred/i.test(el.innerText || '')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 80) continue;
        const a = r.width * r.height;
        if (a < area) { dlg = el; area = a; }
      }
      if (!dlg) return null;
      const btns = Array.from(dlg.querySelectorAll('button, div[role="button"], a, span'));
      let show = null, ok = null;
      for (const b of btns) {
        const t = (b.innerText || '').trim();
        if (!show && /show details/i.test(t)) show = b;
        if (!ok && /^(ok|close)$/i.test(t)) ok = b;
      }
      if (show) { try { show.click(); } catch (_) {} }
      const details = (dlg.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (dismiss && ok) { try { ok.click(); } catch (_) {} }
      return { error: 'MSTR_ERROR_DIALOG', details: details };
    }

    // Is MSTR actively fetching? Used to end cascade waits early when idle.
    function isBusy() {
      const body = document.body ? (document.body.innerText || '') : '';
      if (/Loading\s*Data/i.test(body)) return true;
      const spin = document.querySelector(
        '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="loading" i], [class*="spinner" i]'
      );
      return !!(spin && isVisible(spin));
    }

    function closeDropdown() {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
      const x = 5, y = Math.max(5, window.innerHeight - 5);
      const o = { bubbles: true, clientX: x, clientY: y };
      document.body.dispatchEvent(new MouseEvent('mousedown', o));
      document.body.dispatchEvent(new MouseEvent('mouseup', o));
      document.body.dispatchEvent(new MouseEvent('click', o));
      return true;
    }

    return {
      readValue: readValue,
      listOptions: listOptions,
      fingerprint: fingerprint,
      openSelector: openSelector,
      pickInPopup: pickInPopup,
      pickInSelector: pickInSelector,
      errorDialog: errorDialog,
      isBusy: isBusy,
      closeDropdown: closeDropdown
    };
  }

  const __rtbEnsureHelpers = async () => {
    const present = await page.evaluate(() => !!window.__RTB).catch(() => false);
    if (present) return;
    await page.evaluate((src, labels) => {
      window.__RTB = (new Function('return (' + src + ')'))()(labels);
    }, String(__rtbHelpersFactory), __rtbFilterLabels).catch(() => {});
  };

  const __rtbH = async (fn, args) => {
    await __rtbEnsureHelpers();
    return page.evaluate((name, a) => {
      try { return window.__RTB[name].apply(null, a || []); }
      catch (e) { return { error: 'helper ' + name + ' threw: ' + (e && e.message) }; }
    }, fn, args || []).catch(() => ({ error: 'evaluate failed: ' + fn }));
  };

  const __rtbCode = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().split(/\s+/)[0] || '';

  const __rtbCloseDropdown = async () => { await __rtbH('closeDropdown'); await sleep(300); };

  const __rtbCheckErrorDialog = async (dismiss = true) => {
    const d = await __rtbH('errorDialog', [dismiss !== false]);
    if (d && d.error === 'MSTR_ERROR_DIALOG') { await sleep(600); return d; }
    return null;
  };

  const __rtbReadFilter = async (label) => {
    const v = await __rtbH('readValue', [label]);
    return (v && v.value) || null;
  };

  // FIX 3: a cascading prompt is done when the dependent list CHANGES.
  // Cost guard: a child list legitimately stays the same for many picks (e.g. "Total").
  // Waiting the full timeout every time added ~12s per geo filter and blew the gateway
  // budget on multi-combo runs, so bail out as soon as the page is demonstrably idle.
  const __rtbWaitDependent = async (label, beforeFp, maxMs = 8000) => {
    if (typeof beforeFp !== 'string') return false;
    const start = Date.now();
    let idlePolls = 0;
    while (Date.now() - start < maxMs) {
    await sleep(350);
    const now = await __rtbH('fingerprint', [label]);
    if (typeof now === 'string' && now !== beforeFp) { await waitForLoadingToFinish(10000); return true; }
    // Nothing in flight and the list has not moved: no refresh is coming.
    const busy = await __rtbH('isBusy');
    if (busy === true) { idlePolls = 0; continue; }
    if (++idlePolls >= 3) return false;
    }
    return false;
  };

  /**
   * Drop-in replacement for the old geometry-only selectByLabel.
   * Returns { ok:true, verified, via } or { ok:false, error, actual, available_options }.
   */
  const selectByLabel = async (labelText, wanted, attempts = 2) => {
    const child = __rtbGeoChain[labelText];
    let childFp = null;
    if (child) childFp = await __rtbH('fingerprint', [child]);

    const trail = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await __rtbCloseDropdown();

      const before = await __rtbH('readValue', [labelText]);
      if (before && before.error) return { ok: false, label: labelText, error: before.error };

      if (before.value && __rtbCode(before.value) === __rtbCode(wanted)) {
        return { ok: true, clicked: true, label: labelText, requested: wanted, verified: before.value, via: 'already-set', attempts: attempt - 1 };
      }

      // FIX 5: validate against the live list before clicking anything.
      const listed = await __rtbH('listOptions', [labelText]);
      const options = (listed && listed.options) || [];
      let available = false;
      for (const o of options) {
        if (__rtbCode(o) === __rtbCode(wanted) || String(o).trim().toLowerCase() === String(wanted).trim().toLowerCase()) { available = true; break; }
      }

      let res = null;
      const opened = await __rtbH('openSelector', [labelText]);
      if (opened && opened.opened) {
        await sleep(450);
        res = await __rtbH('pickInPopup', [wanted]);
      }
      if (!res || !res.clicked) res = await __rtbH('pickInSelector', [labelText, wanted]);

      if (!res || !res.clicked) {
        trail.push({ attempt: attempt, tried: res });
        if (!available && options.length) {
          return {
            ok: false, label: labelText, requested: wanted,
            error: 'OPTION_NOT_AVAILABLE',
            message: '"' + wanted + '" is not an option for ' + labelText + ' under the current parent selection',
            available_options: options.slice(0, 40)
          };
        }
        await sleep(600);
        continue;
      }

      await __rtbCloseDropdown();
      await waitForLoadingToFinish(15000);

      const dlg = await __rtbCheckErrorDialog(true);
      if (dlg) { trail.push({ attempt: attempt, clicked: res, dialog: dlg }); await sleep(1200); continue; }

      // FIX 2: read back before believing the click.
      const after = await __rtbH('readValue', [labelText]);
      if (after && after.value && __rtbCode(after.value) === __rtbCode(wanted)) {
        if (child && typeof childFp === 'string') {
          await __rtbWaitDependent(child, childFp, 12000);
          const dlg2 = await __rtbCheckErrorDialog(true);
          if (dlg2) return { ok: false, label: labelText, requested: wanted, error: dlg2.error, message: dlg2.details, verified: after.value };
        }
        return { ok: true, clicked: true, label: labelText, requested: wanted, verified: after.value, via: res.via, attempts: attempt };
      }
      trail.push({ attempt: attempt, clicked: res, readBack: after && after.value });
      await sleep(800);
    }

    const final = await __rtbH('readValue', [labelText]);
    return {
      ok: false, label: labelText, requested: wanted,
      error: 'FILTER_NOT_APPLIED',
      message: 'Selector for "' + labelText + '" never showed "' + wanted + '"',
      actual: final && final.value, trail: trail
    };
  };

  /** Apply a whole combination in geo order, aborting on the first unverified pick. */
  const applyFiltersVerified = async (filters, geoOrder) => {
    const order = geoOrder || ['Area', 'Region', 'Territory'];
    const debug = {};
    const allKeys = Object.keys(filters || {});
    const geoKeys = order.filter(k => allKeys.indexOf(k) !== -1);
    const otherKeys = allKeys.filter(k => order.indexOf(k) === -1);

    for (const key of geoKeys.concat(otherKeys)) {
      const r = await selectByLabel(key, filters[key]);
      debug[key] = r;
      if (!r.ok) return { ok: false, debug: debug, failed_on: key, error: r.error, detail: r };
    }

    await __rtbCloseDropdown();
    await waitForLoadingToFinish(15000);

    const dlg = await __rtbCheckErrorDialog(true);
    if (dlg) return { ok: false, debug: debug, error: dlg.error, detail: dlg };

    // Final safety net: nothing drifted while later filters were applied.
    const finalState = {};
    for (const key of allKeys) {
      const v = await __rtbReadFilter(key);
      finalState[key] = v;
      if (!v || __rtbCode(v) !== __rtbCode(filters[key])) {
        return {
          ok: false, debug: debug, final_state: finalState,
          error: 'FILTER_DRIFT',
          message: 'Filter "' + key + '" drifted to "' + v + '" before extraction (expected "' + filters[key] + '")'
        };
      }
    }
    return { ok: true, debug: debug, final_state: finalState };
  };
// @@RTB_FILTER_CORE_END@@`;

/** Swap the marked core block inside an already-assembled script (used for reference .js files). */
export function injectFilterCore(src: string): string {
  const start = src.indexOf(FILTER_CORE_START);
  const end = src.indexOf(FILTER_CORE_END);
  if (start === -1 || end === -1 || end < start) return src;
  return src.slice(0, start) + FILTER_CORE_JS + src.slice(end + FILTER_CORE_END.length);
}

/** True when a generated script carries the hardened core (used by validators). */
export function hasFilterCore(code: string): boolean {
  const standardCore =
    /__rtbCheckErrorDialog/.test(code) && /FILTER_NOT_APPLIED/.test(code);
  const recordCountFrameCore =
    /@@RTB_RECORD_COUNT_FRAME_CORE@@/.test(code)
    && /const tryFrame = frame/.test(code)
    && /resultFrame/.test(code);
  return standardCore || recordCountFrameCore;
}
