// Handles tab-level commands that content scripts cannot perform themselves.
const api = globalThis.chrome;

function handle(msg, tab) {
  switch (msg && msg.type) {
    case 'openTab':
      return api.tabs.create({
        url: msg.url,
        active: false,
        index: tab ? tab.index + 1 : undefined,
        openerTabId: tab ? tab.id : undefined,
      }).catch(() => api.tabs.create({ url: msg.url, active: false }));
    case 'closeTab':
      return tab ? api.tabs.remove(tab.id) : undefined;
    case 'switchTab':
      return api.tabs.query({ currentWindow: true }).then((tabs) => {
        if (!tab || tabs.length < 2) return;
        tabs.sort((a, b) => a.index - b.index);
        const i = tabs.findIndex((t) => t.id === tab.id);
        const next = tabs[(i + msg.delta + tabs.length) % tabs.length];
        return api.tabs.update(next.id, { active: true });
      });
    case 'listTabs':
      return api.tabs.query({ currentWindow: true }).then((tabs) => tabs
        .sort((a, b) => a.index - b.index)
        .map((t) => ({ id: t.id, title: t.title || t.url || '', active: t.id === (tab && tab.id) })));
    case 'activateTab':
      return api.tabs.update(msg.id, { active: true });
    default:
      return undefined;
  }
}

// Chrome's onMessage ignores returned promises; reply through sendResponse instead.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  Promise.resolve()
    .then(() => handle(msg, sender.tab))
    .then((result) => sendResponse(result === undefined ? null : result), () => sendResponse(null));
  return true;
});
