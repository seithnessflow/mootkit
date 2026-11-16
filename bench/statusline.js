#!/usr/bin/env node
// Ligne de statut : affiche l'usage du forfait (fenêtres 5 h et 7 jours) et le modèle, et journalise cet usage
// (logs/ratelimit.json, logs/ratelimits.jsonl) pour bench/report.js.
// Claude Code passe un JSON sur stdin ; `rate_limits.five_hour/seven_day.used_percentage` (relevé dans le
// binaire 2.1.287, non documenté). Un échantillon brut est gardé dans logs/statusline-sample.json pour vérifier.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// KIT_HOME : dossier du kit (défaut ~/.claude). Les suites de tests le pointent vers un dossier temporaire.
const HOME = process.env.KIT_HOME || path.join(os.homedir(), '.claude');
const LOGS = path.join(HOME, 'logs');
const LAST = path.join(LOGS, 'ratelimit.json');

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* payload illisible : ligne minimale */ }
const pct = (w) => {
  const v = w && (w.used_percentage ?? w.usedPercentage ?? w.utilization);
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
};
const rl = input.rate_limits || input.rateLimits || {};
const five = pct(rl.five_hour || rl.fiveHour);
const seven = pct(rl.seven_day || rl.sevenDay);

try {
  fs.mkdirSync(LOGS, { recursive: true });
  // Un échantillon par version de Claude Code (statusline-sample-<version>.json), jamais réécrit : le payload change d'une version à l'autre
  // (incident : limite Fable séparée constatée le 2026-11-10, échantillon unique daté du 2026-11-01). Version absente ou douteuse : statusline-sample.json.
  const ver = typeof input.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,40}$/.test(input.version) && !input.version.includes('..') ? input.version : null;
  const sample = path.join(LOGS, ver ? `statusline-sample-${ver}.json` : 'statusline-sample.json');
  if (!fs.existsSync(sample)) fs.writeFileSync(sample, JSON.stringify({ ts: new Date().toISOString(), version: ver, keys: Object.keys(input), rate_limits: rl }, null, 2));
  if (five !== null || seven !== null) {
    let last = {};
    try { last = JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch { /* premier relevé */ }
    const row = { ts: new Date().toISOString(), five_hour: five, seven_day: seven, session: input.session_id || null, model: (input.model || {}).id || null, effort: typeof input.effort === 'string' ? input.effort : (input.effort && input.effort.level) || null,
      five_reset: (rl.five_hour || {}).resets_at || null, seven_reset: (rl.seven_day || {}).resets_at || null };
    fs.writeFileSync(LAST, JSON.stringify(row));
    // Historique : seulement quand un pourcentage change (la ligne de statut est rafraîchie très souvent).
    if (last.five_hour !== five || last.seven_day !== seven) fs.appendFileSync(path.join(LOGS, 'ratelimits.jsonl'), JSON.stringify(row) + '\n');
  }
} catch { /* la ligne de statut ne doit jamais échouer */ }

const model = ((input.model || {}).display_name || (input.model || {}).id || '').replace(/^claude-/, '');
const fmt = (v) => (v === null ? '—' : v + ' %');
const parts = [`5 h ${fmt(five)}`, `7 j ${fmt(seven)}`];
if (model) parts.push(model);
process.stdout.write(parts.join(' · '));
