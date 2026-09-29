/**
 * RTB skill template: MSTR grid / crosstab (Geography Details or Performance Trend Grid).
 * Filled from UI: report URL, GRID_TITLE, NAV_STEPS, TIME_GRAIN (Trend only), EXPECTED_COLUMNS.
 * Filters come from runtime __filterCombinations (never hardcode Area/Region values).
 * Extract: Menu → Show Data popup first; on-page scroll merge only as fallback.
 * Never keep Overview "Performance KPIs" / "Line copy" scrapes as the grid.
 * Runtime: Browserless /chromium/function — export default async ({ page }) => { ... }
 */
export default async ({ page }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = "https://mstr-prod.bayer.com/MicroStrategyLibrarySTD/app/267EB189214A7BC7D7B2A786A73B806E/B6589CA7FB48E71EA94D0A9D343F10CE/share";
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1920, height: 1080 }); } catch (_) {}
    try {
      await page.evaluate(() => {
        document.documentElement.style.zoom = '100%';
        if (document.body) document.body.style.zoom = '100%';
      });
    } catch (_) {}
  };
  await __tryWidenViewport();
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
  const reportUrl = "https://mstr-prod.bayer.com/MicroStrategyLibrarySTD/app/267EB189214A7BC7D7B2A786A73B806E/B6589CA7FB48E71EA94D0A9D343F10CE/share";
  const GRID_TITLE = "Performance Trend";
  const KPI_LABEL = "Performance Trend Grid";
  const TIME_GRAIN = "Quarterly";
  const EXPECTED_COLUMNS = [
        "Area",
        "Employee Name",
        "NBRx Total",
        "NRx Total",
        "TRx Total",
        "Blink TRx",
        "NBRx New Writers",
        "Total Writers",
        "Total Calls",
        "Total HCP Calls",
        "F2F HCP Calls",
        "Virtual HCP Calls",
        "Reach (%)",
        "NBRx Breadth (%)",
        "NBRx Depth",
        "Calls to Target (%)",
        "Calls/Day HCP",
        "Frequency",
        "Speaker Programs Attended"
    ];
  const NAV_STEPS = [
        "Performance",
        "Performance Trend"
    ];
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '☰'];
  // Trend viz title is often "Performance Trend Grid"; GRID_TITLE is the shorter tab label.
  const gridTitleHints = () => {
    const hints = [];
    const add = (s) => {
      const t = String(s || '').trim();
      if (!t) return;
      if (hints.some(h => h.toLowerCase() === t.toLowerCase())) return;
      if (/nbrx|nrx|trx|writers|calls|reach|frequency/i.test(t) && !/grid|trend|geography/i.test(t)) return;
      hints.push(t);
    };
    add(GRID_TITLE);
    if (/trend/i.test(GRID_TITLE)) {
      add(KPI_LABEL);
      add('Performance Trend Grid');
    }
    hints.sort((a, b) => b.length - a.length);
    return hints;
  };
  await __tryWidenViewport();

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

  // Ready BEFORE tab nav: filter chrome / footer tabs. Do not wait for grid
  // titles or "NBRx Total" here — those live on Geography / Trend, not Overview.
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

  // Ready AFTER tab nav: require real grid evidence, not the tab/radio words
  // "Performance Trend" / "Quarterly" that exist before the crosstab paints.
  const waitForDashboard = async (maxMs = 25000) => {
    await waitForLoadingToFinish(maxMs);
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate((expectedCols) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const getDirectText = el => {
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          return t.trim();
        };
        const isNavChrome = el => {
          if (!el || !el.closest) return false;
          if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
          const r = el.getBoundingClientRect();
          const vh = window.innerHeight || 900;
          return r.top > vh * 0.82 && r.height < 52 && r.width < 320;
        };
        const looksLikeHeader = el => {
          const r = el.getBoundingClientRect();
          return r.width >= 16 && r.width < 360 && r.height >= 8 && r.height < 56;
        };
        const headerTexts = [];
        const sels = 'th, [role="columnheader"], [class*="ag-header-cell"], [class*="Xtab" i] span, [class*="xtab" i] span, [class*="Xtab" i] div, [class*="xtab" i] div';
        for (const el of Array.from(document.querySelectorAll(sels))) {
          if (!isVisible(el) || isNavChrome(el) || !looksLikeHeader(el)) continue;
          const d = norm(getDirectText(el) || el.innerText || '');
          if (d && d.length < 60) headerTexts.push(d);
        }
        if (!headerTexts.length) {
          for (const el of Array.from(document.querySelectorAll('span, div, label'))) {
            if (!isVisible(el) || isNavChrome(el) || !looksLikeHeader(el)) continue;
            const d = norm(getDirectText(el));
            if (d && d.length < 40) headerTexts.push(d);
          }
        }
        if (headerTexts.some(t => t === 'employee name')) return true;
        const metrics = (expectedCols || []).map(c => norm(c)).filter(c => c && c !== 'area' && c !== 'employee name');
        const metricHits = metrics.filter(m => headerTexts.some(t => t === m));
        if (metricHits.length >= 2) return true;
        const xtab = Array.from(document.querySelectorAll('[class*="Xtab" i], [class*="xtab" i], [role="grid"], table, [class*="ag-root" i]'))
          .some(el => {
            if (!isVisible(el) || isNavChrome(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 220 && r.height > 90;
          });
        if (xtab && headerTexts.some(t => t === 'area' || t === 'employee name' || /nbrx total|nrx total|trx total/.test(t))) return true;
        return false;
      }, EXPECTED_COLUMNS).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(maxMs);
  };

  const closeAnyOpenDropdown = async () => {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
    }).catch(() => {});
    await sleep(250);
  };

  const clickByText = async (step, opts = {}) => {
    const openers = (opts && opts.openers) || NAV_OPENERS;
    const tryClick = async () => page.evaluate((label) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const getDirectText = el => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      };
      const isLongerPhrase = (s) => s.startsWith(want) && s.length > want.length && /\s/.test(s.slice(want.length));
      const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], span, div, li'));
      const exact = [], fuzzy = [];
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        const d = norm(getDirectText(el));
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area >= 80000) continue;
        if (t === want || d === want) { exact.push({ el, area }); continue; }
        // "Performance" must not click "Performance Trend"
        if (t.length <= want.length + 16 && t.includes(want) && !isLongerPhrase(t) && !isLongerPhrase(d)) {
          fuzzy.push({ el, area });
        }
      }
      const pool = exact.length ? exact : fuzzy;
      if (!pool.length) return { error: 'not found: ' + label };
      pool.sort((a, b) => a.area - b.area);
      const best = pool[0].el;
      best.click();
      return { clicked: true, text: (best.innerText || '').trim().slice(0, 60) };
    }, step).catch(() => ({ error: 'evaluate failed' }));
    let res = await tryClick();
    if (res && res.error) {
      for (const op of openers) {
        await page.evaluate((label) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const want = norm(label);
          for (const el of Array.from(document.querySelectorAll('button, [role="button"], span, div'))) {
            const t = norm(el.innerText || el.textContent || '');
            if (t === want || t === '☰') { el.click(); return true; }
          }
          return false;
        }, op).catch(() => false);
        await sleep(400);
        res = await tryClick();
        if (res && !res.error) break;
      }
    }
    await waitForLoadingToFinish();
    return res;
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


  const prettyCol = (s) => String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());

  const isJunkCol = (k) => {
    const s = String(k || '');
    if (!s.trim()) return true;
    if (/^col_\d+$/i.test(s)) return true;
    if (/line\s*copy/i.test(s)) return true;
    if (/performance\s*kpis/i.test(s)) return true;
    // KPI tile text glued into a header: "NBRx Total 3,391.0"
    if (/\d/.test(s) && /nbrx|nrx|trx|writers|blink|calls|reach|frequency/i.test(s)) return true;
    // Territory ids mistaken for columns
    if (/^\d{3}[a-z]\b/i.test(s)) return true;
    return false;
  };

  const isGarbageGridRaw = (raw) => {
    if (!raw || raw.error) return true;
    const headers = raw.headers || raw.columns || [];
    const records = Array.isArray(raw.data) ? raw.data
      : (Array.isArray(raw.rows) && raw.rows[0] && !Array.isArray(raw.rows[0]) ? raw.rows : null);
    const blob = JSON.stringify({ headers, sample: (records || raw.rows || []).slice(0, 8) }).toLowerCase();
    if (/performance\s*kpis\s*-/.test(blob)) return true;
    if ((headers || []).filter((h) => /line\s*copy/i.test(String(h))).length >= 2) return true;
    if ((headers || []).filter((h) => isJunkCol(h)).length >= Math.max(3, Math.floor((headers || []).length / 2))) return true;
    return false;
  };

  const toGrid = (raw) => {
    if (!raw || raw.error) return raw || { error: 'no table' };
    if (isGarbageGridRaw(raw)) return { error: 'rejected Performance KPIs / chrome scrape', via: raw.via || 'rejected' };
    const records = Array.isArray(raw.data) ? raw.data
      : (Array.isArray(raw.rows) && raw.rows.length && raw.rows[0] && !Array.isArray(raw.rows[0]) ? raw.rows : null);
    if (!records || !records.length) {
      // Already matrix form { columns, rows: string[][] }
      if (Array.isArray(raw.columns) && Array.isArray(raw.rows) && Array.isArray(raw.rows[0])) {
        const keepIdx = raw.columns.map((c, i) => (isJunkCol(c) ? -1 : i)).filter((i) => i >= 0);
        if (keepIdx.length < 2) return { error: 'too few clean columns after filter' };
        return {
          columns: keepIdx.map((i) => prettyCol(raw.columns[i])),
          rows: raw.rows.map((row) => keepIdx.map((i) => (row && row[i] != null ? String(row[i]) : ''))),
          via: raw.via || 'normalized-grid',
        };
      }
      return raw;
    }
    const keys = [];
    for (const rec of records) {
      for (const k of Object.keys(rec || {})) {
        if (!k || isJunkCol(k)) continue;
        if (!keys.includes(k)) keys.push(k);
      }
    }
    if (keys.length < 2) return { error: 'too few clean columns after filter', via: raw.via };
    const columns = keys.map(prettyCol);
    const rows = records.map((rec) => keys.map((k) => (rec[k] == null ? '' : String(rec[k]))));
    // Drop rows that are clearly Overview KPI chrome
    const cleanRows = rows.filter((line) => !/performance\s*kpis/i.test(String(line[0] || '')));
    if (!cleanRows.length) return { error: 'only Performance KPIs rows after filter' };
    return { columns, rows: cleanRows, data: records, via: raw.via || 'normalized-grid' };
  };

  const dismissGenericErrorDialog = async () => {
    await page.evaluate(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], a, span'))) {
        const t = norm(el.innerText || el.textContent || '');
        if (t === 'ok' || t === 'close' || t === 'dismiss') {
          const box = el.closest('[role="dialog"], .mstrmojo-Dialog, .mstrmojo-MsgBox, [class*="Dialog"], [class*="Modal"]');
          if (box || /error|warning/i.test((document.body && document.body.innerText) || '')) {
            try { el.click(); } catch (_) {}
          }
        }
      }
    }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(200);
  };

  // Locate grid/crosstab (or chart) under GRID_TITLE — used to open widget Menu → Show Data.
  const findGridWidget = async (titleText) => {
    for (const frame of page.frames()) {
      const result = await frame.evaluate((want) => {
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const getDirectText = el => {
          let t = '';
          for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
          return t.trim();
        };
        const hints = (Array.isArray(want) ? want : [want]).map(s => String(s || '').trim()).filter(Boolean);
        const vh = window.innerHeight || 900;
        const isNavChrome = el => {
          if (!el || !el.closest) return false;
          if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
          const r = el.getBoundingClientRect();
          if (r.top > vh * 0.82 && r.height < 52 && r.width < 320) return true;
          let cls = '';
          try { cls = String(el.className || ''); } catch (_) {}
          return /dock|pageTab|TabBar|tab-item|mstrmojo-Dock|navItem/i.test(cls);
        };
        let titleEl = null, titleScore = -Infinity;
        for (const hint of hints) {
          const target = hint.toLowerCase();
          for (const el of Array.from(document.querySelectorAll('*'))) {
            if (!isVisible(el) || isNavChrome(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.top > vh * 0.88) continue; // skip footer tabs
            const d = (getDirectText(el) || '').toLowerCase();
            const full = ((el.innerText || '').replace(/\s+/g, ' ').trim()).toLowerCase();
            const exact = d === target || full === target;
            const hit = exact || (d.includes(target) && d.length <= target.length + 28)
              || (full.includes(target) && full.length <= target.length + 28);
            if (!hit) continue;
            const area = r.width * r.height;
            if (area > 160000) continue;
            const score = (exact ? 5000 : 0) + target.length * 20 - Math.sqrt(area) - r.top * 0.05;
            if (score > titleScore) { titleScore = score; titleEl = el; }
          }
        }
        if (!titleEl) {
          for (const el of Array.from(document.querySelectorAll('th, [role="columnheader"], span, div, td'))) {
            if (!isVisible(el) || isNavChrome(el)) continue;
            if (String(getDirectText(el) || '').toLowerCase() !== 'employee name') continue;
            const r = el.getBoundingClientRect();
            if (r.width > 400 || r.height > 60) continue;
            titleEl = el;
            break;
          }
        }
        if (!titleEl) return { error: 'grid title not found: ' + hints.join(' / ') };
        const tr = titleEl.getBoundingClientRect();
        const sels = [
          '[class*="Xtab" i]', '[class*="xtab" i]', '[role="grid"]', 'table',
          '[class*="Grid" i]', '[class*="ag-root" i]',
          'canvas', 'svg', '[class*="highcharts" i]', '[class*="mstrmojo-graph" i]',
        ];
        let best = null, bestScore = -1, bestRect = null;
        for (const el of Array.from(document.querySelectorAll(sels.join(',')))) {
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 60) continue;
          if (r.bottom < tr.top - 20) continue;
          if (r.top < tr.bottom - 40 && r.top + 40 < tr.bottom) continue;
          const dist = Math.max(0, r.top - tr.bottom) + Math.abs(r.left - tr.left) * 0.15;
          const score = (r.width * r.height) / 1000 - dist;
          if (score > bestScore) { bestScore = score; best = el; bestRect = r; }
        }
        if (!bestRect) {
          // Fallback: large region below title (menu still works on hover)
          bestRect = {
            top: tr.bottom + 4,
            left: Math.max(0, tr.left),
            width: Math.max(400, Math.min(900, (window.innerWidth || 1200) - tr.left - 40)),
            height: Math.max(220, Math.min(480, vh - tr.bottom - 40)),
          };
        }
        return { top: bestRect.top, left: bestRect.left, width: bestRect.width, height: bestRect.height };
      }, titleText).catch(() => null);
      if (result && !result.error) return { frame, rect: result };
    }
    return { frame: null, rect: null, error: 'grid widget not located for ' + titleText };
  };

  const getFrameViewportOffset = async (frame) => {
    if (!frame || frame === page.mainFrame()) return { x: 0, y: 0 };
    try {
      const frameEl = await frame.frameElement();
      const box = await frameEl.boundingBox();
      if (box) return { x: box.x, y: box.y };
    } catch (_) {}
    return { x: 0, y: 0 };
  };

  const openShowData = async (titleText) => {
    await dismissGenericErrorDialog();
    await closeAnyOpenDropdown();
    await waitForLoadingToFinish(20000);
    const { frame, rect, error } = await findGridWidget(titleText);
    if (!frame || !rect) return { error: error || 'grid widget not located' };
    const frameOffset = await getFrameViewportOffset(frame);
    const cx = frameOffset.x + rect.left + rect.width / 2;
    const cy = frameOffset.y + rect.top + Math.min(40, rect.height / 3);
    const cornerX = frameOffset.x + rect.left + rect.width - 18;
    const cornerY = frameOffset.y + rect.top + 14;

    const clickDotsAt = async (ax, ay) => {
      await page.mouse.move(cx, cy, { steps: 12 });
      await sleep(350);
      await page.mouse.move(ax, ay, { steps: 12 });
      await sleep(700);
      return await frame.evaluate(([anchorX, anchorY]) => {
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
        return { error: 'dots / menu button not found' };
      }, [ax - frameOffset.x, ay - frameOffset.y]).catch(() => ({ error: 'dots evaluate failed' }));
    };

    let dotsClicked = await clickDotsAt(cornerX, cornerY);
    if (dotsClicked.error) {
      for (const [dx, dy] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-16, -4], [16, -4], [-20, 10], [10, 20]]) {
        dotsClicked = await clickDotsAt(cornerX + dx, cornerY + dy);
        if (dotsClicked.clicked) break;
      }
    }
    if (dotsClicked.error) {
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
      try {
        const r = await frame.evaluate(tryClick);
        if (r && r.clicked) return r;
      } catch (_) {}
      for (const f of page.frames()) {
        try {
          const r = await f.evaluate(tryClick);
          if (r && r.clicked) return r;
        } catch (_) {}
      }
      return await page.evaluate(tryClick).catch((e) => ({ error: String(e && e.message || e) }));
    };

    let showDataClicked = await clickShowDataAnywhere();
    if (showDataClicked.error) {
      await dismissGenericErrorDialog();
      dotsClicked = await clickDotsAt(cornerX, cornerY);
      await sleep(900);
      showDataClicked = await clickShowDataAnywhere();
    }
    if (showDataClicked.error) return { error: showDataClicked.error, dots: dotsClicked };
    await sleep(1000);
    return { ok: true, dots: dotsClicked, showData: showDataClicked };
  };

  const extractShowDataTable = async () => {
    const extractFn = () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const POPUP_SEL = '[role="dialog"], .mstrmojo-popup, .mstrmojo-Popup, .mstrmojo-Dialog, .mstrmojo-RootPopup, .mstrmojo-MsgBox, [class*="Popup"], [class*="Modal"], [class*="Dialog"]';
      const isControlText = (t) => /^(close|ok|cancel|export|print|search|filter)$/i.test(norm(t));
      const isKpiLike = (headers, data) => {
        if (!headers || headers.length < 2) return true;
        if (!data || !data.length) return true;
        const blob = JSON.stringify({ headers, data: data.slice(0, 5) }).toLowerCase();
        if (/performance\s*kpis\s*-/.test(blob)) return true;
        if ((headers.filter(h => /line\s*copy/i.test(String(h))).length) >= 2) return true;
        return false;
      };
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
        return { headers, data, via: 'show-data-html-table' };
      };

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

      const tables = Array.from(document.querySelectorAll('table')).filter(t => scoreTable(t) >= 4);
      tables.sort((a, b) => scoreTable(b) - scoreTable(a));
      for (const table of tables) {
        const parsed = parseHtmlTable(table);
        if (parsed) return parsed;
      }

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
          return { headers, data, via: 'show-data-aria-grid' };
        }
      }
      return { error: 'Show Data table not found' };
    };

    for (const frame of page.frames()) {
      try {
        const result = await frame.evaluate(extractFn);
        if (result && !result.error) return result;
      } catch (_) {}
    }
    return await page.evaluate(extractFn).catch(() => ({ error: 'Show Data extract failed' }));
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

  const extractViaShowData = async (titleHint) => {
    const openResult = await openShowData(titleHint);
    if (openResult && openResult.error) return { error: openResult.error, open: openResult };
    await waitForLoadingToFinish(20000);
    const table = await extractShowDataTable();
    await closeShowDataPopup();
    if (!table || table.error || isGarbageGridRaw(table)) {
      return { error: (table && table.error) || 'Show Data returned KPI/chrome noise', open: openResult };
    }
    return table;
  };

  const extractOnPageGrid = async (titleHint, expectedCols) => {
    const titleHints = (() => {
      const raw = Array.isArray(titleHint) ? titleHint : [titleHint];
      const hints = [];
      const add = (s) => {
        const t = String(s || '').trim();
        if (!t || hints.some(h => h.toLowerCase() === t.toLowerCase())) return;
        hints.push(t);
      };
      raw.forEach(add);
      if (raw.some(t => /trend/i.test(String(t || ''))) || /trend/i.test(GRID_TITLE)) {
        add(KPI_LABEL);
        add('Performance Trend Grid');
      }
      hints.sort((a, b) => b.length - a.length);
      return hints;
    })();
    const scrapeFn = (payload) => {
      const titleHintsIn = Array.isArray(payload && payload.titles)
        ? payload.titles
        : [String((payload && payload.title) || payload || '')];
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const isOnPage = el => {
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        } catch (_) { return false; }
      };
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const isNoiseCell = (raw) => {
        const t = String(raw || '');
        if (/performance\s*kpis/i.test(t)) return true;
        if (/^line\s*copy/i.test(t)) return true;
        if (/\d/.test(t) && /^(nbrx|nrx|trx|blink|total writers)\b/i.test(t)) return true;
        return false;
      };
      const headerNameRe = /territory|employee name|area|nbrx total|nrx total|trx total|total calls|reach|frequency|speaker|quarter|qtd|metric/i;
      const vh = window.innerHeight || 900;
      const isNavChrome = el => {
        if (!el || !el.closest) return false;
        if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
        const r = el.getBoundingClientRect();
        if (r.top > vh * 0.82 && r.height < 52 && r.width < 320) return true;
        let cls = '';
        try { cls = String(el.className || ''); } catch (_) {}
        return /dock|pageTab|TabBar|tab-item|mstrmojo-Dock|navItem/i.test(cls);
      };
      let titleEl = null, titleRect = null, titleScore = -Infinity;
      for (const hint of titleHintsIn) {
        const want = norm(hint).toLowerCase();
        if (!want) continue;
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (!isOnPage(el) || isNavChrome(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.top > vh * 0.88) continue; // skip footer nav tabs
          const d = norm(getDirectText(el)).toLowerCase();
          const full = norm(el.innerText || '').toLowerCase();
          const exact = d === want || full === want;
          const hit = exact || (d.includes(want) && d.length <= want.length + 28)
            || (full.includes(want) && full.length <= want.length + 28);
          if (!hit) continue;
          const area = r.width * r.height;
          if (area > 160000) continue;
          const score = (exact ? 5000 : 0) + want.length * 20 - Math.sqrt(area) - r.top * 0.05;
          if (score > titleScore) { titleScore = score; titleEl = el; titleRect = r; }
        }
      }
      if (!titleRect) {
        for (const el of Array.from(document.querySelectorAll('th, [role="columnheader"], span, div, td'))) {
          if (!isOnPage(el) || isNavChrome(el)) continue;
          if (norm(getDirectText(el)).toLowerCase() !== 'employee name') continue;
          const r = el.getBoundingClientRect();
          if (r.width > 400 || r.height > 60) continue;
          titleEl = el;
          titleRect = { top: Math.max(0, r.top - 36), left: r.left, bottom: r.bottom, right: r.right, width: r.width, height: r.height };
          break;
        }
      }
      // Trend/Geography: do not scrape the whole page when title is missing (that yields KPI chrome).
      if (!titleRect && /trend|geography/i.test(titleHintsIn.join(' '))) {
        return { error: 'grid title not found on page', title_found: false, cell_count: 0 };
      }
      const region = titleRect
        ? { top: titleRect.bottom - 8, left: Math.max(0, titleRect.left - 80), right: 100000, bottom: Math.max((window.innerHeight || 900) + 400, titleRect.bottom + 900) }
        : { top: 60, left: 0, right: 100000, bottom: 10000 };

      const cellsFromTable = (table) => {
        const out = [];
        if (!table || !table.rows) return out;
        for (let i = 0; i < table.rows.length; i++) {
          const row = table.rows[i];
          for (let j = 0; j < row.cells.length; j++) {
            const el = row.cells[j];
            const r = el.getBoundingClientRect();
            const raw = norm(el.innerText || el.textContent || '');
            if (!raw || raw.length > 80) continue;
            out.push({ raw, cx: r.left + r.width / 2, top: r.top, left: r.left });
          }
        }
        return out;
      };

      const infos = [];
      const pushInfo = (raw, r) => {
        if (!raw) return;
        if (infos.some(o => o.raw === raw && Math.abs(o.cx - (r.left + r.width / 2)) < 6 && Math.abs(o.top - r.top) < 6)) return;
        infos.push({ raw, cx: r.left + r.width / 2, top: r.top, left: r.left });
      };

      for (const table of Array.from(document.querySelectorAll('table'))) {
        const r = table.getBoundingClientRect();
        if (titleRect && r.bottom < titleRect.top) continue;
        for (const c of cellsFromTable(table)) {
          if (!isNoiseCell(c.raw)) infos.push(c);
        }
      }

      const cellEls = Array.from(document.querySelectorAll(
        'th, td, [role="columnheader"], [role="gridcell"], [role="cell"], [class*="Xtab" i], [class*="xtab" i], [class*="ag-header-cell"], [class*="ag-cell"], [class*="cell" i], span, div'
      ));
      for (const el of cellEls) {
        const r = el.getBoundingClientRect();
        if (r.top < region.top || r.left < region.left - 40) continue;
        if (r.top > region.bottom) continue;
        if (r.width > 420 || r.height > 70 || r.width * r.height > 28000) continue;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none') continue;
        const raw = norm(getDirectText(el) || el.innerText || el.textContent || '');
        if (!raw || raw.length > 80 || raw.split('\n').length > 2) continue;
        if (isNoiseCell(raw)) continue;
        pushInfo(raw, r);
      }

      if (infos.length < 6) {
        return { error: 'on-page grid cells not found', title_found: !!titleEl, cell_count: infos.length };
      }
      infos.sort((a, b) => a.top - b.top || a.cx - b.cx);
      const rowClusters = [];
      for (const c of infos) {
        let row = rowClusters.find(x => Math.abs(x.top - c.top) <= 12);
        if (!row) { row = { top: c.top, cells: [] }; rowClusters.push(row); }
        row.cells.push(c);
        row.top = (row.top * (row.cells.length - 1) + c.top) / row.cells.length;
      }
      rowClusters.sort((a, b) => a.top - b.top);
      const xs = infos.map(c => c.cx).sort((a, b) => a - b);
      const cols = [];
      for (const x of xs) {
        let col = cols.find(c => Math.abs(c.mean - x) <= 22);
        if (!col) { col = { mean: x, n: 0 }; cols.push(col); }
        col.n++;
        col.mean = (col.mean * (col.n - 1) + x) / col.n;
      }
      cols.sort((a, b) => a.mean - b.mean);
      const colIndex = (cx) => {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < cols.length; i++) {
          const d = Math.abs(cols[i].mean - cx);
          if (d < bestD) { bestD = d; best = i; }
        }
        return best;
      };
      const matrix = rowClusters.map(row => {
        const line = [];
        for (let i = 0; i < cols.length; i++) line.push('');
        for (const cell of row.cells) {
          const i = colIndex(cell.cx);
          if (!line[i]) line[i] = cell.raw;
        }
        return line;
      });
      let headerIdx = matrix.findIndex(line => {
        const clean = line.filter(t => t && !isNoiseCell(t) && !/\d/.test(t.replace(/,/g, '')));
        return clean.filter(t => headerNameRe.test(t)).length >= 2;
      });
      if (headerIdx < 0) headerIdx = matrix.findIndex(line => line.filter(t => headerNameRe.test(t) && !isNoiseCell(t)).length >= 2);
      if (headerIdx < 0) headerIdx = 0;
      const headers = matrix[headerIdx].map((h, i) => h || (i === 0 ? 'Area' : ('col_' + i)));
      if (!headers[0]) headers[0] = 'Area';
      const data = [];
      for (let i = 0; i < matrix.length; i++) {
        if (i === headerIdx) continue;
        const line = matrix[i];
        if (!line.some(Boolean)) continue;
        if (/performance\s*kpis/i.test(String(line[0] || ''))) continue;
        const row = {};
        for (let j = 0; j < headers.length; j++) row[headers[j]] = line[j] || '';
        data.push(row);
      }
      if (!data.length) return { error: 'on-page grid had no data rows', headers, cell_count: infos.length };
      const out = { data, headers, via: 'on-page-clustered', title_found: !!titleEl, cell_count: infos.length };
      const junkHeaders = headers.filter(h => /line\s*copy/i.test(h) || (/\d/.test(h) && /nbrx|nrx|trx|writers/i.test(h)));
      if (junkHeaders.length >= 2) return { error: 'on-page scrape looks like KPI/chart chrome', headers, junk: junkHeaders };
      return out;
    };

    const scrollXtab = (titleText, dir) => {
      const hints = (Array.isArray(titleText) ? titleText : [titleText]).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
      const getDirectText = el => {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      };
      const vh = window.innerHeight || 900;
      const isNavChrome = el => {
        if (!el || !el.closest) return false;
        if (el.closest('[role="tab"], [role="tablist"], [role="navigation"]')) return true;
        const r = el.getBoundingClientRect();
        return r.top > vh * 0.82 && r.height < 52 && r.width < 320;
      };
      let tr = null, titleScore = -Infinity;
      for (const title of hints) {
        for (const el of Array.from(document.querySelectorAll('*'))) {
          if (isNavChrome(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8 || r.top > vh * 0.88) continue;
          const d = (getDirectText(el) || '').toLowerCase();
          const exact = d === title;
          if (!exact && !(d.includes(title) && d.length <= title.length + 28)) continue;
          const area = r.width * r.height;
          if (area > 160000) continue;
          const score = (exact ? 5000 : 0) + title.length * 20 - Math.sqrt(area) - r.top * 0.05;
          if (score > titleScore) { titleScore = score; tr = r; }
        }
      }
      const preferred = Array.from(document.querySelectorAll(
        '.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport, .ag-body-viewport, .mstrmojo-scrollNode, .mstrmojo-Xtab-scrollbox, [class*="hScroll" i], [class*="horizontal-scroll" i]'
      ));
      const extra = Array.from(document.querySelectorAll(
        '[class*="Xtab" i], [class*="xtab" i], [role="grid"], table, [class*="Grid" i], [class*="scroll" i], div'
      ));
      const seen = new Set();
      const candidates = [];
      for (const el of preferred.concat(extra)) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 4) continue;
        if (tr && r.bottom < tr.top) continue;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow > 4) candidates.push({ el, overflow, thin: r.height < 36 ? 0 : 1 });
      }
      candidates.sort((a, b) => a.thin - b.thin || b.overflow - a.overflow);
      if (!candidates.length) return { scrolled: false };
      let moved = false, left = 0, max = 0;
      for (const c of candidates.slice(0, 6)) {
        const el = c.el;
        const before = el.scrollLeft;
        if (dir === 'start') el.scrollLeft = 0;
        else if (dir === 'end') el.scrollLeft = el.scrollWidth;
        else el.scrollLeft = Math.min(el.scrollWidth, el.scrollLeft + Math.max(220, Math.floor(Math.max(el.clientWidth, 200) * 0.75)));
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (el.scrollLeft !== before) moved = true;
        left = el.scrollLeft;
        max = el.scrollWidth - el.clientWidth;
      }
      return { scrolled: moved || dir === 'start', left, max };
    };

    const mergeParts = (parts) => {
      const ok = (parts || []).filter(p => p && !p.error && Array.isArray(p.data) && p.data.length);
      if (!ok.length) return parts && parts[0] ? parts[0] : { error: 'no grid parts' };
      const rowKey = rec => {
        const keys = Object.keys(rec || {});
        const attr = keys.find(k => /area|employee|territory|name/i.test(k)) || keys[0];
        return rec && attr ? String(rec[attr]) : '';
      };
      const headerOrder = [];
      for (const p of ok) {
        for (const h of (p.headers || Object.keys(p.data[0] || {}))) {
          if (!h || /line\s*copy/i.test(h) || (/\d/.test(h) && /nbrx|nrx|trx|writers/i.test(h))) continue;
          if (headerOrder.indexOf(h) < 0) headerOrder.push(h);
        }
      }
      const byRow = {};
      const order = [];
      for (const p of ok) {
        for (const rec of p.data) {
          const k = rowKey(rec);
          if (/performance\s*kpis/i.test(k)) continue;
          if (!byRow[k]) { byRow[k] = {}; order.push(k); }
          Object.assign(byRow[k], rec);
        }
      }
      const data = order.map(k => {
        const rec = byRow[k] || {};
        const out = {};
        headerOrder.forEach(h => { out[h] = rec[h] != null ? rec[h] : ''; });
        return out;
      });
      const merged = { data, headers: headerOrder, via: 'on-page-scrolled-merge', parts: ok.length };
      if (!headerOrder.length || !data.length) return { error: 'merged grid empty after noise filter' };
      return merged;
    };

    const headerKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
    const hasExpected = (part) => {
      if (!expectedCols || !expectedCols.length || !part || !part.headers) return false;
      const got = new Set((part.headers || []).map(headerKey).filter(Boolean));
      const want = expectedCols.map(headerKey).filter(k => k && !/^(area|employeename|col\d+)$/.test(k));
      if (!want.length) return false;
      const hits = want.filter(k => [...got].some(g => g === k || g.includes(k) || k.includes(g)));
      return hits.length >= Math.min(want.length, Math.max(10, want.length - 1));
    };

    const scrapeWithScroll = async (frame, titles) => {
      const parts = [];
      try { await frame.evaluate(scrollXtab, titles, 'start'); } catch (_) {}
      await sleep(280);
      parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
      for (let i = 0; i < 14; i++) {
        if (hasExpected(mergeParts(parts))) break;
        let info = { scrolled: false };
        try { info = await frame.evaluate(scrollXtab, titles, 'next'); } catch (_) {}
        if (!info || !info.scrolled) break;
        await sleep(240);
        parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
        if (info.max != null && info.left >= info.max - 8) break;
      }
      try { await frame.evaluate(scrollXtab, titles, 'end'); } catch (_) {}
      await sleep(240);
      parts.push(await frame.evaluate(scrapeFn, { titles }).catch(() => ({ error: 'scrape failed' })));
      try { await frame.evaluate(scrollXtab, titles, 'start'); } catch (_) {}
      return mergeParts(parts);
    };

    let last = { error: 'not found in any accessible frame' };
    for (const frame of page.frames()) {
      const got = await scrapeWithScroll(frame, titleHints);
      if (got && !got.error && Array.isArray(got.data) && got.data.length) return got;
      if (got) last = got;
    }
    return last;
  };

  const finishTable = (row, rawTable, filters) => {
    row.tableData = toGrid(rawTable);
    if (row.tableData && !row.tableData.error) {
      row.grid = {
        columns: row.tableData.columns,
        rows: row.tableData.rows,
      };
      row[KPI_LABEL] = row.grid;
      row.extract_via = rawTable && rawTable.via ? rawTable.via : 'on-page-grid';
    } else {
      row.grid = null;
      row.extract_via = 'failed';
      row.extract_error = (row.tableData && row.tableData.error) || (rawTable && rawTable.error) || 'no table';
    }
    return row;
  };

  const navDebug = [];
  const runNav = async () => {
    for (const step of NAV_STEPS) {
      const r = await clickByText(step, { openers: NAV_OPENERS });
      navDebug.push({ step, ...r });
      await waitForLoadingToFinish();
    }
    if (TIME_GRAIN) {
      await sleep(400);
      const g = await clickByText(TIME_GRAIN, { openers: NAV_OPENERS });
      navDebug.push({ step: TIME_GRAIN, ...g });
      await waitForLoadingToFinish();
    }
  };

  await waitForDossierReady();
  await runNav();
  await waitForDashboard();

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  const scrapeOnce = async (filters) => {
    const debug = {};
    const GEO_ORDER = ['Area', 'Region', 'Territory', 'Time Bucket'];
    const allKeys = Object.keys(filters || {});
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));
    for (const key of geoKeys) debug[key] = await selectByLabel(key, filters[key]);
    for (const key of otherKeys) debug[key] = await selectByLabel(key, filters[key]);
    await closeAnyOpenDropdown();
    await dismissGenericErrorDialog();
    await waitForLoadingToFinish();
    await waitForDashboard();
    const row = { filters_applied: debug };
    // Primary: widget Menu → Show Data (clean multi-col table). Fallback: on-page scrape.
    // Try viz title ("Performance Trend Grid") before the shorter tab label.
    const titles = gridTitleHints();
    let extracted = { error: 'no extract' };
    for (const hint of titles) {
      extracted = await extractViaShowData(hint);
      if (extracted && !extracted.error) break;
    }
    row.show_data = extracted && extracted.error
      ? { ok: false, error: extracted.error, open: extracted.open || null }
      : { ok: true, via: extracted && extracted.via };
    if (extracted && extracted.error) {
      extracted = await extractOnPageGrid(titles, EXPECTED_COLUMNS);
    }
    finishTable(row, extracted, filters);
    return row;
  };

  if (filterCombinations.length === 0) {
    const row = await scrapeOnce({});
    return { navigation: navDebug, ...row };
  }

  const results = {};
  for (let i = 0; i < filterCombinations.length; i++) {
    const { label = String(i), filters = {} } = filterCombinations[i];
    if (i > 0) {
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await waitForDossierReady();
      await runNav();
      await waitForDashboard();
    }
    results[label] = await scrapeOnce(filters);
  }
  return { navigation: navDebug, results };
};
