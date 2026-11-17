// Lueur d'ambiance de Corrtex sur les pages internes : ajoute les halos (s'ils manquent)
// et applique la couleur, l'intensité et l'activation choisies dans les paramètres.
(function () {
  const C = window.Corrtex;
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
  function apply() {
    const p = C.prefs();
    const [h, s, l] = hexToHsl(/^#[0-9a-f]{6}$/i.test(p.light) ? p.light : '#ff4f7b');
    const root = document.documentElement.style;
    root.setProperty('--l1', hsl(h, s, l));
    root.setProperty('--l2', hsl(h + 38, s, Math.min(.7, l + .05)));
    root.setProperty('--l3', hsl(h - 42, s * .9, Math.max(.35, l - .05)));
    root.setProperty('--intensity', p.lightIntensity);
    document.body.classList.toggle('light-off', !p.lightOn);
  }
  function init() {
    if (!document.getElementById('ambient')) {
      const a = document.createElement('div');
      a.id = 'ambient';
      a.setAttribute('aria-hidden', 'true');
      for (const c of ['b1', 'b2', 'b3']) { const d = document.createElement('div'); d.className = 'blob ' + c; a.appendChild(d); }
      document.body.prepend(a);
    }
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.addEventListener('corrtex-prefs', apply);
  // pas d'animation quand la page n'est pas visible (économie de ressources)
  // ni quand l'économie d'énergie est active
  let saver = false;
  const pause = () => document.body && document.body.classList.toggle('paused', document.hidden || saver);
  document.addEventListener('visibilitychange', pause);
  if (C.listen) C.listen('power-saver', (on) => { saver = !!on; pause(); });
  if (C.invoke) C.invoke('app_info').then((i) => { saver = !!(i && i.power_saver); pause(); }).catch(() => {});
})();
