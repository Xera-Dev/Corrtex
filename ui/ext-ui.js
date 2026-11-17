// Liste et installation des extensions — partagé par la page d'accueil et le
// panneau ouvert depuis la barre d'outils.
(function () {
  const C = window.Corrtex;

  C.mountExtensions = function (opts) {
    const $ = (id) => document.getElementById(id);
    const listBox = $(opts.list);

    function status(text, kind) {
      const el = $(opts.status);
      el.hidden = !text;
      el.textContent = text || '';
      el.className = 'status' + (kind ? ' ' + kind : '');
    }

    function icon(x) {
      // icône de l'extension, ou icône de remplacement si elle est absente ou illisible
      const wrap = document.createElement('div');
      wrap.className = 'ext-icon';
      const fallback = () => { wrap.classList.add('fallback'); wrap.innerHTML = C.ICON_EXT; };
      if (!x.icon) { fallback(); return wrap; }
      const img = document.createElement('img');
      img.alt = '';
      img.onerror = fallback;
      img.onload = () => { if (!img.naturalWidth) fallback(); };
      img.src = x.icon;
      wrap.appendChild(img);
      return wrap;
    }

    function card(x) {
      const el = document.createElement('div');
      el.className = 'ext' + (x.enabled ? '' : ' off');
      el.innerHTML =
        '<div class="ext-top"><div class="ext-meta"><div class="ext-name"></div><div class="ext-ver"></div></div>' +
        '<label class="switch" title="Activer / désactiver"><input type="checkbox"><span></span></label></div>' +
        '<div class="ext-actions"></div>';
      el.querySelector('.ext-top').prepend(icon(x));
      el.querySelector('.ext-name').textContent = x.name || x.id;
      const ver = el.querySelector('.ext-ver');
      ver.textContent = (x.version ? 'Version ' + x.version : '') + (x.description ? (x.version ? ' · ' : '') + x.description : '');
      ver.title = x.description || '';
      const sw = el.querySelector('input');
      sw.checked = x.enabled;
      sw.addEventListener('change', async () => {
        const ok = await C.invoke('ext_set_enabled', { id: x.id, enabled: sw.checked });
        if (ok === null) { status('Impossible de modifier cette extension.', 'err'); sw.checked = !sw.checked; }
        el.classList.toggle('off', !sw.checked);
      });
      const actions = el.querySelector('.ext-actions');
      const add = (label, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener('click', () => fn(b));
        actions.appendChild(b);
      };
      if (x.popup) add('Ouvrir', () => C.invoke('ext_open', { url: x.popup }));
      if (x.options) add('Options', () => C.invoke('ext_open', { url: x.options }));
      add('Supprimer', async (b) => {
        if (!b.classList.contains('confirm')) { b.classList.add('confirm'); b.textContent = 'Confirmer la suppression'; return; }
        await C.invoke('ext_remove', { id: x.id });
        load();
      }, 'danger');
      return el;
    }

    async function load() {
      const list = await C.invoke('ext_list');
      listBox.replaceChildren();
      if (!list || !list.length) {
        const e = document.createElement('p');
        e.className = 'empty';
        e.textContent = document.documentElement.classList.contains('mac')
          ? 'Les extensions Chrome ne fonctionnent pas sur Mac : le moteur de Safari, utilisé par Corrtex sur Mac, ne les accepte pas.'
          : 'Aucune extension installée pour le moment.';
        listBox.appendChild(e);
        return;
      }
      list.forEach((x) => listBox.appendChild(card(x)));
    }

    $(opts.form).addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $(opts.input).value.trim();
      if (!input) return;
      status('Téléchargement et installation…');
      try {
        const info = await window.__TAURI__.core.invoke('ext_install', { input });
        status((info.name || 'L’extension') + ' a été ajoutée.', 'ok');
        $(opts.input).value = '';
      } catch (err) {
        status(String(err), 'err');
      }
      load();
    });
    $(opts.store).addEventListener('click', opts.onStore);
    C.listen('extensions-changed', () => { if (!opts.isVisible || opts.isVisible()) load(); });

    return { load };
  };
})();
