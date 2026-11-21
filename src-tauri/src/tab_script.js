// Script injecté dans chaque onglet (cadre principal uniquement).
// Il signale au navigateur l'icône du site et la lecture média en cours,
// et relaie quelques raccourcis clavier que le moteur ne gère pas lui-même.
(function () {
  if (window.top !== window || window.__corrtex) return;
  window.__corrtex = true;

  function send(kind, data) {
    try {
      window.__TAURI_INTERNALS__.invoke('tab_event', { kind: kind, data: data });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- recherche Google
  // Corrtex restyle les pages de résultats Google. Pour ne jamais montrer la page d'origine,
  // un voile aux couleurs du thème (avec un petit chargement) couvre la page dès son début ;
  // le style Corrtex le retire dès qu'il est appliqué. On demande ce style au navigateur dès
  // que la page est prête (DOMContentLoaded), sans attendre la fin du chargement.
  if (/^www\.google\./.test(location.hostname) && location.pathname === '/search') {
    var cover = null, coverInfo = null;
    try {
      var raw = localStorage.getItem('__corrtex_cover');
      // pas encore d'information : style activé par défaut
      coverInfo = raw === '0' ? null : (raw ? JSON.parse(raw) : { bg: 'linear-gradient(180deg, #2f2f32, #1e1e21)', accent: '#ff4f7b' });
    } catch (e) { coverInfo = null; }
    var safeColor = function (c, d) { return /^[#a-zA-Z0-9(),.%\s-]{1,120}$/.test(c || '') ? c : d; };
    var showCover = function () {
      if (cover || !coverInfo || !document.documentElement) return;
      cover = document.createElement('div');
      cover.id = '__corrtex_cover';
      cover.setAttribute('aria-hidden', 'true');
      var bg = safeColor(coverInfo.bg, '#1e1e21'), acc = safeColor(coverInfo.accent, '#ff4f7b');
      cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;pointer-events:none;' +
        'background:' + bg + ';transition:opacity .22s ease;opacity:1';
      var ring = document.createElement('div');
      ring.style.cssText = 'width:30px;height:30px;border-radius:50%;border:3px solid rgba(255,255,255,.14);' +
        'border-top-color:' + acc + ';filter:drop-shadow(0 0 8px ' + acc + ');animation:__cxspin .75s linear infinite';
      var st = document.createElement('style');
      st.textContent = '@keyframes __cxspin{to{transform:rotate(360deg)}}';
      cover.appendChild(st);
      cover.appendChild(ring);
      document.documentElement.appendChild(cover);
    };
    var hideCover = function () {
      if (!cover) { coverInfo = null; return; }
      var c = cover;
      cover = null;
      coverInfo = null;
      c.style.opacity = '0';
      setTimeout(function () { c.remove(); }, 260);
    };
    window.__corrtexCoverDone = hideCover;
    if (coverInfo) {
      if (document.documentElement) showCover();
      else new MutationObserver(function (m, obs) { if (document.documentElement) { obs.disconnect(); showCover(); } }).observe(document, { childList: true });
      // filet de sécurité : jamais plus de quelques secondes de voile
      setTimeout(hideCover, 5000);
      window.addEventListener('load', function () { setTimeout(hideCover, 2500); });
    }
    document.addEventListener('DOMContentLoaded', function () { send('google_ready', null); });
  }

  function favicon() {
    try {
      var l = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
      if (l && l.getAttribute('href')) return new URL(l.getAttribute('href'), location.href).href;
      if (location.protocol === 'https:' || location.protocol === 'http:') return location.origin + '/favicon.ico';
    } catch (e) {}
    return '';
  }

  function bestArtwork(md) {
    if (!md || !md.artwork || !md.artwork.length) return '';
    var best = md.artwork[0], bestSize = 0;
    for (var i = 0; i < md.artwork.length; i++) {
      var s = parseInt(String(md.artwork[i].sizes || '0').split('x')[0], 10) || 0;
      if (s >= bestSize) { bestSize = s; best = md.artwork[i]; }
    }
    try { return new URL(best.src, location.href).href; } catch (e) { return ''; }
  }

  function media() {
    var els = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
    var playing = els.filter(function (e) { return !e.paused && !e.ended && e.currentTime > 0; })[0];
    var started = playing || els.filter(function (e) { return e.currentTime > 0 && !e.ended; })[0];
    var ms = navigator.mediaSession;
    var md = ms && ms.metadata;
    var sessionPlaying = ms && ms.playbackState === 'playing';
    if (!started && !(md && md.title)) return null;
    var progress = 0;
    if (started && isFinite(started.duration) && started.duration > 0) progress = started.currentTime / started.duration;
    return {
      title: (md && md.title) || document.title || location.hostname,
      artist: (md && md.artist) || location.hostname.replace(/^www\./, ''),
      artwork: bestArtwork(md),
      playing: !!playing || !!sessionPlaying,
      progress: Math.round(progress * 1000) / 1000
    };
  }

  var last = '';
  // la page joue du son (vidéo ou musique en lecture, non muette)
  function audible() {
    var list = document.querySelectorAll('video, audio');
    for (var i = 0; i < list.length; i++) { var m = list[i]; if (!m.paused && !m.ended && !m.muted && m.volume > 0 && m.readyState > 2) return true; }
    return false;
  }
  // son coupé par Corrtex : toutes les vidéos de la page restent muettes
  var forcedMute = false;
  window.__corrtexMute = function (on) {
    forcedMute = !!on;
    document.querySelectorAll('video, audio').forEach(function (m) { if (forcedMute) { m.__cxWasMuted = m.muted; m.muted = true; } else if (m.__cxWasMuted === false) m.muted = false; });
  };
  document.addEventListener('play', function (e) { if (forcedMute && e.target && 'muted' in e.target) e.target.muted = true; }, true);
  document.addEventListener('volumechange', function () { setTimeout(report, 50); }, true);
  function report() {
    // précédent / suivant possibles (utile hors Windows, où le moteur ne le signale pas).
    // L'API Navigation ne voit que les pages du même site : elle complète la longueur de
    // l'historique de l'onglet sans la remplacer (« suivant » vers un autre site : déduit des clics)
    var nv = window.navigation, nav = { b: history.length > 1, f: null };
    try {
      if (nv && 'canGoBack' in nv) {
        if (nv.canGoBack) nav.b = true;
        else if (nv.currentEntry && nv.entries && nv.entries().length === history.length) nav.b = false;
        if (nv.canGoForward) nav.f = true;
      }
    } catch (e) {}
    var payload = { favicon: favicon(), media: media(), lang: (document.documentElement && document.documentElement.lang) || '', audible: audible(), nav: nav };
    var json = JSON.stringify(payload);
    if (json !== last) { last = json; send('report', payload); }
  }

  ['play', 'pause', 'ended', 'loadedmetadata', 'emptied'].forEach(function (ev) {
    document.addEventListener(ev, function () { setTimeout(report, 50); }, true);
  });
  document.addEventListener('DOMContentLoaded', report);
  window.addEventListener('load', report);
  window.addEventListener('popstate', function () { setTimeout(report, 50); });
  window.addEventListener('pageshow', function () { setTimeout(report, 50); });
  // onglet caché et silencieux : pas de relevé périodique
  setInterval(function () { if (document.hidden && !audible()) return; report(); }, 2000);

  // ---------------------------------------------------------------- défilement
  // Le navigateur replie la barre de favoris pendant les 30 premiers pixels de défilement.
  // Les pages trop courtes ne la replient pas (sinon la page s'agrandirait et remonterait).
  var lastScroll = -1, scrollRaf = 0, scroller = null;
  function scrollValue() {
    var y = window.scrollY || 0;
    var root = document.scrollingElement || document.documentElement;
    var range = (root ? root.scrollHeight : 0) - window.innerHeight;
    if (y <= 0 && scroller && scroller.isConnected) { y = scroller.scrollTop; range = scroller.scrollHeight - scroller.clientHeight; }
    if (range < 150) return 0;
    return Math.max(0, Math.min(30, Math.round(y)));
  }
  document.addEventListener('scroll', function (e) {
    var t = e.target;
    // sites qui défilent dans un grand bloc interne (messageries, applis web)
    if (t && t.nodeType === 1 && t.clientHeight > window.innerHeight * 0.6) scroller = t;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      var v = scrollValue();
      if (v !== lastScroll) { lastScroll = v; send('scroll', v); }
    });
  }, { capture: true, passive: true });

  // ---------------------------------------------------------------- Chrome Web Store
  // Sur la page d'une extension, un bouton « Ajouter à Corrtex » remplace
  // le bouton « Ajouter à Chrome » (qui ne fonctionne que dans Chrome).
  if (location.hostname === 'chromewebstore.google.com') {
    var storeBtn = null;
    var storeMsg = null;
    var currentId = function () {
      var m = location.pathname.match(/\/detail\/(?:[^/]+\/)?([a-p]{32})(?:[/?#]|$)/);
      return m ? m[1] : null;
    };
    window.__corrtexExtResult = function (ok, msg) {
      if (!storeBtn) return;
      storeBtn.disabled = false;
      storeBtn.textContent = ok ? '✓ Ajoutée à Corrtex' : 'Ajouter à Corrtex';
      storeBtn.style.background = ok ? '#1e8e3e' : '#1a73e8';
      if (storeMsg) { storeMsg.textContent = msg; storeMsg.style.display = 'block'; }
    };
    var ensureStoreButton = function () {
      var id = currentId();
      var box = document.getElementById('__corrtex_store');
      if (!id) { if (box) box.remove(); return; }
      if (box && box.dataset.id === id) return;
      if (box) box.remove();
      box = document.createElement('div');
      box.id = '__corrtex_store';
      box.dataset.id = id;
      box.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:14px "Segoe UI",system-ui,sans-serif';
      storeMsg = document.createElement('div');
      storeMsg.style.cssText = 'display:none;max-width:320px;padding:10px 14px;border-radius:12px;background:#202124;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35)';
      storeBtn = document.createElement('button');
      storeBtn.textContent = 'Ajouter à Corrtex';
      storeBtn.style.cssText = 'height:44px;padding:0 22px;border:0;border-radius:22px;background:#1a73e8;color:#fff;font:600 15px "Segoe UI",system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(26,115,232,.45)';
      storeBtn.addEventListener('click', function () {
        storeBtn.disabled = true;
        storeBtn.textContent = 'Installation…';
        storeMsg.style.display = 'none';
        send('install_ext', id);
      });
      box.appendChild(storeMsg);
      box.appendChild(storeBtn);
      (document.body || document.documentElement).appendChild(box);
    };
    document.addEventListener('DOMContentLoaded', ensureStoreButton);
    setInterval(ensureStoreButton, 1000);
  }


  // ---------------------------------------------------------------- clic droit sur une sélection
  // Un texte est sélectionné : le clic droit ouvre le menu Corrtex (questions à l'IA, copier,
  // rechercher). Sans sélection, ou dans un champ de saisie, le menu habituel reste.
  (function () {
    var host = null, root = null, selRect = null;
    var ITEMS = [
      ['explain', 'Expliquer', 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.5M12 16.6h.01'],
      ['translate', 'Traduire', 'M4 5.5h9M8.5 3.5v2M6 5.5c.6 3 2.6 5.4 5 6.5M11 5.5c-.7 3.4-3 6-6.5 7.5M13 20.5l3.8-9 3.7 9M14.3 17.5h5'],
      ['summarize', 'Résumer', 'M5 6.5h14M5 11h14M5 15.5h9'],
      ['rephrase', 'Reformuler', 'M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9M19.5 4.5V9H15M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15M4.5 19.5V15H9']
    ];
    // couleurs du thème Corrtex (envoyées par le navigateur à chaque page)
    var THEME = { card: '#3a3a3e', fg: '#f4f4f6', accent: '#ff4f7b', scheme: 'dark' };
    window.__corrtexTheme = function (t) {
      if (!t || typeof t !== 'object') return;
      ['card', 'fg', 'accent', 'scheme', 'bg1', 'bg2'].forEach(function (k) {
        if (typeof t[k] === 'string' && /^[#a-zA-Z0-9(),.%\s-]{1,64}$/.test(t[k])) THEME[k] = t[k];
      });
    };
    window.__corrtexPanelCss = function () { return panelCss(); };
    window.__corrtexThemeGet = function () { return THEME; };
    // même présentation que le panneau Réglages : carte, rubriques, lignes de verre en liste
    function panelCss() {
      var dark = THEME.scheme !== 'light';
      var glass = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)';
      var hover = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)';
      var border = dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.14)';
      var dim = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.55)';
      return [
        ':host { all: initial; }',
        '.card { font: 14px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: ' + THEME.fg + '; text-align: left;',
        '  background: color-mix(in srgb, ' + THEME.card + ' 94%, transparent); border: 1px solid ' + border + '; border-radius: 22px;',
        '  backdrop-filter: blur(28px) saturate(1.3); -webkit-backdrop-filter: blur(28px) saturate(1.3); box-shadow: 0 24px 60px rgba(0,0,0,' + (dark ? '.4' : '.16') + '); box-sizing: border-box; }',
        '.card * { box-sizing: border-box; }',
        '.m { position: fixed; z-index: 2147483647; width: 250px; padding: 14px 14px 12px; animation: in .16s cubic-bezier(.2,.9,.3,1.2); transform-origin: top left; }',
        '@keyframes in { from { opacity: 0; transform: scale(.96) translateY(-4px); } }',
        'h3 { display: flex; align-items: center; gap: 7px; margin: 0 2px 8px; font-size: 13px; font-weight: 600; letter-spacing: .2px; }',
        'h3 + .list { margin-top: 0; }',
        '.sec + .sec { margin-top: 12px; padding-top: 12px; border-top: 1px solid ' + hover + '; }',
        'h3 svg { width: 14px; height: 14px; fill: ' + THEME.accent + '; stroke: none; filter: drop-shadow(0 0 5px ' + THEME.accent + '); }',
        '.list { display: flex; flex-direction: column; gap: 2px; border-radius: 14px; overflow: hidden; }',
        'button { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 6px 14px; background: ' + glass + '; color: inherit; font-size: 13.5px; cursor: default; }',
        'button:hover, button:focus-visible { background: ' + hover + '; }',
        'button svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; opacity: .9; }',
        'button span { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.ai svg { stroke: ' + THEME.accent + '; }',
        '.dim { color: ' + dim + '; }'
      ].join('\n');
    }
    var SVG = 'http://www.w3.org/2000/svg';
    function icon(d) {
      var s = document.createElementNS(SVG, 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      var p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
      return s;
    }
    function close() { if (host) { host.remove(); host = null; root = null; } }
    function item(cls, d, label, fn) {
      var b = document.createElement('button');
      b.className = cls;
      b.appendChild(icon(d));
      var sp = document.createElement('span');
      sp.textContent = label;
      b.appendChild(sp);
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); close(); fn(); });
      return b;
    }
    function open(x, y, text) {
      close();
      host = document.createElement('corrtex-menu');
      root = host.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = panelCss();
      var m = document.createElement('div');
      m.className = 'card m';
      var sec1 = document.createElement('div');
      sec1.className = 'sec';
      var h = document.createElement('h3');
      var spark = document.createElementNS(SVG, 'svg');
      spark.setAttribute('viewBox', '0 0 24 24');
      var sp = document.createElementNS(SVG, 'path');
      sp.setAttribute('d', 'M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5z');
      spark.appendChild(sp);
      h.appendChild(spark);
      h.appendChild(document.createTextNode('Demander à l’IA'));
      var list1 = document.createElement('div');
      list1.className = 'list';
      ITEMS.forEach(function (it) {
        list1.appendChild(item('ai', it[2], it[1], function () {
          bubble(it[0], it[1], text);
        }));
      });
      sec1.append(h, list1);
      m.appendChild(sec1);
      var sec2 = document.createElement('div');
      sec2.className = 'sec';
      var h2 = document.createElement('h3');
      h2.textContent = 'Texte sélectionné';
      var list2 = document.createElement('div');
      list2.className = 'list';
      sec2.append(h2, list2);
      m.appendChild(sec2);
      list2.appendChild(item('', 'M9 9.5h9.5v10H9zM15 9.5V5.5a1 1 0 0 0-1-1H5.5a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H9', 'Copier', function () {
        try { navigator.clipboard.writeText(text); } catch (e) { try { document.execCommand('copy'); } catch (e2) {} }
      }));
      var short = text.length > 28 ? text.slice(0, 26).trim() + '…' : text;
      list2.appendChild(item('', 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20', 'Rechercher « ' + short + ' »', function () {
        window.open('https://www.google.com/search?q=' + encodeURIComponent(text.slice(0, 300)), '_blank');
      }));
      root.appendChild(st);
      root.appendChild(m);
      (document.body || document.documentElement).appendChild(host);
      // reste dans la fenêtre
      var r = m.getBoundingClientRect();
      var left = Math.min(x, window.innerWidth - r.width - 8), top = Math.min(y, window.innerHeight - r.height - 8);
      m.style.left = Math.max(8, left) + 'px';
      m.style.top = Math.max(8, top) + 'px';
    }

    // ---------------------------------------------------------------- bulle de réponse
    var bHost = null, bRoot = null, bId = '', bBody = null, bSpin = null, bData = null, bBox = null, bPos = null;
    // la bulle suit le texte sélectionné quand la page défile
    function placeBubble() { if (bBox && bPos) { bBox.style.left = (bPos.left - window.scrollX) + 'px'; bBox.style.top = (bPos.top - window.scrollY) + 'px'; } }
    window.addEventListener('scroll', placeBubble, true);
    function bubbleCss() {
      var dark = THEME.scheme !== 'light';
      var glass = dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)';
      var hover = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)';
      var dim = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.55)';
      return panelCss() + '\n' + [
        '.b { position: fixed; z-index: 2147483646; width: 370px; max-width: calc(100vw - 24px); overflow: hidden; padding: 0; animation: bin .22s cubic-bezier(.2,.9,.3,1.15); }',
        '@keyframes bin { from { opacity: 0; transform: translateY(-6px) scale(.97); } }',
        '.hd { display: flex; align-items: center; gap: 8px; padding: 16px 14px 10px 18px; }',
        '.hd .sp { width: 15px; height: 15px; fill: ' + THEME.accent + '; filter: drop-shadow(0 0 5px ' + THEME.accent + '); flex: none; }',
        '.hd span { flex: 1; font-size: 15px; font-weight: 600; }',
        '.x { all: unset; width: 30px; height: 30px; min-height: 0; padding: 0; border-radius: 50%; display: grid; place-items: center; background: ' + glass + '; border: 1px solid ' + (dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.14)') + '; }',
        '.x:hover { background: ' + hover + '; }',
        '.x svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.8; fill: none; stroke-linecap: round; opacity: 1; }',
        '.bd { margin: 0 14px; padding: 12px 14px; border-radius: 14px; background: ' + glass + '; max-height: 300px; overflow-y: auto; user-select: text; line-height: 1.5; }',
        '.bd::-webkit-scrollbar { width: 6px; } .bd::-webkit-scrollbar-thumb { background: ' + hover + '; border-radius: 3px; }',
        '.bd p { margin: 0 0 8px; } .bd p:last-child { margin-bottom: 0; }',
        '.bd ul { margin: 0 0 8px; padding-left: 18px; } .bd li { margin: 2px 0; }',
        '.bd b { font-weight: 600; }',
        '.bd code { font-family: Consolas, monospace; font-size: 12.5px; background: ' + hover + '; padding: 1px 5px; border-radius: 5px; }',
        '.wait { display: flex; align-items: center; gap: 10px; color: ' + dim + '; }',
        '.ring { width: 16px; height: 16px; border-radius: 50%; border: 2px solid ' + hover + '; border-top-color: ' + THEME.accent + '; animation: spin .75s linear infinite; flex: none; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        '.err { color: ' + dim + '; }',
        '.ft { display: flex; justify-content: flex-end; padding: 12px 14px 14px; }',
        '.ft button { width: auto; min-height: 34px; height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13px; font-weight: 600; gap: 8px; border: 1px solid ' + (dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.14)') + '; }',
        '.ft svg { width: 15px; height: 15px; }'
      ].join('\n');
    }
    function closeBubble() { if (bHost) { bHost.remove(); bHost = null; bRoot = null; bId = ''; } }
    // mise en forme légère : paragraphes, listes, **gras**, `code`
    function inline(parent, line) {
      var re = /(\*\*[^*]+\*\*|`[^`]+`)/g, last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
        var tok = m[0], el = document.createElement(tok[0] === '`' ? 'code' : 'b');
        el.textContent = tok[0] === '`' ? tok.slice(1, -1) : tok.slice(2, -2);
        parent.appendChild(el);
        last = m.index + tok.length;
      }
      if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
    }
    function render(text) {
      var frag = document.createDocumentFragment(), ul = null;
      text.split(/\n/).forEach(function (raw) {
        var line = raw.trim();
        if (!line) { ul = null; return; }
        var li = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
        if (li) {
          if (!ul) { ul = document.createElement('ul'); frag.appendChild(ul); }
          var e = document.createElement('li'); inline(e, li[2]); ul.appendChild(e);
        } else {
          ul = null;
          var p = document.createElement('p'); inline(p, line.replace(/^#+\s*/, '')); frag.appendChild(p);
        }
      });
      return frag;
    }
    var bReplace = null, bFinal = '', bFt = null;
    function bubble(action, label, text, opts) {
      closeBubble();
      bReplace = opts && opts.replace || null;
      bFinal = '';
      bId = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      bData = { action: action, text: text, title: document.title };
      bHost = document.createElement('corrtex-bubble');
      bRoot = bHost.attachShadow({ mode: 'closed' });
      var st = document.createElement('style'); st.textContent = bubbleCss();
      var b = document.createElement('div'); b.className = 'card b';
      var hd = document.createElement('div'); hd.className = 'hd';
      var sp = document.createElementNS(SVG, 'svg'); sp.setAttribute('viewBox', '0 0 24 24'); sp.setAttribute('class', 'sp');
      var spp = document.createElementNS(SVG, 'path'); spp.setAttribute('d', 'M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5z'); sp.appendChild(spp);
      var t = document.createElement('span'); t.textContent = label;
      var x = document.createElement('button'); x.className = 'x'; x.title = 'Fermer'; x.appendChild(icon('M6 6l12 12M18 6L6 18'));
      x.addEventListener('click', closeBubble);
      hd.append(sp, t, x);
      bBody = document.createElement('div'); bBody.className = 'bd';
      bSpin = document.createElement('div'); bSpin.className = 'wait';
      var ring = document.createElement('div'); ring.className = 'ring';
      var wt = document.createElement('span'); wt.textContent = 'L’IA réfléchit…';
      bSpin.append(ring, wt);
      bBody.appendChild(bSpin);
      var ft = document.createElement('div'); ft.className = 'ft';
      bFt = ft;
      var more = document.createElement('button'); more.appendChild(icon('M14 4.5h5.5V10M19.5 4.5L11 13M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10'));
      more.appendChild(document.createTextNode('Continuer dans le panneau IA'));
      more.addEventListener('click', function () {
        send('ai_selection', { action: bData.action, text: bData.text, title: bData.title, panel: true });
        closeBubble();
      });
      if (!bReplace) ft.appendChild(more);
      b.append(hd, bBody, ft);
      bRoot.append(st, b);
      (document.body || document.documentElement).appendChild(bHost);
      // sous la sélection, sinon au-dessus ; toujours dans la largeur de la page
      var r = (opts && opts.rect) || selRect || { left: window.scrollX + 20, top: window.scrollY + 20, bottom: window.scrollY + 20, width: 0 };
      var w = Math.min(360, window.innerWidth - 24);
      var left = Math.max(window.scrollX + 12, Math.min(r.left, window.scrollX + window.innerWidth - w - 12));
      var top = r.bottom + 10;
      if (top + 200 > window.scrollY + window.innerHeight && r.top - 10 - 220 > window.scrollY) top = r.top - 230;
      bBox = b;
      bPos = { left: left, top: top };
      placeBubble();
      send('ai_selection', { action: action, text: text, title: document.title, bubble: bId });
    }
    window.__corrtexBubble = function (id, text, done, error) {
      if (!bRoot || id !== bId) return;
      bBody.replaceChildren();
      if (error && !text) {
        var p = document.createElement('p'); p.className = 'err';
        p.textContent = 'Pas de réponse de l’IA pour le moment. Vous pouvez continuer dans le panneau IA.';
        bBody.appendChild(p);
        return;
      }
      if (text) bBody.appendChild(render(text));
      if (!done) bBody.appendChild(bSpin);
      // réécriture terminée : « Remplacer » met le texte dans le champ, « Copier » le garde
      if (done && bReplace && text && !bFt.childNodes.length) {
        bFinal = text.replace(/^["«»“”\s]+|["«»“”\s]+$/g, '');
        var cp = document.createElement('button');
        cp.appendChild(icon('M9 9.5h9.5v10H9zM15 9.5V5.5a1 1 0 0 0-1-1H5.5a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H9'));
        cp.appendChild(document.createTextNode('Copier'));
        cp.addEventListener('click', function () { try { navigator.clipboard.writeText(bFinal); } catch (e) {} closeBubble(); });
        var ok = document.createElement('button');
        ok.style.marginLeft = '8px';
        ok.style.background = THEME.accent;
        ok.style.color = '#fff';
        ok.style.borderColor = 'transparent';
        ok.appendChild(icon('M5 12.5l4.5 4.5L19 7.5'));
        ok.appendChild(document.createTextNode('Remplacer'));
        var fn = bReplace;
        ok.addEventListener('click', function () { var t = bFinal; closeBubble(); fn(t); });
        bFt.append(cp, ok);
      }
    };
    document.addEventListener('mousedown', function (e) { if (bHost && e.target !== bHost && e.target !== host && e.target !== rwHost) closeBubble(); }, true);

    // ---------------------------------------------------------------- réécriture dans les champs de texte
    // Un petit bouton ✦ apparaît dans le coin du champ en cours de saisie (mail, commentaire…) :
    // il propose de corriger, raccourcir ou changer le ton, puis remplace le texte (Ctrl+Z possible).
    var rwHost = null, rwRoot = null, rwBtn = null, rwField = null, rwMenu = null;
    var RW = [
      ['rw_fix', 'Corriger les fautes', 'M5 12.5l4.5 4.5L19 7.5'],
      ['rw_short', 'Raccourcir', 'M5 8h14M5 12h9M5 16h5'],
      ['rw_formal', 'Plus formel', 'M8 4.5h8l1.5 4h-11zM6.5 8.5h11V19a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM10 12.5h4'],
      ['rw_friendly', 'Plus amical', 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01'],
      ['rw_long', 'Développer', 'M5 6.5h14M5 11h14M5 15.5h14M5 20h8']
    ];
    function editable(el) {
      if (!el || !el.tagName) return null;
      if (el.tagName === 'TEXTAREA') return el;
      if (el.tagName === 'INPUT') return /^(text|search|)$/i.test(el.type || '') && !/(pass|card|cvc|cvv|iban|otp|code)/i.test((el.name || '') + (el.id || '') + (el.autocomplete || '')) ? el : null;
      var ce = el.closest && el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
      return ce || null;
    }
    function fieldText(f) { return f.isContentEditable ? (f.innerText || '') : (f.value || ''); }
    function hideRw() { if (rwHost) rwHost.style.display = 'none'; if (rwMenu) { rwMenu.remove(); rwMenu = null; } }
    function placeRw() {
      if (!rwField || !rwHost || !rwField.isConnected) { hideRw(); return; }
      var r = rwField.getBoundingClientRect();
      if (r.width < 120 || r.height < 18 || r.bottom < 0 || r.top > window.innerHeight) { hideRw(); return; }
      var size = r.height < 40 ? 22 : 28;
      rwBtn.style.width = rwBtn.style.height = size + 'px';
      rwBtn.style.left = (r.right - size - 6) + 'px';
      rwBtn.style.top = (r.height < 40 ? r.top + (r.height - size) / 2 : r.bottom - size - 6) + 'px';
      rwHost.style.display = fieldText(rwField).trim().length >= 12 ? '' : 'none';
    }
    function ensureRw() {
      if (rwHost && rwHost.isConnected) return;
      rwHost = document.createElement('corrtex-write');
      rwRoot = rwHost.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = panelCss() + '\n.w { all: unset; position: fixed; z-index: 2147483645; border-radius: 50%; display: grid; place-items: center; cursor: default;' +
        ' background: color-mix(in srgb, ' + THEME.card + ' 92%, transparent); border: 1px solid rgba(255,255,255,.3); box-shadow: 0 4px 14px rgba(0,0,0,.3); }' +
        '\n.w:hover { transform: scale(1.08); } .w svg { width: 60%; height: 60%; fill: ' + THEME.accent + '; filter: drop-shadow(0 0 4px ' + THEME.accent + '); }';
      rwBtn = document.createElement('button');
      rwBtn.className = 'w';
      rwBtn.title = 'Réécrire avec l’IA';
      var sv = document.createElementNS(SVG, 'svg'); sv.setAttribute('viewBox', '0 0 24 24');
      var pp = document.createElementNS(SVG, 'path'); pp.setAttribute('d', 'M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5z'); sv.appendChild(pp);
      rwBtn.appendChild(sv);
      // le champ garde le focus et sa sélection
      rwBtn.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      rwBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openRwMenu(); });
      rwRoot.append(st, rwBtn);
      (document.body || document.documentElement).appendChild(rwHost);
    }
    function openRwMenu() {
      if (rwMenu) { rwMenu.remove(); rwMenu = null; return; }
      var f = rwField;
      if (!f) return;
      // le texte : la sélection dans le champ, sinon tout le champ
      var range = null, start = 0, end = 0, text = '';
      if (f.isContentEditable) {
        var sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed && f.contains(sel.anchorNode)) { range = sel.getRangeAt(0).cloneRange(); text = String(sel); }
        else { text = f.innerText || ''; }
      } else {
        start = f.selectionStart || 0; end = f.selectionEnd || 0;
        if (end > start) text = f.value.slice(start, end); else { text = f.value; start = 0; end = f.value.length; }
      }
      text = text.trim();
      if (text.length < 2) return;
      rwMenu = document.createElement('div');
      rwMenu.className = 'card m';
      var h = document.createElement('h3');
      var sv = document.createElementNS(SVG, 'svg'); sv.setAttribute('viewBox', '0 0 24 24');
      var pp = document.createElementNS(SVG, 'path'); pp.setAttribute('d', 'M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5z'); sv.appendChild(pp);
      h.append(sv, document.createTextNode('Réécrire avec l’IA'));
      var list = document.createElement('div'); list.className = 'list';
      RW.forEach(function (it) {
        var b = document.createElement('button');
        b.className = 'ai';
        b.appendChild(icon(it[2]));
        var sp = document.createElement('span'); sp.textContent = it[1]; b.appendChild(sp);
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        b.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          rwMenu.remove(); rwMenu = null;
          var r = f.getBoundingClientRect();
          bubble(it[0], it[1], text.slice(0, 8000), {
            rect: { left: r.left + window.scrollX, top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, width: r.width },
            replace: function (t) { replaceIn(f, t, range, start, end); }
          });
        });
        list.appendChild(b);
      });
      rwMenu.append(h, list);
      rwRoot.appendChild(rwMenu);
      var br = rwBtn.getBoundingClientRect();
      var mr = rwMenu.getBoundingClientRect();
      var top = br.bottom + 6;
      if (top + mr.height > window.innerHeight - 8) top = Math.max(8, br.top - mr.height - 6);
      rwMenu.style.left = Math.max(8, Math.min(br.right - mr.width, window.innerWidth - mr.width - 8)) + 'px';
      rwMenu.style.top = top + 'px';
    }
    // remplacement « comme une frappe » : les sites voient le changement et Ctrl+Z l'annule
    function replaceIn(f, t, range, start, end) {
      f.focus();
      if (f.isContentEditable) {
        var sel = window.getSelection();
        sel.removeAllRanges();
        if (range) sel.addRange(range);
        else { var all = document.createRange(); all.selectNodeContents(f); sel.addRange(all); }
      } else {
        f.setSelectionRange(start, end);
      }
      var ok = false;
      try { ok = document.execCommand('insertText', false, t); } catch (e) {}
      if (!ok && !f.isContentEditable) {
        var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f), 'value').set;
        setter.call(f, f.value.slice(0, start) + t + f.value.slice(end));
        f.dispatchEvent(new Event('input', { bubbles: true }));
      }
      setTimeout(placeRw, 30);
    }
    // bouton « Réécrire avec l'IA » dans les champs de texte : désactivé (à la demande de l'utilisateur)
    var RW_ON = false;
    document.addEventListener('focusin', function (e) {
      if (!RW_ON) return;
      var f = editable(e.composedPath ? e.composedPath()[0] : e.target);
      if (!f) return;
      rwField = f;
      ensureRw();
      placeRw();
    }, true);
    document.addEventListener('focusout', function () {
      setTimeout(function () {
        var a = document.activeElement;
        if (!editable(a) && !rwMenu && !bHost) { rwField = null; hideRw(); }
      }, 150);
    }, true);
    document.addEventListener('input', function (e) { if (rwField && (e.target === rwField || rwField.contains(e.target))) placeRw(); }, true);
    window.addEventListener('scroll', function () { if (rwField) placeRw(); }, true);
    window.addEventListener('resize', function () { if (rwField) placeRw(); });
    document.addEventListener('mousedown', function (e) { if (rwMenu && e.target !== rwHost) { rwMenu.remove(); rwMenu = null; } }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rwMenu) { rwMenu.remove(); rwMenu = null; } }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeBubble(); }, true);

    document.addEventListener('contextmenu', function (e) {
      var t = e.target;
      if (t && t.closest && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      var sel = window.getSelection ? String(window.getSelection()).trim() : '';
      if (sel.length < 2) { close(); return; }
      e.preventDefault();
      try {
        var rr = window.getSelection().getRangeAt(0).getBoundingClientRect();
        selRect = { left: rr.left + window.scrollX, top: rr.top + window.scrollY, bottom: rr.bottom + window.scrollY, width: rr.width };
      } catch (err) { selRect = { left: e.pageX, top: e.pageY, bottom: e.pageY, width: 0 }; }
      open(e.clientX, e.clientY, sel.slice(0, 8000));
    }, true);
    document.addEventListener('mousedown', function (e) { if (host && e.target !== host) close(); }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); }, true);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  })();

  // petite icône SVG (sans insérer de HTML : certaines pages l'interdisent)
  function cxIcon(d) {
    var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sv.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    sv.appendChild(p);
    return sv;
  }

  // ---------------------------------------------------------------- recherche dans la page (Ctrl+F)
  // Petite carte façon réglages en haut à droite ; toutes les occurrences sont surlignées
  // (Highlight API), l'occurrence courante dans la couleur du thème.
  (function () {
    var host = null, root = null, input = null, count = null, ranges = [], cur = -1, hlStyle = null;
    function clearHl() {
      try { CSS.highlights.delete('corrtex-find'); CSS.highlights.delete('corrtex-find-cur'); } catch (e) {}
    }
    function ensureHlStyle() {
      if (hlStyle && hlStyle.isConnected) return;
      hlStyle = document.createElement('style');
      hlStyle.textContent = '::highlight(corrtex-find){background:rgba(255,214,102,.45);color:inherit}::highlight(corrtex-find-cur){background:#ff4f7b;color:#fff}';
      (document.head || document.documentElement).appendChild(hlStyle);
    }
    function search(q) {
      ranges = []; cur = -1; clearHl();
      if (!q) { update(); return; }
      ensureHlStyle();
      var needle = q.toLowerCase();
      var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentElement;
          if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(p.tagName) || p.closest('corrtex-find, corrtex-menu, corrtex-bubble, corrtex-reader')) return NodeFilter.FILTER_REJECT;
          return n.nodeValue && n.nodeValue.toLowerCase().indexOf(needle) >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });
      var n;
      while ((n = walker.nextNode()) && ranges.length < 2000) {
        var text = n.nodeValue.toLowerCase(), i = 0;
        while ((i = text.indexOf(needle, i)) >= 0 && ranges.length < 2000) {
          var r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
          var rect = r.getBoundingClientRect();
          if (rect.width || rect.height) ranges.push(r);
          i += needle.length;
        }
      }
      try { if (ranges.length) CSS.highlights.set('corrtex-find', new Highlight(...ranges)); } catch (e) {}
      if (ranges.length) go(0); else update();
    }
    function go(i) {
      if (!ranges.length) return;
      cur = (i + ranges.length) % ranges.length;
      try { CSS.highlights.set('corrtex-find-cur', new Highlight(ranges[cur])); } catch (e) {}
      var r = ranges[cur].getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 40) window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'smooth' });
      update();
    }
    function update() {
      if (!count) return;
      count.textContent = input.value ? (ranges.length ? (cur + 1) + ' / ' + ranges.length : 'Aucun résultat') : '';
    }
    function close() { if (host) { host.remove(); host = null; } clearHl(); ranges = []; }
    window.__corrtexFind = function () {
      if (host) { input.focus(); input.select(); return; }
      var css = window.__corrtexPanelCss ? window.__corrtexPanelCss() : '';
      host = document.createElement('corrtex-find');
      root = host.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = css + '\n.f { position: fixed; z-index: 2147483647; top: 14px; right: 18px; width: 380px; padding: 10px; display: flex; align-items: center; gap: 8px; animation: in .16s cubic-bezier(.2,.9,.3,1.2); }' +
        '\n.f input { all: unset; flex: 1; min-width: 0; height: 36px; padding: 0 14px; border-radius: 18px; font-size: 14px; background: rgba(127,127,127,.12); border: 1px solid rgba(127,127,127,.35); }' +
        '\n.f input:focus { border-color: currentColor; }' +
        '\n.f .n { font-size: 12.5px; opacity: .7; white-space: nowrap; min-width: 44px; text-align: right; }' +
        '\n.f button { width: 34px; height: 34px; min-height: 0; padding: 0; justify-content: center; border-radius: 50%; flex: none; background: rgba(127,127,127,.12); }' +
        '\n.f button svg { width: 16px; height: 16px; }';
      var f = document.createElement('div');
      f.className = 'card f';
      input = document.createElement('input');
      input.placeholder = 'Rechercher dans la page';
      count = document.createElement('span');
      count.className = 'n';
      var prev = document.createElement('button'); prev.title = 'Précédent (Maj+Entrée)'; prev.appendChild(cxIcon('M7 14l5-5 5 5'));
      var next = document.createElement('button'); next.title = 'Suivant (Entrée)'; next.appendChild(cxIcon('M7 10l5 5 5-5'));
      var x = document.createElement('button'); x.title = 'Fermer (Échap)'; x.appendChild(cxIcon('M6 6l12 12M18 6L6 18'));
      prev.onclick = function () { go(cur - 1); };
      next.onclick = function () { go(cur + 1); };
      x.onclick = close;
      var timer = null;
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { search(input.value.trim()); }, 120); });
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1)); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      f.append(input, count, prev, next, x);
      root.append(st, f);
      (document.body || document.documentElement).appendChild(host);
      var sel = String(window.getSelection() || '').trim();
      if (sel && sel.length < 80) { input.value = sel; search(sel); }
      setTimeout(function () { input.focus(); input.select(); }, 0);
    };
  })();

  // ---------------------------------------------------------------- mode lecture
  // Le contenu principal de la page (titre, texte, images) dans une vue épurée au style
  // Corrtex : fond du thème, colonne centrée, taille du texte réglable.
  (function () {
    var host = null, size = 19;
    function pickMain() {
      var art = document.querySelector('article');
      if (art && art.innerText.length > 600) return art;
      var best = null, bestScore = 0;
      document.querySelectorAll('main, [role=main], section, div').forEach(function (el) {
        if (el.closest('nav, header, footer, aside')) return;
        var ps = el.querySelectorAll(':scope > p, :scope > div > p');
        var len = 0;
        ps.forEach(function (p) { len += p.innerText.length; });
        if (len > bestScore) { bestScore = len; best = el; }
      });
      return bestScore > 400 ? best : (art || document.querySelector('main') || document.body);
    }
    var KEEP = /^(P|H1|H2|H3|H4|H5|UL|OL|LI|BLOCKQUOTE|PRE|CODE|IMG|FIGURE|FIGCAPTION|A|EM|STRONG|B|I|BR|TABLE|THEAD|TBODY|TR|TD|TH|SPAN|PICTURE|SOURCE)$/;
    // copie propre : seulement les balises de texte, sans scripts ni attributs actifs
    function clean(node, out) {
      node.childNodes.forEach(function (c) {
        if (c.nodeType === 3) { out.appendChild(document.createTextNode(c.nodeValue)); return; }
        if (c.nodeType !== 1) return;
        var tag = c.tagName;
        if (/^(SCRIPT|STYLE|NOSCRIPT|IFRAME|NAV|ASIDE|FORM|BUTTON|INPUT|SELECT|TEXTAREA|SVG|FOOTER|HEADER|DIALOG|OBJECT|EMBED|VIDEO|AUDIO|CANVAS)$/.test(tag)) return;
        var cs = window.getComputedStyle(c);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        if (!KEEP.test(tag)) { clean(c, out); return; }
        var el = document.createElement(tag === 'SPAN' ? 'span' : tag.toLowerCase());
        if (tag === 'IMG') {
          var src = c.currentSrc || c.src;
          if (!src || !/^https?:|^data:image\//.test(src) || (c.naturalWidth && c.naturalWidth < 80)) return;
          el.src = src; el.alt = c.alt || '';
          out.appendChild(el);
          return;
        }
        if (tag === 'A') { var h = c.href; if (/^https?:/.test(h)) { el.href = h; el.target = '_blank'; el.rel = 'noopener'; } }
        clean(c, el);
        if (el.textContent.trim() || el.querySelector('img')) out.appendChild(el);
      });
      return out;
    }
    function close() { if (host) { host.remove(); host = null; document.documentElement.style.overflow = ''; } }
    window.__corrtexReader = function () {
      if (host) { close(); return; }
      var main = pickMain();
      var body = clean(main, document.createElement('div'));
      var t = window.__corrtexThemeGet ? window.__corrtexThemeGet() : {};
      var dark = (t.scheme || 'dark') !== 'light';
      var bg = dark ? 'linear-gradient(180deg, ' + (t.bg1 || '#2f2f32') + ', ' + (t.bg2 || '#1e1e21') + ')' : 'linear-gradient(180deg, #f7f7f9, #eceef2)';
      var fg = t.fg || (dark ? '#f4f4f6' : '#1d1d20');
      var words = (body.textContent.match(/\S+/g) || []).length;
      host = document.createElement('corrtex-reader');
      var root = host.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = (window.__corrtexPanelCss ? window.__corrtexPanelCss() : '') + '\n' + [
        '.r { position: fixed; inset: 0; z-index: 2147483645; overflow-y: auto; background: ' + bg + '; color: ' + fg + '; animation: rin .25s ease; }',
        '@keyframes rin { from { opacity: 0; } }',
        '.glow { position: fixed; inset: 0; pointer-events: none; background: radial-gradient(60vmax 50vmax at 15% 10%, ' + (t.accent || '#ff4f7b') + '22, transparent 60%), radial-gradient(50vmax 40vmax at 90% 90%, ' + (t.accent || '#ff4f7b') + '14, transparent 60%); }',
        '.bar { position: sticky; top: 14px; z-index: 2; width: max-content; margin: 14px auto 0; padding: 6px; display: flex; gap: 6px; align-items: center; }',
        '.bar button { width: auto; min-height: 34px; height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13px; font-weight: 600; justify-content: center; gap: 8px; }',
        '.bar svg { width: 16px; height: 16px; }',
        '.col { position: relative; max-width: 720px; margin: 0 auto; padding: 36px 28px 120px; font: ' + size + 'px/1.7 Georgia, "Iowan Old Style", "Times New Roman", serif; }',
        '.site { font: 600 13px "Segoe UI", -apple-system, sans-serif; opacity: .65; letter-spacing: .3px; text-transform: uppercase; }',
        '.col h1.title { font: 700 34px/1.2 "Segoe UI Variable Display", "Segoe UI", -apple-system, sans-serif; margin: 10px 0 8px; }',
        '.meta { font: 13px "Segoe UI", -apple-system, sans-serif; opacity: .6; margin-bottom: 28px; }',
        '.col h1, .col h2, .col h3, .col h4 { font-family: "Segoe UI Variable Display", "Segoe UI", -apple-system, sans-serif; line-height: 1.3; margin: 1.6em 0 .5em; }',
        '.col p { margin: 0 0 1.1em; }',
        '.col img { max-width: 100%; height: auto; border-radius: 14px; margin: 1em 0; display: block; }',
        '.col a { color: ' + (t.accent || '#ff4f7b') + '; }',
        '.col blockquote { margin: 1.2em 0; padding: .4em 1.2em; border-left: 3px solid ' + (t.accent || '#ff4f7b') + '; opacity: .9; }',
        '.col pre { white-space: pre-wrap; font: 14px/1.5 Consolas, monospace; padding: 14px; border-radius: 12px; background: rgba(127,127,127,.14); }',
        '.col table { border-collapse: collapse; font-size: .85em; } .col td, .col th { border: 1px solid rgba(127,127,127,.3); padding: 6px 10px; }'
      ].join('\n');
      var r = document.createElement('div'); r.className = 'r';
      var glow = document.createElement('div'); glow.className = 'glow';
      var bar = document.createElement('div'); bar.className = 'card bar';
      var minus = document.createElement('button'); minus.textContent = 'A−'; minus.title = 'Texte plus petit';
      var plus = document.createElement('button'); plus.textContent = 'A+'; plus.title = 'Texte plus grand';
      var x = document.createElement('button'); x.appendChild(cxIcon('M6 6l12 12M18 6L6 18')); x.appendChild(document.createTextNode('Quitter la lecture'));
      var col = document.createElement('div'); col.className = 'col';
      function setSize(n) { size = Math.max(14, Math.min(28, n)); col.style.fontSize = size + 'px'; }
      minus.onclick = function () { setSize(size - 1); };
      plus.onclick = function () { setSize(size + 1); };
      x.onclick = close;
      bar.append(minus, plus, x);
      var site = document.createElement('div'); site.className = 'site'; site.textContent = location.hostname.replace(/^www\./, '');
      var h = document.createElement('h1'); h.className = 'title';
      var h1 = main.querySelector('h1') || document.querySelector('h1');
      h.textContent = (h1 && h1.innerText.trim()) || document.title;
      var meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = Math.max(1, Math.round(words / 230)) + ' min de lecture';
      // le titre n'est pas répété dans le texte
      var dup = body.querySelector('h1'); if (dup && dup.textContent.trim() === h.textContent) dup.remove();
      col.append(site, h, meta, body);
      r.append(glow, bar, col);
      root.append(st, r);
      document.documentElement.appendChild(host);
      document.documentElement.style.overflow = 'hidden';
      r.tabIndex = -1; r.focus();
      r.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    };
  })();

  // raccourcis : touches → action (personnalisables dans les réglages ; envoyés par le navigateur)
  var KEYS = { 'Ctrl+T': 'new_tab', 'Ctrl+W': 'close_tab', 'Ctrl+Shift+T': 'reopen_tab', 'Ctrl+Shift+N': 'private_window', 'Ctrl+K': 'palette',
    'Ctrl+L': 'address', 'Ctrl+F': 'find', 'Ctrl+H': 'history', 'Ctrl+J': 'downloads', 'Alt+R': 'reader', 'Ctrl+Shift+A': 'ai_panel',
    'Ctrl+Shift+S': 'screenshot', 'Alt+S': 'split', 'Alt+N': 'notes', 'Alt+L': 'read_later', 'Alt+PageDown': 'space_next', 'Alt+PageUp': 'space_prev',
    'Alt+M': 'mute_tab', 'Alt+P': 'pip', 'F11': 'fullscreen' };
  var GESTURES = true;
  // Mac : ⌘ joue le rôle de Ctrl (les raccourcis restent enregistrés en « Ctrl+… »)
  var IS_MAC = /Mac/.test(navigator.platform || navigator.userAgent);
  function modKey(e) { return e.ctrlKey || (IS_MAC && e.metaKey); }
  window.__corrtexKeys = function (map, gestures) { if (map && typeof map === 'object') KEYS = map; GESTURES = gestures !== false; };
  function comboOf(e) {
    var k = e.key;
    if (!k || k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'AltGraph') return '';
    var name = k.length === 1 ? k.toUpperCase() : k;
    if (name === ' ') name = 'Space';
    var p = [];
    if (modKey(e)) p.push('Ctrl');
    if (e.altKey) p.push('Alt');
    if (e.shiftKey) p.push('Shift');
    p.push(name);
    return p.join('+');
  }
  document.addEventListener('keydown', function (e) {
    if (modKey(e) && !e.altKey) {
      var key = e.key.toLowerCase();
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); send('key', e.shiftKey ? 'ctrl+shift+tab' : 'ctrl+tab'); return; }
      // zoom mémorisé par site
      if (key === '+' || key === '=' || e.code === 'NumpadAdd') { e.preventDefault(); e.stopPropagation(); send('zoom', 'in'); return; }
      if (key === '-' || e.code === 'NumpadSubtract') { e.preventDefault(); e.stopPropagation(); send('zoom', 'out'); return; }
      if (key === '0' || e.code === 'Numpad0') { e.preventDefault(); e.stopPropagation(); send('zoom', 'reset'); return; }
    }
    var c = comboOf(e), act = c && KEYS[c];
    if (!act) return;
    // une touche seule (sans Ctrl/Alt, hors F1…F12) n'est jamais interceptée pendant la frappe
    if (!modKey(e) && !e.altKey && !/^F\d+$/.test(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (act === 'find' && window.__corrtexFind) { window.__corrtexFind(); return; }
    if (act === 'pip' && window.__corrtexPip) { window.__corrtexPip(); return; }
    if (act === 'screenshot' && window.__corrtexCaptureArea) { window.__corrtexCaptureArea(); return; }
    send('action', act);
  }, true);
  // Ctrl + molette : zoom mémorisé par site
  var lastWheel = 0;
  window.addEventListener('wheel', function (e) {
    if (!modKey(e)) return;
    e.preventDefault();
    var now = Date.now();
    if (now - lastWheel < 90) return;
    lastWheel = now;
    send('zoom', e.deltaY < 0 ? 'in' : 'out');
  }, { passive: false, capture: true });
  // petite carte flottante au style Corrtex (ombre portée, verre), dans une racine fermée
  function cxHost(tag, extraCss) {
    var h = document.createElement(tag);
    var r = h.attachShadow({ mode: 'closed' });
    var st = document.createElement('style');
    st.textContent = (window.__corrtexPanelCss ? window.__corrtexPanelCss() : '') + '\n' + (extraCss || '');
    r.appendChild(st);
    (document.body || document.documentElement).appendChild(h);
    return { host: h, root: r };
  }
  function cxTheme() { return (window.__corrtexThemeGet && window.__corrtexThemeGet()) || { accent: '#ff4f7b', scheme: 'dark' }; }
  function cxSpark() {
    var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sv.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5z');
    sv.appendChild(p);
    return sv;
  }

  // ---------------------------------------------------------------- plein écran des vidéos
  // Le bouton plein écran d'une vidéo (YouTube…) ne remplit que la zone de l'onglet : Corrtex
  // met alors toute la fenêtre en plein écran, et la rétablit à la sortie.
  (function () {
    function changed() { send('page_fullscreen', !!(document.fullscreenElement || document.webkitFullscreenElement)); }
    document.addEventListener('fullscreenchange', changed);
    document.addEventListener('webkitfullscreenchange', changed);
  })();

  // ---------------------------------------------------------------- recherche d'achat de l'agent
  // Panneau en verre (comme le comparateur et les réglages) dessiné dans la page de l'onglet
  // affiché. La recherche tourne dans un moteur caché de Corrtex : il envoie ici son état
  // (show), les boutons lui sont renvoyés (send 'shopping_action'). Il suit l'onglet affiché.
  (function () {
    var host = null, root = null, last = null, mode = 'results', list = null, refineOpen = false, picked = {}, local = null;
    function E(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
    function ic(d) { return cxIcon(d); }
    var I = {
      x: 'M6 6l12 12M18 6L6 18', cart: 'M4 5h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h7.6a1.5 1.5 0 0 0 1.5-1.2L20 8.5H7',
      hist: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4.5V9H8M12 7.5V12l3 2', back: 'M15 18l-6-6 6-6', ext: 'M14 4.5h5.5V10M19.5 4.5L11 13M17 14v5.5H4.5V7H10',
      trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12', bot: 'M12 3v3M7.5 8h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM9.5 13h.01M14.5 13h.01'
    };
    var eur = function (n) { return n == null ? '' : n.toLocaleString('fr-FR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €'; };
    function act(o) { send('shopping_action', o); }
    function openUrl(u) { if (u) send('open_new_tab', { url: u }); }

    function css() {
      var th = cxTheme(), dark = th.scheme !== 'light', ac = th.accent || '#ff4f7b';
      var fg = th.fg || (dark ? '#f4f4f6' : '#111');
      var glass = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.045)';
      var hover = dark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.08)';
      var border = dark ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.14)';
      var dim = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.55)';
      var card = th.card || (dark ? '#3a3a3e' : '#ffffff');
      var good = '#4fcf8a', warn = '#ffb05c', btnFg = dark ? '#1c1c20' : '#fff';
      return [
        ':host { all: initial; }', '* { box-sizing: border-box; }',
        '.pn { position: fixed; z-index: 2147483646; top: 14px; right: 14px; bottom: 14px; width: 470px; max-width: calc(100vw - 28px); display: flex; flex-direction: column;',
        '  font: 14px/1.35 "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, sans-serif; color: ' + fg + '; text-align: left;',
        '  background: color-mix(in srgb, ' + card + ' 72%, transparent); border: 1px solid ' + border + '; border-radius: 26px;',
        '  backdrop-filter: blur(34px) saturate(1.6); -webkit-backdrop-filter: blur(34px) saturate(1.6);',
        '  box-shadow: 0 28px 70px rgba(0,0,0,' + (dark ? '.45' : '.18') + '), inset 0 1px 0 rgba(255,255,255,.18); overflow: hidden; animation: pin .28s cubic-bezier(.2,.8,.2,1); }',
        '@keyframes pin { from { opacity: 0; transform: translateX(24px); } }',
        '.hdr { display: flex; align-items: center; gap: 8px; padding: 20px 20px 10px 24px; flex: none; }',
        '.hdr .tt { flex: 1; min-width: 0; } .hdr h2 { margin: 0; font-size: 22px; font-weight: 600; }',
        '.hdr small { display: block; font-size: 12.5px; color: ' + dim + '; margin-top: 1px; }',
        '.rb { all: unset; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; border: 1px solid ' + border + '; background: ' + glass + '; cursor: default; flex: none; }',
        '.rb:hover { background: ' + hover + '; } .rb.on { background: ' + fg + '; color: ' + btnFg + '; border-color: ' + fg + '; }',
        'svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }',
        '.bd { flex: 1; overflow-y: auto; padding: 0 24px 16px; scrollbar-width: thin; }',
        '.goal { padding: 12px 14px; border-radius: 16px; background: ' + glass + '; border: 1px solid ' + border + '; margin: 4px 0 12px; }',
        '.goal .q { font-weight: 600; line-height: 1.35; } .goal .s { font-size: 12.5px; color: ' + dim + '; margin-top: 4px; }',
        '.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; } .tags span { font-size: 11.5px; padding: 3px 9px; border-radius: 10px; background: ' + hover + '; color: ' + dim + '; }',
        '.steps { display: flex; flex-direction: column; gap: 7px; margin: 4px 0 10px; }',
        '.st { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: ' + dim + '; }',
        '.st i { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid ' + border + '; }',
        '.st.run i { border-color: ' + dim + '; border-top-color: transparent; animation: spin .8s linear infinite; }',
        '.st.ok { color: ' + fg + '; } .st.ok i { border-color: ' + good + '; background: ' + good + '; box-shadow: inset 0 0 0 3px ' + card + '; }',
        '.st.err i { border-color: #ff7a7a; background: #ff7a7a; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        'h3 { margin: 16px 0 8px; font-size: 14px; font-weight: 600; }',
        '.adv { padding: 12px 14px; border-radius: 16px; margin-bottom: 10px; font-size: 13px; line-height: 1.45; background: linear-gradient(135deg, color-mix(in srgb, ' + ac + ' 22%, transparent), ' + glass + '); border: 1px solid color-mix(in srgb, ' + ac + ' 40%, transparent); }',
        '.adv b { font-weight: 650; }',
        '.card { display: grid; grid-template-columns: 88px 1fr; gap: 12px; padding: 12px; border-radius: 18px; margin-bottom: 9px; background: ' + glass + '; border: 1px solid ' + border + '; position: relative; }',
        '.card .rk { position: absolute; top: 8px; left: 8px; width: 22px; height: 22px; border-radius: 11px; font-size: 11.5px; font-weight: 700; display: grid; place-items: center; background: ' + fg + '; color: ' + btnFg + '; }',
        '.pic { width: 88px; height: 88px; border-radius: 13px; background: #fff; display: grid; place-items: center; overflow: hidden; }',
        '.pic img { max-width: 80px; max-height: 80px; object-fit: contain; }',
        '.cb { min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
        '.nm { font-size: 13.5px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }',
        '.nm:hover { text-decoration: underline; }',
        '.mt { font-size: 11.5px; color: ' + dim + '; display: flex; flex-wrap: wrap; gap: 2px 10px; } .mt .stars { color: #ffc24b; }',
        '.pl { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-top: 2px; } .pr { font-size: 19px; font-weight: 700; letter-spacing: -.2px; } .sh { font-size: 12px; color: ' + dim + '; }',
        '.tr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
        '.tag { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 9px; white-space: nowrap; background: ' + hover + '; color: ' + dim + '; }',
        '.tag.good { background: rgba(79,207,138,.16); color: ' + good + '; } .tag.warn { background: rgba(255,176,92,.16); color: ' + warn + '; }',
        '.spk { width: 104px; height: 24px; } .spk path { fill: none; stroke: ' + dim + '; stroke-width: 1.6; } .spk circle { fill: ' + fg + '; stroke: none; }',
        '.why { font-size: 12.5px; line-height: 1.4; opacity: .92; margin-top: 2px; }',
        '.bdg { align-self: flex-start; font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 9px; background: color-mix(in srgb, ' + ac + ' 26%, transparent); color: ' + fg + '; border: 1px solid color-mix(in srgb, ' + ac + ' 45%, transparent); }',
        '.pc { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.35; margin-top: 2px; }',
        '.pc span { display: flex; gap: 6px; } .pc .p b { color: ' + good + '; } .pc .c b { color: ' + warn + '; } .pc b { flex: none; font-weight: 700; }',
        '.acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; align-items: center; }',
        '.btn { all: unset; box-sizing: border-box; height: 30px; padding: 0 13px; border-radius: 15px; font-weight: 600; font-size: 12.5px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: ' + fg + '; color: ' + btnFg + '; cursor: default; }',
        '.btn:hover { filter: brightness(.92); } .btn.gh { background: ' + glass + '; color: ' + fg + '; border: 1px solid ' + border + '; } .btn.gh:hover { background: ' + hover + '; filter: none; }',
        '.btn.big { height: 38px; flex: 1; font-size: 13px; } .btn[disabled] { opacity: .45; pointer-events: none; }',
        '.ft { flex: none; padding: 12px 24px 18px; border-top: 1px solid ' + hover + '; display: flex; flex-direction: column; gap: 10px; }',
        '.row { display: flex; gap: 8px; }',
        '.sug { display: flex; flex-wrap: wrap; gap: 6px; } .sug button { all: unset; height: 28px; padding: 0 11px; border-radius: 14px; font-size: 12px; background: ' + glass + '; border: 1px solid ' + border + '; color: ' + dim + '; cursor: default; }',
        '.sug button:hover { color: ' + fg + '; background: ' + hover + '; } .sug button.on { color: ' + btnFg + '; background: ' + fg + '; border-color: ' + fg + '; }',
        '.sorts { align-items: center; margin: 4px 0 2px; } .sorts .lbl { font-size: 12px; color: ' + dim + '; margin-right: 2px; }',
        'input { all: unset; box-sizing: border-box; flex: 1; min-width: 0; height: 38px; padding: 0 14px; border-radius: 19px; border: 1px solid ' + border + '; background: ' + glass + '; color: ' + fg + '; font-size: 13.5px; }',
        'input:focus { border-color: ' + fg + '; } input::placeholder { color: ' + dim + '; }',
        '.empty { font-size: 13px; color: ' + dim + '; padding: 18px 2px; line-height: 1.45; text-align: center; }',
        '.hi { padding: 12px 14px; border-radius: 16px; background: ' + glass + '; border: 1px solid ' + border + '; margin-bottom: 8px; }',
        '.hi .h1 { display: flex; align-items: center; gap: 8px; } .hi .h1 svg { opacity: .7; }',
        '.hi .g { flex: 1; min-width: 0; font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.hi .d { font-size: 11.5px; color: ' + dim + '; white-space: nowrap; }',
        '.hi .a { font-size: 12.5px; color: ' + dim + '; white-space: pre-line; line-height: 1.45; margin-top: 6px; max-height: 92px; overflow: hidden; }',
        '.hi.open .a { max-height: none; color: ' + fg + '; }',
        '.hi .acts { margin-top: 8px; }',
        '.x { all: unset; width: 26px; height: 26px; border-radius: 13px; display: grid; place-items: center; color: ' + dim + '; cursor: default; } .x:hover { background: ' + hover + '; color: ' + fg + '; } .x svg { width: 14px; height: 14px; }'
      ].join('\n');
    }

    function spark(series) {
      var W = 104, H = 24, min = Math.min.apply(null, series), max = Math.max.apply(null, series), span = max - min || 1;
      var pts = series.map(function (p, i) { return [i / (series.length - 1) * (W - 4) + 2, H - 3 - (p - min) / span * (H - 6)]; });
      var ns = 'http://www.w3.org/2000/svg', sv = document.createElementNS(ns, 'svg');
      sv.setAttribute('viewBox', '0 0 ' + W + ' ' + H); sv.setAttribute('class', 'spk');
      var pa = document.createElementNS(ns, 'path');
      pa.setAttribute('d', 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L'));
      var c = document.createElementNS(ns, 'circle'), lp = pts[pts.length - 1];
      c.setAttribute('cx', lp[0]); c.setAttribute('cy', lp[1]); c.setAttribute('r', 2.6);
      sv.append(pa, c);
      return sv;
    }

    function card(it, i, ranked) {
      var k = E('div', 'card');
      if (ranked) k.append(E('div', 'rk', String(i + 1)));
      var pic = E('div', 'pic');
      if (it.image) { var im = E('img'); im.src = it.image; im.alt = ''; im.onerror = function () { im.remove(); }; pic.append(im); }
      pic.onclick = function () { openUrl(it.url); };
      var b = E('div', 'cb');
      var nm = E('div', 'nm', it.name); nm.title = local ? 'Voir l’article' : 'Comparer les prix sur leDénicheur'; nm.onclick = function () { if (local && it.anchor != null) local.locate(it.anchor); else openUrl(it.url); };
      if (it.badge) b.append(E('span', 'bdg', it.badge));
      b.append(nm);
      var mt = E('div', 'mt');
      if (it.rating) { var s = E('span'); s.append(E('span', 'stars', '★ ' + it.rating.toLocaleString('fr-FR', { maximumFractionDigits: 1 })), document.createTextNode(' (' + (it.reviews || 0).toLocaleString('fr-FR') + ' avis)')); mt.append(s); }
      if (it.offers) mt.append(E('span', '', it.offers + ' marchand' + (it.offers > 1 ? 's' : '')));
      if (it.match != null && !local) mt.append(E('span', '', it.match + ' % de correspondance'));
      if (mt.children.length) b.append(mt);
      var pl = E('div', 'pl');
      pl.append(E('span', 'pr', it.price != null ? eur(it.price) : 'Prix indisponible'));
      if (it.shop) pl.append(E('span', 'sh', 'chez ' + it.shop + (it.stock ? ' · en stock' : '')));
      b.append(pl);
      var t = it.trend, tr = E('div', 'tr');
      var tim = { buy: ['good', 'Bon moment pour acheter'], wait: ['warn', 'Mieux vaut attendre'], ok: ['', 'Prix habituel'] }[it.timing] || null;
      if (t) {
        var txt = t.atLow ? 'Au plus bas sur ' + Math.max(t.days, 1) + ' j' : (t.vsAvg > 0 ? '+' : '') + t.vsAvg + ' % / moyenne ' + eur(t.avg);
        var tg = E('span', 'tag ' + (t.atLow || t.vsAvg <= -5 ? 'good' : t.vsAvg >= 5 ? 'warn' : ''), txt);
        tg.title = 'Sur ' + t.days + ' jours : de ' + eur(t.min) + ' à ' + eur(t.max) + ' (moyenne ' + eur(t.avg) + ')';
        tr.append(tg);
        if (t.series && t.series.length > 2) tr.append(spark(t.series));
      }
      if (tim && it.timing !== 'ok') tr.append(E('span', 'tag ' + tim[0], tim[1]));
      if (tr.children.length) b.append(tr);
      if (it.why) b.append(E('div', 'why', it.why));
      if ((it.pros && it.pros.length) || (it.cons && it.cons.length)) {
        var pc = E('div', 'pc');
        (it.pros || []).slice(0, 3).forEach(function (t) { var r = E('span', 'p'); r.append(E('b', '', '+'), document.createTextNode(t)); pc.append(r); });
        (it.cons || []).slice(0, 2).forEach(function (t) { var r = E('span', 'c'); r.append(E('b', '', '–'), document.createTextNode(t)); pc.append(r); });
        b.append(pc);
      }
      var ac = E('div', 'acts');
      if (local) {
        if (it.anchor != null) { var lo = E('button', 'btn', 'Voir sur la page'); lo.onclick = function () { local.locate(it.anchor); }; ac.append(lo); }
        if (it.url) { var op = E('button', it.anchor != null ? 'btn gh' : 'btn', 'Ouvrir l’article'); op.onclick = function () { openUrl(it.url); }; ac.append(op); }
      } else {
        if (it.offer) { var o = E('button', 'btn', 'Voir l’offre'); o.onclick = function () { openUrl(it.offer); }; ac.append(o); }
        var cp = E('button', it.offer ? 'btn gh' : 'btn', 'Comparer les prix'); cp.onclick = function () { openUrl(it.url); };
        ac.append(cp);
      }
      b.append(ac);
      k.append(pic, b);
      return k;
    }

    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('corrtex-shopping');
      root = host.attachShadow({ mode: 'closed' });
      (document.body || document.documentElement).appendChild(host);
    }

    function render() {
      ensure();
      var v = last || {};
      var prevBd = root.querySelector('.bd'), keep = prevBd ? prevBd.scrollTop : 0, keepMode = root.__mode;
      root.replaceChildren();
      root.__mode = mode;
      var st = E('style'); st.textContent = css(); root.append(st);
      var pn = E('div', 'pn');
      var hdr = E('div', 'hdr'), tt = E('div', 'tt');
      tt.append(E('h2', '', mode === 'history' ? 'Historique de l’agent' : v.title || 'Recherche d’achat'),
        E('small', '', mode === 'history' ? 'Recherches d’achat et réponses de l’agent' : v.busy ? (v.busyText || 'Recherche en cours…') : v.sub || 'Prix, suivi des prix et conseils de l’IA'));
      var hb = E('button', 'rb' + (mode === 'history' ? ' on' : '')); hb.title = mode === 'history' ? 'Revenir aux résultats' : 'Historique des recherches';
      hb.append(ic(mode === 'history' ? I.back : I.hist));
      hb.onclick = function () {
        if (mode === 'history' && (v.goal || v.rounds)) { mode = 'results'; render(); }
        else { mode = 'history'; list = null; render(); act({ action: 'history' }); }
      };
      var cl = E('button', 'rb'); cl.title = 'Fermer'; cl.append(ic(I.x)); cl.onclick = function () { if (!local) act({ action: 'close' }); hide(); };
      hdr.append(tt, hb, cl);
      var bd = E('div', 'bd');
      pn.append(hdr, bd);
      if (mode === 'history') renderHistory(bd, pn); else renderResults(v, bd, pn);
      root.append(pn);
      if (keepMode === mode && keep) bd.scrollTop = keep;
      else pn.style.animation = keepMode ? 'none' : '';
    }

    var SORTS = [['reco', 'Recommandés'], ['price', 'Prix croissant'], ['price-', 'Prix décroissant'], ['match', 'Correspondance'], ['rating', 'Note'], ['deal', 'Bonne affaire']];
    var sortBy = 'reco';
    function sortList(list, k) {
      var a = list.slice(), P = function (x) { return x.price == null ? Infinity : x.price; };
      if (k === 'price') a.sort(function (x, y) { return P(x) - P(y); });
      else if (k === 'price-') a.sort(function (x, y) { return (y.price || 0) - (x.price || 0); });
      else if (k === 'match') a.sort(function (x, y) { return (y.match || 0) - (x.match || 0); });
      else if (k === 'rating') a.sort(function (x, y) { return ((y.rating || 0) + Math.log10((y.reviews || 0) + 1) / 10) - ((x.rating || 0) + Math.log10((x.reviews || 0) + 1) / 10); });
      else if (k === 'deal') a.sort(function (x, y) { return (x.trend ? x.trend.vsAvg : 99) - (y.trend ? y.trend.vsAvg : 99); });
      return a;
    }
    function renderResults(v, bd, pn) {
      var g = E('div', 'goal');
      g.append(E('div', 'q', v.goal || ''));
      if (v.summary) g.append(E('div', 's', v.summary));
      if (v.tags && v.tags.length) { var tg = E('div', 'tags'); v.tags.forEach(function (t) { tg.append(E('span', '', t)); }); g.append(tg); }
      bd.append(g);
      if (v.steps && v.steps.length && (v.busy || !(v.rounds || []).length)) {
        var ss = E('div', 'steps');
        v.steps.forEach(function (s) { var r = E('div', 'st ' + s.s); r.append(E('i'), E('span', '', s.t)); ss.append(r); });
        bd.append(ss);
      }
      // tri : recommandés (choix de l'IA) ou tous les articles suivis par prix, correspondance, note…
      if ((v.rounds || []).length && (v.all || []).length > 1) {
        var so = E('div', 'sug sorts');
        so.append(E('span', 'lbl', 'Trier'));
        SORTS.forEach(function (x) {
          var b = E('button', x[0] === sortBy ? 'on' : '', x[1]);
          b.onclick = function () { sortBy = x[0]; render(); };
          so.append(b);
        });
        bd.append(so);
      }
      if (sortBy !== 'reco' && (v.all || []).length) {
        bd.append(E('h3', '', 'Tous les articles suivis (' + v.all.length + ')'));
        sortList(v.all, sortBy).forEach(function (it, i) { bd.append(card(it, i, false)); });
      } else (v.rounds || []).forEach(function (r, ri) {
        bd.append(E('h3', '', r.title));
        if (r.advice) { var a = E('div', 'adv'); a.append(E('b', '', r.provisional ? 'En cours : ' : 'Conseil : '), document.createTextNode(r.advice.replace(/^Classement provisoire : /, 'classement provisoire, '))); bd.append(a); }
        (r.items || []).forEach(function (it, i) { bd.append(card(it, i, ri === 0 && !r.provisional)); });
      });
      // bas du panneau : continuer / préciser
      var ft = E('div', 'ft');
      if (refineOpen) {
        var sug = E('div', 'sug');
        (v.suggestions || []).forEach(function (s) {
          var b = E('button', picked[s] ? 'on' : '', s);
          b.onclick = function () { picked[s] = !picked[s]; b.classList.toggle('on'); };
          sug.append(b);
        });
        if (sug.children.length) ft.append(sug);
        var row = E('div', 'row');
        var inp = E('input'); inp.placeholder = 'Ex. : plutôt sans fil, autonomie de 30 h, moins de 120 €'; inp.maxLength = 200;
        var go = E('button', 'btn', 'Relancer'); go.style.height = '38px';
        var send2 = function () {
          var texts = Object.keys(picked).filter(function (k) { return picked[k]; });
          if (inp.value.trim()) texts.push(inp.value.trim());
          if (!texts.length) { inp.focus(); return; }
          picked = {}; refineOpen = false;
          if (local) local.refine(texts); else act({ action: 'refine', texts: texts });
        };
        go.onclick = send2;
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') send2(); if (e.key === 'Escape') { refineOpen = false; render(); } }, true);
        row.append(inp, go);
        ft.append(row);
        setTimeout(function () { inp.focus(); }, 30);
      }
      var btns = E('div', 'row');
      var more = E('button', 'btn gh big', v.busy ? (v.busyText || 'Recherche en cours…') : v.moreLabel || 'Continuer la recherche');
      var pre = E('button', 'btn big', refineOpen ? 'Annuler' : v.refineLabel || 'Préciser la recherche');
      if (v.busy || !v.goal) { more.setAttribute('disabled', ''); pre.setAttribute('disabled', ''); }
      if (v.noRefine) pre.setAttribute('disabled', '');
      more.onclick = function () { refineOpen = false; if (local) local.more(); else act({ action: 'more' }); };
      pre.onclick = function () { refineOpen = !refineOpen; render(); };
      btns.append(more, pre);
      ft.append(btns);
      pn.append(ft);
    }

    function when(t) {
      var d = new Date(t * 1000), now = new Date();
      var same = d.toDateString() === now.toDateString();
      return same ? 'aujourd’hui ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }

    function renderHistory(bd, pn) {
      // nouvelle recherche d'achat depuis l'historique
      var row = E('div', 'row'); row.style.margin = '4px 0 14px';
      var inp = E('input'); inp.placeholder = 'Nouvelle recherche d’achat…'; inp.maxLength = 500;
      var go = E('button', 'btn', 'Chercher'); go.style.height = '38px';
      var start = function () { var g = inp.value.trim(); if (!g) { inp.focus(); return; } mode = 'results'; act({ action: 'new', goal: g }); };
      go.onclick = start;
      inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') start(); }, true);
      row.append(inp, go);
      bd.append(row);
      if (!list) { bd.append(E('div', 'empty', 'Chargement…')); return; }
      if (!list.length) { bd.append(E('div', 'empty', 'Aucune recherche pour l’instant. Demandez à l’agent du panneau IA de trouver un article, ou d’agir sur une page : ses réponses s’afficheront ici.')); return; }
      list.forEach(function (h) {
        var it = E('div', 'hi');
        var h1 = E('div', 'h1');
        h1.append(ic(h.kind === 'shopping' ? I.cart : I.bot), E('span', 'g', h.goal || ''), E('span', 'd', when(h.time || 0)));
        var del = E('button', 'x'); del.title = 'Retirer de l’historique'; del.append(ic(I.trash));
        del.onclick = function (e) { e.stopPropagation(); act({ action: 'delete', id: h.id }); list = list.filter(function (x) { return x.id !== h.id; }); render(); };
        h1.append(del);
        it.append(h1);
        if (h.answer) it.append(E('div', 'a', h.answer));
        it.onclick = function () { it.classList.toggle('open'); };
        var ac = E('div', 'acts');
        if (h.kind === 'shopping') { var o = E('button', 'btn', 'Rouvrir les résultats'); o.onclick = function (e) { e.stopPropagation(); mode = 'results'; act({ action: 'open', id: h.id }); }; ac.append(o); }
        else if (h.url) { var p = E('button', 'btn gh', 'Ouvrir la page'); p.onclick = function (e) { e.stopPropagation(); act({ action: 'open', id: h.id }); }; ac.append(p); }
        if (ac.children.length) it.append(ac);
        bd.append(it);
      });
    }

    function hide() { if (host) { host.remove(); host = null; root = null; } if (local && local.closed) local.closed(); local = null; }
    window.__corrtexShopping = {
      // panneau tenu par la page elle-même (comparaison des articles de la page) : ses boutons
      // appellent les fonctions données au lieu du moteur de recherche d'achat
      showLocal: function (v, handlers) {
        if (!local || local !== handlers) { refineOpen = false; picked = {}; }
        local = handlers;
        mode = 'results';
        last = v;
        render();
      },
      show: function (v) {
        // nouvelle recherche : retour au classement recommandé
        if (v && last && v.hid !== last.hid) sortBy = 'reco';
        local = null;
        if (v && v.history) { mode = 'history'; list = null; last = last || {}; render(); act({ action: 'history' }); return; }
        if (v && last && v.hid !== last.hid) { refineOpen = false; picked = {}; }
        if (v) last = v;
        if (mode === 'history' && v && v.goal && v.busy) mode = 'results';
        render();
      },
      hide: hide,
      history: function (l) { list = l || []; if (mode === 'history') render(); }
    };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && host && !refineOpen) { if (!local) act({ action: 'close' }); hide(); } }, true);
  })();


  // ---------------------------------------------------------------- barre de défilement et champs de texte
  // Petite barre de défilement « liquid glass » sur fond transparent (les sites qui ont la leur la gardent),
  // et pas de suggestions d'écriture du navigateur (bouton « Reformuler ») dans les champs.
  (function () {
    try { document.documentElement.setAttribute('writingsuggestions', 'false'); } catch (e) {}
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && t.nodeType === 1 && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) && !t.hasAttribute('writingsuggestions')) t.setAttribute('writingsuggestions', 'false');
    }, true);
    var css = '::-webkit-scrollbar{width:10px;height:10px;background:transparent}' +
      '::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}' +
      '::-webkit-scrollbar-button{display:none;width:0;height:0}' +
      '::-webkit-scrollbar-thumb{border-radius:10px;border:3px solid transparent;background-clip:padding-box;' +
      'background-color:rgba(150,150,160,.42);background-image:linear-gradient(180deg,rgba(255,255,255,.38),rgba(255,255,255,.06));' +
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),inset 0 1px 0 rgba(255,255,255,.45)}' +
      '::-webkit-scrollbar-thumb:hover{border-width:2px;background-color:rgba(150,150,160,.62)}' +
      '::-webkit-scrollbar-thumb:active{background-color:rgba(150,150,160,.78)}';
    function add() {
      if (document.getElementById('corrtex-scrollbar')) return;
      var st = document.createElement('style');
      st.id = 'corrtex-scrollbar';
      st.textContent = css;
      // en tête de page : les styles du site, chargés après, l'emportent s'il a sa propre barre
      var root = document.head || document.documentElement;
      if (root) root.insertBefore(st, root.firstChild);
    }
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  })();

  // ---------------------------------------------------------------- comparer les articles de la page
  // Bouton « Comparer les articles de la page » du panneau IA : les articles affichés sur la page
  // (données structurées, sinon cartes avec prix, lien et image) sont envoyés à l'IA avec les besoins
  // de l'utilisateur ; les meilleurs choix s'affichent dans le panneau en verre.
  (function () {
    var els = [], items = [], needs = '', refinements = [], seq = 0, waiting = null, pageInfo = null;
    var PRICE = /(\d{1,3}(?:[\s  .]\d{3})*(?:[.,]\d{1,2})?)\s?€|€\s?(\d{1,3}(?:[\s  .]\d{3})*(?:[.,]\d{1,2})?)/;
    function num(s) { if (s == null) return null; var n = parseFloat(String(s).replace(/[\s  ]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')); return isFinite(n) && n > 0 ? n : null; }
    function clean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
    function abs(u) { try { return u ? new URL(u, location.href).href : ''; } catch (e) { return ''; } }

    // articles décrits par les données structurées de la page (schema.org)
    function fromLd() {
      var out = [];
      function walk(o, depth) {
        if (!o || typeof o !== 'object' || depth > 6 || out.length > 60) return;
        if (Array.isArray(o)) { o.forEach(function (x) { walk(x, depth + 1); }); return; }
        var t = [].concat(o['@type'] || []).join(' ');
        if (/Product/.test(t) && o.name) {
          var of = [].concat(o.offers || [])[0] || {};
          var ag = o.aggregateRating || {};
          out.push({ name: clean(o.name), price: num(of.price || of.lowPrice), url: abs(o.url || of.url), image: abs([].concat(o.image || [])[0] && ([].concat(o.image)[0].url || [].concat(o.image)[0])),
            rating: num(ag.ratingValue), reviews: parseInt(ag.reviewCount || ag.ratingCount || 0, 10) || 0, details: clean((o.brand && (o.brand.name || o.brand)) ? 'Marque : ' + (o.brand.name || o.brand) + '. ' : '') + clean(o.description).slice(0, 160) });
          return;
        }
        if (o.itemListElement) walk(o.itemListElement, depth + 1);
        if (o.item) walk(o.item, depth + 1);
        if (o['@graph']) walk(o['@graph'], depth + 1);
      }
      document.querySelectorAll('script[type="application/ld+json"]').forEach(function (sc) { try { walk(JSON.parse(sc.textContent), 0); } catch (e) {} });
      return out;
    }

    // cartes d'articles visibles : un prix, un lien et une image dans un même bloc
    function fromDom() {
      var out = [], cards = [], seen = new Set(), priceOf = new Map();
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n, count = 0;
      while ((n = w.nextNode()) && count < 6000 && cards.length < 60) {
        count++;
        var t = n.data;
        if (t.length > 60 || !PRICE.test(t)) continue;
        var el = n.parentElement, card = null;
        for (var k = 0; el && k < 9; k++, el = el.parentElement) {
          if (el === document.body) break;
          if (!el.querySelector('a[href]') || !el.querySelector('img')) continue;
          var r = el.getBoundingClientRect();
          if (r.height < 90 || r.height > 1000 || r.width > innerWidth * 0.75 || r.width < 90) continue;
          if (el.textContent.length > 2500) break;
          card = el;
          break;
        }
        if (!card || seen.has(card)) continue;
        // un bloc qui contient déjà une carte retenue (ou l'inverse) n'est pas une nouvelle carte
        if (cards.some(function (c) { return c.contains(card) || card.contains(c); })) continue;
        seen.add(card);
        cards.push(card);
        // le prix vient du texte qui a fait repérer la carte (pas des chiffres du titre)
        var pm0 = t.match(PRICE);
        if (pm0) priceOf.set(card, num(pm0[1] || pm0[2]));
      }
      cards.forEach(function (c) {
        var title = '';
        var cand = c.querySelectorAll('h1, h2, h3, h4, [class*="title" i], [class*="name" i], [itemprop="name"], a[title]');
        for (var i = 0; i < cand.length && !title; i++) {
          var tx = clean(cand[i].getAttribute('title') || cand[i].textContent);
          if (tx.length >= 6 && tx.length <= 220 && !PRICE.test(tx)) title = tx;
        }
        if (!title) {
          var best = '';
          c.querySelectorAll('a').forEach(function (a) { var tx = clean(a.textContent); if (tx.length > best.length && tx.length < 220 && !PRICE.test(tx)) best = tx; });
          title = best || clean((c.querySelector('img') || {}).alt);
        }
        if (!title) return;
        var text = clean(c.innerText || c.textContent);
        var pm = text.match(PRICE);
        var img = c.querySelector('img');
        var src = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
        var rm = text.match(/(\d[.,]\d)\s*(?:\/\s*5|sur 5|étoiles?)/i) || (c.querySelector('[aria-label*="5"]') && (c.querySelector('[aria-label*="5"]').getAttribute('aria-label').match(/(\d[.,]\d)/)));
        var rv = text.match(/\(?(\d[\d\s .]*)\s*(?:avis|évaluations?|notes?)\)?/i);
        out.push({ name: title, price: priceOf.has(c) ? priceOf.get(c) : pm ? num(pm[1] || pm[2]) : null, url: abs((c.querySelector('a[href]') || {}).getAttribute ? c.querySelector('a[href]').getAttribute('href') : ''),
          image: /^data:/.test(src) && src.length < 400 ? '' : abs(src), rating: rm ? num(rm[1]) : null, reviews: rv ? parseInt(rv[1].replace(/\D/g, ''), 10) || 0 : 0,
          details: text.replace(title, '').slice(0, 200), el: c });
      });
      return out;
    }

    function collect() {
      var dom = fromDom(), ld = fromLd();
      // les cartes de la page sont préférées (on peut y faire défiler) ; les données structurées complètent
      var list = dom.length >= 2 ? dom : ld.length >= 2 ? ld : dom.concat(ld);
      var seen = {}, res = [];
      list.forEach(function (it) {
        var key = (it.name || '').toLowerCase().slice(0, 70);
        if (!key || seen[key]) return;
        seen[key] = 1;
        if (!it.el && it.url) {
          var a = document.querySelector('a[href="' + it.url.replace(/"/g, '') + '"]') || null;
          if (a) it.el = a.closest('li, article, div') || a;
        }
        res.push(it);
      });
      return res.slice(0, 40);
    }

    var eur = function (n) { return n == null ? '?' : n.toLocaleString('fr-FR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €'; };
    function json(text) {
      var t = String(text || '').replace(/```(?:json)?/g, '');
      var i = t.indexOf('{'), j = t.lastIndexOf('}');
      if (i < 0 || j < i) return null;
      try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { return null; }
    }

    function base(extra) {
      var host = location.hostname.replace(/^www\./, '');
      return Object.assign({ title: 'Comparaison des articles', sub: host + ' · ' + items.length + ' article' + (items.length > 1 ? 's' : '') + ' comparés',
        goal: needs || 'Comparaison générale (qualité, prix)', summary: '', tags: refinements.slice(), steps: [], rounds: [], suggestions: [],
        moreLabel: 'Chercher ailleurs', refineLabel: 'Préciser mes besoins', busyText: 'Comparaison en cours…' }, extra || {});
    }

    var handlers = {
      locate: function (n) {
        var el = els[n];
        if (!el || !el.isConnected) { if (items[n] && items[n].url) send('open_new_tab', { url: items[n].url }); return; }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var o = el.style.outline, oo = el.style.outlineOffset, br = el.style.borderRadius;
        el.style.outline = '3px solid ' + (cxTheme().accent || '#ff4f7b');
        el.style.outlineOffset = '4px';
        if (!br) el.style.borderRadius = '12px';
        setTimeout(function () { el.style.outline = o; el.style.outlineOffset = oo; el.style.borderRadius = br; }, 2600);
      },
      refine: function (texts) { refinements = refinements.concat(texts).slice(-6); ask(); },
      more: function () { send('shopping_action', { action: 'new', goal: needs ? needs + (refinements.length ? ' (' + refinements.join(', ') + ')' : '') : document.title }); },
      closed: function () { waiting = null; }
    };

    function ask() {
      var req = 'pc' + (++seq);
      waiting = req;
      var steps = [{ t: items.length + ' articles trouvés sur la page', s: 'ok' }, { t: 'L’IA compare les articles selon vos besoins…', s: 'run' }];
      window.__corrtexShopping.showLocal(base({ busy: true, steps: steps }), handlers);
      var rows = items.map(function (it, i) {
        return i + ' | ' + it.name.slice(0, 140) + ' | ' + eur(it.price) + ' | ' + (it.rating ? it.rating + '/5' + (it.reviews ? ' (' + it.reviews + ' avis)' : '') : 'pas de note') + ' | ' + clean(it.details).slice(0, 150);
      });
      var prompt = 'Je regarde la page « ' + document.title.slice(0, 150) + ' » (' + location.hostname + ').\n' +
        'Mes besoins : ' + (needs ? '« ' + needs + ' »' : 'pas de besoin précis : compare de manière générale (qualité, prix, avis).') +
        (refinements.length ? '\nPrécisions : ' + refinements.join(' ; ') : '') +
        '\n\nVoici les articles présents sur la page :\nn | nom | prix | note | détails\n' + rows.join('\n') + '\n\n' +
        'Compare ces articles selon mes besoins et choisis les 3 à 5 meilleurs choix, du meilleur au moins bon. Écarte ceux qui ne correspondent pas. ' +
        'Réponds UNIQUEMENT par un objet JSON, sans aucun texte autour :\n' +
        '{"picks":[{"n":0,"badge":"Meilleur choix | Meilleur rapport qualité-prix | Le moins cher | Haut de gamme | …","why":"pourquoi, en une ou deux phrases concrètes","pros":["2 ou 3 points forts courts"],"cons":["1 ou 2 points faibles courts"]}],"advice":"conseil d’ensemble en deux phrases au plus","refine":["2 à 4 précisions utiles que je pourrais donner, formulées comme des choix très courts"]}';
      send('page_cmp_ai', { req: req, prompt: prompt.slice(0, 12000) });
    }

    window.__corrtexPageCmpAI = function (req, text, done, error) {
      if (req !== waiting || !(done || error)) return;
      waiting = null;
      var r = json(text);
      if (!r || !Array.isArray(r.picks)) {
        window.__corrtexShopping.showLocal(base({ steps: [{ t: items.length + ' articles trouvés sur la page', s: 'ok' }, { t: error && !text ? 'Pas de réponse de l’IA : vérifiez que vous êtes connecté au service d’IA du panneau.' : 'Réponse de l’IA illisible : réessayez avec « Préciser mes besoins ».', s: 'err' }] }), handlers);
        return;
      }
      var host = location.hostname.replace(/^www\./, '');
      var picks = [];
      r.picks.forEach(function (p) {
        var it = items[+p.n];
        if (!it || picks.some(function (x) { return x.anchor === +p.n; })) return;
        picks.push({ id: String(p.n), anchor: +p.n, name: it.name, image: it.image, url: it.url, price: it.price, shop: host, rating: it.rating, reviews: it.reviews,
          offers: 0, trend: null, why: String(p.why || ''), timing: 'ok', badge: String(p.badge || '').slice(0, 40),
          pros: (Array.isArray(p.pros) ? p.pros : []).map(String), cons: (Array.isArray(p.cons) ? p.cons : []).map(String) });
      });
      picks = picks.slice(0, 5);
      window.__corrtexShopping.showLocal(base({ rounds: [{ title: 'Meilleurs choix', advice: String(r.advice || ''), items: picks }],
        suggestions: (Array.isArray(r.refine) ? r.refine : []).map(String).slice(0, 4) }), handlers);
      // gardé dans l'historique de l'agent
      var lines = picks.map(function (p, i) { return (i + 1) + '. ' + p.name + (p.price != null ? ' — ' + eur(p.price) : '') + (p.badge ? ' (' + p.badge + ')' : ''); });
      send('page_cmp_done', { needs: needs || 'Comparaison générale', answer: lines.join('\n') + (r.advice ? '\n' + r.advice : ''), title: document.title.slice(0, 200) });
    };

    window.__corrtexPageCompare = function (n) {
      needs = clean(n).slice(0, 400);
      refinements = [];
      items = collect();
      els = items.map(function (it) { return it.el || null; });
      items.forEach(function (it) { delete it.el; });
      if (items.length < 2) {
        window.__corrtexShopping.showLocal(base({ sub: location.hostname.replace(/^www\./, ''), noRefine: true,
          steps: [{ t: items.length ? 'Un seul article trouvé sur cette page : ouvrez une page de liste ou de résultats (catégorie, recherche…) pour comparer.' : 'Aucun article trouvé sur cette page. Ouvrez une page de boutique qui affiche plusieurs articles avec leurs prix.', s: 'err' }] }), handlers);
        return;
      }
      ask();
    };
  })();

  // ---------------------------------------------------------------- traduction de la page
  // Le texte de la page est traduit en place (mise en page intacte) par morceaux ; les morceaux
  // visibles d'abord. Les contenus ajoutés ensuite (défilement infini…) sont traduits aussi.
  (function () {
    var on = false, orig = new Map(), seq = 0, pending = {}, queue = [], inflight = 0, total = 0, doneCount = 0;
    var obs = null, mtimer = 0, pill = null, pillTxt = null, hideT = 0;
    var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|SVG|MATH|INPUT|SELECT|OPTION|TEMPLATE)$/;
    function okNode(n) {
      var p = n.parentElement;
      if (!p || SKIP.test(p.tagName) || orig.has(n) || n.__cxq) return false;
      if (p.closest('corrtex-menu, corrtex-bubble, corrtex-find, corrtex-reader, corrtex-agent, corrtex-tr, corrtex-yt, corrtex-write, corrtex-shop, [translate="no"], .notranslate, [contenteditable=""], [contenteditable="true"]')) return false;
      var t = n.nodeValue;
      return t && t.trim().length >= 2 && /\p{L}/u.test(t);
    }
    // les mots en gras / italique d'une phrase sont traduits avec la phrase entière :
    // les morceaux de texte d'un même bloc forment un seul segment (les liens restent à part)
    var INLINE = /^(B|I|EM|STRONG|SPAN|U|SMALL|MARK|SUB|SUP|FONT|ABBR|CITE|Q|S|DEL|INS|TIME|BDI|BDO|DFN|VAR|WBR)$/;
    function container(n) {
      var p = n.parentElement;
      while (p && INLINE.test(p.tagName) && p.parentElement) p = p.parentElement;
      return p;
    }
    function collect(root) {
      var groups = [], cur = null, curC = null, curLen = 0;
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return okNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
      var n;
      while ((n = w.nextNode())) {
        var c = container(n), len = n.nodeValue.length;
        if (cur && c === curC && curLen + len < 1500) { cur.push(n); curLen += len; }
        else { cur = [n]; curC = c; curLen = len; groups.push(cur); }
      }
      return groups;
    }
    function inView(g) {
      try { var r = g[0].parentElement.getBoundingClientRect(); return r.bottom > -200 && r.top < window.innerHeight * 1.6; } catch (e) { return false; }
    }
    function decode(s) {
      return String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }
    function textOf(g) { return g.map(function (n) { return n.nodeValue; }).join('').replace(/\s+/g, ' ').trim(); }
    function enqueue(groups) {
      if (!groups.length) return;
      groups.sort(function (a, b) { return inView(b) - inView(a); });
      var batch = [], size = 0;
      groups.forEach(function (g) {
        g.forEach(function (n) { n.__cxq = true; });
        var len = textOf(g).length;
        if (batch.length && (batch.length >= 60 || size + len > 3800)) { queue.push(batch); batch = []; size = 0; }
        batch.push(g); size += len;
      });
      if (batch.length) queue.push(batch);
      total += groups.length;
      pump();
      showPill();
    }
    function pump() {
      while (on && inflight < 3 && queue.length) {
        var b = queue.shift();
        var id = ++seq;
        pending[id] = b;
        inflight++;
        send('translate', { batch: id, texts: b.map(textOf), to: 'fr' });
      }
    }
    window.__corrtexTranslated = function (id, arr) {
      var groups = pending[id];
      if (!groups) return;
      delete pending[id];
      inflight = Math.max(0, inflight - 1);
      groups.forEach(function (g, i) {
        g.forEach(function (n) { n.__cxq = false; });
        if (!on || !Array.isArray(arr) || typeof arr[i] !== 'string' || !arr[i].trim()) return;
        if (!g.every(function (n) { return n.isConnected; })) return;
        // toute la phrase dans le premier morceau, les autres vidés (aucun élément n'est retiré)
        g.forEach(function (n, k) {
          orig.set(n, n.nodeValue);
          if (k === 0) {
            var m = n.nodeValue.match(/^(\s*)/), last = g[g.length - 1].nodeValue.match(/(\s*)$/);
            n.nodeValue = m[1] + decode(arr[i]).trim() + (g.length === 1 ? n.nodeValue.match(/(\s*)$/)[1] : '');
            if (g.length > 1) g[g.length - 1].__cxTail = last[1];
          } else {
            n.nodeValue = k === g.length - 1 ? (n.__cxTail || '') : '';
          }
        });
      });
      doneCount += groups.length;
      if (!Array.isArray(arr) && on) setPill('Traduction impossible pour le moment', true);
      else showPill();
      pump();
    };
    function ensurePill() {
      if (pill && pill.host.isConnected) return;
      var th = cxTheme();
      pill = cxHost('corrtex-tr', [
        '.p { position: fixed; z-index: 2147483646; top: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;',
        '  padding: 6px 6px 6px 14px; border-radius: 22px; font-size: 13px; animation: in .2s ease-out; }',
        '@keyframes in { from { opacity: 0; transform: translate(-50%, -8px); } }',
        '.p svg { width: 16px; height: 16px; fill: none; stroke: ' + th.accent + '; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }',
        '.p button { width: auto; min-height: 30px; height: 30px; padding: 0 12px; border-radius: 15px; font-size: 12.5px; font-weight: 600; }',
        '.p .x { padding: 0; width: 30px; justify-content: center; }',
        '.p .x svg { stroke: currentColor; width: 13px; height: 13px; }'
      ].join('\n'));
      var p = document.createElement('div');
      p.className = 'card p';
      p.appendChild(cxIcon('M4 5.5h9M8.5 3.5v2M6 5.5c.6 3 2.6 5.4 5 6.5M11 5.5c-.7 3.4-3 6-6.5 7.5M13 20.5l3.8-9 3.7 9M14.3 17.5h5'));
      pillTxt = document.createElement('span');
      var back = document.createElement('button');
      back.textContent = 'Afficher l’original';
      back.addEventListener('click', function () { window.__corrtexTranslatePage(); });
      var x = document.createElement('button');
      x.className = 'x';
      x.appendChild(cxIcon('M6 6l12 12M18 6L6 18'));
      x.addEventListener('click', function () { pill.host.remove(); });
      p.append(pillTxt, back, x);
      pill.root.appendChild(p);
    }
    function setPill(text) {
      ensurePill();
      pillTxt.textContent = text;
      clearTimeout(hideT);
    }
    function showPill() {
      if (!on) return;
      var pct = total ? Math.min(100, Math.round(doneCount / total * 100)) : 0;
      if (doneCount < total) setPill('Traduction en français… ' + pct + ' %');
      else {
        setPill('Page traduite en français');
        hideT = setTimeout(function () { if (pill) pill.host.remove(); }, 4000);
      }
    }
    window.__corrtexTranslatePage = function () {
      if (on) {
        on = false;
        if (obs) { obs.disconnect(); obs = null; }
        orig.forEach(function (v, n) { if (n.isConnected) n.nodeValue = v; });
        orig.clear(); queue = []; pending = {}; inflight = 0; total = 0; doneCount = 0;
        if (pill) pill.host.remove();
        send('translated', false);
        return;
      }
      if (!document.body) return;
      on = true;
      send('translated', true);
      enqueue(collect(document.body));
      if (!total) setPill('Rien à traduire sur cette page');
      document.title && send('translated', true);
      obs = new MutationObserver(function (muts) {
        if (!on) return;
        var added = false;
        muts.forEach(function (m) { if (m.addedNodes.length) added = true; });
        if (!added) return;
        clearTimeout(mtimer);
        mtimer = setTimeout(function () { enqueue(collect(document.body)); }, 700);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    };
  })();

  // ---------------------------------------------------------------- YouTube : résumer la vidéo et en discuter
  (function () {
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function hms(ms) {
      var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
      return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0');
    }
    function videoTitle() {
      var h = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1');
      return ((h && h.textContent) || document.title.replace(/\s*-\s*YouTube$/, '')).trim();
    }
    async function transcript() {
      // 1. sous-titres du lecteur
      try {
        var pl = document.getElementById('movie_player');
        var pr = pl && pl.getPlayerResponse && pl.getPlayerResponse();
        var tracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (tracks && tracks.length) {
          var t = tracks.filter(function (x) { return /^fr/.test(x.languageCode); })[0] || tracks.filter(function (x) { return x.kind !== 'asr'; })[0] || tracks[0];
          var r = await fetch(t.baseUrl + '&fmt=json3', { credentials: 'include' });
          var j = JSON.parse(await r.text());
          var out = [];
          (j.events || []).forEach(function (ev) {
            if (!ev.segs) return;
            var tx = ev.segs.map(function (s) { return s.utf8 || ''; }).join('').replace(/\s+/g, ' ').trim();
            if (tx) out.push('[' + hms(ev.tStartMs || 0) + '] ' + tx);
          });
          if (out.length) return out.join('\n');
        }
      } catch (e) {}
      // 2. panneau « Transcription » de YouTube
      try {
        var segs = document.querySelectorAll('ytd-transcript-segment-renderer');
        var opened = false;
        if (!segs.length) {
          var btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
          if (!btn) {
            var exp = document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand');
            if (exp) { exp.click(); await wait(700); }
            btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
          }
          if (btn) {
            btn.click(); opened = true;
            for (var i = 0; i < 30 && !segs.length; i++) { await wait(300); segs = document.querySelectorAll('ytd-transcript-segment-renderer'); }
          }
        }
        if (segs.length) {
          var lines = Array.prototype.map.call(segs, function (s) {
            var ts = s.querySelector('.segment-timestamp'), tx = s.querySelector('.segment-text, yt-formatted-string');
            return (ts ? '[' + ts.textContent.trim() + '] ' : '') + (tx ? tx.textContent.trim() : '');
          });
          if (opened) {
            var close = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"] #visibility-button button');
            if (close) close.click();
          }
          return lines.join('\n');
        }
      } catch (e) {}
      return '';
    }
    var busy = false, yt = null, ytBtn = null, ytLabel = null;
    window.__corrtexYtSummary = async function () {
      if (busy) return;
      busy = true;
      if (ytLabel) ytLabel.textContent = 'Lecture de la vidéo…';
      var text = '';
      try { text = await transcript(); } catch (e) {}
      send('yt_transcript', { text: text.slice(0, 30000), title: videoTitle() });
      if (ytLabel) ytLabel.textContent = 'Résumé envoyé au panneau IA';
      setTimeout(function () { busy = false; if (ytLabel) ytLabel.textContent = 'Résumer la vidéo'; }, 3000);
    };
    // bouton « Résumer la vidéo » sous le titre
    function ensureButton() {
      if (location.pathname !== '/watch') { if (yt) { yt.host.remove(); yt = null; } return; }
      var anchor = document.querySelector('ytd-watch-metadata #title');
      if (!anchor) return;
      if (yt && yt.host.isConnected && yt.host.parentNode === anchor) return;
      if (yt) yt.host.remove();
      var th = cxTheme();
      var h = document.createElement('corrtex-yt');
      var r = h.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = [
        ':host { all: initial; display: inline-block; margin: 8px 0 2px; }',
        'button { all: unset; display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 16px; border-radius: 17px; cursor: pointer;',
        '  font: 600 13.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: ' + (th.scheme === 'light' ? '#111' : '#f4f4f6') + ';',
        '  background: ' + (th.scheme === 'light' ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.1)') + '; border: 1px solid ' + (th.scheme === 'light' ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.22)') + '; }',
        'button:hover { background: ' + (th.scheme === 'light' ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.16)') + '; }',
        'svg { width: 15px; height: 15px; fill: ' + th.accent + '; filter: drop-shadow(0 0 4px ' + th.accent + '); }'
      ].join('\n');
      ytBtn = document.createElement('button');
      ytLabel = document.createElement('span');
      ytLabel.textContent = 'Résumer la vidéo';
      ytBtn.append(cxSpark(), ytLabel);
      ytBtn.title = 'Résumé de la vidéo dans le panneau IA, puis posez vos questions';
      ytBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); window.__corrtexYtSummary(); });
      r.append(st, ytBtn);
      anchor.appendChild(h);
      yt = { host: h };
    }
    setInterval(ensureButton, 1500);
  })();

  // ---------------------------------------------------------------- agent de navigation
  // L'IA propose une action à la fois (cliquer, écrire, choisir, faire défiler, ouvrir) ;
  // chaque action est montrée et surlignée, et n'est faite qu'après validation.
  (function () {
    var ui = null, card = null, body = null, hl = null, hlEl = null, els = [], goal = '', step = 0, snapT = 0;
    var SEL = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=menuitem], [role=option], [role=combobox], [role=searchbox], [role=switch], [contenteditable="true"]';
    function sensitive(el) {
      var s = ((el.type || '') + ' ' + (el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || '') + ' ' + (el.getAttribute && el.getAttribute('aria-label') || '')).toLowerCase();
      return /password|passwd|mot de passe|cc-|card|carte|cvc|cvv|iban|otp|one-time|code de v/.test(s);
    }
    function label(el) {
      var t = el.getAttribute('aria-label') || '';
      if (!t && el.labels && el.labels[0]) t = el.labels[0].innerText;
      if (!t) t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('alt') || '';
      if (!t) { var img = el.querySelector && el.querySelector('img[alt]'); if (img) t = img.alt; }
      if (!t && (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type))) t = el.value;
      return t.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    function describe(el, i) {
      var tag = el.tagName, role = el.getAttribute('role') || '', lb = label(el), out = '[' + i + '] ';
      if (tag === 'A' || role === 'link') {
        var href = '';
        try { var u = new URL(el.href, location.href); href = (u.host === location.host ? '' : u.host) + u.pathname.slice(0, 50); } catch (e) {}
        out += 'lien « ' + lb + ' »' + (href ? ' → ' + href : '');
      } else if (tag === 'SELECT') {
        var opts = Array.prototype.slice.call(el.options, 0, 8).map(function (o) { return o.text.trim(); }).join(' | ');
        out += 'liste « ' + lb + ' » (choix : ' + opts + ') valeur : ' + (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text.trim() : '');
      } else if (tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(submit|button|checkbox|radio|reset|image|file)$/i.test(el.type)) || el.isContentEditable || role === 'searchbox' || role === 'combobox') {
        var v = sensitive(el) ? '(champ sensible)' : ((el.value || (el.isContentEditable ? el.innerText : '') || '').trim().slice(0, 60));
        out += 'champ ' + (el.type && tag === 'INPUT' ? el.type : 'texte') + ' « ' + lb + ' »' + (v ? ' valeur : « ' + v + ' »' : ' (vide)');
      } else if (tag === 'INPUT' && /^(checkbox|radio)$/i.test(el.type) || role === 'checkbox' || role === 'radio' || role === 'switch') {
        var on = el.checked || el.getAttribute('aria-checked') === 'true';
        out += 'case « ' + lb + ' » ' + (on ? '(cochée)' : '(non cochée)');
      } else {
        out += 'bouton « ' + lb + ' »';
      }
      return out;
    }
    function visible(el) {
      if (el.closest('corrtex-agent, corrtex-menu, corrtex-bubble, corrtex-write, corrtex-tr')) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
    }
    function snapshot() {
      clearTimeout(snapT);
      els = [];
      var lines = [];
      var all = document.querySelectorAll(SEL);
      for (var i = 0; i < all.length && els.length < 90; i++) {
        var el = all[i];
        if (!visible(el)) continue;
        if (!label(el) && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
        lines.push(describe(el, els.length));
        els.push(el);
      }
      var doc = document.documentElement;
      var pct = Math.round(window.scrollY / Math.max(1, doc.scrollHeight - window.innerHeight) * 100);
      var txt = ((document.body && document.body.innerText) || '').replace(/\n{2,}/g, '\n').slice(0, 3500);
      var page = 'Titre : ' + document.title + '\nAdresse : ' + location.href.slice(0, 300) +
        '\nDéfilement : ' + (doc.scrollHeight <= window.innerHeight + 10 ? 'page entière visible' : pct + ' % de la page') +
        '\n\nÉléments visibles :\n' + (lines.join('\n') || '(aucun)') + '\n\nTexte de la page (extrait) :\n' + txt;
      status('Je réfléchis à la prochaine étape…', true);
      send('agent_snap', { page: page });
    }
    function css() {
      var th = cxTheme(), dark = th.scheme !== 'light';
      return [
        '.ag { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px; width: 350px; max-width: calc(100vw - 36px); padding: 14px 14px 14px; animation: in .22s ease-out; }',
        '@keyframes in { from { opacity: 0; transform: translateY(10px); } }',
        '.hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }',
        '.hd > svg { width: 16px; height: 16px; fill: ' + th.accent + '; filter: drop-shadow(0 0 5px ' + th.accent + '); flex: none; }',
        '.hd b { flex: 1; font-size: 14.5px; }',
        '.x { width: 30px !important; min-height: 30px !important; height: 30px; padding: 0 !important; border-radius: 50%; justify-content: center; }',
        '.x svg { width: 13px !important; height: 13px !important; }',
        '.goal { font-size: 12.5px; padding: 8px 12px; border-radius: 12px; background: ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)') + '; margin-bottom: 10px; color: ' + (dark ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.65)') + '; }',
        '.bd { font-size: 13.5px; line-height: 1.45; max-height: 260px; overflow-y: auto; user-select: text; }',
        '.bd p { margin: 0 0 6px; }',
        '.st { display: flex; align-items: center; gap: 10px; color: ' + (dark ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.6)') + '; }',
        '.ring { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(127,127,127,.3); border-top-color: ' + th.accent + '; animation: spin .75s linear infinite; flex: none; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        '.act { padding: 10px 12px; border-radius: 12px; border: 1px solid ' + th.accent + '66; background: ' + th.accent + '1a; margin-bottom: 6px; }',
        '.act b { display: block; margin-bottom: 3px; }',
        '.why { font-size: 12.5px; opacity: .8; }',
        '.btns { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }',
        '.btns button { width: auto; min-height: 34px; height: 34px; padding: 0 14px; border-radius: 17px; font-weight: 600; font-size: 13px; }',
        '.btns .go { background: ' + th.accent + '; color: #fff; }',
        '.btns .go:hover { filter: brightness(1.1); background: ' + th.accent + '; }',
        'input.q { all: unset; box-sizing: border-box; width: 100%; height: 36px; margin-top: 8px; padding: 0 12px; border-radius: 12px; font-size: 13.5px;',
        '  background: ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)') + '; border: 1px solid ' + (dark ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.14)') + '; }',
        '.hl { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid ' + th.accent + '; border-radius: 8px; box-shadow: 0 0 0 4px ' + th.accent + '33, 0 0 18px ' + th.accent + '88; transition: all .15s ease; }'
      ].join('\n');
    }
    function ensureUi() {
      if (ui && ui.host.isConnected) return;
      ui = cxHost('corrtex-agent', css());
      card = document.createElement('div');
      card.className = 'card ag';
      var hd = document.createElement('div'); hd.className = 'hd';
      var t = document.createElement('b'); t.textContent = 'Agent Corrtex';
      var x = document.createElement('button'); x.className = 'x'; x.title = 'Arrêter l’agent';
      x.appendChild(cxIcon('M6 6l12 12M18 6L6 18'));
      x.addEventListener('click', stop);
      hd.append(cxSpark(), t, x);
      var g = document.createElement('div'); g.className = 'goal'; g.id = 'g';
      body = document.createElement('div'); body.className = 'bd';
      card.append(hd, g, body);
      hl = document.createElement('div'); hl.className = 'hl'; hl.style.display = 'none';
      ui.root.append(card, hl);
    }
    function setGoal() { var g = ui.root.getElementById('g'); g.textContent = 'Objectif : ' + goal + (step ? ' · étape ' + (step + 1) : ''); }
    function clear() { body.replaceChildren(); highlight(null); }
    function status(text, spin) {
      if (!ui) return;
      clear();
      var s = document.createElement('div'); s.className = 'st';
      if (spin) { var r = document.createElement('div'); r.className = 'ring'; s.appendChild(r); }
      var sp = document.createElement('span'); sp.textContent = text; s.appendChild(sp);
      body.appendChild(s);
    }
    function btns(list) {
      var d = document.createElement('div'); d.className = 'btns';
      list.forEach(function (b) {
        var e = document.createElement('button'); e.textContent = b[0];
        if (b[2]) e.className = b[2];
        e.addEventListener('click', b[1]);
        d.appendChild(e);
      });
      body.appendChild(d);
      return d;
    }
    function highlight(el) {
      hlEl = el;
      if (!hl) return;
      if (!el || !el.isConnected) { hl.style.display = 'none'; return; }
      var r = el.getBoundingClientRect();
      hl.style.display = '';
      hl.style.left = (r.left - 4) + 'px'; hl.style.top = (r.top - 4) + 'px';
      hl.style.width = (r.width + 8) + 'px'; hl.style.height = (r.height + 8) + 'px';
    }
    window.addEventListener('scroll', function () { if (hlEl) highlight(hlEl); }, true);
    function stop() {
      send('agent_stop', null);
      clearTimeout(snapT);
      if (ui) { ui.host.remove(); ui = null; }
    }
    function next(delay) { clearTimeout(snapT); snapT = setTimeout(snapshot, delay); }
    function stepDone(desc, delay) { step++; send('agent_step', { desc: desc }); setGoal(); next(delay || 1600); }
    function para(text) { var p = document.createElement('p'); p.textContent = text; body.appendChild(p); }

    function exec(a, el) {
      if (a.action === 'click') {
        el.scrollIntoView({ block: 'center' });
        if (el.tagName === 'A' && el.target && el.target !== '_self' && /^https?:/.test(el.href)) { location.href = el.href; return true; }
        try { el.focus({ preventScroll: true }); } catch (e) {}
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) {
          try { el.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, view: window })); } catch (e) {}
        });
        el.click();
        return true;
      }
      if (a.action === 'type') {
        if (sensitive(el)) return false;
        el.scrollIntoView({ block: 'center' });
        el.focus();
        var text = String(a.text || '');
        if (el.isContentEditable) {
          var r = document.createRange(); r.selectNodeContents(el);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          document.execCommand('insertText', false, text);
        } else {
          var proto = Object.getPrototypeOf(el), d = Object.getOwnPropertyDescriptor(proto, 'value');
          if (d && d.set) d.set.call(el, text); else el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (a.enter) {
          var opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          var ok = el.dispatchEvent(new KeyboardEvent('keydown', opts));
          el.dispatchEvent(new KeyboardEvent('keypress', opts));
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          if (ok && el.form) { try { el.form.requestSubmit(); } catch (e) { try { el.form.submit(); } catch (e2) {} } }
        }
        return true;
      }
      if (a.action === 'select') {
        var want = String(a.value || '').toLowerCase();
        var o = Array.prototype.find.call(el.options || [], function (x) { return x.text.trim().toLowerCase() === want || x.value.toLowerCase() === want; }) ||
                Array.prototype.find.call(el.options || [], function (x) { return x.text.toLowerCase().indexOf(want) >= 0; });
        if (!o) return false;
        el.value = o.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (a.action === 'open') {
        if (!/^https?:\/\//i.test(a.url || '')) return false;
        location.href = a.url;
        return true;
      }
      return false;
    }
    function human(a, el) {
      var lb = el ? label(el) || el.tagName.toLowerCase() : '';
      switch (a.action) {
        case 'click': return 'Cliquer sur « ' + lb + ' »';
        case 'type': return 'Écrire « ' + String(a.text || '').slice(0, 80) + ' » dans « ' + lb + ' »' + (a.enter ? ' puis valider' : '');
        case 'select': return 'Choisir « ' + a.value + ' » dans « ' + lb + ' »';
        case 'open': return 'Ouvrir ' + String(a.url || '').slice(0, 90);
        case 'scroll': return a.dir === 'up' ? 'Remonter dans la page' : 'Faire défiler la page';
        default: return a.action;
      }
    }
    function parse(text) {
      var s = String(text || ''), i = s.indexOf('{');
      while (i >= 0) {
        var depth = 0, inStr = false, esc = false;
        for (var j = i; j < s.length; j++) {
          var c = s[j];
          if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') inStr = true;
          else if (c === '{') depth++;
          else if (c === '}') { depth--; if (!depth) { try { var o = JSON.parse(s.slice(i, j + 1)); if (o && o.action) return o; } catch (e) {} break; } }
        }
        i = s.indexOf('{', i + 1);
      }
      return null;
    }
    function failed(msg) {
      clear();
      para(msg);
      btns([['Arrêter', stop], ['Réessayer', function () { send('agent_retry', null); status('Nouvel essai…', true); next(300); }, 'go']]);
    }
    window.__corrtexAgentReply = function (_id, text, done, error) {
      if (!ui) return;
      if (!done) { status('L’IA réfléchit…', true); return; }
      if (error || !text) { failed('L’IA n’a pas répondu à temps.'); return; }
      var a = parse(text);
      if (!a) { failed('Réponse de l’IA incompréhensible.'); return; }
      clear();
      if (a.action === 'done') {
        // la réponse est gardée dans l'historique de l'agent (avant l'arrêt, qui oublie la mission)
        send('agent_done', { answer: String(a.answer || '') });
        send('agent_stop', null);
        var t = document.createElement('b'); t.textContent = 'Terminé'; body.appendChild(t);
        String(a.answer || '').split(/\n+/).forEach(function (l) { if (l.trim()) para(l.trim()); });
        btns([['Fermer', function () { if (ui) { ui.host.remove(); ui = null; } }, 'go']]);
        return;
      }
      if (a.action === 'ask') {
        para(String(a.question || 'Il me manque une information.'));
        var inp = document.createElement('input'); inp.className = 'q'; inp.placeholder = 'Votre réponse…';
        body.appendChild(inp);
        var answer = function () { var v = inp.value.trim(); if (!v) return; send('agent_answer', { desc: v }); step++; setGoal(); status('Merci, je continue…', true); next(300); };
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') answer(); e.stopPropagation(); });
        btns([['Arrêter', stop], ['Envoyer', answer, 'go']]);
        setTimeout(function () { inp.focus(); }, 50);
        return;
      }
      if (a.action === 'scroll') {
        // sans risque : fait tout de suite
        window.scrollBy({ top: (a.dir === 'up' ? -1 : 1) * window.innerHeight * 0.8, behavior: 'smooth' });
        status(human(a) + '…', true);
        stepDone(human(a), 900);
        return;
      }
      var el = null;
      if (a.action !== 'open') {
        el = els[+a.id];
        if (!el || !el.isConnected) { failed('L’élément proposé par l’IA n’existe plus sur la page.'); return; }
      }
      var desc = human(a, el);
      var box = document.createElement('div'); box.className = 'act';
      var b = document.createElement('b'); b.textContent = desc;
      var w = document.createElement('div'); w.className = 'why'; w.textContent = String(a.why || '');
      box.append(b, w);
      body.appendChild(box);
      if (el) { el.scrollIntoView({ block: 'center' }); setTimeout(function () { highlight(el); }, 250); }
      if (a.action === 'type' && sensitive(el)) {
        para('Ce champ est sensible (mot de passe, code ou paiement) : remplissez-le vous-même, puis cliquez sur « Continuer ».');
        btns([['Arrêter', stop], ['Continuer', function () { stepDone('L’utilisateur a rempli lui-même le champ « ' + label(el) + ' »', 300); }, 'go']]);
        return;
      }
      btns([
        ['Arrêter', stop],
        ['Passer', function () { stepDone('(refusé par l’utilisateur) ' + desc, 200); }],
        ['Valider', function () {
          highlight(null);
          var ok = false;
          try { ok = exec(a, el); } catch (e) { ok = false; }
          status(ok ? 'C’est fait, je regarde le résultat…' : 'Action impossible, je cherche autre chose…', true);
          stepDone((ok ? '' : '(échec) ') + desc, a.action === 'open' ? 2500 : 1800);
        }, 'go']
      ]);
    };
    window.__corrtexAgent = {
      start: function (g, n) {
        goal = String(g || '');
        step = n || 0;
        ensureUi();
        setGoal();
        status('Je regarde la page…', true);
        next(500);
      }
    };
  })();

  // ---------------------------------------------------------------- comparateur de prix
  // Sur une fiche produit (données schema.org, Amazon…), un bouton en haut à droite ouvre
  // une carte en verre posée sur la page, comme les réglages : meilleurs prix (leDénicheur),
  // historique, produits trouvés, codes promo (Dealabs) et conseil de l'IA.
  (function () {
    var SKIP_HOSTS = /(^|\.)(google\.[a-z.]+|ledenicheur\.fr|idealo\.[a-z.]+|dealabs\.com|bing\.com|duckduckgo\.com|youtube\.com|wikipedia\.org|chatgpt\.com|claude\.ai|gemini\.google\.com)$/;
    var allowed = !SKIP_HOSTS.test(location.hostname) && /^https?:$/.test(location.protocol);
    var sent = null, btn = null, dismissed = false, lastUrl = '';
    function num(v) {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      var s = String(v).replace(/\s| | /g, '').replace(/[^\d.,]/g, '');
      if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
      var n = parseFloat(s);
      return isFinite(n) && n > 0 ? n : null;
    }
    function isType(o, t) { var x = o && o['@type']; return Array.isArray(x) ? x.indexOf(t) >= 0 : x === t; }
    function findProduct(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return null;
      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { var r = findProduct(o[i], depth + 1); if (r) return r; } return null; }
      if (isType(o, 'Product') || isType(o, 'ProductGroup')) return o;
      if (o['@graph']) return findProduct(o['@graph'], depth + 1);
      for (var k in o) { if (o[k] && typeof o[k] === 'object' && k !== 'isRelatedTo' && k !== 'isSimilarTo') { var r2 = findProduct(o[k], depth + 1); if (r2) return r2; } }
      return null;
    }
    function offerPrice(off) {
      if (!off) return null;
      if (Array.isArray(off)) { var best = null; off.forEach(function (x) { var p = offerPrice(x); if (p && (!best || p.price < best.price)) best = p; }); return best; }
      var p = num(off.price != null ? off.price : (off.lowPrice != null ? off.lowPrice : (off.priceSpecification && off.priceSpecification.price)));
      return p ? { price: p, currency: off.priceCurrency || 'EUR' } : null;
    }
    function meta(sel) { var m = document.querySelector(sel); return m ? (m.getAttribute('content') || m.textContent || '').trim() : ''; }
    function detect() {
      var info = null;
      var scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < scripts.length && !info; i++) {
        var data; try { data = JSON.parse(scripts[i].textContent); } catch (e) { continue; }
        var p = findProduct(data, 0);
        if (!p || !p.name) continue;
        var pr = offerPrice(p.offers) || (p.hasVariant && offerPrice(p.hasVariant.map(function (v) { return v.offers; })));
        var brand = p.brand && (typeof p.brand === 'string' ? p.brand : p.brand.name) || '';
        var img = Array.isArray(p.image) ? p.image[0] : (p.image && (p.image.url || p.image));
        info = { name: String(p.name).trim(), brand: String(brand || '').trim(),
          gtin: String(p.gtin13 || p.gtin || p.gtin14 || p.gtin12 || p.ean || p.gtin8 || '').replace(/\D/g, ''),
          image: typeof img === 'string' ? img : '', price: pr ? pr.price : null };
      }
      if (!info && document.getElementById('productTitle')) {
        var pe = document.querySelector('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, #apex_desktop .a-offscreen, .a-price .a-offscreen');
        var im = document.getElementById('landingImage');
        var by = document.getElementById('bylineInfo');
        info = { name: document.getElementById('productTitle').textContent.trim(),
          brand: by ? by.textContent.replace(/^(Visiter la boutique|Marque\s*:)\s*/i, '').trim() : '',
          gtin: '', image: im ? im.src : '', price: pe ? num(pe.textContent) : null };
      }
      if (!info && /product/i.test(meta('meta[property="og:type"]')) && meta('meta[property="og:title"]')) {
        info = { name: meta('meta[property="og:title"]'), brand: meta('meta[property="product:brand"]'), gtin: '',
          image: meta('meta[property="og:image"]'), price: num(meta('meta[property="product:price:amount"], meta[property="og:price:amount"]')) };
      }
      if (info) { info.name = info.name.replace(/\s+/g, ' ').slice(0, 300); info.site = location.hostname.replace(/^www\./, ''); info.url = location.href; }
      return info;
    }

    // ---------------------------------------------------------------- lecture des pages du comparateur
    function rsc(html) {
      var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g, m, out = '';
      while ((m = re.exec(html))) { try { out += JSON.parse('"' + m[1] + '"'); } catch (e) {} }
      return out;
    }
    function balanced(raw, j) {
      var d = 0, s = false, e = false;
      for (var k = j; k < raw.length; k++) {
        var c = raw[k];
        if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; }
        if (c === '"') s = true;
        else if (c === '{' || c === '[') d++;
        else if (c === '}' || c === ']') { d--; if (!d) { try { return { value: JSON.parse(raw.slice(j, k + 1)), end: k + 1 }; } catch (er) { return null; } } }
      }
      return null;
    }
    function grab(raw, key, from) {
      var i = raw.indexOf(key, from || 0);
      if (i < 0) return null;
      var j = i + key.length;
      if (/[{[]$/.test(key)) j--;
      while (j < raw.length && raw[j] !== '{' && raw[j] !== '[') j++;
      return balanced(raw, j);
    }
    function ld(html, raw, type) {
      var out = [], m;
      var re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
      while ((m = re.exec(html))) { try { var o = JSON.parse(m[1]); if (o['@type'] === type) out.push(o); } catch (e) {} }
      var re2 = /"__html":"((?:[^"\\]|\\.)*)"/g;
      while ((m = re2.exec(raw))) { try { var t = JSON.parse('"' + m[1] + '"'); if (t.indexOf('"@type":"' + type + '"') > 0) { var o2 = JSON.parse(t); if (o2['@type'] === type) out.push(o2); } } catch (e) {} }
      var key = '{"@context":"https://schema.org","@type":"' + type + '"', i = raw.indexOf(key);
      while (i >= 0) { var r = balanced(raw, i); if (r) out.push(r.value); i = raw.indexOf(key, i + key.length); }
      return out;
    }
    function price(text) {
      var m = String(text || '').match(/(\d[\d\s  .]*,\d{2}|\d[\d\s  ]*)\s*€/);
      if (!m) return null;
      var n = parseFloat(m[1].replace(/[\s  .]/g, '').replace(',', '.'));
      return isFinite(n) ? n : null;
    }
    function strip(h) {
      return String(h).replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function parseSearch(html) {
      var raw = rsc(html), seen = {}, out = [];
      ld(html, raw, 'ItemList').forEach(function (l) {
        (l.itemListElement || []).forEach(function (it) {
          var p = it.item || it, id = String(p['@id'] || p.url || '').match(/p=(\d+)/);
          if (!id || seen[id[1]]) return;
          seen[id[1]] = 1;
          out.push({ id: id[1], name: p.name || '', image: p.image || '', url: 'https://ledenicheur.fr/product.php?p=' + id[1],
            price: p.offers ? +(p.offers.price || p.offers.lowPrice) || null : null,
            rating: p.aggregateRating ? +p.aggregateRating.ratingValue : null, reviews: p.aggregateRating ? +p.aggregateRating.reviewCount : 0 });
        });
      });
      return out;
    }
    function parseProduct(html) {
      var raw = rsc(html), res = { name: '', low: null, offerCount: 0, offers: [], history: [] };
      var g = ld(html, raw, 'ProductGroup')[0] || ld(html, raw, 'Product')[0];
      if (g) {
        res.name = g.name || '';
        (g.hasVariant || [g]).forEach(function (v) {
          var o = v.offers || {}, low = +(o.lowPrice || o.price) || null;
          if (low && (res.low == null || low < res.low)) res.low = low;
          res.offerCount += +o.offerCount || 0;
        });
      }
      // offres : liens « Voir l'offre » (« Marchand, titre, 229,03 €, Voir l'offre ») ; le texte avant le lien donne le prix barré
      var re = /<a [^>]*href="([^"]*\/go-to-shop\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g, m, prevEnd = 0, seen = {};
      while ((m = re.exec(html))) {
        var href = m[1].replace(/&amp;/g, '&'), before = strip(html.slice(Math.max(prevEnd, m.index - 4000), m.index));
        prevEnd = re.lastIndex;
        if (seen[href]) continue;
        seen[href] = 1;
        var t = strip(m[2]).replace(/(Voir l’offre|Voir l'offre)/g, '').trim().replace(/,\s*$/, '');
        var p = price(t);
        if (!p) continue;
        var shop = t.split(',')[0].trim();
        var title = t.slice(shop.length + 1).replace(/,\s*\d[\d\s  .]*(,\d{2})?\s*€.*$/, '').trim();
        var tail = before.slice(-300), all = tail.match(/\d[\d\s  .]*,\d{2}\s*€/g) || [];
        var was = all.map(price).filter(function (x) { return x && x > p && x < p * 4; }).sort(function (a, b) { return b - a; })[0] || null;
        res.offers.push({ shop: shop, title: title, price: p, was: was, stock: /en stock/i.test(tail), url: href.indexOf('http') === 0 ? href : 'https://ledenicheur.fr' + href });
      }
      res.offers.sort(function (a, b) { return a.price - b.price; });
      var ph = grab(raw, '"priceHistory":');
      if (ph && ph.value && Array.isArray(ph.value.historyItems)) {
        res.history = ph.value.historyItems.filter(function (h) { return h && h.date && +h.price > 0; })
          .map(function (h) { return { t: Date.parse(h.date), price: h.price / 100, shop: h.shopName || '' }; })
          .sort(function (a, b) { return a.t - b.t; });
      }
      return res;
    }
    function parseCoupons(html) {
      var raw = rsc(html), out = [], seen = {}, from = 0;
      for (;;) {
        var r = grab(raw, '"voucher":{', from);
        if (!r) break;
        from = r.end;
        var v = r.value;
        if (!v || !v.title) continue;
        var key = (v.idPool || '') + '|' + v.title + '|' + (v.code || '');
        if (seen[key]) continue;
        seen[key] = 1;
        var end = v.endTime ? Date.parse(v.endTime) : null;
        if (end && end < Date.now()) continue;
        var st = v.voucherVerificationLiveHistory && v.voucherVerificationLiveHistory.status;
        out.push({ title: v.title.replace(/^Code promo [^:]+:\s*/i, ''), badge: [v.caption1, v.caption2].filter(Boolean).join(' '), code: v.code || '', end: end,
          verified: st === 'verified', terms: v.termsAndConditions || '', lastUsed: v.voucherStatistic && v.voucherStatistic.lastUsedDate ? Date.parse(v.voucherStatistic.lastUsedDate) : 0 });
      }
      out.sort(function (a, b) { return (!!b.code - !!a.code) || (b.verified - a.verified) || (b.lastUsed - a.lastUsed); });
      return out;
    }
    var ACCESSORY = /\b(housse|coque|etui|étui|coussinet|coussinets|oreillette|embout|arceau|cable|câble|chargeur|support|protection|film|adaptateur|remplacement|replacement|pochette|sacoche|bracelet|pour|for|für|compatible|skin|grip|tapis)\b/i;
    function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
    function tokens(s) { return norm(s).split(' ').filter(function (t) { return t.length >= 2 || /\d/.test(t); }); }
    function score(siteName, cand) {
      var a = tokens(siteName), b = {};
      tokens(cand).forEach(function (t) { b[t] = 1; });
      if (!a.length) return 0;
      var hit = 0, max = 0;
      a.forEach(function (t) { var w = /\d/.test(t) ? 2 : 1; max += w; if (b[t]) hit += w; });
      var s = hit / max;
      if (ACCESSORY.test(cand) && !ACCESSORY.test(siteName)) s -= 0.45;
      return s;
    }
    function query(info) {
      var n = String(info.name || '').replace(/\(.*?\)|\[.*?\]/g, ' ').split(/\s[-–|]\s|,|\|/)[0];
      var words = n.split(/\s+/).filter(Boolean);
      if (info.brand && norm(n).indexOf(norm(info.brand)) < 0) words.unshift(info.brand);
      return words.slice(0, 7).join(' ').trim();
    }

    // téléchargements par le navigateur (seuls leDénicheur et Dealabs sont autorisés)
    var fseq = 0, fwait = {};
    function fetchPage(url) {
      return new Promise(function (resolve, reject) {
        var id = ++fseq;
        fwait[id] = { resolve: resolve, reject: reject };
        send('shop_fetch', { id: id, url: url });
        setTimeout(function () { if (fwait[id]) { delete fwait[id]; reject('délai dépassé'); } }, 25000);
      });
    }
    window.__corrtexShopFetched = function (id, ok, body) {
      var w = fwait[id];
      if (!w) return;
      delete fwait[id];
      if (ok) w.resolve(body); else w.reject(body);
    };

    // ---------------------------------------------------------------- carte du comparateur
    var P = null, info = null, run = 0, range = 30, found = [], current = null, product = null, coupons = null, slug = '', aiReq = '', aiBox = null;
    var I = {
      ext: 'M14 4.5h5.5V10M19.5 4.5L11 13M17 14v5.5H4.5V7H10',
      down: 'M12 5v14M6 13l6 6 6-6', up: 'M12 19V5M6 11l6-6 6 6', check: 'M5 12.5l4.5 4.5L19 7.5',
      x: 'M6 6l12 12M18 6L6 18', reload: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', chart: 'M4 19.5h16M7 16V11M12 16V6.5M17 16v-6'
    };
    var eur = function (n) { return n == null ? '—' : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
    var day = function (t) { return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };
    function E(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
    function ic(d, cls) { var s = cxIcon(d); if (cls) s.setAttribute('class', cls); return s; }
    function spark() { return cxSpark(); }
    function openUrl(url) { send('open_new_tab', { url: url }); }

    function css() {
      var th = cxTheme(), dark = th.scheme !== 'light', ac = th.accent;
      var fg = th.fg || (dark ? '#f4f4f6' : '#111');
      var glass = dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.045)';
      var hover = dark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.08)';
      var border = dark ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.14)';
      var dim = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.55)';
      var card = th.card || (dark ? '#3a3a3e' : '#ffffff');
      var good = '#4fcf8a';
      return [
        ':host { all: initial; }',
        '* { box-sizing: border-box; }',
        '.pn { position: fixed; z-index: 2147483646; top: 14px; right: 14px; bottom: 14px; width: 400px; max-width: calc(100vw - 28px); display: flex; flex-direction: column;',
        '  font: 14px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: ' + fg + '; text-align: left;',
        '  background: color-mix(in srgb, ' + card + ' 72%, transparent); border: 1px solid ' + border + '; border-radius: 26px;',
        '  backdrop-filter: blur(34px) saturate(1.6); -webkit-backdrop-filter: blur(34px) saturate(1.6);',
        '  box-shadow: 0 28px 70px rgba(0,0,0,' + (dark ? '.45' : '.18') + '), inset 0 1px 0 rgba(255,255,255,.18); overflow: hidden; animation: pin .28s cubic-bezier(.2,.8,.2,1); }',
        '@keyframes pin { from { opacity: 0; transform: translateX(24px); } }',
        '.hdr { display: flex; align-items: center; gap: 8px; padding: 20px 20px 10px 24px; }',
        '.hdr .tt { flex: 1; min-width: 0; }',
        '.hdr h2 { margin: 0; font-size: 22px; font-weight: 600; }',
        '.hdr small { display: block; font-size: 12.5px; color: ' + dim + '; margin-top: 1px; }',
        '.rb { all: unset; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; border: 1px solid ' + border + '; background: ' + glass + '; cursor: default; flex: none; }',
        '.rb:hover { background: ' + hover + '; }',
        'svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }',
        '.bd { flex: 1; overflow-y: auto; padding: 0 24px 18px; scrollbar-width: thin; }',
        '.grp { padding: 16px 0; border-bottom: 1px solid ' + hover + '; }',
        '.grp:last-child { border-bottom: 0; }',
        'h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 14px; font-weight: 600; }',
        'h3 .n { font-weight: 400; color: ' + dim + '; }',
        'h3 .g { flex: 1; }',
        '.prod { display: flex; gap: 12px; align-items: center; padding: 12px; border-radius: 16px; background: ' + glass + '; }',
        '.prod img, .ph { width: 54px; height: 54px; border-radius: 12px; object-fit: contain; background: #fff; flex: none; }',
        '.ph { background: ' + hover + '; }',
        '.prod .t { font-size: 13.5px; font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
        '.prod .s { font-size: 12.5px; color: ' + dim + '; margin-top: 4px; } .prod .s b { color: ' + fg + '; }',
        '.vd { margin-top: 12px; padding: 16px; border-radius: 18px; background: linear-gradient(135deg, color-mix(in srgb, ' + ac + ' 26%, transparent), ' + glass + '); border: 1px solid color-mix(in srgb, ' + ac + ' 45%, transparent); }',
        '.vd.good { background: linear-gradient(135deg, rgba(79,207,138,.24), ' + glass + '); border-color: rgba(79,207,138,.5); }',
        '.vd .l { font-size: 11.5px; color: ' + dim + '; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; }',
        '.vd .big { font-size: 30px; font-weight: 700; margin: 2px 0; letter-spacing: -.5px; }',
        '.vd .big small { font-size: 14px; font-weight: 500; color: ' + dim + '; margin-left: 6px; letter-spacing: 0; }',
        '.vd .big small.here { color: ' + good + '; font-weight: 600; }',
        '.vd .m { font-size: 13.5px; } .vd .m b { font-weight: 700; }',
        '.vd .r { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }',
        '.tag { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 13px; font-size: 12px; font-weight: 600; background: ' + glass + '; border: 1px solid ' + border + '; }',
        '.tag.good { color: ' + good + '; border-color: rgba(79,207,138,.5); } .tag.warn { color: #ffb05c; border-color: rgba(255,176,92,.5); }',
        '.tag svg { width: 13px; height: 13px; }',
        '.btn { all: unset; box-sizing: border-box; height: 36px; padding: 0 16px; border-radius: 18px; font-weight: 600; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: ' + fg + '; color: ' + (dark ? '#1c1c20' : '#fff') + '; cursor: default; }',
        '.btn:hover { filter: brightness(.92); }',
        '.btn.gh { background: ' + glass + '; color: ' + fg + '; border: 1px solid ' + border + '; }',
        '.btn.gh:hover { background: ' + hover + '; filter: none; }',
        '.btn.full { width: 100%; margin-top: 8px; }',
        '.btn[disabled] { opacity: .5; }',
        '.chips { display: flex; gap: 6px; }',
        '.chip { all: unset; height: 28px; padding: 0 11px; border-radius: 14px; font-size: 12px; border: 1px solid ' + border + '; background: ' + glass + '; cursor: default; }',
        '.chip:hover { background: ' + hover + '; } .chip.sel { background: ' + fg + '; color: ' + (dark ? '#1c1c20' : '#fff') + '; border-color: ' + fg + '; font-weight: 600; }',
        '.ch { position: relative; padding: 12px 12px 8px; border-radius: 16px; background: ' + glass + '; }',
        '.ch svg.c { width: 100%; height: 170px; display: block; overflow: visible; stroke: none; }',
        '.ch .gr { stroke: ' + hover + '; stroke-width: 1; }',
        '.ch text { fill: ' + dim + '; font-size: 10.5px; stroke: none; font-family: inherit; }',
        '.ch .ln { fill: none; stroke: ' + ac + '; stroke-width: 2.2; stroke-linejoin: round; }',
        '.ch .st { stroke: ' + dim + '; stroke-width: 1.2; stroke-dasharray: 4 4; }',
        '.ch .dt { fill: ' + ac + '; stroke: ' + card + '; stroke-width: 2; }',
        '.ch .cu { stroke: ' + dim + '; stroke-width: 1; opacity: .5; }',
        '.tip { position: absolute; pointer-events: none; padding: 6px 10px; border-radius: 10px; font-size: 12px; white-space: nowrap; background: ' + card + '; border: 1px solid ' + border + '; box-shadow: 0 6px 18px rgba(0,0,0,.3); transform: translate(-50%, -110%); display: none; }',
        '.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 8px; }',
        '.stat { padding: 9px 10px; border-radius: 12px; background: ' + glass + '; } .stat .k { font-size: 11.5px; color: ' + dim + '; } .stat .v { font-size: 14.5px; font-weight: 700; margin-top: 2px; }',
        '.note { font-size: 12.5px; color: ' + dim + '; margin-top: 8px; }',
        '.list { display: flex; flex-direction: column; gap: 2px; border-radius: 16px; overflow: hidden; }',
        '.row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; min-height: 50px; padding: 7px 14px; background: ' + glass + '; cursor: default; }',
        '.row:hover { background: ' + hover + '; }',
        '.row.best { background: color-mix(in srgb, ' + ac + ' 16%, transparent); } .row.sel { box-shadow: inset 3px 0 0 ' + ac + '; }',
        '.row .mn { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
        '.row .mn b { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.row .mn i { font-style: normal; font-size: 12px; color: ' + dim + '; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.row .pr { flex: none; text-align: right; font-weight: 700; font-size: 14px; }',
        '.row .pr s { display: block; font-weight: 400; font-size: 11.5px; color: ' + dim + '; } .row .pr em { display: block; font-style: normal; font-weight: 600; font-size: 11px; color: ' + good + '; }',
        '.th { width: 40px; height: 40px; border-radius: 10px; object-fit: contain; background: #fff; flex: none; }',
        '.si { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-weight: 700; font-size: 14px; background: ' + hover + '; flex: none; }',
        '.cp { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: ' + glass + '; }',
        '.cp .tp { display: flex; align-items: flex-start; gap: 10px; }',
        '.cp .bg { flex: none; max-width: 110px; padding: 4px 9px; border-radius: 9px; font-size: 11.5px; font-weight: 700; text-align: center; line-height: 1.2; background: color-mix(in srgb, ' + ac + ' 24%, transparent); color: color-mix(in srgb, ' + ac + ' 50%, ' + fg + '); }',
        '.cp .t { font-size: 13px; line-height: 1.35; flex: 1; }',
        '.cp .bt { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: ' + dim + '; }',
        '.cp .ok { color: ' + good + '; display: inline-flex; align-items: center; gap: 4px; } .cp .ok svg { width: 12px; height: 12px; }',
        '.code { all: unset; margin-left: auto; height: 30px; padding: 0 12px; border-radius: 10px; font: 700 12.5px ui-monospace, Consolas, monospace; letter-spacing: .5px; color: ' + fg + ';',
        '  border: 1.5px dashed color-mix(in srgb, ' + ac + ' 60%, ' + border + '); display: inline-flex; align-items: center; gap: 8px; cursor: default; }',
        '.code:hover { background: ' + hover + '; } .code span { font: 600 11.5px "Segoe UI", system-ui, sans-serif; letter-spacing: 0; color: ' + dim + '; }',
        '.wait { display: flex; align-items: center; gap: 10px; padding: 12px 2px; color: ' + dim + '; font-size: 13px; }',
        '.ring { width: 16px; height: 16px; border-radius: 50%; border: 2px solid ' + hover + '; border-top-color: ' + ac + '; animation: spin .8s linear infinite; flex: none; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
        '.sk { height: 110px; border-radius: 16px; margin-top: 12px; background: linear-gradient(90deg, ' + glass + ' 25%, ' + hover + ' 50%, ' + glass + ' 75%); background-size: 200% 100%; animation: sk 1.3s linear infinite; }',
        '@keyframes sk { to { background-position: -200% 0; } }',
        '.adv { margin-top: 10px; padding: 14px 16px; border-radius: 16px; background: ' + glass + '; border: 1px solid ' + border + '; font-size: 13.5px; line-height: 1.5; user-select: text; }',
        '.adv .ah { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 8px; }',
        '.adv .ah svg, .btn svg.sp { fill: ' + ac + '; stroke: none; filter: drop-shadow(0 0 4px ' + ac + '); width: 15px; height: 15px; }',
        '.adv p { margin: 0 0 7px; } .adv ul { margin: 0 0 7px 18px; padding: 0; } .adv li { margin: 3px 0; }',
        '.empty { text-align: center; padding: 50px 16px; color: ' + dim + '; } .empty svg { width: 40px; height: 40px; opacity: .5; margin-bottom: 10px; }',
        '.src { font-size: 11.5px; color: ' + dim + '; padding-top: 12px; line-height: 1.5; } .src a { color: inherit; }'
      ].join('\n');
    }

    function grp(id) { var g = E('div', 'grp'); g.id = id; return g; }
    function $(id) { return P && P.root.getElementById(id); }
    function waitRow(t) { var w = E('div', 'wait'); w.append(E('div', 'ring'), E('span', '', t)); return w; }
    function fill(id, title, nodes) {
      var g = $(id);
      if (!g) return;
      g.replaceChildren();
      if (title) g.append(typeof title === 'string' ? E('h3', '', title) : title);
      nodes.forEach(function (n) { g.append(n); });
    }
    function h3(t, n) { var h = E('h3'); h.append(E('span', '', t)); if (n != null) h.append(E('span', 'n', String(n))); return h; }

    function openPanel() {
      if (P && P.host.isConnected) { P.host.remove(); P = null; return; }
      info = sent || detect();
      // feuille de style propre au panneau (sans celle des menus)
      var h = document.createElement('corrtex-shoppanel');
      var r = h.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = css();
      r.appendChild(st);
      (document.body || document.documentElement).appendChild(h);
      P = { host: h, root: r };
      var pn = E('div', 'pn');
      var hdr = E('div', 'hdr');
      var tt = E('div', 'tt');
      tt.append(E('h2', '', 'Comparateur'), E('small', '', info ? info.site : 'Meilleurs prix, historique et codes promo'));
      var rl = E('button', 'rb'); rl.title = 'Actualiser'; rl.append(ic(I.reload)); rl.onclick = function () { load(); };
      var cl = E('button', 'rb'); cl.title = 'Fermer'; cl.append(ic(I.x)); cl.onclick = closePanel;
      hdr.append(tt, rl, cl);
      var bd = E('div', 'bd'); bd.id = 'bd';
      pn.append(hdr, bd);
      P.root.appendChild(pn);
      if (btn) btn.host.style.display = 'none';
      load();
    }
    function closePanel() { if (P) { P.host.remove(); P = null; } if (btn) btn.host.style.display = ''; run++; }
    window.__corrtexShopOpen = function () { if (!allowed) return; openPanel(); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && P) closePanel(); }, true);

    function skeleton() {
      var bd = $('bd');
      bd.replaceChildren();
      var g0 = E('div', 'grp');
      var pr = E('div', 'prod');
      if (info.image) { var im = E('img'); im.src = info.image; im.onerror = function () { im.replaceWith(E('div', 'ph')); }; pr.append(im); } else pr.append(E('div', 'ph'));
      var tx = E('div');
      var s = E('div', 's', 'Sur ' + info.site + ' : ');
      s.append(E('b', '', info.price ? eur(info.price) : 'prix non détecté'));
      tx.append(E('div', 't', info.name), s);
      pr.append(tx);
      var v = E('div'); v.id = 'vd'; v.append(E('div', 'sk'));
      g0.append(pr, v);
      var gH = grp('g-h'); gH.append(E('h3', '', 'Évolution du prix'), E('div', 'sk'));
      var gO = grp('g-o'); gO.append(E('h3', '', 'Offres des marchands'), waitRow('Recherche des meilleures offres…'));
      var gF = grp('g-f'); gF.append(E('h3', '', 'Produits trouvés'), waitRow('Recherche sur le comparateur…'));
      var gC = grp('g-c'); gC.append(E('h3', '', 'Codes promo pour ' + info.site), waitRow('Recherche de codes de réduction…'));
      var gA = grp('g-a');
      var src = E('div', 'src');
      var a1 = E('a', '', 'leDénicheur'); a1.href = '#'; a1.onclick = function (e) { e.preventDefault(); openUrl(current ? current.url : 'https://ledenicheur.fr/search?query=' + encodeURIComponent(query(info))); };
      var a2 = E('a', '', 'Dealabs'); a2.href = '#'; a2.onclick = function (e) { e.preventDefault(); openUrl('https://www.dealabs.com/codes-promo/' + slug); };
      src.append(document.createTextNode('Prix et historique : '), a1, document.createTextNode(' · Codes promo : '), a2, document.createTextNode('. Les prix peuvent varier ; vérifiez sur le site du marchand.'));
      bd.append(g0, gH, gO, gF, gC, gA, src);
    }
    function noteBox(t) { var d = E('div', 'vd'); d.append(E('div', 'm', t)); return d; }

    async function load() {
      var my = ++run;
      info = sent || detect();
      if (!P) return;
      if (!info) {
        var bd = $('bd'), e = E('div', 'empty');
        e.append(ic(I.chart), E('div', '', 'Aucun article en vente détecté sur cette page.'));
        bd.replaceChildren(e);
        return;
      }
      slug = siteSlug(info.site);
      found = []; current = null; product = null; coupons = null; aiBox = null;
      skeleton();
      loadCoupons(my);
      try { found = await searchProducts(info); }
      catch (e) {
        if (my !== run) return;
        var m = 'Le comparateur n’a pas répondu (' + e + ').';
        fill('vd', null, [noteBox(m)]);
        ['g-h', 'g-o', 'g-f'].forEach(function (id, i) { fill(id, ['Évolution du prix', 'Offres des marchands', 'Produits trouvés'][i], [E('div', 'note', 'Indisponible.')]); });
        renderAI();
        return;
      }
      if (my !== run) return;
      renderFound();
      if (!found.length) {
        fill('vd', null, [noteBox('Ce produit n’a pas été trouvé sur le comparateur.')]);
        fill('g-h', 'Évolution du prix', [E('div', 'note', 'Pas d’historique disponible.')]);
        fill('g-o', 'Offres des marchands', [E('div', 'note', 'Aucune offre trouvée.')]);
        renderAI();
        return;
      }
      select(found[0], my);
    }
    async function searchProducts(info) {
      var lists = [];
      if (info.gtin && info.gtin.length >= 8) {
        try { lists.push(parseSearch(await fetchPage('https://ledenicheur.fr/search?query=' + info.gtin)).map(function (r) { r.byGtin = true; return r; })); } catch (e) {}
      }
      lists.push(parseSearch(await fetchPage('https://ledenicheur.fr/search?query=' + encodeURIComponent(query(info)))));
      var seen = {}, out = [];
      lists.forEach(function (l) { l.forEach(function (r) {
        if (seen[r.id]) return;
        seen[r.id] = 1;
        r.score = score(info.name, r.name) + (r.byGtin ? 1 : 0);
        out.push(r);
      }); });
      out.sort(function (a, b) { return (b.score - a.score) || ((a.price || 1e9) - (b.price || 1e9)); });
      return out;
    }
    function renderFound() {
      if (!found.length) { fill('g-f', 'Produits trouvés', [E('div', 'note', 'Aucun produit correspondant sur le comparateur.')]); return; }
      var list = E('div', 'list');
      found.forEach(function (r) {
        var b = E('button', 'row' + (current && current.id === r.id ? ' sel' : ''));
        var im = E('img', 'th'); im.src = r.image; im.onerror = function () { im.style.visibility = 'hidden'; };
        var m = E('div', 'mn');
        var pct = Math.max(0, Math.min(100, Math.round(Math.min(r.score, 1) * 100)));
        m.append(E('b', '', r.name), E('i', '', (r.byGtin ? 'Même code EAN · ' : 'Ressemblance ' + pct + ' % · ') + (r.rating ? '★ ' + r.rating.toFixed(1) + ' (' + r.reviews + ' avis)' : 'pas d’avis')));
        b.append(im, m, E('div', 'pr', r.price ? 'dès ' + eur(r.price) : ''));
        b.onclick = function () { select(r, run); };
        list.append(b);
      });
      fill('g-f', h3('Produits trouvés', found.length), [list, E('div', 'note', 'Choisissez un autre produit si celui-ci ne correspond pas exactement.')]);
    }
    async function select(r, my) {
      current = r;
      renderFound();
      fill('vd', null, [E('div', 'sk')]);
      fill('g-h', 'Évolution du prix', [E('div', 'sk')]);
      fill('g-o', 'Offres des marchands', [waitRow('Lecture des offres…')]);
      try { product = parseProduct(await fetchPage(r.url)); }
      catch (e) {
        if (my !== run || current !== r) return;
        fill('vd', null, [noteBox('Impossible de lire la fiche du comparateur (' + e + ').')]);
        fill('g-h', 'Évolution du prix', [E('div', 'note', 'Indisponible.')]);
        fill('g-o', 'Offres des marchands', [E('div', 'note', 'Indisponible.')]);
        return;
      }
      if (my !== run || current !== r) return;
      renderVerdict(); renderHistory(); renderOffers(); renderAI();
    }
    function series(days) {
      var h = product.history;
      if (!h.length) return [];
      var DAY = 864e5, now = Date.now(), start = Math.max(now - days * DAY, h[0].t), out = [], i = 0, last = h[0];
      for (var t = Math.floor(start / DAY) * DAY; t <= now; t += DAY) {
        while (i < h.length && h[i].t <= t + DAY - 1) { last = h[i]; i++; }
        if (last.t <= t + DAY - 1) out.push({ t: t, price: last.price, shop: last.shop });
      }
      return out;
    }
    function stats(days) {
      var s = series(days);
      if (!s.length) return null;
      var p = s.map(function (x) { return x.price; });
      return { min: Math.min.apply(null, p), max: Math.max.apply(null, p), avg: p.reduce(function (a, b) { return a + b; }, 0) / p.length, last: p[p.length - 1], s: s };
    }
    function best() {
      var o = product && product.offers[0];
      var low = [product && product.low, o && o.price].filter(function (x) { return x; }).sort(function (a, b) { return a - b; })[0] || null;
      return { price: low, offer: o && low && o.price <= low + 0.01 ? o : null };
    }
    function renderVerdict() {
      var b = best();
      if (!b.price && !info.price) { fill('vd', null, [noteBox('Aucun prix disponible pour ce produit sur le comparateur.')]); return; }
      var box = E('div', 'vd');
      var diff = info.price && b.price ? info.price - b.price : null;
      var tol = info.price ? Math.max(1, info.price * 0.01) : 1;
      var cheaper = diff != null && diff > tol;
      var siteBest = !!info.price && (!b.price || diff <= tol);
      var shown = siteBest ? info.price : b.price;
      if (siteBest) box.classList.add('good');
      box.append(E('div', 'l', siteBest ? 'Meilleur prix : cette page' : 'Meilleur prix trouvé'));
      var big = E('div', 'big', eur(shown));
      if (siteBest) big.append(E('small', 'here', 'ici, sur ' + info.site));
      else if (b.offer) big.append(E('small', '', 'chez ' + b.offer.shop));
      box.append(big);
      var m = E('div', 'm');
      function rich(parts) { parts.forEach(function (p) { m.append(typeof p === 'string' ? document.createTextNode(p) : E('b', '', p[0])); }); }
      if (!info.price) m.textContent = 'Le prix de ce site n’a pas été détecté : comparez avec le meilleur prix ci-dessus.';
      else if (!b.price) m.textContent = 'Aucune autre offre trouvée sur le comparateur.';
      else if (cheaper) rich(['Vous économisez ', [eur(diff)], ' (' + Math.round(diff / info.price * 100) + ' %) par rapport à ' + info.site + '.']);
      else if (diff < -0.5) rich(['Aucune offre moins chère trouvée : la meilleure offre du comparateur est à ', [eur(b.price)], (b.offer ? ' chez ' + b.offer.shop : '') + ', soit ', [eur(-diff) + ' de plus'], '.']);
      else m.textContent = 'Même prix que la meilleure offre du comparateur' + (b.offer ? ' (' + b.offer.shop + ')' : '') + '.';
      box.append(m);
      var row = E('div', 'r'), st = stats(90);
      if (st && shown) {
        var tag;
        if (shown <= st.min * 1.02) { tag = E('span', 'tag good'); tag.append(ic(I.down), document.createTextNode('Au plus bas depuis 3 mois')); }
        else if (shown >= st.avg * 1.08) { tag = E('span', 'tag warn'); tag.append(ic(I.up), document.createTextNode('Plus cher que d’habitude')); }
        else tag = E('span', 'tag', 'Prix dans la moyenne');
        row.append(tag);
      }
      if (cheaper && b.offer) {
        var go = E('button', 'btn'); go.append(ic(I.ext), document.createTextNode('Voir l’offre'));
        go.style.marginLeft = 'auto';
        go.onclick = function () { openUrl(b.offer.url); };
        row.append(go);
      }
      box.append(row);
      fill('vd', null, [box]);
    }
    function renderHistory() {
      if (!product.history.length) { fill('g-h', 'Évolution du prix', [E('div', 'note', 'Pas encore d’historique pour ce produit.')]); return; }
      var h = E('h3'); h.append(E('span', 'g', 'Évolution du prix'));
      var chips = E('div', 'chips');
      [[7, '7 j'], [30, '30 j'], [90, '3 mois']].forEach(function (x) {
        var c = E('button', 'chip' + (range === x[0] ? ' sel' : ''), x[1]);
        c.onclick = function () { range = x[0]; renderHistory(); };
        chips.append(c);
      });
      h.append(chips);
      var st = stats(range), wrap = E('div', 'ch'), tip = E('div', 'tip');
      wrap.append(tip);
      var grid = E('div', 'stats');
      [['Plus bas', st.min], ['Moyen', st.avg], ['Plus haut', st.max]].forEach(function (x) { var s = E('div', 'stat'); s.append(E('div', 'k', x[0]), E('div', 'v', eur(Math.round(x[1] * 100) / 100))); grid.append(s); });
      var first = st.s[0].price, ch = st.last - first;
      var trend = E('div', 'note', Math.abs(ch) < 0.5 ? 'Prix stable sur la période.' : (ch < 0 ? 'En baisse de ' : 'En hausse de ') + eur(Math.abs(ch)) + ' (' + Math.round(Math.abs(ch) / first * 100) + ' %) sur la période.');
      fill('g-h', h, [wrap, grid, trend]);
      wrap.prepend(chart(st.s, tip, Math.max(200, wrap.clientWidth - 24)));
    }
    function chart(s, tip, W) {
      var NS = 'http://www.w3.org/2000/svg', H = 170, L = 44, R = 8, T = 10, B = 22;
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'c'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', W); svg.setAttribute('height', H);
      function mk(tag, a) { var e = document.createElementNS(NS, tag); for (var k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; }
      var ps = s.map(function (x) { return x.price; }), lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      var site = info.price && info.price < hi * 1.35 && info.price > lo * 0.7 ? info.price : null;
      if (site) { lo = Math.min(lo, site); hi = Math.max(hi, site); }
      var pad = Math.max((hi - lo) * 0.15, hi * 0.02, 1); lo -= pad; hi += pad;
      function x(i) { return L + (s.length < 2 ? (W - L - R) / 2 : i / (s.length - 1) * (W - L - R)); }
      function y(p) { return T + (1 - (p - lo) / (hi - lo)) * (H - T - B); }
      for (var k = 0; k <= 3; k++) {
        var pv = lo + (hi - lo) * k / 3, yy = y(pv);
        mk('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'gr' });
        mk('text', { x: L - 6, y: yy + 3.5, 'text-anchor': 'end' }).textContent = Math.round(pv) + ' €';
      }
      [0, Math.floor((s.length - 1) / 2), s.length - 1].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (i) {
        mk('text', { x: x(i), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === s.length - 1 ? 'end' : 'middle' }).textContent = day(s[i].t);
      });
      var ac = cxTheme().accent, defs = mk('defs', {}), gr = document.createElementNS(NS, 'linearGradient');
      gr.setAttribute('id', 'cxga'); gr.setAttribute('x1', 0); gr.setAttribute('x2', 0); gr.setAttribute('y1', 0); gr.setAttribute('y2', 1);
      [['0', '.35'], ['1', '0']].forEach(function (o) { var st = document.createElementNS(NS, 'stop'); st.setAttribute('offset', o[0]); st.setAttribute('stop-color', ac); st.setAttribute('stop-opacity', o[1]); gr.appendChild(st); });
      defs.appendChild(gr);
      var d = '';
      s.forEach(function (pt, i) { d += (i ? ' H' + x(i).toFixed(1) + ' V' : 'M' + x(i).toFixed(1) + ' ') + y(pt.price).toFixed(1); });
      if (s.length === 1) d += ' H' + (W - R);
      mk('path', { d: d + ' V' + (H - B) + ' H' + x(0).toFixed(1) + ' Z', fill: 'url(#cxga)', stroke: 'none' });
      mk('path', { d: d, class: 'ln' });
      if (site) {
        mk('line', { x1: L, x2: W - R, y1: y(site), y2: y(site), class: 'st' });
        mk('text', { x: W - R, y: y(site) - 4, 'text-anchor': 'end' }).textContent = info.site + ' · ' + eur(site);
      }
      mk('circle', { cx: x(s.length - 1), cy: y(s[s.length - 1].price), r: 4, class: 'dt' });
      var cu = mk('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'cu', visibility: 'hidden' });
      var dt = mk('circle', { r: 4, class: 'dt', visibility: 'hidden' });
      svg.addEventListener('mousemove', function (e) {
        var r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * W;
        var i = Math.max(0, Math.min(s.length - 1, Math.round((vx - L) / (W - L - R) * (s.length - 1))));
        var px = x(i), py = y(s[i].price);
        cu.setAttribute('x1', px); cu.setAttribute('x2', px); cu.setAttribute('visibility', 'visible');
        dt.setAttribute('cx', px); dt.setAttribute('cy', py); dt.setAttribute('visibility', 'visible');
        tip.style.display = 'block'; tip.style.left = (12 + px) + 'px'; tip.style.top = (12 + py) + 'px';
        tip.replaceChildren(E('b', '', eur(s[i].price)), document.createTextNode(' · ' + day(s[i].t)));
        if (s[i].shop) { tip.append(E('br'), document.createTextNode(s[i].shop)); }
      });
      svg.addEventListener('mouseleave', function () { cu.setAttribute('visibility', 'hidden'); dt.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
      return svg;
    }
    function renderOffers() {
      var offers = product.offers, all = E('button', 'btn gh full');
      all.append(ic(I.ext), document.createTextNode(offers.length ? 'Toutes les offres sur le comparateur' : 'Voir toutes les offres'));
      all.onclick = function () { openUrl(current.url + '#prices'); };
      if (!offers.length) { fill('g-o', 'Offres des marchands', [E('div', 'note', product.low ? 'Dès ' + eur(product.low) + ' chez ' + product.offerCount + ' marchands.' : 'Aucune offre trouvée.'), all]); return; }
      var list = E('div', 'list');
      offers.forEach(function (o, i) {
        var b = E('button', 'row' + (i === 0 ? ' best' : ''));
        var m = E('div', 'mn');
        m.append(E('b', '', o.shop), E('i', '', (o.stock ? 'En stock · ' : '') + o.title));
        var pr = E('div', 'pr');
        if (o.was) pr.append(E('s', '', eur(o.was)));
        pr.append(document.createTextNode(eur(o.price)));
        if (info.price && info.price - o.price > 1) pr.append(E('em', '', '−' + eur(info.price - o.price)));
        b.append(E('div', 'si', o.shop.charAt(0).toUpperCase()), m, pr);
        b.title = 'Ouvrir l’offre chez ' + o.shop;
        b.onclick = function () { openUrl(o.url); };
        list.append(b);
      });
      fill('g-o', h3('Offres des marchands', product.offerCount || offers.length), [list, all]);
    }
    function siteSlug(host) {
      var parts = host.toLowerCase().replace(/^www\./, '').split('.');
      if (parts.length >= 3 && /^(co|com)$/.test(parts[parts.length - 2])) return parts[parts.length - 3];
      return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    }
    async function loadCoupons(my) {
      var list;
      try { list = parseCoupons(await fetchPage('https://www.dealabs.com/codes-promo/' + slug)); } catch (e) { list = null; }
      if (my !== run) return;
      coupons = list;
      renderCoupons(); renderAI();
    }
    function renderCoupons() {
      var title = 'Codes promo pour ' + info.site;
      if (!coupons || !coupons.length) { fill('g-c', title, [E('div', 'note', coupons ? 'Aucun code promo en cours pour ce site.' : 'Aucun code promo répertorié pour ce site.')]); return; }
      var list = E('div', 'list'), shown = Math.min(5, coupons.length);
      function add(c) {
        var box = E('div', 'cp'), tp = E('div', 'tp');
        if (c.badge) tp.append(E('div', 'bg', c.badge));
        tp.append(E('div', 't', c.title));
        var bt = E('div', 'bt');
        if (c.verified) { var ok = E('span', 'ok'); ok.append(ic(I.check), document.createTextNode('Vérifié')); bt.append(ok); }
        if (c.end) bt.append(E('span', '', 'jusqu’au ' + day(c.end)));
        if (c.code) {
          var code = E('button', 'code', c.code), lab = E('span', '', 'Copier');
          code.title = 'Copier le code';
          code.append(lab);
          code.onclick = function () { try { navigator.clipboard.writeText(c.code); } catch (e) {} lab.textContent = 'Copié !'; setTimeout(function () { lab.textContent = 'Copier'; }, 1600); };
          bt.append(code);
        } else bt.append(E('span', '', '· offre sans code'));
        box.title = c.terms;
        box.append(tp, bt);
        list.append(box);
      }
      coupons.slice(0, shown).forEach(add);
      var nodes = [list];
      if (coupons.length > shown) {
        var more = E('button', 'btn gh full', 'Voir les ' + (coupons.length - shown) + ' autres');
        more.onclick = function () { coupons.slice(shown).forEach(add); more.remove(); };
        nodes.push(more);
      }
      fill('g-c', h3(title, coupons.length), nodes);
    }
    function renderAI() {
      var g = $('g-a');
      if (!g || (aiBox && aiBox.isConnected)) return;
      var b = E('button', 'btn gh full');
      var sp = spark(); sp.setAttribute('class', 'sp');
      b.append(sp, document.createTextNode('Demander conseil à l’IA'));
      b.onclick = function () {
        var lines = ['Je regarde cet article : « ' + info.name + ' » sur ' + info.site + (info.price ? ' à ' + eur(info.price) : '') + '.'];
        if (product) {
          var b2 = best();
          if (b2.price) lines.push('Meilleur prix trouvé sur leDénicheur : ' + eur(b2.price) + (b2.offer ? ' chez ' + b2.offer.shop : '') + '.');
          if (product.offers.length) lines.push('Offres : ' + product.offers.map(function (o) { return o.shop + ' ' + eur(o.price) + (o.was ? ' (au lieu de ' + eur(o.was) + ')' : ''); }).join(' ; ') + '.');
          var st = stats(90);
          if (st) lines.push('Sur 3 mois, le prix le plus bas était ' + eur(st.min) + ', le moyen ' + eur(Math.round(st.avg)) + ' et le plus haut ' + eur(st.max) + '.');
        }
        if (found.length > 1) lines.push('Produits proches : ' + found.slice(0, 5).map(function (r) { return r.name + (r.price ? ' dès ' + eur(r.price) : ''); }).join(' ; ') + '.');
        if (coupons && coupons.length) lines.push('Codes promo en cours sur ' + info.site + ' : ' + coupons.slice(0, 6).map(function (c) { return (c.code ? c.code + ' : ' : '') + c.title; }).join(' ; ') + '.');
        lines.push('\nEst-ce le bon moment pour acheter ? Quelle est la meilleure option en tenant compte des prix, de l’historique et des codes promo ? Réponds en français, en 5 lignes maximum, sans tableau, puis donne ton conseil final en une phrase.');
        aiReq = 's' + Date.now().toString(36);
        aiBox = E('div', 'adv');
        var ah = E('div', 'ah'); var sp2 = spark(); ah.append(sp2, E('span', '', 'Conseil de l’IA'));
        aiBox.append(ah, waitRow('L’IA analyse les prix…'));
        g.append(aiBox);
        b.disabled = true;
        send('shop_ai', { prompt: lines.join('\n'), req: aiReq });
      };
      g.replaceChildren(b);
      aiBox = null;
    }
    window.__corrtexShopAI = function (id, txt, done, error) {
      if (id !== aiReq || !aiBox || (!txt && !done)) return;
      var ah = aiBox.firstChild;
      aiBox.replaceChildren(ah);
      if (error && !txt) { aiBox.append(E('p', '', 'L’IA n’a pas répondu. Vérifiez que vous êtes connecté à votre IA dans le panneau IA.')); return; }
      var ul = null;
      String(txt).split(/\n+/).forEach(function (line) {
        var t = line.trim();
        if (!t) return;
        var li = t.match(/^([-*•]|\d+[.)])\s+(.*)$/), node = E(li ? 'li' : 'p');
        (li ? li[2] : t.replace(/^#+\s*/, '')).split(/\*\*(.+?)\*\*/).forEach(function (part, i) { node.append(i % 2 ? E('b', '', part) : document.createTextNode(part)); });
        if (li) { if (!ul) { ul = E('ul'); aiBox.append(ul); } ul.append(node); } else { ul = null; aiBox.append(node); }
      });
      if (!done) aiBox.append(waitRow('…'));
    };

    // ---------------------------------------------------------------- bouton « Comparer les prix »
    // même style que les boutons de Corrtex dans les pages (pilule en verre, icône de la couleur du thème)
    function btnCss() {
      var th = cxTheme(), dark = th.scheme !== 'light';
      var fg = th.fg || (dark ? '#f4f4f6' : '#111');
      var card = th.card || (dark ? '#3a3a3e' : '#ffffff');
      var border = dark ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.14)';
      return [
        ':host { all: initial; }',
        '.b { position: fixed; z-index: 2147483644; top: 14px; right: 14px; display: flex; align-items: center; gap: 6px; animation: in .25s ease-out; }',
        '@keyframes in { from { opacity: 0; transform: translateY(-8px); } }',
        'button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: default;',
        '  font: 600 13.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: ' + fg + ';',
        '  background: color-mix(in srgb, ' + card + ' 70%, transparent); border: 1px solid ' + border + ';',
        '  backdrop-filter: blur(24px) saturate(1.5); -webkit-backdrop-filter: blur(24px) saturate(1.5);',
        '  box-shadow: 0 8px 24px rgba(0,0,0,' + (dark ? '.35' : '.15') + '), inset 0 1px 0 rgba(255,255,255,.16); transition: transform .12s, background .12s; }',
        'button:hover { background: color-mix(in srgb, ' + card + ' 88%, transparent); }',
        'button:active { transform: scale(.97); }',
        '.go { height: 38px; padding: 0 16px 0 13px; border-radius: 19px; }',
        '.go svg { width: 16px; height: 16px; fill: none; stroke: ' + th.accent + '; stroke-width: 1.9; stroke-linecap: round; filter: drop-shadow(0 0 4px ' + th.accent + '); }',
        '.x { width: 30px; height: 30px; border-radius: 50%; opacity: .85; }',
        '.x svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }'
      ].join('\n');
    }
    function showButton() {
      if (dismissed || (btn && btn.host.isConnected)) return;
      var hh = document.createElement('corrtex-shop');
      var rr = hh.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = btnCss();
      rr.appendChild(st);
      (document.body || document.documentElement).appendChild(hh);
      btn = { host: hh, root: rr };
      var b = E('div', 'b');
      var go = E('button', 'go'); go.title = 'Comparer les prix, voir l’historique et les codes promo';
      go.append(cxIcon(I.chart), document.createTextNode('Comparer les prix'));
      go.addEventListener('click', openPanel);
      var x = E('button', 'x'); x.title = 'Masquer sur cette page'; x.append(cxIcon(I.x));
      x.addEventListener('click', function () { dismissed = true; btn.host.remove(); });
      b.append(go, x);
      btn.root.appendChild(b);
      if (P) btn.host.style.display = 'none';
    }
    function hideButton() { if (btn) { btn.host.remove(); btn = null; } }
    function check() {
      if (!allowed) return;
      if (location.href !== lastUrl) { lastUrl = location.href; dismissed = false; sent = null; if (P) closePanel(); }
      var inf = detect();
      var key = inf ? inf.name + '|' + inf.price : '', old = sent ? sent.name + '|' + sent.price : '';
      if (key !== old) { sent = inf; send('shop_detect', inf); }
      if (inf) showButton(); else hideButton();
    }
    if (allowed) {
      setTimeout(check, 1200);
      setTimeout(check, 3500);
      setInterval(function () { if (location.href !== lastUrl) setTimeout(check, 1200); }, 1000);
    }
  })();
  // ---------------------------------------------------------------- gestes de la souris
  // Clic droit maintenu + glisser : ← précédent, → suivant, ↑ actualiser, ↓ nouvel onglet,
  // ↓ puis → fermer l'onglet, ← puis ↑ rouvrir l'onglet fermé. Le tracé s'affiche en direct.
  (function () {
    var g = null, cv = null, ctx = null, lab = null, suppress = false;
    var NAMES = { L: 'Précédent', R: 'Suivant', U: 'Actualiser', D: 'Nouvel onglet', DR: 'Fermer l’onglet', LU: 'Rouvrir l’onglet fermé' };
    function dirs(pts) {
      var out = '', last = pts[0];
      for (var i = 1; i < pts.length; i++) {
        var dx = pts[i].x - last.x, dy = pts[i].y - last.y;
        if (Math.abs(dx) < 28 && Math.abs(dy) < 28) continue;
        var d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
        if (out[out.length - 1] !== d) out += d;
        last = pts[i];
      }
      return out.slice(0, 3);
    }
    function overlay() {
      var th = cxTheme();
      cv = document.createElement('canvas');
      cv.width = innerWidth; cv.height = innerHeight;
      cv.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      ctx = cv.getContext('2d');
      ctx.strokeStyle = th.accent; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowColor = th.accent; ctx.shadowBlur = 10;
      lab = document.createElement('div');
      lab.style.cssText = 'position:fixed;left:50%;top:40%;transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;padding:10px 18px;border-radius:20px;' +
        'font:600 15px "Segoe UI",system-ui,sans-serif;color:#fff;background:rgba(30,30,34,.72);backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);border:1px solid rgba(255,255,255,.3);display:none';
      (document.body || document.documentElement).append(cv, lab);
    }
    function clear() { if (cv) { cv.remove(); lab.remove(); cv = null; } g = null; }
    document.addEventListener('mousedown', function (e) {
      if (e.button !== 2 || !GESTURES) return;
      g = { pts: [{ x: e.clientX, y: e.clientY }] };
    }, true);
    document.addEventListener('mousemove', function (e) {
      if (!g || !(e.buttons & 2)) return;
      var p = { x: e.clientX, y: e.clientY }, f = g.pts[0];
      g.pts.push(p);
      if (!cv && Math.hypot(p.x - f.x, p.y - f.y) > 14) overlay();
      if (cv) {
        var q = g.pts[g.pts.length - 2];
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        var d = dirs(g.pts);
        lab.style.display = d ? 'block' : 'none';
        lab.textContent = NAMES[d] || 'Geste inconnu';
      }
    }, true);
    document.addEventListener('mouseup', function (e) {
      if (e.button !== 2 || !g) return;
      var d = cv ? dirs(g.pts) : '';
      var drew = !!cv;
      clear();
      if (drew) {
        suppress = true;
        setTimeout(function () { suppress = false; }, 300);
        if (NAMES[d]) send('gesture', d);
      }
    }, true);
    // pas de menu contextuel après un geste
    document.addEventListener('contextmenu', function (e) { if (suppress) { e.preventDefault(); e.stopImmediatePropagation(); suppress = false; } }, true);
  })();

  // ---------------------------------------------------------------- capture d'écran : choix de la zone
  (function () {
    window.__corrtexCaptureArea = function () {
      if (document.querySelector('corrtex-capture')) return;
      var th = cxTheme();
      var h = document.createElement('corrtex-capture');
      var r = h.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = [
        ':host { all: initial; }',
        '.ov { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(0,0,0,.35); }',
        '.sel { position: fixed; border: 2px solid ' + th.accent + '; box-shadow: 0 0 0 9999px rgba(0,0,0,.45), 0 0 18px ' + th.accent + '; border-radius: 6px; display: none; pointer-events: none; }',
        '.bar { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; gap: 6px; padding: 5px; border-radius: 22px;',
        '  font: 600 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #f4f4f6; background: rgba(40,40,46,.75); border: 1px solid rgba(255,255,255,.3);',
        '  backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4); box-shadow: 0 10px 30px rgba(0,0,0,.35); align-items: center; }',
        '.bar span { padding: 0 10px 0 12px; opacity: .85; font-weight: 500; }',
        '.bar button { all: unset; height: 32px; padding: 0 14px; border-radius: 16px; background: rgba(255,255,255,.1); cursor: default; }',
        '.bar button:hover { background: rgba(255,255,255,.2); }',
        '.size { position: fixed; z-index: 2147483647; padding: 3px 8px; border-radius: 8px; font: 600 11.5px "Segoe UI", system-ui; color: #fff; background: rgba(0,0,0,.7); display: none; pointer-events: none; }'
      ].join('\n');
      var ov = document.createElement('div'); ov.className = 'ov';
      var sel = document.createElement('div'); sel.className = 'sel';
      var size = document.createElement('div'); size.className = 'size';
      var bar = document.createElement('div'); bar.className = 'bar';
      var tip = document.createElement('span'); tip.textContent = 'Glissez pour choisir une zone';
      var vis = document.createElement('button'); vis.textContent = 'Partie visible';
      var full = document.createElement('button'); full.textContent = 'Page entière';
      var esc = document.createElement('button'); esc.textContent = 'Annuler';
      bar.append(tip, vis, full, esc);
      r.append(st, ov, sel, size, bar);
      (document.body || document.documentElement).appendChild(h);
      function close() { h.remove(); document.removeEventListener('keydown', key, true); }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
      document.addEventListener('keydown', key, true);
      // le calque est retiré avant la capture
      function shoot(fn) { close(); requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
      vis.onclick = function () { shoot(function () { send('capture_area', { x: 0, y: 0, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, full: true }); }); };
      full.onclick = function () { shoot(function () { send('action_capture', 'full'); }); };
      esc.onclick = close;
      var start = null;
      ov.addEventListener('mousedown', function (e) { if (e.button !== 0) return; start = { x: e.clientX, y: e.clientY }; });
      ov.addEventListener('mousemove', function (e) {
        if (!start) return;
        var x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY), w = Math.abs(e.clientX - start.x), hh = Math.abs(e.clientY - start.y);
        sel.style.display = 'block'; ov.style.background = 'transparent';
        sel.style.left = x + 'px'; sel.style.top = y + 'px'; sel.style.width = w + 'px'; sel.style.height = hh + 'px';
        size.style.display = 'block'; size.style.left = (x + w + 8) + 'px'; size.style.top = (y + hh + 8) + 'px';
        size.textContent = Math.round(w) + ' × ' + Math.round(hh);
      });
      ov.addEventListener('mouseup', function (e) {
        if (!start) return;
        var x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY), w = Math.abs(e.clientX - start.x), hh = Math.abs(e.clientY - start.y);
        start = null;
        if (w < 8 || hh < 8) { sel.style.display = 'none'; size.style.display = 'none'; ov.style.background = ''; return; }
        shoot(function () { send('capture_area', { x: x, y: y, w: w, h: hh, dpr: devicePixelRatio }); });
      });
    };
  })();

  // ---------------------------------------------------------------- vidéo en lecteur flottant
  // Image dans l'image si le moteur le permet ; sinon un mini-lecteur qui reste visible en bas à droite.
  (function () {
    var mini = null, hoverBtn = null, hoverVid = null;
    function biggest() {
      var best = null, area = 0;
      document.querySelectorAll('video').forEach(function (v) {
        var r = v.getBoundingClientRect(), a = r.width * r.height;
        if (v.readyState > 0 && a > area && (!v.paused || !best)) { best = v; area = a; }
      });
      return best;
    }
    function exitMini() {
      if (!mini) return;
      var v = mini.v;
      v.setAttribute('style', mini.style || '');
      if (!mini.style) v.removeAttribute('style');
      mini.ph.replaceWith(v);
      mini.close.remove();
      mini = null;
    }
    function miniPlayer(v) {
      if (mini) { exitMini(); return; }
      var r = v.getBoundingClientRect();
      var ph = document.createElement('div');
      ph.style.cssText = 'width:' + r.width + 'px;height:' + r.height + 'px';
      var style = v.getAttribute('style');
      v.replaceWith(ph);
      (document.body || document.documentElement).appendChild(v);
      v.style.cssText = 'position:fixed!important;right:18px!important;bottom:18px!important;width:400px!important;height:auto!important;max-height:260px!important;' +
        'z-index:2147483646!important;border-radius:16px!important;box-shadow:0 18px 50px rgba(0,0,0,.45)!important;background:#000!important;object-fit:contain!important;';
      var close = document.createElement('button');
      close.textContent = '✕';
      close.title = 'Remettre la vidéo à sa place';
      close.style.cssText = 'all:unset;position:fixed;right:26px;bottom:' + (18 + Math.min(260, 400 * (v.videoHeight || 9) / (v.videoWidth || 16)) - 38) + 'px;z-index:2147483647;' +
        'width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;font:14px sans-serif;background:rgba(0,0,0,.55);cursor:default';
      close.onclick = exitMini;
      document.documentElement.appendChild(close);
      mini = { v: v, ph: ph, style: style, close: close };
      v.play && v.play().catch(function () {});
    }
    function pip(v) {
      v = v || biggest();
      if (!v) return;
      if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(function () {}); return; }
      if (document.pictureInPictureEnabled && !v.disablePictureInPicture && v.requestPictureInPicture) {
        v.requestPictureInPicture().catch(function () { miniPlayer(v); });
      } else miniPlayer(v);
    }
    window.__corrtexPip = function () { pip(null); };
    // bouton au survol des vidéos
    function ensureBtn() {
      if (hoverBtn) return;
      hoverBtn = document.createElement('button');
      hoverBtn.title = 'Lecteur flottant (Alt+P)';
      hoverBtn.textContent = '⧉  Lecteur flottant';
      hoverBtn.style.cssText = 'all:unset;position:fixed;z-index:2147483645;height:30px;padding:0 12px;border-radius:15px;display:none;align-items:center;' +
        'font:600 12.5px "Segoe UI",system-ui,sans-serif;color:#fff;background:rgba(20,20,24,.6);backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);border:1px solid rgba(255,255,255,.3);cursor:default';
      hoverBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); pip(hoverVid); hoverBtn.style.display = 'none'; });
      document.documentElement.appendChild(hoverBtn);
    }
    // plein écran (page ou vidéo) : pas de bouton par-dessus la vidéo
    function fullscreen(v) {
      return !!(document.fullscreenElement || document.webkitFullscreenElement || (v && v.webkitDisplayingFullscreen));
    }
    function hideBtn() { if (hoverBtn) hoverBtn.style.display = 'none'; hoverVid = null; }
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () { if (fullscreen(null)) hideBtn(); }, true);
    });
    document.addEventListener('webkitbeginfullscreen', hideBtn, true);
    // pages sans vidéo : rien à faire (la liste des vidéos est tenue à jour par le navigateur)
    var vids = document.getElementsByTagName('video'), mmRaf = 0, lastE = null;
    document.addEventListener('mousemove', function (e) {
      if (!vids.length && !hoverVid) return;
      lastE = e;
      if (mmRaf) return;
      mmRaf = requestAnimationFrame(function () { mmRaf = 0; onMove(lastE); });
    }, true);
    function onMove(e) {
      var v = e.target && e.target.closest ? e.target.closest('video') : null;
      if (!v && hoverVid) {
        var r0 = hoverVid.getBoundingClientRect();
        if (e.clientX >= r0.left && e.clientX <= r0.right && e.clientY >= r0.top && e.clientY <= r0.bottom) v = hoverVid;
      }
      if (e.target === hoverBtn) return;
      if (!v || (mini && mini.v === v) || fullscreen(v)) { hideBtn(); return; }
      var r = v.getBoundingClientRect();
      if (r.width < 240 || r.height < 140) return;
      ensureBtn();
      hoverVid = v;
      hoverBtn.style.display = 'flex';
      hoverBtn.style.left = (r.right - 160) + 'px';
      hoverBtn.style.top = (r.top + 12) + 'px';
    }
  })();

  // ---------------------------------------------------------------- mots de passe
  // À la création d'un compte : proposition d'un mot de passe fort, et force du mot de passe tapé.
  (function () {
    var box = null, field = null;
    function isNew(el) {
      if (!el || el.tagName !== 'INPUT' || el.type !== 'password') return false;
      if (/new-password/i.test(el.autocomplete)) return true;
      if (/current-password/i.test(el.autocomplete)) return false;
      var form = el.form || el.closest('form');
      if (form && form.querySelectorAll('input[type=password]').length >= 2) return true;
      return /(new|nouveau|confirm|register|signup|sign-up|inscri|create|creer|créer)/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + location.pathname);
    }
    function generate() {
      var sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#$%&*+-=?@_'];
      var all = sets.join(''), out = [], rnd = new Uint32Array(20);
      crypto.getRandomValues(rnd);
      sets.forEach(function (s, i) { out.push(s[rnd[i] % s.length]); });
      for (var i = 4; i < 18; i++) out.push(all[rnd[i] % all.length]);
      // mélange
      var r2 = new Uint32Array(out.length); crypto.getRandomValues(r2);
      for (var j = out.length - 1; j > 0; j--) { var k = r2[j] % (j + 1), t = out[j]; out[j] = out[k]; out[k] = t; }
      return out.join('');
    }
    function strength(p) {
      if (!p) return 0;
      var s = 0;
      if (p.length >= 8) s++;
      if (p.length >= 12) s++;
      if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
      if (/\d/.test(p)) s++;
      if (/[^A-Za-z0-9]/.test(p)) s++;
      if (/^(.)\1+$|123456|password|azerty|qwerty|motdepasse/i.test(p)) s = 1;
      return Math.min(4, Math.max(1, s - 1));
    }
    function setVal(el, v) {
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function hide() { if (box) { box.host.remove(); box = null; } }
    function place() {
      if (!box || !field || !field.isConnected) return hide();
      var r = field.getBoundingClientRect();
      box.card.style.left = Math.max(8, Math.min(r.left, innerWidth - 330)) + 'px';
      box.card.style.top = (r.bottom + 6) + 'px';
    }
    function show(el) {
      hide();
      field = el;
      var th = cxTheme(), dark = th.scheme !== 'light';
      var fg = th.fg || (dark ? '#f4f4f6' : '#111'), card = th.card || (dark ? '#3a3a3e' : '#fff');
      var h = document.createElement('corrtex-pass');
      var r = h.attachShadow({ mode: 'closed' });
      var st = document.createElement('style');
      st.textContent = [
        ':host { all: initial; }',
        '.c { position: fixed; z-index: 2147483646; width: 320px; padding: 12px 14px; border-radius: 18px; font: 13px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: ' + fg + ';',
        '  background: color-mix(in srgb, ' + card + ' 80%, transparent); backdrop-filter: blur(24px) saturate(1.4); -webkit-backdrop-filter: blur(24px) saturate(1.4); border: 1px solid ' + (dark ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.14)') + '; box-shadow: 0 14px 36px rgba(0,0,0,.3); }',
        '.t { font-weight: 600; display: flex; align-items: center; gap: 8px; }',
        '.t svg { width: 15px; height: 15px; fill: none; stroke: ' + th.accent + '; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }',
        '.pw { margin: 8px 0; padding: 8px 10px; border-radius: 10px; font: 600 13.5px ui-monospace, Consolas, monospace; letter-spacing: .5px; background: ' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)') + '; word-break: break-all; }',
        '.r { display: flex; gap: 6px; }',
        'button { all: unset; height: 30px; padding: 0 12px; border-radius: 15px; font-weight: 600; font-size: 12.5px; cursor: default; background: ' + (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)') + '; }',
        'button:hover { filter: brightness(1.2); } button.go { background: ' + th.accent + '; color: #fff; }',
        '.bar { height: 6px; border-radius: 3px; background: ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)') + '; overflow: hidden; margin: 8px 0 4px; }',
        '.bar i { display: block; height: 100%; border-radius: 3px; transition: width .2s, background .2s; }',
        '.n { font-size: 12px; opacity: .8; }'
      ].join('\n');
      var c = document.createElement('div'); c.className = 'c';
      var t = document.createElement('div'); t.className = 't';
      t.append(cxIcon('M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5M6 10.5h12v9H6zM12 14v2.5'), document.createTextNode('Mot de passe fort suggéré'));
      var pwv = generate();
      var pw = document.createElement('div'); pw.className = 'pw'; pw.textContent = pwv;
      var row = document.createElement('div'); row.className = 'r';
      var use = document.createElement('button'); use.className = 'go'; use.textContent = 'Utiliser';
      var other = document.createElement('button'); other.textContent = 'Un autre';
      var no = document.createElement('button'); no.textContent = 'Non merci';
      row.append(use, other, no);
      var bar = document.createElement('div'); bar.className = 'bar';
      var fill = document.createElement('i'); bar.append(fill);
      var n = document.createElement('div'); n.className = 'n';
      c.append(t, pw, row, bar, n);
      r.append(st, c);
      (document.body || document.documentElement).appendChild(h);
      box = { host: h, card: c, fill: fill, note: n };
      [c, use, other, no].forEach(function (x) { x.addEventListener('mousedown', function (e) { e.preventDefault(); }); });
      other.onclick = function () { pwv = generate(); pw.textContent = pwv; };
      no.onclick = hide;
      use.onclick = function () {
        // le champ et sa confirmation dans le même formulaire
        var form = field.form || field.closest('form') || document;
        var list = Array.prototype.filter.call(form.querySelectorAll('input[type=password]'), function (x) { return isNew(x) || x === field; });
        list.forEach(function (x) { setVal(x, pwv); });
        try { navigator.clipboard.writeText(pwv); } catch (e) {}
        n.textContent = 'Rempli et copié : enregistrez-le dans votre gestionnaire de mots de passe.';
        meter();
        setTimeout(hide, 3500);
      };
      meter();
      place();
    }
    function meter() {
      if (!box || !field) return;
      var s = strength(field.value), cols = ['#ff5c6c', '#ffb05c', '#ffd166', '#4fcf8a'], names = ['Très faible', 'Faible', 'Moyen', 'Fort'];
      box.fill.style.width = field.value ? (s * 25) + '%' : '0';
      box.fill.style.background = cols[s - 1] || 'transparent';
      if (!/copié/.test(box.note.textContent)) box.note.textContent = field.value ? 'Force du mot de passe tapé : ' + names[s - 1] + (s < 3 ? ' — ajoutez longueur, chiffres et symboles.' : '.') : 'Le mot de passe tapé sera évalué ici.';
    }
    document.addEventListener('focusin', function (e) { var el = e.target; if (isNew(el)) show(el); }, true);
    document.addEventListener('focusout', function (e) { if (e.target === field) setTimeout(function () { if (document.activeElement !== field) hide(); }, 200); }, true);
    document.addEventListener('input', function (e) { if (e.target === field) meter(); }, true);
    window.addEventListener('scroll', place, true);
  })();

})();
