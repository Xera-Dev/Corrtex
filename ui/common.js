// Outils partagés par les pages de l'interface Corrtex.

// Mac : ⌘ remplace Ctrl dans tous les raccourcis et Ctrl+clic des pages de Corrtex
// (les raccourcis restent enregistrés en « Ctrl+… »), et les libellés affichent ⌘ ⇧ ⌥.
(function () {
  if (!/Mac/.test(navigator.platform || navigator.userAgent)) return;
  document.documentElement.classList.add('mac');
  const asCtrl = (e) => {
    if (e.metaKey && !e.ctrlKey) Object.defineProperty(e, 'ctrlKey', { value: true });
  };
  for (const t of ['keydown', 'keyup', 'click', 'auxclick', 'mousedown', 'mouseup']) window.addEventListener(t, asCtrl, true);

  const RE = /\b(Ctrl|Maj|Shift|Alt)\+/g;
  const SYM = { Ctrl: '⌘', Maj: '⇧', Shift: '⇧', Alt: '⌥' };
  const fix = (s) => s.replace(RE, (_, k) => SYM[k]).replace(/⌘clic/g, '⌘+clic');
  const fixTitle = (el) => { if (el.title && el.title.includes('+')) { const t = fix(el.title); if (t !== el.title) el.title = t; } };
  const scan = (root) => {
    if (root.nodeType === 3) { if (root.data.includes('+')) { const t = fix(root.data); if (t !== root.data) root.data = t; } return; }
    if (root.nodeType !== 1 || root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') return;
    fixTitle(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) fixTitle(n);
      else if (n.data.includes('+') && n.parentNode.tagName !== 'TEXTAREA' && !n.parentNode.isContentEditable) { const t = fix(n.data); if (t !== n.data) n.data = t; }
    }
  };
  const start = () => {
    scan(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') fixTitle(m.target);
        else for (const n of m.addedNodes) scan(n);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

(function () {
  const T = window.__TAURI__;
  const inTauri = !!T;

  let currentWin = '';
  try { currentWin = window.__TAURI_INTERNALS__.metadata.currentWindow.label; } catch (e) {}

  const api = {
    // icône des extensions (pièce de puzzle)
    ICON_EXT: '<svg viewBox="0 0 24 24"><path d="M7 5.5h2.6a.4.4 0 0 0 .4-.4V4.8a2 2 0 0 1 4 0v.3a.4.4 0 0 0 .4.4H17a1.5 1.5 0 0 1 1.5 1.5v2.6a.4.4 0 0 0 .4.4h.3a2 2 0 0 1 0 4h-.3a.4.4 0 0 0-.4.4V17a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V7A1.5 1.5 0 0 1 7 5.5z"/></svg>',

    // libellé de la fenêtre qui contient cette page (les événements sont filtrés dessus)
    win() {
      try { return window.__TAURI_INTERNALS__.metadata.currentWindow.label; } catch (e) { return currentWin; }
    },
    invoke(cmd, args) {
      if (!inTauri) return Promise.resolve(null);
      return T.core.invoke(cmd, args || {}).catch((e) => { console.warn(cmd, e); return null; });
    },
    listen(event, cb) {
      if (!inTauri) return;
      T.event.listen(event, (e) => cb(e.payload));
    },

    // Transforme ce que l'utilisateur tape en adresse : URL directe ou recherche (moteur choisi).
    toUrl(input) {
      const s = (input || '').trim();
      if (!s) return null;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|file|mailto):/i.test(s)) return s;
      if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
      if (!/\s/.test(s) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(s)) return 'https://' + s;
      return api.searchUrl(s);
    },

    // ------------------------------------------------ moteur de recherche
    engines: [
      { id: 'corrtex', name: 'Corrtex' },
      { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
      { id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
      { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
      { id: 'qwant', name: 'Qwant', url: 'https://www.qwant.com/?q=' },
      { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=' }
    ],
    engine() { const e = api.load('engine', 'corrtex'); return api.engines.some((x) => x.id === e) ? e : 'corrtex'; },
    // adresse d'une page de Corrtex (même origine que la page qui demande)
    pageUrl(page) { return location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + page; },
    // raccourcis « ! » à la DuckDuckGo : !g, !yt, !w, !a, !m, !i, !n, !v…
    bangs: {
      g: 'https://www.google.com/search?q=', yt: 'https://www.youtube.com/results?search_query=', w: 'https://fr.wikipedia.org/w/index.php?search=',
      a: 'https://www.amazon.fr/s?k=', m: 'https://www.google.com/maps/search/', gm: 'https://www.google.com/maps/search/', b: 'https://www.bing.com/search?q=',
      ddg: 'https://duckduckgo.com/?q=', gh: 'https://github.com/search?q=', r: 'https://www.reddit.com/search/?q=', tw: 'https://x.com/search?q=',
      lbc: 'https://www.leboncoin.fr/recherche?text=', imdb: 'https://www.imdb.com/find/?q=', t: 'https://translate.google.com/?sl=auto&tl=fr&text=',
      wr: 'https://www.wordreference.com/fren/', so: 'https://stackoverflow.com/search?q=', sp: 'https://open.spotify.com/search/'
    },
    bangUrl(key, rest) {
      const vert = { i: 'images', n: 'news', v: 'videos' }[key];
      if (vert) return api.pageUrl('search.html') + '#q=' + encodeURIComponent(rest) + '&t=' + vert;
      const base = api.bangs[key];
      if (!base) return null;
      if (!rest) { try { return new URL(base).origin + '/'; } catch (e) { return null; } }
      return base + encodeURIComponent(rest);
    },
    searchUrl(q, engine) {
      const m = q.match(/(?:^|\s)!([a-z]{1,6})(?=\s|$)/i);
      if (m) { const b = api.bangUrl(m[1].toLowerCase(), q.replace(m[0], ' ').trim()); if (b) return b; }
      const e = api.engines.find((x) => x.id === (engine || api.engine()));
      if (e && e.url) return e.url + encodeURIComponent(q);
      return api.pageUrl('search.html') + '#q=' + encodeURIComponent(q);
    },
    // adresse d'une page de recherche (Corrtex ou moteur connu) → texte recherché, sinon null
    searchQuery(url) {
      try {
        const u = new URL(url);
        if (/\/search\.html$/.test(u.pathname)) return new URLSearchParams(u.hash.slice(1)).get('q');
        if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/search') return u.searchParams.get('q');
      } catch (e) {}
      return null;
    },
    // lance la recherche Corrtex avant même que la page de résultats soit chargée
    prefetchSearch(url) {
      try {
        const u = new URL(url);
        if (!/\/search\.html$/.test(u.pathname)) return;
        const p = new URLSearchParams(u.hash.slice(1));
        if (p.get('q')) api.invoke('search_prefetch', { q: p.get('q'), kind: p.get('t') || 'web' });
      } catch (e) {}
    },

    favicon(url, size) {
      try {
        const host = new URL(url).hostname;
        return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=' + (size || 32);
      } catch (e) { return ''; }
    },

    hostOf(url) {
      try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
    },

    // Stockage local (partagé entre la barre du navigateur et la page d'accueil).
    load(key, fallback) {
      try {
        const v = localStorage.getItem('corrtex.' + key);
        return v ? JSON.parse(v) : fallback;
      } catch (e) { return fallback; }
    },
    save(key, value) {
      try { localStorage.setItem('corrtex.' + key, JSON.stringify(value)); } catch (e) {}
      window.dispatchEvent(new CustomEvent('corrtex-store', { detail: key }));
    },

    defaultBookmarks: [
      { title: 'YouTube', url: 'https://www.youtube.com/' },
      { title: 'Google', url: 'https://www.google.com/' },
      { title: 'GitHub', url: 'https://github.com/' },
      { title: 'Actualités', url: 'https://news.google.com/' }
    ],

    themes: [
      { id: 'graphite', name: 'Graphite', preview: ['#2f2f32', '#5e5e62'] },
      { id: 'minuit', name: 'Minuit', preview: ['#0d0d0f', '#1f1f23'] },
      { id: 'ocean', name: 'Océan', preview: ['#0d1726', '#1e2d46'] },
      { id: 'clair', name: 'Clair', preview: ['#dfe1e5', '#f6f7f9'] }
    ],

    lightColors: ['#ff4f7b', '#ff8a3d', '#ffd23f', '#3ddc97', '#2fb7ff', '#6c63ff', '#c86bff', '#ffffff'],

    // Préférences d'apparence (stockées localement, partagées entre les pages)
    prefs() {
      return Object.assign({ theme: 'graphite', light: '#ff4f7b', lightOn: true, lightIntensity: 1 }, api.load('prefs', {}));
    },
    setPrefs(patch) {
      api.save('prefs', Object.assign(api.prefs(), patch));
      api.applyTheme();
    },
    applyTheme() {
      document.documentElement.dataset.theme = api.prefs().theme;
    },
    // couleurs du thème transmises aux pages d'IA et de recherche Google
    sendTheme() {
      const p = api.prefs();
      const css = getComputedStyle(document.documentElement);
      const v = (n) => css.getPropertyValue(n).trim();
      const light = /^#[0-9a-f]{6}$/i.test(p.light) ? p.light : '#ff4f7b';
      api.invoke('set_ai_theme', { theme: {
        bg1: v('--page-1'), bg2: v('--page-2'), card: v('--card-solid'), fg: v('--fg'),
        accent: light, scheme: p.theme === 'clair' ? 'light' : 'dark', google: p.googleSkin === false ? 'off' : 'on'
      } });
    },

    defaultShortcuts: [
      { title: 'YouTube', url: 'https://www.youtube.com/', color: '#3b4a9c' },
      { title: 'Gmail', url: 'https://mail.google.com/', color: '#e04b5a' },
      { title: 'GitHub', url: 'https://github.com/', color: '#eef0f4' },
      { title: 'Actualités', url: 'https://news.google.com/', color: '#3fa9d8' }
    ]
  };

  window.Corrtex = api;

  // Thème appliqué dès le chargement, et mis à jour en direct quand il change ailleurs.
  api.applyTheme();
  window.addEventListener('storage', (e) => {
    if (e.key === 'corrtex.prefs') {
      api.applyTheme();
      window.dispatchEvent(new CustomEvent('corrtex-prefs'));
    }
  });
  window.addEventListener('corrtex-store', (e) => {
    if (e.detail === 'prefs') window.dispatchEvent(new CustomEvent('corrtex-prefs'));
  });
})();
