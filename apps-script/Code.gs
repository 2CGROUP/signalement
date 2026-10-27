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
  ENTITIES: ['2CGroup (holding)', '2CFinance', 'R4Innov', 'HR4Team', 'iytro', 'Collectively.life', 'Argura', 'Je ne sais pas / plusieurs'],
  CATEGORIES: [
    'Harcèlement moral',
    'Harcèlement sexuel ou agissement sexiste',
    'Discrimination',
    'Atteinte à la santé ou à la sécurité',
    'Fraude, corruption ou conflit d’intérêts',
    'Atteinte à l’environnement',
    'Autre manquement à la loi ou au règlement intérieur',
  ],
  DIGEST_HOUR: 8,                 // heure de l'envoi groupé quotidien (Europe/Paris)
  MAX_PER_HOUR: 30,               // signalements acceptés par heure, tous utilisateurs confondus
  MAX_FAILED_CODES_PER_HOUR: 100, // tentatives de code erronées avant blocage temporaire
  MAX_BODY_CHARS: 40000,
  LIMITS: { description: 10000, short: 300, medium: 3000, contact: 200 },
};

const PROP_CODE = 'ACCESS_CODE';
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
    if (raw.length > CONFIG.MAX_BODY_CHARS) throw new Error('Le signalement est trop long.');
    let form;
    try { form = JSON.parse(raw); } catch (err) { throw new Error('Requête invalide.'); }
    return json_(submitReport_(form));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= Administration ================= */

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP_CODE)) props.setProperty(PROP_CODE, randomString_(8));

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
  PropertiesService.getScriptProperties().setProperty(PROP_CODE, randomString_(8));
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

  // 1. Code d'accès
  const failKey = 'fail_' + hour;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_FAILED_CODES_PER_HOUR) {
    throw new Error('Le formulaire est temporairement indisponible. Réessayez dans une heure.');
  }
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_CODE) || '';
  const given = normalizeCode_(form && form.accessCode);
  if (!expected || !safeEqual_(given, expected)) {
    cache.put(failKey, String(fails + 1), 3600);
    throw new Error('Code d’accès incorrect ou expiré. Rechargez la page et saisissez le code en vigueur.');
  }

  // 2. Contenu
  const data = validate_(form);
  if (data.error) throw new Error(data.error);

  // 3. Limite globale
  const rateKey = 'rate_' + hour;
  const count = Number(cache.get(rateKey) || 0);
  if (count >= CONFIG.MAX_PER_HOUR) {
    throw new Error('Trop de signalements ont été envoyés cette heure-ci. Réessayez un peu plus tard.');
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
  const mail = {
    to: CONFIG.RECIPIENT || Session.getEffectiveUser().getEmail(), // propriétaire du script, jamais le visiteur
    subject: '[Signalements] ' + n + (n > 1 ? ' nouveaux signalements' : ' nouveau signalement') + ' — ' + today,
    name: CONFIG.SENDER_NAME,
    htmlBody: reports.map(buildHtml_).join('<hr style="border:0;border-top:2px solid #cdc6fa;margin:28px 0">') + footerHtml_(),
    body: reports.map(buildText_).join('\n\n----------------------------------------\n\n'),
  };
  if (n === 1 && reports[0].contact && isEmail_(reports[0].contact)) mail.replyTo = reports[0].contact;

  MailApp.sendEmail(mail); // si l'envoi échoue, rien n'est supprimé
  doneKeys.forEach(function (k) { props.deleteProperty(k); });
}

/* ================= Helpers ================= */

function validate_(f) {
  if (!f) return { error: 'Formulaire vide.' };
  const L = CONFIG.LIMITS;
  const clean = function (v, max) { return String(v || '').replace(/\u0000/g, '').trim().slice(0, max); };
  const d = {
    entity: clean(f.entity, L.short),
    category: clean(f.category, L.short),
    period: clean(f.period, L.short),
    description: clean(f.description, L.description),
    people: clean(f.people, L.medium),
    evidence: clean(f.evidence, L.medium),
    contact: clean(f.contact, L.contact),
  };
  if (CONFIG.ENTITIES.indexOf(d.entity) === -1) return { error: 'Choisissez l’entité concernée.' };
  if (CONFIG.CATEGORIES.indexOf(d.category) === -1) return { error: 'Choisissez le type de faits.' };
  if (d.description.length < 30) return { error: 'Décrivez les faits en quelques phrases (30 caractères minimum).' };
  if (d.contact && !isEmail_(d.contact)) return { error: 'L’adresse e-mail de contact n’est pas valide.' };
  if (f.goodFaith !== true) return { error: 'Cochez la case de bonne foi pour envoyer le signalement.' };
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

function formatCode_(c) { return c.slice(0, 4) + '-' + c.slice(4); }

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

function row_(label, value) {
  if (!value) return '';
  return '<tr><td style="padding:10px 14px;vertical-align:top;color:#5b4be0;font-weight:bold;width:170px;border-bottom:1px solid #eceaf7">'
    + label + '</td><td style="padding:10px 14px;color:#1f2330;white-space:pre-wrap;border-bottom:1px solid #eceaf7">'
    + esc_(value) + '</td></tr>';
}

function buildHtml_(d) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;max-width:720px">'
    + '<p style="font-size:18px;font-weight:bold;color:#1f2330;margin:0 0 4px">Signalement ' + esc_(d.ref) + '</p>'
    + '<p style="color:#4a4f5a;margin:0 0 16px">Déposé le ' + esc_(d.day) + '. '
    + (d.contact ? 'L’auteur a laissé un moyen de contact.' : 'Signalement anonyme, sans moyen de contact.') + '</p>'
    + '<table style="border-collapse:collapse;width:100%;background:#f9f8ff">'
    + row_('Entité concernée', d.entity)
    + row_('Type de faits', d.category)
    + row_('Période des faits', d.period)
    + row_('Description', d.description)
    + row_('Personnes impliquées', d.people)
    + row_('Éléments disponibles', d.evidence)
    + row_('Contact de l’auteur', d.contact)
    + '</table></div>';
}

function footerHtml_() {
  return '<p style="font-family:Arial,Helvetica,sans-serif;color:#9aa0ab;font-size:12px;margin-top:24px">'
    + 'Rappel : accusé de réception sous 7 jours et retour sous 3 mois lorsque l’auteur a laissé un contact. '
    + 'Ne transférez pas ce message hors des personnes habilitées à traiter les signalements.</p>';
}

function buildText_(d) {
  return [
    'Signalement ' + d.ref + ' (déposé le ' + d.day + ')',
    '',
    'Entité concernée : ' + d.entity,
    'Type de faits : ' + d.category,
    d.period ? 'Période des faits : ' + d.period : '',
    '',
    'Description :', d.description, '',
    d.people ? 'Personnes impliquées :\n' + d.people + '\n' : '',
    d.evidence ? 'Éléments disponibles :\n' + d.evidence + '\n' : '',
    d.contact ? 'Contact de l’auteur : ' + d.contact : 'Signalement anonyme, sans contact.',
  ].join('\n');
}
