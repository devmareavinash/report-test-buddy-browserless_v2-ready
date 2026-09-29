/**
 * REFERENCE: Proven Browserless open-source script for MSTR Overview KPI + filters.
 * Used as gold-standard training for the LLM agent (runtime=browserless).
 *
 * Runtime contract:
 * - Browserless entry: async ({ page, context }) => { ... }
 * - Pass reportUrl, creds, filterCombinations in POST context (or process.env.REPORT_URL)
 * - POST to http://localhost:3000/function with { code, context? }
 *
 * NOTE: This reference retains Puppeteer-compatible page APIs (page.type, page.waitForNavigation,
 * multi-arg page.evaluate) as supported by Browserless /function.
 */
export default async ({ page, context }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __creds = (context && context.creds) ? context.creds : (typeof __creds !== 'undefined' ? __creds : undefined);
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = String((context && context.reportUrl) || process.env.REPORT_URL || '').trim();
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1440, height: 900 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}
  };
  await __tryWidenViewport();
  if (!__reportUrl) {
    return { ok: false, error: 'REPORT_URL_REQUIRED', message: 'Pass context.reportUrl in POST body or set process.env.REPORT_URL' };
  }
  const __detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);
  try {
    await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    return { ok: false, error: 'NAVIGATION_FAILED', message: String(e && e.message || e), reportUrl: __reportUrl };
  }
  const __navUrl = typeof page.url === 'function' ? page.url() : '';
  if (!__navUrl || __navUrl === 'about:blank') {
    return { ok: false, error: 'NAVIGATION_FAILED', message: 'page.goto did not leave about:blank', reportUrl: __reportUrl };
  }
  await __sleep(2000);
  let __hasLoginForm = await __detectLoginForm();
  if (__hasLoginForm && typeof __creds !== 'undefined' && __creds && __creds.username) {
    const __onLoginPage = await page.evaluate(() => /\/auth\/ui\/loginPage/i.test(location.href)).catch(() => false);
    if (!__onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await __sleep(1000);
    }
    const __userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const __pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(__userSel, __creds.username).catch(() => {});
    await page.type(__pwdSel, __creds.password).catch(() => {});
    await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, __pwdSel).catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      __sleep(3000),
    ]);
    await __sleep(1500);
    const __loginFailed = await page.evaluate(() =>
      /login\s*failure|error\s*in\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (__loginFailed) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the report login page' };
    }
    await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await __sleep(2000);
    __hasLoginForm = await __detectLoginForm();
    if (__hasLoginForm) {
      return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
    }
    await __tryWidenViewport();
  } else if (__hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  // === END AUTO-INJECTED AUTH CHECK ===

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reportUrl = __reportUrl;

  const waitForLoadingToFinish = async (maxMs = 45000) => {
    const start = Date.now();
    await sleep(400);
    const isLoading = () => page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (/Loading\s*Data/i.test(bodyText)) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          if (!/Loading\s*Data/i.test(direct)) continue;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
            return true;
        }
      }
      const spin = document.querySelector(
        '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="loading" i][class*="overlay" i]'
      );
      if (spin) {
        const r = spin.getBoundingClientRect();
        const st = window.getComputedStyle(spin);
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none')
          return true;
      }
      return false;
    }).catch(() => false);
    while (Date.now() - start < maxMs) {
      const loading = await isLoading();
      if (!loading) {
        await sleep(800);
        if (!(await isLoading())) return;
      }
      await sleep(400);
    }
  };

  const waitForDossierReady = async (maxMs = 45000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 25000));
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate(() => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        if (document.querySelector('input[type="password"], #Pwd')) return false;
        if (document.querySelector('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="FilterPanel" i]')) return true;
        for (const el of Array.from(document.querySelectorAll('label, span, div, td, th, button, a, [role="tab"]'))) {
          if (!isVisible(el)) continue;
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          const nrm = norm(t);
          if (nrm === 'area' || nrm === 'overview' || nrm === 'performance') return true;
        }
        return false;
      }).catch(() => false);
      if (found) {
        await waitForLoadingToFinish(15000);
        return true;
      }
      await sleep(600);
    }
    return false;
  };

  const waitForDashboard = async (maxMs = 20000) => {
    await waitForLoadingToFinish(maxMs);
    const markers = (typeof KPI_LABELS !== 'undefined' && Array.isArray(KPI_LABELS)) ? KPI_LABELS : [];
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate((labels) => {
        function getDirectText(el) {
          let text = '';
          for (const node of el.childNodes)
            if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
          return text.trim();
        }
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const want = (labels || []).map(s => norm(s)).filter(Boolean);
        if (!want.length) return !!document.querySelector('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="FilterPanel" i]');
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const t = norm(getDirectText(el));
          if (t && want.includes(t)) return true;
        }
        return false;
      }, markers).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(maxMs);
  };

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
      const x = 5, y = Math.max(5, window.innerHeight - 5);
      const opts = { bubbles: true, clientX: x, clientY: y };
      document.body.dispatchEvent(new MouseEvent('mousedown', opts));
      document.body.dispatchEvent(new MouseEvent('mouseup',   opts));
      document.body.dispatchEvent(new MouseEvent('click',     opts));
    }).catch(() => {});
    await sleep(300);
  };

// @@RTB_FILTER_CORE_START@@
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
      return { error: 'No selector bound to label: ' + label };
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
  const __rtbWaitDependent = async (label, beforeFp, maxMs = 12000) => {
    if (typeof beforeFp !== 'string') return false;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(500);
      const now = await __rtbH('fingerprint', [label]);
      if (typeof now === 'string' && now !== beforeFp) { await waitForLoadingToFinish(10000); return true; }
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
// @@RTB_FILTER_CORE_END@@


  const extractKPI = async (labelText) => {
    return await page.evaluate((label) => {
      function getDirectText(el) {
        let text = '';
        for (const node of el.childNodes)
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        return text.trim();
      }
      const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const numRe = /^\s*[$]?\s*-?[\d,]+(\.\d+)?\s*%?\s*$/;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const direct = getDirectText(el);
        if (!direct || norm(direct) !== target) continue;
        const lr = el.getBoundingClientRect();
        if (lr.width === 0 || lr.height === 0) continue;
        for (const vEl of Array.from(document.querySelectorAll('*'))) {
          const vt = getDirectText(vEl);
          if (!numRe.test(vt)) continue;
          const r = vEl.getBoundingClientRect();
          if (r.top >= lr.top && r.top <= lr.top + 120) return { value: vt.trim() };
        }
      }
      return { error: 'Label not found: ' + label };
    }, labelText).catch(() => ({ error: 'evaluate failed' }));
  };

  const clickByText = async (text, { openers } = {}) => {
    const res = await page.evaluate((label) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const t = norm(el.innerText || el.textContent || '');
        if (t === target) { el.click(); return { clicked: true, text: label }; }
      }
      return { error: 'navigation target not found: ' + label };
    }, text).catch(() => ({ error: 'evaluate failed: ' + text }));
    await waitForLoadingToFinish();
    return res;
  };

  const NAV_STEPS = ['Overview'];
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '\u2630'];
  const KPI_LABELS = ['NRx Total', 'Total Writers', 'Target Writers %'];
  const toNum = v => (v == null ? null : parseFloat(String(v).replace(/[^0-9.\-]/g, '')));
  const navDebug = [];
  await waitForDossierReady();
  for (const step of NAV_STEPS) {
    const r = await clickByText(step, { openers: NAV_OPENERS });
    navDebug.push({ step, ...r });
    if (r && r.error) break;
  }
  await waitForDashboard();

  const filterCombinations = (context && Array.isArray(context.filterCombinations) && context.filterCombinations.length > 0)
    ? context.filterCombinations
    : ((typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : []);

  if (filterCombinations.length === 0) {
    const out = { navigation: navDebug };
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      out[k] = toNum(raw && raw.value);
    }
    return out;
  }

  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDossierReady();
      for (const step of NAV_STEPS) {
        await clickByText(step, { openers: NAV_OPENERS });
      }
      await waitForDashboard();
    }
    const debug = {};
    const GEO_ORDER = ['Area', 'Region', 'Territory', 'Time Bucket'];
    const allKeys = Object.keys(filters);
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
    for (const key of geoKeys) debug[key] = await selectByLabel(key, filters[key]);
    for (const key of otherKeys) debug[key] = await selectByLabel(key, filters[key]);
    await closeAnyOpenDropdown();
    const row = { filters_applied: debug };
    for (const k of KPI_LABELS) {
      const raw = await extractKPI(k);
      row[k] = toNum(raw && raw.value);
    }
    results[label] = row;
  }
  return { navigation: navDebug, ...results };
};
