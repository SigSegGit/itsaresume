# Recette manuelle : ce qui se teste à la main

Ce que les tests automatiques ne couvrent pas : un vrai navigateur, un vrai
compte Stripe, une vraie boîte mail, la VM. Chaque fiche : ce qu'il faut,
les étapes, le résultat attendu, quoi noter si ça rate. Cocher la case
quand c'est passé, avec la date.

Conventions : `<domaine>` est ton domaine public, `$DATA` le dossier de
données de la VM (`~/itsacv-data` par défaut). Les commandes PowerShell se
lancent sur le portable, les commandes `bash` sur la VM (en SSH).

---

## 1. L'add-on dans un vrai Chrome (6.2, 6.3) — [ ]

**Il faut** : Chrome ou Edge, une offre ouverte dans un onglet (LinkedIn,
Indeed, n'importe quelle page d'offre).

1. Récupérer l'add-on : GitHub → Actions → le dernier run vert de `main` →
   artefact `itsaresume-addon` → dézipper dans un dossier.
   (Ou, depuis le dépôt :)
   ```powershell
   cd D:\GitHub\itsaresume\cv; node tools/pack-addon.mjs dist
   ```
2. `chrome://extensions` → activer « Mode développeur » → « Charger
   l'extension non empaquetée » → choisir le dossier dézippé.
3. Clic droit sur l'icône → « Options » : indiquer l'adresse de la page
   (`https://cv.<domaine>`), puis importer **un profil de test** (un JSON
   Resume ou un export LinkedIn `.zip`, pas le tien si tu veux tester le
   mode service comme un inconnu).
4. Ouvrir l'offre, cliquer sur l'icône de l'add-on → « Mon CV pour cette
   offre (service) ». (L'autre bouton, « Copier l'offre et ouvrir le
   générateur », ouvre ta propre page avec l'offre collée : à tester aussi.)

**Attendu** : le popup affiche l'avancement, puis un lien vers le PDF. Le PDF
est un CV sur une page, au nom du profil de test, adapté à l'offre.

**Si ça rate** : noter le message du popup, et la console de l'add-on
(`chrome://extensions` → « Inspecter les vues : popup »).

---

## 2. L'impression de la page A4 dans Firefox (2.24) — [ ]

**Il faut** : Firefox, un CV déjà généré.

1. Sur la page d'accueil (locale ou publique), sur la carte d'un CV
   terminé → « Page A4 ».
2. Essayer « Couleurs » (nouveau : Marine, Bordeaux, Forêt, Ardoise,
   Graphite) : les titres et les filets changent de couleur.
3. Cliquer « Imprimer / PDF » → destination « Enregistrer au format PDF »,
   marges « Aucune ».

**Attendu** : une seule page A4, le texte sélectionnable dans le PDF, pas
de bouton ni de barre d'options imprimés, les couleurs choisies présentes.

**Si ça rate** : noter le nombre de pages et ce qui déborde ; joindre le PDF.

---

## 3. La variance de Bionic à température 0 (2.26) — [ ]

**Il faut** : le portable allumé, Bionic lancé avec `temperature = 0`
(fait le 2026-11-24), le routeur local démarré sur ta config Bionic
(`bionic.local.toml`, port 8789), et un dossier de run déjà fait (par
exemple celui de l'offre SRE).

```powershell
cd D:\GitHub\itsaresume\cv; node $HOME\.itsaresume\migrations\variance.mjs $HOME\.itsaresume\out\<dossier-du-run> 5
```

**Attendu** : 5 listings puis 5 analyses de la même offre ; noter les scores.
Avec Sonnet (2026-10-13) l'écart était d'environ 6 points, surtout dans le
listing. À température 0, Bionic devrait donner des scores identiques ou
presque.

**À rapporter** : les 5 scores et le nombre de lignes du listing à chaque
passage (ou la sortie complète du script).

---

## 4. Un CV gratuit pour une personne rencontrée sur LinkedIn — [ ]

Le parcours de ta prospection : un lien d'invitation par personne, elle
génère son CV, elle donne son avis, tu le lis.

1. Créer le lien sur la VM (un libellé par personne, sans données
   sensibles : un prénom et une initiale suffisent) :
   ```bash
   cd ~/itsaresume/cv/deploy/vm-generator && docker compose exec generator node bin/itsacv.js invite "Prénom N." --out /data/out --public-host "$CV_HOST"
   ```
   La commande affiche `https://cv.<domaine>/?i=<code>` : c'est ce lien
   que tu envoies.
2. Ouvrir toi-même le lien dans une fenêtre privée. Onglet « Mon propre
   profil » : joindre un profil **de test** (export LinkedIn `.zip`, ancien
   CV `.pdf`/`.docx`, ou JSON Resume), coller une offre, générer. (L'onglet
   « CV de … » génère ton CV à toi, pour un recruteur.)

   Pour la personne contactée : son export LinkedIn se demande dans
   LinkedIn → Préférences → Confidentialité des données → « Obtenir une
   copie de vos données » ; un ancien CV en PDF suffit aussi. Rien n'est
   gardé : le CV est servi puis effacé au bout de 30 minutes.
3. Sur la carte du CV terminé : « Votre avis sur ce CV » → une note, un
   commentaire → « Envoyer mon avis ».

**Attendu** : « Merci pour votre avis ! » ; sur la VM, une ligne de plus
dans le fichier des avis, avec le libellé de l'invitation :
```bash
tail -n 3 $DATA/out/feedback.jsonl
```
Pour lire les avis, par personne (note moyenne, puis chaque commentaire) :
```bash
cd ~/itsaresume/cv/deploy/vm-generator && docker compose exec generator node bin/itsacv.js invite --feedback --out /data/out
```
Pour voir la consommation par personne :
```bash
cd ~/itsaresume/cv/deploy/vm-generator && docker compose exec generator node bin/itsacv.js invite --usage --out /data/out
```
Pour couper un lien : `... invite --revoke "Prénom N." --out /data/out`.

Rappel (ta décision du 2026-11-24) : ces CV gratuits passent par ton
abonnement Claude, pas par une API payante ; l'API viendra quand tu
vendras.

---

## 5. Le paiement Stripe en mode test (6.12, 6.14) — [ ]

**Il faut** : un compte Stripe (mode test, aucune vérification exigée),
la VM.

1. Dans le tableau de bord Stripe, mode **Test** : Développeurs → Clés API
   → copier la clé secrète `sk_test_…`.
2. Développeurs → Webhooks → « Ajouter un endpoint » :
   `https://cv.<domaine>/premium/api/stripe/webhook`, événements
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `charge.refunded`. Copier le secret de
   signature `whsec_…`.
3. Sur la VM, les ajouter **à la main** dans `$DATA/.env` (jamais dans le
   dépôt), puis relancer :
   ```bash
   nano $DATA/.env    # STRIPE_SECRET_KEY=sk_test_...  et  STRIPE_WEBHOOK_SECRET=whsec_...
   cd ~/itsaresume/cv/deploy/vm-generator && docker compose up -d premium
   ```
4. Sur `https://cv.<domaine>/premium/` : créer un compte, choisir un lot →
   « Payer par carte ». Carte de test `4242 4242 4242 4242`, date future
   quelconque, CVC quelconque.
5. Retour sur le site : la page attend, puis affiche les crédits.
6. « Mes commandes » : la commande apparaît, « Reçu » télécharge un reçu.
7. Dans Stripe → Paiements → ce paiement → « Rembourser » (montant total).

**Attendu** : après l'étape 5, crédits = taille du lot ; après l'étape 7,
crédits repris et la commande marquée « remboursée » ; dans la page admin,
une ligne de journal `stripe`.

**Si ça rate** : Stripe → Webhooks → l'endpoint → onglet des tentatives :
noter le code HTTP et la réponse.

---

## 6. L'envoi des mails par SMTP (6.11) — [ ]

**Il faut** : un compte SMTP (celui de ton hébergeur mail, ou un service
d'envoi), son adresse d'expéditeur.

1. Dans `$DATA/.env` sur la VM :
   ```
   PREMIUM_SMTP_URL=smtps://utilisateur:motdepasse@smtp.fournisseur.tld
   PREMIUM_MAIL_FROM=itsaresume <noreply@<domaine>>
   ```
   puis `docker compose up -d premium`.
2. Créer un compte premium avec une adresse que tu lis.

**Attendu** : un mail « confirmez votre adresse » arrive ; le lien ouvre la
page et confirme l'adresse. « Mot de passe oublié » envoie aussi un lien.

**Si ça rate** : `docker compose logs premium | tail -n 30`, noter la
ligne `SMTP …`.

---

## 7. La copie des sauvegardes premium par ITSaNAS (6.4g) — [ ]

**Il faut** : la flotte ITSaNAS en place sur la VM, une deuxième machine
du compte.

1. Sur la VM :
   ```bash
   bash ~/itsaresume/cv/deploy/vm-generator/itsanas-premium.sh
   ```
   Tu tapes la phrase de passe et tu notes les 24 mots toi-même (le script
   ne les écrit nulle part).
2. Sur une autre machine du compte `itsaresume`, une fois la copie
   synchronisée :
   ```powershell
   cd D:\GitHub\itsaresume\cv; node premium/restore-check.js <chemin\premium-AAAAMMJJHH.db>
   ```

**Attendu** : `restore-check` affiche les comptes et finit sur « ok »
(code de sortie 0). Cocher alors 6.4g dans le handover.

---

## 8. Le suivi de tes candidatures — [ ]

**Il faut** : ta page locale (`itsacv serve`), quelques CV déjà générés.

1. Carte « Mes candidatures » : chaque CV généré y est, le plus récent en
   haut, « À envoyer ».
2. Passer un CV à « Envoyée », écrire une remarque (« via LinkedIn »),
   cliquer ailleurs.
3. Recharger la page.

**Attendu** : le statut et la remarque sont toujours là ; la ligne
« Envoyées par semaine » compte 1 cette semaine ; le filtre « Envoyée »
ne montre que celle-ci ; « Exporter en CSV » télécharge
`candidatures.csv` (s'ouvre dans Excel).

---

## Après la recette

Me donner, pour chaque fiche : passée / ratée + ce qui a été noté. Une
fiche ratée devient une étape du handover, avec un test.
