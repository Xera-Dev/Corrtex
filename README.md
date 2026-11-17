# Corrtex

Navigateur léger pour Windows et Mac, entièrement en français : design métallique sombre en verre liquide, panneau IA intégré (Claude, ChatGPT, Gemini… avec votre propre compte, sans clé API), comparateur de prix, traduction, résumé de vidéos, espaces, vue côte à côte, mode concentration et bien plus.

Construit avec [Tauri 2](https://tauri.app) : il utilise le moteur web déjà présent sur l'ordinateur (WebView2 sous Windows, WebKit sur Mac), d'où une application de quelques Mo.

## Télécharger

Dernière version : **[page des versions](https://github.com/Xera-Dev/Corrtex/releases/latest)**

| Système | Fichier |
| --- | --- |
| Windows 10 et 11 | `Corrtex_…_x64-setup.exe` |
| Mac (Apple Silicon et Intel, macOS 11+) | `Corrtex_…_universal.dmg` |

Les applications ne sont pas signées par Microsoft ni par Apple :
- **Windows** : si SmartScreen s'affiche, cliquez sur « Informations complémentaires » › « Exécuter quand même ».
- **Mac** : au premier lancement, clic droit sur Corrtex › Ouvrir.

## Mises à jour

Corrtex vérifie les nouvelles versions au démarrage puis toutes les 6 heures. Quand une version est disponible, le bouton **Mettre à jour** apparaît dans la barre d'outils : un clic télécharge, installe et redémarre Corrtex (onglets conservés). On peut aussi vérifier à la main : page d'accueil › réglages › À propos.

Les mises à jour sont signées : Corrtex refuse tout fichier qui n'a pas été signé avec la clé du projet.

## Publier une nouvelle version

1. Changer le numéro de version : `npm run version:set 0.3.0` (met à jour `tauri.conf.json`, `Cargo.toml` et `Cargo.lock`).
2. Envoyer sur GitHub avec une étiquette :
   ```
   git commit -am "Version 0.3.0"
   git tag v0.3.0
   git push --follow-tags
   ```
3. Le workflow **Publier une version** (onglet Actions) compile Windows et Mac (environ 15 min), crée la version sur GitHub avec les installateurs et le fichier `latest.json`. Les Corrtex déjà installés proposent alors la mise à jour.

Le workflow peut aussi être lancé à la main (Actions › Publier une version › Run workflow) : il publie la version écrite dans `tauri.conf.json`.

**Clé de signature** : le secret `TAURI_SIGNING_PRIVATE_KEY` du dépôt (Settings › Secrets and variables › Actions) contient la clé privée ; la clé publique est dans `src-tauri/tauri.conf.json`. Gardez une copie de la clé privée en lieu sûr : sans elle, les Corrtex installés ne pourront plus accepter de mise à jour.

## Compiler soi-même

**Windows**
1. **1-Installer-les-outils.bat** (une seule fois, 10 à 20 min).
2. **2-Compiler-et-lancer.bat** : crée `Corrtex.exe` puis le lance.

**Mac**
1. **Mac-Compiler-et-lancer.command** (si macOS refuse : clic droit › Ouvrir). La première fois, il installe les outils d'Apple, Rust et l'outil Tauri (15 à 25 min), puis crée `Corrtex.app` et le lance.
2. Ensuite, **Mac-Recompiler.command** recompile en 1 à 2 minutes et relance Corrtex.

## Différences entre Windows et Mac

Sur Mac : moteur de Safari (WebKit) au lieu de WebView2 ; ⌘ remplace Ctrl dans tous les raccourcis ; vrais boutons de fenêtre à gauche ; pas d'extensions Chrome ; capture d'écran de la partie affichée seulement (macOS demande l'autorisation « Enregistrement de l'écran » la première fois) ; profils séparés à partir de macOS 14 ; pas de page d'erreur Corrtex quand un site ne répond pas.

## Extensions Chrome (Windows)

Sur la page d'une extension du Chrome Web Store, cliquez sur le bouton bleu « Ajouter à Corrtex » en bas à droite, ou collez son lien dans le panneau Extensions.

## Raccourcis

Ctrl+T nouvel onglet · Ctrl+W fermer · Ctrl+L barre d'adresse · Ctrl+K palette de commandes · Ctrl+Tab onglet suivant · F5 actualiser · Alt+← / Alt+→ précédent / suivant · clic molette sur un onglet pour le fermer. Tous modifiables dans les réglages (Gestes et raccourcis). Sur Mac, ⌘ remplace Ctrl.

## Structure

- `src-tauri/src/main.rs` : cœur du navigateur (onglets, fenêtres, panneau IA, mises à jour…)
- `src-tauri/src/tab_script.js` : script injecté dans les pages (raccourcis, traduction, comparateur, lecteur flottant…)
- `src-tauri/src/extensions.rs` : extensions Chrome (Windows)
- `src-tauri/src/google_skin.js` : thème Corrtex des pages de recherche Google
- `src-tauri/src/ai_script.js` : interface réduite du panneau IA
- `ui/` : interface (barre du navigateur, page d'accueil, réglages, menus, bibliothèque…)
- `.github/workflows/release.yml` : compilation et publication des versions
