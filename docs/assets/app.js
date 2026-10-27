/*
 * Dispositif de signalement 2CGroup — logique de la page
 *
 * 1. Le code d'accès déchiffre, dans le navigateur, l'adresse du serveur (assets/config.js).
 *    Un code faux ne permet pas de la retrouver : le formulaire ne s'affiche pas.
 * 2. Le signalement est envoyé SANS COOKIES (credentials: 'omit') et sans référent :
 *    le serveur ne peut pas savoir qui l'envoie, même si la personne est connectée à Google.
 * 3. Aucune donnée n'est stockée dans le navigateur (ni localStorage, ni cookie).
 */
(function () {
  'use strict';

  // Anti-clickjacking : la page refuse de fonctionner si un autre site l'affiche dans un cadre.
  if (window.top !== window.self) {
    document.body.textContent = 'Pour votre sécurité, ouvrez ce formulaire directement à son adresse officielle.';
    return;
  }

  var cfg = window.SIGNALEMENT_CONFIG || null;
  var ENDPOINT_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  var endpoint = null;
  var accessCode = null;

  function $(id) { return document.getElementById(id); }
  function normalizeCode(c) { return String(c || '').toUpperCase().replace(/[\s-]/g, ''); }
  function b64ToBytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }

  async function decryptEndpoint(code) {
    var enc = new TextEncoder();
    var base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64ToBytes(cfg.salt), iterations: cfg.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(cfg.iv) }, key, b64ToBytes(cfg.data));
    return new TextDecoder().decode(plain);
  }

  /* ---------- Écran du code d'accès ---------- */

  var gate = $('gate');
  var unlock = $('unlock');
  var gateError = $('gateError');

  gate.addEventListener('submit', async function (e) {
    e.preventDefault();
    gateError.textContent = '';
    var code = normalizeCode($('accessCode').value);
    if (!code) { gateError.textContent = 'Saisissez le code d’accès.'; $('accessCode').focus(); return; }
    if (!cfg || !cfg.data) { gateError.textContent = 'Le dispositif n’est pas encore configuré. Réessayez plus tard.'; return; }
    if (!window.crypto || !crypto.subtle) { gateError.textContent = 'Votre navigateur est trop ancien pour ce formulaire. Utilisez une version récente de Chrome, Firefox, Safari ou Edge.'; return; }

    unlock.disabled = true;
    unlock.textContent = 'Vérification…';
    try {
      var url = await decryptEndpoint(code);
      if (!ENDPOINT_PATTERN.test(url)) throw new Error('bad');
      endpoint = url;
      accessCode = code;
      gate.hidden = true;
      var form = $('report');
      form.hidden = false;
      form.classList.add('appear');
      $('entity').focus();
    } catch (err) {
      gateError.textContent = 'Code d’accès incorrect. Vérifiez le code indiqué dans l’espace Notion du groupe.';
      $('accessCode').select();
    } finally {
      unlock.disabled = false;
      unlock.textContent = 'Accéder au formulaire';
    }
  });

  /* ---------- Formulaire ---------- */

  var form = $('report');
  var send = $('send');
  var error = $('error');
  var desc = $('description');

  desc.addEventListener('input', function () {
    $('count').textContent = desc.value.length.toLocaleString('fr-FR');
  });

  function collect() {
    return {
      accessCode: accessCode,
      entity: $('entity').value,
      category: $('category').value,
      period: $('period').value.trim(),
      description: desc.value.trim(),
      people: $('people').value.trim(),
      evidence: $('evidence').value.trim(),
      contact: $('contact').value.trim(),
      goodFaith: $('goodFaith').checked,
      website: $('website').value
    };
  }

  function check(d) {
    if (!d.entity) return ['entity', 'Choisissez l’entité concernée.'];
    if (!d.category) return ['category', 'Choisissez le type de faits.'];
    if (d.description.length < 30) return ['description', 'Décrivez les faits en quelques phrases (30 caractères minimum).'];
    if (d.contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.contact)) return ['contact', 'Cette adresse e-mail n’est pas valide. Corrigez-la ou laissez le champ vide.'];
    if (!d.goodFaith) return ['goodFaith', 'Cochez la case de bonne foi pour envoyer le signalement.'];
    return null;
  }

  function showDone(ref) {
    $('intro').hidden = true;
    form.hidden = true;
    form.reset();
    $('ref').textContent = ref;
    var done = $('done');
    done.hidden = false;
    done.classList.add('appear');
    endpoint = null;
    accessCode = null;
    window.scrollTo(0, 0);
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    error.textContent = '';
    var d = collect();
    var problem = check(d);
    if (problem) { error.textContent = problem[1]; $(problem[0]).focus(); return; }

    send.disabled = true;
    send.textContent = 'Envoi en cours…';
    try {
      var res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'omit',          // aucun cookie : Google ne peut pas identifier l'auteur
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // requête « simple » : pas de pré-vérification CORS
        body: JSON.stringify(d)
      });
      var out = await res.json();
      if (!out || !out.ok) throw new Error((out && out.error) || '');
      showDone(out.ref);
    } catch (err) {
      error.textContent = (err && err.message) ? err.message : 'L’envoi n’a pas abouti. Vérifiez votre connexion et réessayez.';
      send.disabled = false;
      send.textContent = 'Envoyer le signalement';
    }
  });
})();
