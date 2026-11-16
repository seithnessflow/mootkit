#!/usr/bin/env node
// Profil de budget du kit v5 (eco, normal, max) : modèle et effort de chaque rôle, écrits dans agents/<rôle>.md à partir de
// profils/gabarits/<rôle>.md ({{model}}, {{effort}}) et de profils/profils.json. Ne bloque jamais rien : code 0, jamais de decision ;
// une erreur va dans logs/telemetrie-erreurs.log et dans le contexte de la session.
//   node profil.js            hook SessionStart : startup, clear et fork recalculent ; compact et resume réinjectent seulement le profil de l'état (rien recalculé) ;
//                             agent_id présent : rien ; autre session vivante : le changement de profil est différé (tracé) ;
//   node profil.js calcul     affiche le choix du moment, n'écrit rien ;
//   node profil.js genere [eco|normal|max]   régénère les agents (profil donné, sinon selon l'état) ;
//   node profil.js force eco|normal|max      force ce profil jusqu'à `auto` ; appliqué même avec une autre session ouverte ;
//   node profil.js auto       retour au profil calculé ;
//   node profil.js fable coupe|autorise      interrupteur « sans Fable » (limite Fable séparée constatée le 2026-11-10) : coupe rend les rôles Fable sur opus, même effort ;
//                             autorise revient à la table. Ne change pas le profil ni le mode ; l'état (champ sans_fable de profil-actif.json) persiste comme le forçage et se lit sur chaque ligne de profils.jsonl.
// Rythme = pourcentage hebdomadaire consommé / fraction de semaine écoulée (plancher 1/7), lu dans logs/ratelimits.jsonl :
// moins de 0,5 -> max ; de 0,5 à 0,9 -> normal ; plus de 0,9 -> eco ; pas de donnée valide -> normal.
// agents/*.md sont générés. Retouche à la main = le fichier diffère de ce que le générateur a lui-même écrit la dernière fois (sha256 par rôle dans
// logs/agents-generes.json) : le changement d'un gabarit n'en est pas une. Sans hash enregistré (premier lancement, état absent ou corrompu), un contenu égal à un des
// six rendus (eco, normal, max, avec ou sans Fable) n'est pas une retouche non plus. Une retouche est, avant écriture,
// déplacée dans <KIT_HOME>/_a_supprimer/<AAAA-MM-JJ_HHhMM>/agents/ (nom pris : suffixe -2, -3…, jamais d'écrasement), puis signalé dans le contexte de la session
// et dans logs/profils.jsonl (champ deplaces). Un fichier qu'on ne peut pas lire (autre erreur que ENOENT) reste en place, ni écrit ni déplacé, et est signalé (champ illisibles) ; une exception pendant l'application garde le journal (deplaces, ecrits, erreur) et le message dit ce qui a été fait ; un contenu déjà sauvé à l'identique n'est pas recopié en -2, -3. Le contenu d'un autre profil est remplacé sans déplacement. Pas d'en-tête dans les fichiers générés (non-régression octet pour octet).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = process.env.KIT_HOME || path.join(os.homedir(), '.claude');
const P = (...s) => path.join(HOME, ...s);
const SEM = 7 * 86400; const HEURE = 3600000;
const PROFILS = ['eco', 'normal', 'max'];
const MODELES = ['haiku', 'sonnet', 'opus', 'fable']; const EFFORTS = ['low', 'medium', 'high', 'xhigh']; // l'effort max ne s'utilise jamais (sortie de Fable 5.2 et benchmarks par effort, 2026-11-09) : une table qui le porte est invalide

// Fonction pure : lignes de ratelimits.jsonl, heure en ms. Ne garde que les lignes hebdomadaires valides de la semaine en cours ;
// pct = maximum de l'heure avant la dernière ligne (une session en retard peut écrire une valeur plus basse).
function choisir(lignes, maintenant) {
  const ok = lignes.filter((l) => l && Number.isFinite(l.seven_day) && Number.isFinite(l.seven_reset) && l.seven_reset * 1000 > maintenant && Number.isFinite(Date.parse(l.ts)));
  if (!ok.length) return { profil: 'normal', rythme: null, pct: null, fraction: null, raison: 'pas de donnée hebdomadaire valide' };
  const t = (l) => Date.parse(l.ts);
  const der = ok.reduce((a, b) => (t(b) > t(a) ? b : a));
  const pct = Math.max(...ok.filter((l) => l.seven_reset === der.seven_reset && t(der) - t(l) >= 0 && t(der) - t(l) <= HEURE).map((l) => l.seven_day));
  const fraction = Math.min(1, Math.max(1 / 7, (maintenant / 1000 - (der.seven_reset - SEM)) / SEM));
  const rythme = Math.round((pct / 100 / fraction) * 1e4) / 1e4;
  return { profil: rythme < 0.5 ? 'max' : rythme <= 0.9 ? 'normal' : 'eco', rythme, pct, fraction, raison: `rythme ${rythme} : ${pct} % de la limite hebdomadaire, ${Math.round(fraction * 1000) / 10} % de la semaine` };
}

const lire = (f) => fs.readFileSync(f, 'utf8');
const ajoute = (f, l) => { fs.mkdirSync(P('logs'), { recursive: true }); fs.appendFileSync(P('logs', f), `${typeof l === 'string' ? l : JSON.stringify(l)}\n`); };
const etatLu = () => { try { return JSON.parse(lire(P('logs', 'profil-actif.json'))); } catch { return null; } };
const lignes = () => { try { return lire(P('logs', 'ratelimits.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }); } catch { return []; } };
// Interrupteur « sans Fable » : booléen de l'état précédent (ancien état sans le champ = faux), recopié par chaque fixe() ; seule la commande `fable` le change.
const sansFable = (prec) => !!prec && prec.sans_fable === true;
const voulu = (prec) => { const c = choisir(lignes(), Date.now()); return prec && prec.mode === 'force' && PROFILS.includes(prec.profil) ? { ...c, profil: prec.profil, mode: 'force', raison: 'forcé par l\'utilisateur' } : { ...c, mode: 'auto' }; };
const texte = (e) => `profil actif : ${e.profil} (${e.mode === 'force' ? 'forcé' : `auto${e.rythme == null ? '' : `, rythme ${e.rythme.toFixed(2).replace('.', ',')}`}`})${e.sans_fable === true ? ` ; sans Fable (demandé par l'utilisateur) : rôles Fable sur Opus, même effort, jusqu'à « Fable autorisé »` : ''}${e.deplaces && e.deplaces.length ? ` ; agents retouchés à la main, déplacés (agents/*.md sont générés : retoucher profils/gabarits/) : ${e.deplaces.map((d) => `${d.role} -> ${d.vers}`).join(', ')}` : ''}${e.illisibles && e.illisibles.length ? ` ; agents illisibles, laissés en place (ni écrits ni déplacés) : ${e.illisibles.map((d) => `${d.role} (${d.code})`).join(', ')}` : ''}`;

// Version de la table : clé _table de profils.json (un texte non vide, sinon nul). Elle va dans l'état (profil-actif.json, champ table, que telemetrie.js recopie sur
// chaque ligne de agents.jsonl et sessions.jsonl) et sur chaque ligne de profils.jsonl : au bilan, elle sépare l'avant et l'après d'un changement de table
// (sortie de Fable 5.2 et benchmarks par effort, 2026-11-09). C'est la version de la table qui a généré les agents en place : un profil différé garde celle de l'état.
const versionTable = () => { try { const v = JSON.parse(lire(P('profils', 'profils.json')))._table; return typeof v === 'string' && v ? v : null; } catch { return null; } };

// Table et gabarits validés en entier avant toute écriture : { rôle: { profil: contenu } }. La clé _table n'est pas un rôle.
function charge(sans = false) {
  const table = Object.fromEntries(Object.entries(JSON.parse(lire(P('profils', 'profils.json')))).filter(([k]) => k !== '_table'));
  const dir = P('profils', 'gabarits'); const roles = Object.keys(table); const sortie = {};
  for (const g of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) if (!roles.includes(g.slice(0, -3))) throw new Error(`profil invalide : gabarit ${g} sans ligne dans profils.json`);
  if (!roles.length) throw new Error('profil invalide : profils.json vide');
  for (const role of roles) {
    const tpl = lire(path.join(dir, `${role}.md`));
    if (!tpl.includes('{{model}}') || !tpl.includes('{{effort}}')) throw new Error(`profil invalide : gabarit ${role}.md sans {{model}} ou {{effort}}`);
    sortie[role] = {}; const six = [];
    for (const p of PROFILS) {
      const v = String((table[role] || {})[p] || ''); const [m, e, ...reste] = v.split(/\s+/);
      if (!MODELES.includes(m) || !EFFORTS.includes(e) || reste.length) throw new Error(`profil invalide : ${role}/${p} = "${v}"`);
      sortie[role][p] = tpl.replaceAll('{{model}}', sans && m === 'fable' ? 'opus' : m).replaceAll('{{effort}}', e);
      six.push(tpl.replaceAll('{{model}}', m).replaceAll('{{effort}}', e), tpl.replaceAll('{{model}}', m === 'fable' ? 'opus' : m).replaceAll('{{effort}}', e)); // avec et sans Fable
    }
    Object.defineProperty(sortie[role], 'six', { value: six }); // non énumérable : les trois profils restent les seules clés
  }
  return sortie;
}

// Hash des fichiers écrits par le générateur : { rôle: sha256 hex }. Absent, illisible ou invalide : vide, sans exception. Écriture atomique (temporaire puis rename).
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const hashesLus = () => { try { const o = JSON.parse(lire(P('logs', 'agents-generes.json'))); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } };
function hashesEcrits(h) {
  fs.mkdirSync(P('logs'), { recursive: true }); const tmp = P('logs', `agents-generes.json.${process.pid}.tmp`);
  try { fs.writeFileSync(tmp, JSON.stringify(h)); fs.renameSync(tmp, P('logs', 'agents-generes.json')); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* temporaire à nous */ } throw e; }
}
const horodatage = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}h${z(d.getMinutes())}`; };
// Met l'ancien fichier à l'abri dans _a_supprimer/<date>/agents/ : copie exclusive (EEXIST = nom pris, suffixe), donc rien n'est écrasé même en cas de course.
// Un contenu déjà sauvé à l'identique (dans n'importe quel dossier daté de _a_supprimer, par une tentative précédente interrompue) n'est pas recopié : on renvoie cette copie.
const dejaSauve = (f, role) => {
  let src; try { src = fs.readFileSync(f); } catch { return null; }
  const nom = (x) => x === `${role}.md` || (x.startsWith(`${role}-`) && /^\d+\.md$/.test(x.slice(role.length + 1))); // role.md, role-2.md, role-3.md…
  let jours = []; try { jours = fs.readdirSync(P('_a_supprimer')); } catch { return null; }
  for (const j of jours) {
    const dir = P('_a_supprimer', j, 'agents'); let noms = []; try { noms = fs.readdirSync(dir).filter(nom); } catch { continue; }
    for (const x of noms) { try { if (fs.readFileSync(path.join(dir, x)).equals(src)) return path.join(dir, x); } catch { /* copie illisible : pas une preuve */ } }
  }
  return null;
};
function metsAbri(f, role) {
  const deja = dejaSauve(f, role); if (deja) return deja;
  const dir = P('_a_supprimer', horodatage(), 'agents'); fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const dest = path.join(dir, n === 1 ? `${role}.md` : `${role}-${n}.md`);
    try { fs.copyFileSync(f, dest, fs.constants.COPYFILE_EXCL); return dest; } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  }
}

// N'écrit que les fichiers au contenu différent (un fichier réécrit identique recharge les agents pour rien) ; true si un a changé.
// Un fichier présent qui n'est aucun des trois rendus est rangé d'abord (deplaces reçoit { role, vers }, avant l'écriture : une exception plus loin ne le perd pas).
// Une lecture en erreur autre que ENOENT (droits, dossier, verrou) : le fichier est laissé en place, jamais écrit ni déplacé, et signalé (suivi.illisibles).
// suivi.ecrits : les rôles réellement écrits, pour dire ce qui a été fait si une exception interrompt la suite.
function applique(contenus, profil, manquantsSeulement, deplaces = [], suivi = { ecrits: [], illisibles: [] }) {
  fs.mkdirSync(P('agents'), { recursive: true });
  const hashes = hashesLus(); let sale = false;
  try {
    for (const [role, c] of Object.entries(contenus)) {
      const f = P('agents', `${role}.md`);
      let actuel = null;
      try { actuel = lire(f); } catch (e) { if (!e || e.code !== 'ENOENT') { suivi.illisibles.push({ role, code: (e && e.code) || String(e) }); continue; } } // absent : à générer
      if (actuel === c[profil]) { if (hashes[role] !== sha(actuel)) { hashes[role] = sha(actuel); sale = true; } continue; } // déjà identique : initialise le hash
      if (manquantsSeulement && actuel !== null) continue;
      // Retouche = différent de ce que le générateur a écrit. Sans hash qui le prouve : un des rendus actuels est reproductible, le reste est mis à l'abri.
      const genere = typeof hashes[role] === 'string' && actuel !== null && sha(actuel) === hashes[role];
      if (actuel !== null && !genere && !c.six.includes(actuel)) deplaces.push({ role, vers: metsAbri(f, role) });
      fs.writeFileSync(f, c[profil]); suivi.ecrits.push(role); hashes[role] = sha(c[profil]); sale = true;
    }
  } finally { if (sale) hashesEcrits(hashes); }
  return suivi.ecrits.length > 0;
}

// Autre session vivante : un fichier sessions/<pid>.json d'un autre sessionId dont le pid existe (EPERM = vivant).
function autreSession(courante) {
  let fichiers = []; try { fichiers = fs.readdirSync(P('sessions')).filter((f) => f.endsWith('.json')); } catch { return false; }
  return fichiers.some((f) => {
    try { const s = JSON.parse(lire(P('sessions', f))); if (!s.sessionId || s.sessionId === courante) return false; process.kill(s.pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
  });
}

// Applique, écrit le journal (dans un finally : ce qui a été déplacé ou écrit se garde même si une exception interrompt la suite), puis l'état en dernier.
// genere_a ne bouge que si un agent a changé (début du délai de rechargement). Une exception est relancée avec e.faits (ce qui a été fait) pour que le message le dise.
function fixe(v, prec, session, source) {
  const deplaces = []; const suivi = { ecrits: [], illisibles: [] }; let change = false; let erreur = null; const table = versionTable(); const sans = 'sans_fable' in v ? v.sans_fable === true : sansFable(prec);
  try { change = applique(charge(sans), v.profil, false, deplaces, suivi); } catch (e) { erreur = e || new Error('erreur inconnue'); } finally {
    if (!erreur || deplaces.length || suivi.ecrits.length || suivi.illisibles.length) {
      const ligne = { date: new Date().toISOString(), session, source, table, sans_fable: sans, voulu: v.profil, applique: erreur ? 'échec' : v.profil, raison: v.raison, ...(deplaces.length ? { deplaces } : {}),
        ...(suivi.illisibles.length ? { illisibles: suivi.illisibles } : {}), ...(erreur ? { ecrits: suivi.ecrits, erreur: String(erreur.message || erreur) } : {}) };
      if (erreur) { try { ajoute('profils.jsonl', ligne); } catch { /* le journal ne masque pas l'erreur d'origine */ } } else ajoute('profils.jsonl', ligne);
    }
  }
  if (erreur) { try { erreur.faits = { deplaces, ecrits: suivi.ecrits, illisibles: suivi.illisibles }; } catch { /* valeur levée non modifiable */ } throw erreur; }
  const e = { profil: v.profil, mode: v.mode, rythme: v.rythme, pct: v.pct, fraction: v.fraction, raison: v.raison, genere_a: change || !(prec && prec.genere_a) ? new Date().toISOString() : prec.genere_a, session, table, sans_fable: sans };
  fs.mkdirSync(P('logs'), { recursive: true }); fs.writeFileSync(P('logs', 'profil-actif.json'), JSON.stringify(e));
  return { ...e, deplaces, illisibles: suivi.illisibles };
}

function sortie(txt, json) {
  try { fs.writeSync(1, json ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: txt } })}\n` : `${txt}\n`); } catch { /* sortie fermée : rien à faire sans bloquer */ }
}

function sessionStart(input) {
  if (input.agent_id) return;
  const prec = etatLu();
  if (input.source === 'compact' || input.source === 'resume') { if (prec) sortie(texte(prec), true); return; } // le profil ne change jamais en cours de session : réinjecté, pas recalculé
  const v = voulu(prec); const contenus = charge(sansFable(prec));
  if (prec && prec.profil !== v.profil && autreSession(input.session_id)) {
    applique(contenus, prec.profil, true);
    ajoute('profils.jsonl', { date: new Date().toISOString(), session: input.session_id, source: input.source || 'startup', table: typeof prec.table === 'string' && prec.table ? prec.table : null, sans_fable: sansFable(prec), voulu: v.profil, applique: prec.profil, raison: 'autre session vivante : profil voulu différé' });
    return sortie(`${texte(prec)} ; profil voulu ${v.profil} différé (une autre session est ouverte)`, true);
  }
  sortie(texte(fixe(v, prec, input.session_id, input.source || 'startup')), true);
}

function commande(cmd, arg) {
  const prec = etatLu();
  if (!['calcul', 'genere', 'force', 'auto', 'fable'].includes(cmd)) return sortie(`commande inconnue : ${cmd}`);
  if (cmd === 'calcul') return sortie(JSON.stringify(choisir(lignes(), Date.now())));
  if ((cmd === 'force' || (cmd === 'genere' && arg)) && !PROFILS.includes(arg)) return sortie(`profil inconnu : ${arg} (eco, normal ou max)`);
  if (cmd === 'fable' && !['coupe', 'autorise'].includes(arg)) return sortie(`argument inconnu : ${arg === undefined ? '' : arg} (coupe ou autorise)`);
  const c = choisir(lignes(), Date.now());
  const v = cmd === 'fable' ? { ...(prec && PROFILS.includes(prec.profil) ? { ...c, profil: prec.profil, mode: prec.mode === 'force' ? 'force' : 'auto', rythme: prec.rythme, pct: prec.pct, fraction: prec.fraction } : voulu(null)),
      raison: arg === 'coupe' ? "sans Fable : demandé par l'utilisateur" : "Fable autorisé par l'utilisateur", sans_fable: arg === 'coupe' }
    : cmd === 'force' ? { ...c, profil: arg, mode: 'force', raison: 'forcé par l\'utilisateur' }
    : cmd === 'genere' && arg ? { ...c, profil: arg, mode: 'auto', raison: `génération du profil ${arg}` }
      : cmd === 'genere' ? voulu(prec) : { ...c, mode: 'auto' };
  const e = fixe(v, prec, (prec && prec.session) || null, cmd);
  sortie(`${texte(e)}${autreSession(prec && prec.session) ? ' ; autre session ouverte : ses agents se rechargent' : ''}`);
}

module.exports = { choisir };
if (require.main === module) {
  process.exitCode = 0;
  const [cmd, arg] = process.argv.slice(2);
  const echec = (e) => {
    try { ajoute('telemetrie-erreurs.log', `${new Date().toISOString()} profil ${cmd || 'sessionstart'} ${(e && e.stack) || e}`); } catch { /* journal d'erreurs inaccessible */ }
    const fa = (e && e.faits) || {}; const fait = [...(fa.ecrits && fa.ecrits.length ? [`agents réécrits : ${fa.ecrits.join(', ')}`] : []), ...(fa.deplaces && fa.deplaces.length ? [`retouches déplacées : ${fa.deplaces.map((d) => `${d.role} -> ${d.vers}`).join(', ')}`] : []),
      ...(fa.illisibles && fa.illisibles.length ? [`agents illisibles, laissés en place : ${fa.illisibles.map((d) => `${d.role} (${d.code})`).join(', ')}`] : [])];
    sortie((fa.ecrits || []).length + (fa.deplaces || []).length ? `profil : échec en cours d'application (${(e && e.message) || e}) ; déjà fait : ${fait.join(' ; ')} ; profil incomplet, état non mis à jour` : `profil : échec, agents inchangés (${(e && e.message) || e})`, !cmd);
  };
  if (cmd) { try { commande(cmd, arg); } catch (e) { echec(e); } } else {
    let raw = '';
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => { try { sessionStart(JSON.parse(raw || '{}')); } catch (e) { echec(e); } });
  }
}
