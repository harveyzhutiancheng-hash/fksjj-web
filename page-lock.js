/** A single writable game page per browser prevents shared-cache and cookie races. */
export async function acquireGamePage() {
  let owned = false, release = () => {}, heartbeat;
  const key = 'fkssj-page-lease-v1', token = globalThis.crypto.randomUUID();
  if (navigator.locks?.request) {
    owned = await new Promise(resolve => {
      navigator.locks.request('fkssj-game-writer', { ifAvailable:true }, async lock => {
        resolve(!!lock);
        if (lock) await new Promise(done => { release = done; });
      }).catch(() => resolve(false));
    });
  } else {
    const current = () => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
    const write = () => localStorage.setItem(key, JSON.stringify({ token, until:Date.now() + 12000 }));
    try {
      if (!current() || current().until < Date.now()) {
        write();
        await new Promise(resolve => setTimeout(resolve, 80));
        owned = current()?.token === token;
      }
      if (owned) heartbeat = setInterval(() => {
        if (current()?.token !== token) { owned = false; blocked(); clearInterval(heartbeat); }
        else write();
      }, 3000);
      release = () => { clearInterval(heartbeat); if (current()?.token === token) localStorage.removeItem(key); };
    } catch { owned = false; }
  }
  function blocked() {
    document.body.classList.remove('ready');
    const loading = document.getElementById('loading');
    loading.replaceChildren();
    const title = document.createElement('strong'); title.textContent = '营地已在另一页打开';
    const text = document.createElement('span'); text.textContent = '关闭另一页后，再回来继续。请使用允许储存数据的浏览器。';
    const button = document.createElement('button'); button.className = 'gold-button'; button.textContent = '重新打开营地'; button.onclick = () => location.reload();
    loading.append(title, text, button);
  }
  if (!owned) { blocked(); await new Promise(() => {}); }
  // App's pagehide saves run first. BFCache returns must acquire a fresh lock.
  window.addEventListener('pagehide', () => { queueMicrotask(() => { owned = false; release(); }); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  return () => owned;
}
