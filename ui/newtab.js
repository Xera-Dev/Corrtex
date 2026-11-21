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
    if (!typed || aiOn) { hideSugg(); return; }
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
    // mode IA : une adresse s'ouvre quand même, le reste est posé à l'IA
    const typed = $('q').value.trim();
    if (aiOn && typed && !/(^|\s)![a-z]/i.test(typed) && C.toUrl(typed) === C.searchUrl(typed)) { route(typed); $('q').value = ''; return; }
    const url = C.toUrl($('q').value);
    if (url) { C.prefetchSearch(url); location.href = url; }
  });
  setTimeout(() => $('q').focus(), 50);
  // connexions vers les moteurs ouvertes à l'avance : la première recherche part plus vite
  if (C.engine() === 'corrtex') C.invoke('search_warm');

  // ------------------------------------------------------------- recherche IA
  // Le bouton IA (à la place du micro) passe la barre en mode IA : contour arc-en-ciel,
  // et la réponse s'affiche juste en dessous, dans un panneau de verre où l'on peut continuer
  // la discussion. Les sources viennent du moteur Corrtex ; l'IA est celle du panneau (sans clé).
  const sbox = $('sbox'), panel = $('aipanel'), thread = $('ai-thread');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  let aiOn = false, conv = [], cur = null, aiReq = '';
  function setAi(on) {
    aiOn = on;
    sbox.classList.toggle('ai', on);
    $('q').placeholder = on ? 'Demandez n’importe quoi à l’IA…' : 'Rechercher avec Corrtex ou saisir une URL';
    $('aibtn').title = on ? 'Revenir à la recherche classique' : 'Recherche IA : l’IA répond directement ici';
    if (on) { hideSugg(); C.invoke('search_warm'); }
    C.save('homeAI', on);
    $('q').focus();
  }
  $('aibtn').addEventListener('click', () => setAi(!aiOn));
  if (C.load('homeAI', false)) setAi(true);

  // résultats web (DuckDuckGo et Mojeek) qui servent de sources à la réponse
  function parseWeb(src, html) {
    const d = new DOMParser().parseFromString(html, 'text/html'), out = [];
    if (src === 'ddg') d.querySelectorAll('.result').forEach((r) => {
      if (/result--ad/.test(r.className)) return;
      const a = r.querySelector('a.result__a'); if (!a) return;
      let u = a.getAttribute('href') || ''; const m = u.match(/[?&]uddg=([^&]+)/); if (m) { try { u = decodeURIComponent(m[1]); } catch (e) {} }
      if (/^https?:\/\//.test(u) && !/duckduckgo\.com/.test(u)) out.push({ url: u, title: clean(a.textContent), snippet: clean((r.querySelector('.result__snippet') || {}).textContent) });
    });
    else d.querySelectorAll('ul.results-standard > li, .results-standard li').forEach((li) => {
      const a = li.querySelector('h2 a, a.title'); if (!a) return;
      const u = a.getAttribute('href') || '';
      if (/^https?:\/\//.test(u)) out.push({ url: u, title: clean(a.textContent), snippet: clean((li.querySelector('p.s') || li.querySelector('p') || {}).textContent) });
    });
    return out;
  }
  async function sources(q) {
    const get = (src) => Promise.race([
      window.__TAURI__.core.invoke('search_fetch', { source: src, q, page: 1, form: null }).then((t) => parseWeb(src, t)),
      new Promise((res) => setTimeout(() => res([]), 3500)),
    ]).catch(() => []);
    const [a, b] = await Promise.all([get('ddg'), get('mojeek')]);
    const seen = new Set(), out = [];
    for (const r of a.concat(b)) {
      const k = r.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
      if (seen.has(k)) continue;
      seen.add(k); out.push(r);
    }
    return out.slice(0, 8);
  }

  // ------------------------------------------------ article de journal (mode IA, questions)
  // image de référence : la fiche Wikipédia si elle correspond, sinon la première image de DuckDuckGo
  async function imageFor(q) {
    const inv = (source) => Promise.race([window.__TAURI__.core.invoke('search_fetch', { source, q, page: 1, form: null }), new Promise((r, j) => setTimeout(() => j('lent'), 4500))]);
    const words = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
    try {
      const p = ((JSON.parse(await inv('wiki')).query || {}).pages || [])[0];
      if (p && p.thumbnail && /^https:/.test(p.thumbnail.source)) {
        const tq = words(q), tt = words(p.title);
        const common = tt.filter((w) => w && tq.indexOf(w) >= 0).length;
        if (tt.length && common / tt.length >= 0.5) return { src: p.thumbnail.source.replace(/\/(\d+)px-/, '/960px-'), small: p.thumbnail.source, credit: 'Wikipédia · ' + p.title, url: p.fullurl };
      }
    } catch (e) {}
    try {
      const r = (JSON.parse(await inv('images')).results || []).find((x) => /^https:/.test(x.image || '') && (x.width || 0) >= 500);
      if (r) return { src: r.image, small: r.thumbnail, credit: C.hostOf(r.url), url: r.url };
    } catch (e) {}
    return null;
  }
  function renderArticle(t, text, done) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    let title = '', lede = '', body = '', ul = false, firstP = true;
    const inline = (l) => esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\[(\d{1,2})\]/g, (m, n) => { const r = t.src[+n - 1]; return r ? '<a class="cite" href="' + esc(r.url) + '" title="' + esc(r.title) + '">' + n + '</a>' : m; });
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      const li = l.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
      if (!li && ul) { body += '</ul>'; ul = false; }
      if (/^#\s+/.test(l) && !title) title = inline(l.replace(/^#\s+/, ''));
      else if (/^>\s*/.test(l)) lede += (lede ? ' ' : '') + inline(l.replace(/^>\s*/, '').replace(/^chapeau\s*:\s*/i, ''));
      else if (/^#{2,4}\s+/.test(l)) { const h = l.replace(/^#{2,4}\s+/, ''); body += '<h3' + (/^à retenir/i.test(h) ? ' class="keep"' : '') + '>' + inline(h) + '</h3>'; }
      else if (li) { if (!ul) { body += '<ul>'; ul = true; } body += '<li>' + inline(li[1]) + '</li>'; }
      else if (!title && !body && !lede) title = inline(l.replace(/^titre\s*:\s*/i, ''));
      else { body += '<p' + (firstP ? ' class="first"' : '') + '>' + inline(l) + '</p>'; firstP = false; }
    }
    if (ul) body += '</ul>';
    const words = String(text).split(/\s+/).length;
    const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const img = t.img;
    t.el.innerHTML = '<article class="news">' +
      (img ? '<figure><img alt="" src="' + esc(img.src) + '" onerror="if(this.dataset.f){this.closest(\'figure\').remove()}else{this.dataset.f=1;this.src=\'' + esc(img.small || '') + '\'}"><figcaption>' + esc(img.credit || '') + '</figcaption></figure>' : '') +
      '<div class="kicker">Corrtex IA · ' + esc(date) + ' · ' + Math.max(1, Math.round(words / 200)) + ' min de lecture</div>' +
      (title ? '<h1>' + title + '</h1>' : '') + (lede ? '<p class="lede">' + lede + '</p>' : '') +
      '<div class="body">' + body + (done ? '' : '<span class="caret"></span>') + '</div></article>';
  }

  function format(t, src) {
    const lines = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>').split(/\n+/);
    let out = '', ul = false;
    for (const l of lines) {
      const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
      if (li) { if (!ul) { out += '<ul>'; ul = true; } out += '<li>' + li[1] + '</li>'; continue; }
      if (ul) { out += '</ul>'; ul = false; }
      if (l.trim()) out += '<p>' + l + '</p>';
    }
    if (ul) out += '</ul>';
    return out.replace(/\[(\d{1,2})\]/g, (m, n) => { const r = src[+n - 1]; return r ? '<a class="cite" href="' + esc(r.url) + '" title="' + esc(r.title) + '">' + n + '</a>' : m; });
  }
  function scrollThread() { thread.scrollTop = thread.scrollHeight; }

  // la demande passe par l'agent : achat → recherche d'achat (suivi des prix) dans ce panneau ;
  // action sur le web → l'agent prend la main dans l'onglet ; question → réponse avec sources
  async function route(q, forceAgent) {
    q = clean(q);
    if (!q) return;
    const kind = forceAgent ? 'action' : await C.invoke('agent_kind', { goal: q }) || 'answer';
    if (kind === 'answer') return ask(q);
    hideSugg();
    document.body.classList.add('ai-open');
    panel.hidden = false;
    $('ai-acts').hidden = true;
    // un panneau de résultats : la recherche en titre, le contenu remplacé à chaque recherche
    const aEl = document.createElement('div'); aEl.className = 'ai-a';
    thread.replaceChildren(aEl);
    $('ai-query').textContent = q;
    conv = []; cur = null; aiReq = '';
    thread.scrollTop = 0;
    if (kind === 'shopping') {
      setMode('Recherche d’achat');
      shopSort = 'reco';
      shopEl = aEl;
      aEl.innerHTML = '<div class="ai-wait"><i></i><i></i><i></i></div>';
      sbox.classList.add('thinking');
    } else {
      setMode('Agent');
      aEl.innerHTML = '<p>L’agent prend la main : il ouvre une recherche, parcourt les pages et vous demande de valider chaque action importante.</p>';
      sbox.classList.add('thinking');
    }
    try { await window.__TAURI__.core.invoke('agent_start', { goal: q, shopping: kind === 'shopping' }); }
    catch (e) { sbox.classList.remove('thinking'); aEl.innerHTML = '<p class="err">' + esc(String(e)) + '</p>'; }
  }
  function setMode(t) { panel.querySelector('header span').textContent = t; }

  async function ask(q) {
    q = clean(q);
    if (!q) return;
    hideSugg();
    setMode('Recherche IA');
    shopEl = null;
    document.body.classList.add('ai-open');
    panel.hidden = false;
    $('ai-acts').hidden = true;
    sbox.classList.add('thinking');
    const turn = { q, a: '', src: [] };
    conv.push(turn);
    cur = turn;
    const aEl = document.createElement('div'); aEl.className = 'ai-a'; aEl.innerHTML = '<div class="ai-wait"><i></i><i></i><i></i></div>';
    thread.replaceChildren(aEl);
    // l'article a son propre titre : la question n'est pas répétée au-dessus
    $('ai-query').textContent = '';
    turn.el = aEl;
    thread.scrollTop = 0;
    $('ai-state').textContent = 'recherche des sources…';
    // l'image de référence est cherchée en même temps que les sources
    const subject = conv.length > 1 ? conv[0].q + ' ' + q : q;
    turn.imgP = imageFor(subject);
    turn.src = await sources(subject);
    if (cur !== turn) return;
    $('ai-state').textContent = 'l’IA rédige…';
    turn.imgP.then((im) => { if (!im || cur !== turn) return; turn.img = im; if (turn.a) renderArticle(turn, turn.a, !aiReq); else turn.el.insertAdjacentHTML('afterbegin', ''); });
    const srcTxt = turn.src.map((r, i) => '[' + (i + 1) + '] ' + r.title + ' — ' + r.url + '\n' + r.snippet).join('\n\n');
    const hist = conv.slice(0, -1).map((t) => 'Question : ' + t.q + '\nRéponse : ' + t.a.slice(0, 1200)).join('\n\n');
    const prompt = (hist ? 'Conversation précédente :\n' + hist + '\n\n' : '') +
      'Question : « ' + q + ' »\n\n' + (srcTxt ? 'Résultats de recherche web actuels :\n\n' + srcTxt + '\n\n' : '') +
      'Rédige en français un court article de presse qui répond à la question, à partir de ces résultats et de tes connaissances, avec exactement cette structure :\n' +
      '# Titre accrocheur et informatif\n' +
      '> Chapeau : l’essentiel de la réponse en deux phrases.\n' +
      '## Intertitre\nParagraphe de 2 à 4 phrases.\n' +
      '## Intertitre\nParagraphe de 2 à 4 phrases.\n' +
      '## À retenir\n- 3 points clés courts\n' +
      'Deux ou trois intertitres au total avant « À retenir ». ' +
      (srcTxt ? 'Cite les sources utilisées avec leur numéro entre crochets, par exemple [2]. ' : '') + 'Pas d’introduction ni de formule de politesse, pas d’autre texte autour de l’article.';
    aiReq = 'na' + Date.now().toString(36);
    window.__TAURI__.core.invoke('shop_ask_ai', { prompt, req: aiReq }).catch((e) => window.__corrtexShopAI(aiReq, '', true, true));
  }
  window.__corrtexShopAI = (req, text, done, error) => {
    if (req !== aiReq || !cur) return;
    const t = cur;
    if (text) { t.a = text; renderArticle(t, text, !!(done || error)); }
    if (done || error) {
      aiReq = '';
      sbox.classList.remove('thinking');
      $('ai-state').textContent = '';
      if (error && !text) t.el.innerHTML = '<p class="err">Pas de réponse de l’IA. Ouvrez le panneau IA et vérifiez que vous êtes connecté à Claude, ChatGPT ou Gemini.</p>';
      if (t.src.length) {
        const s = document.createElement('div'); s.className = 'ai-src';
        s.innerHTML = t.src.slice(0, 6).map((r, i) => '<a href="' + esc(r.url) + '" title="' + esc(r.title) + '"><b>' + (i + 1) + '</b><img alt="" loading="lazy" src="' + esc(C.favicon(r.url, 32)) + '" onerror="this.remove()"><span>' + esc(C.hostOf(r.url)) + '</span></a>').join('');
        s.insertAdjacentHTML('afterbegin', '<span class="lbl">Sources</span>');
        t.el.appendChild(s);
      }
      $('ai-acts').hidden = false;
      setTimeout(() => $('ai-fq').focus(), 50);
    }
  };
  function closeAi() {
    if (shopEl) shopAct({ action: 'close' });
    shopEl = null; shopView = null;
    panel.hidden = true;
    document.body.classList.remove('ai-open');
    sbox.classList.remove('thinking');
    thread.replaceChildren();
    $('ai-query').textContent = '';
    conv = []; cur = null; aiReq = '';
    $('q').focus();
  }
  $('ai-close').onclick = closeAi;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('.drawer.open')) closeAi(); });
  $('ai-follow').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = clean($('ai-fq').value);
    $('ai-fq').value = '';
    if (!v) return;
    // pendant une recherche d'achat, la question de suivi précise la recherche
    if (shopEl && shopView && !shopView.busy) { shopAct({ action: 'refine', texts: [v] }); return; }
    route(v);
  });
  function addQ() {}
  $('ai-results').onclick = () => { const q = conv.length ? conv[conv.length - 1].q : $('q').value; location.href = C.pageUrl('search.html') + '#q=' + encodeURIComponent(q); };
  // « Confier à l'agent » : l'agent agit sur le web pour la dernière demande
  const agentBtn = document.createElement('button');
  agentBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 4.5l5.5 14 2-5.8 5.8-2z"/><path d="M13 13l5.5 5.5"/></svg>Confier à l’agent';
  agentBtn.title = 'L’agent ouvre les pages et agit pour vous (vous validez chaque action)';
  agentBtn.onclick = () => { const t = conv[conv.length - 1]; if (t) route(t.q, true); };
  $('ai-acts').insertBefore(agentBtn, $('ai-panel-btn'));
  $('ai-panel-btn').onclick = () => { const t = conv[conv.length - 1]; if (t) C.invoke('ai_prompt', { prompt: t.q }); };
  $('ai-copy').onclick = () => { const t = conv[conv.length - 1]; if (t && navigator.clipboard) navigator.clipboard.writeText(t.a).then(() => { $('ai-copy').lastChild.textContent = 'Copié'; setTimeout(() => { $('ai-copy').lastChild.textContent = 'Copier'; }, 1400); }); };
  // liens de la réponse : Ctrl+clic ou clic molette = nouvel onglet
  panel.addEventListener('click', (e) => { const a = e.target.closest('a[href]'); if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); C.invoke('new_tab', { url: a.href }); } });
  panel.addEventListener('auxclick', (e) => { const a = e.target.closest('a[href]'); if (a && e.button === 1) { e.preventDefault(); C.invoke('new_tab', { url: a.href }); } });


  // ------------------------------------------------------------- recherche d'achat de l'agent, dans le panneau de l'accueil
  // Le moteur caché (shopping.html) envoie son affichage à l'onglet actif : ici, au lieu du
  // panneau posé sur la page, il s'affiche dans le panneau de la recherche IA.
  let shopEl = null, shopView = null;
  const eur = (n) => n == null ? '' : n.toLocaleString('fr-FR', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
  function shopAct(a) { try { window.__TAURI__.core.invoke('tab_event', { kind: 'shopping_action', data: a }); } catch (e) {} }
  function spark(series) {
    if (!series || series.length < 2) return '';
    const mn = Math.min(...series), mx = Math.max(...series), w = 90, h = 26;
    const pts = series.map((v, i) => (i / (series.length - 1) * w).toFixed(1) + ',' + (h - 2 - (mx === mn ? .5 : (v - mn) / (mx - mn)) * (h - 4)).toFixed(1)).join(' ');
    return '<svg class="sp" viewBox="0 0 ' + w + ' ' + h + '"><polyline points="' + pts + '"/></svg>';
  }
  function shopItem(it, n) {
    const t = it.trend;
    const badge = it.timing === 'buy' ? '<em class="good">Bon moment pour acheter</em>' : it.timing === 'wait' ? '<em class="warn">Prix au-dessus de sa moyenne</em>' : '';
    return '<div class="si"><i class="n">' + n + '</i>' + (it.image ? '<img alt="" loading="lazy" src="' + esc(it.image) + '" onerror="this.style.visibility=\'hidden\'">' : '<div class="noimg"></div>') +
      '<div class="sb"><div class="sn">' + esc(it.name) + '</div>' +
      '<div class="sm"><b>' + esc(eur(it.price)) + '</b>' + (it.shop ? ' chez ' + esc(it.shop) : '') + (it.rating ? ' · ★ ' + esc(String(it.rating).replace('.', ',')) + (it.reviews ? ' (' + it.reviews + ')' : '') : '') + (it.offers > 1 ? ' · ' + it.offers + ' marchands' : '') + (it.match != null ? ' · ' + it.match + ' % de correspondance' : '') + '</div>' +
      (t ? '<div class="st">' + spark(t.series) + '<span>' + (t.atLow ? 'Au plus bas sur ' + t.days + ' j' : (t.vsAvg > 0 ? '+' : '') + t.vsAvg + ' % vs moyenne ' + eur(t.avg)) + '</span></div>' : '') +
      badge + (it.why ? '<p>' + esc(it.why) + '</p>' : '') +
      '<div class="sa">' + (it.offer ? '<a class="pri" href="' + esc(it.offer) + '">Voir l’offre</a>' : '') + (it.url ? '<a href="' + esc(it.url) + '">Comparer les prix</a>' : '') + '</div></div></div>';
  }
  // tri des articles : recommandés (choix de l'IA) ou tous les articles suivis, triés
  const SORTS = [['reco', 'Recommandés'], ['price', 'Prix croissant'], ['price-', 'Prix décroissant'], ['match', 'Correspondance'], ['rating', 'Note'], ['deal', 'Bonne affaire']];
  let shopSort = 'reco';
  function sorted(list, k) {
    const a = list.slice(), P = (x) => x.price == null ? Infinity : x.price;
    if (k === 'price') a.sort((x, y) => P(x) - P(y));
    else if (k === 'price-') a.sort((x, y) => (y.price || 0) - (x.price || 0));
    else if (k === 'match') a.sort((x, y) => (y.match || 0) - (x.match || 0));
    else if (k === 'rating') a.sort((x, y) => ((y.rating || 0) + Math.log10((y.reviews || 0) + 1) / 10) - ((x.rating || 0) + Math.log10((x.reviews || 0) + 1) / 10));
    else if (k === 'deal') a.sort((x, y) => (x.trend ? x.trend.vsAvg : 99) - (y.trend ? y.trend.vsAvg : 99));
    return a;
  }
  function renderShop(v) {
    if (!shopEl || !v) return;
    shopView = v;
    let h = '';
    if (v.summary) h += '<p class="sum">' + esc(v.summary) + '</p>';
    if (v.tags && v.tags.length) h += '<div class="tags">' + v.tags.map((x) => '<span>' + esc(x) + '</span>').join('') + '</div>';
    if (v.busy || !(v.rounds || []).length) {
      h += '<ul class="steps">' + (v.steps || []).map((s) => '<li class="' + esc(s.s) + '">' + esc(s.t) + '</li>').join('') + '</ul>';
    }
    if ((v.rounds || []).length && (v.all || []).length > 1) {
      h += '<div class="sorts"><span>Trier</span>' + SORTS.map((x) => '<button data-sort="' + x[0] + '"' + (x[0] === shopSort ? ' class="on"' : '') + '>' + x[1] + '</button>').join('') + '</div>';
    }
    if (shopSort !== 'reco' && (v.all || []).length) {
      h += '<h4>Tous les articles suivis (' + v.all.length + ')</h4>' + sorted(v.all, shopSort).map((it, i) => shopItem(it, i + 1)).join('');
    } else (v.rounds || []).forEach((r) => {
      h += '<h4>' + esc(r.title) + '</h4>';
      if (r.advice) h += '<div class="adv' + (r.provisional ? ' prov' : '') + '"><b>' + (r.provisional ? 'En cours :' : 'Conseil :') + '</b> ' + esc(r.advice.replace(/^Classement provisoire : /, 'classement provisoire, ')) + '</div>';
      h += (r.items || []).map((it, i) => shopItem(it, i + 1)).join('');
    });
    if (!v.busy && (v.suggestions || []).length) h += '<div class="sug"><span>Préciser :</span>' + v.suggestions.map((x) => '<button data-ref="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>';
    if (!v.busy && (v.rounds || []).length) h += '<div class="more"><button data-more>Continuer la recherche</button></div>';
    shopEl.innerHTML = h;
    sbox.classList.toggle('thinking', !!v.busy);
    $('ai-fq').placeholder = v.busy ? 'Recherche en cours…' : 'Préciser la recherche (budget, marque, usage…)';
    if (!v.busy) $('ai-acts').hidden = true;
  }
  if (panel) panel.addEventListener('click', (e) => {
    const r = e.target.closest('[data-ref]');
    if (r) { shopAct({ action: 'refine', texts: [r.dataset.ref] }); addQ(r.dataset.ref); return; }
    const so = e.target.closest('[data-sort]');
    if (so) { shopSort = so.dataset.sort; renderShop(shopView); return; }
    if (e.target.closest('[data-more]')) shopAct({ action: 'more' });
  });
  window.__corrtexShopping = {
    show(v) {
      if (!v) return;
      if (v.mode === 'history' || !v.goal) return;
      if (!shopEl) {
        // recherche lancée ailleurs (outils, historique) : on ouvre le panneau pour elle
        document.body.classList.add('ai-open'); panel.hidden = false; setMode('Recherche d’achat');
        shopEl = document.createElement('div'); shopEl.className = 'ai-a';
        thread.replaceChildren(shopEl);
        $('ai-query').textContent = v.goal;
      }
      renderShop(v);
    },
    hide() { sbox.classList.remove('thinking'); },
    history() {},
  };

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

  function withUser(url) {
    const n = google && google.active ? google.active : 0;
    if (!n || /AddSession|Logout|ServiceLogin/.test(url)) return url;
    try { const u = new URL(url); if (/google\.com$/.test(u.hostname) || /goo\.gle$/.test(u.hostname)) { u.searchParams.set('authuser', n); return u.href; } } catch (e) {}
    return url;
  }
  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  function renderAccounts(g) {
    const box = $('gm-accounts');
    if (!box) return;
    box.replaceChildren();
    (g.accounts || []).forEach((a, i) => {
      const b = document.createElement('button');
      b.className = 'gacc';
      const av = document.createElement('span'); av.className = 'gav';
      if (a.avatar) { const im = document.createElement('img'); im.alt = ''; im.src = a.avatar; im.onerror = () => { im.remove(); av.textContent = (a.name || a.email).charAt(0).toUpperCase(); }; av.append(im); }
      else av.textContent = (a.name || a.email || '?').charAt(0).toUpperCase();
      const t = document.createElement('span'); t.className = 'gt';
      const n = document.createElement('b'); n.textContent = a.name || a.email;
      const e = document.createElement('small'); e.textContent = a.email;
      t.append(n, e);
      b.append(av, t);
      if (i === (g.active || 0)) { const ok = document.createElement('span'); ok.className = 'ok'; ok.innerHTML = CHECK; b.append(ok); b.title = 'Compte utilisé par Corrtex'; }
      else { b.title = 'Utiliser ce compte'; b.onclick = () => C.invoke('google_switch', { index: i }); }
      box.append(b);
    });
    const add = document.createElement('button');
    add.className = 'gacc add';
    add.innerHTML = '<span class="gav">' + I.add + '</span><span class="gt"><b>Ajouter un autre compte</b><small>Connexion d’un compte Google supplémentaire</small></span>';
    add.onclick = () => { location.href = 'https://accounts.google.com/AddSession?hl=fr&continue=https%3A%2F%2Fwww.google.com%2F'; };
    box.append(add);
  }

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
    renderAccounts(g);
    // moteur Google : recherches avec le compte choisi
    C.save('googleAuthuser', g.active || 0);
  }

  const CHEVRON = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

  function itemEl(it) {
    const b = document.createElement('button');
    b.className = 'row-link';
    b.innerHTML = I[it.icon] + '<span></span>' + (it.right ? '<em class="right"></em>' : '') + CHEVRON;
    b.querySelector('span').textContent = it.label;
    if (it.right) b.querySelector('.right').textContent = it.right;
    // les pages Google s'ouvrent avec le compte choisi (authuser)
    b.onclick = () => { location.href = withUser(it.url); };
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
