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
      $('name').focus();
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
  var lastCopy = '';

  desc.addEventListener('input', function () {
    $('count').textContent = desc.value.length.toLocaleString('fr-FR');
  });

  // Rubrique 10 : en cas d'urgence, rappeler que le formulaire n'est pas traité en temps réel
  Array.prototype.forEach.call(document.querySelectorAll('input[name="urgent"]'), function (r) {
    r.addEventListener('change', function () { $('urgentInfo').hidden = !(r.checked && r.value === 'oui'); });
  });

  function val(name) { var el = form.elements[name]; return el ? String(el.value || '').trim() : ''; }
  function all(name) {
    return Array.prototype.filter.call(form.querySelectorAll('input[name="' + name + '"]'), function (i) { return i.checked; })
      .map(function (i) { return i.value; });
  }
  function one(name) { var a = all(name); return a.length ? a[0] : ''; }

  function collect() {
    return {
      accessCode: accessCode,
      name: val('name'), contact: val('contact'),
      roles: all('roles'), rolesOther: val('rolesOther'),
      subjects: all('subjects'), subjectsOther: val('subjectsOther'),
      discriminationGround: val('discriminationGround'), subjectDetails: val('subjectDetails'),
      description: val('description'),
      dateFrom: val('dateFrom'), dateTo: val('dateTo'), place: val('place'),
      frequency: one('frequency'), usualTime: val('usualTime'),
      accusedName: val('accusedName'), accusedService: val('accusedService'), hierarchy: one('hierarchy'),
      evidence: all('evidence'), evidenceWitnesses: val('evidenceWitnesses'),
      evidenceDocuments: val('evidenceDocuments'), evidenceMedical: val('evidenceMedical'),
      steps: all('steps'), stepsOther: val('stepsOther'),
      expectations: all('expectations'), expectationsOther: val('expectationsOther'),
      urgent: one('urgent'),
      certifyAccurate: $('certifyAccurate').checked, certifyInformed: $('certifyInformed').checked,
      website: val('website')
    };
  }

  function isEmpty(d) {
    var keys = Object.keys(d).filter(function (k) {
      return ['accessCode', 'website', 'certifyAccurate', 'certifyInformed', 'urgent'].indexOf(k) === -1;
    });
    return keys.every(function (k) { return Array.isArray(d[k]) ? d[k].length === 0 : !d[k]; });
  }

  function check(d) {
    if (isEmpty(d)) return ['description', 'Le formulaire est vide. Décrivez au moins la situation que vous souhaitez signaler.'];
    if (d.expectations.indexOf('suivi') !== -1 && !d.contact) {
      return ['contact', 'Pour être informé·e de l’avancement, indiquez un moyen de contact dans la rubrique 1.'];
    }
    if (d.dateFrom && d.dateTo && d.dateTo < d.dateFrom) return ['dateTo', 'La fin de la période est antérieure à son début.'];
    return null;
  }

  function frDate(iso) { var p = iso.split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }

  // Copie lisible de la déclaration, gardée en mémoire uniquement pour le bouton de téléchargement
  function textCopy(d, ref) {
    var labels = {};
    Array.prototype.forEach.call(form.querySelectorAll('input[type=checkbox][value], input[type=radio]'), function (i) {
      labels[i.name + ':' + i.value] = i.parentNode.textContent.trim().replace(/\s*\(.*\)$/, '');
    });
    function list(name, arr) { return arr.map(function (v) { return labels[name + ':' + v]; }).join(', '); }
    var lines = [
      'Déclaration anonyme — dossier ' + ref,
      '',
      ['Nom ou pseudonyme', d.name], ['Contact', d.contact],
      ['Qualité du déclarant', list('roles', d.roles) + (d.rolesOther ? ' (' + d.rolesOther + ')' : '')],
      ['Objet', list('subjects', d.subjects) + (d.subjectsOther ? ' (' + d.subjectsOther + ')' : '')],
      ['Motif de discrimination', d.discriminationGround], ['Précisions', d.subjectDetails],
      ['Description des faits', d.description],
      ['Période', [d.dateFrom, d.dateTo].filter(Boolean).map(frDate).join(' → ')], ['Lieu ou service', d.place],
      ['Fréquence', list('frequency', d.frequency ? [d.frequency] : [])], ['Heure habituelle', d.usualTime],
      ['Personne mise en cause', d.accusedName], ['Service / établissement', d.accusedService],
      ['Lien hiérarchique', list('hierarchy', d.hierarchy ? [d.hierarchy] : [])],
      ['Témoins', d.evidenceWitnesses], ['Écrits et enregistrements', d.evidenceDocuments], ['Éléments médicaux', d.evidenceMedical],
      ['Démarches entreprises', list('steps', d.steps) + (d.stepsOther ? ' (' + d.stepsOther + ')' : '')],
      ['Attentes', list('expectations', d.expectations) + (d.expectationsOther ? ' (' + d.expectationsOther + ')' : '')],
      ['Situation urgente', list('urgent', d.urgent ? [d.urgent] : [])]
    ];
    return lines.map(function (l) {
      if (typeof l === 'string') return l;
      return l[1] ? l[0] + ' : ' + l[1] : null;
    }).filter(function (l) { return l !== null; }).join('\n');
  }

  $('download').addEventListener('click', function () {
    if (!lastCopy) return;
    var url = URL.createObjectURL(new Blob([lastCopy], { type: 'text/plain;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'declaration-' + $('ref').textContent + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  function showDone(ref, d) {
    lastCopy = textCopy(d, ref);
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
      showDone(out.ref, d);
    } catch (err) {
      error.textContent = (err && err.message) ? err.message : 'L’envoi n’a pas abouti. Vérifiez votre connexion et réessayez.';
      send.disabled = false;
      send.textContent = 'Envoyer la déclaration';
    }
  });
})();
