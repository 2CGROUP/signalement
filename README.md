# Dispositif de signalement 2CGroup

Formulaire de signalement interne, anonyme. Ce dépôt est public volontairement : chacun peut vérifier qu’aucune identité n’est collectée.

## Ce que le dispositif reçoit
- Le texte saisi dans le formulaire.
- Le jour d’envoi, sans l’heure.
- Une adresse de contact, uniquement si l’auteur choisit d’en laisser une.

## Ce qu’il ne reçoit jamais
- Le nom ou le compte Google de l’auteur.
- Son adresse IP ou des informations sur son appareil.
- Une copie conservée du formulaire après transmission.

## Comment l’anonymat est garanti
- **Aucune ressource extérieure.** La page (`docs/`) ne charge ni police, ni script, ni service tiers, et aucun outil de statistiques. Une politique de sécurité intégrée à la page interdit toute connexion autre que l’envoi du signalement.
- **Aucun cookie.** Le signalement est envoyé sans cookies ni référent (`credentials: 'omit'` dans `docs/assets/app.js`). Le serveur ne peut pas savoir qui l’envoie, même si la personne est connectée à un compte Google dans son navigateur.
- **Aucune lecture d’identité côté serveur.** Le code du serveur (`apps-script/Code.gs`) ne fait aucun appel permettant d’identifier l’utilisateur, et ne journalise aucun contenu.
- **Aucune horodatation précise.** Les signalements sont regroupés et transmis une fois par jour : l’heure de transmission ne révèle pas l’heure de saisie.
- **Aucun stockage navigateur.** La page n’écrit ni cookie ni donnée locale.

## Contenu du dépôt
| Chemin | Rôle |
|---|---|
| `docs/` | La page du formulaire, publiée par GitHub Pages |
| `docs/assets/config.js` | Adresse du serveur, chiffrée avec le code d’accès |
| `apps-script/Code.gs` | Code du serveur |
| `tools/chiffrer-url.mjs` | Outil de chiffrement de l’adresse du serveur |

## Licences
Polices Newsreader et Public Sans sous licence SIL Open Font License (voir `docs/assets/fonts/`).

