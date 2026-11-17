// Style Corrtex pour les pages de recherche Google (www.google.*) :
// - fond aux couleurs du thème avec la lueur animée de la page d'accueil Corrtex,
// - barre de recherche identique à celle de la page d'accueil, logo « Corrtex »,
// - résultats dans des bulles en verre, cartes et barre de l'aperçu IA en verre.
// S'adapte au mode de Google (clair ou sombre) pour garder un texte lisible.
// Réinjecté par Corrtex après chaque chargement : le script est idempotent.
(function () {
  if (window.top !== window || !/^www\.google\./.test(location.hostname)) return;
  if (window.__corrtexGoogle) return;

  var theme = { bg1: '#2f2f32', bg2: '#1e1e21', accent: '#ff4f7b' };
  var enabled = true;
  var googleDark = null;

  // police du logo (Poppins Bold réduite aux lettres de « Corrtex », ~1 Ko)
  try {
    var face = new FontFace('CorrtexLogo', 'url(data:font/woff2;base64,d09GMgABAAAAAANIAAwAAAAABdgAAAL5AAQBBgAAAAAAAAAAAAAAAAAAAAAAAAAAGyAcMAZgAFwKgzSCfwE2AiQDHAsQAAQgBYMCByAbwgRRVDBiIH4mmG7ukDZOWqeSG14VX75GOHW5jvh8PBT35tv9e6VSWhvPBANSqoYqHWBAOwX4gDIekIA1sn68Xv1kobdndQaSM1XBn+io8hrg37d29ucjz//NtGiJb9VE9qKs7HvUyz4GlPnYz7vbItnh0YV20Lv9EL9UBzr3ulZQtwv0rZCE7e47egJDwX8AhGeTMnIJ+CdRmeokDQmD4ajtauJyH5V8TF/gxP6YuKIezoAuAAEAR6fWLjDMQnaJ3o9CZOGZBgTkFukEGyhINJhBFphBcQiMdaW2HVFwqdJl/4d0Rm+g9lprqRFmkR3HHKOLG+AFgAKElEKIFRE6N5uDn/0q5NkzVPfEi7X4lFX7GIqfoLpnKujxY1bt06fYH2H2yANUp4GGh1PCgyfgXfKwNu/EnzSrmBIjseuZ8g/PEFgJSCwqggjIADCMhaENgXexoHgGcXh7sgL8kZcP8vWTPvUbHfaPLlgpk0jZd3BUUnMJSwoMdKGLWhg67MvZSmlBNLLPbyQWHOhyZRqTCqYVm09tfZLULN2LrGxKfHysS447PdwKLKwLPBcVFdeUFEaS4BO91Mq+xMfbobTMyt3diQV4ezuWlodTqm2WNhYW5jZq6mbWlham5ZOBdu+nqbOhYvrfijynPBcE6c0tPkEx/jFvLRstq+eqiUbivUiGOFTH9/r17myJ73Mfx/f49ezsCssc8QNAoILW/TopG8Jl+I9BJn+Et/GZAJ+C2udujDIXyhOmI0Hwz4S9AQBfGP5lj9aJvyC/yGQs8SwgHvOMo5NAOqIKdDxhu0YT0hoaJkAj0XGGLIoJTEFIhbEplbqeqca2baos+E619IN2W9tCcIMFHCFHqjgxYqWTpk7VpdI8RTTKcQWLhDjJ0mY1FS5elIib2sxkSBcLl4o4ssnW0hHS6FOhIkactWcIpywCLomK/KtouAzJIqXKofK4OjnpPHO4RJHseLLmwuAFdUy+/H2alKlSpSmcLmyAMAhTSsiW0P+oAwAA)', { weight: '700' });
    face.load().then(function (f) { document.fonts.add(f); }).catch(function () {});
  } catch (e) {}

  // mode de Google : couleur du texte claire = page sombre
  function detectDark() {
    if (googleDark !== null || !document.body) return googleDark;
    var m = getComputedStyle(document.body).color.match(/\d+(\.\d+)?/g);
    if (!m) return null;
    googleDark = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255 > 0.5;
    return googleDark;
  }

  // lueur animée (trois halos), comme sur la page d'accueil Corrtex
  function ensureAmbient(on) {
    var el = document.getElementById('__corrtex_ambient');
    if (!on) { if (el) el.remove(); return; }
    if (el || !document.body) return;
    el = document.createElement('div');
    el.id = '__corrtex_ambient';
    el.setAttribute('aria-hidden', 'true');
    // éléments créés un par un (Google interdit l'insertion de HTML en texte)
    for (var i = 0; i < 3; i++) el.appendChild(document.createElement('i'));
    document.body.prepend(el);
  }

  function hexToHsl(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return [340, .9, .65];
    var n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > .5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    }
    return [h, s, l];
  }
  function hsl(h, s, l) { return 'hsl(' + (((h % 360) + 360) % 360) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%)'; }

  function css(t, dark) {
    var c = hexToHsl(t.accent);
    var l1 = hsl(c[0], c[1], c[2]), l2 = hsl(c[0] + 38, c[1], Math.min(.7, c[2] + .05)), l3 = hsl(c[0] - 42, c[1] * .9, Math.max(.35, c[2] - .05));
    var fg = dark ? '#f4f4f6' : '#1d1d20';
    var glass = dark ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.62)';
    var glass2 = dark ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.36)';
    var edge = dark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.08)';
    var hi = dark ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.95)';
    var border = dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.14)';
    var hover = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.06)';
    var dim = dark ? 'rgba(255,255,255,.62)' : 'rgba(0,0,0,.55)';
    var panel = dark ? 'color-mix(in srgb, ' + t.bg1 + ' 82%, transparent)' : 'rgba(255,255,255,.86)';
    var base = dark ? 'linear-gradient(180deg, ' + t.bg1 + ', ' + t.bg2 + ')' : 'linear-gradient(180deg, #f7f7f9, #eceef2)';
    var card = 'background: linear-gradient(180deg, ' + glass + ', ' + glass2 + ') !important; border: 1px solid ' + edge + ' !important;' +
      ' box-shadow: inset 0 1px 0 ' + hi + ', 0 6px 18px rgba(0,0,0,' + (dark ? '.22' : '.06') + ') !important; backdrop-filter: blur(16px) saturate(1.5) !important; -webkit-backdrop-filter: blur(16px) saturate(1.5) !important;';
    // barre « comme la page d'accueil » : verre, bordure épaisse claire, léger halo
    // barre « comme la page d'accueil » : verre uni, bordure claire, léger halo (pas d'ombre ni de dégradé)
    var homeBar = 'background: ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.7)') + ' !important;' +
      ' border: 2px solid ' + (dark ? 'rgba(255,255,255,.38)' : 'rgba(0,0,0,.16)') + ' !important;' +
      ' box-shadow: 0 0 22px ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)') + ' !important;' +
      ' backdrop-filter: blur(16px) !important; -webkit-backdrop-filter: blur(16px) !important;';
    return [
      'html { background: ' + base + ' !important; background-attachment: fixed !important; }',
      'body, .zNsLfb { background: transparent !important; }',
      '#fbar, .fbar, #footcnt { background: transparent !important; }',
      // lueur animée
      '#__corrtex_ambient { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: -1; }',
      '#__corrtex_ambient i { position: absolute; border-radius: 50%; will-change: transform; opacity: ' + (dark ? '.26' : '.16') + ';' + (dark ? ' mix-blend-mode: screen;' : '') + ' }',
      '#__corrtex_ambient i:nth-child(1) { width: 80vmax; height: 80vmax; left: calc(50% - 40vmax); top: calc(50% - 40vmax); background: radial-gradient(circle, ' + l1 + ' 0%, transparent 64%); animation: cxd1 34s ease-in-out infinite alternate; }',
      '#__corrtex_ambient i:nth-child(2) { width: 66vmax; height: 66vmax; left: calc(50% - 33vmax); top: calc(50% - 33vmax); background: radial-gradient(circle, ' + l2 + ' 0%, transparent 64%); animation: cxd2 42s ease-in-out infinite alternate; }',
      '#__corrtex_ambient i:nth-child(3) { width: 56vmax; height: 56vmax; left: calc(50% - 28vmax); top: calc(50% - 28vmax); background: radial-gradient(circle, ' + l3 + ' 0%, transparent 64%); animation: cxd3 51s ease-in-out infinite alternate; }',
      '@keyframes cxd1 { 0% { transform: translate(-38vw,-30vh) } 35% { transform: translate(18vw,-18vh) scale(1.15) } 70% { transform: translate(30vw,26vh) scale(.92) } 100% { transform: translate(-22vw,30vh) scale(1.08) } }',
      '@keyframes cxd2 { 0% { transform: translate(36vw,28vh) scale(1.1) } 40% { transform: translate(-26vw,18vh) scale(.9) } 75% { transform: translate(-30vw,-26vh) scale(1.2) } 100% { transform: translate(24vw,-30vh) } }',
      '@keyframes cxd3 { 0% { transform: translate(6vw,-36vh) scale(.9) } 50% { transform: translate(-34vw,4vh) scale(1.2) } 100% { transform: translate(34vw,10vh) } }',
      '@media (prefers-reduced-motion: reduce) { #__corrtex_ambient i { animation-duration: 240s !important; } }',
      // en-tête qui reste en haut au défilement
      // en-tête : transparent en haut de page ; au défilement, un voile de verre qui part du haut et se fond en bas
      '#searchform, .sfbg { background: transparent !important; box-shadow: none !important; }',
      '#searchform::before { content: ""; position: absolute; left: 0; right: 0; top: -16px; bottom: -14px; z-index: -1; pointer-events: none; opacity: 0; transition: opacity .25s;' +
        ' background: ' + (dark ? 'color-mix(in srgb, ' + t.bg1 + ' 72%, transparent)' : 'rgba(247,247,249,.75)') + '; backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);' +
        ' -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent); mask-image: linear-gradient(180deg, #000 78%, transparent); }',
      'html.cx-scrolled #searchform::before { opacity: 1; }',
      '.RNNXgb .dRYYxd, .RNNXgb .oMByyf:empty { box-shadow: none !important; }',
      // logo « Corrtex » à la place de « Google »
      'a#logo svg, a#logo img { opacity: 0 !important; }',
      'a#logo { position: relative; overflow: visible !important; text-decoration: none !important; }',
      'a#logo::after { content: "Corrtex"; position: absolute; left: 0; top: 50%; transform: translateY(-52%); font: 700 27px/1 CorrtexLogo, "Segoe UI Variable Display", "Segoe UI", sans-serif; letter-spacing: -.5px; color: ' + fg + '; white-space: nowrap; text-shadow: 0 1px 12px ' + (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.06)') + '; }',
      // barre de recherche : même style que la page d'accueil
      '.RNNXgb { ' + homeBar + ' border-radius: 28px !important; }',
      '.RNNXgb .SDkEP, .RNNXgb .a4bIc, .RNNXgb .iblpc, .RNNXgb .dRYYxd { background: transparent !important; }',
      '.RNNXgb:focus-within, .emcav .RNNXgb { border-color: ' + (dark ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.3)') + ' !important; }',
      // suggestions de recherche : même liste que la page d'accueil Corrtex (carte de verre, 6 suggestions)
      '.emcav .RNNXgb, .A8SBwf.emcav .RNNXgb { border-radius: 28px !important; }',
      '.UUbT9 { margin: 10px 10px 0 !important; width: calc(100% - 20px) !important; }',
      '.aajZCb { border-radius: 26px !important; overflow: hidden !important; padding: 8px !important; box-sizing: border-box !important;' +
        ' background: ' + (dark ? 'radial-gradient(120% 140% at 0% 0%, rgba(255,255,255,.20), transparent 55%), linear-gradient(180deg, rgba(255,255,255,.13), rgba(255,255,255,.04)), color-mix(in srgb, ' + t.bg2 + ' 55%, transparent)' : 'linear-gradient(180deg, rgba(255,255,255,.88), rgba(255,255,255,.7))') + ' !important;' +
        ' border: 1px solid ' + (dark ? 'rgba(255,255,255,.32)' : 'rgba(0,0,0,.08)') + ' !important;' +
        ' box-shadow: inset 0 1px 0 rgba(255,255,255,' + (dark ? '.45' : '.9') + '), inset 0 -1px 0 rgba(255,255,255,.08), inset 0 0 22px rgba(255,255,255,.06), 0 18px 40px rgba(0,0,0,' + (dark ? '.30' : '.12') + ') !important;' +
        ' backdrop-filter: blur(26px) saturate(1.8) !important; -webkit-backdrop-filter: blur(26px) saturate(1.8) !important; animation: cxglass .28s cubic-bezier(.2,.9,.3,1.1); }',
      '@keyframes cxglass { from { opacity: 0; transform: translateY(-8px) scale(.98); filter: blur(6px); } }',
      // on ne garde que la liste : ni « Recherches associées », ni mentions, ni séparateurs
      '.aajZCb .xtSCL, .aajZCb .e1R9Ud, .aajZCb > .OBMEnb, .aajZCb > a.lh87ke, .aajZCb .ynRric, .aajZCb > li, .aajZCb .ClJ9Yb, .UUbT9 .WzNHm { display: none !important; }',
      '.aajZCb .gDtRnb, .aajZCb .erkvQe, .aajZCb .erkvQe .OBMEnb, .aajZCb .erkvQe ul { width: 100% !important; max-width: none !important; flex: 1 1 auto !important; padding: 0 !important; margin: 0 !important; }',
      '.aajZCb .erkvQe ul > li:nth-of-type(n+7) { display: none !important; }',
      '.aajZCb, .aajZCb .gDtRnb, .aajZCb .erkvQe, .aajZCb .erkvQe .OBMEnb, .aajZCb .erkvQe ul, .UUbT9 { height: auto !important; min-height: 0 !important; }',
      '.aajZCb li.sbct { min-height: 46px !important; border-radius: 18px !important; margin: 0 !important; padding: 0 !important; display: flex !important; align-items: center !important; animation: cxsg .3s ease both; }',
      '.aajZCb li.sbct:nth-of-type(2) { animation-delay: .04s; } .aajZCb li.sbct:nth-of-type(3) { animation-delay: .08s; } .aajZCb li.sbct:nth-of-type(4) { animation-delay: .12s; } .aajZCb li.sbct:nth-of-type(5) { animation-delay: .16s; } .aajZCb li.sbct:nth-of-type(6) { animation-delay: .2s; }',
      '@keyframes cxsg { from { opacity: 0; transform: translateY(-4px); } }',
      '.aajZCb .eIPGRd { min-height: 46px !important; width: 100% !important; padding: 0 16px !important; box-sizing: border-box !important; display: flex !important; align-items: center !important; gap: 14px !important; }',
      '.aajZCb .sbic { margin: 0 !important; opacity: .75; }',
      '.aajZCb .pcTkSc { padding: 0 !important; }',
      '.aajZCb .wM6W7d, .aajZCb .wM6W7d span { font-size: 16px !important; color: ' + dim + ' !important; }',
      '.aajZCb .wM6W7d b { font-weight: 600 !important; color: ' + fg + ' !important; }',
      '.aajZCb li.sbct.sbhl, .aajZCb li.sbct:hover { background: ' + (dark ? 'linear-gradient(180deg, rgba(255,255,255,.16), rgba(255,255,255,.07))' : 'rgba(0,0,0,.05)') + ' !important; box-shadow: inset 0 1px 0 rgba(255,255,255,' + (dark ? '.3' : '.9') + ') !important; }',
      // onglets « Tous / Images / Vidéos… » : capsule de verre, onglet actif en pilule
      '.zLSRge { display: none !important; }',
      '.beZ0tf { align-items: center !important; gap: 2px !important; height: 42px !important; padding: 0 4px !important; margin-top: 3px !important; border-radius: 21px !important; box-sizing: border-box !important; ' + card + ' box-shadow: inset 0 1px 0 ' + hi + ' !important; }',
      '.beZ0tf .mXwfNd, .beZ0tf .mTpL7c, #hdtb-tls .mXwfNd { min-height: 0 !important; height: 32px !important; padding: 0 14px !important; border-radius: 16px !important; box-sizing: border-box !important; display: flex !important; align-items: center !important; color: ' + dim + ' !important; transition: background .15s, color .15s !important; }',
      '.beZ0tf .mXwfNd:hover, .beZ0tf .mTpL7c:hover, #hdtb-tls .mXwfNd:hover { background: ' + hover + ' !important; color: ' + fg + ' !important; }',
      '.beZ0tf .mXwfNd[aria-current="page"], .beZ0tf .mXwfNd[selected] { background: ' + (dark ? 'rgba(255,255,255,.16)' : '#fff') + ' !important; color: ' + fg + ' !important; box-shadow: inset 0 1px 0 ' + hi + ' !important; }',
      '.beZ0tf .mTpL7c .mXwfNd { padding: 0 !important; height: auto !important; background: none !important; box-shadow: none !important; }',
      '.beZ0tf .mVH5Fc, #hdtb-tls .mVH5Fc { height: auto !important; padding: 0 !important; border: 0 !important; min-height: 0 !important; margin: 0 !important; align-items: center !important; }',
      '.beZ0tf .R1QWuf, #hdtb-tls .R1QWuf { border-bottom: 0 !important; padding: 0 !important; height: auto !important; color: inherit !important; }',
      '#hdtb-tls { display: flex !important; align-items: center !important; margin-left: 8px !important; margin-top: 3px !important; }',
      '#hdtb-tls .mXwfNd { ' + card + ' box-shadow: inset 0 1px 0 ' + hi + ' !important; height: 42px !important; padding: 0 16px !important; border-radius: 21px !important; }',
      '#hdtb-tls .mXwfNd:hover { background: ' + hover + ' !important; }',
      // résultats : chaque site dans une bulle de verre
      '#rso .tF2Cxc { ' + card + ' border-radius: 22px !important; padding: 14px 18px 12px !important; margin: 0 -18px 14px !important; transition: border-color .2s, transform .2s, box-shadow .2s !important; }',
      '#rso .tF2Cxc:hover { border-color: color-mix(in srgb, ' + l1 + ' 50%, ' + edge + ') !important; transform: translateY(-1px); box-shadow: inset 0 1px 0 ' + hi + ', 0 10px 26px rgba(0,0,0,' + (dark ? '.3' : '.1') + '), 0 0 18px color-mix(in srgb, ' + l1 + ' 14%, transparent) !important; }',
      '#rso .MjjYud { margin-bottom: 0 !important; }',
      // cartes : panneau d'informations, recherches associées
      '.lE72Gc, .Casj2d, .kp-wholepage { ' + card + ' }',
      // bloc « Résultats sponsorisés »
      '.vbIt3d { ' + card + ' border-radius: 22px !important; padding: 4px 18px 8px !important; margin-left: -18px !important; margin-right: -18px !important; }',
      '.b2Rnsc { ' + card + ' border-radius: 14px !important; }',
      // filtres de Google (« Gratuit », « En ligne »…) sous les onglets : retirés
      '#hdtb-sc { display: none !important; }',
      // barre « Posez une question » de l'aperçu IA : même verre que la barre de recherche
      '.AgWCw, .esoFne { background: none !important; border: 0 !important; box-shadow: none !important; }',
      // fond opaque : Google fait chevaucher la barre et le texte de l'aperçu quand elle reste collée en bas
      '.AgWCw .d4HWzd::before { ' + homeBar + ' border-radius: 24px !important; background: ' + (dark ? 'color-mix(in srgb, #ffffff 7%, ' + t.bg1 + ')' : '#ffffff') + ' !important; }',
      '.AgWCw .d4HWzd:focus-within::before { border-color: ' + (dark ? 'rgba(255,255,255,.75)' : 'rgba(0,0,0,.3)') + ' !important; }',
      '.AgWCw .A918Hf::after { background: ' + glass + ' !important; border: 1px solid ' + border + ' !important; box-sizing: border-box; }',
      '.Zze5V { display: none !important; }',
      // fondu « Afficher plus » de l'aperçu IA : flou progressif au lieu du gris de Google
      '.RDmXvc { background: none !important; backdrop-filter: blur(10px) !important; -webkit-backdrop-filter: blur(10px) !important; -webkit-mask-image: linear-gradient(180deg, transparent, #000 45%, #000 80%, transparent) !important; mask-image: linear-gradient(180deg, transparent, #000 45%, #000 80%, transparent) !important; }',
      '.vDOt8c { ' + card + ' }',
      // boutons en haut à droite (partager, applications) : boutons ronds de la page d'accueil
      '[data-cxbtn] { width: 40px !important; height: 40px !important; border-radius: 50% !important; box-sizing: border-box !important; display: grid !important; place-items: center !important; background: ' + glass + ' !important; border: 1px solid ' + border + ' !important; backdrop-filter: blur(10px) !important; -webkit-backdrop-filter: blur(10px) !important; transition: background .15s, transform .15s !important; cursor: pointer; }',
      '[data-cxbtn]:hover { background: ' + hover + ' !important; }',
      '[data-cxbtn]::before, [data-cxbtn]::after, [data-cxbtn] > div::before, [data-cxbtn] > div::after { display: none !important; }',
      '[data-cxhide] { display: none !important; }',
      // photo du compte (Corrtex) : même bouton que sur la page d'accueil
      '#__cx_avatar { all: unset; position: relative; flex: none; box-sizing: border-box; width: 40px; height: 40px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; cursor: pointer; margin: 4px; background: ' + glass + '; box-shadow: 0 4px 10px rgba(0,0,0,.3), 0 0 0 1px ' + border + '; transition: transform .15s; }',
      '#__cx_avatar:hover { transform: scale(1.06); }',
      '#__cx_avatar img, .cx-gm-avatar img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }',
      '#__cx_avatar span, .cx-gm-avatar span { width: 100%; height: 100%; display: none; place-items: center; background: #6c63ff; color: #fff; font: 600 16px/1 "Segoe UI", sans-serif; }',
      '#__cx_avatar.noimg img, .cx-gm-avatar.noimg img { display: none; }',
      '#__cx_avatar.noimg span, .cx-gm-avatar.noimg span { display: grid; }',
      // barre d'outils au-dessus des résultats : aperçu IA + filtres, alignée sur les bulles
      '#__cx_tools { display: flex; align-items: center; gap: 10px; margin: 6px 0 6px -18px; position: relative; z-index: 3; }',
      '.cx-pill { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 9px; height: 40px; padding: 0 18px 0 14px; border-radius: 20px; cursor: pointer; font: 600 14px/1 "Segoe UI Variable Text", "Segoe UI", sans-serif; color: ' + fg + '; ' + card + ' transition: border-color .2s, transform .2s !important; }',
      '.cx-pill:hover, .cx-pill[aria-expanded="true"] { border-color: color-mix(in srgb, ' + l1 + ' 55%, ' + edge + ') !important; transform: translateY(-1px); }',
      '.cx-pill svg { width: 18px; height: 18px; flex: none; }',
      '#__cx_aibtn svg { fill: ' + l1 + '; filter: drop-shadow(0 0 6px color-mix(in srgb, ' + l1 + ' 60%, transparent)); transition: transform .4s; }',
      '#__cx_aibtn[aria-expanded="true"] svg { transform: rotate(180deg) scale(.9); }',
      '#__cx_filterbtn svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }',
      '#__cx_filterbtn b { min-width: 20px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 10px; display: grid; place-items: center; font-size: 12px; background: ' + l1 + '; color: #fff; }',
      // menu des filtres : carte de verre façon réglages
      '#__cx_filters { position: absolute; top: 48px; left: 0; width: 380px; padding: 8px 18px 14px; border-radius: 22px; box-sizing: border-box; color: ' + fg + '; font: 14px/1.3 "Segoe UI Variable Text", "Segoe UI", sans-serif; background: ' + panel + '; border: 1px solid ' + border + '; backdrop-filter: blur(28px) saturate(1.3); -webkit-backdrop-filter: blur(28px) saturate(1.3); box-shadow: 0 24px 60px rgba(0,0,0,' + (dark ? '.4' : '.15') + '); transform-origin: 20px 0; animation: cxpop .22s cubic-bezier(.2,.9,.3,1.2); }',
      '@keyframes cxpop { from { opacity: 0; transform: translateY(-6px) scale(.97); } }',
      // panneaux (compte, partager, applications) : même présentation que les réglages Corrtex
      '#__cx_scrim { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.18); }',
      '#__cx_drawer { position: fixed; top: 14px; right: 14px; bottom: 14px; width: 370px; z-index: 2147483001; box-sizing: border-box; padding: 22px 22px 26px; border-radius: 22px; overflow-y: auto; color: ' + fg + '; font: 14px/1.3 "Segoe UI Variable Text", "Segoe UI", sans-serif; text-align: left; background: ' + panel + '; border: 1px solid ' + border + '; backdrop-filter: blur(28px) saturate(1.3); -webkit-backdrop-filter: blur(28px) saturate(1.3); box-shadow: 0 24px 60px rgba(0,0,0,' + (dark ? '.4' : '.15') + '); transform: translateX(calc(100% + 30px)); transition: transform .35s cubic-bezier(.2,.8,.2,1); }',
      '#__cx_drawer.open { transform: none; }',
      '#__cx_drawer::-webkit-scrollbar { width: 0; }',
      '#__cx_drawer *, #__cx_filters * { box-sizing: border-box; }',
      '.cx-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }',
      '.cx-head h2 { margin: 0; font-size: 22px; font-weight: 600; color: ' + fg + '; }',
      '.cx-close { all: unset; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; background: ' + glass + '; border: 1px solid ' + border + '; }',
      '.cx-close:hover { background: ' + hover + '; }',
      '.cx-close svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }',
      '.cx-group { padding: 18px 0; border-bottom: 1px solid ' + hover + '; }',
      '.cx-group:last-child { border-bottom: 0; }',
      '.cx-group h3 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .2px; color: ' + fg + '; }',
      '.cx-profile { display: flex; align-items: center; gap: 16px; }',
      '.cx-gm-avatar { width: 64px; height: 64px; flex: none; border-radius: 50%; overflow: hidden; box-shadow: 0 6px 18px rgba(0,0,0,.3); }',
      '.cx-gm-avatar span { font-size: 26px; }',
      '.cx-name { font-size: 18px; font-weight: 600; }',
      '.cx-email { font-size: 13px; color: ' + dim + '; margin-top: 3px; word-break: break-all; }',
      '.cx-list { display: flex; flex-direction: column; gap: 2px; border-radius: 16px; overflow: hidden; margin-top: 10px; }',
      '.cx-row { all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 8px 14px; cursor: pointer; background: ' + glass + '; font-size: 14px; color: ' + fg + '; }',
      '.cx-row:hover { background: ' + hover + '; }',
      '.cx-row > svg { width: 19px; height: 19px; flex: none; opacity: .9; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }',
      '.cx-row > img { width: 20px; height: 20px; flex: none; border-radius: 4px; }',
      '.cx-row span { flex: 1; min-width: 0; }',
      '.cx-row em { font-style: normal; flex: none; font-size: 12.5px; color: ' + dim + '; }',
      '.cx-row .cx-chev { width: 16px; height: 16px; opacity: .5; }',
      '.cx-apps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; }',
      '.cx-app { all: unset; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px 6px 12px; border-radius: 16px; cursor: pointer; background: ' + glass + '; font-size: 12.5px; color: ' + fg + '; text-align: center; transition: background .15s, transform .15s; }',
      '.cx-app:hover { background: ' + hover + '; transform: translateY(-1px); }',
      '.cx-app img { width: 32px; height: 32px; }',
      '.cx-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }',
      '.cx-chip { all: unset; box-sizing: border-box; height: 34px; padding: 0 15px; border-radius: 17px; display: inline-flex; align-items: center; cursor: pointer; border: 1px solid ' + border + '; background: ' + glass + '; font-size: 13.5px; color: ' + fg + '; }',
      '.cx-chip:hover { background: ' + hover + '; }',
      '.cx-chip.sel { background: ' + fg + '; color: ' + (dark ? t.bg2 : '#fff') + '; border-color: ' + fg + '; font-weight: 600; }',
      '.cx-hint { font-size: 12.5px; color: ' + dim + '; margin: 4px 0 0; }',
      // aperçu IA : masqué derrière le bouton, puis affiché dans une bulle de verre
      '[data-cxai] { ' + card + ' border-radius: 26px !important; padding: 16px 18px 10px !important; margin: 0 -18px 22px !important; box-sizing: content-box !important; transition: opacity .3s ease, transform .35s cubic-bezier(.2,.9,.3,1.1) !important; }',
      '[data-cxai="open"] { margin-top: 12px !important; }',
      '[data-cxai="closed"] { max-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; margin-bottom: 0 !important; border-width: 0 !important; overflow: hidden !important; opacity: 0 !important; transform: translateY(-8px) !important; pointer-events: none !important; }',
      // texte surligné par l'aperçu IA
      'mark.b6AQX { background: color-mix(in srgb, ' + l1 + ' ' + (dark ? '30%' : '18%') + ', transparent) !important; color: inherit !important; }',
      '::selection { background: color-mix(in srgb, ' + l1 + ' 40%, transparent); }'
    ].join('\n');
  }


  // ---------------------------------------------------------------- petits outils DOM
  // (Google interdit l'insertion de HTML en texte : tout est créé élément par élément)
  var SVG = 'http://www.w3.org/2000/svg';
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  // icône : liste de tracés ; une entrée 'c:cx,cy,r' dessine un cercle
  function icon(parts, attrs) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    for (var k in attrs || {}) s.setAttribute(k, attrs[k]);
    parts.forEach(function (p) {
      var n;
      if (p.indexOf('c:') === 0) {
        var v = p.slice(2).split(',');
        n = document.createElementNS(SVG, 'circle');
        n.setAttribute('cx', v[0]); n.setAttribute('cy', v[1]); n.setAttribute('r', v[2]);
      } else {
        n = document.createElementNS(SVG, 'path');
        n.setAttribute('d', p);
      }
      s.appendChild(n);
    });
    return s;
  }
  var I = {
    close: ['M6 6l12 12M18 6L6 18'],
    chev: ['M9 6l6 6-6 6'],
    spark: ['M12 2.5c.5 4.7 2.8 7 7.5 7.5-4.7.5-7 2.8-7.5 7.5-.5-4.7-2.8-7-7.5-7.5 4.7-.5 7-2.8 7.5-7.5zM19 15.5c.2 1.9 1.1 2.8 3 3-1.9.2-2.8 1.1-3 3-.2-1.9-1.1-2.8-3-3 1.9-.2 2.8-1.1 3-3z'],
    filter: ['M4 6.5h16M7 12h10M10 17.5h4'],
    manage: ['c:12,12,9', 'c:12,10,3', 'M6.5 18.5c1.3-2 3.2-3 5.5-3s4.2 1 5.5 3'],
    add: ['c:10,8,3.5', 'M3.5 19c.9-3 3.4-4.5 6.5-4.5 1.2 0 2.3.2 3.2.7M18 14v6M15 17h6'],
    logout: ['M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4', 'M10 8l-4 4 4 4M6 12h10'],
    history: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3.5 4v4.5H8', 'M12 7.5V12l3 2'],
    trash: ['M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13'],
    saved: ['M7 3.5h10a1 1 0 0 1 1 1V20l-6-3.8L6 20V4.5a1 1 0 0 1 1-1z'],
    profile: ['c:12,12,9', 'c:12,10,3', 'M6.5 18.5c1.3-2 3.2-3 5.5-3s4.2 1 5.5 3'],
    shield: ['M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z', 'M8.5 12l2.5 2.5 4.5-5'],
    lang: ['c:12,12,9', 'M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
    gear: ['c:12,12,3', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1'],
    help: ['c:12,12,9', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6', 'M12 17h.01'],
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    mail: ['M4 6.5h16v11H4z', 'M4.5 7l7.5 6 7.5-6'],
    send: ['M20 4L10 14', 'M20 4l-6.5 16-3.5-6-6-3.5z']
  };

  // ---------------------------------------------------------------- panneau façon réglages
  function closeDrawer() {
    var d = document.getElementById('__cx_drawer'), s = document.getElementById('__cx_scrim');
    if (s) s.remove();
    if (!d) return;
    d.classList.remove('open');
    setTimeout(function () { if (!d.classList.contains('open')) d.remove(); }, 360);
  }
  function openDrawer(title, build) {
    closeFilters();
    var old = document.getElementById('__cx_drawer');
    if (old) old.remove();
    var scrim = document.getElementById('__cx_scrim') || el('div');
    scrim.id = '__cx_scrim';
    scrim.onclick = closeDrawer;
    document.body.appendChild(scrim);
    var d = el('section');
    d.id = '__cx_drawer';
    var head = el('header', 'cx-head');
    var close = el('button', 'cx-close');
    close.type = 'button';
    close.title = 'Fermer';
    close.appendChild(icon(I.close));
    close.onclick = closeDrawer;
    head.append(el('h2', '', title), close);
    d.appendChild(head);
    build(d);
    document.body.appendChild(d);
    requestAnimationFrame(function () { requestAnimationFrame(function () { d.classList.add('open'); }); });
  }
  function group(title) {
    var g = el('div', 'cx-group');
    if (title) g.appendChild(el('h3', '', title));
    return g;
  }
  function row(ic, label, onclick, right) {
    var b = el('button', 'cx-row');
    b.type = 'button';
    if (typeof ic === 'string') { var img = el('img'); img.src = ic; img.alt = ''; b.appendChild(img); }
    else b.appendChild(icon(ic));
    b.appendChild(el('span', '', label));
    if (right) b.appendChild(el('em', '', right));
    b.appendChild(icon(I.chev, { 'class': 'cx-chev' }));
    b.onclick = onclick;
    return b;
  }
  function go(url) { closeDrawer(); location.href = url; }
  function openTab(url) { closeDrawer(); window.open(url, '_blank'); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); closeFilters(); }
  }, true);

  // ---------------------------------------------------------------- compte Google
  var profile = null;           // envoyé par Corrtex : { status, name, email, avatar }
  function googleAccountLink() {
    return document.querySelector('#gb a[href*="SignOutOptions"], #gb a[aria-label*="Compte Google"], #gb a[aria-label*="Google Account"]');
  }
  // profil : celui de Corrtex, sinon celui lu dans l'en-tête de Google
  function account() {
    var a = googleAccountLink();
    var p = { name: '', email: '', avatar: '' };
    if (profile && profile.status === 'signed_in') { p.name = profile.name || ''; p.email = profile.email || ''; p.avatar = profile.avatar || ''; }
    if (a) {
      var label = (a.getAttribute('aria-label') || '').replace(/\s+/g, ' ');
      var m = label.match(/(?:Compte Google|Google Account)\s*:?\s*(.*?)\s*\(([^)\s]+@[^)\s]+)\)/);
      if (m) { p.name = p.name || m[1]; p.email = p.email || m[2]; }
      var imgs = a.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        if (/googleusercontent|ggpht/.test(imgs[i].src) && !p.avatar) p.avatar = imgs[i].src.replace(/=s\d+(-[a-z])?/, '=s128');
      }
    }
    return (a || (profile && profile.status === 'signed_in')) ? p : null;
  }
  function fillAvatar(box, p) {
    box.replaceChildren();
    var img = el('img');
    img.alt = '';
    var letter = el('span', '', ((p.name || p.email || '?').trim().charAt(0) || '?').toUpperCase());
    box.append(img, letter);
    if (p.avatar) {
      box.classList.remove('noimg');
      img.onerror = function () { box.classList.add('noimg'); };
      img.src = p.avatar;
    } else box.classList.add('noimg');
  }
  var ACCOUNT_GROUPS = [
    ['Compte', [
      [I.manage, 'Gérer votre compte Google', 'https://myaccount.google.com/'],
      [I.add, 'Ajouter un compte', 'https://accounts.google.com/AddSession?continue=https%3A%2F%2Fwww.google.com%2F'],
      [I.logout, 'Se déconnecter', 'https://accounts.google.com/Logout?continue=https%3A%2F%2Fwww.google.com%2F']]],
    ['Activité', [
      [I.history, 'Historique des recherches', 'https://myactivity.google.com/product/search'],
      [I.trash, 'Supprimer les 30 dernières minutes', 'https://myactivity.google.com/product/search'],
      [I.saved, 'Enregistrements et collections', 'https://www.google.com/save'],
      [I.profile, 'Votre profil dans la Recherche', 'https://myaccount.google.com/profile']]],
    ['Recherche', [
      [I.spark, 'Personnalisation de la recherche', 'https://goo.gle/personalization-settings'],
      [I.shield, 'SafeSearch', 'https://www.google.com/safesearch'],
      [I.lang, 'Langue', 'https://www.google.com/preferences#languages', 'français'],
      [I.gear, 'Autres paramètres', 'https://www.google.com/preferences'],
      [I.help, 'Aide', 'https://support.google.com/websearch']]]
  ];
  function openAccount() {
    var p = account();
    if (!p) return;
    openDrawer('Compte Google', function (d) {
      var g = group();
      g.classList.add('cx-profile');
      var av = el('div', 'cx-gm-avatar');
      fillAvatar(av, p);
      var id = el('div');
      id.append(el('div', 'cx-name', p.name || 'Compte Google'), el('div', 'cx-email', p.email));
      g.append(av, id);
      d.appendChild(g);
      ACCOUNT_GROUPS.forEach(function (sec) {
        var gr = group(sec[0]), list = el('div', 'cx-list');
        sec[1].forEach(function (it) { list.appendChild(row(it[0], it[1], function () { go(it[2]); }, it[3])); });
        gr.appendChild(list);
        d.appendChild(gr);
      });
    });
  }

  // ---------------------------------------------------------------- partager / applications
  function fav(domain) { return 'https://www.google.com/s2/favicons?sz=64&domain=' + domain; }
  function openShare() {
    var url = location.href;
    var q = new URL(url).searchParams.get('q') || '';
    openDrawer('Partager', function (d) {
      var g = group('Cette recherche');
      g.appendChild(el('p', 'cx-hint', q));
      var list = el('div', 'cx-list');
      var copy = row(I.link, 'Copier le lien', function () {
        var done = function () { copy.querySelector('span').textContent = 'Lien copié'; setTimeout(closeDrawer, 700); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {});
      });
      list.appendChild(copy);
      list.appendChild(row(I.mail, 'Envoyer par e-mail', function () { go('mailto:?subject=' + encodeURIComponent(q) + '&body=' + encodeURIComponent(url)); }));
      list.appendChild(row(fav('whatsapp.com'), 'WhatsApp', function () { openTab('https://wa.me/?text=' + encodeURIComponent(q + ' ' + url)); }));
      list.appendChild(row(fav('x.com'), 'X', function () { openTab('https://x.com/intent/post?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(q)); }));
      list.appendChild(row(fav('facebook.com'), 'Facebook', function () { openTab('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url)); }));
      list.appendChild(row(fav('linkedin.com'), 'LinkedIn', function () { openTab('https://www.linkedin.com/sharing/share-offsite/?url=' + encodeURIComponent(url)); }));
      g.appendChild(list);
      d.appendChild(g);
    });
  }
  // icônes officielles de Google (vérifiées)
  var PL = 'https://www.gstatic.com/images/branding/productlogos/', PR = 'https://ssl.gstatic.com/images/branding/product/2x/';
  function pl(n, v) { return PL + n + '/' + v + '/web-48dp/logo_' + n + '_color_2x_web_48dp.png'; }
  var APPS = [
    ['Recherche', pl('googleg', 'v6'), 'https://www.google.com/'], ['Gmail', PR + 'gmail_2020q4_48dp.png', 'https://mail.google.com/'],
    ['YouTube', pl('youtube', 'v9'), 'https://www.youtube.com/'], ['Maps', pl('maps', 'v7'), 'https://maps.google.com/'],
    ['Drive', PR + 'drive_2020q4_48dp.png', 'https://drive.google.com/'], ['Agenda', PR + 'calendar_2020q4_48dp.png', 'https://calendar.google.com/'],
    ['Photos', PR + 'photos_48dp.png', 'https://photos.google.com/'], ['Traduction', pl('translate', 'v14'), 'https://translate.google.com/'],
    ['Actualités', PR + 'news_48dp.png', 'https://news.google.com/'], ['Docs', PR + 'docs_2020q4_48dp.png', 'https://docs.google.com/document/'],
    ['Sheets', PR + 'sheets_2020q4_48dp.png', 'https://docs.google.com/spreadsheets/'], ['Meet', PR + 'meet_2020q4_48dp.png', 'https://meet.google.com/'],
    ['Gemini', pl('gemini_2025', 'v1'), 'https://gemini.google.com/'], ['Play', PR + 'play_prism_48dp.png', 'https://play.google.com/'],
    ['Keep', PR + 'keep_2020q4_48dp.png', 'https://keep.google.com/']
  ];
  function openApps() {
    openDrawer('Applications Google', function (d) {
      var g = group('Ouvrir une application');
      var grid = el('div', 'cx-apps');
      APPS.forEach(function (a) {
        var b = el('button', 'cx-app');
        b.type = 'button';
        var img = el('img');
        img.alt = '';
        img.src = a[1];
        b.append(img, el('span', '', a[0]));
        b.onclick = function () { go(a[2]); };
        grid.appendChild(b);
      });
      g.appendChild(grid);
      d.appendChild(g);
    });
  }
  // les clics sur les boutons de Google ouvrent nos panneaux à la place des leurs
  window.addEventListener('click', function (e) {
    if (!enabled || !e.target || !e.target.closest) return;
    var b = e.target.closest('[data-cxbtn]');
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (b.getAttribute('data-cxbtn') === 'share') openShare();
    else if (b.getAttribute('data-cxbtn') === 'apps') openApps();
  }, true);

  // repère les boutons de l'en-tête et place la photo du compte
  function setupHeader(on) {
    var share = document.querySelector('.apFnFf') || (function () { var b = document.querySelector('[aria-label="Partager"], [aria-label="Share"]'); return b && (b.closest('[role=button]') || b); })();
    var apps = document.querySelector('#gb a[href*="/about/products"], #gbwa a');
    [['share', share], ['apps', apps]].forEach(function (f) {
      if (!f[1]) return;
      if (!on) f[1].removeAttribute('data-cxbtn');
      else if (f[1].getAttribute('data-cxbtn') !== f[0]) f[1].setAttribute('data-cxbtn', f[0]);
    });
    var link = googleAccountLink();
    var mine = document.getElementById('__cx_avatar');
    var p = on ? account() : null;
    if (!p) {
      if (mine) mine.remove();
      if (link) link.removeAttribute('data-cxhide');
      return;
    }
    if (!mine) {
      mine = el('button');
      mine.id = '__cx_avatar';
      mine.type = 'button';
      mine.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openAccount(); };
    }
    var key = p.avatar + '|' + p.name + '|' + p.email;
    if (mine.__key !== key) { fillAvatar(mine, p); mine.title = 'Compte Google\n' + p.name + '\n' + p.email; mine.__key = key; }
    if (link) {
      if (!link.hasAttribute('data-cxhide')) link.setAttribute('data-cxhide', '');
      if (mine.previousElementSibling !== link) link.after(mine);
    } else {
      // Google n'affiche pas son bouton de compte : on se place au bout de l'en-tête
      var host = document.querySelector('#gb') || (apps && apps.parentElement);
      if (host && mine.parentElement !== host) host.appendChild(mine);
    }
    // même ligne que les boutons partager / applications (Google décale parfois son bloc compte)
    var ref = share || apps;
    if (ref) {
      var a = ref.getBoundingClientRect(), b = mine.getBoundingClientRect();
      if (a.height && b.height) {
        var dy = Math.round((a.top + a.height / 2) - (b.top + b.height / 2));
        if (dy) mine.style.top = ((parseFloat(mine.style.top) || 0) + dy) + 'px';
      }
    }
  }

  // ---------------------------------------------------------------- filtres
  var FILE_TYPES = [['', 'Tous'], ['pdf', 'PDF'], ['doc', 'Word'], ['xls', 'Excel'], ['ppt', 'PowerPoint'], ['txt', 'Texte']];
  var PERIODS = [['', 'Toujours'], ['h', 'Dernière heure'], ['d', '24 heures'], ['w', 'Semaine'], ['m', 'Mois'], ['y', 'Année']];
  var LANGS = [['', 'Toutes'], ['fr', 'Français']];
  function filters() {
    var u = new URL(location.href);
    var m = (u.searchParams.get('q') || '').match(/(?:^|\s)filetype:(\w+)/i);
    var t = ((u.searchParams.get('tbs') || '').match(/qdr:(\w)/) || [])[1] || '';
    return { ft: m ? m[1].toLowerCase() : '', t: t, lang: u.searchParams.get('lr') === 'lang_fr' ? 'fr' : '' };
  }
  function applyFilter(change) {
    var f = filters();
    for (var k in change) f[k] = change[k];
    var u = new URL(location.href);
    var q = (u.searchParams.get('q') || '').replace(/(?:^|\s)filetype:\w+/ig, '').trim();
    if (f.ft) q += ' filetype:' + f.ft;
    u.searchParams.set('q', q);
    var tbs = (u.searchParams.get('tbs') || '').split(',').filter(function (x) { return x && !/^qdr:/.test(x); });
    if (f.t) tbs.push('qdr:' + f.t);
    if (tbs.length) u.searchParams.set('tbs', tbs.join(',')); else u.searchParams.delete('tbs');
    if (f.lang) u.searchParams.set('lr', 'lang_fr'); else u.searchParams.delete('lr');
    ['start', 'ei', 'ved', 'sa', 'sca_esv', 'sxsrf', 'uact', 'oq', 'gs_lp', 'sclient', 'iflsig'].forEach(function (p) { u.searchParams.delete(p); });
    location.href = u.toString();
  }
  function closeFilters() {
    var m = document.getElementById('__cx_filters');
    if (m) m.remove();
    var b = document.getElementById('__cx_filterbtn');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleFilters(btn) {
    if (document.getElementById('__cx_filters')) { closeFilters(); return; }
    var f = filters();
    var menu = el('div');
    menu.id = '__cx_filters';
    [['Type de fichier', 'ft', FILE_TYPES], ['Période', 't', PERIODS], ['Langue', 'lang', LANGS]].forEach(function (sec) {
      var g = group(sec[0]), chips = el('div', 'cx-chips');
      sec[2].forEach(function (o) {
        var c = el('button', 'cx-chip' + (f[sec[1]] === o[0] ? ' sel' : ''), o[1]);
        c.type = 'button';
        c.onclick = function () { var ch = {}; ch[sec[1]] = o[0]; applyFilter(ch); };
        chips.appendChild(c);
      });
      g.appendChild(chips);
      menu.appendChild(g);
    });
    btn.setAttribute('aria-expanded', 'true');
    btn.parentElement.appendChild(menu);
  }
  document.addEventListener('pointerdown', function (e) {
    var m = document.getElementById('__cx_filters');
    if (m && !m.contains(e.target) && !e.target.closest('#__cx_filterbtn')) closeFilters();
  }, true);

  // ---------------------------------------------------------------- barre d'outils (aperçu IA + filtres)
  var aiOpen = false;
  function findAI() {
    var box = document.querySelector('#rcnt .YzCcne');
    if (box) return box;
    var heads = document.querySelectorAll('#rcnt [role="heading"]');
    for (var i = 0; i < heads.length; i++) {
      if (/^(Aperçu IA|AI Overview)$/.test(heads[i].textContent.trim())) return heads[i].closest('[data-aim], [data-hveid]') || null;
    }
    return null;
  }
  function setupTools(on) {
    var tools = document.getElementById('__cx_tools');
    var box = findAI();
    var center = document.getElementById('center_col');
    if (!on || (!box && !center)) {
      if (tools) tools.remove();
      var old = document.querySelector('[data-cxai]');
      if (old) old.removeAttribute('data-cxai');
      return;
    }
    if (!tools) {
      tools = el('div');
      tools.id = '__cx_tools';
      var ai = el('button', 'cx-pill');
      ai.id = '__cx_aibtn';
      ai.type = 'button';
      ai.append(icon(I.spark), el('span'));
      ai.onclick = function () { aiOpen = !aiOpen; setupTools(enabled); };
      var fb = el('button', 'cx-pill');
      fb.id = '__cx_filterbtn';
      fb.type = 'button';
      fb.setAttribute('aria-expanded', 'false');
      fb.append(icon(I.filter), el('span', '', 'Filtres'));
      fb.onclick = function () { toggleFilters(fb); };
      tools.append(ai, fb);
    }
    // place : juste au-dessus de l'aperçu IA, sinon en tête des résultats
    if (box) { if (tools.nextElementSibling !== box) box.parentNode.insertBefore(tools, box); }
    else if (tools.parentElement !== center || center.firstElementChild !== tools) center.prepend(tools);
    var aiBtn = document.getElementById('__cx_aibtn');
    aiBtn.hidden = !box;
    aiBtn.style.display = box ? '' : 'none';
    aiBtn.setAttribute('aria-expanded', aiOpen ? 'true' : 'false');
    var label = aiOpen ? "Masquer l'aperçu IA" : "Afficher l'aperçu IA";
    if (aiBtn.lastChild.textContent !== label) aiBtn.lastChild.textContent = label;
    if (box) {
      var state = aiOpen ? 'open' : 'closed';
      if (box.getAttribute('data-cxai') !== state) box.setAttribute('data-cxai', state);
    }
    // nombre de filtres actifs sur le bouton
    var f = filters(), n = (f.ft ? 1 : 0) + (f.t ? 1 : 0) + (f.lang ? 1 : 0);
    var fb2 = document.getElementById('__cx_filterbtn'), badge = fb2.querySelector('b');
    if (n && !badge) { badge = el('b'); fb2.appendChild(badge); }
    if (badge) { if (n) badge.textContent = String(n); else badge.remove(); }
  }

  // capsule des onglets alignée sur le bord gauche des boutons et des bulles de résultats
  function alignTabs(on) {
    var list = document.querySelector('.beZ0tf');
    if (!list) return;
    // on décale tout le bloc (capsule + Outils) : la capsule seule serait coupée par la zone de défilement de Google
    var host = list.closest('.HTOhZ') || list;
    if (!on) { host.style.removeProperty('transform'); return; }
    var ref = document.getElementById('__cx_tools') || document.querySelector('#rso .tF2Cxc');
    if (!ref || !ref.getBoundingClientRect().width) return;
    var cur = parseFloat((host.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
    var dx = Math.round(ref.getBoundingClientRect().left - list.getBoundingClientRect().left);
    if (dx) host.style.setProperty('transform', 'translateX(' + (cur + dx) + 'px)', 'important');
  }

  function onScroll() {
    var on = enabled && window.scrollY > 8;
    if (document.documentElement.classList.contains('cx-scrolled') !== on) document.documentElement.classList.toggle('cx-scrolled', on);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function () { alignTabs(enabled); });

  // voile de chargement (posé par Corrtex au début de la page) : retiré une fois le style appliqué,
  // et couleurs mémorisées pour que le prochain voile ait le fond du thème
  var coverSaved = '';
  function coverDone(dark) {
    try {
      var base = dark ? 'linear-gradient(180deg, ' + theme.bg1 + ', ' + theme.bg2 + ')' : 'linear-gradient(180deg, #f7f7f9, #eceef2)';
      var v = enabled ? JSON.stringify({ bg: base, accent: theme.accent || '#ff4f7b' }) : '0';
      if (coverSaved !== v) { localStorage.setItem('__corrtex_cover', v); coverSaved = v; }
    } catch (e) {}
    if (window.__corrtexCoverDone) window.__corrtexCoverDone();
  }

  var sheet = null;
  function apply() {
    var dark = detectDark();
    if (dark === null) return;
    ensureAmbient(enabled);
    setupHeader(enabled);
    onScroll();
    setupTools(enabled);
    alignTabs(enabled);
    if (!enabled) { closeDrawer(); closeFilters(); }
    var text = enabled ? css(theme, dark) : '';
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      if (sheet.__css !== text) { sheet.replaceSync(text); sheet.__css = text; }
      if (document.adoptedStyleSheets.indexOf(sheet) < 0) document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
      coverDone(dark);
    } catch (e) {
      var st = document.getElementById('__corrtex_google');
      if (!st) { st = document.createElement('style'); st.id = '__corrtex_google'; (document.head || document.documentElement).appendChild(st); }
      st.textContent = text;
      coverDone(dark);
    }
  }

  window.__corrtexGoogle = function (t, on, g) {
    if (t && typeof t === 'object' && t.bg1) theme = t;
    if (g && typeof g === 'object') profile = g;
    enabled = on !== false;
    apply();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  setInterval(apply, 1000);

})();
