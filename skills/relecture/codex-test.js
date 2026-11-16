#!/usr/bin/env node
// Test de skills/relecture/codex.js avec un faux Codex qui enregistre le prompt reçu, dans des dépôts temporaires
// (USERPROFILE et HOME aussi temporaires : rien n'est écrit dans ~/.claude/logs). Code 1 si un cas échoue.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
const CODEX = path.join(__dirname, 'codex.js'); const FAKE = path.join(tmp, 'faux-codex.js'); const DUMP = path.join(tmp, 'prompt.txt');
fs.writeFileSync(FAKE, `const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DUMP + '.appels', a[0] + '\\n'); if (a[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let p = ''; process.stdin.on('data', (d) => { p += d; }).on('end', () => { let n = 0; while (fs.existsSync(process.env.FAKE_DUMP + '.' + n)) n++; fs.writeFileSync(process.env.FAKE_DUMP + '.' + n, p);
  if (process.env.FAKE_FAIL_N === String(n)) { console.error('Error: panne simulee sur l\\'envoi ' + n); process.exit(2); } // FAKE_FAIL_N : l'envoi N (depuis 0) échoue, sans réponse
  const mE = /=== ENVOI (\\d+)\\/(\\d+)/.exec(p); const relance = p.includes('ta réponse précédente n\\'était pas une relecture'); // numéro d'envoi lu dans le prompt, relance détectée par sa ligne
  const attente = !!mE && (process.env.FAKE_ATTENTE_ENVOI === mE[1] || (process.env.FAKE_ATTENTE_UNE_FOIS === mE[1] && !relance)); // FAKE_ATTENTE_ENVOI=k : l'envoi k répond « en attente » à chaque essai ; FAKE_ATTENTE_UNE_FOIS=k : au premier essai seulement
  const non = process.env.FAKE_REVUE === 'non' || process.env.FAKE_FALSE_N === String(n) || attente; // FAKE_FALSE_N : l'appel N répond revue_effectuee: false
  const pts = process.env.FAKE_POINTS ? [{ gravite: 'MINEUR', fichier: 'envoi-' + n + '.js', ligne: 1, probleme: 'P' + n, scenario: 's', correctif: 'c' }] : [];
  fs.writeFileSync(a[a.indexOf('-o') + 1], process.env.FAKE_ILLISIBLE_N === String(n) ? 'Revue en attente, pas de JSON {' : JSON.stringify({ revue_effectuee: !non, raison_si_non_effectuee: attente ? 'Envoi ' + mE[1] + '/' + mE[2] + ' reçu. Les fichiers ne sont pas encore fournis ; revue en attente des envois suivants.' : non ? 'RAISON_CODEX' : '', points: pts })); });\n`);
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const w = (dir, name, txt) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), txt); };
const remplir = (motif, ko) => `// ${motif}\n${`// ${'x'.repeat(60)}\n`.repeat(Math.ceil((ko * 1024) / 64))}`;
function depot(nom, suivis) { // dépôt avec un commit de base ; renvoie son chemin
  const d = path.join(tmp, nom); fs.mkdirSync(d); git(d, 'init', '-q');
  for (const [f, t] of Object.entries(suivis)) w(d, f, t);
  git(d, 'add', '.'); git(d, 'commit', '-qm', 'base'); return d;
}
function codex(cwd, args, demande = 'Relis.', env = {}) { // lance codex.js ; renvoie sa sortie, le premier prompt reçu (p, null si rien envoyé), tous les envois (envois) et leur concaténation (all)
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('prompt.txt.')) fs.rmSync(path.join(tmp, f)); const dem = path.join(tmp, 'demande.txt'); fs.writeFileSync(dem, demande);
  const [base, ...reste] = args;
  const r = spawnSync(process.execPath, [CODEX, base, dem, ...reste], { cwd, encoding: 'utf8',
    env: { ...process.env, USERPROFILE: tmp, HOME: tmp, FAKE_DUMP: DUMP, RELECTURE_CODEX_BIN: `node "${FAKE}"`, ...env } });
  const envois = []; for (let n = 0; fs.existsSync(`${DUMP}.${n}`); n++) envois.push(fs.readFileSync(`${DUMP}.${n}`, 'utf8'));
  const appels = fs.existsSync(`${DUMP}.appels`) ? fs.readFileSync(`${DUMP}.appels`, 'utf8').split('\n').filter(Boolean).length : 0; // appels du faux Codex, login compris
  return { out: `${r.stdout}${r.stderr}`, appels, p: envois.length ? envois[0] : null, envois, all: envois.join('\n') };
}
let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : ${String(got).slice(0, 400)}`}`); if (!ok) fail = 1; };
const has = (p, s) => p !== null && p.includes(s);
const jok = (fn) => { try { return !!fn(journal()); } catch { return false; } }; // un champ manquant du journal = échec du cas, pas plantage
const journal = () => { const d = path.join(tmp, '.claude', 'logs', 'codex'); const fs2 = fs.readdirSync(d).sort(); return JSON.parse(fs.readFileSync(path.join(d, fs2[fs2.length - 1]), 'utf8')); }; // dernier journal écrit

// Dépôt 1 : un fichier suivi modifié, des non suivis de toutes sortes.
const A = depot('a', { 'calc.js': 'const a = 1;\n', '.gitignore': 'ignore.js\n' });
w(A, 'calc.js', 'const a = 2;\n');
w(A, 'lib/moyenne.js', 'for (let i = 0; i <= xs.length; i++) s += xs[i];\nconst api_key = "abcd1234efgh5678";\n');
w(A, 'lib/autre.js', 'AUTRE_NON_LISTE\n'); w(A, 'lib/notes.md', 'NOTE_MD\n'); w(A, 'ignore.js', 'IGNORE_MOI\n');
w(A, 'conf/x_secret.toml', 'SECRET_TOML = 1\n'); w(A, 'sous/rien.txt', 'ok\n');
let r = codex(A, ['HEAD']);
check('sans liste : diff suivi envoyé, aucun non suivi, la sortie le dit', has(r.p, '+++ b/calc.js') && !has(r.p, 'i <= xs') && /aucune liste/.test(r.out), r.out);
check('taille envoyée affichée en Ko', /envoyé à Codex : [\d.]+ Ko/.test(r.out), r.out);
r = codex(path.join(A, 'sous'), ['HEAD', '--', path.join(A, 'lib/moyenne.js'), '../lib/notes.md', '../ignore.js', '../lib', '../conf/x_secret.toml']);
check('fichier listé (chemin absolu, depuis un sous-dossier) : envoyé', has(r.p, '+++ b/lib/moyenne.js') && has(r.p, 'i <= xs'), r.p);
check('fichier non suivi absent de la liste : pas envoyé', !has(r.p, 'AUTRE_NON_LISTE'), r.p);
check('.md listé (non-code) : envoyé comme les autres', has(r.p, '+++ b/lib/notes.md') && has(r.p, 'NOTE_MD'), r.p);
check('fichier ignoré par git listé : envoyé ; dossier listé : refusé, nommé « dossier »', has(r.p, '+++ b/ignore.js') && has(r.p, 'IGNORE_MOI') && has(r.p, 'lib (dossier)'), r.p);
check('x_secret.toml listé (code et sensible) : pas envoyé, nommé « sensible »', !has(r.p, 'SECRET_TOML') && has(r.p, 'conf/x_secret.toml (sensible)'), r.p);
check('secret dans un fichier listé : masqué', !has(r.p, 'abcd1234efgh5678') && has(r.p, '[MASQUÉ]'), r.p);
// C8 : tout ce qui sort du dépôt, les dossiers, les liens et .git sont refusés et nommés, sans être lus.
const dehors = path.join(tmp, 'dehors.js'); w(tmp, 'dehors.js', 'HORS_DEPOT\n'); w(tmp, 'ext/ext.js', 'JONCTION_SECRET\n');
let jonction = true;
try { fs.symlinkSync(path.join(tmp, 'ext'), path.join(A, 'lib', 'jonc'), 'junction'); } catch (e) { jonction = false; console.log(`SKIP jonction : création refusée ici (${e.code}), cas non testé`); }
r = codex(A, ['HEAD', '--', dehors, '../dehors.js', 'lib/jonc', 'lib/jonc/ext.js', '.git/config', 'lib/absent.js']);
check('hors dépôt (chemin absolu, puis ../) : pas lu, nommé « hors dépôt »', !has(r.p, 'HORS_DEPOT') && has(r.p, 'dehors.js (hors dépôt)') && has(r.p, '../dehors.js (hors dépôt)'), r.p);
if (jonction) check('lien (jonction) listé, ou fichier atteint par lui : pas lu, nommé', !has(r.p, 'JONCTION_SECRET') && has(r.p, 'lib/jonc (lien)') && has(r.p, 'lib/jonc/ext.js (hors dépôt'), r.p);
check('.git listé : pas lu, nommé', !has(r.p, 'repositoryformatversion') && has(r.p, '.git/config (dans .git)'), r.p);
check('fichier listé introuvable : nommé', has(r.p, 'lib/absent.js (introuvable)'), r.p);
r = codex(A, ['HEAD', '--', 'ignore.js', 'conf/x_secret.toml']);
check('ignoré listé part ; sensible listé reste refusé', has(r.p, 'IGNORE_MOI') && !has(r.p, 'SECRET_TOML') && has(r.p, 'conf/x_secret.toml (sensible)'), r.p);
for (const base of ['--output=x', '-p', 'HEAD..HEAD', 'a b', 'HEAD;ls']) {
  r = codex(A, [base]);
  check(`base « ${base} » refusée, rien envoyé`, r.p === null && /base refusée/.test(r.out) && !fs.existsSync(path.join(A, 'x')), r.out);
}
r = codex(A, [git(A, 'rev-parse', 'HEAD').stdout.trim()]);
check('base SHA acceptée', has(r.p, '+++ b/calc.js'), r.out);

// Dépôt 2 : diff suivi de ~110 Ko, plus un fichier listé de ~50 Ko : le tout dépasse 150 Ko, donc plusieurs envois.
const B = depot('b', { 'm.js': '// m\n', 'g1.js': '// g1\n', 'g2.js': '// g2\n' });
w(B, 'm.js', '// m modifié\n'); w(B, 'g1.js', remplir('G1', 55)); w(B, 'g2.js', remplir('G2', 55)); w(B, 'liste.js', remplir('LISTE_PLAFOND', 50));
r = codex(B, ['HEAD', '--', 'liste.js']);
check('plafond : prompt de 150 Ko au plus, pour tous les envois', r.envois.length >= 1 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024), r.envois.map((e) => Buffer.byteLength(e)));
check('plafond : chaque envoi fait 150 Ko au plus, il y en a plusieurs', r.envois.length >= 2 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024), r.envois.map((e) => Buffer.byteLength(e)));
check('plafond : le fichier listé qui ne tient pas avec les autres part dans un autre envoi, rien n\'est omis', has(r.all, 'LISTE_PLAFOND') && !/non joints/.test(r.all), r.out);
check('diff de plus de 100 Ko : contenu complet joint, dans le même envoi que le diff du fichier', ['m.js', 'g1.js', 'g2.js'].every((n) => r.envois.filter((e) => has(e, `+++ b/${n}`) && has(e, `\n--- ${n}\n`)).length === 1) && !/non joint/.test(r.out), r.out);

// Dépôt 3 : a.js (40 Ko, petite modification) et b.js (112 Ko, réécrit : diff et contenu ne tiennent pas dans un même envoi).
const C = depot('c', { 'a.js': remplir('A', 40), 'b.js': '// b\n' });
fs.appendFileSync(path.join(C, 'a.js'), 'const MODIF = 1;\n'); w(C, 'b.js', remplir('B_GROS', 112));
r = codex(C, ['HEAD']);
check('fichier dont diff + contenu dépassent un envoi : diff seul, contenu non joint nommé ; l\'autre garde son contenu', has(r.all, '\n--- a.js\n') && has(r.all, '+++ b/b.js') && !has(r.all, '\n--- b.js\n') && /contenu complet non joint[^\n]*b\.js/.test(r.out), r.out);
w(C, 'b.js', '// b petit\n'); r = codex(C, ['HEAD']);
check('diff petit : contenu complet joint (témoin)', has(r.p, '--- a.js'), r.out);

// Dépôt 4 : diff de 200 Ko (deux fichiers de 100 Ko vidés) : deux envois, chaque fichier avec son contenu, points fusionnés.
const D = depot('d', { 'd1.js': remplir('D1', 100), 'd2.js': remplir('D2', 100) });
w(D, 'd1.js', '// d1 réduit\n'); w(D, 'd2.js', '// d2 réduit\n');
r = codex(D, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1' }); // C14-E : `--` toujours passé ; sans lui la relecture ne peut pas être « complète »
check('diff de 200 Ko : 2 envois de 150 Ko au plus, chaque fichier une seule fois avec son contenu', r.envois.length === 2 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024)
  && ['d1.js', 'd2.js'].every((n) => r.envois.filter((e) => has(e, `+++ b/${n}`) && has(e, `\n--- ${n}\n// ${n.slice(0, 2)} réduit`)).length === 1), r.envois.map((e) => Buffer.byteLength(e)));
check('2 envois : relecture complète, pas partielle', /RELECTURE CODEX : complète/.test(r.out) && !/partielle/.test(r.out) && /2 envois/.test(r.out), r.out);
check('journal : liste des fichiers envoyés, nombre d\'envois, statut', jok((j) => j.nombre_envois === 2 && [...j.fichiers_envoyes].sort().join() === 'd1.js,d2.js' && j.statut === 'complète' && j.non_envoyes.length === 0), JSON.stringify(journal()).slice(0, 300));
check('points des envois fusionnés dans une seule réponse', /envoi-0\.js:1 — P0/.test(r.out) && /envoi-1\.js:1 — P1/.test(r.out) && r.out.split('(Codex,').length === 2 && !/RAS/.test(r.out), r.out);

// Dépôt 5 : 700 Ko offerts (sept fichiers listés de 100 Ko) : 4 envois au plus, les 3 derniers fichiers nommés, relecture partielle.
const E = depot('e', { 's.js': '// s\n' }); w(E, 's.js', '// s modifié\n');
for (let i = 1; i <= 7; i++) w(E, `u${i}.js`, remplir(`U${i}`, 100));
r = codex(E, ['HEAD', '--', ...[1, 2, 3, 4, 5, 6, 7].map((i) => `u${i}.js`)]);
check('700 Ko : 4 envois au plus, 150 Ko chacun', r.envois.length === 4 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024), r.envois.map((e) => Buffer.byteLength(e)));
check('700 Ko : u1 à u4 partis, u5 à u7 non lus et nommés, aucune troncature', [1, 2, 3, 4].every((i) => has(r.all, `// U${i}\n`)) && [5, 6, 7].every((i) => !has(r.all, `U${i}`)), r.out);
check('700 Ko : relecture « partielle » avec les noms des fichiers non envoyés', /RELECTURE CODEX : partielle/.test(r.out) && /u5\.js[^\n]*u6\.js[^\n]*u7\.js/.test(r.out) && !/u4\.js \(/.test(r.out), r.out);
check('partielle sans point : pas de « RAS »', !/RAS/.test(r.out), r.out);
check('journal : 4 envois, fichiers envoyés, non envoyés nommés, statut partielle', jok((j) => j.nombre_envois === 4 && j.fichiers_envoyes.length === 5 && j.fichiers_envoyes.includes('u4.js') && j.non_envoyes.length === 3 && j.non_envoyes.every((n) => /^u[567]\.js/.test(n)) && j.statut === 'partielle'), JSON.stringify(journal()).slice(0, 300));

// Dépôt 6 : un fichier SUIVI dont le diff seul dépasse 150 Ko : nommé, jamais tronqué.
// (C14-D : le fichier non suivi de plus de 150 Ko n'est plus refusé, il part en plages de lignes ; testé plus bas.)
const G = depot('g', { 'p.js': '// p\n', 'gros.js': remplir('GROS', 160) }); w(G, 'p.js', '// p modifié\n'); w(G, 'gros.js', '// gros réduit\n');
r = codex(G, ['HEAD', '--']);
check('fichier suivi dont le diff dépasse 150 Ko : nommé, rien de lui n\'est envoyé, le reste part', !has(r.all, 'GROS') && has(r.all, '+++ b/p.js')
  && /gros\.js \(trop gros/.test(r.out) && /RELECTURE CODEX : partielle/.test(r.out), r.out);

// C10 : « non effectuée » dès que rien de la tâche n'est parti, même si Codex répond revue_effectuee: true ; « RAS » seulement si du contenu est parti et Codex a relu.
const H = depot('h', { 'h.js': '// h\n', 'conf/y_secret.toml': 'A = 1\n' });
r = codex(H, ['HEAD']);
check('rien à envoyer : Codex n\'est pas appelé (ni envoi ni login), « non effectuée » avec la raison, jamais « RAS »', r.appels === 0 && r.p === null && /RELECTURE CODEX : non effectuée — aucun fichier de la tâche n'est parti \(diff vide/.test(r.out) && !/RAS/.test(r.out) && !/complète|partielle|INDISPONIBLE/.test(r.out), `${r.appels} appel(s) ${r.out}`);
check('journal : rien envoyé, statut non effectuée', jok((j) => j.fichiers_envoyes.length === 0 && j.statut === 'non effectuée' && /aucun fichier/.test(j.raison)), JSON.stringify(journal()).slice(0, 300));
r = codex(H, ['HEAD', '--', 'conf', '../dehors.js']);
check('liste entièrement refusée : Codex n\'est pas appelé', r.appels === 0 && r.p === null, r.appels);
check('liste entièrement refusée (dossier, hors dépôt), Codex répond true : « non effectuée », refus nommés', /non effectuée — aucun fichier de la tâche n'est parti \(conf \(dossier\)[^\n]*dehors\.js \(hors dépôt\)/.test(r.out) && !/RAS/.test(r.out), r.out);
w(H, 'conf/y_secret.toml', 'A = 2\n'); r = codex(H, ['HEAD']);
check('seul fichier modifié sensible : Codex n\'est pas appelé', r.appels === 0 && r.p === null, r.appels);
check('seul fichier modifié sensible : rien envoyé, « non effectuée », fichier nommé', /non effectuée — aucun fichier de la tâche n'est parti \(conf\/y_secret\.toml \(sensible\)/.test(r.out) && !has(r.all, 'A = 2') && !/RAS/.test(r.out), r.out);
const I = depot('i', { 'i.js': '// i\n' }); w(I, 'i.js', '// i modifié\n');
r = codex(I, ['HEAD', '--']); // C14-E : `--` sans fichier = la session affirme qu'il n'y a pas de fichier nouveau
check('contenu à envoyer : Codex est appelé (login puis un envoi)', r.appels === 2, r.appels);
check('contenu de la tâche parti, Codex a relu, aucun point : « complète » et « RAS » permis', /RELECTURE CODEX : complète, RAS/.test(r.out) && has(r.all, '+++ b/i.js'), r.out);
r = codex(I, ['HEAD'], 'Relis.', { FAKE_REVUE: 'non' });
check('contenu parti mais Codex répond revue_effectuee: false : « non effectuée » avec sa raison, jamais « RAS »', /RELECTURE CODEX : non effectuée — RAISON_CODEX/.test(r.out) && /CODEX INDISPONIBLE : RAISON_CODEX/.test(r.out) && !/RAS/.test(r.out), r.out);
check('journal : fichier envoyé même si Codex n\'a pas relu, statut non effectuée', jok((j) => j.nombre_envois === 1 && j.fichiers_envoyes.join() === 'i.js' && j.statut === 'non effectuée'), JSON.stringify(journal()).slice(0, 300));

// Arrêt « rien envoyé » : une demande de 200 Ko rend le prompt trop gros.
r = codex(A, ['HEAD'], 'D'.repeat(200 * 1024));
check('prompt au-delà de 150 Ko : arrêt, rien envoyé', r.p === null && /rien envoyé/.test(r.out) && /CODEX INDISPONIBLE/.test(r.out), r.out);

// Lien symbolique listé vers un .env : jamais lu. Sous Windows sans mode développeur, la création est refusée.
w(A, '.env', 'ENV_SECRET_LIEN\n');
try { fs.symlinkSync(path.join(A, '.env'), path.join(A, 'lib', 'lien.js'), 'file'); } catch (e) { console.log(`SKIP lien symbolique : création refusée ici (${e.code}), cas non testé`); }
if (fs.existsSync(path.join(A, 'lib', 'lien.js'))) { r = codex(A, ['HEAD', '--', 'lib/lien.js']); check('lien symbolique listé : pas lu', !has(r.p, 'ENV_SECRET_LIEN'), r.p); }

// ===== C14 =====
// A : noms exacts (espaces, renommages). `git diff --no-renames -z` : le nom testé par SENSITIVE est le nom réel.
const K = depot('k', { 'mes cles/.env': 'A=1\n', 'mes docs/a b.js': '// ab\n', 'app.conf.sample': 'X=1\n'.repeat(40), 'old.js': '// old\n'.repeat(30), 'ok.js': '// ok\n' });
w(K, 'mes cles/.env', 'SECRET_ESPACE=1\n'); w(K, 'mes docs/a b.js', '// ab modifié\n');
git(K, 'mv', 'app.conf.sample', '.env'); w(K, '.env', 'X=1\n'.repeat(40) + 'SECRET_RENAME=2\n'); // contenu quasi identique : sans --no-renames, git y voit un renommage
git(K, 'mv', 'old.js', 'new.js'); fs.appendFileSync(path.join(K, 'new.js'), '// NOUVEAU_CONTENU\n');
r = codex(K, ['HEAD', '--', 'mes docs/a b.js', 'new.js']);
check('C14-A nom avec espace dans un dossier sensible (mes cles/.env) : contenu jamais envoyé, nommé « sensible »', !has(r.all, 'SECRET_ESPACE') && /mes cles\/\.env \(sensible\)/.test(r.out + (r.p || '')), r.p);
check('C14-A git mv app.conf.sample .env avec ajout : le .env porte son nom réel, sensible, son contenu ne part pas', !has(r.all, 'SECRET_RENAME') && has(r.p, '.env (sensible)'), r.p);
check('C14-A un renommage est listé sous son nouveau nom, son contenu part (pas « suivi et inchangé »)', has(r.p, '+++ b/new.js') && has(r.p, 'NOUVEAU_CONTENU') && !/suivi et inchangé/.test(r.out), r.out);
check('C14-A nom avec espace non sensible (mes docs/a b.js), listé et modifié : une fois dans le diff, pas « suivi et inchangé »', has(r.p, '+++ b/mes docs/a b.js') && !/suivi et inchangé/.test(r.out) && r.p.split('+++ b/mes docs/a b.js').length === 2, r.out);
check('C14-A le renommage est une suppression de l\'ancien nom plus un ajout du nouveau (pas de « rename from »)', has(r.p, '--- a/old.js') && has(r.p, '+++ /dev/null') && !has(r.p, 'rename from'), r.p);
check('C14-A journal : noms exacts (espaces compris) dans les fichiers envoyés', jok((j) => j.fichiers_envoyes.includes('mes docs/a b.js') && j.fichiers_envoyes.includes('new.js') && j.fichiers_envoyes.includes('old.js') && j.non_envoyes.some((n) => n === '.env (sensible)') && j.non_envoyes.some((n) => n === 'mes cles/.env (sensible)')), JSON.stringify(journal()).slice(0, 400));

// B : SENSITIVE élargi, les noms du point 13.
const NOMS = ['credentials', 'aws/credentials', '.git-credentials', '.pgpass', '.dev.vars', 'infra/prod.tfvars', '.mcp.json', 'config.local.yaml', 'config.local.js', 'app.local.json'];
const L = depot('l', { 'ok.js': '// ok\n' }); w(L, 'ok.js', '// ok modifié\n');
NOMS.forEach((n, i) => w(L, n, `SENSIBLE_${i}\n`));
w(L, 'lib/mcp.json', 'MCP_LIBRE\n'); w(L, 'lib/credentials.js', 'CRED_JS_LIBRE\n');
r = codex(L, ['HEAD', '--', ...NOMS, 'lib/mcp.json', 'lib/credentials.js']);
check('C14-B les noms sensibles du point 13 sont refusés et nommés, contenu jamais envoyé', NOMS.every((n, i) => !has(r.all, `SENSIBLE_${i}`) && has(r.p, `${n} (sensible)`)), NOMS.filter((n, i) => has(r.all, `SENSIBLE_${i}`) || !has(r.p, `${n} (sensible)`)));
check('C14-B des fichiers voisins mais ordinaires (lib/mcp.json, lib/credentials.js) restent envoyés', has(r.p, 'MCP_LIBRE') && has(r.p, 'CRED_JS_LIBRE'), r.p);

// C : masquage des secrets au format JSON, Bearer, jetons GitHub, et dans la demande.
const M = depot('m', { 'ok.js': '// ok\n' }); w(M, 'ok.js', '// ok modifié\n');
w(M, 'cfg/conn.json', '{"password": "hunter2hunter2", "apiKey": "APIKEYVALEUR123", "client_secret": "CLIENTSECRETVALEUR", "n": 1}\nAuthorization: Bearer BEARERVALEUR0123456789\n');
w(M, 'cfg/gh.txt', 'GHP=ghp_' + 'a'.repeat(30) + '\nGHS=ghs_' + 'b'.repeat(30) + '\nGHO=gho_' + 'c'.repeat(30) + '\nGHU=ghu_' + 'd'.repeat(30) + '\nGHR=ghr_' + 'e'.repeat(30) + '\n');
r = codex(M, ['HEAD', '--', 'cfg/conn.json', 'cfg/gh.txt'], `Relis. Mon jeton : ghs_${'z'.repeat(36)} et password=demandeSECRETE1`);
check('C14-C JSON : password, apiKey, client_secret masqués (clé entre guillemets)', ['hunter2hunter2', 'APIKEYVALEUR123', 'CLIENTSECRETVALEUR'].every((s) => !has(r.p, s)) && has(r.p, '"password'), r.p);
check('C14-C Authorization: Bearer <jeton> masqué', !has(r.p, 'BEARERVALEUR0123456789') && /Bearer \[MASQUÉ\]/.test(r.p), r.p);
check('C14-C jetons ghp_, ghs_, gho_, ghu_, ghr_ masqués', ['a', 'b', 'c', 'd', 'e'].every((c) => !has(r.p, c.repeat(30))), r.p);
check('C14-C la demande est masquée aussi (ghs_ et password=)', !has(r.p, 'z'.repeat(36)) && !has(r.p, 'demandeSECRETE1') && has(r.p, '=== DEMANDE ==='), r.p);

// D : un fichier seul de plus de 150 Ko n'est plus refusé : plages de lignes identifiées, réparties entre les envois (4 au plus).
const lignesDe = (marq, ko) => `// ${marq}_DEBUT\n${`// ${'x'.repeat(60)}\n`.repeat(Math.ceil((ko * 1024) / 64))}// ${marq}_FIN\n`;
const N = depot('n', { 'p.js': '// p\n' }); w(N, 'p.js', '// p modifié\n');
w(N, 'b180.js', lignesDe('B180', 180));
r = codex(N, ['HEAD', '--', 'b180.js']);
const nl = (t) => t.split('\n').filter((l) => l === `+// ${'x'.repeat(60)}`).length;
check('C14-D fichier non suivi de 180 Ko : 2 envois de 150 Ko au plus, début et fin partis, plus de « trop gros »', r.envois.length === 2 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024) && has(r.all, 'B180_DEBUT') && has(r.all, 'B180_FIN') && !/trop gros/.test(r.out), [r.envois.map((e) => Buffer.byteLength(e)), r.out]);
check('C14-D 180 Ko : chaque ligne part une fois, aucune perdue ni doublée', nl(r.all) === Math.ceil((180 * 1024) / 64), nl(r.all));
check('C14-D 180 Ko : plages identifiées par chemin et numéros de lignes, dans l\'envoi et dans le journal', r.envois.length > 0 && /\+\+\+ b\/b180\.js\n@@ lignes 1-\d+ @@/.test(r.envois[0]) && /\+\+\+ b\/b180\.js\n@@ lignes \d+-\d+ @@/.test(r.envois[1]) && jok((j) => j.fichiers_envoyes.some((f) => /^b180\.js \(lignes 1-\d+\)$/.test(f)) && j.fichiers_envoyes.some((f) => /^b180\.js \(lignes \d+-\d+\)$/.test(f))), jok((j) => j.fichiers_envoyes) ? 'journal ok' : 'journal sans plages');
check('C14-D 180 Ko avec `--` : relecture complète, le diff du fichier suivi part aussi', /RELECTURE CODEX : complète/.test(r.out) && has(r.all, '+++ b/p.js'), r.out);
w(N, 'b900.js', lignesDe('B900', 900));
r = codex(N, ['HEAD', '--', 'b900.js']);
const total900 = Math.ceil((900 * 1024) / 64) + 2;
let plages = []; try { plages = journal().fichiers_envoyes.filter((f) => /^b900\.js \(lignes/.test(f)).map((f) => /lignes (\d+)-(\d+)/.exec(f).slice(1).map(Number)); } catch { /* journal sans plages : le cas échoue plus bas */ }
const restant = /b900\.js \(lignes (\d+)-(\d+), /.exec(r.out);
check('C14-D fichier de 900 Ko : 4 envois de 150 Ko au plus, début parti, fin non partie, rien tronqué', r.envois.length === 4 && r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024) && has(r.all, 'B900_DEBUT') && !has(r.all, 'B900_FIN'), [r.envois.map((e) => Buffer.byteLength(e)), r.out]);
check('C14-D 900 Ko : le reste est nommé avec ses numéros de lignes, relecture « partielle »', !!restant && /RELECTURE CODEX : partielle/.test(r.out) && Number(restant[2]) === total900, r.out);
check('C14-D 900 Ko : plages envoyées contiguës depuis la ligne 1, suivies exactement par la plage non envoyée', plages.length >= 4 && plages[0][0] === 1 && plages.every((p, i) => i === 0 || p[0] === plages[i - 1][1] + 1) && !!restant && Number(restant[1]) === plages[plages.length - 1][1] + 1, [plages, restant && restant.slice(1)]);
check('C14-D 900 Ko : le diff du fichier suivi n\'est pas affamé par le gros fichier', has(r.all, '+++ b/p.js'), r.out);
check('C14-D journal : statut partielle, plage non envoyée nommée', jok((j) => j.statut === 'partielle' && j.non_envoyes.some((n) => /^b900\.js \(lignes \d+-\d+, /.test(n))), 'journal');
const O = depot('o', { 'p.js': '// p\n' }); w(O, 'p.js', '// p modifié\n'); w(O, 'une-ligne.js', `// PREMIERE\n${'y'.repeat(200 * 1024)}\n// SECONDE_LIGNE\n`);
r = codex(O, ['HEAD', '--', 'une-ligne.js']);
check('C14-D une ligne seule plus grosse qu\'un envoi : nommée (numéro de ligne), les autres lignes partent, jamais tronquée', has(r.all, 'PREMIERE') && has(r.all, 'SECONDE_LIGNE') && !has(r.all, 'yyyyyyyyyyyyyyyy') && /une-ligne\.js \(ligne 2[^)]*trop longue/.test(r.out) && /RELECTURE CODEX : partielle/.test(r.out), r.out);

// E : sans `--` la liste n'a pas été fournie : « partielle », jamais « RAS ». Avec `--` sans fichier : « complète » possible.
const Q = depot('q', { 'q.js': '// q\n' }); w(Q, 'q.js', '// q modifié\n');
r = codex(Q, ['HEAD']);
check('C14-E sans `--` : Codex a relu mais la liste n\'a pas été fournie : « partielle », jamais « RAS », la raison dit `--`', /RELECTURE CODEX : partielle/.test(r.out) && !/RAS|complète/.test(r.out) && /--/.test(r.out.split('RELECTURE CODEX')[1] || ''), r.out);
check('C14-E sans `--` : journal statut partielle, non envoyés nomme les fichiers non suivis ou ignorés', jok((j) => j.statut === 'partielle' && j.non_envoyes.some((n) => /non suivis/.test(n))), 'journal');
r = codex(Q, ['HEAD', '--']);
check('C14-E avec `--` sans fichier : la session affirme qu\'il n\'y en a pas, « complète, RAS » permis', /RELECTURE CODEX : complète, RAS/.test(r.out), r.out);
r = codex(Q, ['HEAD'], 'Relis.', { FAKE_REVUE: 'non' });
check('C14-E sans `--` et Codex n\'a pas relu : « non effectuée », pas « partielle »', /RELECTURE CODEX : non effectuée — RAISON_CODEX/.test(r.out) && !/partielle|RAS/.test(r.out), r.out);

// F : Codex qui échoue ou répond revue_effectuee: false sur le seul envoi N, dépôt à trois envois.
const R = depot('r', { 'r1.js': remplir('R1', 100), 'r2.js': remplir('R2', 100), 'r3.js': remplir('R3', 100) });
for (const f of ['r1', 'r2', 'r3']) w(R, `${f}.js`, `// ${f} réduit\n`);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1' });
check('C14-F témoin : trois envois, tous relus, complète', r.envois.length === 3 && /RELECTURE CODEX : complète/.test(r.out), r.out);
const noms = (j, ...ix) => ix.flatMap((i) => j.envois[i].fichiers);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_FAIL_N: '1' });
check('C14-F échec de l\'envoi 1 : le suivant ne part pas, « partielle », points de l\'envoi 0 gardés, panne signalée', r.envois.length === 2 && /RELECTURE CODEX : partielle/.test(r.out) && /envoi-0\.js:1 — P0/.test(r.out) && /CODEX INDISPONIBLE : [^\n]*panne simulee/.test(r.out) && !/RAS/.test(r.out), r.out);
check('C14-F échec de l\'envoi 1 : journal, fichiers des envois 1 et 2 nommés comme non relus', jok((j) => { const n = noms(j, 1); const m = noms(j, 0); return j.statut === 'partielle' && j.nombre_envois === 2 && n.length >= 1 && n.every((f) => j.non_envoyes.some((x) => x.startsWith(`${f} (`))) && !m.some((f) => j.non_envoyes.some((x) => x.startsWith(`${f} (`))) && j.non_envoyes.length === n.length + 1; }), 'journal');
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_FAIL_N: '0' });
check('C14-F échec de l\'envoi 0 : rien de relu, « non effectuée », jamais « RAS » ni « complète »', r.envois.length === 1 && /RELECTURE CODEX : non effectuée/.test(r.out) && !/RAS|complète|partielle/.test(r.out), r.out);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_ATTENTE_ENVOI: '2' }); // adapté : l'envoi 2 (par son numéro d'envoi) répond false à chaque essai ; avec la relance, 4 appels, le 3e envoi est l'appel n°3
check('C14-F revue_effectuee: false sur l\'envoi 2 seul (relancé une fois) : les trois envois partent, « partielle », points des envois 1 et 3 gardés', r.envois.length === 4 && /RELECTURE CODEX : partielle/.test(r.out) && /envoi-0\.js:1 — P0/.test(r.out) && /envoi-3\.js:1 — P3/.test(r.out) && !/envoi-1\.js:1/.test(r.out) && !/RAS/.test(r.out), r.out);
check('C14-F revue false sur l\'envoi 1 : journal, seuls les fichiers de l\'envoi 1 sont non relus', jok((j) => { const n = noms(j, 1); return j.statut === 'partielle' && j.non_envoyes.length === n.length && n.every((f) => j.non_envoyes.some((x) => x.startsWith(`${f} (envoi 2 non relu`))); }), 'journal');

// ===== Envois multiples : chaque envoi se suffit, relance unique (incident du 2026-11-07 : « en attente des envois 2/4 à 4/4 ») =====
const CONSIGNE = 'relis cette partie maintenant, sans attendre';
r = codex(R, ['HEAD', '--']);
check('T1 chaque prompt d\'un envoi multiple dit de relire maintenant, sans attendre', r.envois.length === 3 && r.envois.every((e, i) => has(e, CONSIGNE) && has(e, `=== ENVOI ${i + 1}/3`) && /ne verras jamais/.test(e) && /en attente/.test(e)), r.envois.map((e) => e.slice(0, 200)));
check('T1 plafond respecté avec l\'en-tête plus long', r.envois.every((e) => Buffer.byteLength(e) <= 150 * 1024), r.envois.map((e) => Buffer.byteLength(e)));
r = codex(I, ['HEAD', '--']);
check('T1 envoi unique : pas de consigne d\'envoi multiple', r.envois.length === 1 && !has(r.p, CONSIGNE) && !has(r.p, '=== ENVOI'), r.p);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_ATTENTE_UNE_FOIS: '2' });
const RELANCE = 'ta réponse précédente n\'était pas une relecture';
check('T2 envoi 2 « en attente » une fois : 4 prompts (3 envois + 1 relance, partie juste après l\'envoi 2 : appel n°3), relance de l\'envoi 2 seul avec les mêmes fichiers', r.envois.length === 4 && r.appels === 5 && has(r.envois[2], RELANCE) && !has(r.envois[0], RELANCE) && !has(r.envois[1], RELANCE) && !has(r.envois[3], RELANCE) && has(r.envois[2], '=== ENVOI 2/3') && r.envois[2].slice(r.envois[2].indexOf('=== DIFF ===')) === r.envois[1].slice(r.envois[1].indexOf('=== DIFF ===')), [r.envois.length, r.appels]);
check('T2 statut « complète », rien de non relu, points des appels 0, 2 et 3 gardés (l\'appel 1 était « en attente »)', /RELECTURE CODEX : complète/.test(r.out) && !/non relu|partielle/.test(r.out) && /envoi-0\.js:1 — P0/.test(r.out) && /envoi-2\.js:1 — P2/.test(r.out) && /envoi-3\.js:1 — P3/.test(r.out) && !/envoi-1\.js:1/.test(r.out), r.out);
check('T2 journal : une entrée par envoi, envois[1].relance === true avec premiere_reponse, les autres relance false', jok((j) => j.nombre_envois === 3 && j.envois.length === 3 && j.envois[1].relance === true && /en attente/.test(j.envois[1].premiere_reponse) && j.envois[0].relance === false && j.envois[2].relance === false && !('premiere_reponse' in j.envois[0]) && j.statut === 'complète' && j.non_envoyes.length === 0), JSON.stringify(journal()).slice(0, 300));
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_ATTENTE_ENVOI: '2' });
check('T3 envoi 2 toujours « en attente » : 4 prompts, une seule relance, le 3e envoi part, « partielle », jamais « RAS »', r.envois.length === 4 && r.appels === 5 && r.envois.filter((e) => has(e, RELANCE)).length === 1 && has(r.envois[3], '=== ENVOI 3/3') && /RELECTURE CODEX : partielle/.test(r.out) && !/RAS|complète/.test(r.out), [r.envois.length, r.appels, r.out]);
check('T3 points des envois 1 et 3 gardés, aucun de l\'envoi 2', /envoi-0\.js:1 — P0/.test(r.out) && /envoi-3\.js:1 — P3/.test(r.out) && !/envoi-1\.js:1|envoi-2\.js:1/.test(r.out), r.out);
check('T3 fichiers de l\'envoi 2 nommés « (envoi 2 non relu, relancé une fois) »', jok((j) => { const n = noms(j, 1); return n.length >= 1 && j.statut === 'partielle' && j.non_envoyes.length === n.length && n.every((f) => j.non_envoyes.includes(`${f} (envoi 2 non relu, relancé une fois)`)); }) && /\(envoi 2 non relu, relancé une fois\)/.test(r.out), r.out);
check('T3 journal : une entrée par envoi, envois[1].relance true, premiere_reponse présente', jok((j) => j.envois.length === 3 && j.envois[1].relance === true && typeof j.envois[1].premiere_reponse === 'string' && j.envois[0].relance === false && j.envois[2].relance === false), JSON.stringify(journal()).slice(0, 300));
r = codex(I, ['HEAD', '--'], 'Relis.', { FAKE_REVUE: 'non' });
check('T4 envoi unique revue_effectuee: false : un seul envoi, pas de relance', r.envois.length === 1 && r.appels === 2 && /RELECTURE CODEX : non effectuée — RAISON_CODEX/.test(r.out) && jok((j) => j.envois.length === 1 && j.envois[0].relance === false), [r.envois.length, r.appels, r.out]);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_FAIL_N: '0' });
check('T5 envoi sans aucune réponse dès le premier essai : arrêt, pas de relance', r.envois.length === 1 && r.appels === 2, [r.envois.length, r.appels]);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_ATTENTE_UNE_FOIS: '2', FAKE_FAIL_N: '2' }); // l'appel n°2 est la relance de l'envoi 2 : Codex tombe pendant la relance
check('T6 relance sans réponse : arrêt, l\'envoi 3 ne part pas, « partielle », envoi 2 « relancé une fois », envoi 3 « non lancé », points de l\'envoi 1 gardés', r.envois.length === 3 && has(r.envois[2], RELANCE) && /RELECTURE CODEX : partielle/.test(r.out) && /envoi-0\.js:1 — P0/.test(r.out) && !/RAS|complète/.test(r.out)
  && jok((j) => { const n2 = noms(j, 1); return n2.length >= 1 && j.envois.length === 2 && j.envois[1].relance === true && j.envois[1].reponse === null && n2.every((f) => j.non_envoyes.includes(`${f} (envoi 2 non relu, relancé une fois)`)) && j.non_envoyes.some((x) => / \(envoi non lancé\)$/.test(x)); }), [r.envois.length, r.out]);
r = codex(R, ['HEAD', '--'], 'Relis.', { FAKE_POINTS: '1', FAKE_ILLISIBLE_N: '1' }); // première réponse de l'envoi 2 illisible (pas du JSON)
check('T7 première réponse illisible : relance de cet envoi seul, puis relu, « complète »', r.envois.length === 4 && has(r.envois[2], RELANCE) && has(r.envois[2], '=== ENVOI 2/3') && /RELECTURE CODEX : complète/.test(r.out) && jok((j) => j.envois[1].relance === true && /pas de JSON/.test(j.envois[1].premiere_reponse)), [r.envois.length, r.out]);

// ===== C14b : fin du lot C14 =====
// A : SENSITIVE sur tous les composants du chemin, suivis et non suivis ; un fichier ignoré par git ne part que s'il est code ou doc.
const SENS10 = ['.envrc', 'prod.env', 'secrets/prod.yaml', '.docker/config.json', '.ssh/config', 'secrets.py', '.htpasswd', '.secrets', 'service-account.json', 'keystore.jks'];
const SENS_PLUS = ['.kube/config', '.gnupg/trustdb', '.azure/profile.js', 'deep/secrets/b.txt', 'sub/.env.production', 'secret.txt', 'lib/secretary.py']; // secretary.py : `secret*` le prend, refus voulu (décidé : une fuite ne se rattrape pas)
const TOUS = [...SENS10, ...SENS_PLUS];
const T = depot('t', { 'ok.js': '// ok\n' }); w(T, 'ok.js', '// ok modifié\n');
TOUS.forEach((n, i) => w(T, n, `NSENS_${i}\n`));
r = codex(T, ['HEAD', '--', ...TOUS]);
check('C14b-A non suivis : les 10 noms et les autres composants sensibles refusés, nommés, contenu jamais envoyé', TOUS.every((n, i) => !has(r.all, `NSENS_${i}`) && has(r.p, `${n} (sensible)`)), TOUS.filter((n, i) => has(r.all, `NSENS_${i}`) || !has(r.p, `${n} (sensible)`)));
const U = depot('u', { 'ok.js': '// ok\n', ...Object.fromEntries(TOUS.map((n, i) => [n, `TOLD_${i}\n`])) }); w(U, 'ok.js', '// ok modifié\n');
TOUS.forEach((n, i) => w(U, n, `TNEW_${i}\n`));
const trace = path.join(tmp, 'git-trace.txt'); fs.writeFileSync(trace, '');
r = codex(U, ['HEAD', '--'], 'Relis.', { GIT_TRACE: trace });
check('C14b-A suivis : les 10 noms et les autres refusés dans le diff, nommés, ni ancien ni nouveau contenu envoyé', TOUS.every((n, i) => !has(r.all, `TOLD_${i}`) && !has(r.all, `TNEW_${i}`) && has(r.p, `${n} (sensible)`)) && has(r.p, '+++ b/ok.js'), TOUS.filter((n, i) => has(r.all, `TOLD_${i}`) || has(r.all, `TNEW_${i}`) || !has(r.p, `${n} (sensible)`)));
const lignesGit = fs.readFileSync(trace, 'utf8').split('\n').filter((l) => /\bdiff\b/.test(l));
check('C14b-A un fichier sensible n\'est jamais lu : aucune commande git diff ne le nomme, un diff par fichier non sensible', TOUS.every((n) => !lignesGit.some((l) => l.includes(n))) && lignesGit.some((l) => /diff .*-- ok\.js/.test(l)), lignesGit.slice(0, 6));
// ignorés par git : ni code ni doc refusés, nommés, relecture partielle
const S = depot('s', { 'ok.js': '// ok\n', '.gitignore': 'app.yaml\nscripts/\nignored-doc.md\nout.log\nnoext\nnotes.rst\nsecrets/\n' }); w(S, 'ok.js', '// ok modifié\n');
w(S, 'app.yaml', 'IGN_YAML: 1\n'); w(S, 'scripts/x.py', 'IGN_PY = 1\n'); w(S, 'ignored-doc.md', 'IGN_MD\n'); w(S, 'out.log', 'IGN_LOG\n'); w(S, 'noext', 'IGN_NOEXT\n'); w(S, 'notes.rst', 'IGN_RST\n');
w(S, 'secrets/p.py', 'IGN_SENS\n'); w(S, 'profils/x.json', '{"LIBRE_JSON": 1}\n');
r = codex(S, ['HEAD', '--', 'app.yaml', 'scripts/x.py', 'ignored-doc.md', 'out.log', 'noext', 'notes.rst', 'secrets/p.py', 'profils/x.json']);
check('C14b-A ignorés par git : app.yaml, out.log, noext refusés et nommés « ignoré par git, ni code ni doc », contenu jamais envoyé', ['app.yaml', 'out.log', 'noext'].every((n) => has(r.p, `${n} (ignoré par git, ni code ni doc)`)) && !has(r.all, 'IGN_YAML') && !has(r.all, 'IGN_LOG') && !has(r.all, 'IGN_NOEXT'), r.p);
check('C14b-A ignorés par git : scripts/x.py, .md et .rst ignorés envoyés ; ignoré et sensible : « sensible »', has(r.p, 'IGN_PY') && has(r.p, 'IGN_MD') && has(r.p, 'IGN_RST') && !has(r.all, 'IGN_SENS') && has(r.p, 'secrets/p.py (sensible)'), r.p);
check('C14b-A profils/x.json non suivi et non ignoré : envoyé (la règle ne vise que les ignorés)', has(r.p, 'LIBRE_JSON') && has(r.p, '+++ b/profils/x.json'), r.p);
check('C14b-A refus d\'un ignoré : la relecture est « partielle », jamais « RAS »', /RELECTURE CODEX : partielle[^\n]*app\.yaml/.test(r.out) && !/RAS/.test(r.out), r.out);

// B : formes de secrets masquées (clé et valeur jamais envoyées).
const W = depot('w', { 'ok.js': '// ok\n', 'pk.txt': 'x\n' }); w(W, 'ok.js', '// ok modifié\n'); w(W, 'pk.txt', 'x\n-----BEGIN PRIVATE KEY-----\nTRACKEDPEM\n');
const FORMES = [
  ['URL user:pass@', 'DATABASE_URL=postgres://admin:URLPASS9876xyz@db.example.com/base', ['URLPASS9876xyz']],
  ['sk_live_', 'STRIPE=sk_live_SKLIVETOKEN1234567890', ['SKLIVETOKEN1234567890']],
  ['rk_live_', 'STRIPE_R=rk_live_RKLIVETOKEN1234567890', ['RKLIVETOKEN1234567890']],
  ['glpat-', 'GL=glpat-GLPATTOKEN1234567890ab', ['GLPATTOKEN1234567890ab']],
  ['AIza', `GOOGLE=AIzaSyD${'q'.repeat(32)}`, ['qqqqqqqqqqqq']],
  ['JWT', 'T=eyJhbGciOiJIUzI1NiJ9.eyJKV1RQQVlMT0FEMTIzNDU2.JWTSIGNATURE987654', ['KV1RQQVlMT0FEMTIzNDU2', 'JWTSIGNATURE987654']],
  ['Authorization: Basic', 'Authorization: Basic QkFTSUNDUkVEMTIzNDU2Nzg=', ['QkFTSUNDUkVEMTIzNDU2Nzg=']],
  ['AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY=AWSSECRETVALUE12345', ['AWSSECRETVALUE12345']],
  ['secretAccessKey JSON', '{"secretAccessKey": "CAMELSECRETVAL99"}', ['CAMELSECRETVAL99']],
  ['*_PASS', 'DB_PASS=DBPASSVALUE123', ['DBPASSVALUE123']],
  ['pwd', 'pwd=PWDVALUE12345', ['PWDVALUE12345']],
];
w(W, 'cfg/formes.txt', `${FORMES.map((f) => f[1]).join('\n')}\nFIN_FORMES_VISIBLE\n`);
w(W, 'cfg/pem.txt', 'AVANT_PEM_VISIBLE\n-----BEGIN RSA PRIVATE KEY-----\nPEMBODY1\nPEMBODY2\nPEM_JUSQUA_LA_FIN\n');
w(W, 'cfg/pgp.txt', 'AVANT_PGP_VISIBLE\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nPGPBODY1\n=PGPCRC\nPGP_JUSQUA_LA_FIN\n');
w(W, 'cfg/pem-fin.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nPEMFINBODY\n-----END OPENSSH PRIVATE KEY-----\nAPRES_END_VISIBLE\n');
w(W, 'cfg/zz.js', '// ZZ_VISIBLE\n');
r = codex(W, ['HEAD', '--', 'cfg/formes.txt', 'cfg/pem.txt', 'cfg/pgp.txt', 'cfg/pem-fin.txt', 'cfg/zz.js']);
for (const [nom, , secrets] of FORMES) check(`C14b-B masqué : ${nom}`, secrets.every((s) => !has(r.all, s)), secrets.filter((s) => has(r.all, s)));
check('C14b-B les formes sont masquées sans manger le reste du fichier', has(r.p, 'FIN_FORMES_VISIBLE') && has(r.p, '[MASQUÉ]'), r.p);
check('C14b-B clé PEM privée sans END : masquée jusqu\'à la fin du fichier, ce qui précède reste', ['PEMBODY1', 'PEMBODY2', 'PEM_JUSQUA_LA_FIN'].every((s) => !has(r.all, s)) && has(r.p, 'AVANT_PEM_VISIBLE'), r.p);
check('C14b-B clé PGP privée sans END : masquée jusqu\'à la fin du fichier', ['PGPBODY1', 'PGPCRC', 'PGP_JUSQUA_LA_FIN'].every((s) => !has(r.all, s)) && has(r.p, 'AVANT_PGP_VISIBLE'), r.p);
check('C14b-B clé PEM avec END : masquée du BEGIN au END, la suite reste ; le fichier suivant n\'est pas touché', !has(r.all, 'PEMFINBODY') && has(r.p, 'APRES_END_VISIBLE') && has(r.p, 'ZZ_VISIBLE'), r.p);
check('C14b-B clé PEM sans END dans un fichier suivi modifié : masquée dans le diff et dans le contenu', !has(r.all, 'TRACKEDPEM'), r.p);

// C : un diff par fichier, noms lus par -z ; un fichier sensible n'est jamais lu ; plus de « diff incohérent ».
const VSUB = depot('vsub', { 's.txt': 's\n' });
const V = depot('v', { 'a.js': '// a\n', 'conf/.env': 'ENV_OLD\n', '.env': 'ENV_ROOT_OLD\n', 'ok2.js': '// ok2\n', '-rf.js': '// rf\n', '[.]env': '// br\n' });
const sm = git(V, '-c', 'protocol.file.allow=always', 'submodule', 'add', VSUB, 'sub'); let sousModule = sm.status === 0;
if (sousModule) { git(V, 'commit', '-qm', 'sous-module'); w(path.join(V, 'sub'), 's.txt', 's2\n'); git(path.join(V, 'sub'), 'commit', '-qam', 's2'); git(V, 'config', 'diff.submodule', 'log'); }
else console.log(`SKIP sous-module : git submodule add refusé ici (${sm.stderr.trim().split('\n').pop()}), cas non testé`);
w(V, 'a.js', '// a\rdiff --git a/faux b/faux\r+FAUX_LIGNE\n'); w(V, 'conf/.env', 'ENV_LEAK_CONF\n'); w(V, '.env', 'ENV_LEAK_GLOB\n'); w(V, '-rf.js', '// RF_MODIF\n'); w(V, '[.]env', '// BRACKET_OK\n');
const Y = depot('y', { 'a.js': '// a\n', 'conf/.env': 'ENV_OLD_Y\n', 'ok2.js': '// ok2\n' }); // dépôt sans sous-module : le faux « diff --git » ajoute un bloc, l'ancien appariement par position échouait ici
w(Y, 'a.js', '// a\rdiff --git a/faux b/faux\r+FAUX_LIGNE\n'); w(Y, 'conf/.env', 'ENV_LEAK_Y\n'); w(Y, 'ok2.js', '// ok2 modifié\n');
r = codex(Y, ['HEAD', '--']);
check('C14b-C a.js contenant « \\rdiff --git a/faux b/faux » et conf/.env suivi : plus de « diff incohérent », le diff de a.js part en entier, .env jamais', !/incohérent|INDISPONIBLE/.test(r.out) && has(r.p, '+++ b/a.js') && has(r.p, 'FAUX_LIGNE') && has(r.p, '+++ b/ok2.js') && !has(r.all, 'ENV_LEAK_Y') && !has(r.all, 'ENV_OLD_Y') && has(r.p, 'conf/.env (sensible)'), r.out);
r = codex(V, ['HEAD', '--']);
check('C14b-C conf/.env suivi : jamais lu ni envoyé, nommé ; le .env racine aussi (pas de motif : --literal-pathspecs)', !has(r.all, 'ENV_LEAK_CONF') && !has(r.all, 'ENV_OLD') && !has(r.all, 'ENV_LEAK_GLOB') && !has(r.all, 'ENV_ROOT_OLD') && has(r.p, 'conf/.env (sensible)') && has(r.p, '.env (sensible)'), r.p);
check('C14b-C nom commençant par « - » (-rf.js) et nom à crochets ([.]env) : leur propre diff part, lu comme nom exact', has(r.p, '+++ b/-rf.js') && has(r.p, 'RF_MODIF') && has(r.p, '+++ b/[.]env') && has(r.p, 'BRACKET_OK'), r.p);
if (sousModule) check('C14b-C sous-module : diff « Subproject commit » (diff.submodule=short forcé malgré diff.submodule=log), sans journal du sous-module', has(r.p, 'Subproject commit') && !has(r.p, 'Submodule sub'), r.p);
const Z = depot('z', { 't.js': '// t\n', 'f.js': '// f\n' });
const bl = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: Z, input: 'f.js', encoding: 'utf8' }).stdout.trim();
git(Z, 'config', 'core.symlinks', 'true'); git(Z, 'update-index', '--add', '--cacheinfo', `120000,${bl},lnk.js`); git(Z, 'commit', '-qm', 'lien'); w(Z, 'lnk.js', 'REGULIER_APRES_LIEN\n');
const blocsZ = git(Z, 'diff', '--no-renames', 'HEAD').stdout.split(/^diff --git /m).length - 1; const nomsZ = git(Z, 'diff', '--no-renames', '-z', '--name-only', 'HEAD').stdout.split('\0').filter(Boolean).length;
if (!(blocsZ === 2 && nomsZ === 1)) console.log(`SKIP typechange : ce git ne produit pas de typechange ici (${blocsZ} blocs, ${nomsZ} nom), cas non testé`);
else { r = codex(Z, ['HEAD', '--']);
  check('C14b-C typechange lien -> fichier (deux blocs, un nom) : la relecture n\'est plus refusée, les deux blocs partent', !/incohérent|INDISPONIBLE/.test(r.out) && has(r.p, 'REGULIER_APRES_LIEN') && has(r.p, 'deleted file mode 120000'), r.out); }
check('C14b-C plus aucun message « diff incohérent » dans le code', !/incohérent/.test(fs.readFileSync(CODEX, 'utf8')), 'présent');

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail);
