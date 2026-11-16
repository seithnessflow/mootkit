# Mootkit

Un kit pour [Claude Code](https://code.claude.com/docs) qui répartit le travail entre des rôles de sous-agents, chacun avec son modèle et son effort, pour mieux travailler et moins dépenser de tokens.

## Ce que fait Mootkit

- La session principale garde le dialogue et les décisions ; elle délègue la lecture, la recherche, l'exécution et la relecture à neuf rôles de sous-agents.
- Chaque rôle a un modèle et un effort fixés par un profil (eco, normal ou max), choisi à chaque démarrage selon le rythme de consommation de la limite hebdomadaire.
- Un travail qui dépasse une certaine taille est relu par des agents qui ne l'ont pas écrit, puis chaque point relevé est vérifié dans le code.
- Des hooks rappellent les règles au bon moment (lecture longue, rapport en retard) et notent la télémétrie de chaque agent, sans jamais bloquer une action.
- Le `CLAUDE.md` pose un contrat d'honnêteté, protège le travail non commité et demande un rapport écrit à la fin de chaque tâche.

On prompte en langage libre : Mootkit ne demande aucune commande, aucun mot-clé, aucun format de demande. Les règles, les gabarits et les messages sont écrits en français.

## Rôles et profils

<!-- table des rôles : générée par outils/synchroniser.js depuis profils/profils.json, ne pas retoucher -->
| Rôle | eco | normal | max | Pour quoi |
|---|---|---|---|---|
| scout | haiku low | haiku medium | sonnet medium | localiser du code, lire et résumer beaucoup de code ou de logs |
| verifier | haiku medium | haiku high | sonnet medium | vérifier dans le code chaque point d'un relecteur |
| researcher | sonnet medium | fable low | fable medium | documentation et recherche web, avec ses sources |
| reviewer-tests | sonnet medium | sonnet high | opus medium | relire un diff sous l'angle des tests uniquement |
| reviewer-securite | sonnet medium | opus medium | opus high | relire un diff sous l'angle sécurité et actions irréversibles uniquement |
| analyste | sonnet medium | sonnet high | opus high | juger du contenu qui n'est pas du code (images, captures, vidéo, textes, sorties de modèles, données), avec un avis argumenté |
| worker | sonnet medium | opus medium | opus high | exécuter une tâche cadrée, tests d'abord |
| architect | opus high | fable medium | fable high | relecture finale contre la demande mot pour mot ; débogage quand la même erreur survit à 2 tentatives |
| conseil | opus medium | fable medium | fable xhigh | regard extérieur à la demande de l'utilisateur : bilan du kit, avis sur une décision ou un cadrage |
<!-- fin de la table des rôles -->

Les modèles et efforts viennent de `profils/profils.json`. Les fichiers `agents/*.md` sont générés à partir de `profils/gabarits/` par `hooks/profil.js` : on retouche les gabarits, jamais les fichiers générés.

Le profil se choisit au démarrage de chaque session (hook `SessionStart`) d'après le rythme : la part de la limite hebdomadaire consommée, rapportée à la part de la semaine écoulée. Rythme sous 0,5 : max ; de 0,5 à 0,9 : normal ; au-delà : eco ; pas de donnée : normal. Le profil ne change pas en cours de session.

On peut forcer un profil en le demandant en langage libre (« passe en eco », « mets le max », « reviens en automatique ») ; la session lance alors `node ~/.claude/hooks/profil.js force eco|normal|max` ou `node ~/.claude/hooks/profil.js auto`.

## Prérequis

- **Windows 11.** Mootkit est **testé uniquement sous Windows**.
- **PowerShell 7** (`pwsh`) et **Git for Windows** (Git Bash) : Claude Code lance les hooks par Git Bash sous Windows, et `git` sert à la relecture.
- **Node.js** : testé avec Node 24 ; aucune version plus ancienne n'a été essayée.
- **Claude Code : testé avec Claude Code 2.1.325 ; version minimale non déterminée.**
- **Un forfait claude.ai donnant accès à Fable** pour les profils normal et max (researcher, architect, conseil). Sans Fable, voir plus bas.
- **Codex CLI, facultatif** : la skill de relecture l'appelle en plus quand le diff dépasse 400 lignes, quand la tâche touche à la sécurité, ou sur demande. **Le diff et les fichiers de la tâche partent alors chez OpenAI par Codex**, même sans demande explicite, secrets masqués au mieux. Si Codex est installé et connecté, c'est automatique : ne le connectez pas si votre code ne doit pas sortir. Sans lui, la relecture le dit et continue sans.

## Installation

1. **Sauvegardez votre `~/.claude` existant**, en entier, avant toute chose. Dans PowerShell 7 :
   ```powershell
   Copy-Item -Recurse "$HOME\.claude" "$HOME\.claude.sauvegarde-$(Get-Date -Format yyyy-MM-dd_HHmm)"
   ```
2. Récupérez Mootkit dans un dossier à part (par exemple `$HOME\mootkit`).
3. Copiez dans `~/.claude` : `CLAUDE.md`, `profils/`, `hooks/`, `skills/relecture/`, `bench/` et `settings.exemple.json`. Si vous avez déjà un `CLAUDE.md` ou des skills à vous, fusionnez à la main au lieu d'écraser.
4. **Réglages.** Fusionnez `settings.exemple.json` dans votre `~/.claude/settings.json` : ses blocs `hooks`, `statusLine` et `permissions.deny`. Ne remplacez pas votre fichier : il contient sans doute d'autres réglages (modèle, `env`, plugins). Les commandes y sont écrites `node "$HOME/.claude/hooks/…"`.
5. **Dossier des rapports.** Les rapports de fin de tâche vont dans `$HOME\Claude\rapports` ; pour un autre dossier, définissez la variable d'environnement `KIT_RAPPORTS` (lue par `hooks/rappels.js`) et `TELEMETRIE_RAPPORTS` (lue par `hooks/telemetrie.js`) avec la même valeur. Ajoutez ce dossier aux `permissions.additionalDirectories` de vos réglages si Claude Code doit y écrire sans demander.
6. **Générez les agents** une première fois :
   ```powershell
   node "$HOME/.claude/hooks/profil.js" genere normal
   ```
   Ensuite, le hook `SessionStart` les régénère seul à chaque démarrage.
7. **Vérifiez** en lançant les suites de tests depuis `~/.claude` :
   ```powershell
   foreach ($t in "hooks/docs-test.js","hooks/profil-test.js","hooks/rappels-test.js","hooks/statusline-test.js","hooks/telemetrie-test.js","skills/relecture/codex-test.js") { node $t > $null; "$t : code $LASTEXITCODE" }
   ```
   Chaque suite rend le code 0 si tout passe. Elles travaillent dans des dossiers temporaires.
8. Facultatif : `git -C ~/.claude config core.hooksPath bench/git-hooks` active un pre-commit qui relance les tests, si votre `~/.claude` est un dépôt git.

## Sans Fable, sans ligne de statut

- **Sans Fable** : demandez-le en langage libre (« sans Fable », « coupe Fable »). La session lance `node ~/.claude/hooks/profil.js fable coupe` : dans le profil actif, chaque rôle prévu sur Fable passe sur Opus au même effort. « Fable autorisé » le rétablit (`fable autorise`). Le réglage vaut pour toutes les sessions jusqu'au retour. Le profil eco n'utilise jamais Fable.
- **Sans la ligne de statut** : Claude Code ne transmet l'usage du forfait (`rate_limits`) qu'au script de ligne de statut. `bench/statusline.js` l'écrit dans `~/.claude/logs/`, où `profil.js` le relit. Sans cette ligne de statut configurée, il n'y a pas de donnée, et Mootkit reste en **profil normal fixe**. Le forçage manuel reste possible.

## Limites connues

- **Profil annoncé différent du profil servi quand une autre session est ouverte** (correction en cours). Le changement de profil est différé tant qu'une autre session tourne, et le profil annoncé au démarrage peut ne pas être celui des agents effectivement servis.
- **Chemins des hooks non testés sur une autre machine.** La forme `$HOME/.claude/…` a été essayée en lançant la commande par Git Bash depuis un script, pas par le lanceur de hooks de Claude Code lui-même, et seulement sur la machine de l'auteur.
- **Dossier de configuration déplacé non pris en charge** : les scripts lisent `~/.claude` (ou `KIT_HOME`), pas `CLAUDE_CONFIG_DIR`.
- **Deux variables pour un même dossier de rapports** : `KIT_RAPPORTS` et `TELEMETRIE_RAPPORTS`, à régler ensemble.
- **`rate_limits`** n'arrive que pour les abonnés claude.ai et seulement après la première réponse de l'API : la première session d'une semaine peut démarrer sans donnée, donc en normal.
- **Tests sautés hors du dépôt d'origine** : la non-régression v4 de `profil-test.js` demande un commit de l'historique privé de l'auteur, absent ici (le cas est signalé « SKIP ») ; le cas du lien symbolique de `codex-test.js` est sauté si Windows refuse de créer un lien (sans mode développeur).
- Le pre-commit contrôle `settings.exemple.json` (au moins 156 règles dans `permissions.deny`), pas votre `settings.json`.

## Pour le mainteneur : `outils/synchroniser.js`

La version publique se refait depuis le dernier commit du kit privé : `node outils/synchroniser.js` (source : `MOOTKIT_SOURCE`, par défaut `~/.claude`). Le script lit uniquement par `git show HEAD:…`, copie une liste blanche écrite en tête du fichier, produit `settings.exemple.json`, remplace les chemins personnels, régénère la table des rôles de ce README et liste chaque remplacement. Il ne supprime rien, et n'écrase un fichier modifié ou non commité qu'avec `--ecraser`.

## Licence

MIT, © 2026 seithnessflow. Voir [LICENSE](LICENSE).
