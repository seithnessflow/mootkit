#!/usr/bin/env node
// Mootkit : synchronisation de la version publique depuis le dernier commit du kit privé.
//
// Usage : node outils/synchroniser.js
//   Source : le HEAD du dépôt git MOOTKIT_SOURCE (par défaut le dossier de configuration de Claude Code, ~/.claude).
//   Lit uniquement par `git show HEAD:<fichier>` : jamais le dossier de travail, jamais d'écriture dans la source.
//   Cible : le dossier parent de outils/ (la racine de ce dépôt).
// Rejouable : relancé sur le même HEAD, il réécrit exactement les mêmes octets. Il ne supprime rien ; un fichier de la
// cible hors liste dans un dossier géré est seulement signalé. Il n'écrase un fichier de la cible modifié ou non commité
// que si on le relance avec --ecraser.
// Sortie : la liste des fichiers écrits avec leur nombre de lignes, puis chaque remplacement (fichier, ligne, avant, après).
// Code 1 si un fichier de la liste manque à HEAD, ou si un chemin personnel survit au nettoyage.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// ===== LISTE BLANCHE : rien d'autre n'est copié. Une entrée qui finit par /*.md prend les .md suivis de ce dossier à HEAD. =====
const LISTE = [
  'CLAUDE.md',
  'profils/profils.json',
  'profils/gabarits/*.md',
  'hooks/profil.js', 'hooks/profil-test.js',
  'hooks/rappels.js', 'hooks/rappels-test.js',
  'hooks/telemetrie.js', 'hooks/telemetrie-test.js',
  'hooks/docs-test.js',
  'hooks/statusline-test.js',
  'skills/relecture/SKILL.md', 'skills/relecture/codex.js', 'skills/relecture/codex-test.js',
  'bench/statusline.js',
  'bench/git-hooks/pre-commit',
];
// settings.json n'est jamais copié : il devient settings.exemple.json, réduit à hooks, statusLine et permissions.deny.
const SETTINGS_SOURCE = 'settings.json';
const SETTINGS_CIBLE = 'settings.exemple.json';

// ===== REMPLACEMENTS, dans cet ordre. `fichiers` : null pour tous les fichiers produits. =====
// Forme des chemins : "$HOME/.claude/..." est développé par Git Bash comme par PowerShell, les deux shells où Claude Code
// lance hooks et statusLine sous Windows (https://code.claude.com/docs/en/hooks.md, https://code.claude.com/docs/en/statusline.md).
// Le dossier personnel n'est pas écrit ici : il vient de os.homedir() de la personne qui lance le script, barres obliques ou antislashs.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PERSO = os.homedir().split(/[\\/]/).filter(Boolean).map(esc).join('[\\\\/]');
const SEP = '[\\\\/]';
// Les deux remplacements du 17/11 (regex du dossier des rapports dans docs-test.js, « session <projet> <identifiant> ») sont
// retirés le 18/11 : le kit est corrigé à la source (commit 1dd3339) et ils ne trouvaient plus rien à HEAD b8989fa.
const REMPLACEMENTS = [
  { nom: 'dossier des rapports (entre accents graves)', fichiers: null,
    motif: new RegExp(`\`${PERSO}${SEP}Claude${SEP}rapports${SEP}([^\`]*)\``, 'gi'),
    par: (_, reste) => `\`$KIT_RAPPORTS\\${reste}\` (KIT_RAPPORTS par défaut : \`$HOME\\Claude\\rapports\`)` },
  { nom: 'dossier des rapports', fichiers: null,
    motif: new RegExp(`${PERSO}${SEP}Claude${SEP}rapports`, 'gi'), par: () => '$KIT_RAPPORTS' },
  { nom: 'dossier de configuration de Claude Code', fichiers: null,
    motif: new RegExp(`${PERSO}${SEP}\\.claude`, 'gi'), par: () => '$HOME/.claude' },
  { nom: 'settings.json devient settings.exemple.json', fichiers: ['hooks/docs-test.js', 'bench/git-hooks/pre-commit'],
    motif: /\bsettings\.json\b/g, par: () => SETTINGS_CIBLE },
];
// Filet : après remplacement, aucun fichier produit ne contient le dossier personnel, le nom d'utilisateur, ni un chemin sous le dossier Users d'un disque.
const INTERDIT = new RegExp(`${PERSO}|\\b${esc(os.userInfo().username)}\\b|[A-Za-z]:[\\\\/]Users[\\\\/]`, 'i');

// README : la table des rôles est régénérée entre ces deux marqueurs, depuis profils.json (modèles) et la table de CLAUDE.md (« Pour quoi »).
const TABLE_DEBUT = '<!-- table des rôles : générée par outils/synchroniser.js depuis profils/profils.json, ne pas retoucher -->';
const TABLE_FIN = '<!-- fin de la table des rôles -->';

const SOURCE = process.env.MOOTKIT_SOURCE || path.join(os.homedir(), '.claude');
const CIBLE = path.join(__dirname, '..');
const git = (...args) => execFileSync('git', ['-C', SOURCE, ...args], { maxBuffer: 64 * 1024 * 1024 });
const echoue = (msg) => { console.error(`synchroniser : ${msg}`); process.exit(1); };

let head;
try { head = git('rev-parse', 'HEAD').toString().trim(); } catch (e) { echoue(`${SOURCE} n'est pas un dépôt git lisible (${e.message.split('\n')[0]})`); }
const suivis = git('ls-tree', '-r', '--name-only', 'HEAD').toString().split('\n').filter(Boolean);
// Identité git de la source (user.email, user.name) : ajoutée au filet, jamais affichée.
const identite = ['user.email', 'user.name'].map((k) => { try { return git('config', '--get', k).toString().trim(); } catch { return ''; } }).filter(Boolean);
const INTERDIT_GIT = identite.length ? new RegExp(identite.map(esc).join('|'), 'i') : null;
const nomSur = (f) => !/\\|(^|\/)\.\.(\/|$)|^\/|^[A-Za-z]:/.test(f);
const ECRASER = process.argv.includes('--ecraser');

const fichiers = [];
for (const entree of LISTE) {
  if (entree.endsWith('/*.md')) {
    const dossier = entree.slice(0, -'*.md'.length);
    const trouves = suivis.filter((f) => f.startsWith(dossier) && !f.slice(dossier.length).includes('/') && f.endsWith('.md')).sort();
    if (!trouves.length) echoue(`aucun fichier pour ${entree} à HEAD ${head}`);
    fichiers.push(...trouves);
  } else {
    if (!suivis.includes(entree)) echoue(`${entree} absent de HEAD ${head}`);
    fichiers.push(entree);
  }
}

const journal = []; // { fichier, ligne, avant, apres }
const nettoie = (fichier, texte) => texte.split('\n').map((l, i) => {
  let ligne = l;
  for (const r of REMPLACEMENTS) {
    if (r.fichiers && !r.fichiers.includes(fichier)) continue;
    ligne = ligne.replace(r.motif, (...m) => { const apres = r.par(...m); journal.push({ fichier, ligne: i + 1, avant: m[0], apres }); return apres; });
  }
  return ligne;
}).join('\n');

const sortie = {}; // chemin relatif -> texte final
for (const f of fichiers) sortie[f] = nettoie(f, git('show', `HEAD:${f}`).toString('utf8'));

// settings.exemple.json : hooks, statusLine, permissions.deny ; aucun autre bloc (ni env, ni modèle, ni plugins).
let settings;
try { settings = JSON.parse(git('show', `HEAD:${SETTINGS_SOURCE}`).toString('utf8')); } catch (e) { echoue(`${SETTINGS_SOURCE} illisible à HEAD ${head} (${e.message.split('\n')[0]})`); }
const exemple = { hooks: settings.hooks, statusLine: settings.statusLine, permissions: { deny: (settings.permissions || {}).deny } };
if (!exemple.hooks || !exemple.statusLine || !Array.isArray(exemple.permissions.deny)) echoue(`${SETTINGS_SOURCE} : hooks, statusLine ou permissions.deny absent`);
sortie[SETTINGS_CIBLE] = nettoie(SETTINGS_CIBLE, `${JSON.stringify(exemple, null, 2)}\n`);

const restes = Object.entries(sortie).flatMap(([f, t]) => t.split('\n').map((l, i) => (INTERDIT.test(l) || (INTERDIT_GIT && INTERDIT_GIT.test(l)) ? `${f}:${i + 1}` : null)).filter(Boolean));
if (restes.length) echoue(`chemin personnel ou identité git restant après nettoyage, rien n'est écrit : ${restes.join(', ')}`);

// Chaque fichier reste sous la cible ; un fichier qui changerait alors qu'il n'est pas commité tel quel dans la cible n'est remplacé qu'avec --ecraser.
const racine = path.resolve(CIBLE) + path.sep;
const horsCible = Object.keys(sortie).filter((f) => !nomSur(f) || !path.resolve(CIBLE, f).startsWith(racine));
if (horsCible.length) echoue(`nom de fichier refusé (antislash, .., chemin absolu ou hors de la cible), rien n'est écrit : ${horsCible.join(', ')}`);
const propre = (f) => { try { return execFileSync('git', ['-C', CIBLE, 'status', '--porcelain', '--', f]).toString().trim() === ''; } catch { return false; } };
const menaces = Object.entries(sortie).filter(([f, t]) => { const d = path.join(CIBLE, f); return fs.existsSync(d) && fs.readFileSync(d, 'utf8') !== t && !propre(f); }).map(([f]) => f);
if (menaces.length && !ECRASER) echoue(`fichiers modifiés ou non commités dans la cible, qui seraient écrasés ; rien n'est écrit (commitez-les, ou relancez avec --ecraser) : ${menaces.join(', ')}`);

for (const [f, t] of Object.entries(sortie)) {
  const dest = path.join(CIBLE, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, t);
}

// Table des rôles du README.
const readme = path.join(CIBLE, 'README.md');
let tableEcrite = false;
if (fs.existsSync(readme)) {
  const r = fs.readFileSync(readme, 'utf8');
  const a = r.indexOf(TABLE_DEBUT); const b = r.indexOf(TABLE_FIN);
  if (a >= 0 && b > a) {
    const profils = JSON.parse(sortie['profils/profils.json']);
    const pourQuoi = Object.fromEntries(sortie['CLAUDE.md'].split('\n').map((l) => /^\| ([\w-]+) \|(?: [^|]+ \|){3} ([^|]+) \|$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    const roles = Object.keys(profils).filter((k) => !k.startsWith('_'));
    const lignes = ['| Rôle | eco | normal | max | Pour quoi |', '|---|---|---|---|---|', ...roles.map((k) => `| ${k} | ${profils[k].eco} | ${profils[k].normal} | ${profils[k].max} | ${pourQuoi[k] || ''} |`)];
    const neuf = `${r.slice(0, a + TABLE_DEBUT.length)}\n${lignes.join('\n')}\n${r.slice(b)}`;
    if (neuf !== r) fs.writeFileSync(readme, neuf);
    tableEcrite = true;
  }
}

// Fichiers hors liste dans les dossiers gérés : signalés, jamais supprimés.
const geres = [...new Set(Object.keys(sortie).map((f) => path.posix.dirname(f)).filter((d) => d !== '.'))];
const horsListe = geres.flatMap((d) => (fs.existsSync(path.join(CIBLE, d)) ? fs.readdirSync(path.join(CIBLE, d), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${d}/${e.name}`) : []))
  .filter((f) => !(f in sortie) && !(f === 'outils/synchroniser.js'));

console.log(`Mootkit : synchronisé depuis ${SOURCE} à HEAD ${head}`);
for (const [f, t] of Object.entries(sortie)) console.log(`  ${f} : ${t.split('\n').length - (t.endsWith('\n') ? 1 : 0)} lignes`);
console.log(`README.md : table des rôles ${tableEcrite ? 'régénérée' : 'non trouvée (marqueurs absents)'}`);
console.log(`Remplacements (${journal.length}) :`);
for (const j of journal) console.log(`  ${j.fichier}:${j.ligne} : « ${j.avant} » -> « ${j.apres} »`);
if (horsListe.length) console.log(`Hors liste, laissés en place : ${horsListe.join(', ')}`);
