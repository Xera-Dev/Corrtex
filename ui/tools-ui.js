// Panneau « Outils » partagé : page d'accueil et panneau de la barre d'outils.
// Navigation (historique, téléchargements, palette…), confidentialité et performances.
(function () {
  const C = window.Corrtex;
  const ICON = {
    history: '<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4.5v10.5M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    reopen: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.5H9"/></svg>',
    priv: '<svg viewBox="0 0 24 24"><path d="M3 11.5c2.5-.6 5.5-1 9-1s6.5.4 9 1"/><path d="M6.5 10.5l1.5-5.5h8l1.5 5.5"/><circle cx="8" cy="16" r="2.5"/><circle cx="16" cy="16" r="2.5"/><path d="M10.5 16h3"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/></svg>',
    cookie: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="9" cy="10" r="1"/><circle cx="14.5" cy="8.5" r=".8"/><circle cx="15" cy="14" r="1.1"/><circle cx="10" cy="15.5" r=".8"/></svg>',
    shot: '<svg viewBox="0 0 24 24"><path d="M4.5 8.5V6a1.5 1.5 0 0 1 1.5-1.5h2.5M15.5 4.5H18A1.5 1.5 0 0 1 19.5 6v2.5M19.5 15.5V18a1.5 1.5 0 0 1-1.5 1.5h-2.5M8.5 19.5H6A1.5 1.5 0 0 1 4.5 18v-2.5"/><circle cx="12" cy="12" r="3"/></svg>',
    cart: '<svg viewBox="0 0 24 24"><path d="M4 5h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.2L20 8.5H7"/><circle cx="10" cy="20" r="1.2"/><circle cx="17" cy="20" r="1.2"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M12 6.5c-1.8-1.3-4.3-2-7.5-2v13c3.2 0 5.7.7 7.5 2 1.8-1.3 4.3-2 7.5-2v-13c-3.2 0-5.7.7-7.5 2z"/><path d="M12 6.5v13"/></svg>',
    focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>',
    backup: '<svg viewBox="0 0 24 24"><path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 14.5v4a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4"/></svg>'
  };

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function row(icon, label, right) {
    const b = el('button', 'row-link');
    b.innerHTML = icon + '<span></span><span class="right"></span>';
    b.children[1].textContent = label;
    b.children[2].textContent = right || '';
    return b;
  }
  function mb(bytes) { return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' Go' : Math.round(bytes / 1e6) + ' Mo'; }

  /**
   * Construit le contenu dans `root`. `close` : ferme le panneau après une action.
   * Renvoie { start, stop } pour l'actualisation du tableau des performances.
   */
  function mount(root, close) {
    root.replaceChildren();
    // l'action d'abord, puis le panneau se ferme (sa page disparaît avec lui)
    const after = (fn) => () => { fn(); setTimeout(close, 60); };

    // ---------------------------------------------------------------- navigation
    const g1 = el('div', 'group', '<h3>Navigation</h3>');
    const l1 = el('div', 'list');
    const nav = [
      [ICON.history, 'Historique', 'Ctrl+H', () => C.invoke('open_library', { section: 'history' })],
      [ICON.download, 'Téléchargements', 'Ctrl+J', () => C.invoke('open_library', { section: 'downloads' })],
      [ICON.search, 'Palette de commandes', 'Ctrl+K', () => C.invoke('palette_open')],
      [ICON.reopen, 'Rouvrir l’onglet fermé', 'Ctrl+Maj+T', () => C.invoke('reopen_closed').catch(() => {})],
      [ICON.shot, 'Capture d’écran', 'Ctrl+Maj+S', () => C.invoke('capture_page', { mode: 'area' }).catch(() => {})],
      [ICON.book, 'Liste de lecture', '', () => C.invoke('open_library', { section: 'readlater' })],
      [ICON.focus, 'Mode concentration (25 min)', '', () => C.invoke('focus_start', { minutes: 25 })]
    ];
    for (const n of nav) { const b = row(n[0], n[1], n[2]); b.onclick = after(n[3]); l1.append(b); }
    // dernière recherche d'achat de l'agent (le panneau remplace celui-ci : pas de fermeture après)
    const shopRow = row(ICON.cart, 'Recherche d’achat (derniers résultats)', '');
    shopRow.onclick = () => {
      const inPanel = /^panw-/.test((((window.__TAURI_INTERNALS__ || {}).metadata || {}).currentWindow || {}).label || '');
      if (!inPanel) close();
      C.invoke('toggle_ext_panel', { view: 'shopping' });
    };
    l1.append(shopRow);
    g1.append(l1);

    // ---------------------------------------------------------------- confidentialité
    const g2 = el('div', 'group', '<h3>Confidentialité</h3>');
    const l2 = el('div', 'list');
    const priv = row(ICON.priv, 'Nouvelle fenêtre privée', 'Ctrl+Maj+N');
    priv.onclick = after(() => C.invoke('new_private_window'));
    l2.append(priv);
    const armed = {};
    for (const [kind, icon, label] of [['history', ICON.trash, 'Effacer l’historique'], ['cookies', ICON.cookie, 'Effacer cookies et cache']]) {
      const b = row(icon, label, '');
      const right = b.querySelector('.right');
      // effacement en deux temps
      b.onclick = async () => {
        if (!armed[kind]) {
          right.textContent = 'Confirmer ?';
          armed[kind] = setTimeout(() => { armed[kind] = null; right.textContent = ''; }, 3000);
          return;
        }
        clearTimeout(armed[kind]); armed[kind] = null;
        right.textContent = '…';
        try { await C.invoke('clear_data', { kind }); right.textContent = 'Effacé'; } catch (e) { right.textContent = 'Erreur'; }
        setTimeout(() => { right.textContent = ''; }, 2500);
      };
      l2.append(b);
    }
    g2.append(l2, el('p', 'hint', 'Effacer les cookies vous déconnecte des sites (Google compris).'));
    g2.lastChild.style.marginTop = '8px';

    // ---------------------------------------------------------------- performances
    const g3 = el('div', 'group', '<h3>Performances</h3>');
    const cards = el('div', 'perf-cards');
    const card = (label) => { const c = el('div', 'perf-card'); const b = el('b', '', '—'); c.append(b, el('span', '', label)); cards.append(c); return b; };
    const mem = card('Mémoire de Corrtex'), count = card('Onglets ouverts'), asleep = card('En veille');
    const list = el('div', 'list');
    const sleepAll = el('button', 'chip', 'Mettre en veille les onglets inactifs');
    sleepAll.style.marginTop = '12px';
    g3.append(cards, list, sleepAll);

    root.append(g1, g2, g3);

    async function refresh() {
      const p = await C.invoke('perf_stats').catch(() => null);
      if (!p) return;
      mem.textContent = p.total ? mb(p.total) : '—';
      count.textContent = p.count;
      asleep.textContent = p.asleep;
      list.replaceChildren();
      const max = Math.max(1, ...p.tabs.map((t) => t.js || 0));
      for (const t of p.tabs.filter((t) => t.url).slice(0, 8)) {
        const r = el('div', 'row-link perf-row');
        const img = el('img');
        img.src = t.favicon || C.favicon(t.url);
        img.onerror = function () { this.style.visibility = 'hidden'; };
        const name = el('span');
        name.textContent = (t.private ? 'Privé · ' : '') + (t.title || C.hostOf(t.url));
        r.append(img, name);
        if (t.asleep) {
          r.append(el('span', 'zz', 'en veille'));
        } else {
          const bar = el('span', 'bar');
          const i = el('i');
          i.style.width = Math.max(4, Math.round((t.js || 0) / max * 100)) + '%';
          bar.title = t.js ? mb(t.js) + ' de mémoire JavaScript' : 'mesure en cours';
          bar.append(i);
          r.append(el('span', 'zz', t.js ? mb(t.js) : ''), bar);
          if (!t.active && !t.pinned) {
            const a = el('button', 'act', 'Veille');
            a.onclick = async () => { await C.invoke('perf_sleep', { id: t.id }); refresh(); };
            r.append(a);
          }
        }
        list.append(r);
      }
    }
    sleepAll.onclick = async () => { await C.invoke('perf_sleep', {}); refresh(); };
    let timer = null;
    return {
      start() { if (!timer) { refresh(); timer = setInterval(refresh, 2500); } },
      stop() { clearInterval(timer); timer = null; }
    };
  }

  window.CorrtexTools = { mount };
})();
