#!/usr/bin/env node
// Télémétrie du kit v5. Ne bloque jamais rien : aucune sortie, code 0 ; une erreur va dans logs/telemetrie-erreurs.log.
//   node telemetrie.js agent    (SubagentStop) : une ligne par appel dans logs/agents.jsonl, plus une ligne d'alerte
//                               si le modèle servi n'est pas celui du rôle, si le rôle est general-purpose, si le type d'agent n'a
//                               pas de fichier de rôle (aussi quand l'historique manque, si agent_type n'est pas vide), ou si un modèle a été imposé à l'appel. Une ligne d'alerte
//                               par raison, avec un champ type stable : escalade, modele_impose, modele_servi, sans_role, general_purpose, conseil_ecriture. Un worker dont le modèle
//                               imposé est un cran au-dessus de celui du rôle (haiku < sonnet < opus, jamais Fable) écrit escalade, ni modele_impose ni modèle servi au lieu du modèle du
//                               rôle : le modèle servi se compare alors au modèle demandé. Un worker déjà sur Fable, ou architect quel que soit son modèle (relance de débogage),
//                               appelé sans modèle avec un effort un cran au-dessus de celui du rôle (low < medium < high < xhigh, jamais max), écrit aussi escalade
//                               (sortie de Fable 5.2 et benchmarks par effort, 2026-11-09). Chaque ligne d'agent porte aussi (rapport 2026-11-17_06h45-temps-essaim-refus.md) :
//                               attente_fond_s (attente des commandes de fond, méthode du diagnostic temps.js), fond_n (commandes de fond), actifs_au_lancement (autres
//                               sous-agents de la session actifs à son début), profondeur (meta.spawnDepth) et taskKind (meta.taskKind), nuls s'ils manquent ; seulement sur la ligne
//                               d'un agent avec historique (la ligne sans_historique garde le payload seul : rien à mesurer). Limite : la fin d'un agent voisin est le mtime de son fichier ;
//   node telemetrie.js session  (Stop) : total cumulé de la session principale dans logs/sessions.jsonl (une ligne par
//                               tour, la dernière ligne d'une session fait foi).
//   Journal des refus (les deux modes) : logs/refus.jsonl, une ligne par refus de permission, lue dans l'historique (toolDenialKind et permissionDecision, champs non documentés
//   par Claude Code). Limite : la règle deny exacte n'y figure pas, seulement son fichier source (regle_source).
// Le modèle servi est lu dans l'historique (message.model). Le modèle imposé à l'appel est le paramètre model du tool_use Agent
// de l'historique principal (par meta.toolUseId, sinon par input.name), jamais meta.model. Lignes v5 : "v": 5, avec le profil actif et la version de la table
// des rôles (champs profil et table de logs/profil-actif.json, écrit par profil.js ; nuls s'ils sont absents ; table sépare l'avant et l'après d'un changement de table au bilan). Dans les 120 s après une régénération des agents, pas d'alerte
// de modèle servi (rechargement: true) : Claude Code applique alors encore l'ancien fichier. sessions.jsonl : contexte = taille de la
// dernière requête principale (entrée + cache écrit + cache lu).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOGS = path.join(process.env.TELEMETRIE_HOME || path.join(os.homedir(), '.claude'), 'logs');
const AGENTS = path.join(process.env.TELEMETRIE_HOME || path.join(os.homedir(), '.claude'), 'agents');
const family = (s) => (/(haiku|sonnet|opus|fable)/.exec(String(s || '')) || [])[1] || null;
const readRows = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Rythme d'un sous-agent (rapport 2026-11-16_00h25-workers-longs.md) : pauses de plus de 5 min entre la dernière ligne d'une requête et la première
// de la suivante (le cache d'un sous-agent dure 5 min), rang (1 = première requête) de la première requête qui appelle Edit, Write, MultiEdit ou NotebookEdit.
function rythme(rows) {
  const req = new Map(); // message.id -> [début, fin, édite]
  for (const o of rows) if (o.type === 'assistant' && o.message && o.message.usage && o.timestamp) { const id = o.message.id || o.uuid; const r = req.get(id) || [o.timestamp, o.timestamp, false]; r[1] = o.timestamp; if ((o.message.content || []).some((b) => b && b.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name))) r[2] = true; req.set(id, r); }
  const v = [...req.values()]; const e = v.findIndex((r) => r[2]);
  return { pauses_5min: v.filter((r, i) => i > 0 && Date.parse(r[0]) - Date.parse(v[i - 1][1]) > 300000).length, premiere_edition: e < 0 ? null : e + 1 };
}

// Attente des commandes de fond (rapport 2026-11-17_06h45-temps-essaim-refus.md), méthode du diagnostic temps.js : intervalles classés par priorité (0 génération, tests
// et sous-agent au premier plan ; 1 boucle d'attente Bash/PowerShell ; 2 autres commandes, lectures, écritures ; 3 Monitor, TaskOutput, BashOutput ; 4 autres outils, lancements
// de fond ; 5 fin de tour suivie d'une notification), puis balayage : chaque instant va à l'intervalle actif le plus prioritaire ; attente = instants classés 1, 3 ou 5.
const BOUCLE = /for i in \$\(seq|until |while \[[\s\S]*(sleep|done)|sleep \d+\s*;\s*done/;
const TESTS = /Godot_v[\d.]+|lancer\.sh|\bpytest\b|npm (run )?test|node --test|\bjest\b|vitest|go test|cargo test|profil-test|python -m unittest/;
function attente(rows) {
  const E = rows.filter((o) => !isNaN(Date.parse(o.timestamp))).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const iv = []; const add = (a, b, p) => { if (b > a) iv.push([a, b, p]); }; const enCours = new Map(); const fond = new Set();
  let req = null; let asst = null; let res = null; let prompt = null; let fin = null; let rapport = false;
  for (const o of E) {
    const t = Date.parse(o.timestamp); const c = o.message && o.message.content; const blocs = Array.isArray(c) ? c : [];
    if (o.type === 'api-request') { if (req === null) { req = t; res = null; } } else if (o.type === 'assistant') {
      if (req !== null) add(req, t, 0); else if (asst === null && (res ?? prompt) !== null) add(res ?? prompt, t, 0); else if (asst !== null) add(asst, t, 0);
      req = res = prompt = null; fin = asst = t;
      for (const b of blocs) if (b && b.type === 'tool_use') { enCours.set(b.id, [t, b.name, b.input || {}]); if (/^(Bash|PowerShell)$/.test(b.name) && (b.input || {}).run_in_background === true) fond.add(b.id); }
    } else if (o.type === 'user' && blocs.some((x) => x && x.type === 'tool_result')) {
      asst = null; res = fin = t; rapport = JSON.stringify(c).includes('Report delivered');
      for (const x of blocs) { const u = x && x.type === 'tool_result' && enCours.get(x.tool_use_id); if (!u) continue; enCours.delete(x.tool_use_id); const [a, n, i] = u; const sh = /^(Bash|PowerShell)$/.test(n);
        if (sh && JSON.stringify(x.content || '').includes('moved to the background')) fond.add(x.tool_use_id);
        add(a, t, sh ? (i.run_in_background ? 4 : BOUCLE.test(i.command || '') ? 1 : TESTS.test(i.command || '') ? 0 : 2) : /^(Read|Grep|Glob|Edit|Write|NotebookEdit)$/.test(n) ? 2 : /^(Monitor|TaskOutput|BashOutput)$/.test(n) ? 3 : /^(Agent|Task)$/.test(n) && !i.run_in_background ? 0 : 4); }
    } else if (o.type === 'user') {
      if (fin !== null && !rapport && /<task-notification>|SYSTEM NOTIFICATION/.test(typeof c === 'string' ? c : blocs.map((x) => (x && x.text) || '').join(' '))) add(fin, t, 5);
      rapport = false; fin = null; if (!o.isMeta) { prompt = t; asst = null; }
    }
  }
  const P = [...new Set(iv.flatMap(([a, b]) => [a, b]))].sort((a, b) => a - b); let s = 0;
  for (let k = 0; k + 1 < P.length; k++) { const m = (P[k] + P[k + 1]) / 2; const p = Math.min(...iv.filter(([a, b]) => a <= m && b > m).map((x) => x[2])); if (p === 1 || p === 3 || p === 5) s += P[k + 1] - P[k]; }
  return { attente_fond_s: Math.round(s / 1000), fond_n: fond.size };
}

// Autres sous-agents actifs au lancement de celui-ci : *.jsonl du même dossier dont le début (premier timestamp des 64 premiers Ko) est ≤ au sien et la fin (mtime) après.
function actifs(file, debut) {
  const t = Date.parse(debut); let n = 0; if (isNaN(t)) return null;
  for (const g of fs.readdirSync(path.dirname(file))) {
    const f = path.join(path.dirname(file), g); if (!g.endsWith('.jsonl') || path.resolve(f) === path.resolve(file)) continue;
    try { const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(65536); const k = fs.readSync(fd, buf, 0, 65536, 0); fs.closeSync(fd); if (Date.parse((/"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, k)) || [])[1]) <= t && fs.statSync(f).mtimeMs > t) n++; } catch { /* dossier ou fichier illisible : ignoré */ }
  }
  return n;
}

// Un message de l'assistant s'écrit sur plusieurs lignes (un bloc par ligne) avec le même id : on garde la dernière.
function usage(rows, mainOnly) {
  const byId = new Map();
  const models = new Set();
  let effort = null;
  for (const o of rows) {
    if (o.type !== 'assistant' || !o.message || (mainOnly && o.isSidechain === true)) continue;
    if (typeof o.perTurnEffort === 'string') effort = o.perTurnEffort;
    if (o.message.model && o.message.model !== '<synthetic>') models.add(o.message.model);
    if (o.message.usage) byId.set(o.message.id || o.uuid, o.message.usage);
  }
  const tokens = { entree: 0, sortie: 0, cache_ecrit: 0, cache_lu: 0, messages: byId.size };
  for (const u of byId.values()) {
    tokens.entree += u.input_tokens || 0;
    tokens.sortie += u.output_tokens || 0;
    tokens.cache_ecrit += u.cache_creation_input_tokens || 0;
    tokens.cache_lu += u.cache_read_input_tokens || 0;
  }
  const ts = rows.map((o) => o.timestamp).filter(Boolean).sort();
  const duree = ts.length ? Math.round((Date.parse(ts[ts.length - 1]) - Date.parse(ts[0])) / 1000) : null;
  const der = [...byId.values()].pop();
  const contexte = der ? (der.input_tokens || 0) + (der.cache_creation_input_tokens || 0) + (der.cache_read_input_tokens || 0) : null;
  return { models: [...models], effort, tokens, contexte, debut: ts[0] || null, duree_s: duree };
}

function projet(cwd) {
  for (let d = path.resolve(cwd || '.'); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return path.resolve(cwd || '.');
  }
}

// Modèle et effort écrits dans le fichier du rôle : agents du projet d'abord, puis ceux du kit.
function roleFile(role, cwd) {
  for (const dir of [path.join(projet(cwd), '.claude', 'agents'), AGENTS]) {
    const f = path.join(dir, `${role}.md`);
    if (!fs.existsSync(f)) continue;
    const head = fs.readFileSync(f, 'utf8').split(/^---\s*$/m)[1] || '';
    const get = (k) => (new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(head) || [])[1] || null;
    return { model: get('model'), effort: get('effort') };
  }
  return null;
}

// Modèle et effort imposés à l'appel : paramètres model et effort du tool_use Agent de l'historique principal, par toolUseId, sinon par nom d'appel.
function paramsAppel(transcript, meta) {
  if (!transcript || !fs.existsSync(transcript) || !(meta.toolUseId || meta.name)) return { model: null, effort: null };
  const uses = fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.includes('"name":"Agent"'))
    .flatMap((l) => { try { return JSON.parse(l).message.content; } catch { return []; } }).filter((b) => b && b.type === 'tool_use' && b.name === 'Agent');
  const b = uses.find((x) => (meta.toolUseId ? x.id === meta.toolUseId : x.input && x.input.name === meta.name));
  const i = (b && b.input) || {};
  return { model: i.model || null, effort: typeof i.effort === 'string' ? i.effort : null };
}

// Profil actif, version de la table et heure (ms) de la dernière génération des agents, lus dans logs/profil-actif.json.
function profilActif() {
  try { const e = JSON.parse(fs.readFileSync(path.join(LOGS, 'profil-actif.json'), 'utf8')); return { profil: e.profil || null, table: typeof e.table === 'string' && e.table ? e.table : null, genere: Date.parse(e.genere_a) || null }; } catch { return { profil: null, table: null, genere: null }; }
}

function append(name, rows) {
  fs.mkdirSync(LOGS, { recursive: true });
  const { profil, table } = profilActif();
  fs.appendFileSync(path.join(LOGS, name), rows.map((r) => `${typeof r === 'string' ? r : JSON.stringify({ ...r, profil, table })}\n`).join(''));
}

// Écritures du conseil hors de ses deux dossiers (rapports, scratchpad) : trace non bloquante, HEURISTIQUE ASSUMÉE. Un Write, Edit ou
// NotebookEdit se juge sur son chemin ; une commande Bash ou PowerShell se juge sur ce que son texte laisse voir (redirection > ou >>, tee,
// cp, mv, sed -i, dd of=, rm, touch, mkdir, Set-Content/sc, Add-Content/ac, New-Item/ni, Copy-Item/cpi/copy, Out-File, [IO.File]::Write*, etc.), guillemets
// masqués ; git commit et git push sont signalés tels quels (ils écrivent dans un dépôt, dont on ne juge pas le chemin). Elle ne voit pas : un script (node, python)
// qui écrit lui-même, un état partagé entre deux appels (un cd ne vaut que dans sa commande ; sinon cwd du payload), une variable ($X, %X%) dans
// le chemin (ignoré, jamais alerté). Chemins comparés sans casse, barres obliques ou antislashs, forme /c/ de Git Bash comprise.
// Le scratchpad vient de scratchpad_dir du payload, sinon d'un chemin .../claude/<id>/<session>/scratchpad d'un Write ou Edit de l'historique.
const RAPPORTS = process.env.TELEMETRIE_RAPPORTS || path.join(os.homedir(), 'Claude', 'rapports');
const norm = (p, base) => {
  let s = String(p).replace(/\\/g, '/').replace(/^~(?=\/|$)/, os.homedir().replace(/\\/g, '/')).replace(/^\/([a-z])\//i, '$1:/');
  if (!/^([a-z]:)?\//i.test(s)) s = `${String(base).replace(/\\/g, '/')}/${s}`;
  return path.posix.normalize(s).replace(/\/+$/, '').toLowerCase();
};
const PS_PARAM = /^-(path|filepath|literalpath|destination)$/i; const PS_SWITCH = /^-(force|recurse|append|noclobber|nonewline|confirm|whatif|passthru)$/i;
function cibles(cmd, base) { // [cible, dossier courant] ; un cd (cd, pushd, Set-Location) de la commande change le dossier des cibles relatives qui suivent
  let cwd = base; const add = (...ts) => ts.forEach((t) => out.push([t, cwd]));
  const q = []; const s = cmd.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => `\u0001${q.push(a === undefined ? b : a) - 1}\u0001`); // guillemets masqués
  const val = (t) => t.replace(/\u0001(\d+)\u0001/g, (_, i) => q[i]); const out = [];
  for (const m of cmd.matchAll(/\[(?:System\.)?IO\.File\]::\w*Write\w*\(\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] === undefined ? m[2] : m[1]); // [IO.File]::WriteAllText("chemin", …)
  for (const seg of s.split(/&&|\|\||[;|\n]/)) {
    for (const m of seg.matchAll(/(?:^|[^>&])&?>>?[ \t]*(\S+)/g)) add(val(m[1]));
    const t = seg.trim().split(/\s+/).filter(Boolean); while (t.length && /^(\w+=\S*|sudo|command|&)$/.test(t[0])) t.shift();
    const c = (t.shift() || '').toLowerCase(); const a = t.map(val); const pos = a.filter((x) => !x.startsWith('-'));
    if (/^(cd|pushd|set-location|sl)$/.test(c)) { cwd = a[0] && a[0] !== '-' && !/[$%`]/.test(a[0]) ? norm(a[0], cwd) : null; continue; } // dossier inconnu : cibles relatives ignorées
    const ps = a.flatMap((x, i) => (PS_PARAM.test(a[i - 1] || '') ? [x] : [])); // valeurs de -Path, -FilePath, -LiteralPath, -Destination
    const posPS = a.filter((x, i) => !x.startsWith('-') && !(/^-/.test(a[i - 1] || '') && !PS_SWITCH.test(a[i - 1])));
    if (/^(tee|rm|rmdir|touch|mkdir|truncate|unlink)$/.test(c)) add(...pos);
    else if (/^(cp|mv|install|ln)$/.test(c)) add(...pos.slice(-1));
    else if (c === 'sed' && a.some((x) => /^(-[a-zA-Z]*i|--in-place)/.test(x))) add(...(a.includes('-e') ? pos : pos.slice(1)));
    else if (c === 'dd') add(...a.filter((x) => x.startsWith('of=')).map((x) => x.slice(3)));
    else if (/^(curl|wget|invoke-webrequest|iwr)$/.test(c)) add(...a.flatMap((x, i) => (/^(-o|-O|--output|-outfile)$/.test(a[i - 1] || '') ? [x] : [])));
    else if (/^(set|add|clear)-content$|^out-file$|^tee-object$|^export-\w+$|^new-item$|^remove-item$|^rename-item$|^(move|copy)-item$|^set-item$|^(del|erase|ri|rd|md|ni|sc|ac|cpi|copy)$/.test(c)) add(...(ps.length ? ps : (/^((move|copy)-item|cpi|copy)$/.test(c) ? posPS.slice(-1) : posPS.slice(0, 1))));
  }
  return out;
}
const GIT_ECRIT = /\bgit(?:\s+(?:-[cC]\s+\S+|--?\S+))*\s+(commit|push)\b/g;
function ecrituresHorsZone(rows, input) {
  const base = input.cwd || '.'; const appels = [];
  for (const o of rows) for (const b of (o.message && Array.isArray(o.message.content) ? o.message.content : [])) if (b && b.type === 'tool_use' && b.input) appels.push(b);
  const fichiers = appels.filter((b) => /^(Write|Edit|NotebookEdit)$/.test(b.name)).map((b) => b.input.file_path || b.input.notebook_path).filter(Boolean);
  let scratch = input.scratchpad_dir ? norm(input.scratchpad_dir, base) : null;
  for (const p of fichiers) { if (scratch) break; const m = /^(.*\/claude\/[^/]+\/[^/]+\/scratchpad)(\/|$)/.exec(norm(p, base)); if (m) scratch = m[1]; }
  const dedans = (p) => [norm(RAPPORTS, base), scratch].some((d) => d && (p === d || p.startsWith(`${d}/`)));
  const cibl = [...fichiers.map((t) => [t, base]), ...appels.filter((b) => /^(Bash|PowerShell)$/.test(b.name) && typeof b.input.command === 'string').flatMap((b) => cibles(b.input.command, base))];
  const gits = appels.filter((b) => /^(Bash|PowerShell)$/.test(b.name) && typeof b.input.command === 'string').flatMap((b) => [...b.input.command.matchAll(GIT_ECRIT)].map((m) => `git ${m[1]}`));
  return [...new Set(gits), ...new Set(cibl.filter(([t, d]) => t && !/^(\/dev\/(null|stdout|stderr|tty)|nul|con|&\d)$/i.test(t) && !/[$%`]/.test(t) && (d !== null || /^([a-z]:|[\\/~])/i.test(t)) && !dedans(norm(t, d))).map(([t]) => t))];
}

// Refus de permission de l'historique (toolDenialKind, permissionDecision) : une ligne par tool_use_id dans logs/refus.jsonl, sans doublon.
function refus(rows, input) {
  const f = path.join(LOGS, 'refus.jsonl'); const vus = new Set(fs.existsSync(f) ? readRows(f).map((r) => r.id) : []); const uses = new Map(); const lignes = [];
  const blocs = (o) => (o.message && Array.isArray(o.message.content) ? o.message.content : []);
  for (const o of rows) for (const b of blocs(o)) {
    if (b && b.type === 'tool_use') uses.set(b.id, b);
    if (!(b && b.type === 'tool_result' && o.toolDenialKind) || vus.has(b.tool_use_id)) continue;
    vus.add(b.tool_use_id); const u = uses.get(b.tool_use_id) || {}; const d = o.permissionDecision || {}; const i = u.input || {};
    const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join(' ') : JSON.stringify(b.content));
    lignes.push({ v: 5, date: o.timestamp, session: input.session_id, projet: projet(input.cwd), agent: input.agent_id || null, id: b.tool_use_id, outil: u.name || null, commande: String(i.command || i.file_path || '').slice(0, 2000) || null, composant: o.toolDenialKind, source: d.source || null, type: d.reasonType || null, regle_source: d.ruleSource || null, raison: String(txt).slice(0, 200) });
  }
  if (lignes.length) append('refus.jsonl', lignes);
}

function agent(input) {
  const file = input.agent_transcript_path;
  if (!file || !fs.existsSync(file)) { // agent interne sans historique écrit (constaté le 01/11) : le payload, sans les chemins
    const reste = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'cwd' && k !== 'session_id' && !/_path$/.test(k)));
    const date = new Date().toISOString(); const lignes = [{ v: 5, sans_historique: true, date, session: input.session_id, agent_id: input.agent_id, agent_type: input.agent_type, ...reste }];
    if (input.agent_type && !roleFile(input.agent_type, input.cwd)) lignes.push({ v: 5, alerte: `sans fichier de rôle dans agents/ : ${input.agent_type}`, type: 'sans_role', date, session: input.session_id, agent: input.agent_id, role: input.agent_type });
    return append('agents.jsonl', lignes);
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { /* sans .meta.json : rôle du payload */ }
  // Un appel nommé porte son nom dans agentType ; son vrai rôle est dans spawnedAgentType (constaté en v3).
  const role = meta.spawnedAgentType || meta.customAgentType || meta.agentType || input.agent_type || 'inconnu';
  const rows = readRows(file); const u = usage(rows, false);
  const r = roleFile(role, input.cwd);
  const { model: appel, effort: effortAppel } = paramsAppel(input.transcript_path, meta);
  const { genere } = profilActif();
  const grace = genere !== null && Date.parse(u.debut || new Date().toISOString()) < genere + 120000;
  const row = {
    v: 5, date: u.debut || new Date().toISOString(), session: input.session_id, projet: projet(input.cwd),
    agent: input.agent_id, role, nom: meta.name || null, description: meta.description || null,
    modele_role: r && r.model, modele_appel: appel, modele_servi: u.models,
    effort_role: r && r.effort, effort_appel: effortAppel, effort_servi: u.effort, tokens: u.tokens, duree_s: u.duree_s, ...rythme(rows),
    ...attente(rows), actifs_au_lancement: actifs(file, u.debut), profondeur: meta.spawnDepth ?? null, taskKind: meta.taskKind ?? null, ...(grace ? { rechargement: true } : {}),
  };
  const cran = (m) => ['haiku', 'sonnet', 'opus'].indexOf(family(m));
  const escalade = role === 'worker' && !!appel && !!r && cran(r.model) >= 0 && cran(appel) === cran(r.model) + 1; const voulu = escalade ? appel : r && r.model;
  const pas = (e) => ['low', 'medium', 'high', 'xhigh'].indexOf(e); // l'effort max n'est jamais un cran
  const escaladeEffort = !appel && !!r && ((role === 'worker' && family(r.model) === 'fable') || role === 'architect') && pas(r.effort) >= 0 && pas(effortAppel) === pas(r.effort) + 1;
  const raisons = [];
  if (role === 'general-purpose') raisons.push(['general_purpose', 'rôle general-purpose au lieu d\'un rôle du kit']);
  if (!grace && voulu && family(voulu) && u.models.some((m) => family(m) !== family(voulu))) raisons.push(['modele_servi', `modèle servi ${u.models.join('+')} au lieu de ${voulu}`]);
  if (!r && input.agent_type) raisons.push(['sans_role', `sans fichier de rôle dans agents/ : ${role}`]);
  if (appel) raisons.push(escalade ? ['escalade', `escalade du worker : ${r.model} → ${appel}`] : ['modele_impose', `modèle imposé à l'appel : ${appel}`]);
  else if (escaladeEffort) { const m = family(r.model) || r.model; raisons.push(['escalade', `escalade ${role === 'worker' ? 'du worker' : 'd\'architect'} : ${m} ${r.effort} → ${m} ${effortAppel}`]); }
  const dehors = role === 'conseil' ? ecrituresHorsZone(rows, input) : [];
  if (dehors.length) raisons.push(['conseil_ecriture', `conseil : écriture hors des rapports et du scratchpad : ${dehors.slice(0, 5).join(', ')}`]);
  const out = [row, ...raisons.map(([type, alerte]) => ({ v: 5, alerte, type, date: row.date, session: row.session, agent: row.agent, role }))];
  append('agents.jsonl', out);
  refus(rows, input);
}

function session(input) {
  const rows = readRows(input.transcript_path); const u = usage(rows, true);
  append('sessions.jsonl', [{ v: 5, date: new Date().toISOString(), session: input.session_id, projet: projet(input.cwd), debut: u.debut, modeles: u.models, tokens: u.tokens, contexte: u.contexte }]);
  refus(rows, input);
}

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    if (process.argv[2] === 'agent') agent(JSON.parse(raw)); else session(JSON.parse(raw));
  } catch (e) {
    try { append('telemetrie-erreurs.log', [`${new Date().toISOString()} ${process.argv[2]} ${(e && e.stack) || e}`]); } catch { /* journal d'erreurs inaccessible : rien d'autre à faire sans bloquer */ }
  }
  process.exit(0);
});
