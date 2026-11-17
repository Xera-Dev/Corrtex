#!/bin/bash
# Corrtex pour Mac : installe les outils si besoin, compile Corrtex.app, puis le lance.
# Double-cliquez sur ce fichier dans le Finder (ou : bash Mac-Compiler-et-lancer.command).
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

fail() { echo; echo " [ERREUR] $1"; echo; read -r -p " Appuyez sur Entrée pour fermer…" _; exit 1; }

echo
echo " ── Corrtex pour Mac ──"
echo

# 1. Outils de développement d'Apple (compilateur, éditeur de liens)
if ! xcode-select -p >/dev/null 2>&1; then
  echo " Installation des outils de développement d'Apple : une fenêtre va s'ouvrir, cliquez sur « Installer »."
  xcode-select --install
  fail "Relancez ce fichier une fois l'installation des outils d'Apple terminée."
fi

# 2. Rust
if ! command -v cargo >/dev/null 2>&1; then
  echo " Installation de Rust (une seule fois, quelques minutes)…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal || fail "L'installation de Rust a échoué."
  source "$HOME/.cargo/env"
fi

# 3. Outil Tauri (fabrique l'application Corrtex.app)
if ! cargo tauri --version >/dev/null 2>&1; then
  echo " Installation de l'outil Tauri (une seule fois, 5 à 10 minutes)…"
  cargo install tauri-cli --version "^2" --locked || fail "L'installation de l'outil Tauri a échoué."
fi

# 4. Compilation
echo
echo " Compilation de Corrtex (la première fois : 5 à 10 minutes, ensuite bien plus rapide)…"
echo
cd "$ROOT/src-tauri" || exit 1
cargo tauri build --bundles app || fail "La compilation a échoué. Copiez le message ci-dessus et envoyez-le à Claude."

APP="$ROOT/src-tauri/target/release/bundle/macos/Corrtex.app"
[ -d "$APP" ] || fail "Corrtex.app est introuvable après la compilation."

# 5. Copie à côté de ce fichier, levée de la quarantaine, lancement
rm -rf "$ROOT/Corrtex.app"
cp -R "$APP" "$ROOT/Corrtex.app"
xattr -cr "$ROOT/Corrtex.app" 2>/dev/null

echo
echo " OK ! Corrtex.app est prêt dans ce dossier (vous pouvez le glisser dans Applications). Lancement…"
open "$ROOT/Corrtex.app"
sleep 2
