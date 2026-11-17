// Injecté uniquement dans la vue invisible "gprobe".
// Étapes, de la plus fiable à la moins fiable :
//   1) accounts.google.com/ListAccounts : liste JSON des comptes connectés (nom, e-mail, photo)
//   2) www.google.com : bouton du compte dans l'en-tête (attente que le nom et l'e-mail soient chargés)
// Ce qui a été vu est joint dans "log" (fichier corrtex-debug.log à côté de Corrtex.exe).
(function () {
  if (window.top !== window) return;
  var sent = false;

  function send(data) {
    if (sent) return;
    sent = true;
    try { window.__TAURI_INTERNALS__.invoke('google_profile', { data: data }); } catch (e) {}
  }

  function bigAvatar(src) {
    if (!src) return '';
    if (/=s\d+/.test(src)) return src.replace(/=s\d+(-[a-z0-9-]+)*$/i, '=s192-c');
    if (/\/s\d+(-c)?\//.test(src)) return src.replace(/\/s\d+(-c)?\//, '/s192-c/');
    return src + (src.indexOf('?') < 0 ? '?sz=192' : '');
  }
  function isPhoto(src) { return /^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(src || ''); }

  // ---------------------------------------------------- 1) liste des comptes
  if (location.hostname === 'accounts.google.com') {
    var n = 0;
    var t = setInterval(function () {
      n++;
      var text = (document.body && document.body.innerText || '').trim();
      if (!text && n < 12) return; // ~2 s : la réponse est peut-être traitée comme un téléchargement
      clearInterval(t);
      var log = 'ListAccounts: ' + text.slice(0, 400);
      try {
        var start = text.indexOf('[');
        var data = JSON.parse(text.slice(start));
        var list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
        var acc = null;
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!Array.isArray(a)) continue;
          // l'e-mail est la première chaîne contenant "@", la photo la première URL googleusercontent
          var email = '', photo = '', idx = -1;
          for (var j = 0; j < a.length; j++) {
            if (!email && typeof a[j] === 'string' && /^[^\s@]+@[^\s@]+$/.test(a[j])) { email = a[j]; idx = j; }
            if (!photo && typeof a[j] === 'string' && isPhoto(a[j])) photo = a[j];
          }
          if (email) { acc = { name: typeof a[idx - 1] === 'string' ? a[idx - 1] : '', email: email, avatar: bigAvatar(photo) }; break; }
        }
        if (acc) { send({ signedIn: true, name: acc.name, email: acc.email, avatar: acc.avatar, log: log }); return; }
        if (Array.isArray(data) && Array.isArray(data[1]) && data[1].length === 0) { send({ signedIn: false, log: log }); return; }
      } catch (e) { log += ' | erreur: ' + e; }
      try { sessionStorage.setItem('corrtex_probe_log', log); } catch (e) {}
      location.replace('https://www.google.com/?hl=fr');
    }, 150);
    return;
  }

  // ---------------------------------------------------- 2) en-tête de google.com
  if (location.hostname !== 'www.google.com') return;
  var prevLog = '';
  try { prevLog = sessionStorage.getItem('corrtex_probe_log') || ''; } catch (e) {}

  function findAccount() {
    var links = document.querySelectorAll('a[href*="accounts.google.com/SignOutOptions"], a[aria-label*="@"], a[aria-label*="Compte Google"], a[aria-label*="Google Account"]');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('aria-label') || '').indexOf('@') > 0) return links[i];
    }
    return links[0] || null;
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var account = findAccount();
    var signin = document.querySelector('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"]');
    if (!account && signin) { clearInterval(timer); send({ signedIn: false, log: prevLog + ' | google.com: bouton Connexion' }); return; }
    if (!account) { if (tries > 40) { clearInterval(timer); send({ signedIn: false, log: prevLog + ' | google.com: rien trouvé' }); } return; }

    var label = account.getAttribute('aria-label') || '';
    var imgs = account.querySelectorAll('img');
    var photo = '';
    for (var k = 0; k < imgs.length; k++) { var src = imgs[k].currentSrc || imgs[k].src; if (isPhoto(src)) { photo = src; break; } }
    // le nom, l'e-mail et la photo arrivent parfois après le bouton : on patiente jusqu'à 8 s
    if ((label.indexOf('@') < 0 || !photo) && tries < 32) return;
    clearInterval(timer);
    var m = label.match(/[:：]\s*([^\n(]+?)\s*\(([^)\s]+@[^)\s]+)\)/) || label.match(/([^\n(:]+?)\s*\(([^)\s]+@[^)\s]+)\)/);
    send({
      signedIn: true,
      name: m ? m[1].trim() : '',
      email: m ? m[2].trim() : '',
      avatar: bigAvatar(photo),
      log: prevLog + ' | google.com label="' + label.slice(0, 160) + '" photo="' + photo.slice(0, 160) + '"'
    });
  }, 250);
})();
