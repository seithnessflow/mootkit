#!/usr/bin/env node
// Test de hooks/profil.js, dans un dossier temporaire (KIT_HOME) : choix du profil (rythmes 0,3, 0,7, 1,2, bornes 0,5 et 0,9,
// sans données, reset passé, lignes nulles, ligne en retard d'une autre session, premier jour), hook SessionStart (génération,
// seconde génération sans écriture, compact, agent_id, autre session vivante, table invalide, forçage et retour en automatique,
// interrupteur « sans Fable » dans les trois profils et son retour) et la vraie table de profils (9 rôles x 3 profils, valeurs de la demande). Code 1 si un cas échoue.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawnSync } = require('child_process');
const { choisir } = require('./profil.js');
let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : ${JSON.stringify(got)}`}`); if (!ok) fail = 1; };

// 1. choisir(lignes, maintenant) : fonction pure. Semaine à moitié écoulée (fraction 0,5) : pct 15 -> 0,3 ; 35 -> 0,7 ; 60 -> 1,2.
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60000; const SEM = 7 * 86400;
const reset = (fraction) => NOW / 1000 + Math.round((1 - fraction) * SEM);
const L = (pct, fraction, minutes = 1, extra = {}) => ({ ts: new Date(NOW - minutes * MIN).toISOString(), five_hour: 3, seven_day: pct, seven_reset: reset(fraction), ...extra });
const r = (lignes, now = NOW) => choisir(lignes, now);
check('rythme 0,3 : max', r([L(15, 0.5)]).profil === 'max' && r([L(15, 0.5)]).rythme === 0.3, r([L(15, 0.5)]));
check('rythme 0,7 : normal', r([L(35, 0.5)]).profil === 'normal' && r([L(35, 0.5)]).rythme === 0.7, r([L(35, 0.5)]));
check('rythme 1,2 : eco', r([L(60, 0.5)]).profil === 'eco' && r([L(60, 0.5)]).rythme === 1.2, r([L(60, 0.5)]));
check('borne 0,5 : normal', r([L(25, 0.5)]).profil === 'normal', r([L(25, 0.5)]));
check('juste sous 0,5 : max', r([L(24, 0.5)]).profil === 'max', r([L(24, 0.5)]));
check('borne 0,9 : normal', r([L(45, 0.5)]).profil === 'normal', r([L(45, 0.5)]));
check('juste au-dessus de 0,9 : eco', r([L(46, 0.5)]).profil === 'eco', r([L(46, 0.5)]));
check('sans aucune ligne : normal, raison donnée', r([]).profil === 'normal' && r([]).rythme === null && /donnée/.test(r([]).raison), r([]));
check('lignes nulles ou sans reset : écartées, normal', r([L(null, 0.5), { ts: L(1, 0.5).ts, seven_day: 40 }, { seven_day: 40, seven_reset: reset(0.5) }]).profil === 'normal' && r([L(null, 0.5)]).rythme === null, r([L(null, 0.5)]));
check('reset passé : lignes périmées écartées, normal', r([L(60, 0.5, 1, { seven_reset: NOW / 1000 - 10 })]).profil === 'normal' && r([L(60, 0.5, 1, { seven_reset: NOW / 1000 })]).rythme === null, r([L(60, 0.5, 1, { seven_reset: NOW / 1000 - 10 })]));
check('une ligne périmée ne gêne pas une ligne valide', r([L(90, 0.5, 5, { seven_reset: NOW / 1000 - 10 }), L(15, 0.5, 1)]).profil === 'max', r([L(90, 0.5, 5, { seven_reset: NOW / 1000 - 10 }), L(15, 0.5, 1)]));
const retard = r([L(45, 0.5, 30), L(40, 0.5, 20), L(38, 0.5, 1)]); // la dernière ligne est celle d'une session en retard : 38 au lieu de 45
check('session en retard : pct = max de l\'heure avant la dernière ligne, pas la dernière ligne', retard.pct === 45 && retard.profil === 'normal', retard);
check('une ligne vieille de plus d\'une heure ne compte pas', r([L(80, 0.5, 120), L(15, 0.5, 1)]).pct === 15 && r([L(80, 0.5, 120), L(15, 0.5, 1)]).profil === 'max', r([L(80, 0.5, 120), L(15, 0.5, 1)]));
check('dernière ligne = plus récente par ts, pas par ordre du fichier', r([L(15, 0.5, 1), L(80, 0.5, 200)]).pct === 15, r([L(15, 0.5, 1), L(80, 0.5, 200)]));
const j1 = r([L(7, 0.1)]); const j1b = r([L(13, 0.1)]);
check('premier jour : fraction plancher 1/7 (7 % -> 0,49 max, 13 % -> 0,91 eco)', j1.fraction === 1 / 7 && j1.rythme === 0.49 && j1.profil === 'max' && j1b.rythme === 0.91 && j1b.profil === 'eco', [j1, j1b]);
check('fraction réelle au-dessus du plancher', r([L(15, 0.5)]).fraction === 0.5, r([L(15, 0.5)]));

// 2. Hook et commandes, dans un KIT_HOME jetable.
const TABLE = { _table: 'v5-test', scout: { eco: 'haiku low', normal: 'haiku low', max: 'haiku medium' }, architect: { eco: 'opus high', normal: 'opus xhigh', max: 'fable high' } };
const gabarit = (role) => `---\nname: ${role}\nmodel: {{model}}\neffort: {{effort}}\n---\nCorps de ${role}.\n`;
const homes = [];
function fresh(table = TABLE) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'profil-')); homes.push(home);
  for (const d of ['profils/gabarits', 'agents', 'logs', 'sessions']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'profils', 'profils.json'), JSON.stringify(table));
  for (const role of ['scout', 'architect']) fs.writeFileSync(path.join(home, 'profils', 'gabarits', `${role}.md`), gabarit(role));
  return home;
}
// Données hebdomadaires relatives à l'heure réelle : semaine à moitié écoulée, pct choisi (rythme = pct / 50).
function donnees(home, pct) {
  const now = Date.now();
  const row = { ts: new Date(now - 60000).toISOString(), five_hour: 3, seven_day: pct, seven_reset: Math.round(now / 1000 + 3.5 * 86400) };
  fs.writeFileSync(path.join(home, 'logs', 'ratelimits.jsonl'), pct === null ? '' : `${JSON.stringify(row)}\n`);
}
function run(home, args, input) {
  const p = spawnSync(process.execPath, [path.join(__dirname, 'profil.js'), ...args], { input: input === undefined ? '' : JSON.stringify(input), env: { ...process.env, KIT_HOME: home }, encoding: 'utf8' });
  let ctx = null; try { ctx = JSON.parse(p.stdout).hookSpecificOutput.additionalContext; } catch { /* sortie vide ou texte */ }
  return { code: p.status, out: p.stdout, err: p.stderr, ctx };
}
const demarre = (home, session = 's1', source = 'startup') => run(home, [], { session_id: session, source, hook_event_name: 'SessionStart', cwd: home });
const lit = (home, f) => fs.readFileSync(path.join(home, f), 'utf8');
const agent = (home, role) => lit(home, `agents/${role}.md`);
const etat = (home) => JSON.parse(lit(home, 'logs/profil-actif.json'));
const journal = (home) => (fs.existsSync(path.join(home, 'logs', 'profils.jsonl')) ? lit(home, 'logs/profils.jsonl').trim().split('\n').map((l) => JSON.parse(l)) : []);
const erreurs = (home) => (fs.existsSync(path.join(home, 'logs', 'telemetrie-erreurs.log')) ? lit(home, 'logs/telemetrie-erreurs.log') : '');

{ // démarrage en rythme 0,3 : agents générés en max, état, journal, contexte
  const h = fresh(); donnees(h, 15);
  const a = demarre(h);
  check('démarrage : code 0, sortie JSON additionalContext, jamais de decision', a.code === 0 && a.ctx && !/decision/i.test(a.out), a);
  check('démarrage rythme 0,3 : agents max générés, placeholders remplacés', agent(h, 'architect') === '---\nname: architect\nmodel: fable\neffort: high\n---\nCorps de architect.\n' && /model: haiku\neffort: medium/.test(agent(h, 'scout')), agent(h, 'architect'));
  const e = etat(h);
  check('état écrit : profil, mode, rythme, pct, fraction, raison, genere_a, session', e.profil === 'max' && e.mode === 'auto' && e.pct === 15 && Math.abs(e.rythme - 0.3) < 0.01 && Math.abs(e.fraction - 0.5) < 0.01 && e.session === 's1' && Date.parse(e.genere_a) > 0 && typeof e.raison === 'string', e);
  check('contexte : profil actif, mode, rythme à virgule', /profil actif : max \(auto, rythme 0,30\)/.test(a.ctx), a.ctx);
  check('journal : une ligne avec voulu et appliqué', journal(h).length === 1 && journal(h)[0].voulu === 'max' && journal(h)[0].applique === 'max' && journal(h)[0].session === 's1' && journal(h)[0].source === 'startup', journal(h));
  // seconde génération : mêmes données, rien ne s'écrit dans agents/ (mtime ancien conservé) et genere_a ne bouge pas
  const vieux = new Date(Date.now() - 3600 * 1000);
  for (const role of ['scout', 'architect']) fs.utimesSync(path.join(h, 'agents', `${role}.md`), vieux, vieux);
  const ga = etat(h).genere_a;
  const b = demarre(h, 's2');
  check('seconde génération sans écriture : mtime des agents inchangés, genere_a conservé', ['scout', 'architect'].every((x) => Math.abs(fs.statSync(path.join(h, 'agents', `${x}.md`)).mtimeMs - vieux.getTime()) < 2000) && etat(h).genere_a === ga && etat(h).session === 's2', [b, etat(h)]);
  // rythme 0,7 puis 1,2 : le profil suit
  donnees(h, 35); demarre(h, 's3');
  check('rythme 0,7 : normal appliqué', etat(h).profil === 'normal' && /model: opus\neffort: xhigh/.test(agent(h, 'architect')), etat(h));
  donnees(h, 60); demarre(h, 's4');
  check('rythme 1,2 : eco appliqué', etat(h).profil === 'eco' && /model: opus\neffort: high/.test(agent(h, 'architect')), etat(h));
  // compact : réinjecte le profil sans rien recalculer ni écrire
  donnees(h, 15); const etatAvant = lit(h, 'logs/profil-actif.json'); const lignes = journal(h).length;
  const c = demarre(h, 's4', 'compact');
  check('compact : profil réinjecté, rien recalculé ni écrit', /profil actif : eco/.test(c.ctx) && lit(h, 'logs/profil-actif.json') === etatAvant && /effort: high/.test(agent(h, 'architect')) && journal(h).length === lignes, [c, etat(h)]);
  // agent_id : un sous-agent ne déclenche rien
  const g = run(h, [], { session_id: 'sa', source: 'startup', agent_id: 'a1' });
  check('agent_id présent : aucune sortie, rien d\'écrit', g.code === 0 && g.out === '' && lit(h, 'logs/profil-actif.json') === etatAvant && journal(h).length === lignes, g);
}
{ // sans données et fichier absent
  const h = fresh(); donnees(h, null);
  const a = demarre(h);
  check('sans données : normal', etat(h).profil === 'normal' && etat(h).rythme === null && /profil actif : normal \(auto\)/.test(a.ctx), [a.ctx, etat(h)]);
  const h2 = fresh(); fs.rmSync(path.join(h2, 'logs'), { recursive: true, force: true });
  const b = demarre(h2);
  check('ratelimits.jsonl absent : normal, code 0, pas d\'erreur', b.code === 0 && etat(h2).profil === 'normal' && erreurs(h2) === '', [b, erreurs(h2)]);
}
{ // calcul : n'écrit rien
  const h = fresh(); donnees(h, 15);
  const c = run(h, ['calcul']);
  check('calcul : affiche le profil et le rythme, n\'écrit ni agents ni état ni journal', c.code === 0 && /max/.test(c.out) && /0[.,]3/.test(c.out) && !fs.existsSync(path.join(h, 'logs', 'profil-actif.json')) && fs.readdirSync(path.join(h, 'agents')).length === 0 && journal(h).length === 0, c);
}
{ // autre session vivante : profil voulu différé ; session morte ou même sessionId : appliqué
  const h = fresh(); donnees(h, 15); demarre(h, 's1');
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'autre', cwd: h, kind: 'interactive' }));
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.abc.key`), 'x');
  donnees(h, 60);
  const avant = [lit(h, 'agents/architect.md'), lit(h, 'logs/profil-actif.json')];
  const d = demarre(h, 's2');
  check('autre session vivante : aucune écriture, état hérité, « profil voulu eco différé »', lit(h, 'agents/architect.md') === avant[0] && lit(h, 'logs/profil-actif.json') === avant[1] && /profil actif : max/.test(d.ctx) && /profil voulu eco différé/.test(d.ctx), [d.ctx, etat(h)]);
  const jr = journal(h).pop();
  check('autre session vivante : tracé dans profils.jsonl (voulu eco, appliqué max)', jr.voulu === 'eco' && jr.applique === 'max' && /autre session/.test(jr.raison), jr);
  fs.rmSync(path.join(h, 'agents', 'scout.md'));
  demarre(h, 's2');
  check('autre session vivante, rôle manquant : généré quand même, sans changer de profil', /model: haiku\neffort: medium/.test(lit(h, 'agents/scout.md')) && lit(h, 'agents/architect.md') === avant[0], lit(h, 'agents/scout.md'));
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's2', cwd: h }));
  demarre(h, 's2');
  check('le fichier de session est celui de la session courante : appliqué', etat(h).profil === 'eco', etat(h));
  const mort = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.rmSync(path.join(h, 'sessions', `${process.pid}.json`));
  fs.writeFileSync(path.join(h, 'sessions', `${mort}.json`), JSON.stringify({ pid: Number(mort), sessionId: 'morte', cwd: h }));
  donnees(h, 15); demarre(h, 's3');
  check('autre session dont le pid est mort : ignorée, profil appliqué', etat(h).profil === 'max', etat(h));
}
{ // table invalide : aucune écriture, erreur journalisée et injectée, code 0
  const h = fresh(); donnees(h, 15); demarre(h);
  const avant = [lit(h, 'agents/architect.md'), lit(h, 'agents/scout.md'), lit(h, 'logs/profil-actif.json')];
  donnees(h, 60);
  const mauvais = [['valeur sans effort', { ...TABLE, architect: { ...TABLE.architect, eco: 'opus' } }], ['modèle inconnu', { ...TABLE, scout: { ...TABLE.scout, eco: 'gpt low' } }], ['profil absent', { ...TABLE, scout: { eco: 'haiku low', normal: 'haiku low' } }], ['rôle sans gabarit', { ...TABLE, inconnu: TABLE.scout }]];
  for (const [nom, table] of mauvais) {
    fs.writeFileSync(path.join(h, 'profils', 'profils.json'), JSON.stringify(table));
    const a = demarre(h, 's9');
    check(`table invalide (${nom}) : agents et état inchangés, erreur injectée et journalisée, code 0`, a.code === 0 && lit(h, 'agents/architect.md') === avant[0] && lit(h, 'agents/scout.md') === avant[1] && lit(h, 'logs/profil-actif.json') === avant[2] && /profil/.test(a.ctx || '') && /échec|invalide/.test(a.ctx || '') && /profil/.test(erreurs(h)), [a, erreurs(h)]);
  }
  fs.writeFileSync(path.join(h, 'profils', 'profils.json'), '{ pas du json');
  const b = demarre(h, 's9');
  check('table illisible : même comportement', b.code === 0 && lit(h, 'agents/architect.md') === avant[0] && /échec|invalide/.test(b.ctx || ''), b);
  fs.writeFileSync(path.join(h, 'profils', 'profils.json'), JSON.stringify(TABLE));
  fs.writeFileSync(path.join(h, 'profils', 'gabarits', 'scout.md'), '---\nname: scout\nmodel: haiku\n---\n');
  const c = demarre(h, 's9');
  check('gabarit sans {{model}} ni {{effort}} : refusé sans rien écrire', c.code === 0 && lit(h, 'agents/scout.md') === avant[1] && /échec|invalide/.test(c.ctx || ''), c);
}
{ // forçage en langage libre -> commandes ; il survit aux sessions ; retour en automatique
  const h = fresh(); donnees(h, 15); demarre(h, 's1');
  const f = run(h, ['force', 'eco']);
  check('force eco : agents eco, mode force, code 0', f.code === 0 && etat(h).profil === 'eco' && etat(h).mode === 'force' && /model: opus\neffort: high/.test(agent(h, 'architect')), [f, etat(h)]);
  const d = demarre(h, 's2');
  check('forçage conservé au démarrage suivant malgré un rythme de 0,3', etat(h).profil === 'eco' && etat(h).mode === 'force' && /profil actif : eco \(forcé\)/.test(d.ctx), [d.ctx, etat(h)]);
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'autre', cwd: h }));
  const m = run(h, ['force', 'max']);
  check('force avec une autre session vivante : appliqué quand même et signalé', etat(h).profil === 'max' && etat(h).mode === 'force' && /autre session/.test(m.out), [m.out, etat(h)]);
  const x = run(h, ['force', 'turbo']);
  check('force avec un profil inconnu : refusé, rien changé, code 0', x.code === 0 && etat(h).profil === 'max' && /inconnu|invalide/.test(x.out), [x.out, etat(h)]);
  donnees(h, 60);
  const a = run(h, ['auto']);
  check('auto : retour au calcul (rythme 1,2 -> eco), mode auto', a.code === 0 && etat(h).mode === 'auto' && etat(h).profil === 'eco' && /model: opus\neffort: high/.test(agent(h, 'architect')), [a, etat(h)]);
  check('forçages et retour tracés dans profils.jsonl', journal(h).filter((l) => l.source === 'force' || l.source === 'auto').length >= 3, journal(h));
  const g = run(h, ['genere', 'normal']);
  check('genere normal : agents normal, mode inchangé', g.code === 0 && /model: opus\neffort: xhigh/.test(agent(h, 'architect')) && etat(h).mode === 'auto', [g, etat(h)]);
}
{ // clone neuf : agents/ vide, un rôle manquant déclenche la génération
  const h = fresh(); donnees(h, 35); fs.rmSync(path.join(h, 'agents'), { recursive: true, force: true });
  const a = demarre(h);
  check('agents/ absent : dossier recréé, rôles générés', a.code === 0 && fs.existsSync(path.join(h, 'agents', 'scout.md')) && etat(h).profil === 'normal', a);
}
{ // C14-G : source resume = compact (profil réinjecté, rien recalculé) ; startup, clear et fork recalculent
  const h = fresh(); donnees(h, 15); demarre(h, 's1');
  donnees(h, 60);
  const etatAvant = lit(h, 'logs/profil-actif.json'); const archAvant = agent(h, 'architect'); const nj = journal(h).length;
  const r1 = demarre(h, 's1', 'resume');
  check('resume : profil réinjecté (max), rien recalculé ni écrit malgré un rythme de 1,2 (état, agents, journal)', /profil actif : max/.test(r1.ctx || '') && lit(h, 'logs/profil-actif.json') === etatAvant && agent(h, 'architect') === archAvant && journal(h).length === nj, [r1, etat(h)]);
  const r2 = demarre(h, 's2', 'clear');
  check('clear : recalcule (rythme 1,2 -> eco)', etat(h).profil === 'eco' && /profil actif : eco/.test(r2.ctx || '') && journal(h).length === nj + 1 && journal(h).pop().source === 'clear', [r2, etat(h)]);
  donnees(h, 15); const r3 = demarre(h, 's3', 'fork');
  check('fork : recalcule (rythme 0,3 -> max)', etat(h).profil === 'max' && /profil actif : max/.test(r3.ctx || '') && journal(h).pop().source === 'fork', [r3, etat(h)]);
  donnees(h, 35); const r4 = demarre(h, 's4', 'startup');
  check('startup : recalcule (rythme 0,7 -> normal)', etat(h).profil === 'normal' && /profil actif : normal/.test(r4.ctx || '') && journal(h).pop().source === 'startup', [r4, etat(h)]);
  donnees(h, 60); const avantR = [lit(h, 'logs/profil-actif.json'), journal(h).length];
  const r5 = demarre(h, 's4', 'resume');
  check('resume après recalculs : profil de l\'état (normal), pas du rythme du moment', /profil actif : normal/.test(r5.ctx || '') && lit(h, 'logs/profil-actif.json') === avantR[0] && journal(h).length === avantR[1], [r5, etat(h)]);
}
{ // C14-H : un agents/<rôle>.md qui ne correspond à aucun des 3 rendus est déplacé dans _a_supprimer/<date>/agents/ avant écriture, jamais écrasé
  const h = fresh(); donnees(h, 15); demarre(h, 's1');
  const supprimes = () => { const d = path.join(h, '_a_supprimer'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((j) => fs.readdirSync(path.join(d, j, 'agents')).map((f) => path.join(d, j, 'agents', f))) : []; };
  const rendu = agent(h, 'scout'); const retouche = `${rendu}Ma retouche à la main.\n`;
  fs.writeFileSync(path.join(h, 'agents', 'scout.md'), retouche);
  const a = demarre(h, 's2');
  check('retouche : le fichier est régénéré', agent(h, 'scout') === rendu, agent(h, 'scout'));
  check('retouche : l\'ancien contenu est dans _a_supprimer/<AAAA-MM-JJ_HHhMM>/agents/scout.md, intact', supprimes().length === 1 && /_a_supprimer[\\/]\d{4}-\d\d-\d\d_\d\dh\d\d[\\/]agents[\\/]scout\.md$/.test(supprimes()[0]) && fs.readFileSync(supprimes()[0], 'utf8') === retouche, supprimes());
  check('retouche : signalée dans additionalContext (rôle et dossier)', /scout/.test(a.ctx || '') && /_a_supprimer/.test(a.ctx || '') && /déplac/.test(a.ctx || ''), a.ctx);
  const jr = journal(h).pop();
  check('retouche : signalée dans logs/profils.jsonl (rôle, destination)', Array.isArray(jr.deplaces) && jr.deplaces.length === 1 && jr.deplaces[0].role === 'scout' && /_a_supprimer/.test(jr.deplaces[0].vers), jr);
  // nom déjà pris dans la même minute : suffixe, rien d'écrasé
  const retouche2 = `${rendu}Deuxième retouche.\n`;
  fs.writeFileSync(path.join(h, 'agents', 'scout.md'), retouche2);
  demarre(h, 's3');
  const s2 = supprimes();
  check('nom déjà pris : second fichier avec suffixe, le premier n\'est pas écrasé', s2.length === 2 && new Set(s2).size === 2 && s2.map((f) => fs.readFileSync(f, 'utf8')).sort().join('|') === [retouche, retouche2].sort().join('|') && s2.some((f) => /scout-2\.md$/.test(f)), s2);
  // contenu d'un autre profil : remplacé sans déplacement ni signalement
  const h2 = fresh(); donnees(h2, 60); demarre(h2, 'x'); const eco = agent(h2, 'architect');
  fs.writeFileSync(path.join(h, 'agents', 'architect.md'), eco);
  const nbAvant = supprimes().length; const lignesAvant = journal(h).length;
  const b = demarre(h, 's4');
  check('contenu d\'un autre profil (eco) : remplacé par le rendu max, sans déplacement', agent(h, 'architect') === '---\nname: architect\nmodel: fable\neffort: high\n---\nCorps de architect.\n' && supprimes().length === nbAvant && !/déplac/.test(b.ctx || '') && !('deplaces' in journal(h).pop()) && journal(h).length === lignesAvant + 1, [b.ctx, supprimes()]);
  // les trois rendus sont reconnus (normal aussi)
  const h3 = fresh(); donnees(h3, 35); demarre(h3, 'y'); const normal = agent(h3, 'scout');
  fs.writeFileSync(path.join(h, 'agents', 'scout.md'), normal);
  const n0 = supprimes().length; demarre(h, 's5');
  check('contenu du profil normal : remplacé sans déplacement', agent(h, 'scout') === rendu && supprimes().length === n0, supprimes());
  // fichier absent : généré, rien déplacé ; commande genere : même règle que le hook
  fs.rmSync(path.join(h, 'agents', 'architect.md'));
  const n1 = supprimes().length; demarre(h, 's6');
  check('fichier absent : généré sans déplacement', fs.existsSync(path.join(h, 'agents', 'architect.md')) && supprimes().length === n1, supprimes());
  fs.writeFileSync(path.join(h, 'agents', 'architect.md'), 'retouche de architect\n');
  const g = run(h, ['genere', 'max']);
  check('commande genere : retouche déplacée et signalée dans la sortie', supprimes().length === n1 + 1 && /architect/.test(g.out) && /déplac/.test(g.out) && agent(h, 'architect').includes('model: fable'), [g.out, supprimes()]);
  // autre session vivante : la génération « rôle manquant seulement » n'écrase ni ne déplace une retouche
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'autre', cwd: h }));
  donnees(h, 60); fs.writeFileSync(path.join(h, 'agents', 'scout.md'), 'retouche différée\n');
  const n2 = supprimes().length; demarre(h, 's7');
  check('autre session vivante : une retouche reste en place (profil différé), rien déplacé', lit(h, 'agents/scout.md') === 'retouche différée\n' && supprimes().length === n2, supprimes());
}
{ // C14b-D : erreur de lecture, exception pendant l'application, nouvelle tentative (vrais cas du système de fichiers, aucune injection)
  const supprimes = (h) => { const d = path.join(h, '_a_supprimer'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((j) => fs.readdirSync(path.join(d, j, 'agents')).map((f) => path.join(d, j, 'agents', f))) : []; };
  // 1. agents/scout.md illisible autrement que par ENOENT (ici un dossier : EISDIR) : jamais écrit, laissé en place, signalé ; les autres agents sont appliqués
  const h = fresh(); donnees(h, 15); demarre(h, 's1'); donnees(h, 60);
  fs.rmSync(path.join(h, 'agents', 'scout.md')); fs.mkdirSync(path.join(h, 'agents', 'scout.md')); fs.writeFileSync(path.join(h, 'agents', 'scout.md', 'x.txt'), 'DANS_LE_DOSSIER\n');
  const a = demarre(h, 's2');
  check('C14b-D lecture en erreur (EISDIR) : le fichier est laissé en place, rien n\'est écrit à sa place ni déplacé', fs.statSync(path.join(h, 'agents', 'scout.md')).isDirectory() && lit(h, 'agents/scout.md/x.txt') === 'DANS_LE_DOSSIER\n' && supprimes(h).length === 0, [a, supprimes(h)]);
  check('C14b-D lecture en erreur : signalée (rôle, code) dans le contexte et dans le journal ; code 0', a.code === 0 && /scout/.test(a.ctx || '') && /illisible/.test(a.ctx || '') && /EISDIR/.test(a.ctx || '') && !/agents inchangés/.test(a.ctx || '') && JSON.stringify(journal(h).pop().illisibles || []).includes('EISDIR'), [a.ctx, journal(h).pop()]);
  check('C14b-D lecture en erreur : les autres agents sont appliqués (architect passé en eco)', /model: opus\neffort: high/.test(agent(h, 'architect')) && etat(h).profil === 'eco', agent(h, 'architect'));
  // 2. exception pendant l'application : scout est rendu, architect (retouché, en lecture seule) échoue à l'écriture ; deplaces et le fait ne se perdent pas
  const h2 = fresh(); donnees(h2, 15); demarre(h2, 's1');
  const sonde = path.join(h2, 'sonde.txt'); fs.writeFileSync(sonde, 'x'); fs.chmodSync(sonde, 0o444); let ecritureBloquee = false; try { fs.writeFileSync(sonde, 'y'); } catch { ecritureBloquee = true; } fs.chmodSync(sonde, 0o666);
  if (!ecritureBloquee) console.log('SKIP C14b-D exception pendant l\'application : un fichier en lecture seule reste inscriptible ici (administrateur ?), cas non testé');
  else {
    const rendu = agent(h2, 'scout'); const retS = `${rendu}Retouche scout.\n`; const retA = `${agent(h2, 'architect')}Retouche architect.\n`;
    fs.writeFileSync(path.join(h2, 'agents', 'scout.md'), retS); fs.writeFileSync(path.join(h2, 'agents', 'architect.md'), retA); fs.chmodSync(path.join(h2, 'agents', 'architect.md'), 0o444);
    const b = demarre(h2, 's2'); const jr = journal(h2).pop() || {};
    check('C14b-D exception pendant l\'application : code 0, scout rendu, architect resté en place', b.code === 0 && agent(h2, 'scout') === rendu && agent(h2, 'architect') === retA, [b, agent(h2, 'architect')]);
    check('C14b-D exception : le journal (finally) garde deplaces des deux retouches, l\'erreur et ce qui a été écrit', jr.deplaces && jr.deplaces.map((d) => d.role).sort().join() === 'architect,scout' && /EPERM|EACCES/.test(JSON.stringify(jr.erreur || '')) && JSON.stringify(jr.ecrits || []).includes('scout'), jr);
    check('C14b-D exception : le message dit ce qui a été fait (scout, déplacements), jamais « agents inchangés »', /scout/.test(b.ctx || '') && /déplac/.test(b.ctx || '') && !/agents inchangés/.test(b.ctx || '') && /échec/.test(b.ctx || ''), b.ctx);
    check('C14b-D exception : les deux retouches sont sauvées intactes dans _a_supprimer', supprimes(h2).map((f) => fs.readFileSync(f, 'utf8')).sort().join('|') === [retS, retA].sort().join('|'), supprimes(h2));
    // 3. nouvelle tentative : le contenu déjà sauvé à l'identique n'est pas recopié en -2
    fs.chmodSync(path.join(h2, 'agents', 'architect.md'), 0o666);
    const c = demarre(h2, 's3');
    check('C14b-D nouvelle tentative : architect rendu', c.code === 0 && /model: fable\neffort: high/.test(agent(h2, 'architect')), c);
    check('C14b-D nouvelle tentative : rien recopié en -2, -3 (toujours deux fichiers sauvés)', supprimes(h2).length === 2 && !supprimes(h2).some((f) => /-\d\.md$/.test(f)), supprimes(h2));
  }
  // contenu déjà sauvé à l'identique dans un autre dossier daté : pas recopié non plus
  const h3 = fresh(); donnees(h3, 15); demarre(h3, 's1'); const ret3 = `${agent(h3, 'scout')}Déjà sauvée.\n`;
  fs.mkdirSync(path.join(h3, '_a_supprimer', '2020-01-01_00h00', 'agents'), { recursive: true }); fs.writeFileSync(path.join(h3, '_a_supprimer', '2020-01-01_00h00', 'agents', 'scout.md'), ret3);
  fs.writeFileSync(path.join(h3, 'agents', 'scout.md'), ret3); const d = demarre(h3, 's2');
  check('C14b-D contenu déjà sauvé à l\'identique (autre date) : rendu régénéré, aucune seconde copie, signalé', supprimes(h3).length === 1 && /model: haiku\neffort: medium/.test(agent(h3, 'scout')) && /scout/.test(d.ctx || '') && /déplac/.test(d.ctx || ''), [supprimes(h3), d.ctx]);
  // retouche différente du contenu déjà sauvé : sauvée, suffixe
  fs.writeFileSync(path.join(h3, 'agents', 'scout.md'), `${ret3}et autre chose\n`); demarre(h3, 's3');
  check('C14b-D contenu différent de ce qui est sauvé : copié à part, rien d\'écrasé', supprimes(h3).length === 2 && supprimes(h3).some((f) => fs.readFileSync(f, 'utf8') === `${ret3}et autre chose\n`), supprimes(h3));
}
{ // Hash des fichiers générés : retouche à la main = le fichier diffère de ce que le générateur a écrit la dernière fois
  const crypto = require('crypto'); const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const ficheHash = (h) => path.join(h, 'logs', 'agents-generes.json');
  const sauves = (h) => { const out = []; const base = path.join(h, '_a_supprimer'); if (!fs.existsSync(base)) return out; for (const j of fs.readdirSync(base)) { const d = path.join(base, j, 'agents'); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) out.push(path.join(d, f)); } return out; };
  const aDeplaces = (h) => journal(h).some((l) => l.deplaces && l.deplaces.length);
  const modifieGabarit = (h, role) => fs.writeFileSync(path.join(h, 'profils', 'gabarits', `${role}.md`), `${gabarit(role)}Ligne ajoutée au gabarit.\n`);
  const ancien = (role) => `---\nname: ${role}\nmodel: haiku\neffort: medium\n---\nAncien corps de ${role}.\n`;

  // T1 : gabarit modifié, fichier intact -> mis à jour sans déplacement
  const h1 = fresh(); run(h1, ['genere', 'max']); modifieGabarit(h1, 'scout');
  const t1 = run(h1, ['genere', 'max']);
  check('T1 gabarit modifié, fichier non retouché : agent mis à jour', /Ligne ajoutée au gabarit\./.test(agent(h1, 'scout')) && t1.code === 0, [t1.out, agent(h1, 'scout')]);
  check('T1 aucun déplacement : rien dans _a_supprimer, pas de deplaces dans le journal ni dans le message', sauves(h1).length === 0 && !fs.existsSync(path.join(h1, '_a_supprimer')) && !aDeplaces(h1) && !/déplac/.test(t1.out), [sauves(h1), journal(h1), t1.out]);

  // T2 : retouche à la main -> déplacée et signalée
  const h2 = fresh(); run(h2, ['genere', 'max']); const retouche = `${agent(h2, 'scout')}Retouche manuelle.\n`;
  fs.writeFileSync(path.join(h2, 'agents', 'scout.md'), retouche);
  const t2 = run(h2, ['genere', 'max']);
  check('T2 retouche à la main : copie dans _a_supprimer/…/agents avec le contenu retouché', sauves(h2).length === 1 && fs.readFileSync(sauves(h2)[0], 'utf8') === retouche && /_a_supprimer/.test(sauves(h2)[0]), sauves(h2));
  check('T2 signalée (message et profils.jsonl deplaces), agent régénéré', /scout/.test(t2.out) && /déplac/.test(t2.out) && aDeplaces(h2) && journal(h2).some((l) => (l.deplaces || []).some((d) => d.role === 'scout')) && agent(h2, 'scout') === '---\nname: scout\nmodel: haiku\neffort: medium\n---\nCorps de scout.\n', [t2.out, journal(h2)]);

  // T3 : premier lancement sans agents-generes.json
  const h3 = fresh(); fs.writeFileSync(path.join(h3, 'agents', 'scout.md'), ancien('scout'));
  fs.writeFileSync(path.join(h3, 'agents', 'architect.md'), '---\nname: architect\nmodel: opus\neffort: high\n---\nCorps de architect.\n'); // rendu eco actuel
  const t3 = run(h3, ['genere', 'max']);
  check('T3 premier lancement : contenu d\'un ancien gabarit déplacé et signalé', sauves(h3).length === 1 && fs.readFileSync(sauves(h3)[0], 'utf8') === ancien('scout') && /scout/.test(t3.out) && /déplac/.test(t3.out), [sauves(h3), t3.out]);
  check('T3 premier lancement : rendu actuel d\'un autre profil remplacé sans déplacement', !sauves(h3).some((f) => /architect/.test(path.basename(f))) && /model: fable\neffort: high/.test(agent(h3, 'architect')) && !(journal(h3).flatMap((l) => l.deplaces || [])).some((d) => d.role === 'architect'), [sauves(h3), journal(h3)]);
  let st3 = null; try { st3 = JSON.parse(lit(h3, 'logs/agents-generes.json')); } catch { /* absent */ }
  check('T3 agents-generes.json : un sha256 par rôle égal au hash du fichier écrit', !!st3 && ['scout', 'architect'].every((r) => st3[r] === sha(agent(h3, r)) && /^[0-9a-f]{64}$/.test(st3[r])), st3);

  // T4 : fichier d'état corrompu
  const h4 = fresh(); fs.writeFileSync(ficheHash(h4), 'ceci n\'est pas du JSON {{{'); fs.writeFileSync(path.join(h4, 'agents', 'scout.md'), ancien('scout'));
  const t4 = run(h4, ['genere', 'max']);
  check('T4 état corrompu : pas d\'exception, règle du premier lancement (ancien déplacé)', t4.code === 0 && erreurs(h4) === '' && !/échec/.test(t4.out) && sauves(h4).length === 1 && fs.readFileSync(sauves(h4)[0], 'utf8') === ancien('scout') && /déplac/.test(t4.out), [t4.out, erreurs(h4), sauves(h4)]);
  let st4 = null; try { st4 = JSON.parse(lit(h4, 'logs/agents-generes.json')); } catch { /* invalide */ }
  check('T4 état réparé : hash du fichier écrit', !!st4 && st4.scout === sha(agent(h4, 'scout')), st4);

  // T5 : gabarit modifié ET hash enregistré, mais fichier retouché
  const h5 = fresh(); run(h5, ['genere', 'max']); modifieGabarit(h5, 'scout'); run(h5, ['genere', 'max']);
  const ret5 = `${agent(h5, 'scout')}Ma retouche.\n`; fs.writeFileSync(path.join(h5, 'agents', 'scout.md'), ret5); modifieGabarit(h5, 'architect');
  const t5 = run(h5, ['genere', 'max']);
  check('T5 retouche + gabarit modifié : déplacée et signalée, le gabarit ne la masque pas', sauves(h5).length === 1 && fs.readFileSync(sauves(h5)[0], 'utf8') === ret5 && aDeplaces(h5) && /déplac/.test(t5.out), [sauves(h5), t5.out]);
  check('T5 architect (non retouché, gabarit modifié) : mis à jour sans déplacement', /Ligne ajoutée/.test(agent(h5, 'architect')) && !sauves(h5).some((f) => /architect/.test(path.basename(f))), sauves(h5));
}
{ // Version de la table (clé _table de profils.json) : dans l'état et sur chaque ligne de profils.jsonl, pour séparer l'avant et l'après d'un changement de table au bilan
  // (sortie de Fable 5.2 et benchmarks par effort, 2026-11-09). C'est la version de la table qui a généré les agents en place.
  const h = fresh(); donnees(h, 15); demarre(h, 's1');
  check('version de table : dans profil-actif.json et sur la ligne de démarrage ; _table n\'est pas un rôle (pas de agents/_table.md)', etat(h).table === 'v5-test' && journal(h).pop().table === 'v5-test' && JSON.stringify(fs.readdirSync(path.join(h, 'agents')).sort()) === '["architect.md","scout.md"]', [etat(h), journal(h), fs.readdirSync(path.join(h, 'agents'))]);
  // la table change pendant qu'une autre session vit : la ligne différée porte la version des agents en place, pas la nouvelle
  fs.writeFileSync(path.join(h, 'profils', 'profils.json'), JSON.stringify({ ...TABLE, _table: 'v5-suivante' }));
  fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'autre', cwd: h, kind: 'interactive' }));
  donnees(h, 60); demarre(h, 's2'); const dif = journal(h).pop();
  check('version de table : profil différé (autre session vivante), la ligne porte la version des agents en place', /autre session/.test(dif.raison) && dif.table === 'v5-test' && etat(h).table === 'v5-test', dif);
  fs.rmSync(path.join(h, 'sessions', `${process.pid}.json`)); demarre(h, 's3');
  check('version de table : à la génération suivante, l\'état et la ligne portent la nouvelle version', etat(h).table === 'v5-suivante' && journal(h).pop().table === 'v5-suivante' && etat(h).profil === 'eco', [etat(h), journal(h).pop()]);
  // table sans _table (ou _table qui n'est pas un texte) : la génération marche, la version est nulle, la clé reste présente
  const { _table, ...sans } = TABLE;
  for (const [nom, t] of [['absente', sans], ['pas un texte', { ...sans, _table: { v: 5 } }], ['vide', { ...sans, _table: '' }]]) {
    const h2 = fresh(t); donnees(h2, 15); const d = demarre(h2, 's1'); const l = journal(h2).pop() || {};
    check(`version de table ${nom} : agents générés, version nulle dans l'état et sur la ligne`, d.code === 0 && /model: fable/.test(agent(h2, 'architect')) && etat(h2).table === null && 'table' in l && l.table === null, [d.out, l]);
  }
  // chaque ligne écrite par tous les cas de ce fichier porte la clé ; chaque sorte de ligne est couverte avec la version du test
  const toutes = homes.flatMap((x) => journal(x));
  const sortes = { startup: (l) => l.source === 'startup' && !/autre session/.test(l.raison || ''), differe: (l) => /autre session/.test(l.raison || ''), force: (l) => l.source === 'force', auto: (l) => l.source === 'auto', genere: (l) => l.source === 'genere', echec: (l) => l.applique === 'échec', deplaces: (l) => Array.isArray(l.deplaces) };
  check('version de table : la clé table est sur chaque ligne de profils.jsonl de tous les cas', toutes.length > 40 && toutes.every((l) => 'table' in l && (l.table === null || typeof l.table === 'string')), toutes.filter((l) => !('table' in l)).slice(0, 3));
  const manque = Object.entries(sortes).filter(([, f]) => !toutes.some((l) => f(l) && l.table === 'v5-test')).map((x) => x[0]);
  check('version de table : chaque sorte de ligne (démarrage, différé, force, auto, genere, échec, retouche déplacée) porte la version', manque.length === 0, manque);
}
{ // Fable 5.2 : l'effort max ne s'utilise jamais ; une table qui le porte est invalide, rien n'est écrit
  const h = fresh({ ...TABLE, scout: { eco: 'haiku low', normal: 'haiku low', max: 'haiku max' } });
  const g = run(h, ['genere', 'max']);
  check('table avec un effort max : profil invalide, aucun agent écrit', /profil : échec, agents inchangés \(profil invalide : scout\/max = "haiku max"\)/.test(g.out) && !fs.existsSync(path.join(h, 'agents', 'scout.md')) && !fs.existsSync(path.join(h, 'agents', 'architect.md')), [g.out, fs.readdirSync(path.join(h, 'agents'))]);
  // même refus au démarrage d'une session, pour un effort max dans un profil qui n'est pas le profil choisi : la table se valide en entier
  const h2 = fresh({ ...TABLE, architect: { eco: 'opus high', normal: 'opus max', max: 'fable high' } }); donnees(h2, 15);
  const d = demarre(h2, 's1');
  check('table avec un effort max, au démarrage d\'une session : profil invalide injecté, code 0, aucun agent ni état écrit', d.code === 0 && /profil : échec, agents inchangés \(profil invalide : architect\/normal = "opus max"\)/.test(d.ctx || '') && fs.readdirSync(path.join(h2, 'agents')).length === 0 && !fs.existsSync(path.join(h2, 'logs', 'profil-actif.json')), [d.out, fs.readdirSync(path.join(h2, 'agents'))]);
}
{ // Interrupteur « sans Fable » (limite Fable séparée constatée le 2026-11-10) : `fable coupe` rend opus (même effort) à la place de fable ; `fable autorise` revient.
  // L'état (sans_fable) survit aux démarrages, à force et à auto comme le mode force ; seule la commande `fable` le change.
  const TF = { _table: 'v5-test', scout: { eco: 'haiku low', normal: 'haiku low', max: 'haiku medium' }, architect: { eco: 'fable medium', normal: 'fable low', max: 'fable xhigh' } };
  const EFF = { eco: 'medium', normal: 'low', max: 'xhigh' };
  const arch = (h) => { let t = ''; try { t = agent(h, 'architect'); } catch { /* absent */ } const m = t.match(/\nmodel: (\S+)\neffort: (\S+)\n/); return m ? `${m[1]} ${m[2]}` : null; };
  const vivante = (h, id = 'autre') => fs.writeFileSync(path.join(h, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, cwd: h, kind: 'interactive' }));
  for (const p of ['eco', 'normal', 'max']) {
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1'); run(h, ['force', p]);
    const scoutAvant = agent(h, 'scout');
    check(`sans Fable ${p} : avant la coupure, architect sur fable ${EFF[p]}`, arch(h) === `fable ${EFF[p]}` && etat(h).sans_fable === false, [arch(h), etat(h)]);
    const c = run(h, ['fable', 'coupe']); const jc = journal(h).pop();
    check(`sans Fable ${p} : fable coupe -> architect sur opus au même effort, scout inchangé, profil et mode inchangés, état sans_fable vrai`, c.code === 0 && arch(h) === `opus ${EFF[p]}` && agent(h, 'scout') === scoutAvant && etat(h).sans_fable === true && etat(h).profil === p && etat(h).mode === 'force', [c.out, arch(h), etat(h)]);
    check(`sans Fable ${p} : fable coupe -> sortie avec l'annonce`, /sans Fable/.test(c.out), c.out);
    check(`sans Fable ${p} : fable coupe -> dernière ligne du journal : source fable, sans_fable vrai, table v5-test`, jc.source === 'fable' && jc.sans_fable === true && jc.table === 'v5-test', jc);
    const s2 = demarre(h, 's2');
    check(`sans Fable ${p} : le démarrage suivant garde opus et annonce « sans Fable »`, arch(h) === `opus ${EFF[p]}` && etat(h).sans_fable === true && /sans Fable/.test(s2.ctx || '') && journal(h).pop().sans_fable === true, [s2.ctx, arch(h), etat(h)]);
    const a = run(h, ['fable', 'autorise']); const ja = journal(h).pop();
    check(`sans Fable ${p} : fable autorise -> architect revient sur fable au même effort, sans_fable faux, profil et mode inchangés`, a.code === 0 && arch(h) === `fable ${EFF[p]}` && etat(h).sans_fable === false && etat(h).profil === p && etat(h).mode === 'force' && ja.source === 'fable' && ja.sans_fable === false, [a.out, arch(h), etat(h), ja]);
    const s3 = demarre(h, 's3');
    check(`sans Fable ${p} : après autorise, plus d'annonce « sans Fable » au démarrage`, !/sans Fable/.test(s3.ctx || '') && !/sans Fable/.test(a.out) && etat(h).sans_fable === false && arch(h) === `fable ${EFF[p]}`, [s3.ctx, a.out]);
  }
  { // survit à force vers un autre profil et à auto
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1'); run(h, ['force', 'eco']); run(h, ['fable', 'coupe']);
    run(h, ['force', 'max']);
    check('sans Fable : survit à force max (architect opus xhigh, sans_fable vrai)', arch(h) === 'opus xhigh' && etat(h).sans_fable === true && etat(h).profil === 'max', [arch(h), etat(h)]);
    donnees(h, 60); run(h, ['auto']);
    check('sans Fable : survit à auto (rythme 1,2 -> eco, architect opus medium, sans_fable vrai, mode auto)', arch(h) === 'opus medium' && etat(h).sans_fable === true && etat(h).mode === 'auto' && etat(h).profil === 'eco', [arch(h), etat(h)]);
    run(h, ['genere', 'normal']);
    check('sans Fable : survit à genere normal (opus low)', arch(h) === 'opus low' && etat(h).sans_fable === true, [arch(h), etat(h)]);
  }
  { // sans état valide : la commande prend le profil calculé
    const h = fresh(TF); donnees(h, 15);
    const c = run(h, ['fable', 'coupe']);
    let e0 = {}; try { e0 = etat(h); } catch { /* état absent */ }
    check('sans Fable sans état préalable : profil calculé (rythme 0,3 -> max), mode auto, architect opus xhigh', e0.profil === 'max' && e0.mode === 'auto' && e0.sans_fable === true && arch(h) === 'opus xhigh', [c.out, e0]);
  }
  { // autre session vivante : appliqué quand même et signalé ; la ligne différée porte sans_fable
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1'); vivante(h);
    const c = run(h, ['fable', 'coupe']);
    check('sans Fable avec une autre session vivante : appliqué quand même et signalé', arch(h) === 'opus xhigh' && etat(h).sans_fable === true && /autre session/.test(c.out), [c.out, arch(h), etat(h)]);
    donnees(h, 60); const d = demarre(h, 's2'); const jd = journal(h).pop();
    check('sans Fable : la ligne différée d\'un démarrage porte sans_fable (valeur de l\'état en place) et l\'annonce suit', /autre session/.test(jd.raison) && jd.sans_fable === true && /sans Fable/.test(d.ctx || ''), [jd, d.ctx]);
    run(h, ['fable', 'autorise']); donnees(h, 60); const d2 = demarre(h, 's3'); const jd2 = journal(h).pop();
    check('sans Fable faux : la ligne différée porte sans_fable faux', /autre session/.test(jd2.raison) && jd2.sans_fable === false && !/sans Fable/.test(d2.ctx || ''), [jd2, d2.ctx]);
  }
  { // argument inconnu ou absent : dit, rien écrit
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1');
    const avant = [lit(h, 'logs/profil-actif.json'), lit(h, 'logs/profils.jsonl'), agent(h, 'architect'), agent(h, 'scout')];
    for (const args of [['fable', 'bidule'], ['fable']]) {
      const x = run(h, args);
      check(`fable ${args[1] || '(sans argument)'} : « argument inconnu », rien écrit (état, journal, agents)`, x.code === 0 && /argument inconnu/.test(x.out) && /coupe ou autorise/.test(x.out) && lit(h, 'logs/profil-actif.json') === avant[0] && lit(h, 'logs/profils.jsonl') === avant[1] && agent(h, 'architect') === avant[2] && agent(h, 'scout') === avant[3], [x.out, etat(h)]);
    }
    const y = run(h, ['fable', 'bidule']);
    check('fable bidule : la sortie nomme l\'argument', y.out.trim() === 'argument inconnu : bidule (coupe ou autorise)', y.out);
  }
  { // sans hash : un rendu dans l'autre position de l'interrupteur n'est pas une retouche
    const supprime = (h) => fs.existsSync(path.join(h, '_a_supprimer'));
    const h = fresh(TF); donnees(h, 15); run(h, ['genere', 'max']);
    fs.rmSync(path.join(h, 'logs', 'agents-generes.json'), { force: true });
    const c = run(h, ['fable', 'coupe']);
    check('sans hash : rendu avec Fable en place puis fable coupe -> ni _a_supprimer ni champ deplaces', arch(h) === 'opus xhigh' && !supprime(h) && !('deplaces' in journal(h).pop()) && !/déplac/.test(c.out), [c.out, journal(h).pop()]);
    fs.rmSync(path.join(h, 'logs', 'agents-generes.json'), { force: true });
    const a = run(h, ['fable', 'autorise']);
    check('sans hash : rendu sans Fable en place puis fable autorise -> ni _a_supprimer ni champ deplaces', arch(h) === 'fable xhigh' && journal(h).pop().source === 'fable' && !supprime(h) && !('deplaces' in journal(h).pop()) && !/déplac/.test(a.out), [a.out, journal(h).pop()]);
    // une vraie retouche reste déplacée, dans les deux positions
    fs.rmSync(path.join(h, 'logs', 'agents-generes.json'), { force: true });
    fs.writeFileSync(path.join(h, 'agents', 'architect.md'), `${agent(h, 'architect')}Ma retouche.\n`);
    run(h, ['fable', 'coupe']);
    check('sans hash : une vraie retouche reste déplacée', supprime(h) && Array.isArray(journal(h).pop().deplaces), journal(h).pop());
  }
  { // état ancien sans le champ : traité comme faux
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1');
    const e = etat(h); delete e.sans_fable; fs.writeFileSync(path.join(h, 'logs', 'profil-actif.json'), JSON.stringify(e));
    const d = demarre(h, 's2');
    check('état ancien sans sans_fable : traité comme faux (architect sur fable, pas d\'annonce, champ écrit à faux)', arch(h) === 'fable xhigh' && etat(h).sans_fable === false && !/sans Fable/.test(d.ctx || ''), [arch(h), etat(h), d.ctx]);
  }
  { // compact et resume réinjectent l'annonce
    const h = fresh(TF); donnees(h, 15); demarre(h, 's1');
    const sans = demarre(h, 's1', 'compact');
    run(h, ['fable', 'coupe']);
    const co = demarre(h, 's1', 'compact'); const re = demarre(h, 's1', 'resume');
    check('compact et resume réinjectent l\'annonce « sans Fable » ; rien quand l\'interrupteur est faux', /sans Fable/.test(co.ctx || '') && /sans Fable/.test(re.ctx || '') && !/sans Fable/.test(sans.ctx || ''), [sans.ctx, co.ctx, re.ctx]);
    check('annonce sans Fable : texte exact', (co.ctx || '').includes(' ; sans Fable (demandé par l\'utilisateur) : rôles Fable sur Opus, même effort, jusqu\'à « Fable autorisé »'), co.ctx);
  }
  const toutesF = homes.flatMap((x) => journal(x));
  check('sans Fable : le booléen sans_fable est sur chaque ligne de profils.jsonl de tous les cas, au moins une vraie et une fausse', toutesF.length > 40 && toutesF.every((l) => typeof l.sans_fable === 'boolean') && toutesF.some((l) => l.sans_fable === true) && toutesF.some((l) => l.sans_fable === false), toutesF.filter((l) => typeof l.sans_fable !== 'boolean').slice(0, 3));
}
for (const h of homes) fs.rmSync(h, { recursive: true, force: true });

// 3. La vraie table : 9 rôles x 3 profils, valeurs de la demande à l'identique (table adaptée à Fable 5.2 : sortie de Fable 5.2 et benchmarks par effort, 2026-11-09).
// ===== POINT 1 (table v5-fable52d) : valeurs, version, eco sans Fable, boucle « sans Fable ». Incident : incohérences de la table relevées le 2026-11-12. =====
const DEMANDE = {
  scout: ['haiku low', 'haiku medium', 'sonnet medium'], verifier: ['haiku medium', 'haiku high', 'sonnet medium'],
  researcher: ['sonnet medium', 'fable low', 'fable medium'], 'reviewer-tests': ['sonnet medium', 'sonnet high', 'opus medium'],
  'reviewer-securite': ['sonnet medium', 'opus medium', 'opus high'], analyste: ['sonnet medium', 'sonnet high', 'opus high'],
  worker: ['sonnet medium', 'opus medium', 'opus high'], architect: ['opus high', 'fable medium', 'fable high'], conseil: ['opus medium', 'fable medium', 'fable xhigh'],
};
let reelle = null; try { reelle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profils', 'profils.json'), 'utf8')); } catch (e) { reelle = { erreur: String(e) }; }
const rolesReels = Object.keys(reelle).filter((k) => k !== '_table');
check('vraie table : 9 rôles, trois profils chacun', rolesReels.length === 9 && rolesReels.every((k) => JSON.stringify(Object.keys(reelle[k])) === '["eco","normal","max"]'), reelle);
check('vraie table : version v5-fable52d (clé _table)', reelle._table === 'v5-fable52d', reelle._table);
const ecarts = Object.entries(DEMANDE).flatMap(([role, v]) => ['eco', 'normal', 'max'].filter((p, i) => (reelle[role] || {})[p] !== v[i]).map((p) => `${role}/${p}`));
check('vraie table : les 27 valeurs sont celles de la demande', ecarts.length === 0, ecarts);
const doc = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
const horsDoc = Object.entries(DEMANDE).filter(([role, v]) => !doc.includes(`| ${role} | ${v.join(' | ')} |`)).map((x) => x[0]);
check('CLAUDE.md : la table des rôles reprend les trois profils de profils.json', horsDoc.length === 0, horsDoc);
// Fable 5.2 : en eco, aucun Fable, sans exception (v5-fable52d : le conseil y passe sur Opus) ; l'effort max nulle part. Chaque contrôle est aussi passé sur une table fautive, qu'il doit voir.
const fableEco = (t) => Object.entries(t).filter(([role, v]) => role !== '_table' && v && /^fable\b/.test(String(v.eco))).map((x) => x[0]);
const effortMax = (t) => Object.entries(t).flatMap(([role, v]) => ['eco', 'normal', 'max'].filter((p) => role !== '_table' && v && /\smax$/.test(String(v[p]))).map((p) => `${role}/${p}`));
check('vraie table : en eco, aucun Fable, sans exception, conseil compris (conseil eco = opus medium ; le contrôle voit un worker eco sur Fable et un conseil eco sur Fable)', fableEco(reelle).length === 0 && (reelle.conseil || {}).eco === 'opus medium' && fableEco({ ...reelle, worker: { eco: 'fable low' } }).join() === 'worker' && fableEco({ ...reelle, conseil: { eco: 'fable high' } }).join() === 'conseil', fableEco(reelle));
// limite Fable séparée constatée le 2026-11-10 : le worker ne passe plus par Fable (opus high en max)
check('vraie table : Fable en normal et en max pour researcher et architect, worker jamais sur Fable', ['researcher', 'architect', 'worker'].map((r) => ['eco', 'normal', 'max'].map((p) => (/^fable\b/.test(String((reelle[r] || {})[p])) ? 'F' : '-')).join('')).join() === '-FF,-FF,---', [reelle.researcher, reelle.architect, reelle.worker]);
check('vraie table : aucun effort max (le contrôle voit un « opus max »)', effortMax(reelle).length === 0 && effortMax({ scout: { eco: 'haiku low', normal: 'opus max', max: 'haiku low' } }).join() === 'scout/normal', effortMax(reelle));

// ===== POINT 2 (règles) : Fable réservé, escalade du worker, relance (b) de l'architect, effort max interdit, « sans Fable ». Incident : incohérences de la table relevées le 2026-11-12. =====
// Les règles de CLAUDE.md sont ici des fonctions, appliquées à la vraie table profil par profil ; chaque fonction est aussi passée sur des cas limites (xhigh, haiku, fable) qu'elle doit refuser.
const PROFS = ['eco', 'normal', 'max'];
const EFFORTS_T = ['low', 'medium', 'high', 'xhigh']; // l'effort max ne s'utilise jamais
const parse = (v) => String(v).split(' ');
const cran = (e) => EFFORTS_T[EFFORTS_T.indexOf(e) + 1] || null; // null : déjà en xhigh, plus de cran
// (c) escalade du worker : sonnet -> opus au même effort (eco) ; déjà sur Opus : même modèle, effort d'un cran ; sinon (haiku, fable, opus xhigh) : pas d'escalade prévue (null)
const escaladeWorker = (v) => { const [m, e] = parse(v); return m === 'sonnet' ? `opus ${e}` : m === 'opus' && cran(e) ? `opus ${cran(e)}` : null; };
// (b) relance de l'architect : même modèle, effort d'un cran ; déjà en xhigh : pas de relance (null), on prévient l'utilisateur
const relanceArchitect = (v) => { const [m, e] = parse(v); return cran(e) ? `${m} ${cran(e)}` : null; };
// « sans Fable » : fable <effort> devient opus <effort>, le reste est inchangé
const sansFableRegle = (v) => { const [m, e] = parse(v); return m === 'fable' ? `opus ${e}` : String(v); };
// Fable réservé aux rôles de raisonnement, de planification et de recherche : researcher, architect, conseil
const fableHorsReserve = (t) => Object.entries(t).filter(([role, v]) => role !== '_table' && v && PROFS.some((p) => /^fable\b/.test(String(v[p]))) && !['researcher', 'architect', 'conseil'].includes(role)).map((x) => x[0]);
check('règle : Fable réservé à researcher, architect, conseil, jamais au worker (le contrôle voit un reviewer-tests et un worker sur Fable)', fableHorsReserve(reelle).length === 0 && fableHorsReserve({ ...reelle, 'reviewer-tests': { eco: 'sonnet medium', normal: 'fable low', max: 'fable low' } }).join() === 'reviewer-tests' && fableHorsReserve({ ...reelle, worker: { eco: 'sonnet medium', normal: 'opus medium', max: 'fable high' } }).join() === 'worker', fableHorsReserve(reelle));
const ESC_W = { eco: 'opus medium', normal: 'opus high', max: 'opus xhigh' }; const REL_A = { eco: 'opus xhigh', normal: 'fable high', max: 'fable xhigh' };
for (const p of PROFS) {
  const ew = escaladeWorker((reelle.worker || {})[p]); const ra = relanceArchitect((reelle.architect || {})[p]);
  check(`règle, profil ${p} : escalade du worker ${(reelle.worker || {})[p]} -> ${ESC_W[p]}`, ew === ESC_W[p], ew);
  check(`règle, profil ${p} : relance (b) de l'architect ${(reelle.architect || {})[p]} -> ${REL_A[p]}`, ra === REL_A[p], ra);
  const [mw, ew2] = parse(ew); const [, ea] = parse(ra);
  check(`règle, profil ${p} : aucun résultat d'escalade en effort max ni hors des efforts permis, aucun worker sur fable`, EFFORTS_T.includes(ew2) && EFFORTS_T.includes(ea) && ew2 !== 'max' && ea !== 'max' && mw !== 'fable' && !/^fable\b/.test(String(ew)), [ew, ra]);
}
check('règle : cas limites des fonctions (xhigh : pas de cran ; worker haiku ou fable : pas d\'escalade ; l\'effort ne saute jamais à max)', cran('xhigh') === null && escaladeWorker('opus xhigh') === null && relanceArchitect('fable xhigh') === null && escaladeWorker('haiku low') === null && escaladeWorker('fable high') === null && cran('high') === 'xhigh' && cran('medium') === 'high' && cran('low') === 'medium' && [...EFFORTS_T].every((e) => cran(e) !== 'max'), [escaladeWorker('opus xhigh'), relanceArchitect('fable xhigh')]);
{ // « sans Fable » sur la vraie table : aucun fable, l'effort gardé, tout le reste inchangé
  const sans = Object.fromEntries(Object.entries(reelle).filter(([k]) => k !== '_table').map(([role, v]) => [role, PROFS.map((p) => sansFableRegle(v[p]))]));
  const fautifs = Object.entries(sans).filter(([role, v]) => v.some((x, i) => /^fable\b/.test(x) || parse(x)[1] !== parse(reelle[role][PROFS[i]])[1] || (parse(reelle[role][PROFS[i]])[0] !== 'fable' && x !== reelle[role][PROFS[i]]))).map((x) => x[0]);
  check('règle : « sans Fable » remplace fable <effort> par opus <effort> sur toute la table (researcher opus low/medium, architect opus medium/high, conseil opus medium/xhigh), le reste inchangé', fautifs.length === 0 && sans.researcher.join() === 'sonnet medium,opus low,opus medium' && sans.architect.join() === 'opus high,opus medium,opus high' && sans.conseil.join() === 'opus medium,opus medium,opus xhigh' && sansFableRegle('fable high') === 'opus high' && sansFableRegle('haiku low') === 'haiku low', [fautifs, sans]);
}

// ===== POINT 3 (cohérence) : coherence(table) renvoie la liste des fautes. Incident : incohérences de la table relevées le 2026-11-12. =====
// (r1) sur chaque ligne, d'eco à max, le modèle ne descend jamais de gamme (haiku < sonnet < opus < fable) et, à modèle égal, l'effort ne descend jamais (low < medium < high < xhigh) ;
// (r2) d'un profil au suivant, le modèle ne monte pas de plus d'une gamme, sauf le rôle researcher (sonnet -> fable). La validation de profil.js n'est pas touchée : la cohérence se teste ici seulement.
const GAMMES = ['haiku', 'sonnet', 'opus', 'fable'];
function coherence(table) {
  const fautes = [];
  for (const [role, v] of Object.entries(table)) {
    if (role === '_table') continue;
    const cases = PROFS.map((p) => parse((v || {})[p]));
    if (cases.some(([m, e, ...reste]) => GAMMES.indexOf(m) < 0 || EFFORTS_T.indexOf(e) < 0 || reste.length)) { fautes.push(`invalide ${role} : ${PROFS.map((p) => (v || {})[p]).join(' | ')}`); continue; }
    for (let i = 0; i < 2; i++) {
      const [ma, ea] = cases[i]; const [mb, eb] = cases[i + 1]; const ga = GAMMES.indexOf(ma); const gb = GAMMES.indexOf(mb);
      const trajet = `${role} ${PROFS[i]} -> ${PROFS[i + 1]} : ${ma} ${ea} -> ${mb} ${eb}`;
      if (gb < ga) fautes.push(`r1 le modèle descend de gamme, ${trajet}`);
      else if (gb === ga && EFFORTS_T.indexOf(eb) < EFFORTS_T.indexOf(ea)) fautes.push(`r1 l'effort descend à modèle égal, ${trajet}`);
      if (gb - ga > 1 && !(role === 'researcher' && ma === 'sonnet' && mb === 'fable')) fautes.push(`r2 le modèle monte de plus d'une gamme, ${trajet}`);
    }
  }
  return fautes;
}
const regles = (t) => coherence(t).map((f) => f.split(' ')[0]).join();
check('cohérence : la vraie table n\'a aucune faute', coherence(reelle).length === 0, coherence(reelle));
const fr1 = coherence({ x: { eco: 'opus high', normal: 'sonnet high', max: 'opus high' } }); const fr1b = coherence({ y: { eco: 'sonnet high', normal: 'sonnet medium', max: 'sonnet high' } });
check('cohérence r1 : un rôle opus high | sonnet high | opus high est refusé (r1, le modèle descend, rôle nommé), sans r2', regles({ x: { eco: 'opus high', normal: 'sonnet high', max: 'opus high' } }) === 'r1' && /^r1 /.test(fr1[0]) && /x eco -> normal/.test(fr1[0]), fr1);
check('cohérence r1 : à modèle égal, un effort qui baisse (sonnet high | sonnet medium | sonnet high) est refusé (r1)', regles({ y: { eco: 'sonnet high', normal: 'sonnet medium', max: 'sonnet high' } }) === 'r1' && /y eco -> normal/.test(fr1b[0]), fr1b);
check('cohérence r1 : un modèle qui monte avec un effort plus bas (sonnet high | opus medium | opus high) n\'est pas une faute', coherence({ z: { eco: 'sonnet high', normal: 'opus medium', max: 'opus high' } }).length === 0, coherence({ z: { eco: 'sonnet high', normal: 'opus medium', max: 'opus high' } }));
const fr2 = coherence({ w: { eco: 'haiku medium', normal: 'opus medium', max: 'opus high' } });
check('cohérence r2 : haiku medium | opus medium | opus high est refusé (r2, saut de gamme), sans r1', regles({ w: { eco: 'haiku medium', normal: 'opus medium', max: 'opus high' } }) === 'r2' && /w eco -> normal/.test(fr2[0]), fr2);
check('cohérence r2 : l\'exception researcher (sonnet -> fable) ne s\'étend pas à un autre rôle (worker sonnet medium | fable low | fable medium refusé en r2)', regles({ worker: { eco: 'sonnet medium', normal: 'fable low', max: 'fable medium' } }) === 'r2' && coherence({ researcher: { eco: 'sonnet medium', normal: 'fable low', max: 'fable medium' } }).length === 0, [coherence({ worker: { eco: 'sonnet medium', normal: 'fable low', max: 'fable medium' } }), coherence({ researcher: { eco: 'sonnet medium', normal: 'fable low', max: 'fable medium' } })]);
check('cohérence r2 : l\'exception researcher est étroite (researcher haiku -> fable reste refusé en r2)', regles({ researcher: { eco: 'haiku low', normal: 'fable low', max: 'fable medium' } }) === 'r2', [coherence({ researcher: { eco: 'haiku low', normal: 'fable low', max: 'fable medium' } })]);
check('cohérence : une valeur illisible ou un effort max est signalé (jamais accepté en silence)', coherence({ q: { eco: 'opus', normal: 'opus high', max: 'opus high' } }).length === 1 && coherence({ q: { eco: 'opus high', normal: 'opus high', max: 'opus max' } }).length === 1, [coherence({ q: { eco: 'opus', normal: 'opus high', max: 'opus high' } })]);

// 4. Les vrais gabarits : tous les rôles x tous les profils, et non-régression de `genere normal` contre la v4 (a096bed), octet pour octet.
const RACINE = path.join(__dirname, '..');
const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'profil-kit-'));
fs.cpSync(path.join(RACINE, 'profils'), path.join(kit, 'profils'), { recursive: true });
const gab = fs.existsSync(path.join(kit, 'profils', 'gabarits')) ? fs.readdirSync(path.join(kit, 'profils', 'gabarits')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
check('gabarits : un fichier par rôle de la table, sans autre', JSON.stringify(gab) === JSON.stringify(Object.keys(DEMANDE).sort()), gab);
const generes = {};
for (const p of ['eco', 'normal', 'max']) {
  const g = run(kit, ['genere', p]);
  generes[p] = Object.fromEntries(Object.keys(DEMANDE).map((role) => { try { return [role, fs.readFileSync(path.join(kit, 'agents', `${role}.md`), 'utf8')]; } catch { return [role, null]; } }));
  const faux = Object.entries(DEMANDE).filter(([role, v]) => { const [m, e] = v[['eco', 'normal', 'max'].indexOf(p)].split(' '); const c = generes[p][role]; return !c || !c.includes(`\nmodel: ${m}\neffort: ${e}\n`) || c.includes('{{') || c.includes('\r') || !c.startsWith(`---\nname: ${role}\n`); });
  check(`genere ${p} : 9 rôles, model et effort de la table, ni {{ ni CRLF`, g.code === 0 && faux.length === 0 && Object.keys(DEMANDE).length === 9, [g.out, faux.map((f) => f[0])]);
}
// limite Fable séparée constatée le 2026-11-10 : le worker généré en max est sur opus high, et chaque ligne du journal porte la version de la table
check('genere max : le worker généré contient model: opus et effort: high', typeof generes.max.worker === 'string' && generes.max.worker.includes('\nmodel: opus\neffort: high\n'), generes.max.worker);
const lignesKit = fs.existsSync(path.join(kit, 'logs', 'profils.jsonl')) ? fs.readFileSync(path.join(kit, 'logs', 'profils.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('journal de la copie du kit : chaque ligne de profils.jsonl porte table v5-fable52d', lignesKit.length >= 3 && lignesKit.every((l) => l.table === 'v5-fable52d'), lignesKit.map((l) => l.table));
let etatKit = {}; try { etatKit = JSON.parse(fs.readFileSync(path.join(kit, 'logs', 'profil-actif.json'), 'utf8')); } catch { /* état absent : le check échoue */ }
check('état de la copie du kit : profil-actif.json porte table v5-fable52d (telemetrie.js la recopie sur agents.jsonl et sessions.jsonl)', etatKit.table === 'v5-fable52d', etatKit);
let base = null; try { base = Object.fromEntries(Object.keys(DEMANDE).map((role) => [role, require('child_process').execFileSync('git', ['show', `a096bed:agents/${role}.md`], { cwd: RACINE, stdio: ['ignore', 'pipe', 'ignore'] })])); } catch { /* historique sans a096bed */ }
if (!base) console.log('SKIP non-régression v4 : commit a096bed absent de cet historique, cas non testé');
else {
  // Seul analyste reste identique octet pour octet à la v4. Les huit autres rôles changent à la demande de l'utilisateur : architect (plan en amont, C12),
  // conseil (écritures bornées, C13, mention "v": 5), puis la table v5-fable52d et l'audit du 2026-11-13 (ligne suivante). Pour eux, chaque ligne v4 reste, sauf les lignes nommées ici, à l'exact préfixe près.
  // v5-fable52d : le profil normal change aussi pour scout (effort low -> medium), verifier (medium -> high), reviewer-tests (medium -> high), worker (sonnet high -> opus medium) et conseil (effort high -> medium) ; audit des prompts du 2026-11-13 : reviewer-tests, reviewer-securite, architect, scout et researcher perdent aussi des lignes de format v4 (nommées ci-dessous). Huit rôles changent ; seul analyste reste identique à la v4.
  const CHANGES = { researcher: ['model: sonnet', 'effort: medium', '## Format (40 lignes au plus)'], architect: ['description: Regard neuf en lecture seule', 'model: opus', 'effort: xhigh', '## Format (40 lignes au plus)', '- [CRITIQUE|MAJEUR|MINEUR] fichier:ligne — constat — scénario concret — quoi faire   (5 points au plus)'], conseil: ['description: Regard extérieur, lancé seulement', '- Lecture seule : Bash sert à lire', 'Lis ~/.claude/CLAUDE.md', 'effort: high'], scout: ['effort: low', '## Format (25 lignes au plus)'], verifier: ['effort: medium'], 'reviewer-tests': ['effort: medium', '(6 points au plus, du plus grave au moins grave)'], 'reviewer-securite': ['(6 points au plus, du plus grave au moins grave)'], worker: ['model: sonnet', 'effort: high'] }; // C14-J : la description (ligne 3) est la ligne ajoutée
  const diff = Object.keys(DEMANDE).filter((role) => !CHANGES[role] && (generes.normal[role] === null || !Buffer.from(generes.normal[role], 'utf8').equals(base[role])));
  check('non-régression : genere normal identique octet pour octet à agents/*.md de a096bed, hors les huit rôles changés (researcher, architect, conseil, scout, verifier, reviewer-tests, worker : modèle ou effort v5-fable52d ; reviewer-securite : format, audit du 2026-11-13) ; seul analyste reste identique', diff.length === 0, diff);
  const perdues = (role) => { const neuves = new Set((generes.normal[role] || '').split(/\n/)); return base[role].toString('utf8').split(/\n/).filter((l) => !neuves.has(l)); };
  check('non-régression : les huit rôles changés (architect, conseil, researcher, scout, verifier, reviewer-tests, reviewer-securite, worker) gardent chaque ligne v4 sauf celles nommées', Object.entries(CHANGES).every(([role, admis]) => { const p = perdues(role); return p.length === admis.length && p.every((l) => admis.some((d) => l.startsWith(d))); }), Object.keys(CHANGES).map(perdues));
}
// Interrupteur « sans Fable » sur la vraie table (limite Fable séparée constatée le 2026-11-10) : aucun agent sur fable, l'effort de la table gardé, puis retour aux valeurs de la demande.
for (const p of ['eco', 'normal', 'max']) {
  const i = ['eco', 'normal', 'max'].indexOf(p); const roles = Object.keys(DEMANDE);
  run(kit, ['force', p]); const c = run(kit, ['fable', 'coupe']);
  const lu = Object.fromEntries(roles.map((role) => [role, (() => { try { return fs.readFileSync(path.join(kit, 'agents', `${role}.md`), 'utf8'); } catch { return ''; } })()]));
  const attendu = (role) => { const [m, e] = DEMANDE[role][i].split(' '); return `\nmodel: ${m === 'fable' ? 'opus' : m}\neffort: ${e}\n`; };
  const fautifs = roles.filter((role) => lu[role].includes('model: fable') || !lu[role].includes(attendu(role)));
  check(`vraie table, sans Fable, ${p} : aucun des 9 agents sur fable, chaque rôle garde l'effort de la table (fable -> opus)`, c.code === 0 && roles.length === 9 && fautifs.length === 0, [c.out, fautifs]);
  // v5-fable52d : eco n'a plus aucun Fable (conseil opus medium dans la table elle-même) ; normal et max : researcher, architect, conseil passent sur Opus au même effort.
  const precis = { eco: [['conseil', 'opus', 'medium']], normal: [['researcher', 'opus', 'low'], ['architect', 'opus', 'medium'], ['conseil', 'opus', 'medium']], max: [['researcher', 'opus', 'medium'], ['architect', 'opus', 'high'], ['conseil', 'opus', 'xhigh']] }[p];
  const sansFableEco = p !== 'eco' || (roles.every((role) => !/^fable\b/.test(String((reelle[role] || {}).eco))) && roles.every((role) => !generes.eco[role].includes('model: fable')));
  check(`vraie table, sans Fable, ${p} : valeurs explicites (${precis.map((x) => x.join(' ')).join(', ')})${p === 'eco' ? ' ; aucun fable dans la table ni dans les agents eco générés avant la coupure' : ''}`, precis.every(([role, m, e]) => lu[role].includes(`\nmodel: ${m}\neffort: ${e}\n`)) && sansFableEco, precis.map(([role]) => lu[role].slice(0, 80)));
  const a = run(kit, ['fable', 'autorise']);
  const retour = roles.filter((role) => { const [m, e] = DEMANDE[role][i].split(' '); try { return !fs.readFileSync(path.join(kit, 'agents', `${role}.md`), 'utf8').includes(`\nmodel: ${m}\neffort: ${e}\n`); } catch { return true; } });
  check(`vraie table, fable autorise, ${p} : retour aux valeurs de la demande`, a.code === 0 && !/commande inconnue/.test(a.out) && c.code === 0 && !/commande inconnue/.test(c.out) && retour.length === 0, [a.out, retour]);
}
fs.rmSync(kit, { recursive: true, force: true });
process.exit(fail);
