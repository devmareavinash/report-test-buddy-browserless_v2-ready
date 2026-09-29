/**
 * REFERENCE: Proven Browserless open-source script for MSTR chart/trend Show Data extraction.
 * Used as gold-standard training for the LLM agent (runtime=browserless).
 *
 * Runtime contract:
 * - Browserless entry: async ({ page }) => { ... }
 * - Injected globals: __creds, __filterCombinations
 * - Report URL: filled by RTB assemble (Browserless has no Node process.env)
 * - POST to http://localhost:3000/chromium/function with { code, context? }
 *
 * Chart extraction flow:
 * - Navigate NAV_STEPS (Performance footer, then Activity page tab), record navDebug
 * - Apply TIME_GRAIN (Weekly/Monthly/Quarterly) after tabs, then filters, then Show Data
 * - Return { navigation: navDebug, results } and copy navigation onto each combo row
 * - openShowData(chartTitle + title variants) → waitForShowDataPopup → extractShowDataTable
 * - NEVER scrape canvas/SVG — always use Show Data popup table extraction
 *
 * NOTE: This reference retains Puppeteer-compatible page APIs (page.type, page.waitForNavigation,
 * multi-arg page.evaluate) as supported by Browserless /function.
 */
export default async ({ page }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = "";
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1440, height: 900 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}
  };
  await __tryWidenViewport();
  if (!__reportUrl) {
    return { ok: false, error: 'REPORT_URL_REQUIRED', message: 'Report URL missing — regenerate script from RTB' };
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
  await page.goto(__reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
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


  const waitForLoadingToFinish = async (maxMs = 15000) => {
    const start = Date.now();
    await sleep(300);
    const isLoading = () => page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (/Loading\s*Data/i.test(bodyText)) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          let direct = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent;
          if (!/Loading\s*Data/i.test(direct)) continue;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none') return true;
        }
      }
      const spin = document.querySelector('.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i]');
      if (spin) {
        const r = spin.getBoundingClientRect();
        const st = window.getComputedStyle(spin);
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none') return true;
      }
      return false;
    }).catch(() => false);
    while (Date.now() - start < maxMs) {
      const loading = await isLoading();
      if (!loading) { await sleep(400); if (!(await isLoading())) return; }
      await sleep(300);
    }
  };

  const waitForDashboard = async (maxMs = 15000) => {
    await waitForLoadingToFinish(maxMs);
    const CHART_WAIT_TITLE = 'Overall Performance';
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      let found = false;
      for (const frame of page.frames()) {
        try {
          const ok = await frame.evaluate((titleText) => {
            function getDirectText(el) {
              let text = '';
              for (const node of el.childNodes)
                if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
              return text.trim();
            }
            const target = titleText.toLowerCase();
            return Array.from(document.querySelectorAll('*'))
              .some(el => getDirectText(el).toLowerCase().includes(target));
          }, CHART_WAIT_TITLE);
          if (ok) { found = true; break; }
        } catch (_) {}
      }
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(maxMs);
  };

  // Ready BEFORE Performance nav: filter chrome / Area must exist.
  // Do not wait for chart title here — that only appears after the Performance tab.
  const waitForDossierReady = async (maxMs = 25000) => {
    await waitForLoadingToFinish(Math.min(maxMs, 25000));
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      for (const frame of page.frames()) {
        try {
          const ok = await frame.evaluate(() => {
            const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const isVisible = el => {
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return false;
              const st = getComputedStyle(el);
              return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
            };
            if (document.querySelector('.mstrmojo-DocSelector, [class*="DocSelector"], [class*="FilterPanel" i]')) return true;
            for (const el of Array.from(document.querySelectorAll('label, span, div, td, th'))) {
              if (!isVisible(el)) continue;
              let t = '';
              for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
              if (norm(t) === 'area') return true;
            }
            return false;
          });
          if (ok) {
            await waitForLoadingToFinish(15000);
            return true;
          }
        } catch (_) {}
      }
      await sleep(600);
    }
    return false;
  };

  const evalAcrossFrames = async (fn, arg) => {
    let lastErr = { error: 'not found in any accessible frame' };
    for (const frame of page.frames()) {
      try {
        const result = await frame.evaluate(fn, arg);
        if (result && !result.error) return { frame, result };
        if (result && result.error) lastErr = result;
      } catch (_) {}
    }
    return { frame: null, result: lastErr };
  };

  const evalInFrame = async (frame, fn, arg) => {
    try { return await frame.evaluate(fn, arg); } catch (e) { return { error: String(e && e.message || e) }; }
  };

  let cachedDossierFrame = null;

  const dismissGenericErrorDialog = async () => {
    const tryDismiss = () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
        } catch (_) { return false; }
      };
      // Prefer explicit MSTR error dialogs ("An error has occurred…") then any OK in a dialog.
      const dialogs = Array.from(document.querySelectorAll(
        '[role="dialog"], .mstrmojo-Dialog, .mstrmojo-MsgBox, .mstrmojo-popup, [class*="Dialog"], [class*="MsgBox"], [class*="Modal"]'
      )).filter(isVisible);
      const looksLikeError = el => /an error has occurred|sorry for the inconvenience|contact your administrator/i.test(el.innerText || '');
      const candidates = dialogs.filter(looksLikeError).concat(dialogs);
      for (const dlg of candidates) {
        const btns = Array.from(dlg.querySelectorAll('button, [role="button"], a, span, input[type="button"]')).filter(isVisible);
        for (const el of btns) {
          const t = norm(el.innerText || el.textContent || el.value || '');
          if (/^(ok|close|dismiss|yes)$/i.test(t)) {
            try { el.click(); return { dismissed: true, via: 'dialog-ok', text: t }; } catch (_) {}
          }
        }
      }
      // Fallback: any visible OK whose ancestor mentions error / Show Details.
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, span, input[type="button"]')).filter(isVisible)) {
        const t = norm(el.innerText || el.textContent || el.value || '');
        if (!/^(ok|close|dismiss)$/i.test(t)) continue;
        let p = el.parentElement;
        for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
          const pt = p.innerText || '';
          if (/an error has occurred|show details|sorry for the inconvenience/i.test(pt)) {
            try { el.click(); return { dismissed: true, via: 'ancestor-error-ok', text: t }; } catch (_) {}
          }
        }
      }
      return { dismissed: false };
    };

    let last = { dismissed: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      let hit = false;
      const frames = [];
      if (cachedDossierFrame && !cachedDossierFrame.isDetached()) frames.push(cachedDossierFrame);
      for (const f of page.frames()) {
        if (!frames.includes(f)) frames.push(f);
      }
      for (const frame of frames) {
        try {
          const r = await frame.evaluate(tryDismiss);
          if (r && r.dismissed) { last = r; hit = true; break; }
        } catch (_) {}
      }
      if (!hit) {
        try {
          const r = await page.evaluate(tryDismiss);
          if (r && r.dismissed) { last = r; hit = true; }
        } catch (_) {}
      }
      if (hit) {
        await sleep(400);
        try { await page.keyboard.press('Escape'); } catch (_) {}
        try {
          const vh = (page.viewportSize() && page.viewportSize().height) || 800;
          await page.mouse.click(8, Math.max(8, vh - 8));
        } catch (_) {}
        await sleep(250);
      } else {
        break;
      }
    }
    return last;
  };

  const closeAnyOpenDropdown = async () => {
    try { await page.keyboard.press('Escape'); } catch (_) {}
    try {
      const vh = (page.viewportSize() && page.viewportSize().height) || 800;
      await page.mouse.click(8, Math.max(8, vh - 8));
    } catch (_) {}
    await sleep(250);
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

  const clickByTextInFrames = async (text, { preferBottom, preferTop, preferMiddle, openers } = {}) => {
    const payload = { preferBottom: !!preferBottom, preferTop: !!preferTop, preferMiddle: !!preferMiddle };
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate(([label, opts]) => {
          function getDirectText(el) {
            let t = '';
            for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
            return (t || '').trim();
          }
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const target = norm(label);
          const matchText = (direct, inner) => {
            if (direct === target || inner === target) return true;
            // Short tab labels: do not match longer titles ("Overall Performance",
            // "Activity Trend", "Performance - Activity").
            if (target.length <= 18) {
              return direct.startsWith(target) && direct.length <= target.length + 4;
            }
            if (inner.includes(target) && inner.length <= target.length + 80) return true;
            if (target.includes(inner) && inner.length >= 4) return true;
            if (target.length >= 10 && inner.includes(target.slice(0, Math.min(24, target.length)))) return true;
            return false;
          };
          const isVisible = el => {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
            return st.visibility !== 'hidden' && st.display !== 'none';
          };
          const isBlueTab = el => {
            const st = getComputedStyle(el);
            const bg = st.backgroundColor || '';
            return /rgb\(\s*\d+,\s*\d+,\s*2[0-9]{2}/.test(bg)
              || /rgb\(\s*0,\s*\d+,\s*2[0-9]{2}/.test(bg);
          };
          const vh = window.innerHeight || 800;
          const hits = [];
          for (const el of Array.from(document.querySelectorAll('button, a, span, div, li, label, [role="button"], [role="tab"]'))) {
            if (!isVisible(el)) continue;
            const direct = norm(getDirectText(el));
            const inner = norm(el.innerText || el.textContent || '');
            if (!matchText(direct, inner)) continue;
            const r = el.getBoundingClientRect();
            if (opts.preferBottom && r.top < vh * 0.62) continue;
            if (opts.preferMiddle && (r.top < vh * 0.10 || r.top > vh * 0.58)) continue;
            if (opts.preferTop && !opts.preferMiddle && r.top > vh * 0.45) continue;
            const tag = (el.tagName || '').toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            const score = (tag === 'button' || role === 'tab' || role === 'button' ? 2 : 0)
              + (isBlueTab(el) ? 3 : 0)
              + (opts.preferMiddle && r.top >= vh * 0.14 && r.top <= vh * 0.50 ? 2 : 0);
            // An EXACT label must outrank any substring hit. "Activity Performance"
            // is contained in the "Monthly Call Activity Performance" link, which
            // sits a few px higher, so the top-based tiebreak used to click the
            // link instead of the sub-tab.
            const isExactHit = (direct === target || inner === target);
            hits.push({ el, area: r.width * r.height, top: r.top, bottom: r.bottom, score, exact: isExactHit ? 1 : 0 });
          }
          if (!hits.length) return { error: 'not in frame' };
          hits.sort((a, b) => {
            if (b.exact !== a.exact) return b.exact - a.exact;
            if (b.score !== a.score) return b.score - a.score;
            if (opts.preferBottom) return b.bottom - a.bottom || a.area - b.area;
            if (opts.preferTop || opts.preferMiddle) return a.top - b.top || a.area - b.area;
            return a.area - b.area;
          });
          hits[0].el.click();
          // Report the element's OWN text, not the requested label -- echoing the
          // label hid the fact that a different element was being clicked.
          const clickedText = (getDirectText(hits[0].el) || hits[0].el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          return { clicked: true, via: 'frame-eval', text: clickedText || label, requested: label, exact: !!hits[0].exact };
        }, [text, payload]);
        if (r && r.clicked) return r;
      } catch (_) {}
    }
    return null;
  };

  const clickByText = async (text, { scope, openers, preferBottom, preferTop, preferMiddle } = {}) => {
    let r = await clickByTextInFrames(text, { preferBottom, preferTop, preferMiddle, openers });
    if (r && r.clicked) return r;
    const tryClick = () => page.evaluate(([label, scopeSel]) => {
      function getDirectText(el) { let t = ''; for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent; return t.trim(); }
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; const st = el.ownerDocument.defaultView.getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none'; };
      const roots = [document];
      for (const f of Array.from(document.querySelectorAll('iframe, frame'))) { try { if (f.contentDocument) roots.push(f.contentDocument); } catch (_) {} }
      const exact = [];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = norm(getDirectText(el));
          const inner = norm(el.innerText || '');
          const shortTab = target.length <= 18;
          const hit = (direct && direct === target) || inner === target
            || (!shortTab && inner.includes(target) && inner.length <= target.length + 24)
            || (shortTab && direct && direct.startsWith(target) && direct.length <= target.length + 4);
          if (hit) {
            const r = el.getBoundingClientRect();
            exact.push({ el, area: r.width * r.height });
          }
        }
      }
      exact.sort((a, b) => a.area - b.area);
      if (exact[0]) { exact[0].el.click(); return { clicked: true, via: 'exact', text: label }; }
      return { error: 'Text not found: ' + label };
    }, [text, scope || null]);
    r = await tryClick();
    if (r && r.clicked) return r;
    const menuOpeners = openers || ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '☰'];
    for (const opener of menuOpeners) {
      await clickByTextInFrames(opener, { openers: menuOpeners }).catch(() => null);
      await page.evaluate((op) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const t = norm(el.innerText || el.textContent || '');
          if (t === norm(op) || t.includes(norm(op))) { el.click(); return true; }
        }
        return false;
      }, opener).catch(() => false);
      await sleep(400);
      r = await clickByTextInFrames(text, { preferBottom, preferTop, preferMiddle, openers });
      if (r && r.clicked) return { ...r, via: 'after-opener-frame-' + (r.via || 'frame') };
      r = await tryClick();
      if (r && r.clicked) return { ...r, via: 'after-opener-' + opener };
    }
    return r || { error: 'Navigation failed: ' + text };
  };
  const chartTitleVariants = (titleText) => {
    const t = String(titleText || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    const out = [t];
    const noSuffix = t.replace(/\s+(graph|chart|plot)$/i, '').trim();
    if (noSuffix && noSuffix !== t) out.push(noSuffix);
    if (!/\b(graph|chart|plot)\b/i.test(t)) {
      out.push(t + ' Graph');
      out.push(t + ' Chart');
    }
    if (/\btrend$/i.test(t) && !/\btrends$/i.test(t)) out.push(t + 's');
    if (/\btrends$/i.test(t)) out.push(t.replace(/s$/i, ''));
    // "Activity Performance - Segment Summary" is tab-name + widget-name glued together.
    // The widget's own title is just "Segment Summary", so try each side of the dash.
    if (/\s[-\u2013\u2014]\s/.test(t)) {
      const parts = t.split(/\s[-\u2013\u2014]\s/).map((p) => p.trim()).filter(Boolean);
      for (const p of parts.slice().reverse()) {
        out.push(p);
        if (!/\b(graph|chart|plot)\b/i.test(p)) { out.push(p + ' Graph'); out.push(p + ' Chart'); }
      }
    }
    return [...new Set(out.filter(Boolean))];
  };

  const locateChartByTitle = (titleText) => {
    const isVisible = el => { const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none'; };
    function getDirectText(el) { let t = ''; for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent; return t.trim(); }
    const target = String(titleText || '').toLowerCase();
    let titleEl = null, titleArea = Infinity;
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (!isVisible(el)) continue;
      const direct = getDirectText(el).toLowerCase();
      const inner = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!direct.includes(target) && !(inner.includes(target) && inner.length <= target.length + 48)) continue;
      const r = el.getBoundingClientRect(); const area = r.width * r.height;
      if (area < titleArea) { titleEl = el; titleArea = area; }
    }
    if (!titleEl) return { error: 'chart title not found: ' + titleText };
    const tr = titleEl.getBoundingClientRect();
    let best = null, bestDist = Infinity, bestRect = null;
    for (const el of Array.from(document.querySelectorAll('canvas, svg, [class*="highcharts" i], [class*="mstrmojo-graph" i], [class*="chart-container" i], [class*="Graph" i]'))) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 50 || r.top < tr.bottom - 10) continue;
      const dist = (r.top - tr.bottom) + Math.abs(r.left - tr.left);
      if (dist < bestDist) { bestDist = dist; best = el; bestRect = r; }
    }
    if (!best) return { error: 'chart element not found below title' };
    return { top: bestRect.top, left: bestRect.left, width: bestRect.width, height: bestRect.height };
  };

  const findChartWidget = async (chartTitleText) => {
    const titles = chartTitleVariants(chartTitleText);
    if (!titles.length) titles.push(String(chartTitleText || 'Chart'));
    let lastError = 'chart title not found: ' + chartTitleText;
    for (const titleText of titles) {
      const { frame, result } = await evalAcrossFrames(locateChartByTitle, titleText);
      if (result && !result.error && frame) return { frame, rect: result };
      if (result && result.error) lastError = result.error;
    }
    for (const titleText of titles) {
      try {
        const result = await page.evaluate(locateChartByTitle, titleText);
        if (result && !result.error) return { frame: page.mainFrame(), rect: result };
        if (result && result.error) lastError = result.error;
      } catch (_) {}
    }
    // Nothing matched. Report WHAT IS on the page so the real widget title is
    // visible in the log instead of only the last variant that failed.
    let available = [];
    try {
      const collect = () => {
        const out = [];
        const isVis = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 10) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const nodes = document.querySelectorAll(
          '[class*="Title" i], [class*="title" i], [class*="Header" i], h1, h2, h3, h4, text, tspan'
        );
        for (const el of Array.from(nodes)) {
          if (!isVis(el)) continue;
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          t = (t || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length < 3 || t.length > 70) continue;
          if (out.indexOf(t) === -1) out.push(t);
          if (out.length >= 40) break;
        }
        return out;
      };
      const seen = [];
      for (const fr of page.frames()) {
        try {
          const got = await fr.evaluate(collect);
          for (const t of (got || [])) if (seen.indexOf(t) === -1) seen.push(t);
        } catch (_) {}
      }
      available = seen.slice(0, 40);
    } catch (_) {}
    return {
      frame: null,
      rect: null,
      error: lastError,
      tried: titles,
      available_titles: available,
    };
  };

  const getFrameViewportOffset = async (frame) => {
    if (!frame || frame === page.mainFrame()) return { x: 0, y: 0 };
    try { const frameEl = await frame.frameElement(); const box = await frameEl.boundingBox(); if (box) return { x: box.x, y: box.y }; } catch (_) {}
    return { x: 0, y: 0 };
  };

  const openShowData = async (chartTitleText) => {
    await dismissGenericErrorDialog();
    await waitForLoadingToFinish(20000);
    const { frame, rect, error, tried, available_titles } = await findChartWidget(chartTitleText);
    if (!frame || !rect) {
      // Surface the titles actually present so the log names the real widget.
      return {
        error: error || 'chart widget not located',
        tried_titles: tried || null,
        available_titles: available_titles || null,
      };
    }
    cachedDossierFrame = frame;
    const frameOffset = await getFrameViewportOffset(frame);
    const cx = frameOffset.x + rect.left + rect.width / 2;
    const cy = frameOffset.y + rect.top + Math.min(40, rect.height / 3);
    const cornerX = frameOffset.x + rect.left + rect.width - 18;
    const cornerY = frameOffset.y + rect.top + 14;

    const clickDotsAt = async (ax, ay) => {
      await page.mouse.move(cx, cy, { steps: 12 });
      await sleep(200);
      await page.mouse.move(ax, ay, { steps: 8 });
      await sleep(400);
      return await evalInFrame(frame, ([anchorX, anchorY]) => {
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const known = Array.from(document.querySelectorAll(
          '.hover-menu-btn, .hover-btn, [aria-label="Context Menu"], [aria-label*="context menu" i], [aria-label*="More" i], [title*="More" i]'
        )).filter(isVisible);
        if (known.length) {
          known.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            const da = Math.abs(ra.left - anchorX) + Math.abs(ra.top - anchorY);
            const db = Math.abs(rb.left - anchorX) + Math.abs(rb.top - anchorY);
            return da - db;
          });
          known[0].click();
          return { clicked: true, via: 'known-menu-btn' };
        }
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const t = (el.innerText || el.textContent || '').trim();
          if (t === '...' || t === '⋮' || t === '•••' || t === '···') {
            el.click();
            return { clicked: true, via: 'text-dots' };
          }
          const al = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) || '';
          if (/more options|show more|kebab|ellipsis|3.?dot|three.?dot|context\s*menu/i.test(al)) {
            el.click();
            return { clicked: true, via: 'aria-label' };
          }
        }
        const classRe = /more|kebab|ellipsis|overflow|menu|dots?[-_]?btn|hover-btn/i;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const cls = (el.getAttribute && el.getAttribute('class')) || '';
          if (!cls || !classRe.test(cls)) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.width < 64 && r.height > 0 && r.height < 64) {
            el.click();
            return { clicked: true, via: 'class-keyword' };
          }
        }
        return { error: 'dots button not found' };
      }, [ax - frameOffset.x, ay - frameOffset.y]);
    };

    let dotsClicked = await clickDotsAt(cornerX, cornerY);
    if (dotsClicked.error) {
      // Trimmed from 8 offsets to 3: each attempt costs ~2.5s (hover sleeps + two full-DOM scans),
      // and 8 fallbacks pushed a single Show Data open past 20s.
      for (const [dx, dy] of [[-8,0],[8,0],[0,-8]]) {
        dotsClicked = await clickDotsAt(cornerX + dx, cornerY + dy);
        if (dotsClicked.clicked) break;
      }
    }
    if (dotsClicked.error) {
      // Last resort: right-click chart center to open context menu.
      await page.mouse.click(cx, cy, { button: 'right' });
      await sleep(700);
      dotsClicked = { clicked: true, via: 'right-click' };
    }

    await sleep(800);

    const clickShowDataAnywhere = async () => {
      const tryClick = () => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const isMatch = t => t === 'show data' || t === 'export data' || t === 'view data'
          || /^show\s*data/.test(t) || t.includes('show data');
        const exact = [], fuzzy = [];
        for (const el of Array.from(document.querySelectorAll('li, button, a, span, div, [role="menuitem"], [role="option"]'))) {
          if (!isVisible(el)) continue;
          const raw = (el.innerText || el.textContent || '').trim();
          if (!raw || raw.length > 40) continue;
          const t = norm(raw);
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (t === 'show data' || t === 'export data') exact.push({ el, area });
          else if (isMatch(t) && area < 8000) fuzzy.push({ el, area });
        }
        exact.sort((a, b) => a.area - b.area);
        fuzzy.sort((a, b) => a.area - b.area);
        const best = exact[0] || fuzzy[0];
        if (best) { best.el.click(); return { clicked: true, text: (best.el.innerText || '').trim() }; }
        return { error: 'Show Data menu item not found' };
      };

      if (cachedDossierFrame && !cachedDossierFrame.isDetached()) {
        try {
          const r = await cachedDossierFrame.evaluate(tryClick);
          if (r && r.clicked) return r;
        } catch (_) {}
      }
      const { result } = await evalAcrossFrames(tryClick);
      if (result && result.clicked) return result;
      try {
        const r = await page.evaluate(tryClick);
        if (r && r.clicked) return r;
        return r || { error: 'Show Data menu item not found' };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    };

    let showDataClicked = await clickShowDataAnywhere();
    if (showDataClicked.error) {
      // Re-hover and retry once — menu can dismiss after grain/filter redraw.
      await dismissGenericErrorDialog();
      dotsClicked = await clickDotsAt(cornerX, cornerY);
      await sleep(900);
      showDataClicked = await clickShowDataAnywhere();
    }
    if (showDataClicked.error) {
      return { error: showDataClicked.error, dots: dotsClicked };
    }
    await sleep(1000);
    return { ok: true, dots: dotsClicked, showData: showDataClicked };
  };

  const findShowDataPopupContainer = async () => {
    // Prefer dialog/popup with a real multi-column grid — never a lone KPI cell.
    return await evalAcrossFrames(() => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 40) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const POPUP_SEL = '[role="dialog"], .mstrmojo-popup, .mstrmojo-Popup, .mstrmojo-Dialog, .mstrmojo-RootPopup, .mstrmojo-MsgBox, [class*="Popup"], [class*="Modal"], [class*="Dialog"]';
      const scoreTable = (table) => {
        if (!table || !table.rows || table.rows.length < 2) return 0;
        const cols = table.rows[0] ? table.rows[0].cells.length : 0;
        if (cols < 2) return 0; // reject single-KPI "tables"
        const rows = table.rows.length;
        const r = table.getBoundingClientRect();
        return rows * cols * 10 + (r.width * r.height) / 1000;
      };
      const candidates = Array.from(document.querySelectorAll(POPUP_SEL)).filter(isVisible);
      let best = null, bestScore = 0, bestTable = null;
      for (const el of candidates) {
        const tables = Array.from(el.querySelectorAll('table'));
        for (const table of tables) {
          const s = scoreTable(table);
          if (s > bestScore) { bestScore = s; best = el; bestTable = table; }
        }
        // ARIA grids inside popup
        const gridRows = el.querySelectorAll('[role="row"]');
        if (gridRows.length >= 3) {
          const s = gridRows.length * 5;
          if (s > bestScore) { bestScore = s; best = el; bestTable = null; }
        }
      }
      if (!best || bestScore < 20) {
        // Fallback: largest multi-col table on page that looks chart-like
        const tables = Array.from(document.querySelectorAll('table')).filter(t => scoreTable(t) > 0);
        tables.sort((a, b) => scoreTable(b) - scoreTable(a));
        if (!tables.length) {
          return {
            error: 'no multi-column Show Data table',
            popupCount: candidates.length,
            bestScore,
            visibleTables: document.querySelectorAll('table').length,
            roleRows: document.querySelectorAll('[role="row"]').length,
          };
        }
        bestTable = tables[0];
        best = bestTable.closest(POPUP_SEL) || bestTable;
        bestScore = scoreTable(bestTable);
      }
      if (bestScore < 20) {
        return {
          error: 'Show Data table too small (likely KPI, not chart)',
          popupCount: candidates.length,
          bestScore,
          visibleTables: document.querySelectorAll('table').length,
        };
      }
      let cols = bestTable && bestTable.rows[0] ? bestTable.rows[0].cells.length : 0;
      let rows = bestTable ? bestTable.rows.length : 0;
      let via = bestTable ? 'html-table' : 'aria-grid';
      // ARIA Show Data grids set bestTable=null; count role=rows so waitForShowDataPopup
      // does not treat a ready 634x494 popup as empty (rowCount=0/colCount=0).
      if (!bestTable && best) {
        const ariaRows = Array.from(best.querySelectorAll('[role="row"]'));
        rows = ariaRows.length;
        const first = ariaRows[0];
        cols = first
          ? first.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="cell"], td, [class*="cell" i]').length
          : 0;
      }
      const tr = (bestTable || best).getBoundingClientRect();
      return {
        ready: true,
        rowCount: rows,
        colCount: cols,
        score: bestScore,
        via,
        top: tr.top,
        left: tr.left,
        width: tr.width,
        height: tr.height,
      };
    });
  };

  const waitForShowDataPopup = async (maxMs = 20000) => {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < maxMs) {
      const { result } = await findShowDataPopupContainer();
      last = result;
      if (result && result.ready && (result.colCount >= 2 || result.rowCount >= 3 || (result.via === 'aria-grid' && result.score >= 20))) {
        await sleep(300);
        return result;
      }
      await sleep(250);
    }
    return { error: 'Show Data popup timed out (no multi-column chart table)', last };
  };

  const extractShowDataTable = async () => {
    const extractFn = () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const isControlText = t => /^(close|add data|export|ok|cancel)$/.test(t);
      const isKpiLike = (headers, rows) => {
        if (!headers || headers.length < 2) return true;
        if (!rows || rows.length < 1) return true;
        // Single metric + one value = KPI tile scrape, not chart Show Data
        if (headers.length === 1 && rows.length <= 2) return true;
        return false;
      };
      const POPUP_SEL = '[role="dialog"], .mstrmojo-popup, .mstrmojo-Popup, .mstrmojo-Dialog, .mstrmojo-RootPopup, [class*="Popup"], [class*="Modal"], [class*="Dialog"], [class*="overlay" i]';
      const scoreTable = (table) => {
        if (!table || !table.rows || table.rows.length < 2) return 0;
        const cols = table.rows[0] ? table.rows[0].cells.length : 0;
        if (cols < 2) return 0;
        return table.rows.length * cols;
      };
      const parseHtmlTable = (table) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) return null;
        const headerCells = Array.from(rows[0].querySelectorAll('th, td'));
        const headers = headerCells.map((h, i) => (h.innerText || h.textContent || '').trim() || ('col_' + i));
        const data = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td, th'));
          if (!cells.length) continue;
          const rowText = norm(rows[i].innerText || rows[i].textContent || '');
          if (isControlText(rowText)) continue;
          const rowData = {};
          headers.forEach((h, idx) => {
            rowData[h] = cells[idx] ? (cells[idx].innerText || cells[idx].textContent || '').trim() : '';
          });
          data.push(rowData);
        }
        if (isKpiLike(headers, data)) return null;
        return { headers, rows: data, via: 'html-table' };
      };

      // 1) Tables inside popups first
      const popups = Array.from(document.querySelectorAll(POPUP_SEL)).filter(isVisible);
      let bestParsed = null, bestScore = 0;
      for (const popup of popups) {
        for (const table of Array.from(popup.querySelectorAll('table'))) {
          const s = scoreTable(table);
          if (s < 4) continue;
          const parsed = parseHtmlTable(table);
          if (!parsed) continue;
          if (s > bestScore) { bestScore = s; bestParsed = parsed; }
        }
      }
      if (bestParsed) return bestParsed;

      // 2) Largest multi-col table on page
      const tables = Array.from(document.querySelectorAll('table')).filter(t => scoreTable(t) >= 4);
      tables.sort((a, b) => scoreTable(b) - scoreTable(a));
      for (const table of tables) {
        const parsed = parseHtmlTable(table);
        if (parsed) return parsed;
      }

      // 3) ARIA grid inside popup (same as proven Monthly script)
      for (const popupEl of popups) {
        let rowEls = Array.from(popupEl.querySelectorAll('[role="row"]')).filter(isVisible);
        rowEls.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        if (rowEls.length < 2) continue;
        let headerRowEl = rowEls.find(r => r.querySelector('[role="columnheader"]')) || rowEls[0];
        const headerCellEls = Array.from(headerRowEl.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="cell"], td, [class*="cell" i]'));
        if (headerCellEls.length < 2) continue;
        const headerCols = headerCellEls.map((h, i) => {
          const r = h.getBoundingClientRect();
          return { name: (h.innerText || h.textContent || '').trim() || ('col_' + i), cx: r.left + r.width / 2 };
        });
        const data = [];
        for (const rowEl of rowEls.filter(r => r !== headerRowEl)) {
          const cells = Array.from(rowEl.querySelectorAll('[role="gridcell"], [role="cell"], td, [class*="cell" i]'));
          if (!cells.length) continue;
          const rowText = norm(rowEl.innerText || rowEl.textContent || '');
          if (isControlText(rowText)) continue;
          const rowData = {};
          for (const cell of cells) {
            const raw = (cell.innerText || cell.textContent || '').trim();
            if (!raw) continue;
            const r = cell.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            let bestCol = null, bestDist = Infinity;
            for (const col of headerCols) {
              const d = Math.abs(cx - col.cx);
              if (d < bestDist) { bestDist = d; bestCol = col; }
            }
            if (bestCol) rowData[bestCol.name] = raw;
          }
          if (Object.keys(rowData).length > 0) data.push(rowData);
        }
        const headers = headerCols.map(c => c.name);
        if (!isKpiLike(headers, data) && data.length > 0) {
          return { headers, rows: data, via: 'aria-row-grid' };
        }
      }

      return { error: 'Show Data chart table not found (rejected KPI/single-column scrape)' };
    };

    if (cachedDossierFrame && !cachedDossierFrame.isDetached()) {
      try {
        const result = await cachedDossierFrame.evaluate(extractFn);
        if (result && !result.error) return result;
      } catch (_) {}
    }
    const { result } = await evalAcrossFrames(extractFn);
    return result;
  };

  const isGoodChartTable = (td) => {
    if (!td || td.error) return false;
    const headers = td.headers || [];
    const rows = td.rows || td.data || [];
    if (headers.length < 2) return false;
    if (!rows.length) return false;
    return true;
  };

  const closeShowDataPopup = async () => {
    const closed = await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], span, a'))) {
        const t = norm(el.innerText || el.textContent || '');
        if (t === 'close') { el.click(); return true; }
      }
      return false;
    }).catch(() => false);
    if (!closed) await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  };

  // Weekly / Monthly / Quarterly are radios beside Overall Performance — not footer tabs.
  const clickChartTimeGrain = async (grain, chartTitle = 'Overall Performance') => {
    const targetGrain = String(grain || 'Monthly');
    const titleHint = String(chartTitle || 'Overall Performance');
    const tryFrame = async (frame) => {
      try {
        return await frame.evaluate(([titleText, grainText]) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
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
          const grainN = norm(grainText);
          const title = norm(titleText);
          const grains = ['weekly', 'monthly', 'quarterly'];
          let titleRect = null, titleArea = Infinity;
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            const inner = norm(el.innerText || '');
            if (d !== title && !d.includes(title) && !(inner.includes(title) && inner.length <= title.length + 48)) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area < titleArea) { titleArea = area; titleRect = r; }
          }
          const grainHits = [];
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el)) continue;
            const d = norm(getDirectText(el));
            if (!grains.includes(d)) continue;
            const r = el.getBoundingClientRect();
            if (r.width * r.height > 8000) continue;
            grainHits.push({ el, d, r, area: r.width * r.height });
          }
          grainHits.sort((a, b) => a.area - b.area);
          if (!grainHits.length) return { error: 'no weekly/monthly/quarterly labels in frame' };
          let cluster = grainHits;
          if (titleRect) {
            const nearTitle = grainHits.filter(h =>
              Math.abs(h.r.top - titleRect.top) < 56 && h.r.left >= titleRect.left - 40
            );
            if (nearTitle.length) cluster = nearTitle;
          }
          const byRow = [];
          for (const h of cluster) {
            let row = byRow.find(x => Math.abs(x.top - h.r.top) < 22);
            if (!row) { row = { top: h.r.top, items: [] }; byRow.push(row); }
            row.items.push(h);
          }
          byRow.sort((a, b) => b.items.length - a.items.length);
          const bestRow = byRow.find(r => r.items.length >= 2) || byRow[0];
          const pool = bestRow ? bestRow.items : cluster;
          const pick = pool.find(h => h.d === grainN) || grainHits.find(h => h.d === grainN);
          if (!pick) return { error: 'grain label not found: ' + grainText };
          const clickControl = (el) => {
            const inner = el.querySelector && el.querySelector('input[type="radio"], [role="radio"]');
            if (inner) { inner.click(); return 'inner-radio'; }
            const forId = el.getAttribute && el.getAttribute('for');
            if (forId) {
              const inp = document.getElementById(forId);
              if (inp) { inp.click(); return 'label-for'; }
            }
            const parent = el.parentElement;
            if (parent) {
              const pr = parent.querySelector('input[type="radio"], [role="radio"]');
              if (pr) { pr.click(); return 'sibling-radio'; }
            }
            let prev = el.previousElementSibling;
            for (let i = 0; i < 4 && prev; i++, prev = prev.previousElementSibling) {
              const isRadio = prev.matches && (prev.matches('input[type="radio"]') || prev.getAttribute('role') === 'radio');
              const pr = isRadio ? prev : (prev.querySelector && prev.querySelector('input[type="radio"], [role="radio"]'));
              if (pr) { pr.click(); return 'prev-radio'; }
            }
            el.click();
            return 'text';
          };
          return { clicked: true, via: clickControl(pick.el), grain: grainText, cluster: pool.map(h => h.d) };
        }, [titleHint, targetGrain]);
      } catch (_) { return null; }
    };
    for (const frame of page.frames()) {
      const r = await tryFrame(frame);
      if (r && r.clicked) {
        await waitForLoadingToFinish();
        await waitForDashboard().catch(() => {});
        return r;
      }
    }
    return { error: 'grain control not found: ' + targetGrain };
  };

  // NAV_STEPS: footer tabs only. Grain (Weekly/Monthly/Quarterly) is clickByText — proven
  // in production Monthly scripts; chart-scoped radio finder is fallback only.
  const NAV_STEPS = ['Performance'];
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '\u2630'];
  const TIME_GRAIN = (typeof __timeGrain !== 'undefined' && __timeGrain)
    || (typeof context !== 'undefined' && context && context.timeGrain)
    || 'Monthly';
  // Filled by RTB assemble from scenario description (widget title for Show Data + grain radios).
  const CHART_TITLE = 'Overall Performance';
  const KPI_LABELS = [];

  const applyTimeGrain = async () => {
    await sleep(500);
    // Prefer chart-scoped radio (beside CHART_TITLE); clickByText as proven Monthly fallback.
    let r = await clickChartTimeGrain(TIME_GRAIN, CHART_TITLE);
    if (r && r.error) {
      r = await clickByText(TIME_GRAIN, { openers: NAV_OPENERS, preferMiddle: true });
    }
    if (r && r.error) {
      r = await clickByText(TIME_GRAIN, { openers: NAV_OPENERS });
    }
    await waitForLoadingToFinish();
    await dismissGenericErrorDialog();
    await waitForDashboard().catch(() => {});
    return r;
  };

  // Footer tabs live in the bottom strip; sub-tabs sit in the middle band.
  // Anchoring on single words (/^(activity|trend)$/) sent every multi-word sub-tab
  // ("Activity Performance", "Sales Performance") to the preferBottom default, and
  // preferBottom rejects everything above 62% of the viewport -- exactly where the
  // sub-tab row is. Those sub-tabs were therefore unclickable.
  const FOOTER_TAB_RE = /^(overview|performance|geography|geography details|hcp customer|pcc hcp|pre call card|competitive landscape|market access|hco customer|blink rx)$/i;
  const navPrefer = (step) => {
    const s = String(step || '').trim();
    if (FOOTER_TAB_RE.test(s)) return { preferBottom: true };
    if (/\s/.test(s) || /^(activity|trend|sales|segment)$/i.test(s)) return { preferMiddle: true };
    return {};
  };

  await waitForLoadingToFinish();
  const dossierReady = await waitForDossierReady();
  const navDebug = [{ dossier_ready: dossierReady }];
  for (const step of NAV_STEPS) {
    const pref = navPrefer(step);
    let r = await clickByText(step, { openers: NAV_OPENERS, ...pref });
    if (r && r.error) r = await clickByText(step, { openers: NAV_OPENERS });
    if (r && r.error) r = await clickByText(step, { openers: NAV_OPENERS, preferMiddle: true });
    if (r && r.error) r = await clickByText(step, { openers: NAV_OPENERS, preferBottom: true });
    navDebug.push({ step, ...r });
    await waitForLoadingToFinish();
  }
  await waitForDashboard();
  // Grain belongs with navigation (Performance → Activity → Quarterly), before filters.
  const grainNav = await applyTimeGrain();
  navDebug.push({ step: TIME_GRAIN, ...(grainNav || {}) });

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  const extractChartAfterGrain = async (row) => {
    // Filters often leave Territory dropdown + MSTR Error modal open (blocks Show Data).
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await sleep(300);

    // Re-assert grain after filters (filters can reset Weekly). Prefer clickByText like working script.
    row.time_grain = await applyTimeGrain();
    await closeAnyOpenDropdown();
    await sleep(400);

    const tryExtract = async (popupMs = 20000) => {
      const openResult = await openShowData(CHART_TITLE);
      if (openResult.error) return { openResult, tableData: null, waitResult: null };
      const waitResult = await waitForShowDataPopup(popupMs);
      if (waitResult && waitResult.error) {
        await closeShowDataPopup().catch(() => {});
        return { openResult, waitResult, tableData: null };
      }
      const tableData = await extractShowDataTable();
      await closeShowDataPopup();
      return { openResult, waitResult, tableData };
    };

    let attempt = await tryExtract(20000);
    if (!isGoodChartTable(attempt.tableData)) {
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
      await sleep(300);
      await clickChartTimeGrain(TIME_GRAIN, CHART_TITLE);
      await waitForLoadingToFinish(15000);
      await dismissGenericErrorDialog();
      attempt = await tryExtract(15000);
    }

    row.show_data_debug = {
      open: attempt.openResult || null,
      wait: attempt.waitResult || null,
      tableError: (attempt.tableData && attempt.tableData.error) || null,
    };
    if (!isGoodChartTable(attempt.tableData)) {
      row.show_data_error = (attempt.tableData && attempt.tableData.error)
        || (attempt.openResult && attempt.openResult.error)
        || (attempt.waitResult && attempt.waitResult.error)
        || 'extracted table is not a multi-column chart Show Data grid';
      if (attempt.tableData) row.tableData_rejected = attempt.tableData;
    } else {
      row.tableData = attempt.tableData;
      row.chart_title = CHART_TITLE;
      // Same key as the scenario KPI label so Latest result can bind without guessing.
      row[CHART_TITLE] = attempt.tableData;
    }
    return row;
  };

  if (filterCombinations.length === 0) {
    await waitForDashboard();
    const row = await extractChartAfterGrain({ navigation: navDebug });
    return { navigation: navDebug, ...row };
  }

  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDossierReady();
      await dismissGenericErrorDialog();
      for (const step of NAV_STEPS) {
        const pref = navPrefer(step);
        let r = await clickByText(step, { openers: NAV_OPENERS, ...pref });
        if (r && r.error) r = await clickByText(step, { openers: NAV_OPENERS });
      }
      await waitForDashboard();
      await applyTimeGrain();
    }
    // (removed a duplicate waitForDossierReady: the page is already ready after
    // nav + waitForDashboard + applyTimeGrain; it cost up to 30s per combination.)
    const debug = {};
    // Match working script: geo first, Time Bucket / others after (not interleaved with Territory).
    const GEO_ORDER = ['Area', 'Region', 'Territory'];
    const allKeys = Object.keys(filters);
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
    for (const key of geoKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    for (const key of otherKeys) {
      debug[key] = await selectByLabel(key, filters[key]);
      await dismissGenericErrorDialog();
      await closeAnyOpenDropdown();
    }
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await waitForLoadingToFinish();
    const row = await extractChartAfterGrain({ filters_applied: debug, navigation: navDebug });
    results[label] = row;
  }
  return { navigation: navDebug, results };
};