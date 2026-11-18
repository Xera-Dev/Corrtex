// Barre du navigateur : onglets (avec glisser-déposer), navigation, barre d'adresse, favoris.
(function () {
  const C = window.Corrtex;
  const $ = (id) => document.getElementById(id);
  const tabsEl = $('tabs');
  const address = $('address');
  let st = { tabs: [], active: null, sidebar_open: false, media: null, maximized: false };
  let editing = false; // l'utilisateur tape dans la barre d'adresse
  let drag = null;     // glisser-déposer en cours
  let pendingRender = false;

  const ICON_NOTE = '<svg class="playing" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>';
  const ICON_MUTED = '<svg class="playing" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function activeTab() { return st.tabs.find((t) => t.id === st.active); }
  // onglets de l'espace affiché
  function spaceTabs() { return st.tabs.filter((t) => (t.space || 0) === (st.space || 0)); }
  // sélecteur d'espace : pastille de couleur + nom (le nom n'apparaît qu'avec plusieurs espaces)
  function renderSpace() {
    const b = $('space-btn');
    const spaces = st.spaces || [];
    const cur = spaces.find((s) => s.id === (st.space || 0)) || spaces[0];
    if (!cur) return;
    b.style.setProperty('--sc', cur.color);
    b.querySelector('span').textContent = spaces.length > 1 ? cur.name : '';
    b.classList.toggle('named', spaces.length > 1);
    b.title = 'Espace : ' + cur.name + ' — cliquer pour changer ou créer un espace';
  }
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // ------------------------------------------------------------- onglets
  // Onglets épinglés (icône seule, à gauche), groupes (pastille colorée repliable),
  // onglets en veille (estompés), menu du clic droit et aperçu au survol.
  let hoverTimer = null, previewOpen = false;
  function groupOf(id) { return (st.groups || []).find((g) => g.id === id); }
  function hidePreview() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    if (previewOpen) { previewOpen = false; C.invoke('preview_close'); }
  }
  function renderTabs() {
    if (drag) { pendingRender = true; return; }
    const frag = document.createDocumentFragment();
    const avail = tabsEl.parentElement.clientWidth - 260;
    const shown = spaceTabs();
    const normal = shown.filter((t) => !t.pinned);
    const pinnedW = (shown.length - normal.length) * 42;
    const narrow = normal.length * 120 > avail - pinnedW;
    let prevGroup = 0;
    renderSpace();
    for (const t of shown) {
      const g = !t.pinned && t.group ? groupOf(t.group) : null;
      // pastille du groupe, devant son premier onglet
      if (g && g.id !== prevGroup) {
        const pill = document.createElement('button');
        pill.className = 'grp' + (g.collapsed ? ' collapsed' : '');
        pill.style.setProperty('--gc', g.color);
        pill.title = (g.name || 'Groupe') + (g.collapsed ? ' (replié) — cliquer pour ouvrir' : ' — cliquer pour replier');
        const dot = document.createElement('i');
        const name = document.createElement('span');
        name.textContent = g.name || '';
        pill.append(dot, name);
        if (g.collapsed) {
          const n = st.tabs.filter((x) => x.group === g.id).length;
          const c = document.createElement('em');
          c.textContent = n;
          pill.appendChild(c);
        }
        pill.addEventListener('click', () => { hidePreview(); C.invoke('group_action', { gid: g.id, action: 'toggle' }); });
        pill.addEventListener('contextmenu', (e) => { e.preventDefault(); hidePreview(); C.invoke('group_menu', { gid: g.id, x: pill.getBoundingClientRect().left }); });
        frag.appendChild(pill);
      }
      prevGroup = g ? g.id : 0;
      if (g && g.collapsed) continue;
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === st.active ? ' active' : '') + (st.split && (t.id === st.split || t.id === st.active) ? ' split' : '') + (narrow && !t.pinned ? ' narrow' : '') +
        (t.pinned ? ' pinned' : '') + (t.asleep ? ' asleep' : '') + (g ? ' grouped' : '');
      if (g) el.style.setProperty('--gc', g.color);
      el.dataset.id = t.id;
      let icon;
      if (t.loading && t.url) icon = '<span class="spinner"></span>';
      else if (!t.url) icon = '<img class="fav" src="icon.png" alt="">';
      else icon = '<img class="fav" alt="" src="' + escAttr(t.favicon || C.favicon(t.url)) + '">';
      // son : haut-parleur sur l'onglet qui joue du son (cliquer coupe le son), barré s'il est coupé
      const playing = t.muted ? '<button class="snd muted" title="Remettre le son (Alt+M)">' + ICON_MUTED + '</button>'
        : (t.audible || (st.media && st.media.tab === t.id && st.media.playing)) ? '<button class="snd" title="Couper le son de l’onglet (Alt+M)">' + ICON_NOTE + '</button>' : '';
      el.innerHTML = icon + (t.pinned ? '' : '<span class="title"></span>' + playing + '<button class="close" title="Fermer (Ctrl+W)">' + ICON_CLOSE + '</button>');
      if (!t.pinned) el.querySelector('.title').textContent = t.title;
      const img = el.querySelector('img.fav');
      if (img && t.url) img.onerror = () => { if (!img.dataset.fb) { img.dataset.fb = 1; img.src = C.favicon(t.url); } };
      el.addEventListener('pointerdown', (e) => { hidePreview(); onTabDown(e, t, el); });
      el.addEventListener('auxclick', (e) => { if (e.button === 1 && !t.pinned) { e.preventDefault(); C.invoke('close_tab', { id: t.id }); } });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); hidePreview(); C.invoke('tab_menu', { id: t.id, x: el.getBoundingClientRect().left }); });
      // aperçu au survol (sans gêner le glisser-déposer)
      el.addEventListener('mouseenter', () => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (drag) return;
          previewOpen = true;
          C.invoke('tab_preview', { id: t.id, x: el.getBoundingClientRect().left });
        }, previewOpen ? 120 : 650);
      });
      el.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimer);
        // petit délai : passer d'un onglet à l'autre garde l'aperçu ouvert
        hoverTimer = setTimeout(() => { if (previewOpen) { previewOpen = false; C.invoke('preview_close'); } }, 180);
      });
      const snd = el.querySelector('.snd');
      if (snd) {
        snd.addEventListener('pointerdown', (e) => e.stopPropagation());
        snd.addEventListener('click', (e) => { e.stopPropagation(); C.invoke('tab_mute', { id: t.id }); });
      }
      const close = el.querySelector('.close');
      if (close) close.addEventListener('click', (e) => { e.stopPropagation(); C.invoke('close_tab', { id: t.id }); });
      frag.appendChild(el);
    }
    tabsEl.replaceChildren(frag);
  }
  tabsEl.addEventListener('mouseleave', hidePreview);

  // ------------------------------------------------------------- glisser-déposer
  // Glisser un onglet horizontalement le déplace parmi les autres ;
  // le glisser nettement hors de la barre l'ouvre dans une nouvelle fenêtre.
  const DETACH_DISTANCE = 45;

  function onTabDown(e, t, el) {
    if (e.button !== 0 || e.target.closest('.close')) return;
    // activation sans donner le focus à la page : sinon Windows interrompt le suivi de la souris
    if (t.id !== st.active) C.invoke('activate_tab', { id: t.id, focus: false });
    const els = [...tabsEl.querySelectorAll('.tab')];
    const rects = els.map((x) => x.getBoundingClientRect());
    const from = els.indexOf(el);
    // pas entre deux onglets (largeur + espacement)
    const step = rects.length > 1 ? rects[1].left - rects[0].left : rects[0].width + 6;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { id: t.id, el, els, rects, step, started: false, startX: e.clientX, startY: e.clientY, from, to: from, pointerId: e.pointerId };
  }

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.started) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.started = true;
      drag.el.classList.add('dragging');
      drag.els.forEach((x) => { if (x !== drag.el) x.classList.add('shifting'); });
    }

    const strip = $('tabstrip').getBoundingClientRect();
    const outside = e.clientY < strip.top - DETACH_DISTANCE || e.clientY > strip.bottom + DETACH_DISTANCE ||
                    e.clientX < -DETACH_DISTANCE || e.clientX > window.innerWidth + DETACH_DISTANCE;
    // l'onglet quitte la barre (ou c'est le seul onglet) : la fenêtre suit la souris,
    // gérée par Corrtex tant que le bouton reste enfoncé
    if (outside || st.tabs.length === 1) {
      const d = drag;
      const grabX = d.startX - d.rects[d.from].left;
      cancelDrag();
      C.invoke('drag_detach', { id: d.id, grabX });
      return;
    }

    // position de l'onglet tiré, limitée à la zone des onglets
    const r0 = drag.rects[drag.from];
    const first = drag.rects[0], last = drag.rects[drag.rects.length - 1];
    const clamped = Math.max(first.left - r0.left, Math.min(last.right - r0.right, dx));
    drag.el.style.transform = 'translateX(' + clamped + 'px)';

    // nouvelle place : l'échange se fait dès que le bord de l'onglet tiré atteint
    // le milieu du voisin (vers la droite : bord droit ; vers la gauche : bord gauche)
    const leftEdge = r0.left + clamped, rightEdge = r0.right + clamped;
    let to = drag.from;
    for (let i = drag.from + 1; i < drag.rects.length; i++) {
      const r = drag.rects[i];
      if (rightEdge > r.left + r.width / 2) to = i;
    }
    for (let i = drag.from - 1; i >= 0; i--) {
      const r = drag.rects[i];
      if (leftEdge < r.left + r.width / 2) to = i;
    }
    drag.to = to;

    const w = drag.step;
    drag.els.forEach((x, i) => {
      if (x === drag.el) return;
      let shift = 0;
      if (drag.from < drag.to && i > drag.from && i <= drag.to) shift = -w;
      if (drag.from > drag.to && i >= drag.to && i < drag.from) shift = w;
      x.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
    });
  });

  function cancelDrag() {
    if (!drag) return;
    try { drag.el.releasePointerCapture(drag.pointerId); } catch (err) {}
    drag.els.forEach((x) => { x.style.transform = ''; x.classList.remove('shifting', 'dragging', 'detaching'); });
    drag = null;
    pendingRender = false;
    renderTabs();
  }

  function endDrag(e, cancelled) {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    const d = drag;
    if (!d.started) {
      // simple clic : la page de l'onglet reçoit maintenant le focus
      drag = null;
      try { d.el.releasePointerCapture(d.pointerId); } catch (err) {}
      C.invoke('activate_tab', { id: d.id, focus: true });
      if (pendingRender) { pendingRender = false; renderTabs(); }
      return;
    }
    try { d.el.releasePointerCapture(d.pointerId); } catch (err) {}

    const to = cancelled ? d.from : d.to;
    // 1) l'onglet glisse jusqu'à sa place (les autres sont déjà décalés)
    let target = 0;
    target = (to - d.from) * d.step;
    d.el.classList.remove('dragging');
    d.el.classList.add('settling');
    d.el.style.transform = target ? 'translateX(' + target + 'px)' : '';
    if (cancelled) d.els.forEach((x) => { if (x !== d.el) x.style.transform = ''; });

    // 2) puis on range réellement les éléments, sans animation, et on valide l'ordre
    setTimeout(() => {
      d.els.forEach((x) => { x.classList.add('no-anim'); x.classList.remove('shifting', 'settling'); x.style.transform = ''; });
      if (to !== d.from) {
        // place dans la liste complète (les onglets d'un groupe replié ne sont pas affichés)
        const visible = d.els.filter((x) => x !== d.el).map((x) => +x.dataset.id);
        const rest = st.tabs.filter((x) => x.id !== d.id).map((x) => x.id);
        const index = to === 0 ? rest.indexOf(visible[0]) : rest.indexOf(visible[to - 1]) + 1;
        const ref = d.els.filter((x) => x !== d.el)[to] || null;
        tabsEl.insertBefore(d.el, ref);
        C.invoke('move_tab', { id: d.id, index: Math.max(0, index) });
      }
      void tabsEl.offsetWidth; // applique la position sans transition
      d.els.forEach((x) => x.classList.remove('no-anim'));
      drag = null;
      if (pendingRender) { pendingRender = false; renderTabs(); }
    }, 170);
  }
  window.addEventListener('pointerup', (e) => endDrag(e, false));
  window.addEventListener('pointercancel', (e) => endDrag(e, true));

  // ------------------------------------------------------------- barre d'outils
  function renderToolbar() {
    const t = activeTab();
    $('reload').classList.toggle('loading', !!(t && t.loading && t.url));
    if (!editing) address.value = t ? t.url : '';
    const icon = $('omni-icon');
    if (t && t.url && /^https:/.test(t.url)) {
      icon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>';
      icon.title = 'Connexion sécurisée';
    } else {
      icon.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
      icon.title = '';
    }
    const isBm = t && t.url && bmHas(t.url);
    $('star').classList.toggle('on', !!isBm);
    $('star').title = isBm ? 'Retirer des favoris' : 'Ajouter aux favoris';
    $('star').style.visibility = t && t.url ? 'visible' : 'hidden';
    $('ai-toggle').classList.toggle('on', !!st.sidebar_open);
    // fenêtre de navigation privée
    document.body.classList.toggle('private', !!st.private);
    $('private-badge').hidden = !st.private;
    // zoom mémorisé du site, mode lecture, téléchargements
    const z = t && t.url ? (t.zoom || 1) : 1;
    $('zoom-badge').hidden = Math.abs(z - 1) < 0.01;
    $('zoom-badge').textContent = Math.round(z * 100) + ' %';
    $('reader').hidden = !(t && t.url && !t.asleep);
    $('note-btn').hidden = !(t && t.url);
    $('note-btn').classList.toggle('on', !!st.note);
    $('note-btn').title = st.note ? 'Notes de ce site (une note existe)' : 'Notes de ce site';
    $('split-exit').hidden = !st.split;
    // mode concentration : barre réduite (ni onglets ni favoris) et minuteur
    const focus = st.focus_left != null;
    document.body.classList.toggle('focus', focus);
    if (focus) $('toolbar').setAttribute('data-tauri-drag-region', ''); else $('toolbar').removeAttribute('data-tauri-drag-region');
    $('focus-badge').hidden = !focus;
    if (focus && !focusArmed) $('focus-badge').querySelector('span').textContent = Math.max(1, Math.ceil(st.focus_left / 60)) + ' min';
    // profil de la fenêtre
    const pb = $('profile-badge');
    pb.hidden = !st.profile;
    if (st.profile) { pb.style.setProperty('--pc', st.profile.color); pb.querySelector('span').textContent = st.profile.name; pb.title = 'Profil : ' + st.profile.name + ' (connexions et cookies séparés)'; }
    document.body.classList.toggle('saver', !!st.power_saver);
    // traduction proposée sur les pages qui ne sont pas en français
    const foreign = t && t.url && !t.asleep && t.lang && !/^fr\b/i.test(t.lang) && !/(^|\.)google\./.test(C.hostOf(t.url));
    $('translate').hidden = !(foreign || (t && t.translated));
    $('translate').classList.toggle('on', !!(t && t.translated));
    $('translate').title = t && t.translated ? 'Afficher la page d’origine' : 'Traduire la page en français';
    const dl = st.downloads || [0, 0];
    $('dl-toggle').hidden = !dl[1];
    $('dl-toggle').classList.toggle('busy', dl[0] > 0);
    // bouton Extensions : dans la barre d'outils dès qu'on n'est plus sur la page d'accueil
    const onHome = !t || !t.url;
    document.body.classList.toggle('home', onHome);
    $('ext-toggle').hidden = onHome;
    $('tools-toggle').hidden = onHome;
    if (onHome && extPanelOpen) C.invoke('close_panel');
    $('win-max').innerHTML = st.maximized
      ? '<svg viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" rx="1"/><path d="M3.5 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/></svg>'
      : '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>';
    $('win-max').title = st.maximized ? 'Restaurer' : 'Agrandir';
  }

  // ------------------------------------------------------------- favoris
  function bookmarks() { return C.load('bookmarks', C.defaultBookmarks); }

  function renderBookmarks() {
    const list = bookmarks();
    const bar = $('bookmarks');
    bar.replaceChildren();
    if (!list.length) {
      const e = document.createElement('span');
      e.className = 'bm-empty';
      e.textContent = 'Cliquez sur l’étoile de la barre d’adresse pour ajouter un favori.';
      bar.appendChild(e);
      return;
    }
    for (const b of list) {
      if (b.folder) { bar.appendChild(folderEl(b)); continue; }
      const el = document.createElement('button');
      el.className = 'bm';
      el.title = b.url + '\nClic droit : modifier · glisser pour déplacer';
      el.dataset.url = b.url;
      el.dataset.key = b.url;
      el.innerHTML = '<img alt="" src="' + escAttr(C.favicon(b.url)) + '"><span></span>';
      el.querySelector('span').textContent = b.title;
      el.addEventListener('click', (e) => {
        if (bmDragged) { bmDragged = false; return; }
        if (e.ctrlKey) C.invoke('new_tab', { url: b.url });
        else C.invoke('navigate', { url: b.url });
      });
      el.addEventListener('pointerdown', (e) => bmPointerDown(e, el));
      el.addEventListener('auxclick', (e) => { if (e.button === 1) C.invoke('new_tab', { url: b.url }); });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        C.invoke('bookmark_menu', { url: b.url, x: r.left, y: r.bottom + 2 });
      });
      bar.appendChild(el);
    }
  }

  // dossier de favoris : ses favoris s'affichent dans une petite fenêtre
  function folderEl(f) {
    const el = document.createElement('button');
    el.className = 'bm folder';
    el.dataset.key = f.id;
    el.title = (f.children || []).length + ' favori(s) · clic droit : renommer ou supprimer';
    el.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg><span></span><svg class="chev" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>';
    el.querySelector('span').textContent = f.title || 'Dossier';
    const open = (e) => {
      if (e) e.preventDefault();
      if (bmDragged) { bmDragged = false; return; }
      const r = el.getBoundingClientRect();
      C.invoke('popup_show', { kind: 'bmfolder', data: { id: f.id }, x: r.left, y: r.bottom + 2 });
    };
    el.addEventListener('click', open);
    el.addEventListener('contextmenu', open);
    el.addEventListener('pointerdown', (e) => bmPointerDown(e, el));
    return el;
  }
  function bmHas(url) { return bookmarks().some((b) => b.url === url || (b.folder && (b.children || []).some((c) => c.url === url))); }

  // glisser-déposer : un favori échange sa place quand il atteint la moitié du voisin
  let bmDragged = false;
  function bmPointerDown(e, el) {
    if (e.button !== 0) return;
    const bar = $('bookmarks');
    const x0 = e.clientX;
    let dragging = false;
    const startLeft = el.offsetLeft;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      if (!dragging) {
        if (Math.abs(dx) < 5) return;
        dragging = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
      }
      // position voulue = position de départ + déplacement du pointeur
      const want = startLeft + dx;
      const next = el.nextElementSibling, prev = el.previousElementSibling;
      if (next && next.classList.contains('bm') && want + el.offsetWidth > next.offsetLeft + next.offsetWidth / 2) bar.insertBefore(next, el);
      else if (prev && prev.classList.contains('bm') && want < prev.offsetLeft + prev.offsetWidth / 2) bar.insertBefore(el, prev);
      el.style.transform = 'translateX(' + (want - el.offsetLeft) + 'px)';
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      bmDragged = true;
      setTimeout(() => { bmDragged = false; }, 0);
      el.classList.remove('dragging');
      el.style.transform = '';
      const order = [...bar.querySelectorAll('.bm')].map((x) => x.dataset.key);
      const all = bookmarks();
      const key = (x) => x.folder ? x.id : x.url;
      all.sort((a, b2) => order.indexOf(key(a)) - order.indexOf(key(b2)));
      C.save('bookmarks', all);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  $('star').addEventListener('click', () => {
    const t = activeTab();
    if (!t || !t.url) return;
    let list = bookmarks();
    if (bmHas(t.url)) {
      list = list.filter((b) => b.url !== t.url);
      list.forEach((b) => { if (b.folder) b.children = (b.children || []).filter((c) => c.url !== t.url); });
    } else list.push({ title: (t.title || C.hostOf(t.url)).slice(0, 40), url: t.url });
    C.save('bookmarks', list);
    renderBookmarks(); renderToolbar();
  });

  window.addEventListener('storage', (e) => { if (e.key === 'corrtex.bookmarks') { renderBookmarks(); renderToolbar(); } });

  // ------------------------------------------------------------- barre d'adresse + suggestions Google
  let sugg = { items: [], selected: -1, query: '', typed: '' };
  let suggTimer = 0, suggSeq = 0;
  // historique : complétion écrite dans la barre (« hel » → « hel|lcase.com ») et sites déjà visités
  let hist = { inline: null, items: [], typed: '' };
  let lastGoogle = [];

  function looksLikeUrl(text) { const u = C.toUrl(text); return u && !u.startsWith('https://www.google.com/search?q='); }
  const bare = (u) => (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

  function pushSuggestions() {
    const r = $('omnibox').getBoundingClientRect();
    $('omnibox').classList.toggle('suggesting', sugg.items.length > 0);
    C.invoke('suggest_update', { data: { x: r.left, width: r.width, items: sugg.items, selected: sugg.selected, query: sugg.typed } });
  }

  function closeSuggestions() {
    clearTimeout(suggTimer);
    suggSeq++;
    if (sugg.items.length) C.invoke('suggest_close');
    sugg = { items: [], selected: -1, query: '', typed: '' };
    hist = { inline: null, items: [], typed: '' };
    lastGoogle = [];
    $('omnibox').classList.remove('suggesting');
  }

  // liste : site complété, autres sites de l'historique, puis recherches Google
  function buildItems(typed) {
    const q = typed.trim();
    const items = [];
    const seen = new Set();
    if (hist.inline) {
      items.push({ type: 'history', text: hist.inline.text, url: hist.inline.url, title: hist.inline.title || hist.inline.text, top: true });
      seen.add(bare(hist.inline.url));
    } else if (looksLikeUrl(q)) {
      items.push({ type: 'url', text: q, url: C.toUrl(q) });
    }
    for (const h of hist.items) {
      if (seen.has(bare(h.url))) continue;
      seen.add(bare(h.url));
      items.push({ type: 'history', text: bare(h.url), url: h.url, title: h.title || bare(h.url) });
    }
    lastGoogle.filter((r) => r.toLowerCase() !== q.toLowerCase() || !items.length).forEach((r) => items.push({ type: 'search', text: r }));
    if (!items.length || !items.some((i) => i.type === 'search')) items.push({ type: 'search', text: q });
    return items.slice(0, 9);
  }

  function refreshList(typed) {
    // si l'utilisateur a déjà choisi une ligne au clavier, on la garde
    const prev = sugg.selected >= 0 && sugg.typed === typed ? sugg.items[sugg.selected] : null;
    const items = buildItems(typed);
    const sel = prev ? items.findIndex((i) => i.type === prev.type && i.text === prev.text) : -1;
    sugg = { items, selected: sel, query: typed.trim(), typed };
    pushSuggestions();
  }

  function requestSuggestions(deleting) {
    const typed = address.value;
    const q = typed.trim();
    clearTimeout(suggTimer);
    if (!q) { closeSuggestions(); return; }
    const seq = ++suggSeq;
    // historique : tout de suite, pour compléter pendant la frappe
    C.invoke('history_complete', { query: q }).then((r) => {
      if (seq !== suggSeq || !editing || address.value !== typed) return;
      hist = { inline: null, items: (r && r.items) || [], typed };
      const inl = r && r.inline;
      // on ne complète que si le texte tapé est bien le début de l'adresse, et pas pendant un effacement
      if (inl && !deleting && !/\s/.test(typed) && bare(inl.text).startsWith(bare(typed)) && document.activeElement === address) {
        hist.inline = inl;
        const rest = inl.text.slice(bare(typed).length);
        if (rest) {
          address.value = typed + rest;
          address.setSelectionRange(typed.length, address.value.length);
        }
      } else if (inl && bare(inl.text) === bare(typed)) {
        hist.inline = inl;
      }
      refreshList(typed);
    });
    // recherches Google : un peu après
    suggTimer = setTimeout(async () => {
      const results = await C.invoke('suggest', { query: q }) || [];
      if (seq !== suggSeq || !editing) return;
      lastGoogle = results;
      refreshList(typed);
    }, 110);
  }

  function go(text) {
    const url = C.toUrl(text);
    if (!url) return;
    goUrl(url);
  }
  function goUrl(url) {
    closeSuggestions();
    editing = false;
    address.blur();
    C.invoke('navigate', { url });
  }

  address.addEventListener('focus', () => { editing = true; setTimeout(() => address.select(), 0); });
  address.addEventListener('blur', () => {
    editing = false;
    // petit délai : un clic dans la liste doit pouvoir être pris en compte
    setTimeout(() => { if (!editing) { closeSuggestions(); renderToolbar(); } }, 180);
  });
  address.addEventListener('input', (e) => {
    editing = true;
    requestSuggestions(/^delete/.test(e.inputType || ''));
  });
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (hist.inline && address.selectionStart !== address.selectionEnd && address.selectionEnd === address.value.length) {
        // premier Échap : on retire juste la complétion
        address.value = address.value.slice(0, address.selectionStart);
        hist.inline = null;
        refreshList(address.value);
      } else if (sugg.items.length) { address.value = sugg.typed; closeSuggestions(); }
      else { editing = false; renderToolbar(); address.select(); }
      e.preventDefault();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugg.items.length) {
      e.preventDefault();
      const n = sugg.items.length;
      sugg.selected = e.key === 'ArrowDown' ? (sugg.selected + 1 >= n ? -1 : sugg.selected + 1) : (sugg.selected - 1 < -1 ? n - 1 : sugg.selected - 1);
      address.value = sugg.selected >= 0 ? sugg.items[sugg.selected].text : sugg.typed;
      pushSuggestions();
    }
  });
  $('omnibox').addEventListener('submit', (e) => {
    e.preventDefault();
    const it = sugg.selected >= 0 ? sugg.items[sugg.selected] : null;
    if (it && (it.type === 'url' || it.type === 'history')) return goUrl(it.url);
    if (it) return go(it.text);
    // Entrée sur la complétion de l'historique : on ouvre ce site
    if (hist.inline && bare(address.value) === bare(hist.inline.text)) return goUrl(hist.inline.url);
    go(address.value);
  });

  // ------------------------------------------------------------- boutons
  $('newtab').addEventListener('click', () => C.invoke('new_tab', {}));
  $('back').addEventListener('click', () => C.invoke('go_back'));
  $('forward').addEventListener('click', () => C.invoke('go_forward'));
  $('reload').addEventListener('click', () => C.invoke('reload'));
  $('ai-toggle').addEventListener('click', () => C.invoke('toggle_sidebar'));
  let extPanelOpen = false;
  $('ext-toggle').addEventListener('click', () => C.invoke('toggle_ext_panel'));
  C.listen('ext-panel', (p) => {
    if (!p || p.win !== C.win()) return;
    const view = p.view || 'extensions';
    extPanelOpen = p.open;
    $('ext-toggle').classList.toggle('on', p.open && view === 'extensions');
    $('tools-toggle').classList.toggle('on', p.open && view === 'tools');
  });
  $('tools-toggle').addEventListener('click', () => C.invoke('toggle_ext_panel', { view: 'tools' }));
  $('zoom-badge').addEventListener('click', () => C.invoke('zoom_active', { dir: 'reset' }));
  $('reader').addEventListener('click', () => C.invoke('reader_toggle'));
  $('note-btn').addEventListener('click', () => {
    const r = $('note-btn').getBoundingClientRect();
    C.invoke('popup_show', { kind: 'notes', x: Math.max(8, r.right - 360), y: r.bottom + 6 });
  });
  $('split-exit').addEventListener('click', () => C.invoke('split_close'));
  // arrêt du mode concentration en deux temps
  var focusArmed = false;
  $('focus-badge').addEventListener('click', () => {
    const s = $('focus-badge').querySelector('span');
    if (!focusArmed) { focusArmed = true; s.textContent = 'Arrêter ?'; setTimeout(() => { focusArmed = false; renderToolbar(); }, 3000); return; }
    focusArmed = false;
    C.invoke('focus_stop');
  });
  // batterie : économie d'énergie automatique
  if (navigator.getBattery) {
    navigator.getBattery().then((bat) => {
      const send = () => C.invoke('power_state', { onBattery: !bat.charging }).catch(() => {});
      bat.addEventListener('chargingchange', send);
      send();
    }).catch(() => {});
  }
  $('space-btn').addEventListener('click', () => {
    const r = $('space-btn').getBoundingClientRect();
    const counts = {};
    st.tabs.forEach((t) => { counts[t.space || 0] = (counts[t.space || 0] || 0) + 1; });
    C.invoke('popup_show', { kind: 'spaces', data: { spaces: st.spaces || [], space: st.space || 0, counts }, x: r.left, y: 40 });
  });
  $('translate').addEventListener('click', () => C.invoke('translate_page'));
  $('dl-toggle').addEventListener('click', () => C.invoke('open_library', { section: 'downloads' }));
  $('win-min').addEventListener('click', () => C.invoke('win_minimize'));
  $('win-max').addEventListener('click', () => C.invoke('win_toggle_maximize'));
  $('win-close').addEventListener('click', () => C.invoke('win_close'));

  // Raccourcis quand la barre du navigateur a le focus
  // raccourcis personnalisables (réglages) : touches → action
  let KEYMAP = {};
  C.invoke('keys_get').then((r) => { if (r && r.map) KEYMAP = r.map; }).catch(() => {});
  C.listen('keys-changed', (m) => { if (m && typeof m === 'object') KEYMAP = m; });
  function comboOf(e) {
    const k = e.key;
    if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(k)) return '';
    let name = k.length === 1 ? k.toUpperCase() : k;
    if (name === ' ') name = 'Space';
    const p = [];
    if (e.ctrlKey) p.push('Ctrl');
    if (e.altKey) p.push('Alt');
    if (e.shiftKey) p.push('Shift');
    p.push(name);
    return p.join('+');
  }
  C.listen('open-notes', (w) => { if (w === C.win()) $('note-btn').click(); });
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    const act = KEYMAP[comboOf(e)];
    // pendant la frappe dans la barre d'adresse, seules les combinaisons avec Ctrl/Alt comptent
    if (act && (e.ctrlKey || e.altKey || /^F\d+$/.test(e.key))) {
      e.preventDefault();
      if (act === 'address') address.focus();
      else if (act === 'notes') $('note-btn').click();
      else C.invoke('run_action_cmd', { action: act });
      return;
    }
    if (e.ctrlKey && (k === '+' || k === '=')) { e.preventDefault(); C.invoke('zoom_active', { dir: 'in' }); }
    else if (e.ctrlKey && k === '-') { e.preventDefault(); C.invoke('zoom_active', { dir: 'out' }); }
    else if (e.ctrlKey && k === '0') { e.preventDefault(); C.invoke('zoom_active', { dir: 'reset' }); }
    else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const list = spaceTabs();
      const i = list.findIndex((t) => t.id === st.active);
      const n = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      if (n) C.invoke('activate_tab', { id: n.id });
    }
    else if (e.key === 'F5' || (e.ctrlKey && k === 'r')) { e.preventDefault(); C.invoke('reload'); }
    else if (e.altKey && e.key === 'ArrowLeft') C.invoke('go_back');
    else if (e.altKey && e.key === 'ArrowRight') C.invoke('go_forward');
    else if (e.key === 'Escape' && drag) endDrag({ pointerId: drag.pointerId }, true);
  });

  document.addEventListener('contextmenu', (e) => { if (e.target !== address) e.preventDefault(); });

  // ------------------------------------------------------------- état
  function setBmOffset(off) { $('bm-wrap').style.setProperty('--off', off || 0); }

  // couleurs de la lumière d'ambiance (lueur derrière la barre de favoris)
  function applyLight() {
    const hex = C.prefs().light || '#ff4f7b';
    const r = document.documentElement.style;
    r.setProperty('--l1', hex);
    r.setProperty('--l2', 'color-mix(in srgb, ' + hex + ' 60%, #ffb347)');
  }
  window.addEventListener('corrtex-prefs', () => { applyLight(); C.sendTheme(); });
  applyLight();
  C.sendTheme();

  C.listen('bm-offset', (p) => { if (p && p.win === C.win()) setBmOffset(p.off); });

  let lastTabsKey = '';
  function apply(s) {
    if (!s || (s.win && s.win !== C.win())) return; // état d'une autre fenêtre
    setBmOffset(s.bm_off);
    st = s;
    // la barre d'onglets n'est redessinée que si ce qu'elle affiche a changé
    const key = JSON.stringify([s.active, s.space, s.split, s.groups, s.spaces, s.media && s.media.tab, s.media && s.media.playing,
      (s.tabs || []).map((t) => [t.id, t.title, t.url, t.favicon, t.loading, t.pinned, t.group, t.asleep, t.space, t.audible, t.muted])]);
    if (key !== lastTabsKey) { lastTabsKey = key; renderTabs(); }
    renderToolbar();
    // flèches grisées quand il n'y a pas de page précédente / suivante
    const t = activeTab();
    $('back').disabled = !(t && t.can_back);
    $('forward').disabled = !(t && t.can_fwd);
  }

  C.listen('browser-state', apply);
  C.listen('focus-omnibox', (w) => { if (!w || w === C.win()) address.focus(); });
  // redimensionnement : un seul redessin par image
  let resizeRaf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(renderTabs); });
  C.invoke('get_state').then(apply);
  renderBookmarks();
  // ---------------------------------------------------------------- nouvelle version de Corrtex
  (function () {
    const pill = $('update-pill'), label = pill.querySelector('span');
    let version = null;
    const show = (v) => {
      version = v || null;
      pill.hidden = !version;
      if (version && !pill.classList.contains('busy')) { label.textContent = 'Mettre à jour'; pill.title = 'Corrtex ' + version + ' est disponible : installer et redémarrer'; }
    };
    C.invoke('update_status').then(show).catch(() => {});
    C.listen('update-status', (p) => show(p && p.version));
    C.listen('update-progress', (d) => {
      const p = d || {};
      if (p.error) { pill.classList.remove('busy'); label.textContent = 'Réessayer'; pill.title = 'La mise à jour a échoué : ' + p.error; return; }
      pill.hidden = false;
      pill.classList.add('busy');
      label.textContent = p.pct >= 100 ? 'Installation…' : 'Téléchargement ' + p.pct + ' %';
    });
    pill.addEventListener('click', () => {
      if (!version) return;
      pill.classList.add('busy');
      label.textContent = 'Téléchargement…';
      C.invoke('update_install').catch(() => {});
    });
  })();
})();
