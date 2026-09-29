export default async ({ page }) => {

  // === AUTO-INJECTED SESSION-AWARE AUTH CHECK (do not remove) ===
  const __sleep = ms => new Promise(r => setTimeout(r, ms));
  const __reportUrl = "";
  const __tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1440, height: 900 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}
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

  const tryWidenViewport = async () => {
    try { if (typeof page.setViewport === 'function') await page.setViewport({ width: 1440, height: 900 }); } catch (_) {}
    try { if (typeof page.setViewportSize === 'function') await page.setViewportSize({ width: 1440, height: 900 }); } catch (_) {}
  };
  await tryWidenViewport();

  const reportUrl = "";

  const detectLoginForm = () => page.evaluate(() => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const hasUserField = !!document.querySelector(
      'input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], #Uid'
    );
    const hasPwdField = !!document.querySelector('input[type="password"], #Pwd');
    const hasLoginBtn = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'))
      .some(el => /log ?in/.test(norm(el.innerText || el.value || '')));
    return hasUserField || hasPwdField || hasLoginBtn;
  }).catch(() => false);

  const fillAndSubmitLogin = async (username, password) => {
    const userSel = '#Uid, input[placeholder*="user name" i], input[name*="user" i], input[id*="user" i], input[type="text"]';
    const pwdSel  = '#Pwd, input[type="password"], input[placeholder*="password" i]';
    await page.type(userSel, username).catch(() => {});
    await page.type(pwdSel, password).catch(() => {});
    const clicked = await page.evaluate((pSel) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const cands = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      let btn = cands.find(el => norm(el.innerText || el.value || '') === 'log in with credentials');
      if (!btn) btn = cands.find(el => /log ?in/.test(norm(el.innerText || el.value || '')));
      if (btn) { btn.click(); return true; }
      const pwd = document.querySelector(pSel);
      const form = pwd && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return true; }
      return false;
    }, pwdSel).catch(() => false);
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      sleep(3000),
    ]);
    return clicked;
  };

  await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2000);
  let hasLoginForm = await detectLoginForm();
  if (hasLoginForm && typeof __creds !== 'undefined' && __creds?.username) {
    const onLoginPage = await page.evaluate(() => /\/auth\/ui\/loginPage/i.test(location.href)).catch(() => false);
    if (!onLoginPage && __creds.loginUrl) {
      await page.goto(__creds.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1000);
    }
    await fillAndSubmitLogin(__creds.username, __creds.password);
    await sleep(1500);
    const loginFailed = await page.evaluate(() =>
      /login\s*failure|error\s*in\s*login|invalid (user|credentials|password)|incorrect (user|password)/i.test(document.body.innerText || '')
    ).catch(() => false);
    if (loginFailed) return { ok: false, error: 'LOGIN_FAILED', message: 'Credentials rejected by the login page' };
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    hasLoginForm = await detectLoginForm();
    if (hasLoginForm) return { ok: false, error: 'LOGIN_FAILED', message: 'Still on login page after submitting credentials' };
  } else if (hasLoginForm) {
    return { ok: false, error: 'AUTH_REQUIRED', message: 'Login form present but no credentials provided' };
  }
  await tryWidenViewport();

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

  const waitForDashboard = async (maxMs = 20000) => {
    await waitForLoadingToFinish(maxMs);
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const found = await page.evaluate(() => {
        function getDirectText(el) {
          let text = '';
          for (const node of el.childNodes)
            if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
          return text.trim();
        }
        return Array.from(document.querySelectorAll('*'))
          .some(el => /HCP Customer/i.test(getDirectText(el)));
      }).catch(() => false);
      if (found) break;
      await sleep(500);
    }
    await waitForLoadingToFinish(maxMs);
  };

  // waitForDashboard only proves the dossier shell is visible. After navigation
  // or a filter change, the HCP grid can still be rebuilding. Wait until the
  // target title + grid exist and their DOM fingerprint is unchanged for three
  // consecutive polls before opening the context menu.
  const waitForTargetGridStable = async (titleText, maxMs = 60000) => {
    const start = Date.now();
    let lastFingerprint = '';
    let stablePolls = 0;
    let lastSeen = null;
    while (Date.now() - start < maxMs) {
      await dismissGenericErrorDialog();
      let found = null;
      for (const frame of page.frames()) {
        try {
          const state = await frame.evaluate((wantedTitle) => {
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const isVisible = el => {
              const r = el.getBoundingClientRect();
              if (r.width < 1 || r.height < 1) return false;
              const st = getComputedStyle(el);
              return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
            };
            const bodyText = document.body ? document.body.innerText || '' : '';
            const loading = /Loading\s*Data/i.test(bodyText)
              || Array.from(document.querySelectorAll(
                '.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, ' +
                '[class*="WaitBox" i], [class*="spinner" i], [class*="loading" i]'
              )).some(isVisible);
            let title = null;
            for (const el of Array.from(document.querySelectorAll('*'))) {
              if (!isVisible(el)) continue;
              let direct = '';
              for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) direct += n.textContent || '';
              const directNorm = norm(direct);
              const wanted = norm(wantedTitle);
              if (directNorm === wanted || directNorm.includes(wanted) || wanted.includes(directNorm)) {
                title = el;
                break;
              }
            }
            if (!title) return { ready: false, reason: 'title-not-found', loading };
            const tr = title.getBoundingClientRect();
            const selectors = [
              'table', '[role="grid"]', '[class*="grid" i]', '[class*="xtab" i]',
              '[class*="table" i]', '[class*="visualization" i]'
            ];
            let best = null, bestArea = 0;
            for (const sel of selectors) {
              for (const el of Array.from(document.querySelectorAll(sel))) {
                if (!isVisible(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 220 || r.height < 90) continue;
                if (r.top < tr.top - 30) continue;
                const area = r.width * r.height;
                if (area > bestArea) { best = el; bestArea = area; }
              }
            }
            if (!best) return { ready: false, reason: 'grid-not-found', loading };
            const rows = best.querySelectorAll('tr, [role="row"]').length;
            const cells = best.querySelectorAll(
              'td, th, [role="gridcell"], [role="columnheader"], [role="cell"]'
            ).length;
            const text = norm(best.innerText || best.textContent || '');
            const r = best.getBoundingClientRect();
            return {
              ready: !loading && r.width > 220 && r.height > 90,
              loading,
              rows,
              cells,
              textLength: text.length,
              fingerprint: [rows, cells, text.length, Math.round(r.width), Math.round(r.height)].join('|'),
            };
          }, titleText);
          if (state && (state.ready || state.reason !== 'title-not-found')) {
            found = { ...state, frame_url: frame.url() };
            if (state.ready) break;
          }
        } catch (_) {}
      }
      lastSeen = found;
      if (found && found.ready && found.fingerprint) {
        if (found.fingerprint === lastFingerprint) stablePolls++;
        else { lastFingerprint = found.fingerprint; stablePolls = 1; }
        if (stablePolls >= 3) {
          await sleep(800);
          return { ok: true, ...found, stable_polls: stablePolls };
        }
      } else {
        stablePolls = 0;
        lastFingerprint = '';
      }
      await sleep(700);
    }
    return { ok: false, error: 'View My HCP List grid did not become stable', last_seen: lastSeen };
  };

  const evalAcrossFrames = async (fn, ...args) => {
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const result = await frame.evaluate(fn, ...args);
        if (result && !result.error) return { frame, result };
      } catch (_) {}
    }
    return { frame: null, result: { error: 'not found in any accessible frame' } };
  };

  const evalInFrame = async (frame, fn, ...args) => {
    try {
      return await frame.evaluate(fn, ...args);
    } catch (_) {
      return { error: 'evaluate failed in frame' };
    }
  };

  let cachedDossierFrame = null;

  const dismissGenericErrorDialog = async () => {
    const probe = () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        if (t.includes('an error has occurred')) {
          for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
            if (!isVisible(b)) continue;
            if (norm(b.innerText || b.textContent || '') === 'ok') { b.click(); return { dismissed: true }; }
          }
          return { found: true, dismissed: false };
        }
      }
      return { found: false };
    };
    let found = false;
    try { const r = await page.evaluate(probe); if (r.found) found = true; } catch (_) {}
    if (!found) {
      const { result } = await evalAcrossFrames(probe).catch(() => ({ result: null }));
      if (result && result.found) found = true;
    }
    if (found) await sleep(500);
    return found;
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
  // @@RTB_RECORD_COUNT_FRAME_CORE@@
  // Record-count screens are iframe-heavy, so this proven variant deliberately
  // searches every accessible frame for labels, selectors, and popup options.
  const selectByLabel = async (labelText, optionText) => {
    await closeAnyOpenDropdown();
    const tryFrame = frame => frame.evaluate((label, opt) => {
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const extractCode = v => norm(v).split(/\s+/)[0].trim();
      const optCode = extractCode(opt);
      const normOpt = norm(opt);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      let labelEl = null, labelArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (norm(getDirectText(el)) !== norm(label)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < labelArea) { labelEl = el; labelArea = area; }
      }
      if (!labelEl) return { error: 'Label not found: ' + label };
      const lr = labelEl.getBoundingClientRect();

      let bestSelect = null, bestDist = Infinity;
      for (const s of Array.from(document.querySelectorAll('select'))) {
        if (!isVisible(s)) continue;
        const r = s.getBoundingClientRect();
        const dist = Math.abs(r.top - lr.top) + Math.abs(r.left - lr.left);
        if (dist < 200 && dist < bestDist) { bestSelect = s; bestDist = dist; }
      }
      if (bestSelect) {
        const options = Array.from(bestSelect.options);
        let m = options.find(o => extractCode(o.textContent) === optCode)
             || options.find(o => norm(o.textContent) === normOpt)
             || options.find(o => norm(o.textContent).startsWith(normOpt) || normOpt.startsWith(norm(o.textContent)));
        if (m) {
          bestSelect.value = m.value;
          bestSelect.dispatchEvent(new Event('input',  { bubbles: true }));
          bestSelect.dispatchEvent(new Event('change', { bubbles: true }));
          return { clicked: true, via: 'native-select', option: m.textContent.trim() };
        }
      }

      const legacy = Array.from(document.querySelectorAll('.mstrmojo-DocSelector'));
      if (legacy.length) {
        const withCode = [], withoutCode = [];
        for (const sel of legacy) {
          const r = sel.getBoundingClientRect();
          if (Math.abs(r.top - lr.top) > 40) continue;
          if (r.left < lr.left - 10) continue;
          const dist = Math.abs(r.left - lr.left);
          let hasCode = false;
          for (const c of Array.from(sel.querySelectorAll('*')))
            if (extractCode(getDirectText(c)) === optCode) { hasCode = true; break; }
          (hasCode ? withCode : withoutCode).push({ sel, dist });
        }
        withCode.sort((a, b) => a.dist - b.dist);
        withoutCode.sort((a, b) => a.dist - b.dist);
        const best = withCode[0]?.sel || withoutCode[0]?.sel;
        if (best) {
          for (const c of Array.from(best.querySelectorAll('*'))) {
            const d = getDirectText(c);
            if (!d || d.length < 2) continue;
            if (extractCode(d) === optCode) { c.click(); return { clicked: true, via: 'legacy-selector', option: d }; }
          }
        }
      }

      let valueEl = null, valueDist = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const d = getDirectText(el);
        if (!d || norm(d) === norm(label)) continue;
        const r = el.getBoundingClientRect();
        if (r.top < lr.top - 2) continue;
        if (r.top - lr.top > 60) continue;
        const dx = Math.abs(r.left - lr.left);
        if (dx > 250) continue;
        const dist = (r.top - lr.top) + dx;
        if (dist < valueDist) { valueDist = dist; valueEl = el; }
      }
      if (valueEl) { valueEl.click(); return { opened: true, via: 'click-current-value', clickedText: getDirectText(valueEl) }; }

      const nearby = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (Math.abs(r.top - lr.top) > 80 || Math.abs(r.left - lr.left) > 300) continue;
        const t = getDirectText(el);
        if (!t) continue;
        nearby.push({ tag: el.tagName, cls: (el.className || '').toString().substring(0, 60), text: t.substring(0, 40) });
        if (nearby.length >= 8) break;
      }
      return { error: 'No selector or clickable value found near: ' + label, nearby };
    }, labelText, optionText).catch(() => ({ error: 'evaluate failed for ' + labelText }));
    let result = { error: 'Label not found: ' + labelText };
    let resultFrame = null;
    const frames = cachedDossierFrame && !cachedDossierFrame.isDetached()
      ? [cachedDossierFrame, ...page.frames().filter(f => f !== cachedDossierFrame)]
      : page.frames();
    for (const frame of frames) {
      const candidate = await tryFrame(frame);
      if (candidate && !candidate.error) {
        result = candidate;
        resultFrame = frame;
        break;
      }
      // Preserve useful diagnostics from a frame that contained the label.
      if (candidate && candidate.nearby) {
        result = candidate;
        resultFrame = frame;
      }
    }

    if (result.clicked) {
      await closeAnyOpenDropdown();
      await waitForLoadingToFinish();
      await waitForDashboard();
      return { ok: true, ...result };
    }

    if (result.opened) {
      await sleep(400);
      const pickInFrame = frame => frame.evaluate((opt) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const optCode = norm(opt).split(/\s+/)[0];
        const normOpt = norm(opt);
        const isVisible = el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const st = getComputedStyle(el);
          return st.visibility !== 'hidden' && st.display !== 'none';
        };
        const cands = Array.from(document.querySelectorAll(
          'li, [role="option"], [role="menuitem"], [role="listbox"] *, ul *, div, span, td'
        ));
        let exact = null, codeMatch = null, contains = null;
        for (const el of cands) {
          if (!isVisible(el)) continue;
          const t = norm(el.innerText || el.textContent || '');
          if (!t || t.length > 60) continue;
          if (t === normOpt && !exact) exact = el;
          else if (t.split(/\s+/)[0] === optCode && !codeMatch) codeMatch = el;
          else if (t.includes(normOpt) && !contains) contains = el;
        }
        const best = exact || codeMatch || contains;
        if (best) { best.click(); return { clicked: true, text: (best.innerText || best.textContent || '').trim().substring(0, 60) }; }
        return null;
      }, optionText).catch(() => null);
      let picked = null;
      const pickFrames = resultFrame
        ? [resultFrame, ...page.frames().filter(f => f !== resultFrame)]
        : page.frames();
      for (const frame of pickFrames) {
        picked = await pickInFrame(frame);
        if (picked && picked.clicked) break;
      }
      if (picked && picked.clicked) {
        await closeAnyOpenDropdown();
        await waitForLoadingToFinish();
        await waitForDashboard();
        return { ok: true, via: 'opened-then-picked', ...picked };
      }
      return { ok: false, error: 'Opened dropdown for ' + labelText + ' but option not found: ' + optionText, clickedTo: result.clickedText };
    }

    return { ok: false, ...result };
  };

  // @@RTB_FILTER_CORE_END@@

  const clickByText = async (text, { scope, openers } = {}) => {
    const tryClickInFrame = frame => frame.evaluate((label, scopeSel) => {
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(label);
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = el.ownerDocument.defaultView.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const roots = [];
      const pushRoot = (root) => {
        if (!root) return;
        if (scopeSel) { const s = root.querySelector(scopeSel); if (s) roots.push(s); }
        else roots.push(root);
      };
      pushRoot(document);
      for (const f of Array.from(document.querySelectorAll('iframe, frame'))) {
        try { pushRoot(f.contentDocument); } catch (_) {}
      }
      const exact = [], attr = [], contains = [];
      for (const root of roots) {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (!isVisible(el)) continue;
          const direct = getDirectText(el);
          if (direct && norm(direct) === target) {
            const r = el.getBoundingClientRect();
            exact.push({ el, area: r.width * r.height });
            continue;
          }
          const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('data-tooltip'));
          if (al && norm(al) === target) {
            const r = el.getBoundingClientRect();
            attr.push({ el, area: r.width * r.height });
          }
        }
        for (const el of Array.from(root.querySelectorAll('a, button, li, div, span, td, [role="tab"], [role="menuitem"], [role="button"]'))) {
          if (!isVisible(el)) continue;
          const it = norm(el.innerText || el.textContent || '');
          if (!it || !it.includes(target)) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height > 200000) continue;
          contains.push({ el, area: r.width * r.height, len: it.length });
        }
      }
      exact.sort((a, b) => a.area - b.area);
      attr.sort((a, b) => a.area - b.area);
      contains.sort((a, b) => (a.len - b.len) || (a.area - b.area));
      const best = exact[0] || attr[0] || contains[0];
      if (best) {
        const el = best.el;
        const forId = el.getAttribute && el.getAttribute('for');
        if (forId) {
          const inp = el.ownerDocument.getElementById(forId);
          if (inp) { inp.click(); return { clicked: true, via: 'label-for', text: label }; }
        }
        const innerRadio = el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]');
        if (innerRadio) { innerRadio.click(); return { clicked: true, via: 'inner-radio', text: label }; }
        el.click();
        return { clicked: true, via: exact[0] ? 'text' : attr[0] ? 'attr' : 'contains', text: label };
      }
      for (const inp of Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
        const id = inp.id;
        if (id) {
          const lab = document.querySelector('label[for="' + id + '"]');
          if (lab && norm(lab.innerText || '') === target) { inp.click(); return { clicked: true, via: 'radio-label', text: label }; }
        }
        const parent = inp.parentElement;
        if (parent && norm(parent.innerText || '') === target) { inp.click(); return { clicked: true, via: 'radio-parent', text: label }; }
      }
      return { error: 'navigation target not found: ' + label };
    }, text, scope || null).catch(() => ({ error: 'evaluate failed: ' + text }));

    const tryClick = async () => {
      const frames = cachedDossierFrame && !cachedDossierFrame.isDetached()
        ? [cachedDossierFrame, ...page.frames().filter(f => f !== cachedDossierFrame)]
        : page.frames();
      let last = { error: 'navigation target not found: ' + text };
      for (const frame of frames) {
        const candidate = await tryClickInFrame(frame);
        if (candidate && !candidate.error) {
          cachedDossierFrame = frame;
          return { ...candidate, frame_url: frame.url() };
        }
        if (candidate) last = candidate;
      }
      return last;
    };

    let res = await tryClick();
    if (res && res.error && Array.isArray(openers) && openers.length) {
      for (const op of openers) {
        const opened = await page.evaluate((opLabel) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const target = norm(opLabel);
          for (const el of Array.from(document.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt'));
            const t = norm(el.innerText || '');
            if ((al && norm(al) === target) || (t && t === target)) { el.click(); return true; }
          }
          return false;
        }, op).catch(() => false);
        if (opened) {
          await sleep(600);
          res = await tryClick();
          if (res && !res.error) break;
        }
      }
    }
    await waitForLoadingToFinish();
    await waitForDashboard().catch(() => {});
    return res;
  };

  const findChartWidget = async (chartTitleText) => {
    const { frame, result } = await evalAcrossFrames((titleText) => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      function getDirectText(el) {
        let t = '';
        for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        return t.trim();
      }
      const target = titleText.toLowerCase();
      let titleEl = null, titleArea = Infinity;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        if (!getDirectText(el).toLowerCase().includes(target)) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < titleArea) { titleEl = el; titleArea = area; }
      }
      if (!titleEl) return { error: 'chart title not found: ' + titleText };
      const tr = titleEl.getBoundingClientRect();
      const chartSelectors = 'canvas, svg, [class*="highcharts" i], [class*="mstrmojo-graph" i], [class*="chart-container" i], table, [class*="grid" i], [class*="table" i]';
      let best = null, bestDist = Infinity, bestRect = null;
      for (const el of Array.from(document.querySelectorAll(chartSelectors))) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 50) continue;
        if (r.top < tr.bottom - 10) continue;
        const verticalDist = r.top - tr.bottom;
        const horizontalOffset = Math.abs(r.left - tr.left);
        const dist = verticalDist + horizontalOffset;
        if (dist < bestDist) { bestDist = dist; best = el; bestRect = r; }
      }
      if (!best) return { error: 'chart element not found below title' };
      return { top: bestRect.top, left: bestRect.left, width: bestRect.width, height: bestRect.height };
    }, chartTitleText);
    if (result.error) return { frame: null, rect: null, error: result.error };
    return { frame, rect: result };
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

  const openShowData = async (chartTitleText) => {
    const { frame, rect, error } = await findChartWidget(chartTitleText);
    if (!frame || !rect) return { error: error || 'chart widget not located' };
    cachedDossierFrame = frame;

    const frameOffset = await getFrameViewportOffset(frame);
    const cx = frameOffset.x + rect.left + rect.width / 2;
    const cy = frameOffset.y + rect.top + 20;
    const cornerX = frameOffset.x + rect.left + rect.width - 20;
    const cornerY = frameOffset.y + rect.top + 12;

    await page.mouse.move(cx, cy, { steps: 15 });
    await sleep(400);
    await page.mouse.move(cornerX, cornerY, { steps: 15 });
    await sleep(700);

    const clickDots = () => evalInFrame(frame, (anchorX, anchorY) => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const candidates = Array.from(document.querySelectorAll(
        '.hover-menu-btn, .hover-btn, [aria-label="Context Menu"], [aria-label*="context menu" i]'
      )).filter(isVisible);
      if (candidates.length) {
        candidates.sort((a, b) => {
          const aVis = /\bvisible\b/.test(a.getAttribute('class') || '') ? 0 : 1;
          const bVis = /\bvisible\b/.test(b.getAttribute('class') || '') ? 0 : 1;
          if (aVis !== bVis) return aVis - bVis;
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const da = Math.abs(ra.left - anchorX) + Math.abs(ra.top - anchorY);
          const db = Math.abs(rb.left - anchorX) + Math.abs(rb.top - anchorY);
          return da - db;
        });
        const best = candidates[0];
        best.click();
        return { clicked: true, via: 'known-context-menu-btn' };
      }
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (t === '...' || t === '\u22ee' || t === '\u2022\u2022\u2022' || t === '\u00b7\u00b7\u00b7') { el.click(); return { clicked: true, via: 'text-dots' }; }
        const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '');
        if (/more options|show more|kebab|ellipsis|3 dot|three dot|context\s*menu/i.test(al || '')) {
          el.click();
          return { clicked: true, via: 'aria-label' };
        }
      }
      const classKeywordRe = /more|kebab|ellipsis|overflow|menu|dots?[-_]?btn/i;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const cls = (el.getAttribute && el.getAttribute('class')) || '';
        if (cls && classKeywordRe.test(cls)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.width < 60 && r.height > 0 && r.height < 60) {
            el.click();
            return { clicked: true, via: 'class-keyword' };
          }
        }
      }
      return { error: 'dots button not found' };
    }, cornerX - frameOffset.x, cornerY - frameOffset.y);

    let dotsClicked = await clickDots();
    if (dotsClicked.error) {
      const cornerRetries = [[-5,0],[5,0],[0,-5],[0,5],[-10,-5],[10,-5],[-10,5],[10,5]];
      for (const [dx, dy] of cornerRetries) {
        await page.mouse.move(cornerX + dx, cornerY + dy, { steps: 8 });
        await sleep(350);
        dotsClicked = await clickDots();
        if (dotsClicked.clicked) break;
      }
    }

    await sleep(600);

    const showDataClicked = await evalInFrame(frame, () => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const exact = [], contains = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        if (!t) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (t === 'show data') exact.push({ el, area });
        else if (t.includes('show data') && area < 5000) contains.push({ el, area });
      }
      exact.sort((a, b) => a.area - b.area);
      contains.sort((a, b) => a.area - b.area);
      const best = exact[0] || contains[0];
      if (best) { best.el.click(); return { clicked: true }; }
      return { error: 'Show Data option not found in menu' };
    });

    return { dotsClicked, showDataClicked, frameUrl: frame.url() };
  };

  const openShowDataAfterGridReady = async (chartTitleText) => {
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await closeAnyOpenDropdown();
      await dismissGenericErrorDialog();
      const ready = await waitForTargetGridStable(chartTitleText, attempt === 1 ? 60000 : 25000);
      if (!ready.ok) {
        last = { error: ready.error, ready, attempt };
        continue;
      }
      const opened = await openShowData(chartTitleText);
      const clicked = !!(opened && opened.showDataClicked && opened.showDataClicked.clicked);
      if (clicked) return { ok: true, attempt, ready, ...opened };
      last = {
        error: opened?.error || opened?.showDataClicked?.error || opened?.dotsClicked?.error
          || 'Show Data did not open',
        attempt,
        ready,
        opened,
      };
      await closeShowDataPopup().catch(() => {});
      await dismissGenericErrorDialog();
      await sleep(1200);
    }
    return { ok: false, ...(last || { error: 'Show Data did not open' }) };
  };

  const findShowDataPopupContainer = async () => {
    const probe = () => {
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [class*="popup" i], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]'
      ));
      let best = null, bestArea = Infinity;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const hasTable = !!el.querySelector('table tr:nth-child(2)');
        const gridRows = el.querySelectorAll('[role="row"]');
        if (!hasTable && gridRows.length < 2) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < bestArea) { best = el; bestArea = area; }
      }
      if (!best) return { error: 'popup container not found' };
      const hasSpinner = !!best.querySelector('.mstrmojo-WaitBox, .mstrmojo-Wait, .mstrWaitBox, [class*="WaitBox" i], [class*="spinner" i], [class*="loading" i]');
      return { found: true, hasSpinner };
    };
    if (cachedDossierFrame && !cachedDossierFrame.isDetached()) {
      try {
        const result = await cachedDossierFrame.evaluate(probe);
        if (result && result.found) return { frame: cachedDossierFrame, result };
      } catch (_) {}
    }
    const { frame, result } = await evalAcrossFrames(probe);
    if (frame) cachedDossierFrame = frame;
    return { frame, result };
  };

  const waitForShowDataPopup = async (maxMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const { result } = await findShowDataPopupContainer();
      if (result && result.found && !result.hasSpinner) break;
      await sleep(600);
    }
    await sleep(500);
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
      const candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [class*="popup" i], [class*="modal" i], [class*="dialog" i], [class*="overlay" i]'
      ));
      let popupEl = null, bestArea = Infinity;
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const hasTable = !!el.querySelector('table tr:nth-child(2)');
        const gridRows = el.querySelectorAll('[role="row"]');
        if (!hasTable && gridRows.length < 2) continue;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < bestArea) { popupEl = el; bestArea = area; }
      }
      if (!popupEl) return { error: 'Show Data popup container not found' };

      const table = popupEl.querySelector('table');
      if (table) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length >= 2) {
          const headerCells = Array.from(rows[0].querySelectorAll('th, td'));
          const headers = headerCells.map((h, i) => norm(h.innerText || h.textContent || '') || ('col_' + i));
          const data = [];
          for (let i = 1; i < rows.length; i++) {
            const cells = Array.from(rows[i].querySelectorAll('td, th'));
            if (!cells.length) continue;
            const rowText = norm(rows[i].innerText || rows[i].textContent || '');
            if (isControlText(rowText)) continue;
            const rowData = {};
            headers.forEach((h, idx) => {
              rowData[h] = cells[idx] ? (cells[idx].innerText || cells[idx].textContent || '').trim() : null;
            });
            data.push(rowData);
          }
          return { data, headers, via: 'html-table' };
        }
      }

      let rowEls = Array.from(popupEl.querySelectorAll('[role="row"]')).filter(isVisible);
      rowEls.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      if (rowEls.length >= 2) {
        let headerRowEl = rowEls.find(r => r.querySelector('[role="columnheader"]')) || rowEls[0];
        const headerCellEls = Array.from(headerRowEl.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="cell"], td, [class*="cell" i]'));
        const headerCols = headerCellEls.map((h, i) => {
          const r = h.getBoundingClientRect();
          return { name: norm(h.innerText || h.textContent || '') || ('col_' + i), cx: r.left + r.width / 2 };
        });
        const dataRowEls = rowEls.filter(r => r !== headerRowEl);
        const data = [];
        for (const rowEl of dataRowEls) {
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
        if (data.length > 0) return { data, headers, via: 'aria-row-grid' };
      }

      const cellEls = Array.from(popupEl.querySelectorAll('[role="gridcell"], [role="cell"], td, [class*="cell" i]')).filter(isVisible);
      const infos = cellEls.map(el => {
        const r = el.getBoundingClientRect();
        return { raw: (el.innerText || el.textContent || '').trim(), cx: r.left + r.width / 2, top: r.top };
      }).filter(info => info.raw && !isControlText(norm(info.raw)));
      infos.sort((a, b) => a.top - b.top);
      const yTolerance = 6;
      const clusters = [];
      for (const info of infos) {
        let cluster = clusters.find(c => Math.abs(c.top - info.top) <= yTolerance);
        if (!cluster) { cluster = { top: info.top, cells: [] }; clusters.push(cluster); }
        cluster.cells.push(info);
      }
      if (clusters.length < 2) return { error: 'Found popup container but could not parse any grid rows inside it' };
      const colCenters = [...clusters[0].cells].sort((a, b) => a.cx - b.cx).map(c => c.cx);
      const data = [];
      for (let ci = 1; ci < clusters.length; ci++) {
        const rowData = {};
        for (const cell of clusters[ci].cells) {
          let bestIdx = 0, bestDist = Infinity;
          colCenters.forEach((cx, idx) => { const d = Math.abs(cell.cx - cx); if (d < bestDist) { bestDist = d; bestIdx = idx; } });
          rowData['col_' + bestIdx] = cell.raw;
        }
        if (Object.keys(rowData).length > 0) data.push(rowData);
      }
      return { data, headers: colCenters.map((_, i) => 'col_' + i), via: 'grid-fallback-clustered' };
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

  // Read the total shown at the top of the Show Data popup, for example
  // "Rows: 1,234". Do not count visible DOM rows because MSTR can paginate or
  // virtualize the grid.
  const extractShowDataRowCount = async () => {
    const probe = () => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const popupSel =
        '[role="dialog"], .mstrmojo-Popup, .mstrmojo-popup, .mstrmojo-RootPopup, ' +
        '[class*="Popup"], [class*="popup"], [class*="modal" i], [class*="dialog" i]';
      const popups = Array.from(document.querySelectorAll(popupSel)).filter(isVisible);
      const candidates = popups.length ? popups : [document];
      const parseCount = raw => {
        const text = norm(raw);
        const patterns = [
          /\bRows?\s*:\s*([\d,]+)\b/i,
          /\b([\d,]+)\s+Rows?\b/i,
          /\b\d+\s*[-–]\s*\d+\s+of\s+([\d,]+)\b/i,
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (!m) continue;
          const value = Number.parseInt(m[1].replace(/,/g, ''), 10);
          if (Number.isFinite(value) && value >= 0) {
            return { count: value, raw: text };
          }
        }
        return null;
      };

      // Prefer direct header text so values inside the grid do not form a
      // misleading number.
      for (const root of candidates) {
        const all = [root, ...Array.from(root.querySelectorAll('*'))];
        for (const el of all) {
          if (el !== document && !isVisible(el)) continue;
          let direct = '';
          for (const n of Array.from(el.childNodes || [])) {
            if (n.nodeType === Node.TEXT_NODE) direct += n.textContent || '';
          }
          const hit = parseCount(direct);
          if (hit) return { ...hit, via: 'show-data-header' };
        }
      }

      // Some MSTR builds expose the total as an accessibility/data attribute.
      for (const root of candidates) {
        for (const el of Array.from(root.querySelectorAll(
          '[aria-rowcount], [data-row-count], [data-total-count], [aria-label], [title]'
        ))) {
          if (!isVisible(el)) continue;
          for (const attr of ['aria-rowcount', 'data-row-count', 'data-total-count']) {
            const raw = el.getAttribute(attr);
            if (raw == null || raw === '') continue;
            const value = Number.parseInt(String(raw).replace(/,/g, ''), 10);
            if (Number.isFinite(value) && value >= 0) {
              return { count: value, raw: `${attr}=${raw}`, via: attr };
            }
          }
          const hit = parseCount(
            `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
          );
          if (hit) return { ...hit, via: 'show-data-attribute' };
        }
      }

      const samples = popups.slice(0, 3).map(el =>
        norm(el.innerText || el.textContent || '').slice(0, 240)
      );
      return {
        count: null,
        error: 'Rows count was not found at the top of the Show Data popup',
        popup_samples: samples,
      };
    };

    const frames = [];
    if (cachedDossierFrame && !cachedDossierFrame.isDetached()) frames.push(cachedDossierFrame);
    for (const frame of page.frames()) if (!frames.includes(frame)) frames.push(frame);
    const diagnostics = [];
    for (const frame of frames) {
      try {
        const result = await frame.evaluate(probe);
        if (result && Number.isFinite(result.count)) {
          return { ...result, frame_url: frame.url() };
        }
        if (result) diagnostics.push({ frame_url: frame.url(), ...result });
      } catch (_) {}
    }
    return {
      count: null,
      error: 'Rows count was not found in any accessible Show Data popup',
      diagnostics: diagnostics.slice(0, 5),
    };
  };

  const closeShowDataPopup = async () => {
    await evalAcrossFrames(() => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], [class*="close" i], [aria-label*="close" i]'))) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '');
        if (t === 'x' || t === '\u00d7' || t === 'close' || /close/i.test(al)) { el.click(); return { clicked: true }; }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      return { via: 'escape' };
    });
    await sleep(500);
    await dismissGenericErrorDialog();
  };

  // Filled by the deterministic record-count assembler.
  const NAV_STEPS = [];
  const SUB_TABS = [];
  const KPI_PREFIX = 'Row Count';
  const NAV_OPENERS = ['Menu', 'Navigation', 'More', 'Open menu', 'Main menu', '\u2630'];
  const navDebug = [];

  // Initial dashboard load
  await waitForDashboard();

  // Navigate to the parent screen. Each sub-tab is opened before its filters are
  // applied because HCP Customer renders the prompt bar inside the selected tab.
  for (const step of NAV_STEPS) {
    const r = await clickByText(step, { openers: NAV_OPENERS });
    navDebug.push({ step, ...r });
    if (r && r.error) break;
  }

  const filterCombinations = (typeof __filterCombinations !== 'undefined' && Array.isArray(__filterCombinations) && __filterCombinations.length > 0)
    ? __filterCombinations : [];

  const scrapeOnce = async (filters) => {
    const GEO_ORDER = ['Area', 'Region', 'Territory'];
    const allKeys = Object.keys(filters || {});
    const geoKeys = GEO_ORDER.filter(k => allKeys.includes(k));
    const otherKeys = allKeys.filter(k => !GEO_ORDER.includes(k));

    const row = { filters_applied: {} };
    for (const tab of SUB_TABS) {
      const kpiKey = KPI_PREFIX + ' - ' + tab;
      const tabClick = await clickByText(tab, { openers: NAV_OPENERS });
      row[kpiKey + '_navigation'] = tabClick;
      if (tabClick && tabClick.error) {
        row[kpiKey] = null;
        row[kpiKey + '_debug'] = { error: 'Sub-tab did not open', navigation: tabClick };
        continue;
      }

      await waitForDashboard();
      const tabFilters = {};
      for (const key of geoKeys) {
        tabFilters[key] = await selectByLabel(key, filters[key]);
        await dismissGenericErrorDialog();
      }
      for (const key of otherKeys) {
        tabFilters[key] = await selectByLabel(key, filters[key]);
        await dismissGenericErrorDialog();
      }
      await closeAnyOpenDropdown();
      // The validator expects the applied filter map at the top level. Each tab
      // also carries its own diagnostic copy for multi-tab cases.
      if (!Object.keys(row.filters_applied).length) row.filters_applied = tabFilters;
      row[kpiKey + '_filters'] = tabFilters;

      const gridReady = await waitForTargetGridStable(tab, 60000);
      row[kpiKey + '_grid_ready'] = gridReady;
      const openResult = gridReady.ok
        ? await openShowDataAfterGridReady(tab)
        : { ok: false, error: gridReady.error, ready: gridReady };
      row[kpiKey + '_show_data'] = openResult;
      if (!openResult.ok) {
        row[kpiKey] = null;
        row[kpiKey + '_debug'] = { error: openResult.error, open_result: openResult };
        continue;
      }
      await waitForShowDataPopup();
      await waitForLoadingToFinish(10000);
      await sleep(800);
      const countResult = await extractShowDataRowCount();
      row[kpiKey] = countResult.count;
      row[kpiKey + '_debug'] = countResult;
      await closeShowDataPopup();
      await sleep(500);
    }
    row.ok = SUB_TABS.every(tab => Number.isFinite(row[KPI_PREFIX + ' - ' + tab]));
    if (!row.ok) row.error = 'One or more Show Data row counts were not found';
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
      await waitForDashboard();
      await dismissGenericErrorDialog();
      for (const step of NAV_STEPS) await clickByText(step, { openers: NAV_OPENERS });
      await waitForDashboard();
    }
    const row = await scrapeOnce(filters);
    results[label] = row;
  }
  return { navigation: navDebug, results };
};