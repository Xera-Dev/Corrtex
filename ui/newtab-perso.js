// Page d'accueil : fond d'écran, widgets (horloge, météo, tâches, citation), mode concentration,
// profils, économie d'énergie, version et mises à jour.
(function () {
  const C = window.Corrtex;
  const $ = (id) => document.getElementById(id);
  const P = () => Object.assign({ wall: 'lights', wallDim: 0.25, widgets: { clock: true, weather: false, todo: false, quote: false } }, C.prefs());
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const visible = () => document.visibilityState === 'visible';

  // ---------------------------------------------------------------- image / vidéo du fond (IndexedDB : pas de limite de 5 Mo)
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('corrtex', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('media');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function blobGet(key) {
    const d = await db();
    return new Promise((res) => { const q = d.transaction('media').objectStore('media').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  }
  async function blobPut(key, val) {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  // ---------------------------------------------------------------- fond d'écran
  const WALLS = [
    ['lights', 'Lumières', ''],
    ['aurora', 'Aurore', 'linear-gradient(120deg,#0b1a3a,#1d6f6a,#5b2a86,#0b1a3a)'],
    ['sunset', 'Couchant', 'linear-gradient(120deg,#2b1033,#a8324a,#f08a4b,#2b1033)'],
    ['ocean', 'Océan', 'linear-gradient(120deg,#031b34,#0a4f7a,#1aa3b8,#031b34)'],
    ['forest', 'Forêt', 'linear-gradient(120deg,#0d1f14,#25543a,#6f8f3a,#0d1f14)'],
    ['night', 'Nuit', 'linear-gradient(120deg,#07070c,#1c1c3a,#3a1c4a,#07070c)'],
    ['image', 'Image', ''],
    ['video', 'Vidéo', '']
  ];
  let wallUrl = null;
  async function applyWall() {
    const p = P(), w = $('wall');
    if (wallUrl) { URL.revokeObjectURL(wallUrl); wallUrl = null; }
    w.replaceChildren();
    w.className = '';
    const mode = p.wall || 'lights';
    // le fond animé « Lumières » est celui de Corrtex ; les autres le remplacent (et l'arrêtent)
    document.body.classList.toggle('walled', mode !== 'lights');
    if (mode === 'lights') return;
    const preset = WALLS.find((x) => x[0] === mode);
    if (preset && preset[2]) {
      w.className = 'grad';
      w.style.backgroundImage = preset[2];
    } else {
      w.style.backgroundImage = '';
      const blob = await blobGet('wall').catch(() => null);
      if (!blob) { document.body.classList.remove('walled'); return; }
      wallUrl = URL.createObjectURL(blob);
      if (mode === 'video') {
        const v = el('video');
        v.src = wallUrl; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.setAttribute('disablepictureinpicture', '');
        w.append(v);
        v.play().catch(() => {});
      } else {
        const i = el('img'); i.src = wallUrl; i.alt = '';
        w.append(i);
      }
    }
    const dim = el('div', 'dim');
    dim.style.opacity = p.wallDim;
    w.append(dim);
  }
  // vidéo et animation en pause quand la page est cachée ou en économie d'énergie
  let saver = false;
  function pauseWall() {
    const v = $('wall').querySelector('video');
    const stop = !visible() || saver;
    if (v) { if (stop) v.pause(); else v.play().catch(() => {}); }
    document.body.classList.toggle('saver', saver);
  }
  document.addEventListener('visibilitychange', pauseWall);

  function renderWallSettings() {
    const p = P(), box = $('set-wall');
    box.replaceChildren();
    for (const [id, name, bg] of WALLS) {
      const b = el('button', 'wall-tile' + ((p.wall || 'lights') === id ? ' sel' : ''));
      const sw = el('i');
      if (bg) sw.style.backgroundImage = bg;
      else if (id === 'lights') sw.classList.add('lights');
      else sw.classList.add(id);
      b.append(sw, el('span', '', name));
      b.onclick = async () => {
        if ((id === 'image' || id === 'video') && !(await blobGet('wall').catch(() => null))) { pick(id); return; }
        C.setPrefs({ wall: id });
        renderWallSettings(); applyWall();
      };
      box.append(b);
    }
    $('set-dim').value = p.wallDim;
  }
  function pick(kind) {
    const f = $('wall-file');
    f.accept = kind === 'video' ? 'video/mp4,video/webm' : 'image/*';
    f.dataset.kind = kind;
    f.click();
  }
  $('wall-img').onclick = () => pick('image');
  $('wall-vid').onclick = () => pick('video');
  $('wall-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const kind = e.target.dataset.kind;
    e.target.value = '';
    if (!file) return;
    if (file.size > 80 * 1024 * 1024) { alertHint('Fichier trop lourd (80 Mo au plus).'); return; }
    let blob = file;
    // image : réduite à la taille de l'écran (plus légère à afficher)
    if (kind === 'image') blob = await shrink(file).catch(() => file);
    await blobPut('wall', blob);
    C.setPrefs({ wall: kind });
    renderWallSettings(); applyWall();
  });
  function shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image(), u = URL.createObjectURL(file);
      img.onload = () => {
        const max = Math.max(screen.width, screen.height) * (devicePixelRatio || 1);
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = el('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        c.toBlob((b) => (b ? res(b) : rej()), 'image/jpeg', 0.88);
      };
      img.onerror = () => { URL.revokeObjectURL(u); rej(); };
      img.src = u;
    });
  }
  function alertHint(t) { const m = $('city-msg'); m.hidden = false; m.textContent = t; }
  $('set-dim').addEventListener('input', (e) => { C.setPrefs({ wallDim: +e.target.value }); const d = $('wall').querySelector('.dim'); if (d) d.style.opacity = e.target.value; });

  // ---------------------------------------------------------------- widgets
  const WIDGETS = [['clock', 'Horloge'], ['weather', 'Météo'], ['todo', 'Tâches du jour'], ['quote', 'Citation du jour']];
  const QUOTES = [
    ['Il faut cultiver notre jardin.', 'Voltaire'],
    ['Le cœur a ses raisons que la raison ne connaît point.', 'Blaise Pascal'],
    ['Rien ne sert de courir ; il faut partir à point.', 'Jean de La Fontaine'],
    ['Je pense, donc je suis.', 'René Descartes'],
    ['Ce que l’on conçoit bien s’énonce clairement.', 'Nicolas Boileau'],
    ['À vaincre sans péril, on triomphe sans gloire.', 'Pierre Corneille'],
    ['Il n’y a qu’un bonheur dans la vie, c’est d’aimer et d’être aimé.', 'George Sand'],
    ['Aide-toi, le ciel t’aidera.', 'Jean de La Fontaine'],
    ['On a souvent besoin d’un plus petit que soi.', 'Jean de La Fontaine'],
    ['Le travail éloigne de nous trois grands maux : l’ennui, le vice et le besoin.', 'Voltaire'],
    ['Petit à petit, l’oiseau fait son nid.', 'Proverbe'],
    ['Qui va lentement va sûrement.', 'Proverbe'],
    ['Paris ne s’est pas fait en un jour.', 'Proverbe'],
    ['Tout vient à point à qui sait attendre.', 'Proverbe'],
    ['Vingt fois sur le métier remettez votre ouvrage.', 'Nicolas Boileau'],
    ['Patience et longueur de temps font plus que force ni que rage.', 'Jean de La Fontaine']
  ];
  const WX = { 0: ['Ciel dégagé', '☀️'], 1: ['Peu nuageux', '🌤️'], 2: ['Partiellement nuageux', '⛅'], 3: ['Couvert', '☁️'], 45: ['Brouillard', '🌫️'], 48: ['Brouillard givrant', '🌫️'],
    51: ['Bruine', '🌦️'], 53: ['Bruine', '🌦️'], 55: ['Bruine dense', '🌧️'], 61: ['Pluie faible', '🌦️'], 63: ['Pluie', '🌧️'], 65: ['Forte pluie', '🌧️'],
    71: ['Neige faible', '🌨️'], 73: ['Neige', '🌨️'], 75: ['Forte neige', '❄️'], 80: ['Averses', '🌦️'], 81: ['Averses', '🌧️'], 82: ['Fortes averses', '⛈️'],
    95: ['Orage', '⛈️'], 96: ['Orage et grêle', '⛈️'], 99: ['Orage et grêle', '⛈️'] };
  let clockTimer = 0;
  function renderWidgets() {
    const p = P(), box = $('widgets'), on = p.widgets || {};
    clearTimeout(clockTimer);
    box.replaceChildren();
    if (document.body.classList.contains('private')) return;
    if (on.clock) box.append(clockCard());
    if (on.weather) box.append(weatherCard());
    if (on.todo) box.append(todoCard());
    if (on.quote) box.append(quoteCard());
  }
  function card(title) { const c = el('div', 'wcard'); if (title) c.append(el('div', 'wt', title)); return c; }
  function clockCard() {
    const c = card(), t = el('div', 'clock'), d = el('div', 'wsub');
    const tick = () => {
      const n = new Date();
      t.textContent = n.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const s = n.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      d.textContent = s.charAt(0).toUpperCase() + s.slice(1);
      // prochaine mise à jour au changement de minute (pas de minuterie inutile)
      clockTimer = setTimeout(tick, 60000 - (n.getSeconds() * 1000 + n.getMilliseconds()) + 50);
    };
    tick();
    c.append(t, d);
    return c;
  }
  function weatherCard() {
    const c = card('Météo'), body = el('div', 'wsub', 'Chargement…');
    c.append(body);
    const city = C.load('weatherCity', null);
    if (!city) { body.textContent = 'Choisissez une ville dans les paramètres › Widgets.'; return c; }
    const cache = C.load('weatherCache', null);
    const show = (w) => {
      body.replaceChildren();
      const [label, icon] = WX[w.code] || ['', '🌡️'];
      const row = el('div', 'wx');
      row.append(el('span', 'wxi', icon), el('span', 'wxt', Math.round(w.t) + '°'));
      const info = el('div', 'wsub', city.name + ' · ' + label);
      const mm = el('div', 'wsub', '↑ ' + Math.round(w.max) + '°  ↓ ' + Math.round(w.min) + '°');
      body.append(row, info, mm);
    };
    // la météo est gardée 30 min
    if (cache && cache.key === city.name && Date.now() - cache.at < 30 * 60000) { show(cache.w); return c; }
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon + '&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1')
      .then((r) => r.json())
      .then((j) => {
        const w = { t: j.current.temperature_2m, code: j.current.weather_code, max: j.daily.temperature_2m_max[0], min: j.daily.temperature_2m_min[0] };
        C.save('weatherCache', { key: city.name, at: Date.now(), w });
        show(w);
      })
      .catch(() => { body.textContent = 'Météo indisponible.'; });
    return c;
  }
  function todoCard() {
    const c = card('Tâches du jour');
    const today = new Date().toDateString();
    let data = C.load('todo', { day: today, items: [] });
    // nouvelle journée : les tâches faites disparaissent, les autres restent
    if (data.day !== today) { data = { day: today, items: data.items.filter((x) => !x.done) }; C.save('todo', data); }
    const list = el('div', 'todo');
    const render = () => {
      list.replaceChildren();
      data.items.forEach((it, i) => {
        const r = el('label', 'ti' + (it.done ? ' done' : ''));
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = it.done;
        cb.onchange = () => { it.done = cb.checked; C.save('todo', data); render(); };
        const x = el('button', 'tx', '×'); x.title = 'Supprimer';
        x.onclick = (e) => { e.preventDefault(); data.items.splice(i, 1); C.save('todo', data); render(); };
        r.append(cb, el('span', '', it.text), x);
        list.append(r);
      });
    };
    const inp = el('input', 'tadd'); inp.placeholder = 'Ajouter une tâche…'; inp.maxLength = 120;
    inp.onkeydown = (e) => { if (e.key === 'Enter' && inp.value.trim()) { data.items.push({ text: inp.value.trim(), done: false }); inp.value = ''; C.save('todo', data); render(); } };
    render();
    c.append(list, inp);
    return c;
  }
  function quoteCard() {
    const c = card('Citation du jour');
    const day = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 864e5);
    const [q, a] = QUOTES[day % QUOTES.length];
    c.append(el('div', 'quote', '« ' + q + ' »'), el('div', 'wsub', a));
    return c;
  }
  function renderWidgetSettings() {
    const p = P(), box = $('set-widgets');
    box.replaceChildren();
    for (const [id, name] of WIDGETS) {
      const r = el('div', 'row-link keyrow');
      r.append(el('span', '', name));
      const sw = el('label', 'switch'), cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!(p.widgets || {})[id];
      cb.onchange = () => {
        const w = Object.assign({}, P().widgets, { [id]: cb.checked });
        C.setPrefs({ widgets: w });
        $('weather-city').hidden = !w.weather;
        renderWidgets();
      };
      sw.append(cb, el('span'));
      r.append(sw);
      box.append(r);
    }
    $('weather-city').hidden = !(p.widgets || {}).weather;
    const city = C.load('weatherCity', null);
    $('city-input').value = city ? city.name : '';
  }
  $('city-save').onclick = async () => {
    const q = $('city-input').value.trim();
    const m = $('city-msg');
    if (!q) return;
    m.hidden = false; m.textContent = 'Recherche…';
    try {
      const j = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=fr&format=json&name=' + encodeURIComponent(q))).json();
      const r = j.results && j.results[0];
      if (!r) { m.textContent = 'Ville introuvable.'; return; }
      C.save('weatherCity', { name: r.name, lat: r.latitude, lon: r.longitude });
      C.save('weatherCache', null);
      m.textContent = 'Météo de ' + r.name + (r.country ? ' (' + r.country + ')' : '') + '.';
      renderWidgets();
    } catch (e) { m.textContent = 'Recherche impossible (pas de connexion ?).'; }
  };

  // ---------------------------------------------------------------- mode concentration
  async function renderFocus() {
    const f = await C.invoke('focus_info').catch(() => null);
    if (!f) return;
    const box = $('focus-chips');
    box.replaceChildren();
    if (f.left) {
      const b = el('button', 'chip sel', 'Arrêter (encore ' + Math.ceil(f.left / 60) + ' min)');
      b.onclick = async () => { await C.invoke('focus_stop'); renderFocus(); };
      box.append(b);
    } else {
      for (const m of [25, 50, 90]) {
        const b = el('button', 'chip', m + ' min');
        b.onclick = async () => { await C.invoke('focus_start', { minutes: m }); renderFocus(); };
        box.append(b);
      }
    }
    const ta = $('focus-sites');
    if (document.activeElement !== ta) ta.value = (f.sites || []).join('\n');
  }
  let fsT = 0;
  $('focus-sites').addEventListener('input', (e) => {
    clearTimeout(fsT);
    fsT = setTimeout(() => C.invoke('focus_sites_set', { sites: e.target.value.split(/[\n,]+/) }), 600);
  });
  C.listen('focus-changed', renderFocus);

  // ---------------------------------------------------------------- profils
  async function renderProfiles() {
    const list = await C.invoke('profile_list').catch(() => []);
    const box = $('profiles');
    box.replaceChildren();
    for (const p of list) {
      const r = el('div', 'row-link keyrow');
      const dot = el('i', 'pdot'); dot.style.background = p.color; dot.style.boxShadow = '0 0 8px ' + p.color;
      r.append(dot, el('span', '', p.name));
      const open = el('button', 'kbd', 'Ouvrir');
      open.title = 'Ouvrir une fenêtre avec ce profil';
      open.onclick = () => C.invoke('open_profile_window', { id: p.id });
      r.append(open);
      if (p.id !== 0) {
        const del = el('button', 'kreset', '×');
        del.title = 'Supprimer le profil et ses données (connexions, cookies)';
        let armed = false;
        del.onclick = async () => {
          if (!armed) { armed = true; del.textContent = '?'; del.title = 'Cliquer encore pour confirmer'; setTimeout(() => { armed = false; del.textContent = '×'; }, 3000); return; }
          try { await window.__TAURI__.core.invoke('profile_delete', { id: p.id }); } catch (e) { const m = $('profile-msg'); m.hidden = false; m.textContent = String(e); }
          renderProfiles();
        };
        r.append(del);
      }
      box.append(r);
    }
  }
  $('profile-add').onclick = async () => {
    const n = $('profile-name').value.trim();
    if (!n) return;
    await C.invoke('profile_create', { name: n });
    $('profile-name').value = '';
    renderProfiles();
  };
  $('profile-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('profile-add').click(); });

  // ---------------------------------------------------------------- économie d'énergie, version, mises à jour
  async function renderAbout() {
    const i = await C.invoke('app_info').catch(() => null);
    if (!i) return;
    saver = !!i.power_saver;
    pauseWall();
    const box = $('power-chips');
    box.replaceChildren();
    for (const [m, n] of [['auto', 'Sur batterie'], ['on', 'Toujours'], ['off', 'Jamais']]) {
      const b = el('button', 'chip' + (i.power_mode === m ? ' sel' : ''), n);
      b.onclick = async () => { await C.invoke('set_power_mode', { mode: m }); renderAbout(); };
      box.append(b);
    }
    $('power-state').textContent = i.power_saver ? 'Économie d’énergie active.' + (i.on_battery ? ' (sur batterie)' : '') : (i.on_battery ? 'Sur batterie.' : 'Sur secteur.');
    $('about-version').textContent = 'Version ' + i.version;
    return i;
  }
  C.listen('power-saver', () => renderAbout());
  function openWhatsNew() { location.href = 'whatsnew.html'; }
  $('whatsnew-btn').onclick = openWhatsNew;
  async function checkUpdate(silent) {
    const m = $('update-msg');
    if (!silent) { m.hidden = false; m.textContent = 'Recherche…'; }
    try {
      const r = await window.__TAURI__.core.invoke('update_check');
      $('update-install-row').hidden = !r.available;
      if (r.available) {
        if (silent) toast('Corrtex ' + r.version + ' est disponible.', 'Installer', installUpdate);
        else m.textContent = 'Nouvelle version ' + r.version + ' disponible (vous avez la ' + r.current + ').';
      } else if (!silent) m.textContent = 'Corrtex est à jour (version ' + r.current + ').';
    } catch (e) { if (!silent) m.textContent = String(e); }
  }
  function installUpdate() {
    const m = $('update-msg');
    m.hidden = false;
    m.textContent = 'Téléchargement de la mise à jour…';
    $('update-install').disabled = true;
    window.__TAURI__.core.invoke('update_install').catch((e) => { m.textContent = String(e); $('update-install').disabled = false; });
  }
  C.listen('update-progress', (p) => {
    if (!p) return;
    const m = $('update-msg');
    m.hidden = false;
    m.textContent = p.error ? 'La mise à jour a échoué : ' + p.error : p.pct >= 100 ? 'Installation, Corrtex va redémarrer…' : 'Téléchargement ' + p.pct + ' %';
  });
  $('update-install').onclick = installUpdate;
  $('update-btn').onclick = () => checkUpdate(false);

  // ---------------------------------------------------------------- message en bas de page
  function toast(text, action, fn) {
    const t = $('toast');
    t.replaceChildren(el('span', '', text));
    if (action) { const b = el('button', 'chip sel', action); b.onclick = () => { t.hidden = true; fn(); }; t.append(b); }
    const x = el('button', 'tclose', '×'); x.onclick = () => { t.hidden = true; }; t.append(x);
    t.hidden = false;
  }

  // ---------------------------------------------------------------- démarrage (les réglages lourds attendent l'ouverture du panneau)
  applyWall();
  renderWidgets();
  window.addEventListener('corrtex-prefs', () => { applyWall(); renderWidgets(); });
  let settingsReady = false;
  const settings = $('settings');
  new MutationObserver(() => {
    if (!settings.classList.contains('open') || settingsReady) return;
    settingsReady = true;
    renderWallSettings(); renderWidgetSettings(); renderFocus(); renderProfiles();
  }).observe(settings, { attributes: true, attributeFilter: ['class'] });
  renderAbout().then((i) => {
    if (!i) return;
    if (i.updated) toast('Corrtex a été mis à jour en version ' + i.version + '.', 'Voir les nouveautés', openWhatsNew);
    if (i.updated || i.first) C.invoke('version_seen');
    // la vérification périodique est faite par Corrtex (pastille « Mettre à jour » dans la barre)
  });
})();
