// ChromeVim content script: page navigation, link hints, and vim modes for text fields.
(() => {
  'use strict';
  if (window.__chromeVimLoaded) return;
  window.__chromeVimLoaded = true;

  const T = globalThis.ChromeVimText;
  const ext = globalThis.browser || globalThis.chrome;

  const HINT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const SCROLL_STEP = 70;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'email', 'number']);
  const STRONG_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
  const CLICKABLE_SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary', 'label[for]',
    '[contenteditable]:not([contenteditable=false])', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    'video[controls]', 'audio[controls]',
    ...['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'option', 'switch', 'textbox', 'combobox', 'searchbox', 'treeitem', 'slider', 'spinbutton']
      .map((r) => `[role=${r}]`),
  ].join(',');

  const state = {
    mode: 'page',        // page | hints | passthrough
    editEl: null,        // focused editable element, if any
    editMode: null,      // insert | normal | visual | vline
    buf: [],             // pending normal-mode key tokens
    pageBuf: '',
    pageTimer: 0,
    hints: null,
    register: { text: '', linewise: false },
    desiredCol: null,
    lastFind: null,
    vAnchor: 0,
    vHead: 0,
    swallowKeyUp: new Set(),
  };

  // ---------------------------------------------------------------- DOM utils

  const composedParent = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;

  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') return TEXT_INPUT_TYPES.has(el.type) && !el.disabled && !el.readOnly;
    return !!el.isContentEditable;
  }

  function hasSelectionApi(el) {
    if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return false;
    try { return typeof el.selectionStart === 'number'; } catch { return false; }
  }

  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    state.swallowKeyUp.add(e.code);
  }

  const isEscape = (e) => e.key === 'Escape' || (e.ctrlKey && e.key === '[');

  function send(msg) {
    try { return Promise.resolve(ext.runtime.sendMessage(msg)).catch(() => {}); } catch { return Promise.resolve(); }
  }

  function copyText(text) {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch { /* clipboard unavailable */ }
  }

  // ---------------------------------------------------------------- UI (shadow DOM overlay)

  const CSS = `
    .hint {
      position: fixed; z-index: 2147483647; pointer-events: none;
      font: bold 12px/1 "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace; letter-spacing: 0.5px;
      color: #1d1d1f; background: linear-gradient(#fff785, #ffc542);
      border: 1px solid #c38a22; border-radius: 3px; padding: 2px 3px;
      box-shadow: 0 2px 5px rgba(0,0,0,.35); white-space: nowrap; text-transform: none;
    }
    .tablist {
      position: fixed; inset: 0; margin: auto; width: min(560px, 90vw); height: fit-content; max-height: 80vh;
      overflow: auto; z-index: 2147483647; pointer-events: none; padding: 10px 12px; border-radius: 10px;
      background: rgba(28,28,30,.95); box-shadow: 0 10px 40px rgba(0,0,0,.5);
    }
    .tablist .tabrow { display: flex; align-items: center; gap: 10px; padding: 3px 0; color: #f2f2f7;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .tablist .tabrow.active { color: #ffd60a; }
    .tablist .tabrow.hidden { display: none; }
    .tablist .hint { position: static; flex: none; }
    .tablist .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint .typed { color: #b27500; opacity: .55; }
    .hint.hidden { display: none; }
    #mode, #toast {
      position: fixed; right: 12px; bottom: 12px; pointer-events: none; z-index: 2147483647;
      font: 600 12px/1.2 "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace; color: #fff; background: rgba(28,28,30,.92);
      border-radius: 6px; padding: 5px 9px; box-shadow: 0 2px 8px rgba(0,0,0,.3); display: none;
    }
    #mode.insert { background: rgba(36,138,61,.95); }
    #mode.normal { background: rgba(0,96,223,.95); }
    #mode.visual { background: rgba(175,82,222,.95); }
    #mode.passthrough { background: rgba(255,149,0,.95); }
    #toast { bottom: 44px; }
    #help {
      position: fixed; inset: 0; margin: auto; width: min(760px, 92vw); max-height: 86vh; overflow: auto;
      pointer-events: auto; display: none; z-index: 2147483647;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f2f2f7;
      background: rgba(28,28,30,.97); border-radius: 12px; padding: 18px 22px; box-shadow: 0 10px 40px rgba(0,0,0,.5);
      height: fit-content;
    }
    #help h2 { margin: 0 0 8px; font-size: 16px; }
    #help h3 { margin: 12px 0 4px; font-size: 13px; color: #8e8e93; text-transform: uppercase; letter-spacing: .5px; }
    #help .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
    #help .row { display: flex; gap: 10px; }
    #help kbd { font: 600 12px "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace; color: #ffd60a; min-width: 70px; display: inline-block; }
  `;

  let ui = null;

  function getUI() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.setAttribute('data-chrome-vim', '');
    host.style.cssText = [
      'all:initial', 'position:fixed', 'top:0', 'left:0', 'width:0', 'height:0', 'margin:0', 'padding:0',
      'border:0', 'overflow:visible', 'background:transparent', 'z-index:2147483647', 'pointer-events:none',
      'display:block', 'inset:0 auto auto 0',
    ].map((d) => d + ' !important').join(';');
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
    const mk = (id) => { const d = document.createElement('div'); d.id = id; root.appendChild(d); return d; };
    ui = { host, root, hints: mk('hints'), mode: mk('mode'), toast: mk('toast'), help: mk('help') };
    (document.body || document.documentElement).appendChild(host);
    return ui;
  }

  // Put the overlay in the top layer so it sits above modal dialogs / fullscreen content.
  function raiseUI() {
    const u = getUI();
    if (!u.host.isConnected) (document.body || document.documentElement).appendChild(u.host);
    if (typeof u.host.showPopover === 'function') {
      try {
        if (!u.host.hasAttribute('popover')) u.host.setAttribute('popover', 'manual');
        if (u.host.matches(':popover-open')) u.host.hidePopover();
        u.host.showPopover();
      } catch { /* popover unsupported or blocked */ }
    }
    return u;
  }

  let toastTimer = 0;
  function toast(msg) {
    const u = raiseUI();
    u.toast.textContent = msg;
    u.toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { u.toast.style.display = 'none'; }, 1500);
  }

  function updateIndicator() {
    const pending = state.buf.join('');
    let text = '', cls = '';
    if (state.mode === 'hints') { text = '-- HINTS --'; }
    else if (state.mode === 'passthrough') { text = '-- PASS THROUGH --  (Esc to exit)'; cls = 'passthrough'; }
    else if (state.editEl) {
      const labels = { insert: '-- INSERT --', normal: '-- NORMAL --', visual: '-- VISUAL --', vline: '-- VISUAL LINE --' };
      text = labels[state.editMode] || '';
      cls = state.editMode === 'vline' ? 'visual' : state.editMode;
    }
    if (!text && !ui) return;
    const u = text ? raiseUI() : getUI();
    u.mode.className = cls;
    u.mode.textContent = text + (pending ? '  ' + pending : '');
    u.mode.style.display = text ? 'block' : 'none';
  }

  const HELP = [
    ['Page', [
      ['f', 'Label clickable items; type label to click/focus'], ['F', 'Label links; open in new tab'],
      ['j / k', 'Scroll down / up'], ['h / l', 'Scroll left / right'], ['d / u', 'Half page down / up'],
      ['gg / G', 'Top / bottom'], ['^ / $', 'Far left / right'], ['H / L', 'History back / forward'], ['r', 'Reload'],
      ['gi', 'Focus first text input'], ['yy', 'Copy page URL'], ['J / K', 'Previous / next tab'],
      ['t', 'Pick tab by label'], ['x', 'Close tab'], ['i', 'Pass-through mode (Esc exits)'], ['?', 'Toggle this help'],
    ]],
    ['Text fields', [
      ['Esc', 'Insert → Normal → leave field'], ['i a I A o O', 'Enter insert mode'],
      ['h j k l w b e', 'Motions (counts ok: 3w)'], ['0 ^ $ gg G', 'Line / buffer motions'],
      ['f t F T ; ,', 'Find char in line'], ['d c y + motion', 'Operators (dw, ciw, yi")'],
      ['dd cc yy D C Y', 'Line operations'], ['x X s S r ~ J', 'Edit chars / join'],
      ['p P', 'Paste'], ['u  Ctrl-r', 'Undo / redo'], ['v V', 'Visual / visual line'],
    ]],
  ];

  function toggleHelp(force) {
    const u = raiseUI();
    const show = force !== undefined ? force : u.help.style.display !== 'block';
    if (show && !u.help.firstChild) {
      const h2 = document.createElement('h2');
      h2.textContent = 'ChromeVim';
      u.help.appendChild(h2);
      const cols = document.createElement('div');
      cols.className = 'cols';
      for (const [title, rows] of HELP) {
        const col = document.createElement('div');
        const h3 = document.createElement('h3');
        h3.textContent = title;
        col.appendChild(h3);
        for (const [k, d] of rows) {
          const row = document.createElement('div');
          row.className = 'row';
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          const span = document.createElement('span');
          span.textContent = d;
          row.append(kbd, span);
          col.appendChild(row);
        }
        cols.appendChild(col);
      }
      u.help.appendChild(cols);
    }
    u.help.style.display = show ? 'block' : 'none';
    state.helpOpen = show;
  }

  // ---------------------------------------------------------------- Link hints

  function makeLabels(n, chars = HINT_CHARS) {
    const base = chars.length;
    const first = chars.replace(/[^a-z]/g, '') || chars;
    let len = 1, cap = first.length;
    while (cap < n) { len++; cap *= base; }
    const out = [];
    for (let i = 0; i < n; i++) {
      let s = '', x = i;
      for (let j = 1; j < len; j++) { s = chars[x % base] + s; x = Math.floor(x / base); }
      out.push(first[x] + s);
    }
    return out;
  }

  function hitTest(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function visibleRect(el) {
    const vw = innerWidth, vh = innerHeight;
    const ok = (r) => r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    for (const r of el.getClientRects()) if (ok(r)) return r;
    for (const c of el.children) {
      const r = c.getBoundingClientRect();
      if (ok(r)) return r;
    }
    return null;
  }

  function isReachable(el, r) {
    const vw = innerWidth, vh = innerHeight;
    const clampX = (x) => Math.max(0, Math.min(vw - 1, x));
    const clampY = (y) => Math.max(0, Math.min(vh - 1, y));
    const ix = Math.min(3, r.width / 2), iy = Math.min(3, r.height / 2);
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + ix, r.top + iy],
      [r.right - ix, r.bottom - iy],
    ];
    for (const [x, y] of points) {
      const hit = hitTest(clampX(x), clampY(y));
      if (!hit) continue;
      if (composedContains(el, hit) || composedContains(hit, el)) return true;
      const label = hit.closest && hit.closest('label');
      if (label && label.control === el) return true;
    }
    return false;
  }

  function collectClickables() {
    const vw = innerWidth, vh = innerHeight;
    const found = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (ui && el === ui.host) continue;
        let matched = false;
        try { matched = el.matches(CLICKABLE_SELECTOR); } catch { /* ignore */ }
        if (matched && el.disabled) continue;
        const br = el.getBoundingClientRect();
        if (br.bottom <= 0 || br.right <= 0 || br.top >= vh || br.left >= vw) continue;
        let viaCursor = false;
        if (!matched) {
          if (br.width < 4 || br.height < 4) continue;
          if (getComputedStyle(el).cursor !== 'pointer') continue;
          const parent = composedParent(el);
          if (parent && getComputedStyle(parent).cursor === 'pointer') continue;
          viaCursor = true;
        }
        found.push({ el, viaCursor });
      }
    };
    visit(document);

    const items = [];
    for (const it of found) {
      const r = visibleRect(it.el);
      if (!r) continue;
      const cs = getComputedStyle(it.el);
      if (cs.visibility !== 'visible') continue;
      if (!isReachable(it.el, r)) continue;
      it.rect = r;
      items.push(it);
    }

    // Drop nested duplicates (e.g. <div tabindex><a href> with the same box).
    const byEl = new Map(items.map((it) => [it.el, it]));
    const same = (a, b) => Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4 &&
      Math.abs(a.right - b.right) < 4 && Math.abs(a.bottom - b.bottom) < 4;
    const dropped = new Set();
    for (const it of items) {
      let n = composedParent(it.el);
      for (let depth = 0; n && depth < 12; depth++, n = composedParent(n)) {
        const anc = byEl.get(n);
        if (!anc || dropped.has(anc)) continue;
        if (it.viaCursor) { dropped.add(it); break; }
        if (same(it.rect, anc.rect)) {
          if (STRONG_TAGS.has(it.el.tagName) && !STRONG_TAGS.has(anc.el.tagName)) dropped.add(anc);
          else dropped.add(it);
          break;
        }
      }
    }
    // Reading order: group items into visual rows (vertical overlap), then left-to-right.
    const kept = items.filter((it) => !dropped.has(it)).sort((a, b) => a.rect.top - b.rect.top);
    const rows = [];
    for (const it of kept) {
      const mid = (it.rect.top + it.rect.bottom) / 2;
      const row = rows[rows.length - 1];
      if (row && mid < row.bottom && it.rect.top < row.bottom) row.items.push(it);
      else rows.push({ bottom: it.rect.bottom, items: [it] });
    }
    return rows.flatMap((row) => row.items.sort((a, b) => a.rect.left - b.rect.left));
  }

  function renderHintLabel(node, label, typedLen) {
    node.textContent = '';
    if (typedLen) {
      const t = document.createElement('span');
      t.className = 'typed';
      t.textContent = label.slice(0, typedLen);
      node.appendChild(t);
    }
    node.appendChild(document.createTextNode(label.slice(typedLen)));
  }

  function showHints(newTab) {
    const items = collectClickables();
    if (!items.length) { toast('No clickable elements'); return; }
    const labels = makeLabels(items.length);
    const u = raiseUI();
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      const node = document.createElement('div');
      node.className = 'hint';
      node.style.left = Math.max(0, Math.min(it.rect.left - 2, innerWidth - 24)) + 'px';
      node.style.top = Math.max(0, Math.min(it.rect.top - 2, innerHeight - 18)) + 'px';
      it.label = labels[i];
      it.node = node;
      renderHintLabel(node, it.label, 0);
      frag.appendChild(node);
    });
    u.hints.replaceChildren(frag);
    state.hints = { items, typed: '', newTab };
    state.mode = 'hints';
    updateIndicator();
  }

  async function showTabHints() {
    const tabs = await send({ type: 'listTabs' });
    if (!Array.isArray(tabs) || !tabs.length) { toast('No tabs'); return; }
    const labels = makeLabels(tabs.length, HINT_CHARS.slice(26));
    const u = raiseUI();
    const list = document.createElement('div');
    list.className = 'tablist';
    const items = tabs.map((t, i) => {
      const row = document.createElement('div');
      row.className = 'tabrow' + (t.active ? ' active' : '');
      const node = document.createElement('div');
      node.className = 'hint';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = t.title;
      row.append(node, title);
      list.appendChild(row);
      renderHintLabel(node, labels[i], 0);
      return { tabId: t.id, label: labels[i], node, row };
    });
    u.hints.replaceChildren(list);
    state.hints = { items, typed: '', newTab: false };
    state.mode = 'hints';
    updateIndicator();
  }

  function exitHints() {
    if (ui) ui.hints.replaceChildren();
    state.hints = null;
    if (state.mode === 'hints') state.mode = 'page';
    updateIndicator();
  }

  function onHintKey(e) {
    consume(e);
    const h = state.hints;
    if (isEscape(e)) return exitHints();
    if (e.key === 'Backspace') {
      h.typed = h.typed.slice(0, -1);
    } else {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      const typed = h.typed + e.key;
      const matching = h.items.filter((it) => it.label.startsWith(typed));
      if (!matching.length) return;
      if (matching.length === 1 && matching[0].label === typed) {
        const { el, tabId } = matching[0];
        const newTab = h.newTab;
        exitHints();
        if (tabId !== undefined) { send({ type: 'activateTab', id: tabId }); return; }
        activate(el, newTab);
        return;
      }
      h.typed = typed;
    }
    for (const it of h.items) {
      const match = it.label.startsWith(h.typed);
      (it.row || it.node).classList.toggle('hidden', !match);
      if (match) renderHintLabel(it.node, it.label, h.typed.length);
    }
  }

  function simulateClick(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    };
    const pointer = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', pointer));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', pointer));
    const down = el.dispatchEvent(new MouseEvent('mousedown', { ...opts, buttons: 1, detail: 1 }));
    if (down && typeof el.focus === 'function') el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, detail: 1 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 1 }));
  }

  function focusEditable(el, atEnd = true) {
    el.focus();
    if (hasSelectionApi(el)) {
      if (atEnd) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch { /* ignore */ } }
    } else if (el.isContentEditable && atEnd) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    enterInsert(el);
  }

  function activate(el, newTab) {
    lastTarget = el;
    if (isEditable(el)) return focusEditable(el);
    if (el.tagName === 'SELECT') {
      el.focus();
      try { el.showPicker(); } catch { simulateClick(el); }
      return;
    }
    const link = el.closest && el.closest('a[href]');
    if (newTab && link && link.href && !/^javascript:/i.test(link.href)) {
      send({ type: 'openTab', url: link.href });
      return;
    }
    simulateClick(el);
  }

  // ---------------------------------------------------------------- Scrolling

  let lastTarget = null;
  let scrollerCache = { el: null, axis: null, time: 0 };

  function docScrollable(axis) {
    const se = document.scrollingElement || document.documentElement;
    const max = axis === 'y' ? se.scrollHeight - innerHeight : se.scrollWidth - innerWidth;
    if (max <= 1) return false;
    const prop = axis === 'y' ? 'overflowY' : 'overflowX';
    const h = getComputedStyle(document.documentElement)[prop];
    if (h === 'hidden' || h === 'clip') return false;
    if (document.body && h === 'visible') {
      const b = getComputedStyle(document.body)[prop];
      if (b === 'hidden' || b === 'clip') return false;
    }
    return true;
  }

  function canScroll(el, axis) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(axis === 'y' ? cs.overflowY : cs.overflowX)) return false;
    return axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
  }

  function findScroller(axis) {
    for (let n = lastTarget && lastTarget.isConnected ? lastTarget : null; n; n = composedParent(n)) {
      if (n === document.body || n === document.documentElement) break;
      if (canScroll(n, axis)) return n;
    }
    const se = document.scrollingElement || document.documentElement;
    if (docScrollable(axis)) return se;
    const now = Date.now();
    if (scrollerCache.axis === axis && now - scrollerCache.time < 2000 && scrollerCache.el && scrollerCache.el.isConnected) {
      return scrollerCache.el;
    }
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('*')) {
      const area = el.clientWidth * el.clientHeight;
      if (area <= bestArea || !canScroll(el, axis)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      best = el;
      bestArea = area;
    }
    scrollerCache = { el: best, axis, time: now };
    return best || se;
  }

  function scrollByAmount(dx, dy, smooth) {
    const el = findScroller(dy ? 'y' : 'x');
    el.scrollBy({ left: dx, top: dy, behavior: smooth ? 'smooth' : 'instant' });
  }

  function scrollToEdge(bottom) {
    const el = findScroller('y');
    el.scrollTo({ top: bottom ? el.scrollHeight : 0, behavior: 'smooth' });
  }

  function scrollToHorizontalEdge(right) {
    const el = findScroller('x');
    el.scrollTo({ left: right ? el.scrollWidth : 0, behavior: 'smooth' });
  }

  function viewportHeightOf(el) {
    return el === document.scrollingElement || el === document.documentElement ? innerHeight : el.clientHeight;
  }

  // ---------------------------------------------------------------- Page mode

  function focusFirstInput() {
    const candidates = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('input, textarea, [contenteditable]')) {
        if (isEditable(el) && visibleRect(el)) candidates.push(el);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    if (!candidates.length) return toast('No text inputs');
    focusEditable(candidates[0]);
  }

  const PAGE_COMMANDS = {
    j: () => scrollByAmount(0, SCROLL_STEP),
    k: () => scrollByAmount(0, -SCROLL_STEP),
    h: () => scrollByAmount(-SCROLL_STEP, 0),
    l: () => scrollByAmount(SCROLL_STEP, 0),
    d: () => { const el = findScroller('y'); el.scrollBy({ top: viewportHeightOf(el) / 2, behavior: 'smooth' }); },
    u: () => { const el = findScroller('y'); el.scrollBy({ top: -viewportHeightOf(el) / 2, behavior: 'smooth' }); },
    gg: () => scrollToEdge(false),
    G: () => scrollToEdge(true),
    '^': () => scrollToHorizontalEdge(false),
    '0': () => scrollToHorizontalEdge(false),
    '$': () => scrollToHorizontalEdge(true),
    H: () => history.back(),
    L: () => history.forward(),
    r: () => location.reload(),
    f: () => showHints(false),
    F: () => showHints(true),
    t: () => showTabHints(),
    gi: () => focusFirstInput(),
    yy: () => { copyText(location.href); toast('Copied URL'); },
    x: () => send({ type: 'closeTab' }),
    J: () => send({ type: 'switchTab', delta: -1 }),
    K: () => send({ type: 'switchTab', delta: 1 }),
    i: () => { state.mode = 'passthrough'; updateIndicator(); },
    '?': () => toggleHelp(),
  };
  const PAGE_PREFIXES = new Set(Object.keys(PAGE_COMMANDS).flatMap((k) =>
    Array.from({ length: k.length - 1 }, (_, i) => k.slice(0, i + 1))));

  function onPageKey(e) {
    if (state.helpOpen && (isEscape(e) || e.key === '?')) { consume(e); toggleHelp(false); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) { state.pageBuf = ''; return; }
    let seq = state.pageBuf + e.key;
    if (!PAGE_COMMANDS[seq] && !PAGE_PREFIXES.has(seq)) seq = e.key;
    clearTimeout(state.pageTimer);
    if (PAGE_PREFIXES.has(seq)) {
      consume(e);
      state.pageBuf = seq;
      state.pageTimer = setTimeout(() => { state.pageBuf = ''; }, 1200);
      return;
    }
    state.pageBuf = '';
    const cmd = PAGE_COMMANDS[seq];
    if (!cmd) return;
    consume(e);
    cmd();
  }

  // ---------------------------------------------------------------- Edit modes

  function enterInsert(el) {
    if (state.ceTyping === null) state.ceTyping = true;
    if (!state.pendingSnap || state.pendingSnap.el !== el) {
      commitInsertSession();
      if (hasSelectionApi(el)) state.pendingSnap = { el, ...snapshot(el) };
    }
    state.editEl = el;
    state.editMode = 'insert';
    state.buf = [];
    state.mode = 'page';
    updateIndicator();
  }

  // Vim-style undo history per text field: each normal command or insert session is one step.
  // (Native undo groups each execCommand separately, so we keep our own snapshots.)
  const histories = new WeakMap();
  const historyOf = (el) => {
    if (!histories.has(el)) histories.set(el, { undo: [], redo: [] });
    return histories.get(el);
  };
  const snapshot = (el) => ({ value: el.value, pos: el.selectionStart });

  function pushUndo(el, snap) {
    const h = historyOf(el);
    h.undo.push(snap);
    if (h.undo.length > 200) h.undo.shift();
    h.redo = [];
  }

  function commitInsertSession() {
    const snap = state.pendingSnap;
    state.pendingSnap = null;
    if (snap && snap.el.value !== snap.value) pushUndo(snap.el, { value: snap.value, pos: snap.pos });
  }

  function undoRedo(el, which, n) {
    const h = historyOf(el);
    const from = which === 'undo' ? h.undo : h.redo;
    const to = which === 'undo' ? h.redo : h.undo;
    let target = null;
    for (let i = 0; i < n && from.length; i++) {
      to.push(snapshot(el));
      target = from.pop();
      replaceRange(el, 0, el.value.length, target.value);
    }
    if (!target) return setCursor(el, curPos(el));
    setCursor(el, target.pos);
  }

  function leaveEdit(blur) {
    commitInsertSession();
    const el = state.editEl;
    state.editEl = null;
    state.editMode = null;
    state.buf = [];
    if (blur && el) {
      if (hasSelectionApi(el)) {
        const p = el.selectionStart;
        try { el.setSelectionRange(p, p); } catch { /* ignore */ }
      }
      el.blur();
    }
    updateIndicator();
  }

  function curPos(el) { return el.selectionStart; }

  // Normal-mode cursor is rendered as a one-character selection (block cursor).
  function setCursor(el, p) {
    const s = el.value;
    p = T.clampNormal(s, p);
    const end = p < s.length && s[p] !== '\n' ? p + 1 : p;
    try { el.setSelectionRange(p, end); } catch { /* ignore */ }
    state.editMode = 'normal';
  }

  function enterNormal(el, fromInsert) {
    commitInsertSession();
    state.editEl = el;
    state.buf = [];
    state.desiredCol = null;
    if (hasSelectionApi(el)) {
      let p = el.selectionStart;
      if (fromInsert && p > T.lineStart(el.value, p)) p--;
      setCursor(el, p);
    } else {
      state.editMode = 'normal';
      const sel = getSelection();
      if (sel.rangeCount) sel.collapseToStart();
    }
    updateIndicator();
  }

  function insertAt(el, p) {
    try { el.setSelectionRange(p, p); } catch { /* ignore */ }
    enterInsert(el);
  }

  function replaceRange(el, a, b, text) {
    el.focus();
    el.setSelectionRange(a, b);
    let ok = false;
    try {
      if (text) ok = document.execCommand('insertText', false, text);
      else ok = a === b || document.execCommand('delete', false);
    } catch { ok = false; }
    if (!ok) {
      el.setRangeText(text, a, b, 'end');
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: text ? 'insertText' : 'deleteContentBackward', data: text || null,
      }));
    }
  }

  function setRegister(text, linewise) {
    state.register = { text, linewise };
    copyText(linewise ? text + '\n' : text);
  }

  function applyOp(el, op, range, origin) {
    const s = el.value;
    let a = range.from, b = range.to, text;
    const linewise = range.linewise;
    if (linewise) {
      a = T.lineStart(s, Math.min(range.from, range.to));
      b = T.lineEnd(s, Math.max(range.from, range.to));
      text = s.slice(a, b);
    } else {
      text = s.slice(a, b);
    }
    setRegister(text, linewise && el.tagName === 'TEXTAREA');
    if (op === 'y') {
      setCursor(el, linewise ? origin : a);
      return;
    }
    if (op === 'c') {
      replaceRange(el, a, b, '');
      insertAt(el, a);
      return;
    }
    // op === 'd'
    if (linewise) {
      if (b < s.length) b += 1;
      else if (a > 0) a -= 1;
    }
    replaceRange(el, a, b, '');
    const ns = el.value;
    setCursor(el, linewise ? T.firstNonBlank(ns, Math.min(a, ns.length)) : a);
  }

  function paste(el, p, before, count) {
    const { text, linewise } = state.register;
    if (!text) return;
    const s = el.value;
    const reps = Math.max(1, count || 1);
    if (linewise && el.tagName === 'TEXTAREA') {
      const block = Array(reps).fill(text).join('\n');
      if (before) {
        const ls = T.lineStart(s, p);
        replaceRange(el, ls, ls, block + '\n');
        setCursor(el, T.firstNonBlank(el.value, ls));
      } else {
        const le = T.lineEnd(s, p);
        replaceRange(el, le, le, '\n' + block);
        setCursor(el, T.firstNonBlank(el.value, le + 1));
      }
      return;
    }
    const chunk = text.repeat(reps);
    const at = before || p >= T.lineEnd(s, p) ? p : p + 1;
    replaceRange(el, at, at, chunk);
    setCursor(el, at + chunk.length - 1);
  }

  function toggleCase(str) {
    return Array.from(str, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
  }

  function visualRange(el) {
    const s = el.value;
    const lo = Math.min(state.vAnchor, state.vHead), hi = Math.max(state.vAnchor, state.vHead);
    if (state.editMode === 'vline') return { from: lo, to: hi, linewise: true };
    return { from: lo, to: Math.min(s.length, hi + 1), linewise: false };
  }

  function renderVisual(el) {
    const s = el.value;
    const r = visualRange(el);
    const a = r.linewise ? T.lineStart(s, r.from) : r.from;
    const b = r.linewise ? T.lineEnd(s, r.to) : r.to;
    try { el.setSelectionRange(a, b, state.vHead < state.vAnchor ? 'backward' : 'forward'); } catch { /* ignore */ }
  }

  function resolveFind(cmd) {
    if (cmd.motion === ';' || cmd.motion === ',') {
      if (!state.lastFind) return null;
      let kind = state.lastFind.kind;
      if (cmd.motion === ',') kind = { f: 'F', F: 'f', t: 'T', T: 't' }[kind];
      return { ...cmd, motion: kind, char: state.lastFind.char, repeat: true };
    }
    if ('fFtT'.includes(cmd.motion)) state.lastFind = { kind: cmd.motion, char: cmd.char };
    return cmd;
  }

  function execMotion(el, cmd, p, visual) {
    const s = el.value;
    cmd = resolveFind(cmd);
    if (!cmd) return;
    let m = cmd.motion;
    if (cmd.op === 'c' && (m === 'w' || m === 'W') && s[p] && !T.isSpace(s[p])) m = m === 'w' ? 'e' : 'E';
    const vertical = ['j', 'k', 'ArrowUp', 'ArrowDown', 'Enter'].includes(m);
    if (vertical) {
      if (state.desiredCol === null) state.desiredCol = p - T.lineStart(s, p);
    } else {
      state.desiredCol = (m === '$' || m === 'End') ? Infinity : null;
    }
    const res = T.motion(s, p, m, cmd.count, cmd.char, !!cmd.op, vertical ? state.desiredCol : null, cmd.repeat);
    if (!res) return;
    if (cmd.op) {
      let { pos } = res;
      const le = T.lineEnd(s, p);
      if ((m === 'w' || m === 'W') && pos > le && le > p) pos = le;
      if (res.type === 'linewise') return applyOp(el, cmd.op, { from: Math.min(p, pos), to: Math.max(p, pos), linewise: true }, p);
      const a = Math.min(p, pos);
      let b = Math.max(p, pos);
      if (res.type === 'inclusive') b = Math.min(s.length, b + 1);
      return applyOp(el, cmd.op, { from: a, to: b, linewise: false }, p);
    }
    if (visual) {
      state.vHead = res.pos;
      renderVisual(el);
    } else {
      setCursor(el, res.pos);
    }
  }

  function normalCommand(el, cmd) {
    const s = el.value;
    const p = curPos(el);
    const n = cmd.count || 1;
    const ls = T.lineStart(s, p), le = T.lineEnd(s, p);
    const multiline = el.tagName === 'TEXTAREA';
    state.desiredCol = null;
    switch (cmd.cmd) {
      case 'i': return insertAt(el, p);
      case 'a': return insertAt(el, Math.min(le, p + 1));
      case 'I': return insertAt(el, T.firstNonBlank(s, p));
      case 'A': return insertAt(el, le);
      case 'o':
        if (!multiline) return insertAt(el, le);
        replaceRange(el, le, le, '\n');
        return insertAt(el, le + 1);
      case 'O':
        if (!multiline) return insertAt(el, ls);
        replaceRange(el, ls, ls, '\n');
        return insertAt(el, ls);
      case 'x': case 'Delete': {
        if (p >= le) return;
        const b = Math.min(le, p + n);
        setRegister(s.slice(p, b), false);
        replaceRange(el, p, b, '');
        return setCursor(el, p);
      }
      case 'X': {
        const a = Math.max(ls, p - n);
        if (a === p) return;
        setRegister(s.slice(a, p), false);
        replaceRange(el, a, p, '');
        return setCursor(el, a);
      }
      case 's': {
        const b = Math.min(le, p + n);
        setRegister(s.slice(p, b), false);
        replaceRange(el, p, b, '');
        return insertAt(el, p);
      }
      case 'S': return applyOp(el, 'c', { from: p, to: motionLines(s, p, n), linewise: true }, p);
      case 'C': return applyOp(el, 'c', { from: p, to: T.motion(s, p, '$', n, null, true).pos, linewise: false }, p);
      case 'D': return applyOp(el, 'd', { from: p, to: T.motion(s, p, '$', n, null, true).pos, linewise: false }, p);
      case 'Y': return applyOp(el, 'y', { from: p, to: motionLines(s, p, n), linewise: true }, p);
      case 'p': return paste(el, p, false, n);
      case 'P': return paste(el, p, true, n);
      case 'u': return undoRedo(el, 'undo', n);
      case '<C-r>': return undoRedo(el, 'redo', n);
      case 'r': {
        if (p + n > le) return;
        replaceRange(el, p, p + n, cmd.char.repeat(n));
        return setCursor(el, p + n - 1);
      }
      case '~': {
        const b = Math.min(le, p + n);
        if (b <= p) return;
        replaceRange(el, p, b, toggleCase(s.slice(p, b)));
        return setCursor(el, Math.min(b, T.lastCharPos(el.value, p)));
      }
      case 'J': {
        if (!multiline) return;
        let pos = p;
        for (let i = 0; i < Math.max(1, n - 1); i++) {
          const cur = el.value;
          const e = T.lineEnd(cur, pos);
          if (e >= cur.length) break;
          let k = e + 1;
          while (k < cur.length && (cur[k] === ' ' || cur[k] === '\t')) k++;
          const sep = cur[k] === '\n' || k >= cur.length || e === T.lineStart(cur, e) ? '' : ' ';
          replaceRange(el, e, k, sep);
          pos = e;
        }
        return setCursor(el, pos);
      }
      case 'v': case 'V':
        state.vAnchor = state.vHead = p;
        state.editMode = cmd.cmd === 'v' ? 'visual' : 'vline';
        return renderVisual(el);
      default:
        return setCursor(el, p);
    }
  }

  function motionLines(s, p, n) {
    let pos = p;
    for (let i = 0; i < n - 1; i++) pos = T.lineDown(s, pos, 0);
    return pos;
  }

  function visualCommand(el, cmd) {
    const s = el.value;
    const r = visualRange(el);
    const lo = r.linewise ? T.lineStart(s, r.from) : r.from;
    const hi = r.linewise ? T.lineEnd(s, r.to) : r.to;
    switch (cmd.cmd) {
      case 'o': [state.vAnchor, state.vHead] = [state.vHead, state.vAnchor]; return renderVisual(el);
      case 'v': case 'V': {
        const mode = cmd.cmd === 'v' ? 'visual' : 'vline';
        if (state.editMode === mode) return setCursor(el, state.vHead);
        state.editMode = mode;
        return renderVisual(el);
      }
      case 'd': case 'x': case 'Delete': return applyOp(el, 'd', r, lo);
      case 'X': case 'D': return applyOp(el, 'd', { ...r, linewise: true }, lo);
      case 'c': case 's': return applyOp(el, 'c', r, lo);
      case 'C': case 'S': case 'R': return applyOp(el, 'c', { ...r, linewise: true }, lo);
      case 'y': return applyOp(el, 'y', r, lo);
      case 'Y': return applyOp(el, 'y', { ...r, linewise: true }, lo);
      case 'p': case 'P': {
        const reg = state.register;
        if (!reg.text) return;
        setRegister(s.slice(lo, hi), r.linewise);
        replaceRange(el, lo, hi, reg.text);
        return setCursor(el, lo + reg.text.length - 1);
      }
      case '~': case 'u': case 'U': {
        const seg = s.slice(lo, hi);
        const out = cmd.cmd === '~' ? toggleCase(seg) : cmd.cmd === 'u' ? seg.toLowerCase() : seg.toUpperCase();
        replaceRange(el, lo, hi, out);
        return setCursor(el, lo);
      }
      case 'r': {
        replaceRange(el, lo, hi, s.slice(lo, hi).replace(/[^\n]/g, cmd.char));
        return setCursor(el, lo);
      }
      case 'J': {
        setCursor(el, lo);
        const lines = s.slice(lo, hi).split('\n').length;
        return normalCommand(el, { cmd: 'J', count: Math.max(2, lines) });
      }
      default:
        return renderVisual(el);
    }
  }

  function execText(el, cmd) {
    const s = el.value;
    const visual = state.editMode === 'visual' || state.editMode === 'vline';
    const p = visual ? state.vHead : curPos(el);
    const n = cmd.count || 1;
    if (cmd.line) {
      return applyOp(el, cmd.op, { from: p, to: motionLines(s, p, n), linewise: true }, p);
    }
    if (cmd.textobj) {
      const r = T.textObject(s, p, cmd.textobj);
      if (!r) return visual ? undefined : setCursor(el, p);
      if (visual) {
        state.vAnchor = r[0];
        state.vHead = Math.max(r[0], r[1] - 1);
        if (state.editMode === 'vline') state.editMode = 'visual';
        return renderVisual(el);
      }
      return applyOp(el, cmd.op, { from: r[0], to: r[1], linewise: false }, p);
    }
    if (cmd.motion) return execMotion(el, cmd, p, visual);
    return visual ? visualCommand(el, cmd) : normalCommand(el, cmd);
  }

  function repeatContentEditable(el, count) {
    const last = state.ceLast;
    if (!last) return;
    const toks = count ? [...String(count)].concat(last.toks.filter((t) => !/^[0-9]$/.test(t))) : last.toks;
    state.ceReplaying = true;
    try {
      for (const t of toks) execContentEditable(el, t);
      if (state.editMode === 'insert') {
        if (last.inserted) document.execCommand('insertText', false, last.inserted);
        enterNormal(el, true);
      }
    } finally { state.ceReplaying = false; }
  }

  // Collects text typed during a contenteditable insert session so `.` can replay it.
  window.addEventListener('input', (e) => {
    if (state.ceLast && state.ceTyping === true && !state.ceReplaying && e.isTrusted && e.inputType === 'insertText' && e.data) {
      state.ceLast.inserted += e.data;
    }
  }, true);

  // Visual mode for contenteditable: the native selection is extended with Selection.modify().
  function ceVisual(el, cmd, n, ext, move, sel) {
    const exitVisual = () => { sel.collapseToStart(); state.editMode = 'normal'; };
    const yank = () => setRegister(sel.toString(), false);
    switch (cmd.motion || cmd.cmd) {
      case 'h': case 'ArrowLeft': return ext('backward', 'character', n);
      case 'l': case 'ArrowRight': return ext('forward', 'character', n);
      case 'j': case 'ArrowDown': return ext('forward', 'line', n);
      case 'k': case 'ArrowUp': return ext('backward', 'line', n);
      case 'w': case 'W': case 'e': case 'E': return ext('forward', 'word', n);
      case 'b': case 'B': return ext('backward', 'word', n);
      case '0': case '^': case 'Home': return ext('backward', 'lineboundary');
      case '$': case 'End': return ext('forward', 'lineboundary');
      case 'gg': return ext('backward', 'documentboundary');
      case 'G': return ext('forward', 'documentboundary');
      case 'v': case 'V': {
        const mode = cmd.cmd === 'v' ? 'visual' : 'vline';
        if (state.editMode === mode) return exitVisual();
        state.editMode = mode;
        return;
      }
      case 'y': case 'Y': yank(); return exitVisual();
      case 'd': case 'x': case 'D': case 'X': yank(); document.execCommand('delete'); state.editMode = 'normal'; return;
      case 'c': case 's': case 'C': case 'S': yank(); document.execCommand('delete'); return enterInsert(el);
      case 'p': case 'P': {
        const reg = state.register.text;
        if (!reg) return;
        const old = sel.toString();
        document.execCommand('insertText', false, reg);
        setRegister(old, false);
        state.editMode = 'normal';
        return;
      }
      default:
    }
  }

  // Chrome on Windows moves "forward word" to the start of the next word; other platforms stop at the
  // end of the current one. The contenteditable commands below assume the latter.
  const WORD_SKIPS_SPACE = /win/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform);

  function textBeforeFocus(el, sel) {
    const r = document.createRange();
    r.selectNodeContents(el);
    try { r.setEnd(sel.focusNode, sel.focusOffset); } catch { return ''; }
    return r.toString();
  }

  function forwardWordEnd(el, sel, alter) {
    if (!WORD_SKIPS_SPACE) { sel.modify(alter, 'forward', 'word'); return; }
    const start = textBeforeFocus(el, sel).length;
    sel.modify(alter, 'forward', 'word');
    let now = textBeforeFocus(el, sel);
    if (now.length > start && !/\S/.test(now.slice(start))) {
      sel.modify(alter, 'forward', 'word'); // only skipped whitespace; move over the next word too
      now = textBeforeFocus(el, sel);
    }
    for (let k = 0; k < 64 && now.length > start + 1 && /\s/.test(now[now.length - 1]); k++) {
      sel.modify(alter, 'backward', 'character');
      const next = textBeforeFocus(el, sel);
      if (next.length >= now.length) break;
      now = next;
    }
  }

  // Simplified normal mode for contenteditable regions using Selection.modify().
  function execContentEditable(el, tok) {
    const sel = getSelection();
    const step = (alter, dir, unit) => {
      if (dir === 'forward' && unit === 'word') forwardWordEnd(el, sel, alter);
      else sel.modify(alter, dir, unit);
    };
    const move = (dir, unit, n = 1) => { for (let i = 0; i < n; i++) step('move', dir, unit); };
    const ext = (dir, unit, n = 1) => { for (let i = 0; i < n; i++) step('extend', dir, unit); };
    state.buf.push(tok);
    const visual = state.editMode === 'visual' || state.editMode === 'vline';
    const cmd = T.parseCommand(state.buf, visual);
    if (cmd.incomplete) return;
    const toks = state.buf;
    state.buf = [];
    if (cmd.invalid) return;
    const n = cmd.count || 1;
    if (!visual && cmd.cmd === '.') return repeatContentEditable(el, n);
    if (!visual && !state.ceReplaying && isRepeatable(cmd)) {
      state.ceLast = { toks, inserted: '' };
      state.ceTyping = null;
    }
    if (visual) return ceVisual(el, cmd, n, ext, move, sel);
    if (cmd.cmd === 'v' || cmd.cmd === 'V') {
      state.editMode = cmd.cmd === 'v' ? 'visual' : 'vline';
      if (cmd.cmd === 'v') ext('forward', 'character');
      else { move('backward', 'lineboundary'); ext('forward', 'lineboundary'); }
      return;
    }
    if (cmd.line && cmd.op === 'd') {
      move('backward', 'lineboundary');
      ext('forward', 'line', n);
      document.execCommand('delete');
      return;
    }
    if (cmd.op) {
      const map = { w: ['forward', 'word'], e: ['forward', 'word'], b: ['backward', 'word'], $: ['forward', 'lineboundary'], 0: ['backward', 'lineboundary'] };
      const d = map[cmd.motion];
      if (!d) return;
      ext(d[0], d[1], n);
      const text = sel.toString();
      setRegister(text, false);
      if (cmd.op === 'y') { sel.collapseToStart(); return; }
      document.execCommand('delete');
      if (cmd.op === 'c') enterInsert(el);
      return;
    }
    switch (cmd.motion || cmd.cmd) {
      case 'h': case 'ArrowLeft': return move('backward', 'character', n);
      case 'l': case 'ArrowRight': return move('forward', 'character', n);
      case 'j': case 'ArrowDown': return move('forward', 'line', n);
      case 'k': case 'ArrowUp': return move('backward', 'line', n);
      case 'w': case 'W':
        for (let i = 0; i < n; i++) { move('forward', 'word', 2); move('backward', 'word'); }
        return;
      case 'e': case 'E': return move('forward', 'word', n);
      case 'b': case 'B': return move('backward', 'word', n);
      case '0': case '^': case 'Home': return move('backward', 'lineboundary');
      case '$': case 'End': return move('forward', 'lineboundary');
      case 'gg': return move('backward', 'documentboundary');
      case 'G': return move('forward', 'documentboundary');
      case 'i': return enterInsert(el);
      case 'a': move('forward', 'character'); return enterInsert(el);
      case 'I': move('backward', 'lineboundary'); return enterInsert(el);
      case 'A': move('forward', 'lineboundary'); return enterInsert(el);
      case 'o': move('forward', 'lineboundary'); document.execCommand('insertParagraph'); return enterInsert(el);
      case 'O': move('backward', 'lineboundary'); document.execCommand('insertParagraph'); move('backward', 'character'); return enterInsert(el);
      case 'x': ext('forward', 'character', n); setRegister(sel.toString(), false); document.execCommand('delete'); return;
      case 'X': ext('backward', 'character', n); setRegister(sel.toString(), false); document.execCommand('delete'); return;
      case 'D': ext('forward', 'lineboundary'); setRegister(sel.toString(), false); document.execCommand('delete'); return;
      case 'C': ext('forward', 'lineboundary'); setRegister(sel.toString(), false); document.execCommand('delete'); return enterInsert(el);
      case 'p': move('forward', 'character'); if (state.register.text) document.execCommand('insertText', false, state.register.text); return;
      case 'P': if (state.register.text) document.execCommand('insertText', false, state.register.text); return;
      case 'u': for (let i = 0; i < n; i++) document.execCommand('undo'); return;
      case '<C-r>': for (let i = 0; i < n; i++) document.execCommand('redo'); return;
      default:
    }
  }

  function tokenFor(e) {
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return null;
    if (e.ctrlKey) {
      if (e.key === '[') return 'Escape';
      if (e.key.toLowerCase() === 'r') return '<C-r>';
      return null;
    }
    return e.key;
  }

  const REPEATABLE = new Set(['x', 'X', 's', 'S', 'r', '~', 'J', 'D', 'C', 'p', 'P', 'o', 'O', 'i', 'a', 'I', 'A']);
  function isRepeatable(cmd) {
    if (cmd.op) return cmd.op !== 'y';
    return REPEATABLE.has(cmd.cmd);
  }

  function repeatLast(el, count) {
    const { cmd, inserted } = state.lastChange;
    execText(el, count ? { ...cmd, count } : cmd);
    if (state.editMode === 'insert') {
      if (inserted) {
        const p = el.selectionStart;
        replaceRange(el, p, p, inserted);
      }
      state.pendingSnap = null;
      enterNormal(el, true);
    }
  }

  function onEditKey(e, el) {
    if (state.editMode === 'insert') {
      if (isEscape(e) && !e.metaKey && !e.altKey) {
        consume(e);
        state.ceTyping = false;
        const rec = state.recording;
        state.recording = null;
        if (rec && state.lastChange && hasSelectionApi(el)) {
          const end = el.selectionStart;
          if (end >= rec.pos && el.value.length > rec.len) state.lastChange.inserted = el.value.slice(rec.pos, end);
        }
        if (hasSelectionApi(el) || el.isContentEditable) enterNormal(el, true);
        else leaveEdit(true);
      }
      return;
    }
    if (e.metaKey || e.altKey) return;
    const tok = tokenFor(e);
    if (!tok || tok === 'Tab') return;
    if (tok === 'Enter' && el.tagName === 'INPUT' && !state.buf.length) return; // let forms submit
    consume(e);

    if (tok === 'Escape') {
      if (state.buf.length) state.buf = [];
      else if (state.editMode === 'visual' || state.editMode === 'vline') {
        if (hasSelectionApi(el)) setCursor(el, state.vHead);
        else { getSelection().collapseToStart(); state.editMode = 'normal'; }
      }
      else return leaveEdit(true);
      return updateIndicator();
    }

    if (!hasSelectionApi(el)) {
      execContentEditable(el, tok);
      return updateIndicator();
    }

    state.buf.push(tok);
    const visual = state.editMode === 'visual' || state.editMode === 'vline';
    const cmd = T.parseCommand(state.buf, visual);
    if (cmd.incomplete) return updateIndicator();
    state.buf = [];
    if (!cmd.invalid) {
      const before = snapshot(el);
      const repeating = cmd.cmd === '.' && !visual && state.lastChange;
      try {
        if (repeating) repeatLast(el, cmd.count);
        else execText(el, cmd);
      } catch (err) { console.warn('[ChromeVim]', err); }
      if (!repeating && !visual && isRepeatable(cmd)) {
        state.lastChange = { cmd, inserted: '' };
        state.recording = state.editMode === 'insert' ? { pos: el.selectionStart, len: el.value.length } : null;
      }
      if (cmd.cmd !== 'u' && cmd.cmd !== '<C-r>') {
        if (state.editMode === 'insert') state.pendingSnap = { el, ...before };
        else if (el.value !== before.value) pushUndo(el, before);
      }
    }
    updateIndicator();
  }

  // ---------------------------------------------------------------- Event wiring

  function onKeyDown(e) {
    if (!e.isTrusted || e.isComposing || e.keyCode === 229) return;
    if (state.mode === 'hints') return onHintKey(e);

    const active = deepActiveElement();
    if (isEditable(active)) {
      if (state.editEl !== active) enterInsert(active);
      return onEditKey(e, active);
    }
    if (state.editEl) leaveEdit(false);

    if (state.mode === 'passthrough') {
      if (isEscape(e)) { consume(e); state.mode = 'page'; updateIndicator(); }
      return;
    }
    onPageKey(e);
  }

  function onKeyUp(e) {
    if (state.swallowKeyUp.delete(e.code)) e.stopImmediatePropagation();
  }

  function onFocusIn() {
    const active = deepActiveElement();
    if (isEditable(active)) {
      if (state.editEl !== active) {
        if (state.mode === 'hints') exitHints();
        enterInsert(active);
      }
    }
  }

  function onFocusOut() {
    setTimeout(() => {
      if (!document.hasFocus()) return; // window switch: keep current mode
      if (state.editEl && !isEditable(deepActiveElement())) leaveEdit(false);
    }, 0);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('focusin', onFocusIn, true);
  window.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    lastTarget = e.composedPath()[0];
    if (state.mode === 'hints') exitHints();
    if (state.helpOpen) toggleHelp(false);
  }, true);
  window.addEventListener('resize', () => { if (state.mode === 'hints') exitHints(); });
  window.addEventListener('scroll', () => { if (state.mode === 'hints') exitHints(); }, { capture: true, passive: true });
  window.addEventListener('pagehide', () => { if (state.mode === 'hints') exitHints(); });

  // Exposed for automated tests only.
  window.__chromeVimDebug = { state, makeLabels, collectClickables };
})();
