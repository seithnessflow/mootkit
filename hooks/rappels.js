#!/usr/bin/env node
// Rappels du kit v5 : du contexte injecté dans la session principale, jamais un refus. Code 0, jamais de decision ni de
// permissionDecision ; une erreur va dans logs/telemetrie-erreurs.log ; silence si agent_id est présent (le hook tourne aussi
// dans les sous-agents). Sortie : {"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}.
//   PreToolUse Read           fichier de plus de 20 000 caractères (taille sur disque) lu sans offset, limit ni pages,
//                             hors images et PDF : « lecture longue : délègue à scout, ou lis une plage » ;
//   PostToolUse Bash|PowerShell   sortie (stdout + stderr) de plus de 20 000 caractères : même rappel, adapté ;
//   UserPromptSubmit          au moins 30 requêtes principales (message.id distincts) et au moins une modification depuis le repère = dernier Write RÉUSSI vers le
//                             dossier des rapports (tool_use associé à son tool_result par id ; is_error l'écarte ; sans tool_result, il compte), ou le début.
//                             Modification : Write, Edit, NotebookEdit dans le dossier du projet (cwd du payload ; sans cwd, partout), jamais le rapport lui-même ;
//                             Agent worker ; git commit, git mv, sed -i (Bash, PowerShell). LIMITE ASSUMÉE : une modification faite par un script (node, python), une
//                             redirection, tee, cp ou un outil externe n'est pas vue. « rapport en retard : écris-le avant d'enchaîner », UNE FOIS : le prompt où il
//                             se déclenche devient le repère (retour après 30 nouvelles requêtes avec modification), un rapport réarme. Rejeu prompt par prompt, plus un état minimal :
//                             une fenêtre (début, ou dernier rapport, ou dernier rappel) ne rappelle qu'une fois, fichier créé en exclusif (wx) dans logs/rappels/<session>-<sha1 clé>.json,
//                             donc sûr sous appels simultanés. SILENCE si le prompt est un retour de sous-agent (<agent-message, « Another Claude session sent a message: »), une
//                             notification de tâche ou un résumé de compaction (« This session is being continued… »), ou si l'historique a une telle ligne (peer, task-notification,
//                             isCompactSummary) avec le promptId du payload ; la fenêtre n'est alors pas consommée ;
//   PostToolUse Write vers rapports   contexte de la dernière requête principale (input + cache_read + cache_creation) au-dessus de
//                             250 000 tokens : fait « contexte à N k », que CLAUDE.md demande d'ajouter au rapport.
//   Dossier des rapports : KIT_RAPPORTS, sinon ~/Claude/rapports.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = process.env.KIT_HOME || path.join(os.homedir(), '.claude');
const SEUIL = 20000; const REQUETES = 30; const CONTEXTE = 250000;
const normalise = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const RAPPORTS = normalise(process.env.KIT_RAPPORTS || path.join(os.homedir(), 'Claude', 'rapports'));
const estRapport = (f) => typeof f === 'string' && normalise(f).startsWith(`${RAPPORTS}/`);
const gitSous = (sous) => new RegExp(String.raw`\bgit(?:\s+-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--\S+)*\s+${sous}\b`);
const COMMIT = gitSous('commit'); const MV = gitSous('mv'); const SED_I = /\bsed\s+(?:[^\s|;&]+\s+)*?(?:-[a-zA-Z]*i[a-zA-Z.]*|--in-place\S*)(?=\s|$)/;
const BINAIRES = /\.(png|jpe?g|gif|webp|bmp|tiff?|ico|heic|pdf)$/i;
const rappel = (n, txt) => `rappel du kit (${Math.round(n / 1000)} k car.) : ${txt}`;

function lecture(input) {
  const t = input.tool_input || {}; const f = t.file_path;
  if (typeof f !== 'string' || !f || t.offset != null || t.limit != null || t.pages != null || BINAIRES.test(f)) return null;
  let taille; try { const s = fs.statSync(path.resolve(input.cwd || '.', f)); if (!s.isFile()) return null; taille = s.size; } catch { return null; }
  return taille > SEUIL ? rappel(taille, 'lecture longue : délègue à scout, ou lis une plage') : null;
}

// Forme documentée : {stdout, stderr, interrupted, isImage}. Forme inconnue (PowerShell n'est pas documenté) : taille de son JSON.
function sortie(input) {
  const r = input.tool_response; if (r == null || r.isImage === true) return null;
  const long = (v) => (typeof v === 'string' ? v.length : 0);
  const n = typeof r === 'string' ? r.length : typeof r.stdout === 'string' || typeof r.stderr === 'string' ? long(r.stdout) + long(r.stderr) : (JSON.stringify(r) || '').length;
  return n > SEUIL ? rappel(n, 'sortie longue : redirige-la vers un fichier temporaire et ne lis que le résumé, ou délègue à scout') : null;
}

// Vrai prompt utilisateur : ni ligne de sous-agent, ni méta, ni résumé de compaction, ni tool_result, ni notification de tâche (le hook ne tourne pas pour elles).
const estPrompt = (o) => {
  const c = o.type === 'user' && o.isSidechain !== true && !o.isMeta && !o.isCompactSummary && o.message && o.message.content;
  if (!c || (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result'))) return false;
  return !['task-notification', 'peer'].includes((o.origin || {}).kind) && !/^\s*<task-notification>/.test(typeof c === 'string' ? c : (c[0] || {}).text);
};
// Requêtes principales du transcript, réduites à ce qui sert (id, usage, outils), et les prompts utilisateur ({ prompt: true }) à leur place ; une ligne
// corrompue est ignorée, un fichier absent donne [], un fichier illisible lève. Le tableau porte .erreurs : les tool_use_id dont le tool_result est en is_error.
function requetes(f) {
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const res = []; res.erreurs = new Set(); res.exclus = new Set();
  for (const l of txt.split('\n')) {
    let o; try { o = l && JSON.parse(l); } catch { continue; }
    if (o && o.type === 'user' && typeof o.promptId === 'string' && (o.isCompactSummary === true || ['peer', 'task-notification'].includes((o.origin || {}).kind))) res.exclus.add(o.promptId);
    if (o && estPrompt(o)) { res.push({ prompt: true }); continue; }
    if (o && o.type === 'user' && o.message && Array.isArray(o.message.content)) for (const b of o.message.content) if (b && b.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string') res.erreurs.add(b.tool_use_id);
    const m = o && o.type === 'assistant' && o.isSidechain !== true && o.message;
    if (!m || m.model === '<synthetic>') continue;
    res.push({ id: m.id, usage: m.usage, uses: (Array.isArray(m.content) ? m.content : []).filter((b) => b && b.type === 'tool_use').map((b) => ({ id: b.id, nom: b.name, f: (b.input || {}).file_path || (b.input || {}).notebook_path, t: (b.input || {}).subagent_type, c: (b.input || {}).command })) });
  }
  return res;
}
// Fichier dans le dossier du projet (sans cwd ou sans chemin : on ne peut pas juger, il compte).
const dansProjet = (f, cwd) => { if (!cwd || typeof f !== 'string' || !f) return true; const r = normalise(path.resolve(cwd, f)); const c = normalise(path.resolve(cwd)); return r === c || r.startsWith(`${c}/`); };
const modifie = (u, cwd) => (['Write', 'Edit', 'NotebookEdit'].includes(u.nom) && !estRapport(u.f) && dansProjet(u.f, cwd)) || (u.nom === 'Agent' && u.t === 'worker')
  || ((u.nom === 'Bash' || u.nom === 'PowerShell') && [COMMIT, MV, SED_I].some((re) => re.test(String(u.c))));

// Rejoue l'historique prompt par prompt : à chaque prompt, 30 requêtes et une modification depuis le repère = rappel, et le repère devient ce prompt. Le prompt courant
// est la dernière ligne si c'en est un (déjà écrit), sinon il s'ajoute (le hook tourne avant l'écriture). { n requêtes depuis le dernier rapport, tire : tombé sur le prompt courant, cle : point de départ du décompte qui a tiré (stable) }.
function retard(reqs, cwd) {
  const erreurs = reqs.erreurs || new Set(); const suite = reqs.at(-1)?.prompt ? reqs : [...reqs, { prompt: true }];
  let vus = new Set(); let depuis = 0; let modif = false; let marque = null; let tire = false; let cle = 'debut'; let cleTir = null; let dernier = null;
  for (const r of suite) {
    if (r.prompt) { tire = depuis >= REQUETES && modif; if (tire) { depuis = 0; modif = false; cleTir = cle; cle = `rappel:${dernier}`; } }
    else if (r.uses.some((u) => u.nom === 'Write' && estRapport(u.f) && !erreurs.has(u.id))) { vus = new Set(); depuis = 0; modif = false; marque = r.id; cle = `rapport:${r.id}`; }
    else if (r.id && r.id !== marque) { dernier = r.id; if (!vus.has(r.id)) { vus.add(r.id); depuis++; } if (r.uses.some((u) => modifie(u, cwd))) modif = true; }
  }
  return { n: vus.size, tire, cle: tire ? cleTir : null };
}

// Tokens lus par la dernière requête principale qui a un usage, ou null.
function contexte(reqs) {
  const r = [...reqs].reverse().find((x) => x.usage && typeof x.usage === 'object');
  const nb = (v) => (typeof v === 'number' ? v : 0);
  return r ? nb(r.usage.input_tokens) + nb(r.usage.cache_read_input_tokens) + nb(r.usage.cache_creation_input_tokens) : null;
}

// Texte à injecter, ou null (silence).
// Ni notification de tâche, ni retour de sous-agent, ni résumé de compaction : ce ne sont pas des messages de l'utilisateur (silence, sinon le rappel se répéterait à chacun).
const NOTIF = /^\s*(?:<task-notification>|<agent-message\b|Another Claude session sent a message:|This session is being continued from a previous conversation)/;
const journal = (e) => { try { fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true }); fs.appendFileSync(path.join(HOME, 'logs', 'telemetrie-erreurs.log'), `${new Date().toISOString()} rappels ${(e && e.stack) || e}\n`); } catch { /* journal d'erreurs inaccessible : rien d'autre à faire sans bloquer */ } };
// Réserve la fenêtre : création exclusive (atomique), donc un seul de deux hooks simultanés l'obtient. Faux = déjà rappelée (EEXIST), ou état inutilisable (journalisé).
function reserve(session, cle) {
  let dir; try { dir = path.join(HOME, 'logs', 'rappels'); fs.mkdirSync(dir, { recursive: true }); } catch (e) { journal(e); return false; }
  try {
    const sid = String(session || 'sans-session').replace(/[^\w.-]/g, '_').slice(0, 100);
    const fd = fs.openSync(path.join(dir, `${sid}-${crypto.createHash('sha1').update(cle).digest('hex')}.json`), 'wx');
    try { fs.writeSync(fd, JSON.stringify({ date: new Date().toISOString(), session: session || 'sans-session', cle })); } finally { fs.closeSync(fd); }
    return true;
  } catch (e) { if (!e || e.code !== 'EEXIST') journal(e); return false; }
}
function decide(input) {
  if (!input || input.agent_id) return null;
  const ev = input.hook_event_name; const outil = input.tool_name;
  if (ev === 'PreToolUse' && outil === 'Read') return lecture(input);
  if (ev === 'PostToolUse' && (outil === 'Bash' || outil === 'PowerShell')) return sortie(input);
  if (ev === 'UserPromptSubmit' && input.transcript_path && !NOTIF.test(input.prompt || '')) { const reqs = requetes(input.transcript_path); if (typeof input.prompt_id === 'string' && reqs.exclus.has(input.prompt_id)) return null; const r = retard(reqs, input.cwd); return r.tire && reserve(input.session_id, r.cle) ? `rappel du kit (${r.n} requêtes depuis le dernier rapport) : rapport en retard : écris-le avant d'enchaîner` : null; }
  if (ev === 'PostToolUse' && outil === 'Write' && input.transcript_path && estRapport((input.tool_input || {}).file_path)) { const t = contexte(requetes(input.transcript_path)); return t > CONTEXTE ? `contexte à ${Math.round(t / 1000)} k` : null; }
  return null;
}

module.exports = { decide, requetes, retard, contexte };
if (require.main === module) {
  process.exitCode = 0;
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}'); const txt = decide(input);
      if (txt) fs.writeSync(1, `${JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: txt } })}\n`);
    } catch (e) {
      journal(e);
    }
  });
}
