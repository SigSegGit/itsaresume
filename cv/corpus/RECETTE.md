# Recette du corpus : score attendu par offre

Écrit par `node scripts/corpus-check.mjs --sheet` depuis `corpus/*.json` (champ `expected`) ;
un test vérifie qu'il est à jour. Bandes : low 0-34, mid 35-69, high 70-100, pour un
profil SRE / ingénieur de production. `node scripts/corpus-check.mjs <run>` compare un run.

| offre | bande | score attendu |
| --- | --- | --- |
| en-cloud-architect | mid | 35-75 |
| en-devsecops | mid | 35-75 |
| en-platform-startup | high | 60-100 |
| en-sre-fintech | high | 60-100 |
| fr-admin-sys-public | high | 55-100 |
| fr-devops-esn | high | 60-100 |
| fr-ingenieur-data-platform | mid | 35-75 |
| fr-itfar-dev-cobol-db2 | low | 0-30 |
| fr-itfar-dev-fullstack-junior | low | 0-35 |
| fr-itfar-dev-php-legacy | low | 0-30 |
| fr-itfar-support-helpdesk-n1 | low | 0-35 |
| fr-mid-chef-projet-infrastructure | mid | 25-60 |
| fr-mid-dba-postgresql | mid | 35-70 |
| fr-mid-ingenieur-reseau | mid | 20-55 |
| fr-near-architecte-cloud-fintech | mid | 40-75 |
| fr-near-devops-kubernetes-retail | high | 60-100 |
| fr-near-directeur-plateforme-ecommerce | mid | 30-70 |
| fr-near-ingenieur-production-assurance | high | 60-100 |
| fr-near-ingenieur-production-sre-paiement | high | 65-100 |
| fr-offtrack-agent-entretien-medical | low | 0-15 |
| fr-offtrack-architecte-dplg | low | 0-20 |
| fr-offtrack-architecte-interieur | low | 0-20 |
| fr-offtrack-charge-rh | low | 0-20 |
| fr-offtrack-chauffeur-livreur | low | 0-15 |
| fr-offtrack-chef-projet-mariages | low | 0-20 |
| fr-offtrack-commercial-bien-etre-adulte | low | 0-20 |
| fr-offtrack-directeur-agence-bancaire | low | 0-20 |
| fr-offtrack-electricien-tertiaire | low | 0-20 |
| fr-offtrack-facteur | low | 0-15 |
| fr-offtrack-frigoriste-pac | low | 0-20 |
| fr-offtrack-gardien-refuge | low | 0-15 |
| fr-offtrack-jardinier | low | 0-20 |
| fr-offtrack-plombier-chauffagiste | low | 0-20 |
| fr-offtrack-vendeur-kitesurf | low | 0-15 |
| fr-sre-banque | high | 60-100 |
