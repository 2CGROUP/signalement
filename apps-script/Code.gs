/**
 * Dispositif de signalement 2CGroup — serveur (Google Apps Script)
 *
 * La page du formulaire est hébergée sur GitHub Pages. Elle envoie chaque signalement ici
 * par une requête POST SANS COOKIES : Google ne sait donc pas qui l'envoie, même si la
 * personne est connectée à son compte 2CGroup dans son navigateur.
 *
 * Ce script :
 *  - ne lit jamais l'identité de l'utilisateur (aucun appel à Session.getActiveUser) ;
 *  - vérifie le code d'accès commun, applique une limite d'envois par heure ;
 *  - met les signalements en file d'attente (propriétés du script, sans historique) ;
 *  - envoie chaque matin un seul mail groupé à la boîte d'alerte, puis vide la file ;
 *  - peut prévenir d'autres personnes par un court avis SANS CONTENU (nombre de déclarations) :
 *    renseigner leurs adresses, séparées par des virgules, dans la propriété du script NOTIFY_TO
 *    (Paramètres du projet > Propriétés du script). Ne jamais écrire ces adresses dans ce fichier ;
 *  - ne journalise aucun contenu.
 *
 * Déploiement : Application Web, « Exécuter en tant que : moi », « Qui a accès : Tout le monde ».
 * Le projet DOIT appartenir au compte de la boîte d'alerte.
 *
 * Fonctions à lancer à la main depuis l'éditeur :
 *  - setup()            : une fois (autorisations, déclencheur quotidien, premier code d'accès)
 *  - showAccessCode()   : affiche le code actuel dans le journal d'exécution
 *  - rotateAccessCode() : génère un nouveau code (penser à rechiffrer l'URL côté GitHub)
 *  - sendDigest()       : force l'envoi immédiat de la file d'attente
 */

const CONFIG = {
  // Laisser vide = le mail est envoyé au propriétaire du script (la boîte d'alerte).
  RECIPIENT: '',
  SENDER_NAME: 'Dispositif de signalement 2CGroup',
  // Valeurs autorisées : code envoyé par la page -> libellé affiché dans le mail
  LISTS: {
    roles: { concerne: 'Personnellement concerné·e par les faits', temoin: 'Témoin direct des faits', indirect: 'Connaissance indirecte des faits', autre: 'Autre' },
    subjects: { harcelement_moral: 'Harcèlement moral', harcelement_sexuel: 'Harcèlement sexuel', discrimination: 'Discrimination', violences: 'Violences physiques ou verbales', autre: 'Autre' },
    frequency: { isole: 'Fait isolé', repete: 'Répété', quotidien: 'Quotidien' },
    hierarchy: { oui: 'Oui', non: 'Non', collegue: 'Collègue', autre: 'Autre' },
    evidence: { temoins: 'Témoins directs', ecrits: 'Écrits, courriels, messages, photos, enregistrements', medical: 'Comptes rendus médicaux ou arrêts de travail' },
    steps: { aucune: 'Aucune démarche à ce jour', hierarchie: 'Alerte ou information de la hiérarchie', cse: 'Saisine des représentants du personnel / CSE', inspection: 'Déclaration à l’inspection du travail', plainte: 'Dépôt de plainte ou de main courante', medecin: 'Consultation du médecin du travail', autre: 'Autre' },
    expectations: { enquete: 'Une enquête interne', protection: 'Une mesure de protection ou de mise à distance', mediation: 'Une médiation', enregistrement: 'Un simple enregistrement du signalement', suivi: 'Être informé·e de l’avancement', autre: 'Autre' },
    urgent: { oui: 'OUI — risque immédiat pour la santé ou la sécurité', non: 'Non' },
  },
  DIGEST_HOUR: 8,                 // heure de l'envoi groupé quotidien (Europe/Paris)
  MAX_PER_HOUR: 30,               // signalements acceptés par heure, tous utilisateurs confondus
  MAX_BODY_CHARS: 60000,
  LIMITS: { description: 10000, details: 2000, evidence: 1000, short: 300, tiny: 120 },
};

const PROP_CODE = 'ACCESS_CODE';
const PROP_NOTIFY = 'NOTIFY_TO';
const CODE_LENGTH = 12;          // 12 caractères parmi 32 : environ 60 bits, hors de portée d'une attaque par force brute
const QUEUE_PREFIX = 'q|';
const CHUNK_CHARS = 2500;        // une propriété est limitée à 9 Ko
const QUEUE_MAX_BYTES = 350000;  // stockage total limité à 500 Ko : au-delà, envoi intermédiaire
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TZ = 'Europe/Paris';

/* ================= Points d'entrée web ================= */

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > CONFIG.MAX_BODY_CHARS) throw userError_('Le signalement est trop long.');
    let form;
    try { form = JSON.parse(raw); } catch (err) { throw userError_('Requête invalide.'); }
    return json_(submitReport_(form));
  } catch (err) {
    // Seuls les messages prévus pour l'utilisateur sont renvoyés ; les erreurs internes restent génériques.
    const msg = err && err.userFacing ? err.message : 'Le signalement n’a pas pu être enregistré. Réessayez plus tard.';
    return json_({ ok: false, error: msg });
  }
}

function userError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= Administration ================= */

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_CODE)) props.setProperty(PROP_CODE, randomString_(CODE_LENGTH));

  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sendDigest'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDigest').timeBased()
    .atHour(CONFIG.DIGEST_HOUR).everyDays(1).inTimezone(TZ).create();

  MailApp.getRemainingDailyQuota(); // déclenche l'autorisation d'envoi de mails
  console.log('Installation terminée. Envoi groupé chaque jour vers ' + CONFIG.DIGEST_HOUR + 'h.');
  showAccessCode();
}

function showAccessCode() {
  const code = PropertiesService.getScriptProperties().getProperty(PROP_CODE);
  console.log(code ? 'Code d’accès actuel : ' + formatCode_(code) : 'Aucun code : lancez setup().');
}

function rotateAccessCode() {
  PropertiesService.getScriptProperties().setProperty(PROP_CODE, randomString_(CODE_LENGTH));
  console.log('Nouveau code généré. L’ancien ne fonctionne plus.');
  console.log('À faire maintenant : rechiffrer l’URL avec tools/chiffrer-url.mjs et publier la page.');
  showAccessCode();
}

/* ================= Réception d'un signalement ================= */

function submitReport_(form) {
  // Pot de miel anti-robot : champ invisible qui doit rester vide
  if (form && form.website) return { ok: true, ref: makeRef_() };

  const cache = CacheService.getScriptCache();
  const hour = Utilities.formatDate(new Date(), TZ, 'yyyyMMddHH');

  // 1. Code d'accès. Un code faux est toujours refusé, mais les tentatives ratées
  //    ne bloquent jamais les envois avec le bon code (pas de déni de service possible).
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_CODE) || '';
  const given = normalizeCode_(form && form.accessCode);
  if (!expected || !safeEqual_(given, expected)) {
    throw userError_('Code d’accès incorrect ou expiré. Rechargez la page et saisissez le code en vigueur.');
  }

  // 2. Contenu
  const data = validate_(form);
  if (data.error) throw userError_(data.error);

  // 3. Limite globale
  const rateKey = 'rate_' + hour;
  const count = Number(cache.get(rateKey) || 0);
  if (count >= CONFIG.MAX_PER_HOUR) {
    throw userError_('Trop de signalements ont été envoyés cette heure-ci. Réessayez un peu plus tard.');
  }
  cache.put(rateKey, String(count + 1), 3600);

  // 4. Mise en file d'attente
  data.ref = makeRef_();
  data.day = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');
  enqueue_(data);
  return { ok: true, ref: data.ref };
}

/* ================= File d'attente ================= */

function enqueue_(report) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const json = JSON.stringify(report);
    if (queueBytes_(props.getProperties()) + utf8Bytes_(json) > QUEUE_MAX_BYTES) flush_(props);
    const parts = Math.ceil(json.length / CHUNK_CHARS);
    const batch = {};
    for (let i = 0; i < parts; i++) {
      batch[QUEUE_PREFIX + report.ref + '|' + i + '|' + parts] = json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
    }
    props.setProperties(batch);
  } finally {
    lock.releaseLock();
  }
}

/** Déclencheur quotidien : envoie tous les signalements en attente en un seul mail. */
function sendDigest() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    flush_(PropertiesService.getScriptProperties());
  } finally {
    lock.releaseLock();
  }
}

function flush_(props) {
  const all = props.getProperties();
  const groups = {};
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(QUEUE_PREFIX) !== 0) return;
    const p = k.split('|'); // q | ref | index | total
    groups[p[1]] = groups[p[1]] || { keys: [], chunks: [], total: Number(p[3]) };
    groups[p[1]].keys.push(k);
    groups[p[1]].chunks[Number(p[2])] = all[k];
  });

  const reports = [];
  const doneKeys = [];
  Object.keys(groups).sort().forEach(function (ref) { // tri par référence : ne révèle pas l'ordre d'arrivée
    const g = groups[ref];
    if (g.chunks.filter(String).length !== g.total) return; // incomplet : gardé pour le prochain envoi
    try { reports.push(JSON.parse(g.chunks.join(''))); } catch (e) { /* illisible : supprimé */ }
    Array.prototype.push.apply(doneKeys, g.keys);
  });
  if (!reports.length) return;

  const n = reports.length;
  const today = Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy');
  const urgent = reports.some(function (r) { return r.urgent && r.urgent.indexOf('OUI') === 0; });
  const subject = (urgent ? '[URGENT] ' : '')
    + '[Signalements] ' + n + (n > 1 ? ' nouvelles déclarations' : ' nouvelle déclaration') + ' — ' + today;
  const mail = {
    to: CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail(), // propriétaire du script, jamais le visiteur
    subject: subject,
    name: CONFIG.SENDER_NAME,
    htmlBody: reports.map(buildHtml_).join('<hr style="border:0;border-top:2px solid #cdc6fa;margin:28px 0">') + footerHtml_(),
    body: reports.map(buildText_).join('\n\n----------------------------------------\n\n'),
  };
  if (n === 1 && reports[0].contact && isEmail_(reports[0].contact)) mail.replyTo = reports[0].contact;

  MailApp.sendEmail(mail); // si l'envoi échoue, rien n'est supprimé
  doneKeys.forEach(function (k) { props.deleteProperty(k); });
  notify_(props, subject, n);
}

// Avis sans contenu : seulement le nombre de déclarations et, le cas échéant, la mention [URGENT].
// Envoyé après le vidage de la file : un échec ici ne bloque ni ne duplique le mail principal.
function notify_(props, subject, n) {
  const to = String(props.getProperty(PROP_NOTIFY) || '').split(',')
    .map(function (s) { return s.trim(); }).filter(isEmail_);
  if (!to.length) return;
  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: subject,
      name: CONFIG.SENDER_NAME,
      body: (n > 1 ? n + ' nouvelles déclarations ont été transmises' : 'Une nouvelle déclaration a été transmise')
        + ' à la boîte du comité d’éthique.\nLe contenu n’est pas reproduit dans ce message.',
    });
  } catch (e) {
    console.log('Avis sans contenu non envoyé.'); // ni adresse ni contenu dans le journal
  }
}

/* ================= Helpers ================= */

function validate_(f) {
  if (!f) return { error: 'Formulaire vide.' };
  const L = CONFIG.LIMITS, LI = CONFIG.LISTS;
  const clean = function (v, max) { return String(v || '').replace(/\u0000/g, '').trim().slice(0, max); };
  const list = function (v, map) {
    return (Array.isArray(v) ? v : []).filter(function (x, i, arr) {
      return Object.prototype.hasOwnProperty.call(map, x) && arr.indexOf(x) === i;
    }).map(function (x) { return map[x]; });
  };
  const one = function (v, map) { return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : ''; };
  const date = function (v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  };
  const d = {
    name: clean(f.name, L.tiny),
    contact: clean(f.contact, L.short),
    roles: list(f.roles, LI.roles), rolesOther: clean(f.rolesOther, L.short),
    subjects: list(f.subjects, LI.subjects), subjectsOther: clean(f.subjectsOther, L.short),
    discriminationGround: clean(f.discriminationGround, L.short),
    subjectDetails: clean(f.subjectDetails, L.details),
    description: clean(f.description, L.description),
    dateFrom: date(f.dateFrom), dateTo: date(f.dateTo),
    place: clean(f.place, L.short),
    frequency: one(f.frequency, LI.frequency),
    usualTime: clean(f.usualTime, L.tiny),
    accusedName: clean(f.accusedName, L.short),
    accusedService: clean(f.accusedService, L.short),
    hierarchy: one(f.hierarchy, LI.hierarchy),
    hierarchyOther: f.hierarchy === 'autre' ? clean(f.hierarchyOther, L.short) : '',
    evidence: list(f.evidence, LI.evidence),
    evidenceWitnesses: clean(f.evidenceWitnesses, L.evidence),
    evidenceDocuments: clean(f.evidenceDocuments, L.evidence),
    evidenceMedical: clean(f.evidenceMedical, L.evidence),
    steps: list(f.steps, LI.steps), stepsOther: clean(f.stepsOther, L.short),
    expectations: list(f.expectations, LI.expectations), expectationsOther: clean(f.expectationsOther, L.short),
    urgent: one(f.urgent, LI.urgent),
    certifyAccurate: f.certifyAccurate === true,
    certifyInformed: f.certifyInformed === true,
  };
  const content = Object.keys(d).filter(function (k) {
    return ['urgent', 'certifyAccurate', 'certifyInformed'].indexOf(k) === -1;
  });
  if (content.every(function (k) { return Array.isArray(d[k]) ? !d[k].length : !d[k]; })) {
    return { error: 'Le formulaire est vide. Décrivez au moins la situation que vous souhaitez signaler.' };
  }
  if (d.expectations.indexOf(LI.expectations.suivi) !== -1 && !d.contact) {
    return { error: 'Pour être informé·e de l’avancement, indiquez un moyen de contact dans la rubrique 1.' };
  }
  if (!d.certifyAccurate || !d.certifyInformed) {
    return { error: 'Cochez les deux cases de la rubrique 11 pour envoyer la déclaration.' };
  }
  return d;
}

function randomString_(len) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[(bytes[i] + 256) % ALPHABET.length];
  return s;
}

function makeRef_() {
  const s = randomString_(7);
  return s.slice(0, 3) + '-' + s.slice(3); // ex. A7K-3QX9
}

function formatCode_(c) { return c.match(/.{1,4}/g).join('-'); }

function normalizeCode_(c) { return String(c || '').toUpperCase().replace(/[\s-]/g, ''); }

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function utf8Bytes_(s) { return Utilities.newBlob(s).getBytes().length; }

function queueBytes_(all) {
  return Object.keys(all).reduce(function (n, k) {
    return k.indexOf(QUEUE_PREFIX) === 0 ? n + utf8Bytes_(k) + utf8Bytes_(all[k]) : n;
  }, 0);
}

function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

function esc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function joinOther_(items, other) {
  return items.join(', ') + (other ? (items.length ? ' ' : '') + '(précision : ' + other + ')' : '');
}

/** Rubriques du mail, dans l'ordre de la trame. Les lignes vides sont omises. */
function sections_(d) {
  return [
    ['Réservé au comité d’éthique', [
      ['N° de dossier', d.ref], ['Date de réception', d.day],
      ['Situation urgente', d.urgent],
      ['Reçu par (service / fonction)', '…'], ['Orientation', 'enquête, médiation, classement, autre'],
    ]],
    ['1. Identification', [['Nom ou pseudonyme', d.name], ['Contact', d.contact]]],
    ['2. Qualité du déclarant', [['À quel titre', joinOther_(d.roles, d.rolesOther)]]],
    ['3. Objet de la déclaration', [
      ['Objet', joinOther_(d.subjects, d.subjectsOther)],
      ['Motif de discrimination', d.discriminationGround], ['Précisions', d.subjectDetails]]],
    ['4. Description des faits', [['Description', d.description]]],
    ['5. Dates, lieux et fréquence', [
      ['Période', [d.dateFrom, d.dateTo].filter(String).join(' → ')], ['Lieu ou service', d.place],
      ['Fréquence', d.frequency], ['Heure habituelle', d.usualTime]]],
    ['6. Personne(s) mise(s) en cause', [
      ['Nom ou fonction', d.accusedName], ['Service / établissement', d.accusedService],
      ['Lien hiérarchique', joinOther_(d.hierarchy ? [d.hierarchy] : [], d.hierarchyOther)]]],
    ['7. Témoins et éléments matériels', [
      ['Éléments signalés', d.evidence.join(', ')], ['Témoins', d.evidenceWitnesses],
      ['Écrits, enregistrements', d.evidenceDocuments], ['Éléments médicaux', d.evidenceMedical]]],
    ['8. Démarches déjà entreprises', [['Démarches', joinOther_(d.steps, d.stepsOther)]]],
    ['9. Attentes', [['Suite attendue', joinOther_(d.expectations, d.expectationsOther)]]],
    ['11. Déclaration du déclarant', [
      ['Informations exactes et sincères', d.certifyAccurate ? 'Certifié' : 'Non coché'],
      ['Informé·e de la transmission', d.certifyInformed ? 'Oui' : 'Non coché']]],
  ].map(function (s) {
    return [s[0], s[1].filter(function (r) { return r[1]; })];
  }).filter(function (s) { return s[1].length; });
}

function row_(label, value) {
  return '<tr><td style="padding:8px 14px;vertical-align:top;color:#5b4be0;font-weight:bold;width:190px;border-bottom:1px solid #eceaf7">'
    + esc_(label) + '</td><td style="padding:8px 14px;color:#1f2330;white-space:pre-wrap;border-bottom:1px solid #eceaf7">'
    + esc_(value) + '</td></tr>';
}

function buildHtml_(d) {
  const urgent = d.urgent && d.urgent.indexOf('OUI') === 0;
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;max-width:760px">'
    + '<p style="font-size:18px;font-weight:bold;color:#1f2330;margin:0 0 4px">Déclaration ' + esc_(d.ref)
    + (urgent ? ' <span style="color:#b3261e">— situation urgente signalée</span>' : '') + '</p>'
    + '<p style="color:#4a4f5a;margin:0 0 14px">Déposée le ' + esc_(d.day) + '. '
    + (d.contact ? 'Le déclarant a laissé un moyen de contact.' : 'Déclaration anonyme, sans moyen de contact.') + '</p>'
    + sections_(d).map(function (s) {
      return '<p style="font-weight:bold;color:#1f2330;margin:18px 0 6px">' + esc_(s[0]) + '</p>'
        + '<table style="border-collapse:collapse;width:100%;background:#f9f8ff">'
        + s[1].map(function (r) { return row_(r[0], r[1]); }).join('') + '</table>';
    }).join('')
    + '</div>';
}

function footerHtml_() {
  return '<p style="font-family:Arial,Helvetica,sans-serif;color:#9aa0ab;font-size:12px;margin-top:24px">'
    + 'Rappel : accusé de réception sous 7 jours et retour sous 3 mois lorsque l’auteur a laissé un contact. '
    + 'Ne transférez pas ce message hors des personnes habilitées à traiter les signalements.</p>';
}

function buildText_(d) {
  return 'Déclaration ' + d.ref + ' (déposée le ' + d.day + ')\n\n'
    + sections_(d).map(function (s) {
      return s[0].toUpperCase() + '\n' + s[1].map(function (r) { return r[0] + ' : ' + r[1]; }).join('\n');
    }).join('\n\n');
}
