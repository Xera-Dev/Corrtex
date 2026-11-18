#!/bin/bash
# Corrtex pour Mac : recompile rapidement (outils déjà installés) puis relance Corrtex.
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

pkill -x corrtex 2>/dev/null && sleep 1
cd "$ROOT/src-tauri" || exit 1
if ! cargo tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'; then
  echo; echo " [ERREUR] La compilation a échoué."; read -r _; exit 1
fi
rm -rf "$ROOT/Corrtex.app"
cp -R "$ROOT/src-tauri/target/release/bundle/macos/Corrtex.app" "$ROOT/Corrtex.app"
xattr -cr "$ROOT/Corrtex.app" 2>/dev/null
echo; echo " OK, Corrtex relancé."
open "$ROOT/Corrtex.app"
