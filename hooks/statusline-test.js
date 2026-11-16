#!/usr/bin/env node
// Test de bench/statusline.js, dans un dossier temporaire (KIT_HOME) : un échantillon du payload par version de Claude Code
// (statusline-sample-<version>.json), jamais réécrit ; version absente ou douteuse (chemin, séparateur, « .. ») -> statusline-sample.json ;
// la ligne affichée ne change pas. Incident : limite Fable séparée constatée le 2026-11-10, échantillon unique daté du 2026-11-01. Code 1 si un cas échoue.
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const { spawnSync } = require('child_process');
let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : ${JSON.stringify(got)}`}`); if (!ok) fail = 1; };
const SCRIPT = path.join(__dirname, '..', 'bench', 'statusline.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-'));
const payload = (version, five = 5) => ({ ...(version === undefined ? {} : { version }), session_id: 's1', model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: five, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } });
const run = (p) => spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(p), env: { ...process.env, KIT_HOME: home }, encoding: 'utf8' });
const logs = () => (fs.existsSync(path.join(home, 'logs')) ? fs.readdirSync(path.join(home, 'logs')).sort() : []);
const sample = (f) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'logs', f), 'utf8')); } catch { return { absent: f, keys: [], rate_limits: { five_hour: {} } }; } }; // absent : le check échoue, sans exception

const a = run(payload('2.1.321'));
check('version valide : code 0, ligne affichée inchangée', a.status === 0 && a.stdout === '5 h 5 % · 7 j 7 % · opus-5-5', a);
check('version valide : statusline-sample-2.1.321.json écrit, avec la version, les clés et rate_limits', logs().includes('statusline-sample-2.1.321.json') && sample('statusline-sample-2.1.321.json').version === '2.1.321' && sample('statusline-sample-2.1.321.json').keys.includes('rate_limits') && sample('statusline-sample-2.1.321.json').rate_limits.five_hour.used_percentage === 5, logs());
run(payload('2.1.321', 9));
check('même version : l\'échantillon n\'est jamais réécrit', sample('statusline-sample-2.1.321.json').rate_limits.five_hour.used_percentage === 5, sample('statusline-sample-2.1.321.json'));
run(payload('2.1.322'));
check('nouvelle version : un second échantillon, le premier reste', logs().includes('statusline-sample-2.1.322.json') && logs().includes('statusline-sample-2.1.321.json'), logs());
for (const v of ['../../evil', 'a/b', 'a\\b', 'C:x', '..', '.hidden', 'x'.repeat(60), 5, null]) run(payload(v));
run(payload(undefined));
const echantillons = logs().filter((f) => f.startsWith('statusline-sample'));
check('versions douteuses ou absentes : seulement statusline-sample.json en plus, rien hors de logs/', JSON.stringify(echantillons) === JSON.stringify(['statusline-sample-2.1.321.json', 'statusline-sample-2.1.322.json', 'statusline-sample.json']) && JSON.stringify(fs.readdirSync(home)) === '["logs"]' && sample('statusline-sample.json').version === null, [echantillons, fs.readdirSync(home)]);

fs.rmSync(home, { recursive: true, force: true });
process.exit(fail);
