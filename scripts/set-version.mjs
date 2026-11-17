// Change le numéro de version de Corrtex partout où il apparaît.
// Utilisation : npm run version:set 0.3.0
import { readFileSync, writeFileSync } from 'node:fs';

const v = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(v)) {
  console.error('Indiquez une version de la forme 1.2.3, par exemple : npm run version:set 0.3.0');
  process.exit(1);
}
const conf = 'src-tauri/tauri.conf.json';
const c = JSON.parse(readFileSync(conf, 'utf8'));
c.version = v;
writeFileSync(conf, JSON.stringify(c, null, 2) + '\n');

const cargo = 'src-tauri/Cargo.toml';
writeFileSync(cargo, readFileSync(cargo, 'utf8').replace(/^version = "[^"]*"/m, `version = "${v}"`));

const lock = 'src-tauri/Cargo.lock';
writeFileSync(lock, readFileSync(lock, 'utf8').replace(/(name = "corrtex"\nversion = )"[^"]*"/, `$1"${v}"`));

console.log(`Version ${v}. Publiez-la avec : git commit -am "Version ${v}" && git tag v${v} && git push --follow-tags`);
