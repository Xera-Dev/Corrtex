// Comparateur de prix : lecture des pages publiques de leDénicheur (produits, offres,
// historique des prix) et de Dealabs (codes promo). Aucune clé d'API n'est nécessaire.
(function () {
  // Données de la page envoyées par morceaux (« self.__next_f.push([1, "…"]) ») : on les recolle
  function rsc(html) {
    const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
    let m, out = '';
    while ((m = re.exec(html))) { try { out += JSON.parse('"' + m[1] + '"'); } catch (e) {} }
    return out;
  }
  // Objet ou tableau JSON qui commence juste après `key` (ex. '"priceHistory":')
  function grab(raw, key, from) {
    const i = raw.indexOf(key, from || 0);
    if (i < 0) return null;
    let j = i + key.length;
    if (/[{[]$/.test(key)) j--;
    while (j < raw.length && raw[j] !== '{' && raw[j] !== '[') j++;
    return balanced(raw, j);
  }
  function balanced(raw, j) {
    let d = 0, s = false, e = false;
    for (let k = j; k < raw.length; k++) {
      const c = raw[k];
      if (s) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') s = false; continue; }
      if (c === '"') s = true;
      else if (c === '{' || c === '[') d++;
      else if (c === '}' || c === ']') { d--; if (!d) { try { return { value: JSON.parse(raw.slice(j, k + 1)), end: k + 1 }; } catch (er) { return null; } } }
    }
    return null;
  }
  // Données schema.org d'un type donné, dans le HTML ou dans les données de la page
  function ld(html, raw, type) {
    const out = [];
    const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html))) { try { const o = JSON.parse(m[1]); if (o['@type'] === type) out.push(o); } catch (e) {} }
    // balises insérées par la page elle-même (« __html »)
    const re2 = /"__html":"((?:[^"\\]|\\.)*)"/g;
    while ((m = re2.exec(raw))) {
      try { const t = JSON.parse('"' + m[1] + '"'); if (t.indexOf('"@type":"' + type + '"') > 0) { const o = JSON.parse(t); if (o['@type'] === type) out.push(o); } } catch (e) {}
    }
    const key = '{"@context":"https://schema.org","@type":"' + type + '"';
    let i = raw.indexOf(key);
    while (i >= 0) {
      const r = balanced(raw, i);
      if (r) out.push(r.value);
      i = raw.indexOf(key, i + key.length);
    }
    return out;
  }
  function price(text) {
    const m = String(text || '').match(/(\d[\d\s  .]*,\d{2}|\d[\d\s  ]*)\s*€/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/[\s  .]/g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  // ---------------------------------------------------------------- leDénicheur : recherche
  function parseSearch(html) {
    const raw = rsc(html);
    const lists = ld(html, raw, 'ItemList');
    const seen = new Set(), out = [];
    for (const l of lists) {
      for (const it of l.itemListElement || []) {
        const p = it.item || it;
        const id = String(p['@id'] || p.url || '').match(/p=(\d+)/);
        if (!id || seen.has(id[1])) continue;
        seen.add(id[1]);
        out.push({
          id: id[1],
          name: p.name || '',
          image: p.image || '',
          url: 'https://ledenicheur.fr/product.php?p=' + id[1],
          price: p.offers ? +(p.offers.price || p.offers.lowPrice) || null : null,
          rating: p.aggregateRating ? +p.aggregateRating.ratingValue : null,
          reviews: p.aggregateRating ? +p.aggregateRating.reviewCount : 0
        });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- leDénicheur : fiche produit
  function parseProduct(html) {
    const raw = rsc(html);
    const res = { name: '', image: '', low: null, high: null, offerCount: 0, variants: [], offers: [], history: [] };
    const group = ld(html, raw, 'ProductGroup')[0] || ld(html, raw, 'Product')[0];
    if (group) {
      res.name = group.name || '';
      res.image = group.image || '';
      const vars = group.hasVariant || [group];
      for (const v of vars) {
        const o = v.offers || {};
        const low = +(o.lowPrice || o.price) || null;
        if (low) res.variants.push({ name: v.name || '', low, high: +o.highPrice || low, count: +o.offerCount || 0, url: v.url || '' });
      }
      const lows = res.variants.map((v) => v.low);
      if (lows.length) res.low = Math.min.apply(null, lows);
      const highs = res.variants.map((v) => v.high);
      if (highs.length) res.high = Math.max.apply(null, highs);
      res.offerCount = res.variants.reduce((a, v) => a + v.count, 0);
    }
    // offres des marchands (liens « Voir l'offre ») : « Marchand, titre, 229,03 €, Voir l'offre »
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const seen = new Set();
    doc.querySelectorAll('a[href*="/go-to-shop/"]').forEach((a) => {
      const href = a.getAttribute('href');
      if (seen.has(href)) return;
      seen.add(href);
      const t = (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').replace(/(Voir l’offre|Voir l'offre)/g, '').trim().replace(/,\s*$/, '');
      const p = price(t);
      if (!p) return;
      const shop = t.split(',')[0].trim();
      const title = t.slice(shop.length + 1).replace(/,\s*\d[\d\s  .]*(,\d{2})?\s*€.*$/, '').trim();
      // prix barré éventuel dans la ligne
      // la ligne de cette offre : le plus grand bloc qui ne contient qu'elle
      let row = a.parentElement;
      while (row && row.parentElement && row.parentElement.querySelectorAll('a[href*="/go-to-shop/"]').length <= 1) row = row.parentElement;
      const all = (row ? row.textContent : '').match(/\d[\d\s  .]*,\d{2}\s*€/g) || [];
      const was = all.map(price).filter((x) => x && x > p && x < p * 4).sort((x, y) => y - x)[0] || null;
      const stock = /en stock/i.test(row ? row.textContent : '');
      res.offers.push({ shop, title, price: p, was, stock, url: href.startsWith('http') ? href : 'https://ledenicheur.fr' + href });
    });
    res.offers.sort((x, y) => x.price - y.price);
    // historique : prix le plus bas de chaque jour (centimes), seulement les jours où il change
    const ph = grab(raw, '"priceHistory":');
    if (ph && ph.value && Array.isArray(ph.value.historyItems)) {
      res.history = ph.value.historyItems
        .filter((h) => h && h.date && +h.price > 0)
        .map((h) => ({ t: Date.parse(h.date), price: h.price / 100, shop: h.shopName || '' }))
        .sort((a, b) => a.t - b.t);
    }
    if (!res.name) { const t = doc.querySelector('h1'); res.name = t ? t.textContent.trim() : ''; }
    return res;
  }

  // ---------------------------------------------------------------- Dealabs : codes promo d'un site
  function parseCoupons(html) {
    const raw = rsc(html);
    const out = [], seen = new Set();
    let from = 0;
    while (true) {
      const r = grab(raw, '"voucher":{', from);
      if (!r) break;
      from = r.end;
      const v = r.value;
      if (!v || !v.title) continue;
      const key = (v.idPool || '') + '|' + v.title + '|' + (v.code || '');
      if (seen.has(key)) continue;
      seen.add(key);
      const end = v.endTime ? Date.parse(v.endTime) : null;
      if (end && end < Date.now()) continue;
      const st = v.voucherVerificationLiveHistory && v.voucherVerificationLiveHistory.status;
      out.push({
        title: v.title.replace(/^Code promo [^:]+:\s*/i, ''),
        badge: [v.caption1, v.caption2].filter(Boolean).join(' '),
        code: v.code || '',
        end,
        verified: st === 'verified',
        terms: v.termsAndConditions || '',
        lastUsed: v.voucherStatistic && v.voucherStatistic.lastUsedDate ? Date.parse(v.voucherStatistic.lastUsedDate) : null
      });
    }
    out.sort((a, b) => (!!b.code - !!a.code) || (b.verified - a.verified) || ((b.lastUsed || 0) - (a.lastUsed || 0)));
    return out;
  }

  // ---------------------------------------------------------------- choix du bon produit
  const ACCESSORY = /\b(housse|coque|etui|étui|coussinet|coussinets|oreillette|embout|arceau|cable|câble|chargeur|support|protection|film|verre trempé|adaptateur|remplacement|replacement|pochette|sacoche|bracelet|pour|for|für|compatible)\b/i;
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter((t) => t.length >= 2 || /\d/.test(t)); }
  function score(siteName, cand) {
    const a = tokens(siteName), b = new Set(tokens(cand));
    if (!a.length) return 0;
    let hit = 0;
    a.forEach((t) => { if (b.has(t)) hit += /\d/.test(t) ? 2 : 1; });
    const max = a.reduce((n, t) => n + (/\d/.test(t) ? 2 : 1), 0);
    let s = hit / max;
    if (ACCESSORY.test(cand) && !ACCESSORY.test(siteName)) s -= 0.45;
    return s;
  }
  // texte de recherche : marque + début du nom, sans le superflu
  function query(info) {
    let n = String(info.name || '').replace(/\(.*?\)|\[.*?\]/g, ' ').split(/\s[-–|]\s|,|\|/)[0];
    let words = n.split(/\s+/).filter(Boolean);
    if (info.brand && words.length && norm(words[0]) !== norm(info.brand) && norm(n).indexOf(norm(info.brand)) < 0) words.unshift(info.brand);
    return words.slice(0, 7).join(' ').trim();
  }

  window.CorrtexShop = { rsc, grab, parseSearch, parseProduct, parseCoupons, score, query, norm, price };
})();
