#!/usr/bin/env node
// Test de hooks/rappels.js, dans un dossier temporaire (KIT_HOME, KIT_RAPPORTS) et au rythme réel : un processus node par appel.
// Lectures longues : PreToolUse Read (sous le seuil, au-dessus, image, PDF, offset, limit, pages, fichier absent) et PostToolUse
// Bash|PowerShell (sous le seuil, au-dessus, formes de réponse inconnues). Pour chaque hook : agent_id présent, stdin illisible,
// code 0, jamais de decision ni de permissionDecision. Code 1 si un cas échoue.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawnSync } = require('child_process');
let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : ${JSON.stringify(got)}`}`); if (!ok) fail = 1; };

const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'rappels-'));
const home = path.join(kit, 'home'); const rapports = path.join(kit, 'rapports'); const dossier = path.join(kit, 'travail');
for (const d of [home, rapports, dossier]) fs.mkdirSync(d, { recursive: true });
const erreurs = () => { try { return fs.readFileSync(path.join(home, 'logs', 'telemetrie-erreurs.log'), 'utf8'); } catch { return ''; } };
const viderErreurs = () => fs.rmSync(path.join(home, 'logs'), { recursive: true, force: true });

// Un appel du hook : entrée JSON (ou texte brut), retour { code, out, err, ctx, json }.
let garder = false; // faux : l'état « déjà rappelé » (logs/rappels) est vidé avant chaque appel, pour que les cas indépendants (même session s1) ne se gênent pas
function run(input) {
  if (!garder) fs.rmSync(path.join(home, 'logs', 'rappels'), { recursive: true, force: true });
  const p = spawnSync(process.execPath, [path.join(__dirname, 'rappels.js')], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, KIT_HOME: home, KIT_RAPPORTS: rapports }, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(p.stdout); } catch { /* silence */ }
  return { code: p.status, out: p.stdout, err: p.stderr, json, ctx: json && json.hookSpecificOutput ? json.hookSpecificOutput.additionalContext : null };
}
// propre : une sortie JSON d'injection, et rien d'autre (ni decision, ni permissionDecision) ; le silence se teste avec muet.
const propre = (r) => r.code === 0 && !/decision/i.test(r.out) && !!r.json && Object.keys(r.json).join() === 'hookSpecificOutput' && Object.keys(r.json.hookSpecificOutput).sort().join() === 'additionalContext,hookEventName';
const muet = (r) => r.code === 0 && r.out === '' && r.err === '';
const fichier = (nom, taille) => { const f = path.join(dossier, nom); fs.writeFileSync(f, 'a'.repeat(taille)); return f; };
const lire = (file_path, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path, ...extra }, cwd: dossier, session_id: 's1' });
const sortie = (tool_name, tool_response, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input: { command: 'x' }, tool_response, cwd: dossier, session_id: 's1', ...extra });

// 1. PreToolUse Read : seuil de 20 000 caractères, mesuré par la taille sur disque.
{
  const sous = run(lire(fichier('sous.txt', 20000)));
  check('Read : 20 000 car. pile (pas au-dessus du seuil) : silence', muet(sous), sous);
  const dessus = run(lire(fichier('dessus.txt', 20001)));
  check('Read : 20 001 car. : rappel « lecture longue : délègue à scout, ou lis une plage »', propre(dessus) && dessus.json.hookSpecificOutput.hookEventName === 'PreToolUse' && /^rappel du kit \(20 k car\.\) : lecture longue : délègue à scout, ou lis une plage$/.test(dessus.ctx), dessus);
  const gros = run(lire(fichier('gros.txt', 150000)));
  check('Read : 150 000 car. : taille annoncée en k', propre(gros) && /\(150 k car\.\)/.test(gros.ctx), gros);
  const rel = run({ ...lire('gros.txt'), cwd: dossier });
  check('Read : chemin relatif résolu depuis cwd', propre(rel) && /\(150 k car\.\)/.test(rel.ctx), rel);
  check('Read : jamais de refus, jamais de permissionDecision (sortie entière vérifiée)', propre(dessus) && !/permission/i.test(dessus.out), dessus.out);
  for (const [nom, extra] of [['offset', { offset: 100 }], ['limit', { limit: 200 }], ['pages', { pages: '1-5' }], ['offset et limit', { offset: 1, limit: 50 }]]) {
    const r = run(lire(path.join(dossier, 'gros.txt'), extra));
    check(`Read : ${nom} présent : silence (c'est une plage)`, muet(r), r);
  }
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'PNG', 'pdf', 'PDF']) {
    const r = run(lire(fichier(`gros.${ext}`, 300000)));
    check(`Read : .${ext} de 300 k : silence (images et PDF, scout n'y est pour rien)`, muet(r), r);
  }
  const abs = run(lire(path.join(dossier, 'nexiste-pas.txt')));
  check('Read : fichier absent : silence, code 0, pas d\'erreur journalisée', muet(abs) && erreurs() === '', [abs, erreurs()]);
  const dir = run(lire(dossier));
  check('Read : dossier : silence', muet(dir), dir);
  const sans = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, session_id: 's1' });
  check('Read : sans file_path : silence', muet(sans), sans);
  const sansInput = run({ hook_event_name: 'PreToolUse', tool_name: 'Read', session_id: 's1' });
  check('Read : sans tool_input : silence', muet(sansInput), sansInput);
  const nul = run(lire(path.join(dossier, 'gros.txt'), { offset: null, limit: null }));
  check('Read : offset et limit null : pas une plage, rappel', propre(nul) && /lecture longue/.test(nul.ctx), nul);
  const sub = run({ ...lire(path.join(dossier, 'gros.txt')), agent_id: 'a1', agent_type: 'scout' });
  check('Read : agent_id présent : silence (le scout lit comme il veut)', muet(sub), sub);
  const autre = run({ ...lire(path.join(dossier, 'gros.txt')), tool_name: 'Grep' });
  check('PreToolUse sur un autre outil : silence', muet(autre), autre);
}

// 2. PostToolUse Bash et PowerShell : sortie au-dessus du même seuil (stdout + stderr).
{
  const att = (n) => ({ stdout: 'a'.repeat(n), stderr: '', interrupted: false, isImage: false });
  for (const outil of ['Bash', 'PowerShell']) {
    const sous = run(sortie(outil, att(20000)));
    check(`${outil} : sortie de 20 000 car. pile : silence`, muet(sous), sous);
    const dessus = run(sortie(outil, att(20001)));
    check(`${outil} : 20 001 car. : rappel de sortie longue, hookEventName PostToolUse`, propre(dessus) && dessus.json.hookSpecificOutput.hookEventName === 'PostToolUse' && /^rappel du kit \(20 k car\.\) : sortie longue : /.test(dessus.ctx) && /scout/.test(dessus.ctx) && /fichier temporaire/.test(dessus.ctx), dessus);
    const sub = run(sortie(outil, att(50000), { agent_id: 'a1' }));
    check(`${outil} : agent_id présent : silence`, muet(sub), sub);
  }
  const mix = run(sortie('Bash', { stdout: 'a'.repeat(12000), stderr: 'b'.repeat(12000), interrupted: false, isImage: false }));
  check('Bash : stdout et stderr s\'additionnent', propre(mix) && /\(24 k car\.\)/.test(mix.ctx), mix);
  const noOut = run(sortie('Bash', { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: true }));
  check('Bash : sortie vide : silence', muet(noOut), noOut);
  const img = run(sortie('Bash', { stdout: 'a'.repeat(90000), stderr: '', interrupted: false, isImage: true }));
  check('Bash : isImage : silence', muet(img), img);
  const absent = run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, session_id: 's1' });
  check('Bash : tool_response absent : silence', muet(absent), absent);
  const nul = run(sortie('Bash', null));
  check('Bash : tool_response null : silence', muet(nul), nul);
  const chaine = run(sortie('PowerShell', 'z'.repeat(30000)));
  check('forme inconnue : chaîne de 30 000 car. : rappel sur sa taille', propre(chaine) && /\(30 k car\.\)/.test(chaine.ctx), chaine);
  const inconnue = run(sortie('PowerShell', { sortie: 'z'.repeat(30000), code: 0 }));
  check('forme inconnue : objet sans stdout ni stderr : taille de son JSON', propre(inconnue) && /rappel du kit \(30 k car\.\)/.test(inconnue.ctx), inconnue);
  const tableau = run(sortie('PowerShell', ['a'.repeat(15000), 'b'.repeat(15000)]));
  check('forme inconnue : tableau : taille de son JSON', propre(tableau) && /\(30 k car\.\)/.test(tableau.ctx), tableau);
  const courte = run(sortie('PowerShell', { sortie: 'ok', code: 0 }));
  check('forme inconnue courte : silence', muet(courte), courte);
  const nombre = run(sortie('PowerShell', 42));
  check('forme inconnue : nombre : silence', muet(nombre), nombre);
  const autre = run(sortie('Grep', att(90000)));
  check('PostToolUse sur un autre outil : silence', muet(autre), autre);
}

// 3. Entrées illisibles : code 0, rien sur la sortie, erreur dans logs/telemetrie-erreurs.log.
{
  viderErreurs();
  const a = run('ceci n\'est pas du JSON');
  check('stdin illisible : code 0, silence, erreur journalisée', muet(a) && /rappels/.test(erreurs()), [a, erreurs()]);
  viderErreurs();
  const b = run('');
  check('stdin vide : code 0, silence', muet(b), b);
  const c = run({ hook_event_name: 'EvenementInconnu', tool_name: 'Read' });
  check('événement inconnu : silence', muet(c), c);
  const d = run({});
  check('objet vide : silence', muet(d), d);
}

// 4. UserPromptSubmit : « rapport en retard » = au moins 30 requêtes principales (message.id distincts) depuis le dernier Write
//    vers rapports, et au moins une modification (Write, Edit, NotebookEdit, Agent worker, git commit) depuis ce repère.
const ligne = (o) => JSON.stringify(o);
const use = (name, input) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name, input });
let seq = 0;
const asst = (content = [{ type: 'text', text: 'ok' }], usage = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 }, extra = {}, id = `msg_${++seq}`) => ({ type: 'assistant', isSidechain: false, timestamp: new Date(Date.UTC(2026, 10, 4, 0, 0, seq)).toISOString(), message: { id, role: 'assistant', content, usage }, ...extra });
const reqs = (n) => Array.from({ length: n }, () => asst());
const edit = () => asst([use('Edit', { file_path: path.join(dossier, 'a.js'), old_string: 'a', new_string: 'b' })]);
const ecritRapport = (nom = '2026-11-04_03h04-projet.md') => asst([use('Write', { file_path: path.join(rapports, nom), content: 'x' })]);
const prompt = (t = 'suite') => ({ type: 'user', isSidechain: false, message: { role: 'user', content: t } });
const dossierProche = path.join(`${rapports}-vieux`, 'x.md');
let nt = 0;
const transcript = (rows, brut) => { const f = path.join(kit, `t${++nt}.jsonl`); fs.writeFileSync(f, brut === undefined ? rows.map(ligne).join('\n') + '\n' : brut); return f; };
const envoi = (rows, extra = {}) => run({ hook_event_name: 'UserPromptSubmit', prompt: 'suite', session_id: 's1', cwd: dossier, transcript_path: transcript(rows), ...extra });
const envoiBrut = (brut) => run({ hook_event_name: 'UserPromptSubmit', prompt: 'suite', session_id: 's1', cwd: dossier, transcript_path: transcript(null, brut) });
const enRetard = (r, n) => propre(r) && r.json.hookSpecificOutput.hookEventName === 'UserPromptSubmit' && new RegExp(`^rappel du kit \\(${n} requêtes depuis le dernier rapport\\) : rapport en retard : écris-le avant d'enchaîner$`).test(r.ctx);
{
  const a = envoi([prompt(), ...reqs(28), edit()]);
  check('29 requêtes et une modification : silence', muet(a), a);
  const b = envoi([prompt(), ...reqs(29), edit()]);
  check('30 requêtes et une modification : « rapport en retard : écris-le avant d\'enchaîner »', enRetard(b, 30), b);
  const c = envoi([prompt(), ...reqs(80), edit()]);
  check('80 requêtes : le rappel annonce N', enRetard(c, 81), c);
  check('30 requêtes sans aucune modification : silence', muet(envoi([prompt(), ...reqs(29), asst([use('Read', { file_path: 'x' })]), ...reqs(20)])), null);
  check('jamais de decision ni de permissionDecision', !/decision/i.test(b.out) && propre(b), b.out);
  // repère = dernier Write vers rapports : seul ce qui suit compte.
  check('modifs et requêtes avant le rapport ne comptent pas : 100 requêtes, rapport, 29 requêtes, une modification : silence', muet(envoi([edit(), ...reqs(100), ecritRapport(), ...reqs(28), edit()])), null);
  check('modification avant le rapport, 40 requêtes après sans modification : silence', muet(envoi([edit(), ...reqs(10), ecritRapport(), ...reqs(40)])), null);
  check('rapport puis 30 requêtes dont une modification : rappel', enRetard(envoi([...reqs(100), ecritRapport(), ...reqs(15), edit(), ...reqs(14)]), 30), null);
  check('le dernier rapport fait repère (deux rapports)', muet(envoi([edit(), ...reqs(60), ecritRapport('a.md'), edit(), ...reqs(40), ecritRapport('b.md'), ...reqs(5)])), null);

  check('un chemin voisin (rapports-vieux) n\'est pas un rapport', enRetard(envoi([edit(), ...reqs(30), asst([use('Write', { file_path: dossierProche, content: 'x' })]), ...reqs(5)]), 37), null);
  check('un Write vers rapports dans un sous-agent ne fait pas repère', enRetard(envoi([edit(), ...reqs(40), asst([use('Write', { file_path: path.join(rapports, 'z.md'), content: 'x' })], undefined, { isSidechain: true })]), 41), null);
  check('un Write vers rapports avec chemin en barres obliques fait repère', muet(envoi([edit(), ...reqs(40), asst([use('Write', { file_path: path.join(rapports, 'z.md').replace(/\\/g, '/'), content: 'x' })])])), null);
  check('aucun rapport dans la session : on compte depuis le début', enRetard(envoi([edit(), ...reqs(29)]), 30), null);
  // nature des modifications
  for (const [nom, rows] of [['Write', [asst([use('Write', { file_path: path.join(dossier, 'n.js'), content: 'x' })])]], ['NotebookEdit', [asst([use('NotebookEdit', { notebook_path: 'n.ipynb' })])]], ['Agent worker', [asst([use('Agent', { subagent_type: 'worker', prompt: 'x' })])]], ['git commit (Bash)', [asst([use('Bash', { command: 'cd x && git commit -m "m"' })])]], ['git -C ... commit (PowerShell)', [asst([use('PowerShell', { command: 'git -C . commit --amend' })])]]]) {
    check(`modification : ${nom} : rappel`, enRetard(envoi([...reqs(29), ...rows]), 30), nom);
  }
  for (const [nom, rows] of [['Agent scout', [asst([use('Agent', { subagent_type: 'scout', prompt: 'x' })])]], ['git log', [asst([use('Bash', { command: 'git log --oneline' })])]], ['git status', [asst([use('Bash', { command: 'git status' })])]], ['Read', [asst([use('Read', { file_path: 'x' })])]], ['Bash ls', [asst([use('Bash', { command: 'ls' })])]]]) {
    check(`pas une modification : ${nom} : silence`, muet(envoi([...reqs(29), ...rows])), nom);
  }
  // comptage des requêtes
  const deux = (n) => Array.from({ length: n }, (_, i) => [asst([{ type: 'thinking', thinking: '' }], undefined, {}, `dup_${n}_${i}`), asst([use('Read', { file_path: 'x' })], undefined, {}, `dup_${n}_${i}`)]).flat();
  check('une requête étalée sur deux lignes (même message.id) compte une fois : 28 + la modification = 29, silence', muet(envoi([...deux(28), edit()])), null);
  check('… 29 requêtes en deux lignes + la modification = 30 : rappel', enRetard(envoi([...deux(29), edit()]), 30), null);
  check('les lignes de sous-agents (isSidechain) ne comptent pas', muet(envoi([edit(), ...reqs(5), ...Array.from({ length: 60 }, () => asst(undefined, undefined, { isSidechain: true }))])), null);
  const bruit = [edit(), ...reqs(29)].map(ligne); bruit.splice(10, 0, '{ pas du json', '', 'null', '[1]');
  check('lignes corrompues ignorées, le reste compte', enRetard(envoiBrut(`${bruit.join('\n')}\n`), 30), null);
  check('lignes non assistant ignorées (prompts, résultats)', enRetard(envoi([edit(), prompt(), ...reqs(29), prompt(), { type: 'system' }, { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }]), 30), null);
  // données absentes ou illisibles
  check('sans transcript_path : silence', muet(run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 's1' })), null);
  viderErreurs();
  const absent = run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', transcript_path: path.join(kit, 'nexiste-pas.jsonl') });
  check('transcript pas encore créé : silence, pas d\'erreur', muet(absent) && erreurs() === '', [absent, erreurs()]);
  // incident telemetrie-erreurs.log 2026-11-15 00:10 et 03:03 : transcript absent avec prompt_id → TypeError sur .exclus.has (requetes renvoyait [] nu)
  const absentId = run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', prompt_id: 'pid-absent', session_id: 's1', transcript_path: path.join(kit, 'nexiste-pas.jsonl') });
  check('transcript pas encore créé, avec prompt_id : silence, code 0, pas d\'erreur', muet(absentId) && erreurs() === '', [absentId, erreurs()]);
  const vide = require('./rappels.js').requetes(path.join(kit, 'nexiste-pas.jsonl'));
  check('requetes() sur fichier absent : même forme (tableau vide, .erreurs et .exclus sont des Set)', Array.isArray(vide) && vide.length === 0 && vide.erreurs instanceof Set && vide.exclus instanceof Set, vide);
  check('transcript vide : silence', muet(envoiBrut('')), null);
  const illisible = run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', transcript_path: dossier });
  check('transcript illisible (c\'est un dossier) : silence, code 0, erreur journalisée', muet(illisible) && /rappels/.test(erreurs()), [illisible, erreurs()]);
  const sub = envoi([edit(), ...reqs(40)], { agent_id: 'a1' });
  check('agent_id présent : silence', muet(sub), sub);
}

// 5. PostToolUse Write vers rapports : au-dessus de 250 000 tokens de contexte (dernière requête principale : input + cache_read +
//    cache_creation), le fait « contexte à N k » est injecté ; en dessous, silence.
const ctxUsage = (input, lu, cree) => ({ input_tokens: input, cache_read_input_tokens: lu, cache_creation_input_tokens: cree, output_tokens: 10 });
const ecrit = (rows, extra = {}) => run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(rapports, 'r.md'), content: 'x' }, tool_response: { type: 'create' }, session_id: 's1', cwd: dossier, transcript_path: transcript(rows), ...extra });
const contexteA = (r, n) => propre(r) && r.json.hookSpecificOutput.hookEventName === 'PostToolUse' && r.ctx === `contexte à ${n} k`;
{
  check('contexte à 250 000 pile : silence', muet(ecrit([asst(undefined, ctxUsage(2, 200000, 49998))])), null);
  const a = ecrit([asst(undefined, ctxUsage(2, 200000, 100000))]);
  check('contexte à 300 002 (somme des trois compteurs, aucun au-dessus de 250 k seul) : « contexte à 300 k »', contexteA(a, 300), a);
  const b = ecrit([asst(undefined, ctxUsage(1, 250000, 0))]);
  check('contexte à 250 001 : « contexte à 250 k »', contexteA(b, 250), b);
  check('contexte à 180 k : silence', muet(ecrit([asst(undefined, ctxUsage(3, 150000, 30000))])), null);
  check('c\'est la dernière requête principale qui compte (une plus lourde avant : silence)', muet(ecrit([asst(undefined, ctxUsage(1, 400000, 0)), asst(undefined, ctxUsage(1, 90000, 0))])), null);
  check('c\'est la dernière requête principale qui compte (une plus légère avant : rappel)', contexteA(ecrit([asst(undefined, ctxUsage(1, 90000, 0)), asst(undefined, ctxUsage(1, 320000, 0))]), 320), null);
  check('les lignes de sous-agents sont ignorées', muet(ecrit([asst(undefined, ctxUsage(1, 90000, 0)), asst(undefined, ctxUsage(1, 900000, 0), { isSidechain: true })])), null);
  const dernier = ecrit([asst(undefined, ctxUsage(1, 300000, 0)), { type: 'user', message: { content: 'x' } }, asst([{ type: 'text', text: 'sans usage' }], null)]);
  check('dernière ligne assistant sans usage : on prend la dernière qui en a une', contexteA(dernier, 300), dernier);
  check('Write hors rapports : silence', muet(ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { tool_input: { file_path: path.join(dossier, 'r.md'), content: 'x' } })), null);
  check('dossier voisin (rapports-vieux) : silence', muet(ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { tool_input: { file_path: dossierProche, content: 'x' } })), null);
  check('chemin en barres obliques vers rapports : rappel', contexteA(ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { tool_input: { file_path: path.join(rapports, 'r.md').replace(/\\/g, '/'), content: 'x' } }), 400), null);
  check('Edit vers rapports : silence (seul Write déclenche)', muet(ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { tool_name: 'Edit' })), null);
  check('sans file_path : silence', muet(ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { tool_input: {} })), null);
  check('transcript sans aucune usage : silence', muet(ecrit([prompt(), asst([{ type: 'text', text: 'x' }], null)])), null);
  check('usage en forme inconnue (chaînes) : silence', muet(ecrit([asst(undefined, { input_tokens: 'beaucoup', cache_read_input_tokens: '400000' })])), null);
  check('usage partielle (cache_creation absent) : compte ce qui existe', contexteA(ecrit([asst(undefined, { input_tokens: 10, cache_read_input_tokens: 300000 })]), 300), null);
  check('sans transcript_path : silence', muet(run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(rapports, 'r.md') } })), null);
  viderErreurs();
  const abs = run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(rapports, 'r.md') }, transcript_path: path.join(kit, 'nexiste-pas.jsonl') });
  check('transcript absent : silence', muet(abs), abs);
  const ill = run({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(rapports, 'r.md') }, transcript_path: dossier });
  check('transcript illisible (dossier) : silence, code 0, erreur journalisée', muet(ill) && /rappels/.test(erreurs()), [ill, erreurs()]);
  const sub = ecrit([asst(undefined, ctxUsage(1, 400000, 0))], { agent_id: 'a1' });
  check('agent_id présent : silence', muet(sub), sub);
}

// 6. C14-K : la mesure de modification. Le rapport lui-même ne compte pas ; Write, Edit et NotebookEdit hors du dossier du projet (cwd) non plus ;
//    git mv et sed -i comptent. LIMITE ASSUMÉE (dite dans rappels.js) : une modification faite par un script (node, python), une redirection ou
//    un outil externe n'est pas vue.
{
  const hors = path.join(kit, 'ailleurs', 'x.js'); const voisin = `${dossier}-voisin${path.sep}x.js`;
  for (const [nom, rows] of [['Write', [asst([use('Write', { file_path: hors, content: 'x' })])]], ['Edit', [asst([use('Edit', { file_path: hors, old_string: 'a', new_string: 'b' })])]],
    ['NotebookEdit', [asst([use('NotebookEdit', { notebook_path: path.join(kit, 'ailleurs', 'n.ipynb') })])]], ['Write dans un dossier voisin du projet (même préfixe)', [asst([use('Write', { file_path: voisin, content: 'x' })])]],
    ['Write vers le rapport lui-même (Edit du rapport)', [asst([use('Edit', { file_path: path.join(rapports, 'r.md'), old_string: 'a', new_string: 'b' })])]]]) {
    check(`C14-K hors du projet : ${nom} : ne compte pas comme modification, silence`, muet(envoi([...reqs(29), ...rows])), nom);
  }
  for (const [nom, rows] of [['Write dans un sous-dossier du projet', [asst([use('Write', { file_path: path.join(dossier, 'src', 'n.js'), content: 'x' })])]], ['Edit avec chemin en barres obliques', [asst([use('Edit', { file_path: path.join(dossier, 'a.js').replace(/\\/g, '/'), old_string: 'a', new_string: 'b' })])]],
    ['NotebookEdit dans le projet', [asst([use('NotebookEdit', { notebook_path: path.join(dossier, 'n.ipynb') })])]], ['Write à chemin relatif (résolu depuis le projet)', [asst([use('Write', { file_path: 'src/n.js', content: 'x' })])]]]) {
    check(`C14-K dans le projet : ${nom} : rappel`, enRetard(envoi([...reqs(29), ...rows]), 30), nom);
  }
  const sansCwd = run({ hook_event_name: 'UserPromptSubmit', prompt: 'suite', session_id: 's1', transcript_path: transcript([...reqs(29), asst([use('Write', { file_path: hors, content: 'x' })])]) });
  check('C14-K sans cwd dans l\'entrée : le projet est inconnu, le Write compte (pas de filtre)', enRetard(sansCwd, 30), sansCwd);
  for (const [nom, tool, cmd] of [['git mv (Bash)', 'Bash', 'git mv a.js b.js'], ['git -C … mv (PowerShell)', 'PowerShell', 'git -C . mv a.js b.js'], ['cd puis git mv', 'Bash', 'cd x && git mv a b'], ['sed -i', 'Bash', "sed -i 's/a/b/' f.txt"], ['sed -i.bak', 'Bash', "sed -i.bak 's/a/b/' f.txt"], ['sed -ie', 'Bash', "sed -ie 's/a/b/' f.txt"], ['sed --in-place', 'Bash', "sed --in-place 's/a/b/' f.txt"], ['sed -n puis sed -i', 'Bash', "sed -n 1p f && sed -i 's/a/b/' f"]]) {
    check(`C14-K commande qui compte : ${nom} : rappel`, enRetard(envoi([...reqs(29), asst([use(tool, { command: cmd })])]), 30), cmd);
  }
  for (const [nom, cmd] of [['git mv ressemblant (git log --grep mv)', 'git log --grep mv'], ['sed sans -i', "sed -n '1,5p' f.txt"], ['sed -e', "sed -e 's/a/b/' f.txt"], ['grep -i', 'grep -i x f.txt'], ['git add', 'git add -A']]) {
    check(`C14-K commande qui ne compte pas : ${nom} : silence`, muet(envoi([...reqs(29), asst([use('Bash', { command: cmd })])])), cmd);
  }
}

// 7. C14-L : seul un Write vers rapports réussi sert de repère (tool_use associé à son tool_result par id ; is_error l'écarte).
{
  const resultat = (id, erreur) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: erreur, content: erreur ? 'EPERM' : 'File created' }] } });
  const ecritAvec = (erreur, nom = 'r.md') => { const u = use('Write', { file_path: path.join(rapports, nom), content: 'x' }); return [asst([u]), resultat(u.id, erreur)]; };
  check('C14-L Write vers rapports échoué (is_error) : pas un repère, le rappel reste (modification, 30 requêtes ou plus)', enRetard(envoi([edit(), ...reqs(40), ...ecritAvec(true), ...reqs(2)]), 44), null);
  check('C14-L Write vers rapports réussi (is_error: false) : repère, silence', muet(envoi([edit(), ...reqs(40), ...ecritAvec(false), ...reqs(2)])), null);
  check('C14-L Write vers rapports sans tool_result (pas encore de réponse) : repère, comme avant', muet(envoi([edit(), ...reqs(40), ecritRapport(), ...reqs(2)])), null);
  check('C14-L Write réussi, 10 requêtes et une modification, puis Write échoué, 25 requêtes : le réussi reste le repère, rappel sur 37 requêtes', enRetard(envoi([edit(), ...reqs(40), ...ecritAvec(false), edit(), ...reqs(10), ...ecritAvec(true, 's.md'), ...reqs(25)]), 37), null);
}

// 8. C15 : le rappel « rapport en retard » se déclenche une fois au seuil (30 requêtes et une modification depuis le repère), puis ne revient qu'après
//    30 nouvelles requêtes avec une modification ; un rapport écrit avec succès réarme. Sans état : le hook rejoue l'historique prompt par prompt.
//    Chaque prompt marqué par P() est rejoué avec le vrai hook, une fois sans lui dans le transcript (il n'y est pas encore quand le hook tourne),
//    une fois avec lui : les deux résultats doivent être identiques. Une valeur = N annoncé (requêtes depuis le dernier rapport), ou null = silence.
{
  const marques = new Set(); const P = (t) => { const p = prompt(t); marques.add(p); return p; };
  const nAnnonce = (r) => { const m = r.ctx && /^rappel du kit \((\d+) requêtes depuis le dernier rapport\) : rapport en retard : écris-le avant d'enchaîner$/.exec(r.ctx); return m ? Number(m[1]) : r.ctx || r.out || r.err ? 'inattendu' : null; };
  const tirs = (rows) => { const sans = []; const avec = []; rows.forEach((r, k) => { if (!marques.has(r)) return; sans.push(nAnnonce(envoi(rows.slice(0, k)))); avec.push(nAnnonce(envoi(rows.slice(0, k + 1)))); }); return { sans, avec }; };
  const scenario = (nom, rows, attendu) => { const { sans, avec } = tirs(rows); const ok = JSON.stringify(sans) === JSON.stringify(attendu) && JSON.stringify(avec) === JSON.stringify(attendu); check(`C15 ${nom} : ${JSON.stringify(attendu)}`, ok, { attendu, sans, sansLePrompt: sans, avecLePrompt: avec }); };
  const resultat = (id, erreur) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: erreur, content: erreur ? 'EPERM' : 'File created' }] } });
  const ecritAvec = (erreur, nom = 'c15.md') => { const u = use('Write', { file_path: path.join(rapports, nom), content: 'x' }); return [asst([u]), resultat(u.id, erreur)]; };

  scenario('premier déclenchement au seuil (29 requêtes : silence, 30 : rappel)', [P(), edit(), ...reqs(28), P(), reqs(1)[0], P()], [null, null, 30]);
  scenario('silence aux prompts suivants', [P(), edit(), ...reqs(29), P(), ...reqs(2), P(), ...reqs(1), P(), P()], [null, 30, null, null, null]);
  scenario('retour après 30 nouvelles requêtes avec modification (29 : silence, 30 : rappel annoncé depuis le dernier rapport)', [P(), edit(), ...reqs(29), P(), edit(), ...reqs(28), P(), ...reqs(1), P()], [null, 30, null, 60]);
  scenario('pas de retour après 45 requêtes sans modification, puis le retour dès qu\'une modification arrive', [P(), edit(), ...reqs(29), P(), ...reqs(45), P(), edit(), P()], [null, 30, null, 76]);
  scenario('deuxième puis troisième déclenchement', [P(), edit(), ...reqs(29), P(), ...reqs(2), P(), edit(), ...reqs(27), P(), ...reqs(5), P(), ...reqs(24), edit(), P()], [null, 30, null, 60, null, 90]);
  scenario('réarmement dès qu\'un rapport est écrit : 14 requêtes après lui = silence (35 depuis le repère précédent), 30 = rappel', [P(), edit(), ...reqs(29), P(), ...reqs(20), ecritRapport(), edit(), ...reqs(13), P(), ...reqs(16), P()], [null, 30, null, 30]);
  scenario('le rapport réarme aussi avant le premier déclenchement', [P(), edit(), ...reqs(20), ecritRapport(), ...reqs(40), P(), edit(), P()], [null, null, 41]);
  scenario('Write de rapport en échec : ne réarme pas, le rappel revient 30 requêtes après le repère', [P(), edit(), ...reqs(29), P(), edit(), ...reqs(9), ...ecritAvec(true), ...reqs(19), P()], [null, 30, 60]);
  scenario('Write de rapport réussi au même endroit : réarme, silence', [P(), edit(), ...reqs(29), P(), edit(), ...reqs(9), ...ecritAvec(false), ...reqs(19), P()], [null, 30, null]);
  scenario('modification avant le repère ne compte pas pour la suite : 45 requêtes sans modification après le rappel, silence', [P(), edit(), ...reqs(29), P(), ...reqs(45), P()], [null, 30, null]);
  scenario('rapport sans tool_result encore (écriture en cours) : repère, silence', [P(), edit(), ...reqs(29), P(), ecritRapport(), edit(), ...reqs(5), P()], [null, 30, null]);
  // seuls les vrais prompts utilisateur sont des points d'évaluation : ni tool_result, ni résumé de compaction, ni message méta, ni notification de tâche, ni ligne de sous-agent.
  for (const [nom, ligneUser] of [['tool_result', resultat('toolu_x', false)], ['résumé de compaction', { type: 'user', isSidechain: false, isCompactSummary: true, message: { role: 'user', content: 'résumé' } }],
    ['message méta', { type: 'user', isSidechain: false, isMeta: true, message: { role: 'user', content: 'méta' } }], ['message méta d\'un pair', { type: 'user', isSidechain: false, isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: 'rapport du sous-agent' } }],
    ['notification de tâche (origin)', { type: 'user', isSidechain: false, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification> <task-id>a</task-id> </task-notification>' } }],
    ['notification de tâche (texte seul)', { type: 'user', isSidechain: false, message: { role: 'user', content: '<task-notification> <task-id>a</task-id> </task-notification>' } }],
    ['ligne de sous-agent', { type: 'user', isSidechain: true, message: { role: 'user', content: 'tâche du sous-agent' } }],
    ['contenu en blocs texte avec tool_result', { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'tool_result', tool_use_id: 'toolu_y', content: 'z' }] } }]]) {
    const r = envoi([edit(), ...reqs(29), ligneUser, ...reqs(2)]);
    check(`C15 ${nom} : pas un prompt, donc pas un point de déclenchement : le rappel tombe sur le prompt courant (N=32)`, enRetard(r, 32), r);
  }
  const bloc = envoi([edit(), ...reqs(29), { type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'avec image' }, { type: 'image', source: {} }] } }, ...reqs(2)]);
  check('C15 prompt en blocs (texte et image) : un vrai prompt, il déclenche à son tour (repère), le prompt courant se tait', muet(bloc), bloc);
  // le prompt courant : absent du transcript, ou déjà écrit (dernière ligne), ou précédé d'un prompt resté sans réponse.
  const present = envoi([edit(), ...reqs(29), prompt('autre texte que celui du hook')]);
  check('C15 prompt courant déjà écrit en dernière ligne (texte différent de input.prompt) : un seul déclenchement, N=30', enRetard(present, 30), present);
  const absentDuTranscript = envoi([edit(), ...reqs(29)]);
  check('C15 prompt courant absent du transcript : traité comme le dernier prompt, N=30', enRetard(absentDuTranscript, 30), absentDuTranscript);
  const deux = envoi([edit(), ...reqs(29), prompt('a'), ...reqs(3)], { prompt: 'b' });
  check('C15 le déclenchement tombé sur un prompt antérieur ne se répète pas sur le prompt courant', muet(deux), deux);
  // données absentes ou inutilisables
  check('C15 transcript sans aucune ligne assistant : silence', muet(envoi([prompt(), prompt()])), null);
  check('C15 transcript vide, prompt seul : silence', muet(envoi([prompt()])), null);
  viderErreurs();
  const sansMessage = envoi([edit(), ...reqs(29), { type: 'user' }, { type: 'user', message: null }, { type: 'user', message: { content: null } }, { type: 'user', message: { role: 'user' } }]);
  check('C15 lignes user sans message ou sans contenu : pas de plantage, aucune erreur journalisée', sansMessage.code === 0 && sansMessage.err === '' && erreurs() === '', [sansMessage, erreurs()]);
  const sansPrompt = run({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dossier, transcript_path: transcript([edit(), ...reqs(29)]) });
  check('C15 entrée sans champ prompt : le rappel se déclenche quand même (le repère ne dépend pas du texte)', enRetard(sansPrompt, 30), sansPrompt);
  // Une notification de tâche n'est pas un prompt : si Claude Code y déclenche le hook, il se tait, sinon le rappel se répéterait à chacune.
  const notifLigne = { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>fin</task-notification>' } };
  const parNotif = (debut = '') => run({ hook_event_name: 'UserPromptSubmit', prompt: `${debut}<task-notification>fin</task-notification>`, session_id: 's1', cwd: dossier, transcript_path: transcript([edit(), ...reqs(29), notifLigne]) });
  check('C15 hook lancé par une notification de tâche : silence, deux fois de suite', muet(parNotif()) && muet(parNotif()), null);
  check('C15 notification précédée d\'espaces et de sauts de ligne : silence', muet(parNotif(' \n  ')), null);
  const apresNotif = envoi([edit(), ...reqs(29), notifLigne, prompt()]);
  check('C15 le prompt humain qui suit une notification reçoit bien le rappel', enRetard(apresNotif, 30), apresNotif);
  const sansTranscript = run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 's1', cwd: dossier });
  check('C15 sans transcript_path : silence', muet(sansTranscript), sansTranscript);
  const nul = run({ hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 's1', cwd: dossier, transcript_path: null });
  check('C15 transcript_path null : silence', muet(nul), nul);
}


// 7. Retour de sous-agent, résumé de compaction, notification : jamais de rappel. Un vrai prompt : un rappel par fenêtre, même sous appels simultanés.
async function bloc7() {
  garder = true;
  const { spawn } = require('child_process');
  const peer = (id, t = '<agent-message from="w">[Subagent hand-back] fini</agent-message>') => ({ type: 'user', isMeta: true, promptId: id, origin: { kind: 'peer' }, message: { role: 'user', content: t } });
  const compact = (id) => ({ type: 'user', isCompactSummary: true, promptId: id, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } });
  const notif = (id) => ({ type: 'user', promptId: id, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>fin</task-notification>' } });
  const humain = (t, id) => ({ ...prompt(t), promptId: id, origin: { kind: 'human' } });
  const base = () => [edit(), ...reqs(29)];
  const payload = (session, rows, extra = {}) => ({ hook_event_name: 'UserPromptSubmit', prompt: 'vrai message', prompt_id: 'pid-x', session_id: session, cwd: dossier, transcript_path: transcript(rows), ...extra });
  // T1 : retour de sous-agent
  const formes = [['<agent-message from="w">[Subagent hand-back] fini</agent-message>', 'sans préfixe'], ['Another Claude session sent a message: <agent-message from="w">[Subagent hand-back] fini</agent-message>', 'avec préfixe'], ['  \n <agent-message from="w">x', 'précédé d\'espaces'], ['\tAnother Claude session sent a message: x', 'préfixe seul, espaces']];
  formes.forEach(([prompt, nom], i) => {
    const r = run(payload(`sT1-${i}`, base(), { prompt }));
    check(`T1 retour de sous-agent (${nom}) : silence`, muet(r), r);
    const apres = run(payload(`sT1-${i}`, base()));
    check(`T1 (${nom}) le silence ne consomme pas la fenêtre : le vrai prompt suivant reçoit le rappel`, enRetard(apres, 30), apres);
  });
  const parId = run(payload('sT1-id', [...base(), peer('p1')], { prompt: 'texte quelconque', prompt_id: 'p1' }));
  check('T1 ligne peer déjà écrite avec le même promptId que le payload : silence', muet(parId), parId);
  const parIdAvant = run(payload('sT1-id2', [...base(), peer('p1'), prompt('autre')], { prompt: 'texte quelconque', prompt_id: 'p1' }));
  check('T1 ligne peer avec le même promptId, suivie d\'une autre ligne : silence', muet(parIdAvant), parIdAvant);
  const autreId = run(payload('sT1-id3', [...base(), peer('p0')], { prompt: 'texte quelconque', prompt_id: 'p1' }));
  check('T1 ligne peer d\'un AUTRE promptId : le vrai prompt reçoit le rappel', enRetard(autreId, 30), autreId);
  // T2 : compaction et notification
  const c1 = run(payload('sT2-a', base(), { prompt: 'This session is being continued from a previous conversation that ran out of context.' }));
  check('T2 résumé de compaction (texte du prompt) : silence', muet(c1), c1);
  const c2 = run(payload('sT2-b', [...base(), compact('p2')], { prompt: 'autre', prompt_id: 'p2' }));
  check('T2 résumé de compaction (isCompactSummary, même promptId) : silence', muet(c2), c2);
  const n1 = run(payload('sT2-c', [...base(), notif('p3')], { prompt: 'autre', prompt_id: 'p3' }));
  check('T2 task-notification (même promptId) : silence', muet(n1), n1);
  const n2 = run(payload('sT2-d', [...base(), compact('p4'), peer('p4')], { prompt: 'autre', prompt_id: 'p4' }));
  check('T2 promptId partagé compaction + peer : silence', muet(n2), n2);
  // T3 : vrai prompt, une fois par fenêtre
  const rows3 = [...base(), humain('salut', 'pid-x')];
  const v1 = run(payload('sT3', rows3));
  check('T3 vrai prompt (origin human, avec promptId) : un rappel', enRetard(v1, 30), v1);
  const v2 = run(payload('sT3', rows3));
  check('T3 deuxième appel identique (même session, même historique) : silence', muet(v2), v2);
  const v3 = run(payload('sT3bis', rows3));
  check('T3 autre session, même historique : rappel (l\'état est par session)', enRetard(v3, 30), v3);
  const v4 = run(payload(undefined, base()));
  const v5 = run(payload(undefined, base()));
  check('T3 sans session_id : un rappel puis silence (clé « sans-session »)', enRetard(v4, 30) && muet(v5), [v4, v5]);
  // T4 : appels simultanés
  fs.rmSync(path.join(home, 'logs', 'rappels'), { recursive: true, force: true });
  const entree = JSON.stringify(payload('sT4', base()));
  const un = () => new Promise((ok) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'rappels.js')], { env: { ...process.env, KIT_HOME: home, KIT_RAPPORTS: rapports } });
    let out = ''; let err = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => ok({ code, out, err })); p.stdin.end(entree);
  });
  const res = await Promise.all(Array.from({ length: 8 }, un));
  const sorties = res.filter((r) => r.out !== '');
  check('T4 8 processus simultanés, même vrai prompt : exactement 1 rappel, tous code 0, aucune erreur', sorties.length === 1 && res.every((r) => r.code === 0 && r.err === '') && /rapport en retard/.test(sorties[0].out), res);
  // T5 : nouvelle fenêtre
  const ap = humain('un', 'pid-1');
  const b5 = base(); const m5 = [edit(), ...reqs(29)]; const m5b = [edit(), ...reqs(29)];
  const r5a = run(payload('sT5', [...b5, ap]));
  const r5b = run(payload('sT5', [...b5, ap, ...m5]));
  const r5c = run(payload('sT5', [...b5, ap, ...m5]));
  const r5d = run(payload('sT5', [...b5, ap, ...m5, humain('deux', 'pid-2'), ...m5b]));
  check('T5 rappel, puis 30 requêtes avec modification, puis vrai prompt : nouveau rappel ; identique ensuite : silence ; une troisième fenêtre : rappel', enRetard(r5a, 30) && enRetard(r5b, 60) && muet(r5c) && enRetard(r5d, 90), [r5a, r5b, r5c, r5d]);
  // erreur d'état : le dossier d'état est un fichier
  viderErreurs(); fs.mkdirSync(path.join(home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(home, 'logs', 'rappels'), 'je suis un fichier');
  const e = run(payload('sT6', base()));
  check('état non créable : silence, code 0, une ligne dans telemetrie-erreurs.log', muet(e) && /rappels/.test(erreurs()), [e, erreurs()]);
  garder = false;
}

bloc7().then(() => { fs.rmSync(kit, { recursive: true, force: true }); process.exit(fail); }, (e) => { console.log(`FAIL bloc7 : ${e && e.stack}`); fs.rmSync(kit, { recursive: true, force: true }); process.exit(1); });
