// Script injecté dans le panneau IA.
// 1) Interface réduite : le site est chargé en version mobile ; on masque en plus les
//    bandeaux "télécharger l'application" et on affine les barres de défilement.
// 2) Style Corrtex (désactivable avec le bouton palette) pour Gemini, ChatGPT et Claude :
//    fond aux couleurs du thème, barre de question, questions et réponses en liquid glass.
//    Sélecteurs relevés sur les sites (versions mobiles) — à revoir si un site change.
// 3) __corrtexAsk(texte) : écrit un message dans la barre de question et l'envoie.
(function () {
  if (window.top !== window) return;
  // Corrtex réinjecte ce script régulièrement : s'il est déjà là, on réapplique seulement le style
  if (window.__corrtexAI) { window.__corrtexAI(); return; }

  var BASE = [
    '[class*="app-banner" i], [class*="appbanner" i], [class*="download-app" i],',
    '[class*="smart-banner" i], [id*="app-banner" i], a[href*="apps.apple.com"],',
    'a[href*="play.google.com/store"] { display: none !important; }',
    '::-webkit-scrollbar { width: 6px; height: 6px; }',
    '::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 3px; }',
    '::-webkit-scrollbar-track { background: transparent; }'
  ].join('\n');

  var SITES = {
    'gemini.google.com': {
      css: "/* ---- Style Corrtex pour gemini.google.com ---- */\n\n/* fond : m\u00eame d\u00e9grad\u00e9 que l'en-t\u00eate du panneau (pas de s\u00e9paration visible) */\nhtml, body { background: linear-gradient(180deg, var(--cx-bg1), var(--cx-bg2)) fixed !important; }\nbody, .mat-typography { font-family: \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif !important; }\n/* voiles et d\u00e9grad\u00e9s opaques de Gemini : retir\u00e9s pour laisser voir le fond */\n.gradient-strip, .top-gradient, .bottom-gradient { opacity: 0 !important; }\ninput-container.input-gradient-overlay { background-image: none !important; }\n.autosuggest-scrim { background: rgba(0,0,0,.35) !important; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }\nmat-sidenav, .mat-drawer { background: color-mix(in srgb, var(--cx-bg2) 92%, transparent) !important; backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4); }\n\n/* barre de question en liquid glass */\ninput-area-v2 {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid var(--cx-edge) !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), inset 0 -1px 0 rgba(255,255,255,.05), 0 12px 30px rgba(0,0,0,.35) !important;\n  backdrop-filter: blur(22px) saturate(1.7) !important; -webkit-backdrop-filter: blur(22px) saturate(1.7) !important;\n}\ninput-area-v2:focus-within { border-color: color-mix(in srgb, var(--cx-fg) 55%, transparent) !important; }\n\n/* questions : bulle de verre */\n.user-query-bubble-with-background {\n  background: linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.05)) !important;\n  border: 1px solid var(--cx-edge) !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 8px 20px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.6) !important; -webkit-backdrop-filter: blur(16px) saturate(1.6) !important;\n  border-radius: 24px 24px 8px 24px !important;\n}\n\n/* r\u00e9ponses : carte de verre */\nmodel-response .presented-response-container {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid color-mix(in srgb, var(--cx-edge) 80%, transparent) !important;\n  border-radius: 22px !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 10px 26px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.5) !important; -webkit-backdrop-filter: blur(16px) saturate(1.5) !important;\n  padding: 6px 4px 8px !important; margin: 4px 10px !important; width: auto !important;\n}\nmodel-response .response-container-content { padding-top: 0 !important; }\n/* banni\u00e8res et cartes de Gemini */\n.gem-banner-container {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid var(--cx-edge) !important; box-shadow: inset 0 1px 0 var(--cx-hi) !important; backdrop-filter: blur(16px) !important; -webkit-backdrop-filter: blur(16px) !important;\n}\n::selection { background: color-mix(in srgb, var(--cx-accent) 45%, transparent); }\n",
      editor: 'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]',
      // version mobile : la classe « send-button » est sur le conteneur du bouton
      send: '.send-button button, button.send-button, button[aria-label="Envoyer un message"], button[aria-label="Envoyer le message"], button[aria-label="Send message"]',
      reply: 'model-response .markdown, model-response message-content'
    },
    'chatgpt.com': {
      css: "/* ---- Style Corrtex pour chatgpt.com (interface mobile, connect\u00e9 ou non) ---- */\nhtml, body, [data-testid=\"ds-document-layout\"] { background: linear-gradient(180deg, var(--cx-bg1), var(--cx-bg2)) fixed !important; }\nbody { font-family: \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif !important; }\n:root, .dark, .light { --main-surface-primary: transparent !important; --main-surface-background: transparent !important; --bg-primary: transparent !important; --sidebar-surface-primary: var(--cx-bg2) !important; }\n/* bandes opaques de l'en-t\u00eate et du bas */\nheader[data-slot=\"header\"] > span, footer[data-ds-composer] > span { background: transparent !important; }\n#page-header, #thread-bottom-container, #thread-bottom { background: transparent !important; }\naside#ds-sidebar, aside#ds-sidebar span, aside#ds-sidebar section { background: color-mix(in srgb, var(--cx-bg2) 94%, transparent) !important; }\n\n/* barre de question en liquid glass */\nform[data-mobile-composer], [data-composer-surface=\"true\"], form:has(#prompt-textarea) > div > div:has(#prompt-textarea) {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid var(--cx-edge) !important; border-radius: 26px !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), inset 0 -1px 0 rgba(255,255,255,.05), 0 12px 30px rgba(0,0,0,.35) !important;\n  backdrop-filter: blur(22px) saturate(1.7) !important; -webkit-backdrop-filter: blur(22px) saturate(1.7) !important;\n}\n\n/* questions : bulle de verre */\n[data-user-message-bubble], [data-message-author-role=\"user\"] .user-message-bubble-color, [data-message-author-role=\"user\"] [class*=\"bg-token-message-surface\"] {\n  background: linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.05)) !important;\n  border: 1px solid var(--cx-edge) !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 8px 20px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.6) !important; -webkit-backdrop-filter: blur(16px) saturate(1.6) !important;\n  border-radius: 22px 22px 8px 22px !important; color: var(--cx-fg) !important;\n}\n\n/* r\u00e9ponses : carte de verre */\n[data-assistant-markdown-root], [data-message-author-role=\"assistant\"] .markdown {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid color-mix(in srgb, var(--cx-edge) 80%, transparent) !important; border-radius: 22px !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 10px 26px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.5) !important; -webkit-backdrop-filter: blur(16px) saturate(1.5) !important; padding: 12px 16px !important;\n}\n",
      editor: '#prompt-textarea, #mobile-composer-prompt, textarea[data-mobile-composer-prompt]',
      send: 'button[data-composer-submit], #composer-submit-button, button[data-testid="send-button"], button[aria-label="Envoyer un message"], button[aria-label="Send prompt"]',
      reply: '[data-message-author-role="assistant"] .markdown, [data-assistant-markdown-root], [data-message-author-role="assistant"]'
    },
    'claude.ai': {
      css: "/* ---- Style Corrtex pour claude.ai (syst\u00e8me de design \"cds\", relev\u00e9 sur la vraie page) ---- */\nhtml, body { background: linear-gradient(180deg, var(--cx-bg1), var(--cx-bg2)) fixed !important; }\nbody { font-family: \"Segoe UI Variable Text\", \"Segoe UI\", system-ui, sans-serif !important; }\n:root, html.cds-root, [data-theme=\"claude\"], [data-theme=\"claude\"][data-mode=\"dark\"] {\n  --cds-surface-1: transparent !important; --cds-surface-0: transparent !important; --cds-page-bg: transparent !important;\n}\nbody.bg-surface-1, .bg-page, [data-composer-card-holder], [data-cds=\"ChatComposer\"],\nmain.dframe-content, .dframe-content, .dframe-content-inner { background: transparent !important; }\n/* barre de question */\n[data-cds=\"ChatComposer\"] .bg-surface-3 {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid var(--cx-edge) !important; border-radius: 26px !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), inset 0 -1px 0 rgba(255,255,255,.05), 0 12px 30px rgba(0,0,0,.35) !important;\n  backdrop-filter: blur(22px) saturate(1.7) !important; -webkit-backdrop-filter: blur(22px) saturate(1.7) !important;\n}\n/* questions : la bulle du message */\n[data-cds=\"UserMessage\"] div[class*=\"group/bubble\"] {\n  background: linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.05)) !important;\n  border: 1px solid var(--cx-edge) !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 8px 20px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.6) !important; -webkit-backdrop-filter: blur(16px) saturate(1.6) !important;\n  border-radius: 22px 22px 8px 22px !important; color: var(--cx-fg) !important;\n}\n/* r\u00e9ponses : le texte de la r\u00e9ponse dans une carte */\n[data-cds=\"AssistantMessage\"] [data-cds=\"Prose\"] {\n  background: linear-gradient(180deg, var(--cx-glass), var(--cx-glass2)) !important;\n  border: 1px solid color-mix(in srgb, var(--cx-edge) 80%, transparent) !important; border-radius: 22px !important;\n  box-shadow: inset 0 1px 0 var(--cx-hi), 0 10px 26px rgba(0,0,0,.25) !important;\n  backdrop-filter: blur(16px) saturate(1.5) !important; -webkit-backdrop-filter: blur(16px) saturate(1.5) !important; padding: 12px 16px !important;\n}\n",
      editor: '[data-testid="chat-input"], div.ProseMirror[contenteditable="true"]',
      send: 'button[data-testid="chat-input-send"], button[aria-label="Envoyer le message"], button[aria-label="Send message"]',
      reply: '[data-cds="AssistantMessage"] [data-cds="Prose"], [data-cds="AssistantMessage"], .font-claude-message'
    }
  };
  var site = SITES[location.hostname] || null;

  var DEFAULT = { bg1: '#2f2f32', bg2: '#1e1e21', card: '#3a3a3e', fg: '#f4f4f6', accent: '#ff4f7b', scheme: 'dark' };
  var theme = DEFAULT, enabled = true;

  // "#2f2f32" -> "240 3% 19%" (format des variables de couleur de claude.ai)
  function hsl(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '0 0% 15%';
    var n = parseInt(m[1], 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > .5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    }
    return Math.round(h) + ' ' + Math.round(s * 100) + '% ' + Math.round(l * 100) + '%';
  }

  function vars(t) {
    var dark = t.scheme !== 'light';
    return ':root {' +
      ' --cx-bg1: ' + t.bg1 + '; --cx-bg2: ' + t.bg2 + '; --cx-accent: ' + t.accent + '; --cx-fg: ' + t.fg + ';' +
      ' --cx-h-bg1: ' + hsl(t.bg1) + '; --cx-h-bg2: ' + hsl(t.bg2) + '; --cx-h-card: ' + hsl(t.card) + ';' +
      ' --cx-glass: ' + (dark ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.62)') + ';' +
      ' --cx-glass2: ' + (dark ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.32)') + ';' +
      ' --cx-edge: ' + (dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.10)') + ';' +
      ' --cx-hi: ' + (dark ? 'rgba(255,255,255,.32)' : 'rgba(255,255,255,.9)') + '; }\n';
  }

  // Feuille de style : balise <style> + feuille "adoptée" en secours si le site bloque les balises
  var sheets = {};
  function setStyle(id, css) {
    var el = document.getElementById(id);
    if (!css) {
      if (el) el.remove();
      if (sheets[id]) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(function (s) { return s !== sheets[id]; });
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      (document.head || document.documentElement).appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
    if (el.parentNode && el !== el.parentNode.lastElementChild) el.parentNode.appendChild(el);
    try {
      if (!sheets[id]) sheets[id] = new CSSStyleSheet();
      if (sheets[id].__css !== css) { sheets[id].replaceSync(css); sheets[id].__css = css; }
      if (document.adoptedStyleSheets.indexOf(sheets[id]) < 0) document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheets[id]]);
    } catch (e) {}
  }

  function apply() {
    setStyle('__corrtex_ai', BASE);
    setStyle('__corrtex_skin', site && enabled ? vars(theme) + site.css : '');
  }

  // appelé par Corrtex avec les couleurs du thème, et quand on active / désactive le style
  window.__corrtexSkin = function (t, on) {
    if (t && typeof t === 'object' && t.bg1) theme = t;
    enabled = on !== false;
    apply();
  };

  function current(ed) { return (ed.value !== undefined ? ed.value : ed.textContent || '').trim(); }

  // Insère le texte dans la barre de question, sans dépendre du focus clavier :
  // zone de texte classique -> valeur + événement ; éditeur riche -> collage simulé.
  function insert(ed, text) {
    if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
      var proto = ed.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(ed, text);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    try {
      var sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(range);
    } catch (e) {}
    var dt = new DataTransfer();
    dt.setData('text/plain', text);
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    if (current(ed).indexOf(text.slice(0, 20)) < 0) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    }
  }

  // écrit le message dans la barre de question puis l'envoie
  window.__corrtexAsk = function (text) {
    if (!site || typeof text !== 'string') return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var ed = document.querySelector(site.editor);
      if (!ed) { if (tries > 50) clearInterval(timer); return; }
      clearInterval(timer);
      ed.focus();
      insert(ed, text);
      // on laisse au site le temps de prendre le texte en compte, puis on envoie ;
      // si le texte est toujours dans la barre, on réessaie (jusqu'à 3 fois)
      var n = 0, clicks = 0, lastClick = 0;
      var sendTimer = setInterval(function () {
        n++;
        if (clicks && current(ed).indexOf(text.slice(0, 20)) < 0) { clearInterval(sendTimer); return; } // envoyé
        if (n < 4) return; // ~600 ms
        var btn = document.querySelector(site.send);
        // un bouton d'envoi de formulaire peut rester marqué "inactif" alors que l'envoi marche
        var isSubmit = btn && btn.type === 'submit' && btn.form && btn.form.requestSubmit;
        var ready = btn && !btn.disabled && (isSubmit || btn.getAttribute('aria-disabled') !== 'true');
        if (ready && Date.now() - lastClick > 900) {
          // bouton d'envoi d'un formulaire (ChatGPT) : on soumet le formulaire ; sinon simple clic
          if (isSubmit) btn.form.requestSubmit(btn);
          else btn.click();
          clicks++; lastClick = Date.now();
          if (clicks >= 3) clearInterval(sendTimer);
        } else if (n > 40) {
          clearInterval(sendTimer);
          ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
      }, 150);
    }, 300);
  };

  // Entrée envoie le message (la version mobile des sites ferait un retour à la ligne) ;
  // Maj+Entrée garde le retour à la ligne.
  function sendNow() {
    var btn = site && document.querySelector(site.send);
    if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      if (!(btn && btn.type === 'submit' && btn.form)) return false;
    }
    if (btn.type === 'submit' && btn.form && btn.form.requestSubmit) btn.form.requestSubmit(btn);
    else btn.click();
    return true;
  }
  if (site && !window.__corrtexEnter) {
    window.__corrtexEnter = true;
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.keyCode === 229) return;
      var t = e.target;
      if (!t || !t.closest || !t.closest(site.editor)) return;
      if (!current(t.closest(site.editor))) return;
      if (sendNow()) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  }

  // Réponse rapide (bulle dans la page) : on suit le texte de la dernière réponse et on le
  // renvoie à Corrtex au fur et à mesure, jusqu'à ce qu'il ne bouge plus.
  // réponse déjà affichée avant la question (discussion précédente restée à l'écran) : à ignorer
  var mark = { n: 0, last: '' };
  window.__corrtexMark = function () {
    if (!site || !site.reply) return;
    var ns = document.querySelectorAll(site.reply);
    mark = { n: ns.length, last: ns.length ? (ns[ns.length - 1].innerText || '').trim() : '' };
  };
  window.__corrtexWatch = function (req) {
    if (!site || !site.reply) return;
    var last = '', stable = 0, start = Date.now(), sentAt = 0, base = mark;
    function report(text, done, error) {
      try { window.__TAURI_INTERNALS__.invoke('ai_quick_result', { req: req, text: (text || '').slice(0, 40000), done: !!done, error: !!error }); } catch (e) {}
    }
    var t = setInterval(function () {
      var ns = document.querySelectorAll(site.reply);
      var txt = ns.length ? (ns[ns.length - 1].innerText || '').trim() : '';
      // tant que seule l'ancienne réponse est visible, on attend la nouvelle
      if (txt && ns.length <= base.n && txt === base.last) txt = '';
      var busy = !!document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], button[aria-label*="Interrompre" i], button[data-testid="stop-button"]');
      if (txt && txt !== last) {
        last = txt; stable = Date.now();
        if (Date.now() - sentAt > 250) { report(txt, false); sentAt = Date.now(); }
      }
      if (last && !busy && Date.now() - stable > 1800) { clearInterval(t); report(last, true); }
      // rien ne s'écrit et l'IA ne travaille pas : la question n'est pas partie
      else if (!last && !busy && Date.now() - start > 45000) { clearInterval(t); report('', true, true); }
      // longues réponses (JSON détaillé, réflexion de Gemini) : jusqu'à 3 minutes
      else if (Date.now() - start > 180000) { clearInterval(t); report(last, true, !last); }
    }, 300);
  };


  // Génération d'image (onglet Images du moteur Corrtex) : on demande l'image, on attend qu'elle
  // soit finie, puis on la renvoie à Corrtex en data: (les adresses de ChatGPT exigent la connexion).
  window.__corrtexImageWatch = function (serial, prompt) {
    function report(images, text, error) {
      try { window.__TAURI_INTERNALS__.invoke('ai_image_result', { serial: serial, images: images || [], text: (text || '').slice(0, 1500), error: error || '' }); } catch (e) {}
    }
    if (!site) { report([], '', 'site'); return; }
    var gem = /gemini/.test(location.hostname);
    function loggedOut() {
      if (gem) return !!document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"], a[href*="accounts.google.com/AccountChooser"]');
      return !!document.querySelector('[data-testid="login-button"], [data-testid="mobile-login-button"], a[href*="/auth/login"]');
    }
    var t0 = Date.now();
    var waitEd = setInterval(function () {
      if (loggedOut()) { clearInterval(waitEd); report([], '', 'login'); return; }
      if (document.querySelector(site.editor)) { clearInterval(waitEd); setTimeout(go, 600); }
      else if (Date.now() - t0 > 14000) { clearInterval(waitEd); report([], '', 'login'); }
    }, 400);
    var srcOf = function (i) { return i.currentSrc || i.src || ''; };
    function go() {
      var before = {};
      [].forEach.call(document.images, function (i) { before[srcOf(i)] = 1; });
      window.__corrtexAsk((gem ? 'Crée une image : ' : 'Génère une image : ') + prompt + '\n\nGénère directement l’image, sans poser de question.');
      var start = Date.now(), lastKey = '', stable = Date.now();
      var tick = setInterval(function () {
        var busy = !!document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], button[aria-label*="Interrompre" i], button[data-testid="stop-button"]');
        var srcs = [];
        [].forEach.call(document.images, function (i) {
          var s = srcOf(i);
          if (!s || before[s] || i.naturalWidth < 300 || i.naturalHeight < 300) return;
          if (/avatar|profile|favicon|logo|emoji/i.test(s + ' ' + (i.alt || ''))) return;
          if (srcs.indexOf(s) < 0) srcs.push(s);
        });
        var ns = document.querySelectorAll(site.reply), txt = ns.length ? (ns[ns.length - 1].innerText || '').trim() : '';
        var key = srcs.join('|') + '#' + txt.length;
        if (key !== lastKey) { lastKey = key; stable = Date.now(); }
        var quiet = Date.now() - stable;
        if (srcs.length && !busy && quiet > 3000) { clearInterval(tick); finish(srcs.slice(-4), txt); return; }
        // une réponse sans image (refus, quota…) : on attend un peu, la génération peut encore démarrer
        var working = /cr[ée]ation|g[ée]n[ée]ration|creating|generating|en cours|un instant/i.test(txt);
        if (!srcs.length && txt && !busy && !working && quiet > 9000 && Date.now() - start > 20000) { clearInterval(tick); report([], txt, 'noimage'); return; }
        if (Date.now() - start > 190000) { clearInterval(tick); report([], txt, 'timeout'); }
      }, 700);
    }
    function toData(s) {
      if (/^data:image\//.test(s)) return Promise.resolve(s);
      return fetch(s, { credentials: 'include' }).then(function (r) { return r.blob(); }).then(function (b) {
        return new Promise(function (res) {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result).replace(/^data:(application\/octet-stream|binary\/octet-stream)?;/, 'data:image/png;')); };
          fr.onerror = function () { res(s); };
          fr.readAsDataURL(b);
        });
      }).catch(function () {
        // autre origine sans autorisation : copie par canvas, sinon l'adresse telle quelle
        try {
          var img = [].filter.call(document.images, function (i) { return srcOf(i) === s; })[0];
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return c.toDataURL('image/png');
        } catch (e) { return s; }
      });
    }
    function finish(srcs, txt) {
      Promise.all(srcs.map(toData)).then(function (list) {
        report(list.filter(function (u) { return /^data:image\//.test(u) || /^https:\/\//.test(u); }), txt, '');
      });
    }
  };

  window.__corrtexAI = apply;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
  // les sites d'IA réécrivent souvent l'en-tête de la page : on vérifie régulièrement
  setInterval(apply, 2000);
})();
