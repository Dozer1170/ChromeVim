const { chromium } = require('playwright');
const fs = require('fs');
const EXT = require('path').join(__dirname, '../extension/content/');
const html = `<!doctype html><body style="height:3000px">
<a href="#one" id="l1" onclick="window.clicked='l1'">One</a>
<button id="b1" onclick="window.clicked='b1'">Btn</button>
<input id="inp" value="hello world foo">
<textarea id="ta" rows=4>line one\nline two\nline three</textarea>
<div id="d1" style="cursor:pointer;width:50px;height:20px" onclick="window.clicked='d1'">div</div>
<input type=checkbox id=cb>
</body>`;
let fails = 0;
const eq = (a, b, msg) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', msg, ok ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message); });
  await p.addInitScript({ content: fs.readFileSync(EXT + 'textops.js', 'utf8') + '\n' + fs.readFileSync(EXT + 'vim.js', 'utf8') });
  await p.route('http://t.test/', r => r.fulfill({ contentType: 'text/html', body: html })); await p.goto('http://t.test/');
  const labels = await p.evaluate(() => window.__chromeVimDebug.collectClickables().map(i => i.el.id));
  eq(labels, ['l1', 'b1', 'inp', 'ta', 'd1', 'cb'], 'clickables in order');
  const k = async (...keys) => { for (const x of keys) await p.keyboard.press(x); };
  const typ = async s => { for (const c of s) await p.keyboard.press(c === ' ' ? 'Space' : c); };
  await k('f'); eq(await p.evaluate(() => window.__chromeVimDebug.state.mode), 'hints', 'f shows hints');
  await k('b'); eq(await p.evaluate(() => window.clicked), 'b1', 'f B clicks button');
  await k('f', 'e'); eq(await p.evaluate(() => window.clicked), 'd1', 'f E clicks cursor:pointer div');
  await k('f', 'f'); eq(await p.evaluate(() => document.getElementById('cb').checked), true, 'f F toggles checkbox');
  await k('f', 'Escape'); eq(await p.evaluate(() => window.__chromeVimDebug.state.mode), 'page', 'Esc exits hints');
  await k('j'); await p.waitForTimeout(50); eq(await p.evaluate(() => scrollY), 70, 'j scrolls');
  await k('g', 'g'); await p.waitForTimeout(600); eq(await p.evaluate(() => scrollY), 0, 'gg top');
  // input
  await k('f', 'c');
  const st = () => p.evaluate(() => { const s = window.__chromeVimDebug.state; const a = document.activeElement; return [s.editMode, a.id, a.value, a.selectionStart]; });
  eq(await st(), ['insert', 'inp', 'hello world foo', 15], 'f C focuses input in insert mode');
  await typ('X'); eq((await st())[2], 'hello world fooX', 'insert types');
  await k('Escape'); eq((await st()).slice(0,1).concat((await st())[3]), ['normal', 15], 'Esc -> normal');
  await typ('x'); eq((await st())[2], 'hello world foo', 'x deletes');
  await typ('0w'); eq((await st())[3], 6, '0w');
  await typ('cw'); await typ('there'); await k('Escape'); eq((await st())[2], 'hello there foo', 'cw');
  await typ('0dw'); eq((await st())[2], 'there foo', 'dw');
  await typ('u'); eq((await st())[2], 'hello there foo', 'u undo');
  await typ('$diw'); eq((await st())[2], 'hello there ', 'diw');
  await typ('0dw.'); eq((await st())[2], '', '. repeats dw');
  await typ('u'); await typ('u');
  await typ('0cwab'); await k('Escape'); await typ('w.'); eq((await st())[2], 'ab ab ', '. repeats cw with typed text');
  await typ('u'); eq((await st())[2], 'ab there ', 'u undoes .');
  await typ('u'); eq((await st())[2], 'hello there ', 'u undoes cw');
  await typ('0yiwP'); eq((await st())[2], 'hellohello there ', 'yiw P');
  await typ('A!'); eq((await st())[2], 'hellohello there !', 'A append');
  await k('Escape', 'Escape'); eq(await p.evaluate(() => [window.__chromeVimDebug.state.editEl, document.activeElement.tagName]), [null, 'BODY'], 'Esc Esc leaves field');
  // textarea
  await k('f', 'd', 'Escape');
  await typ('gg'); eq((await st())[3], 0, 'gg in textarea');
  await typ('jdd'); eq((await st())[2], 'line one\nline three', 'j dd');
  await typ('p'); eq((await st())[2], 'line one\nline three\nline two', 'p linewise');
  await typ('ggdd.'); eq((await st())[2], 'line two', '. repeats dd');
  await typ('u'); await typ('u'); await typ('Gyy');
  await typ('ggVjd'); eq((await st())[2], 'line two', 'V j d');
  await typ('ofoo'); await k('Escape'); eq((await st())[2], 'line two\nfoo', 'o opens line');
  await typ('kJ'); eq((await st())[2], 'line two foo', 'J joins');
  await typ('0ftrT'); eq((await st())[2], 'line Two foo', 'f + r');
  await typ('vex'); eq((await st())[2], 'line  foo', 'v e x');
  await typ('0ct '); await typ('ZZ'); await k('Escape'); eq((await st())[2], 'ZZ  foo', 'ct<space>');
  await typ('~'); eq((await st())[2], 'Zz  foo', '~');
  await typ('uu'); eq((await st())[2], 'line  foo', 'uu undoes ~ and change');
  await k('Control+r'); eq((await st())[2], 'ZZ  foo', 'Ctrl-r redo');
  await typ('2u'); eq((await st())[2], 'line Two foo', '2u');
  // clicking into input with mouse => insert mode
  await k('Escape', 'Escape'); await p.click('#inp'); eq((await st())[0], 'insert', 'mouse click -> insert');
  await k('Escape','Escape');
  await typ('i'); eq(await p.evaluate(() => window.__chromeVimDebug.state.mode), 'passthrough', 'i passthrough');
  await typ('j'); await p.waitForTimeout(50); eq(await p.evaluate(() => scrollY), 0, 'passthrough ignores j');
  await k('Escape'); await typ('gi'); eq((await st()).slice(0,2), ['insert','inp'], 'gi');
  // contenteditable
  await k('Escape', 'Escape');
  await p.evaluate(() => { const d = document.createElement('div'); d.id = 'ce'; d.contentEditable = 'true'; d.textContent = 'aa bb cc dd'; document.body.prepend(d); d.focus(); });
  const ce = () => p.evaluate(() => document.getElementById('ce').textContent.replace(/\u00a0/g, ' '));
  await k('Escape'); await typ('0dw.'); eq(await ce(), ' cc dd', 'contenteditable . repeats dw');
  await typ('cwxy'); await k('Escape'); await typ('w.'); eq(await ce(), 'xy xy', 'contenteditable . repeats cw with typed text');
  await b.close(); console.log(fails ? `${fails} FAILURES` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
