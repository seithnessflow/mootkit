#!/usr/bin/env node
// Relecture par Codex (autre famille de modèles), en lecture seule, pour la procédure de relecture.
// Usage, depuis le dossier du projet :  node ~/.claude/skills/relecture/codex.js <base> [fichier-de-la-demande] [-- <fichiers de la tâche>]
// Relit `git diff --no-renames <base>` (arbre de travail compris), un diff par fichier : noms lus par -z (exacts), sensibles écartés avant toute lecture de leur diff, un renommage = suppression + ajout sous le nouveau nom
// et les fichiers listés après `--`, même non suivis (jamais : hors dépôt, dossier, lien, .git, sensible ; un fichier ignoré par git ne part que s'il est code ou doc : .py .js .ts .tsx .gd .rs .ps1 .sh .toml .html .css .md .txt .rst). Plus de 150 Ko : plusieurs
// envois, 4 au plus, chacun relu à part (l'en-tête dit à Codex de relire tout de suite, sans attendre les autres) ; un envoi qui revient sans relecture repart seul UNE fois (relance, même lancement) ; un fichier listé non suivi qui dépasse un envoi est découpé en plages de lignes identifiées (chemin et numéros de lignes), réparties entre les
// envois ; ce qui ne part pas est nommé, la relecture est « partielle ». Sans `--` la liste n'a pas été fournie : « partielle » au mieux, jamais « RAS ».
// Rien de la tâche à envoyer : Codex n'est pas appelé (pas même son login), relecture « non effectuée » avec la raison.
// Réponses brutes dans ~/.claude/logs/codex/ ; points fusionnés et taille envoyée sur la sortie standard. Code 0 dans tous les cas : sans Codex, « CODEX INDISPONIBLE : <raison> ».
// Codex ne touche pas au disque : son bac à sable Windows tourne sous un autre compte qui ne lit pas les projets
// (constaté le 2026-10-20, CLI 0.163.0). Il reçoit tout dans son prompt : demande, diff, fichiers modifiés.
// Fichiers sensibles jamais envoyés, secrets masqués (filtre par motifs : il couvre les formes courantes, pas toutes).
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');

const MAX_PROMPT = 150 * 1024; // octets d'un envoi à Codex au plus (plan à 20 € : usage minimal)
const MAX_ENVOIS = 4; const RESERVE = 8 * 1024; // 4 envois = 600 Ko au plus ; RESERVE : place gardée pour la ligne « non joints »
const MAX_LECTURE = 8 * 1024 * 1024; // un fichier listé plus gros n'est pas lu (refus nommé) ; en dessous, il part en entier ou en plages de lignes
const octets = (s) => Buffer.byteLength(s, 'utf8');
// Sensible = un composant quelconque du chemin est un dossier de secrets, ou porte un nom de fichier de secrets (testé sur chaque composant, dossiers compris ; point ou espace final retirés : Windows les ignore).
// secret* prend aussi lib/secretary.py : refus voulu (un secret parti ne se rattrape pas, un refus coûte une relecture « partielle » nommée).
const DOSSIERS_SENSIBLES = new Set(['secrets', '.ssh', '.aws', '.docker', '.kube', '.gnupg', '.azure']);
const NOM_SENSIBLE = /^(\.env(\..*)?|\.envrc|.*\.env|.*\.(pem|key|p12|pfx|kdbx|tfvars|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials?|\.git-credentials|\.pgpass|\.dev\.vars|\.mcp\.json|config\.local\..*|.*\.local\.json|.*(secret|credential|token|password)s?.*\.(json|ya?ml|txt|ini|toml|cfg|conf|env)|.*service-account.*\.json|auth\.json|\.netrc|\.npmrc|\.pypirc|\.htpasswd|\.secrets?|secrets?.*)$/is;
const sensible = (name) => String(name).split('/').some((c) => [c, c.replace(/[. ]+$/, '')].some((x) => DOSSIERS_SENSIBLES.has(x.toLowerCase()) || NOM_SENSIBLE.test(x)));
// Ignoré par git : ne part que s'il est code ou texte documentaire (liste CODE de la v4, plus .md, .txt, .rst).
const CODE_OU_DOC = /\.(py|js|ts|tsx|gd|rs|ps1|sh|toml|html|css|md|txt|rst)$/i;
const SECRETS = [
  /sk-[A-Za-z0-9_-]{20,}/g, /[sr]k_live_[A-Za-z0-9]{10,}/g, /glpat-[A-Za-z0-9_-]{20,}/g, /AIza[0-9A-Za-z_-]{30,}/g, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, // ... JWT
  /(?<=:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/g, // ://user:motdepasse@hôte : seul le mot de passe est masqué
  /(\bAuthorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/=_-]+/gi, /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g, /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, // sans END : masqué jusqu'à la fin du texte (PEM, PGP)
  /((?:password|passwd|mot de passe|mdp|secret|token|api[_-]?key|secret[_-]?access[_-]?key|_pass|pwd)["']?\s*[:=]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"']{4,})/gi, // ["']? après la clé : JSON
  /(\bBearer\s+)\S+/gi,
  /(sshpass\s+-p\s+)["']?[^\s"']+/gi,
];
const redact = (t) => SECRETS.reduce((s, re) => s.replace(re, (m, pre) => (typeof pre === 'string' && m.startsWith(pre) ? pre : '') + '[MASQUÉ]'), String(t || ''));
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['revue_effectuee', 'raison_si_non_effectuee', 'points'],
  properties: {
    revue_effectuee: { type: 'boolean' }, raison_si_non_effectuee: { type: 'string' },
    points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['gravite', 'fichier', 'ligne', 'probleme', 'scenario', 'correctif'],
      properties: { gravite: { type: 'string', enum: ['CRITIQUE', 'MAJEUR', 'MINEUR'] }, fichier: { type: 'string' }, ligne: { type: 'integer' }, probleme: { type: 'string' }, scenario: { type: 'string' }, correctif: { type: 'string' } } } },
  },
};

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Fichier listé par la session (suivi ou non) : envoyé, sauf s'il est introuvable, un dossier, un lien,
// hors dépôt, dans .git, sensible, ignoré par git sans être code ni doc, au-delà de MAX_LECTURE ou binaire ; refus {name, refus}. Sinon diff « nouveau fichier » fait ici (texte = contenu, pour le découpage
// en plages si le diff ne tient pas dans un envoi). Aucune lecture avant ces contrôles.
function listé(rootReel, f, root) {
  const abs = path.resolve(f); let st; let reel;
  try { st = fs.lstatSync(abs); reel = fs.realpathSync.native(abs); } catch { return { name: f, refus: 'introuvable' }; }
  if (st.isSymbolicLink()) return { name: f, refus: 'lien' };
  if (st.isDirectory()) return { name: f, refus: 'dossier' };
  if (!st.isFile()) return { name: f, refus: 'pas un fichier ordinaire' };
  const rel = path.relative(rootReel, reel);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { name: f, refus: 'hors dépôt' };
  const name = rel.split(path.sep).join('/');
  if (/(^|\/)\.git(\/|$)/.test(name)) return { name, refus: 'dans .git' };
  if (sensible(name)) return { name, refus: 'sensible' };
  const ign = git(['check-ignore', '-q', '--', name], root); // 0 = ignoré, 1 = non ; autre (erreur) : traité comme ignoré, donc code ou doc seulement
  if (ign.status !== 1 && !CODE_OU_DOC.test(name)) return { name, refus: 'ignoré par git, ni code ni doc' };
  if (st.size > MAX_LECTURE) return { name, refus: `trop gros : ${Math.round(st.size / 1024)} Ko, au-delà de ${MAX_LECTURE / 1024 / 1024} Mo, non lu` };
  let t; try { t = fs.readFileSync(abs, 'utf8'); } catch { return { name, refus: 'illisible' }; }
  if (t.includes('\0')) return { name, refus: 'binaire' };
  return { name, nouveau: true, texte: t, p: `diff --git a/${name} b/${name}\nnew file mode 100644 (non suivi)\n--- /dev/null\n+++ b/${name}\n${t.replace(/^/gm, '+')}\n` };
}

// Découpe en envois de MAX_PROMPT octets au plus (MAX_ENVOIS au plus). Un fichier = son diff + son contenu complet, jamais séparés : même envoi.
// Ne tient pas avec son contenu : part avec son seul diff, contenu nommé. Ne tient pas seul, ou plus de place : nommé dans cut, rien de lui n'est envoyé ni tronqué.
// Exception : un fichier listé non suivi qui ne tient pas seul est découpé en plages de lignes qui remplissent la place restante des envois (après les autres fichiers,
// pour ne pas les priver de place), 4 envois au plus ; les lignes qui restent sont nommées (plage), une ligne seule plus grosse qu'un envoi aussi.
// liste = null : pas de `--`.
// fixe = octets du prompt hors diff et fichiers.
function material(base, fixe, liste) {
  // Noms exacts (-z), sensibles écartés avant toute lecture de leur diff, puis un diff par nom restant : pas d'appariement par position (un « diff --git » dans le contenu d'un fichier, un typechange à deux blocs ou un sous-module ne le faussent plus).
  // --literal-pathspecs : le nom est un chemin exact, jamais un motif (un fichier nommé « [.]env » ne doit pas lire le diff de « .env »). diff.submodule=short : pas de journal du sous-module (le réglage de l'utilisateur est écarté).
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim(); // les noms de git sont relatifs à la racine : les diffs par nom y tournent aussi
  const G = ['--literal-pathspecs', '-c', 'diff.submodule=short'];
  const nm = git([...G, 'diff', '--no-renames', '-z', '--name-only', base, '--'], root);
  if (nm.status !== 0) throw new Error(`git diff --name-only ${base} : ${nm.stderr.trim()}`);
  const cut = []; const notes = []; const parts = [];
  for (const name of nm.stdout.split('\0').filter(Boolean)) {
    if (sensible(name)) { cut.push(`${name} (sensible)`); continue; }
    const d = git([...G, 'diff', '--no-renames', base, '--', name], root);
    if (d.status !== 0) throw new Error(`git diff ${base} -- ${name} : ${d.stderr.trim()}`);
    if (d.stdout) parts.push({ name, p: d.stdout });
  }
  if (liste === null) notes.push('fichiers non suivis : aucun envoyé (aucune liste donnée : pas de « -- » sur la ligne de commande)');
  else {
    const rootReel = fs.realpathSync.native(root); const ls = git(['ls-files', '-z'], root); // suivis : déjà dans le diff, ou inchangés
    if (ls.status !== 0) throw new Error(`git ls-files : ${ls.stderr.trim()}`);
    const suivis = new Set(ls.stdout.split('\0'));
    for (const f of liste) {
      const x = listé(rootReel, f, root);
      if (x.refus) cut.push(`${x.name} (${x.refus})`);
      else if (parts.some((q) => q.name === x.name)) continue; // listé deux fois, ou déjà dans le diff
      else if (suivis.has(x.name)) notes.push(`${x.name} : suivi et inchangé, rien à envoyer`);
      else parts.push(x);
    }
  }
  const cap = MAX_PROMPT - fixe - RESERVE; const unites = []; const gros = [];
  for (const [i, part] of parts.entries()) {
    const { name, p, nouveau: neuf } = part;
    if (sensible(name)) { cut.push(`${name} (sensible)`); continue; } // déjà écarté plus haut : garde-fou
    if (neuf && octets(p) > cap) { gros.push({ i, name, texte: redact(part.texte) }); continue; } // plus qu'un envoi : plages de lignes
    const diff = redact(p); let contenu = ''; let omis = false;
    if (!neuf) try {
      const f = path.join(root, name); const st = fs.lstatSync(f);
      if (st.isFile() && st.size > cap) omis = true;
      else if (st.isFile()) { const t = fs.readFileSync(f, 'utf8'); if (!t.includes('\0')) contenu = `\n--- ${name}\n${redact(t)}`; }
    } catch { /* supprimé ou illisible : le diff seul part */ }
    if (octets(diff) + octets(contenu) > cap) { omis = omis || !!contenu; contenu = ''; }
    const taille = octets(diff) + octets(contenu);
    if (taille > cap) { cut.push(`${name} (trop gros : ${Math.round(taille / 1024)} Ko, ne tient pas dans un envoi)`); continue; }
    unites.push({ i, name, diff, contenu, omis, taille });
  }
  const bacs = []; // les plus gros d'abord, chacun dans le premier envoi où il tient
  for (const u of [...unites].sort((a, b) => b.taille - a.taille)) {
    let bac = bacs.find((b) => b.n + u.taille <= cap);
    if (!bac && bacs.length < MAX_ENVOIS) { bac = { n: 0, us: [] }; bacs.push(bac); }
    if (bac) { bac.n += u.taille; bac.us.push(u); } else cut.push(`${u.name} (au-delà de ${MAX_ENVOIS} envois)`);
  }
  const entete = (name, a, z, tot) => `diff --git a/${name} b/${name}\nnew file mode 100644 (non suivi ; lignes ${a}-${z} sur ${tot})\n--- /dev/null\n+++ b/${name}\n@@ lignes ${a}-${z} @@\n`;
  for (const g of gros) { // plages de lignes dans la place restante des envois, dans l'ordre ; le reste est nommé
    const L = g.texte.split('\n'); if (L[L.length - 1] === '') L.pop(); const tot = L.length; const ovh = octets(entete(g.name, tot, tot, tot)) + 16; let k = 0;
    for (let b = 0; k < tot && b < MAX_ENVOIS; b++) {
      if (!bacs[b]) bacs.push({ n: 0, us: [] });
      for (;;) {
        let z = k; let used = 0; const libre = cap - bacs[b].n - ovh;
        while (z < tot && used + octets(L[z]) + 2 <= libre) { used += octets(L[z]) + 2; z++; }
        if (z > k) { const diff = entete(g.name, k + 1, z, tot) + L.slice(k, z).map((l) => `+${l}\n`).join(''); bacs[b].us.push({ i: g.i, ord: k, name: g.name, label: `${g.name} (lignes ${k + 1}-${z})`, diff, contenu: '', omis: false, taille: octets(diff) }); bacs[b].n += octets(diff); k = z; }
        if (k >= tot) break;
        if (octets(L[k]) + 2 > cap - ovh) { cut.push(`${g.name} (ligne ${k + 1}, trop longue pour un envoi)`); k++; continue; } // seule, elle ne tiendrait dans aucun envoi
        break; // le reste va dans l'envoi suivant
      }
    }
    if (k < tot) cut.push(`${g.name} (lignes ${k + 1}-${tot}, au-delà de ${MAX_ENVOIS} envois)`);
  }
  const vide = !bacs.some((b) => b.us.length); if (!bacs.length) bacs.push({ n: 0, us: [] }); // rien à envoyer : un envoi vide
  const sansContenu = bacs.flatMap((b) => b.us).filter((u) => u.omis).map((u) => u.name);
  if (sansContenu.length) notes.push(`contenu complet non joint (avec son diff, le fichier ne tient pas dans un envoi) : ${sansContenu.join(', ')}`);
  const cuts = [...new Set(cut)]; const liste40 = cuts.length > 40 ? `${cuts.slice(0, 40).join(', ')} et ${cuts.length - 40} autres` : cuts.join(', ');
  const non = cuts.length ? `\n(non joints, trop gros, binaires, sensibles ou hors liste : ${liste40.slice(0, 2500)})\n` : '';
  const envois = bacs.map((b) => { const us = b.us.sort((x, y) => x.i - y.i || (x.ord || 0) - (y.ord || 0)); return { noms: us.map((u) => u.label || u.name), diff: us.map((u) => u.diff).join('') + non, files: us.map((u) => u.contenu).join('') }; });
  return { envois, cut: cuts, sansContenu, notes, vide };
}

// En-tête d'un envoi multiple : chaque envoi se suffit (incident du 2026-11-07 : Codex a répondu « en attente des envois 2/4 à 4/4 » et rien n'a été relu).
const enteteEnvoi = (i, N) => `=== ENVOI ${i}/${N} : seuls les fichiers de cet envoi sont ci-dessous ; les autres partent dans les autres envois. Chaque envoi est relu à part : relis cette partie maintenant, sans attendre les autres envois. Tu ne verras jamais les autres envois dans cette conversation. Ne réponds jamais « en attente » : revue_effectuee: false seulement si tu ne peux pas relire ce qui est ci-dessous. ===`;
const LIGNE_RELANCE = '=== RELANCE : ta réponse précédente n\'était pas une relecture ; relis maintenant ce qui est ci-dessous ===';
const relue = (reponse) => { try { return JSON.parse(reponse).revue_effectuee === true; } catch { return false; } }; // réponse absente, illisible ou revue_effectuee !== true : pas une relecture

function review(base, demande, liste) {
  const tete = [
    'Tu es un relecteur de code d\'une autre famille de modèles que les autres relecteurs : cherche ce qu\'ils pourraient manquer.',
    'Tu ne peux exécuter aucune commande ni lire aucun fichier : tout ce que tu as est ci-dessous. Ne prétends jamais avoir lancé quoi que ce soit.',
    'Rends uniquement le JSON demandé. Un point exige un scénario concret d\'échec construit à partir du code fourni. Une liste vide vaut mieux qu\'une liste gonflée.',
    '', '=== DEMANDE ===', redact(demande), '',
  ].join('\n');
  // fixe compte le plus long en-tête d'envoi possible et la ligne de relance (place réservée hors diff)
  const m = material(base, octets(tete) + 200 + octets(enteteEnvoi(MAX_ENVOIS, MAX_ENVOIS)) + octets(LIGNE_RELANCE), liste); const N = m.envois.length;
  const construire = (e, i, relance) => [tete, ...(N > 1 ? [enteteEnvoi(i + 1, N), ...(relance ? [LIGNE_RELANCE] : [])] : []),
    '=== DIFF ===', e.diff, '', '=== FICHIERS MODIFIÉS ===', e.files].join('\n');
  const prompts = m.envois.map((e, i) => construire(e, i, false));
  for (const p of [...prompts, ...(N > 1 ? m.envois.map((e, i) => construire(e, i, true)) : [])]) if (octets(p) > MAX_PROMPT) throw new Error(`prompt de ${octets(p)} octets, au-delà de ${MAX_PROMPT} : rien envoyé`);
  if (m.vide) return { envois: [], restants: [], cut: m.cut, sansContenu: [], notes: m.notes, sansListe: liste === null, dir: null }; // aucun contenu de la tâche : Codex n'est pas appelé, pas même son login
  const login = spawnSync(`${process.env.RELECTURE_CODEX_BIN || 'codex'} login status`, { shell: true, encoding: 'utf8', timeout: 60000 });
  if (login.status !== 0 || !/logged in/i.test(`${login.stdout}${login.stderr}`)) throw new Error(`codex non connecté (${`${login.stdout}${login.stderr}`.trim().split('\n').pop() || login.status})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relecture-codex-')); // jamais le projet : Codex garde son dossier verrouillé
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(SCHEMA));
  const lancer = (prompt, i, essai) => { // un appel de Codex ; renvoie l'entrée de journal de l'essai
    const t0 = Date.now(); const sortie = path.join(dir, `reponse-${i}-${essai}.json`);
    const r = spawnSync(`${process.env.RELECTURE_CODEX_BIN || 'codex'} exec -s read-only --ephemeral --skip-git-repo-check -C "${dir}" --output-schema "${path.join(dir, 'schema.json')}" -o "${sortie}" -`,
      { input: prompt, cwd: dir, shell: true, encoding: 'utf8', timeout: 15 * 60000, maxBuffer: 64 * 1024 * 1024 });
    let reponse = null;
    try { reponse = fs.readFileSync(sortie, 'utf8'); } catch { /* pas de réponse : la raison est dans stderr */ }
    const erreurs = `${r.stderr || ''}\n${r.stdout || ''}`.split('\n').filter((l) => /^\s*(error|erreur)\b|^\s*\w*Error:/i.test(l)).slice(-5);
    return { fichiers: m.envois[i].noms, ko: +(octets(prompt) / 1024).toFixed(1), secs: Math.round((Date.now() - t0) / 1000), status: r.error ? String(r.error.code || r.error) : r.status, reponse, erreurs };
  };
  const envois = [];
  for (const [i, prompt] of prompts.entries()) {
    let e = { ...lancer(prompt, i, 0), relance: false };
    if (N > 1 && e.reponse && !relue(e.reponse)) { // réponse sans relecture : ce seul envoi repart une fois ; la réponse de la relance remplace la première
      const re = lancer(construire(m.envois[i], i, true), i, 1);
      e = { ...re, ko: +(e.ko + re.ko).toFixed(1), secs: e.secs + re.secs, relance: true, premiere_reponse: e.reponse };
    }
    envois.push(e);
    if (!e.reponse) break; // Codex injoignable ou en échec : les envois suivants ne partent pas, leurs fichiers sont nommés
  }
  return { envois, restants: m.envois.slice(envois.length).flatMap((e) => e.noms), cut: m.cut, sansContenu: m.sansContenu, notes: m.notes, sansListe: liste === null, dir };
}

if (require.main === module) {
  const args = process.argv.slice(2); const sep = args.indexOf('--');
  const [base, demandeFile] = sep < 0 ? args : args.slice(0, sep);
  const liste = sep < 0 ? null : args.slice(sep + 1); // null : pas de `--`, la liste des fichiers de la tâche n'a pas été fournie
  const logDir = path.join(os.homedir(), '.claude', 'logs', 'codex');
  let res;
  try {
    if (!base || !/^[A-Za-z0-9][\w./-]*([~^]\d*)*$/.test(base) || base.includes('..')) throw new Error(base ? `base refusée : ${base} (SHA, branche ou tag attendu)` : 'usage : codex.js <base> [fichier-de-la-demande] [-- <fichiers de la tâche>]');
    res = review(base, demandeFile ? fs.readFileSync(demandeFile, 'utf8') : 'Relis ce diff : bugs, failles, tests manquants.', liste);
  } catch (e) { res = { envois: [], restants: [], cut: [], sansContenu: [], notes: [], sansListe: false, erreurs: [String(e.message || e)] }; }
  const n = res.envois.length; const ko = +res.envois.reduce((s, e) => s + e.ko, 0).toFixed(1);
  const logFile = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const points = []; const lus = []; const indispo = res.erreurs ? [res.erreurs.join(' | ')] : []; const non = [...res.cut, ...res.restants.map((f) => `${f} (envoi non lancé)`)];
  res.envois.forEach((e, i) => {
    let o = null;
    try { o = JSON.parse(e.reponse); } catch { /* réponse absente ou illisible : envoi non relu */ }
    if (o && o.revue_effectuee) { lus.push(...e.fichiers); points.push(...o.points); return; }
    non.push(...e.fichiers.map((f) => `${f} (envoi ${i + 1} non relu${e.relance ? ', relancé une fois' : ''})`));
    indispo.push(`${(o && o.raison_si_non_effectuee) || e.erreurs.join(' | ') || `sortie ${e.status}`}${n > 1 ? ` (envoi ${i + 1}/${n})` : ''}`);
  });
  const envoyes = res.envois.flatMap((e) => e.fichiers); const reste = [...non, ...res.sansContenu.map((f) => `${f} (contenu complet non joint)`), ...(res.sansListe ? ['fichiers non suivis ou ignorés par git (aucune liste donnée : pas de « -- » sur la ligne de commande)'] : [])];
  // « RAS » n'existe que pour « complète » : du contenu de la tâche est parti, Codex a dit revue_effectuee: true, et la liste des fichiers a été fournie (`--`). Sans fichier relu : « non effectuée ».
  const statut = !lus.length ? 'non effectuée' : reste.length ? 'partielle' : 'complète';
  const raison = statut !== 'non effectuée' ? '' : [...indispo, ...(envoyes.length ? [] : [`aucun fichier de la tâche n'est parti (${res.cut.join(', ') || 'diff vide et aucun fichier listé'}) : Codex n'a pas été appelé`])].join(' ; ');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify({ projet: process.cwd(), base, statut, raison, nombre_envois: n, fichiers_envoyes: envoyes, non_envoyes: reste, envoye_ko: ko, points, notes: res.notes, erreurs: res.erreurs, envois: res.envois }, null, 1));
  for (const note of res.notes) console.log(`(${note})`);
  console.log(`(envoyé à Codex : ${ko} Ko en ${n} envoi${n > 1 ? 's' : ''})`);
  for (const l of indispo) console.log(`CODEX INDISPONIBLE : ${l} (réponse brute : ${logFile})`);
  if (lus.length) for (const p of points) console.log(`- [${p.gravite}] ${p.fichier}:${p.ligne} — ${p.probleme} — ${p.scenario} (DÉDUIT, Codex sans exécution) — ${p.correctif}`);
  const nbp = points.length ? `${points.length} point${points.length > 1 ? 's' : ''}` : '';
  console.log(`RELECTURE CODEX : ${{ 'non effectuée': `non effectuée — ${raison}`, partielle: `partielle, non relus : ${reste.join(', ')} ; ${nbp || 'aucun point'} sur le reste`, 'complète': `complète, ${nbp || 'RAS'}` }[statut]}`);
  if (n) console.log(`(Codex, ${res.envois.reduce((s, e) => s + e.secs, 0)} s ; réponses brutes : ${logFile})`);
  try { if (res.dir) fs.rmSync(res.dir, { recursive: true, force: true }); } catch { /* un processus codex résiduel peut garder ce dossier temporaire */ }
  process.exit(0);
}
