// Pure text helpers for vim-style editing of <input>/<textarea> values.
(function (root) {
  'use strict';

  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\u00a0';
  const isWordChar = (c) => /[\p{L}\p{N}_]/u.test(c);
  const charClass = (c, big) => {
    if (c === undefined) return -1;
    if (isSpace(c)) return 0;
    if (big) return 2;
    return isWordChar(c) ? 2 : 1;
  };

  function lineStart(s, p) {
    if (p <= 0) return 0;
    return s.lastIndexOf('\n', p - 1) + 1;
  }
  function lineEnd(s, p) {
    const i = s.indexOf('\n', p);
    return i < 0 ? s.length : i;
  }
  function lastCharPos(s, p) {
    return Math.max(lineStart(s, p), lineEnd(s, p) - 1);
  }
  function firstNonBlank(s, p) {
    let i = lineStart(s, p);
    const le = lineEnd(s, p);
    while (i < le && (s[i] === ' ' || s[i] === '\t')) i++;
    return Math.min(i, Math.max(lineStart(s, p), le - 1));
  }
  function clampNormal(s, p) {
    p = Math.max(0, Math.min(p, s.length));
    return Math.min(p, lastCharPos(s, p));
  }
  function isEmptyLineAt(s, i) {
    return s[i] === '\n' && lineStart(s, i) === i;
  }
  function lineStartOf(s, idx) {
    let p = 0;
    for (let i = 0; i < idx; i++) {
      const nl = s.indexOf('\n', p);
      if (nl < 0) break;
      p = nl + 1;
    }
    return p;
  }

  function wordForward(s, p, big) {
    const n = s.length;
    if (p >= n) return n;
    const c = charClass(s[p], big);
    let i = p;
    if (c !== 0) while (i < n && charClass(s[i], big) === c) i++;
    while (i < n && isSpace(s[i])) {
      if (i !== p && isEmptyLineAt(s, i)) break;
      i++;
    }
    return i;
  }
  function wordBackward(s, p, big) {
    let i = p - 1;
    if (i <= 0) return 0;
    while (i > 0 && isSpace(s[i])) {
      if (isEmptyLineAt(s, i)) return i;
      i--;
    }
    if (i <= 0) return 0;
    const c = charClass(s[i], big);
    while (i > 0 && charClass(s[i - 1], big) === c) i--;
    return i;
  }
  function wordEnd(s, p, big) {
    const n = s.length;
    let i = p + 1;
    while (i < n && isSpace(s[i])) i++;
    if (i >= n) return Math.max(0, n - 1);
    const c = charClass(s[i], big);
    while (i + 1 < n && charClass(s[i + 1], big) === c) i++;
    return i;
  }

  function lineDown(s, p, col) {
    const le = lineEnd(s, p);
    if (le >= s.length) return p;
    const nls = le + 1;
    const nle = lineEnd(s, nls);
    return Math.min(nls + col, Math.max(nls, nle - 1));
  }
  function lineUp(s, p, col) {
    const ls = lineStart(s, p);
    if (ls === 0) return p;
    const pls = lineStart(s, ls - 1);
    const ple = ls - 1;
    return Math.min(pls + col, Math.max(pls, ple - 1));
  }

  // kind: f | t | F | T. `repeat` skips an adjacent match for t/T so ";" makes progress.
  function findChar(s, p, ch, kind, repeat) {
    const ls = lineStart(s, p), le = lineEnd(s, p);
    if (kind === 'f') { for (let i = p + 1; i < le; i++) if (s[i] === ch) return i; }
    else if (kind === 't') { for (let i = p + (repeat ? 2 : 1); i < le; i++) if (s[i] === ch) return i - 1; }
    else if (kind === 'F') { for (let i = p - 1; i >= ls; i--) if (s[i] === ch) return i; }
    else if (kind === 'T') { for (let i = p - (repeat ? 2 : 1); i >= ls; i--) if (s[i] === ch) return i + 1; }
    return -1;
  }

  // Returns {pos, type: 'exclusive'|'inclusive'|'linewise'} or null.
  function motion(s, p, m, count, ch, isOp, col, repeat) {
    const n = count || 1;
    let pos = p, type = 'exclusive';
    if (col === undefined || col === null) col = p - lineStart(s, p);
    switch (m) {
      case 'h': case 'ArrowLeft': case 'Backspace':
        pos = Math.max(lineStart(s, p), p - n); break;
      case 'l': case 'ArrowRight': case ' ':
        pos = Math.min(isOp ? lineEnd(s, p) : lastCharPos(s, p), p + n); break;
      case 'j': case 'ArrowDown': case 'Enter':
        type = 'linewise'; for (let i = 0; i < n; i++) pos = lineDown(s, pos, col); break;
      case 'k': case 'ArrowUp':
        type = 'linewise'; for (let i = 0; i < n; i++) pos = lineUp(s, pos, col); break;
      case 'w': case 'W':
        for (let i = 0; i < n; i++) pos = wordForward(s, pos, m === 'W'); break;
      case 'b': case 'B':
        for (let i = 0; i < n; i++) pos = wordBackward(s, pos, m === 'B'); break;
      case 'e': case 'E':
        type = 'inclusive'; for (let i = 0; i < n; i++) pos = wordEnd(s, pos, m === 'E'); break;
      case '0': case 'Home':
        pos = lineStart(s, p); break;
      case '^':
        pos = firstNonBlank(s, p); break;
      case '$': case 'End':
        for (let i = 0; i < n - 1; i++) pos = lineDown(s, pos, 0);
        pos = isOp ? lineEnd(s, pos) : lastCharPos(s, pos); break;
      case 'gg':
        type = 'linewise'; pos = firstNonBlank(s, count ? lineStartOf(s, count - 1) : 0); break;
      case 'G':
        type = 'linewise'; pos = firstNonBlank(s, count ? lineStartOf(s, count - 1) : lineStart(s, s.length)); break;
      case 'f': case 't': case 'F': case 'T': {
        type = (m === 'f' || m === 't') ? 'inclusive' : 'exclusive';
        for (let i = 0; i < n; i++) {
          const r = findChar(s, pos, ch, m, repeat || i > 0);
          if (r < 0) return null;
          pos = r;
        }
        break;
      }
      default:
        return null;
    }
    return { pos, type };
  }

  function wordObject(s, p, around, big) {
    const n = s.length;
    if (!n || s[p] === '\n' || p >= n) return [p, p];
    const c = charClass(s[p], big);
    let a = p, b = p + 1;
    while (a > 0 && s[a - 1] !== '\n' && charClass(s[a - 1], big) === c) a--;
    while (b < n && s[b] !== '\n' && charClass(s[b], big) === c) b++;
    if (around) {
      if (c !== 0) {
        let e = b;
        while (e < n && (s[e] === ' ' || s[e] === '\t')) e++;
        if (e > b) b = e;
        else while (a > 0 && (s[a - 1] === ' ' || s[a - 1] === '\t')) a--;
      } else if (b < n && s[b] !== '\n') {
        const c2 = charClass(s[b], big);
        while (b < n && s[b] !== '\n' && charClass(s[b], big) === c2) b++;
      }
    }
    return [a, b];
  }

  function quoteObject(s, p, q, around) {
    const ls = lineStart(s, p), le = lineEnd(s, p);
    const qs = [];
    for (let i = ls; i < le; i++) if (s[i] === q && s[i - 1] !== '\\') qs.push(i);
    for (let i = 0; i + 1 < qs.length; i += 2) {
      const o = qs[i], c = qs[i + 1];
      if ((p >= o && p <= c) || p < o) return around ? [o, c + 1] : [o + 1, c];
    }
    return null;
  }

  function bracketObject(s, p, open, close, around) {
    let depth = 0, o = -1;
    for (let i = Math.min(p, s.length - 1); i >= 0; i--) {
      const ch = s[i];
      if (ch === close && i !== p) depth++;
      else if (ch === open) { if (depth === 0) { o = i; break; } depth--; }
    }
    if (o < 0) return null;
    depth = 0;
    let c = -1;
    for (let i = o + 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === open) depth++;
      else if (ch === close) { if (depth === 0) { c = i; break; } depth--; }
    }
    if (c < 0) return null;
    return around ? [o, c + 1] : [o + 1, c];
  }

  const BRACKETS = {
    '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
    '[': ['[', ']'], ']': ['[', ']'],
    '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
    '<': ['<', '>'], '>': ['<', '>'],
  };

  function textObject(s, p, obj) {
    const around = obj[0] === 'a';
    const k = obj.slice(1);
    if (k === 'w' || k === 'W') return wordObject(s, p, around, k === 'W');
    if (k === '"' || k === "'" || k === '`') return quoteObject(s, p, k, around);
    if (BRACKETS[k]) return bracketObject(s, p, BRACKETS[k][0], BRACKETS[k][1], around);
    return null;
  }

  // Parses a buffer of key tokens into a command. Returns {incomplete}, {invalid}, or a command.
  function parseCommand(toks, visual) {
    const isDigit = (t, cur) => /^[0-9]$/.test(t) && !(t === '0' && cur === '');
    let i = 0, c1 = '', c2 = '', op = null;
    while (i < toks.length && isDigit(toks[i], c1)) c1 += toks[i++];
    if (i >= toks.length) return { incomplete: true };
    if (!visual && (toks[i] === 'd' || toks[i] === 'c' || toks[i] === 'y')) {
      op = toks[i++];
      while (i < toks.length && isDigit(toks[i], c2)) c2 += toks[i++];
      if (i >= toks.length) return { incomplete: true };
    }
    const count = (c1 || c2) ? parseInt(c1 || '1', 10) * parseInt(c2 || '1', 10) : 0;
    const k = toks[i];
    const rest = toks.slice(i + 1);
    const needChar = () => {
      if (!rest.length) return null;
      return rest[0].length === 1 ? rest[0] : false;
    };
    if (op && k === op) return { op, line: true, count };
    if (k === 'g') {
      if (!rest.length) return { incomplete: true };
      return rest[0] === 'g' ? { op, motion: 'gg', count } : { invalid: true };
    }
    if (k === 'f' || k === 'F' || k === 't' || k === 'T') {
      const ch = needChar();
      if (ch === null) return { incomplete: true };
      if (ch === false) return { invalid: true };
      return { op, motion: k, char: ch, count };
    }
    if ((op || visual) && (k === 'i' || k === 'a')) {
      if (!rest.length) return { incomplete: true };
      return { op, textobj: k + rest[0], count };
    }
    if (!op && k === 'r') {
      const ch = needChar();
      if (ch === null) return { incomplete: true };
      if (ch === false) return { invalid: true };
      return { cmd: 'r', char: ch, count };
    }
    if (MOTION_KEYS.has(k)) return { op, motion: k, count };
    if (op) return { invalid: true };
    return { cmd: k, count };
  }

  const MOTION_KEYS = new Set([
    'h', 'j', 'k', 'l', 'w', 'W', 'b', 'B', 'e', 'E', '0', '^', '$', 'G', ';', ',',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', ' ', 'Enter',
  ]);

  root.ChromeVimText = {
    isSpace, lineStart, lineEnd, lastCharPos, firstNonBlank, clampNormal, lineStartOf,
    wordForward, wordBackward, wordEnd, lineDown, lineUp, findChar, motion, textObject, parseCommand,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
