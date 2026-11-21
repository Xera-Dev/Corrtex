// Page d'accueil Corrtex : recherche Google, compte Google, paramètres, widget musique.
(function () {
  const C = window.Corrtex;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- recherche
  // Suggestions Google sous la barre de recherche (4 au maximum)
  const SG_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
  let sg = { items: [], sel: -1, typed: '' };
  let sgTimer = 0, sgSeq = 0;

  function renderSugg() {
    const box = $('sugg');
    box.replaceChildren();
    box.hidden = !sg.items.length;
    $('search').classList.toggle('open', sg.items.length > 0);
    const q = sg.typed.toLowerCase();
    sg.items.forEach((text, i) => {
      const el = document.createElement('div');
      el.className = 'sg' + (i === sg.sel ? ' sel' : '');
      el.innerHTML = SG_ICON + '<span></span>';
      const span = el.querySelector('span');
      if (q && text.toLowerCase().startsWith(q)) {
        span.append(document.createTextNode(text.slice(0, q.length)));
        const b = document.createElement('b'); b.textContent = text.slice(q.length); span.append(b);
      } else { const b = document.createElement('b'); b.textContent = text; span.append(b); }
      el.addEventListener('mousedown', (e) => { e.preventDefault(); const u = C.toUrl(text); C.prefetchSearch(u); location.href = u; });
      box.appendChild(el);
    });
  }
  function hideSugg() { sgSeq++; clearTimeout(sgTimer); sg = { items: [], sel: -1, typed: '' }; renderSugg(); }

  $('q').addEventListener('input', () => {
    const typed = $('q').value.trim();
    clearTimeout(sgTimer);
    if (!typed) { hideSugg(); return; }
    const seq = ++sgSeq;
    sgTimer = setTimeout(async () => {
      const res = (await C.invoke('suggest', { query: typed })) || [];
      if (seq !== sgSeq) return;
      sg = { items: res.slice(0, 4), sel: -1, typed };
      renderSugg();
    }, 110);
  });
  $('q').addEventListener('keydown', (e) => {
    if (!sg.items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = sg.items.length;
      sg.sel = e.key === 'ArrowDown' ? (sg.sel + 1 >= n ? -1 : sg.sel + 1) : (sg.sel - 1 < -1 ? n - 1 : sg.sel - 1);
      $('q').value = sg.sel >= 0 ? sg.items[sg.sel] : sg.typed;
      renderSugg();
    } else if (e.key === 'Escape') { $('q').value = sg.typed; hideSugg(); }
  });
  $('q').addEventListener('blur', () => setTimeout(hideSugg, 150));

  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = C.toUrl($('q').value);
    if (url) { C.prefetchSearch(url); location.href = url; }
  });
  setTimeout(() => $('q').focus(), 50);
  // connexions vers les moteurs ouvertes à l'avance : la première recherche part plus vite
  if (C.engine() === 'corrtex') C.invoke('search_warm');

  // Recherche vocale (si le moteur la prend en charge)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $('mic').style.display = 'none';
  else {
    let rec = null;
    $('mic').addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = 'fr-FR';
      rec.interimResults = true;
      rec.onresult = (ev) => {
        const r = ev.results[ev.results.length - 1];
        $('q').value = r[0].transcript;
        if (r.isFinal) $('search').requestSubmit();
      };
      rec.onerror = () => { $('mic').title = 'Recherche vocale indisponible'; };
      rec.onend = () => { rec = null; $('mic').classList.remove('listening'); };
      $('mic').classList.add('listening');
      try { rec.start(); } catch (e) { rec = null; $('mic').classList.remove('listening'); }
    });
  }

  // ------------------------------------------------------------- widget musique
  const player = $('player');
  function renderMedia(m) {
    player.classList.remove('idle', 'playing', 'paused', 'noart');
    // le lecteur n'apparaît que lorsqu'une piste est en cours dans un onglet
    document.body.classList.toggle('has-player', !!m);
    player.setAttribute('aria-hidden', m ? 'false' : 'true');
    if (!m) {
      player.classList.add('idle', 'noart');
      $('m-title').textContent = 'Aucune lecture';
      $('m-artist').textContent = 'Lancez une musique dans un onglet';
      $('m-progress').style.width = '0';
      player.querySelector('.player-bg').style.backgroundImage = '';
      return;
    }
    player.classList.add(m.playing ? 'playing' : 'paused');
    $('m-title').textContent = m.title || 'Lecture en cours';
    $('m-artist').textContent = m.artist || '';
    $('m-progress').style.width = Math.max(0, Math.min(1, m.progress || 0)) * 100 + '%';
    const img = $('art-img');
    if (m.artwork) {
      if (img.getAttribute('src') !== m.artwork) img.src = m.artwork;
      img.onerror = () => player.classList.add('noart');
      player.querySelector('.player-bg').style.backgroundImage = 'url("' + m.artwork.replace(/"/g, '%22') + '")';
    } else {
      player.classList.add('noart');
      player.querySelector('.player-bg').style.backgroundImage = '';
    }
  }

  $('toggle').addEventListener('click', () => C.invoke('media_control', { action: 'toggle' }));
  $('prev').addEventListener('click', () => C.invoke('media_control', { action: 'prev' }));
  $('next').addEventListener('click', () => C.invoke('media_control', { action: 'next' }));
  $('art').addEventListener('click', () => C.invoke('focus_media_tab'));


  // ------------------------------------------------------------- lumière d'ambiance
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  const hsl = (h, s, l) => 'hsl(' + ((h % 360) + 360) % 360 + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%)';

  function applyLight() {
    const p = C.prefs();
    const [h, s, l] = hexToHsl(/^#[0-9a-f]{6}$/i.test(p.light) ? p.light : '#ff4f7b');
    const root = document.documentElement.style;
    // une couleur principale + deux voisines pour un halo vivant, comme sur Apple Music
    root.setProperty('--l1', hsl(h, s, l));
    root.setProperty('--l2', hsl(h + 38, s, Math.min(.7, l + .05)));
    root.setProperty('--l3', hsl(h - 42, s * .9, Math.max(.35, l - .05)));
    root.setProperty('--intensity', p.lightIntensity);
    document.body.classList.toggle('light-off', !p.lightOn);
  }
  // pas d'animation quand l'onglet n'est pas visible (économie de ressources)
  document.addEventListener('visibilitychange', () => document.body.classList.toggle('paused', document.hidden));

  // ------------------------------------------------------------- paramètres
  const settings = $('settings');
  let providers = [];
  let aiProvider = '';
  let aiMemory = true;
  let restoreSession = true;
  let sleepMin = 30;
  let saveHistory = true;

  // Panneaux latéraux (paramètres, compte Google, extensions) : un seul ouvert à la fois
  let openDrawer = null;
  function showDrawer(id) {
    if (openDrawer && openDrawer.id === id) { closeDrawers(); return; }
    closeDrawers();
    const d = $(id);
    if (id === 'settings') renderSettings();
    if (id === 'extensions') loadExtensions();
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    $('settings-scrim').hidden = false;
    openDrawer = d;
  }
  function closeDrawers() {
    document.querySelectorAll('.drawer.open').forEach((d) => { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); });
    $('settings-scrim').hidden = true;
    openDrawer = null;
  }
  $('open-settings').addEventListener('click', () => showDrawer('settings'));
  $('open-tools').addEventListener('click', () => showDrawer('tools'));

  // ---------------------------------------------------------------- outils (panneau partagé, voir tools-ui.js)
  const tools = window.CorrtexTools.mount($('tools-body'), closeDrawers);
  new MutationObserver(() => { if ($('tools').classList.contains('open')) tools.start(); else tools.stop(); })
    .observe($('tools'), { attributes: true, attributeFilter: ['class'] });
  $('open-extensions').addEventListener('click', () => showDrawer('extensions'));
  document.querySelectorAll('.drawer-close').forEach((b) => b.addEventListener('click', closeDrawers));
  $('settings-scrim').addEventListener('click', closeDrawers);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawers(); });

  function renderSettings() {
    const p = C.prefs();

    const ai = $('set-ai');
    ai.replaceChildren();
    for (const pr of providers) {
      const b = document.createElement('button');
      b.className = 'chip' + (pr.id === aiProvider ? ' sel' : '');
      b.textContent = pr.name;
      b.onclick = () => { aiProvider = pr.id; C.invoke('set_ai_provider', { id: pr.id }); renderSettings(); };
      ai.appendChild(b);
    }
    $('set-memory').checked = aiMemory;
    $('set-restore').checked = restoreSession;
    $('set-history').checked = saveHistory;
    const sl = $('set-sleep');
    sl.replaceChildren();
    for (const [m, label] of [[15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [0, 'Jamais']]) {
      const b = document.createElement('button');
      b.className = 'chip' + (m === sleepMin ? ' sel' : '');
      b.textContent = label;
      b.onclick = () => { sleepMin = m; C.invoke('set_tab_prefs', { sleepMin: m }); renderSettings(); };
      sl.appendChild(b);
    }

    const th = $('set-theme');
    th.replaceChildren();
    for (const t of C.themes) {
      const b = document.createElement('button');
      b.className = 'theme' + (t.id === p.theme ? ' sel' : '');
      b.innerHTML = '<div class="pv"><div></div><div></div></div><span></span>';
      b.querySelector('.pv').children[0].style.background = t.preview[0];
      b.querySelector('.pv').children[1].style.background = t.preview[1];
      b.querySelector('span').textContent = t.name;
      b.onclick = () => { C.setPrefs({ theme: t.id }); renderSettings(); };
      th.appendChild(b);
    }

    $('set-light-on').checked = p.lightOn;
    $('set-google').checked = p.googleSkin !== false;
    const sw = $('set-light');
    sw.replaceChildren();
    const isPreset = C.lightColors.includes(p.light.toLowerCase());
    for (const c of C.lightColors) {
      const b = document.createElement('button');
      b.className = 'sw' + (c === p.light.toLowerCase() ? ' sel' : '');
      b.style.background = c;
      b.title = c;
      b.onclick = () => { C.setPrefs({ light: c }); renderSettings(); };
      sw.appendChild(b);
    }
    const custom = document.createElement('label');
    custom.className = 'sw custom' + (isPreset ? '' : ' sel');
    custom.title = 'Couleur personnalisée';
    custom.innerHTML = '<input type="color">';
    const input = custom.querySelector('input');
    input.value = p.light;
    input.addEventListener('input', () => C.setPrefs({ light: input.value }));
    input.addEventListener('change', renderSettings);
    sw.appendChild(custom);

    $('set-intensity').value = p.lightIntensity;
  }

  $('set-light-on').addEventListener('change', (e) => C.setPrefs({ lightOn: e.target.checked }));
  $('set-google').addEventListener('change', (e) => C.setPrefs({ googleSkin: e.target.checked }));
  // ---------------------------------------------------------------- sauvegarde
  const backupMsg = (text, bad) => {
    const m = $('backup-msg');
    m.textContent = text;
    m.style.display = text ? '' : 'none';
    m.style.color = bad ? '#ff8a9c' : '';
  };
  $('backup-export').addEventListener('click', async () => {
    const ui = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('corrtex.')) ui[k] = localStorage.getItem(k);
    }
    const path = await C.invoke('backup_export', { ui });
    if (path) backupMsg('Sauvegarde enregistrée : ' + path.split(/[\\/]/).pop() + ' (dossier Téléchargements)');
    else backupMsg('La sauvegarde n’a pas pu être enregistrée.', true);
  });
  $('backup-import').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { backupMsg('Ce fichier n’est pas une sauvegarde Corrtex.', true); return; }
    let ui;
    try { ui = await window.__TAURI__.core.invoke('backup_import', { data }); }
    catch (err) { backupMsg(String(err || 'Import impossible.'), true); return; }
    for (const [k, v] of Object.entries(ui || {})) {
      if (k.startsWith('corrtex.') && typeof v === 'string') { try { localStorage.setItem(k, v); } catch {} }
    }
    backupMsg('Sauvegarde importée. Certains réglages s’appliqueront au prochain démarrage.');
    setTimeout(() => location.reload(), 1400);
  });

  $('set-history').addEventListener('change', (e) => { saveHistory = e.target.checked; C.invoke('set_privacy', { saveHistory }); });
  // ---------------------------------------------------------------- gestes et raccourcis
  let keyCapture = null;
  async function renderKeys() {
    const r = await C.invoke('keys_get').catch(() => null);
    if (!r) return;
    $('set-gestures').checked = !!r.gestures;
    const box = $('set-keys');
    box.replaceChildren();
    for (const a of r.actions) {
      const row = document.createElement('div');
      row.className = 'row-link keyrow';
      const l = document.createElement('span');
      l.textContent = a.label;
      const k = document.createElement('button');
      k.className = 'kbd' + (a.keys !== a.default ? ' custom' : '');
      k.textContent = a.keys || 'Aucun';
      k.title = 'Cliquer puis taper la nouvelle combinaison (Échap : annuler, Retour arrière : aucun raccourci)';
      k.onclick = () => {
        if (keyCapture) keyCapture.el.classList.remove('wait');
        keyCapture = { id: a.id, el: k };
        k.classList.add('wait');
        k.textContent = 'Tapez…';
      };
      row.append(l, k);
      if (a.keys !== a.default) {
        const reset = document.createElement('button');
        reset.className = 'kreset';
        reset.title = 'Revenir à ' + a.default;
        reset.textContent = '↺';
        reset.onclick = async () => { await C.invoke('keys_set', { action: a.id, keys: null }); renderKeys(); };
        row.append(reset);
      }
      box.append(row);
    }
  }
  document.addEventListener('keydown', async (e) => {
    if (!keyCapture) return;
    e.preventDefault(); e.stopPropagation();
    const k = e.key;
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(k)) return;
    const cap = keyCapture;
    keyCapture = null;
    if (k === 'Escape') { renderKeys(); return; }
    let combo = '';
    if (k !== 'Backspace' && k !== 'Delete') {
      let name = k.length === 1 ? k.toUpperCase() : k;
      if (name === ' ') name = 'Space';
      const p = [];
      if (e.ctrlKey) p.push('Ctrl');
      if (e.altKey) p.push('Alt');
      if (e.shiftKey) p.push('Shift');
      // une touche seule ne gênerait la frappe : Ctrl ou Alt obligatoire (sauf F1…F12)
      if (!e.ctrlKey && !e.altKey && !/^F\d+$/.test(k)) { cap.el.textContent = 'Ajoutez Ctrl ou Alt'; setTimeout(renderKeys, 1200); return; }
      p.push(name);
      combo = p.join('+');
    }
    await C.invoke('keys_set', { action: cap.id, keys: combo || 'none' });
    renderKeys();
  }, true);
  $('set-gestures').addEventListener('change', (e) => C.invoke('set_gestures', { on: e.target.checked }));
  renderKeys();

  $('set-restore').addEventListener('change', (e) => { restoreSession = e.target.checked; C.invoke('set_tab_prefs', { restore: restoreSession }); });
  $('set-memory').addEventListener('change', (e) => { aiMemory = e.target.checked; C.invoke('set_ai_memory', { on: aiMemory }); });
  $('set-intensity').addEventListener('input', (e) => C.setPrefs({ lightIntensity: parseFloat(e.target.value) }));
  window.addEventListener('corrtex-prefs', applyLight);

  // ------------------------------------------------------------- compte Google
  const I = {
    google: '<svg viewBox="0 0 24 24"><path fill="#4285F4" stroke="none" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" stroke="none" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" stroke="none" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" stroke="none" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10C7.2 7.7 9.4 6 12 6z"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 2"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/><circle cx="16.5" cy="16.5" r="3.6" fill="var(--card-solid)"/><path d="M16.5 14.8v1.9l1.2.8"/></svg>',
    saved: '<svg viewBox="0 0 24 24"><path d="M7 3.5h10a1 1 0 0 1 1 1V20l-6-3.8L6 20V4.5a1 1 0 0 1 1-1z"/></svg>',
    profile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.5 18.5c1.3-2 3.2-3 5.5-3s4.2 1 5.5 3"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l2 7 7 2-7 2-2 7-2-7-7-2 7-2z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
    lang: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
    help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
    add: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 19c.9-3 3.4-4.5 6.5-4.5 1.2 0 2.3.2 3.2.7M18 14v6M15 17h6"/></svg>',
    logout: '<svg viewBox="0 0 24 24"><path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/></svg>'
  };

  // Les mêmes entrées que le menu du compte sur google.com, rangées comme les paramètres
  const GROUPS = [
    { title: 'Compte', items: [
      { icon: 'google', label: 'Gérer votre compte Google', url: 'https://myaccount.google.com/' },
      { icon: 'add', label: 'Ajouter un compte', url: 'https://accounts.google.com/AddSession?continue=https%3A%2F%2Fwww.google.com%2F' },
      { icon: 'logout', label: 'Se déconnecter', url: 'https://accounts.google.com/Logout?continue=https%3A%2F%2Fwww.google.com%2F' }] },
    { title: 'Activité', items: [
      { icon: 'history', label: 'Historique des recherches', url: 'https://myactivity.google.com/product/search' },
      { icon: 'trash', label: 'Supprimer les 30 dernières minutes', url: 'https://myactivity.google.com/product/search' },
      { icon: 'saved', label: 'Enregistrements et collections', url: 'https://www.google.com/save' },
      { icon: 'profile', label: 'Votre profil dans la Recherche', url: 'https://myaccount.google.com/profile' }] },
    { title: 'Recherche', items: [
      { icon: 'spark', label: 'Personnalisation de la recherche', url: 'https://goo.gle/personalization-settings' },
      { icon: 'shield', label: 'SafeSearch', url: 'https://www.google.com/safesearch' },
      { icon: 'lang', label: 'Langue', right: 'français', url: 'https://www.google.com/preferences#languages' },
      { icon: 'gear', label: 'Autres paramètres', url: 'https://www.google.com/preferences' },
      { icon: 'help', label: 'Aide', url: 'https://support.google.com/websearch' }] }
  ];
  const SIGNIN_URL = 'https://accounts.google.com/ServiceLogin?hl=fr&continue=https%3A%2F%2Fwww.google.com%2F';

  let google = C.load('google', { status: 'unknown' });

  function setAvatar(box, img, letter, g) {
    letter.textContent = (g.name || g.email || '?').trim().charAt(0).toUpperCase();
    if (g.avatar) { img.src = g.avatar; box.classList.remove('noimg'); img.onerror = () => box.classList.add('noimg'); }
    else box.classList.add('noimg');
  }

  function renderGoogle(g) {
    if (!g) return;
    // tant que la vérification n'est pas faite, on garde le dernier état connu
    if (g.status === 'unknown') g = google;
    else { google = g; C.save('google', g); }
    const signedIn = g.status === 'signed_in';
    $('google-btn').hidden = signedIn;
    $('avatar-btn').hidden = !signedIn;
    if (!signedIn) { if (openDrawer && openDrawer.id === 'account') closeDrawers(); return; }
    $('avatar-btn').title = 'Compte Google\n' + (g.name || '') + '\n' + (g.email || '');
    setAvatar($('avatar-btn'), $('avatar-img'), $('avatar-letter'), g);
    setAvatar(document.querySelector('.gm-avatar'), $('gm-img'), $('gm-letter'), g);
    $('gm-name').textContent = g.name || 'Compte Google';
    $('gm-email').textContent = g.email || '';
  }

  const CHEVRON = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

  function itemEl(it) {
    const b = document.createElement('button');
    b.className = 'row-link';
    b.innerHTML = I[it.icon] + '<span></span>' + (it.right ? '<em class="right"></em>' : '') + CHEVRON;
    b.querySelector('span').textContent = it.label;
    if (it.right) b.querySelector('.right').textContent = it.right;
    b.onclick = () => { location.href = it.url; };
    return b;
  }

  function buildAccount() {
    const box = $('gm-list');
    box.replaceChildren();
    for (const g of GROUPS) {
      const group = document.createElement('div');
      group.className = 'group';
      const h = document.createElement('h3');
      h.textContent = g.title;
      const list = document.createElement('div');
      list.className = 'list';
      g.items.forEach((it) => list.appendChild(itemEl(it)));
      group.append(h, list);
      box.appendChild(group);
    }
  }

  $('avatar-btn').addEventListener('click', () => showDrawer('account'));
  $('google-btn').addEventListener('click', () => { location.href = SIGNIN_URL; });
  buildAccount();
  renderGoogle(google);
  // à chaque ouverture de la page d'accueil, on vérifie si le compte a changé
  C.invoke('refresh_google');

  // ------------------------------------------------------------- extensions
  const extUI = C.mountExtensions({
    list: 'ext-list', form: 'ext-form', input: 'ext-input', status: 'ext-status', store: 'ext-store',
    onStore: () => { location.href = 'https://chromewebstore.google.com/'; },
    isVisible: () => !!(openDrawer && openDrawer.id === 'extensions')
  });
  function loadExtensions() { extUI.load(); }

  function applyState(s) {
    if (!s) return;
    providers = s.providers || [];
    aiProvider = s.ai_provider;
    if (typeof s.ai_memory === 'boolean') aiMemory = s.ai_memory;
    if (typeof s.restore_session === 'boolean') restoreSession = s.restore_session;
    if (typeof s.sleep_min === 'number') sleepMin = s.sleep_min;
    if (typeof s.save_history === 'boolean') saveHistory = s.save_history;
    if (typeof s.private === 'boolean') {
      document.body.classList.toggle('private', s.private);
      $('private-hero').hidden = !s.private;
    }
    renderMedia(s.media);
    renderGoogle(s.google);
    if (openDrawer && openDrawer.id === 'settings') renderSettings();
  }

  renderMedia(null);
  applyLight();
  C.listen('global-state', applyState);
  C.invoke('get_state').then(applyState);
})();
