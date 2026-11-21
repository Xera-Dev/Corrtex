// Comparateur de prix : lecture des pages publiques de leDénicheur (produits, offres,
// historique des prix) et de Dealabs (codes promo). Aucune clé d'API n'est nécessaire.
// Même code que le comparateur dans les pages (src-tauri/src/tab_script.js).
(function () {
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



  // ---------------------------------------------------------------- page de résultats d'une boutique quelconque
  // (boutiques ajoutées dans les réglages) : données structurées schema.org, sinon cartes avec prix, lien et image
  function parseShopGeneric(html, base) {
    var doc = new DOMParser().parseFromString(html, 'text/html'), out = [], seen = {};
    function abs(u) { try { return u ? new URL(u, base).href : ''; } catch (e) { return ''; } }
    function clean(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
    function add(it) {
      var key = norm(it.name).slice(0, 60);
      if (!it.name || it.name.length < 4 || !it.url || seen[key] || out.length >= 24) return;
      seen[key] = 1;
      out.push(it);
    }
    function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 7) return;
      if (Array.isArray(o)) { o.forEach(function (x) { walk(x, d + 1); }); return; }
      var t = [].concat(o['@type'] || []).join(' ');
      if (/Product/.test(t) && o.name) {
        var of = [].concat(o.offers || [])[0] || {}, ag = o.aggregateRating || {}, im = [].concat(o.image || [])[0];
        add({ name: clean(o.name).slice(0, 200), price: +(of.price || of.lowPrice) || null, url: abs(o.url || of.url), image: abs(im && (im.url || im)),
          rating: +ag.ratingValue || null, reviews: +(ag.reviewCount || ag.ratingCount) || 0 });
        return;
      }
      ['itemListElement', 'item', '@graph', 'mainEntity'].forEach(function (k) { if (o[k]) walk(o[k], d + 1); });
    }
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(function (sc) { try { walk(JSON.parse(sc.textContent), 0); } catch (e) {} });
    if (out.length >= 2) return out;
    // cartes : le plus petit bloc autour d'un prix qui contient un lien et une image
    var PR = /\d[\d\s  .]*(?:[.,]\d{1,2})?\s?€|€\s?\d/;
    var w = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT), n, cards = [], count = 0;
    while ((n = w.nextNode()) && count < 20000 && cards.length < 40) {
      count++;
      if (n.data.length > 40 || !PR.test(n.data)) continue;
      var p = n.parentElement;
      if (p && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
      var el = p, card = null;
      for (var k = 0; el && k < 8; k++, el = el.parentElement) {
        if (el.tagName === 'BODY') break;
        if (el.textContent.length > 1500) break;
        if (el.querySelector('a[href]') && el.querySelector('img')) { card = el; break; }
      }
      if (!card || cards.some(function (c) { return c === card || c.contains(card) || card.contains(c); })) continue;
      card.__price = price(n.data);
      cards.push(card);
    }
    cards.forEach(function (c) {
      var title = '';
      var cand = c.querySelectorAll('h2, h3, h4, [class*="title" i], [class*="name" i], [itemprop="name"], a[title]');
      for (var i = 0; i < cand.length && !title; i++) {
        var tx = clean(cand[i].getAttribute('title') || cand[i].textContent);
        if (tx.length >= 6 && tx.length <= 220 && !PR.test(tx)) title = tx;
      }
      var link = null;
      c.querySelectorAll('a[href]').forEach(function (a) {
        var h = a.getAttribute('href') || '';
        if (/^(#|javascript:)/i.test(h)) return;
        if (!link || clean(a.textContent).length > clean(link.textContent).length) link = a;
      });
      if (!title && link) title = clean(link.getAttribute('title') || link.textContent);
      var img = c.querySelector('img');
      if (!title && img) title = clean(img.getAttribute('alt'));
      if (!title || !link) return;
      var src = img ? (img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || (img.getAttribute('srcset') || '').split(/[\s,]+/)[0] || img.getAttribute('src') || '') : '';
      var text = clean(c.textContent);
      var rm = text.match(/(\d[.,]\d)\s*(?:\/\s*5|sur 5|étoiles?)/i), rv = text.match(/(\d[\d\s .]*)\s*(?:avis|évaluations?)/i);
      add({ name: title.slice(0, 200), price: c.__price, url: abs(link.getAttribute('href')), image: /^data:/.test(src) ? '' : abs(src),
        rating: rm ? parseFloat(rm[1].replace(',', '.')) : null, reviews: rv ? parseInt(rv[1].replace(/\D/g, ''), 10) || 0 : 0 });
    });
    return out;
  }
  window.CorrtexShop = { parseShopGeneric: parseShopGeneric, rsc: rsc, grab: grab, ld: ld, parseSearch: parseSearch, parseProduct: parseProduct, parseCoupons: parseCoupons, score: score, query: query, norm: norm, tokens: tokens, price: price, ACCESSORY: ACCESSORY };
})();
