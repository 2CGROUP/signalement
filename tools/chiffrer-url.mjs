#!/usr/bin/env node
/*
 * Chiffre l'adresse du serveur Apps Script avec le code d'accès et écrit docs/assets/config.js.
 *
 * Usage (à lancer en local, depuis la racine du dépôt) :
 *   node tools/chiffrer-url.mjs
 *
 * L'URL et le code sont demandés au clavier (et non passés en arguments), pour qu'ils
 * n'apparaissent pas dans l'historique du terminal. Rien d'autre n'est écrit sur le disque.
 * Nécessite Node.js 18 ou plus récent.
 */
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const ITERATIONS = 600000;
const ENDPOINT_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets', 'config.js');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); }; // masque la saisie du code
const lines = rl[Symbol.asyncIterator]();

async function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  return String(value || '').trim();
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '');

async function deriveKey(code, salt, usage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

const url = await ask('URL du déploiement Apps Script (…/exec) : ');
if (!ENDPOINT_PATTERN.test(url)) {
  console.error('Adresse invalide : elle doit être de la forme https://script.google.com/macros/s/…/exec');
  rl.close(); process.exit(1);
}
const code = normalizeCode(await ask('Code d’accès (affiché par showAccessCode) : ', true));
if (code.length < 12) {
  console.error('Code trop court : utilisez le code généré par le script (12 caractères).');
  rl.close(); process.exit(1);
}

rl.close();

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const encKey = await deriveKey(code, salt, 'encrypt');
const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(url)));

// Vérification : on redéchiffre avant d'écrire
const decKey = await deriveKey(code, salt, 'decrypt');
const check = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decKey, data));
if (check !== url) { console.error('Échec de la vérification du chiffrement.'); process.exit(1); }

const config = { v: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
writeFileSync(OUT,
  '/* Généré par tools/chiffrer-url.mjs — ne pas modifier à la main.\n'
  + ' * Contient l\'adresse du serveur, chiffrée avec le code d\'accès (AES-GCM, clé dérivée par PBKDF2).\n'
  + ' * Sans le code, elle est illisible. */\n'
  + 'window.SIGNALEMENT_CONFIG = ' + JSON.stringify(config, null, 2) + ';\n');

console.log('config.js mis à jour. Vérifiez avec « git diff » qu’il ne contient que des données chiffrées, puis ouvrez une pull request.');
