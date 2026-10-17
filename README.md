# ChromeVim

Vim-style keyboard navigation for Chrome: link hints, scrolling, and vim normal/insert modes in text fields. A Chrome port of SafariVim with the same keys and behavior.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension/` folder in this repo.
3. Reload any tabs that were already open. Content scripts only reach pages that load after you install the extension.

After you edit the JS, click the reload icon on the ChromeVim card in `chrome://extensions`, then reload the page.

The same folder also loads in other Chromium browsers, such as Edge (`edge://extensions`) and Brave.

## Keys

### Page

| Key | Action |
| --- | --- |
| `f` | Label clickable items (`A`–`Z`, `a`–`z`; two letters if there are more than 52). Type a label to click it. Text fields get focus in insert mode. |
| `F` | Same as `f`, but links open in a new background tab |
| `t` | List open tabs with labels; type a label to switch to that tab |
| `j` / `k`, `h` / `l` | Scroll down/up, left/right |
| `d` / `u` | Scroll half a page down/up |
| `gg` / `G` | Jump to the top/bottom |
| `^` / `$` | Scroll to the far left/right |
| `H` / `L` | Go back/forward in history |
| `r` | Reload |
| `gi` | Focus the first text input |
| `yy` | Copy the page URL |
| `J` / `K` | Switch to the previous/next tab |
| `x` | Close the tab |
| `i` | Pass-through mode: send all keys to the page. `Esc` exits. |
| `?` | Show help |

### Text fields (input, textarea, contenteditable)

Clicking or focusing a field puts it in **insert** mode. `Esc` (or `Ctrl-[`) switches to **normal** mode. Pressing `Esc` again leaves the field.

- Motions: `h j k l w W b B e E 0 ^ $ gg G f F t T ; ,`. Counts work, for example `3w`.
- Operators: `d c y` plus a motion or text object (`iw aw i" a" i' i( a( i[ i{ i<` …). `dd cc yy` act on whole lines.
- Edits: `x X s S r ~ J D C Y p P o O i a I A`
- `.` repeats the last change (including text typed in insert mode).  Works in contenteditable too.
- `u` / `Ctrl-r` undo and redo. Each command or insert session counts as one step.
- `v` / `V` start visual and visual-line mode. Then use `d x c y p ~ u U r J o`.
- In single-line inputs, `Enter` in normal mode submits the form.

Contenteditable regions (rich editors) get a smaller command set based on `Selection.modify`. It includes `v` / `V` with motions and `y d x c p` in visual mode.

## Tests

```sh
npm install && npm run setup-tests && npm test
```

`tests/e2e.test.js` loads the content scripts into Playwright Chromium and simulates keystrokes. `tests/extension.test.js` loads the unpacked extension into Chromium and checks the tab commands (`J` `K` `t` `F` `x` `yy`) that go through the service worker.

## Limitations

- Hints only cover the frame that has focus. Elements inside iframes don't get labels from the top page.
- Chrome doesn't allow extensions on its own pages (`chrome://…`, the New Tab page) or on the Chrome Web Store.
- Chrome keeps a few shortcuts for itself (for example `Ctrl-T`, `Ctrl-W`, `Ctrl-N`). Pages can't intercept those.
- There are no macros or named registers. Yanks also go to the system clipboard when the page allows it.
