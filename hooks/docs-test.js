#!/usr/bin/env node
// Test des règles écrites du kit (CLAUDE.md, skills/relecture/SKILL.md, gabarits) : une règle de la demande v5 absente du texte fait échouer le cas.
// Contrôle de présence seulement (le texte est lu par un modèle, pas exécuté) : il garde la demande, il ne prouve pas que la session la suit. Code 1 si un cas échoue.
'use strict';
const fs = require('fs');
const path = require('path');

const kit = path.join(__dirname, '..');
const lit = (...p) => fs.readFileSync(path.join(kit, ...p), 'utf8');
const doc = lit('CLAUDE.md');
const skill = lit('skills', 'relecture', 'SKILL.md');
const desc = (/^description:\s*(.*)$/m.exec(skill) || [])[1] || '';
const etape = (n) => (new RegExp(`^${n}\\. \\*\\*[^\\n]*(\\n {3}-[^\\n]*)*`, 'm').exec(skill) || [''])[0]; // une étape numérotée de SKILL.md, puces comprises
const ligne = (txt, motif) => txt.split('\n').filter((l) => motif.test(l)).join('\n');

let fail = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` : ${String(got).slice(0, 300)}`}`); if (!ok) fail = 1; };

// C11 : relecture plus épaisse en profil max, ventilation par relecteur dans tous les profils.
check('C11 description du skill : seuils 150 lignes, 50 lignes en profil max, architecte dès 150 en max', /150 lignes/.test(desc) && /50 lignes/.test(desc) && /max/.test(desc) && /architect/.test(desc), desc);
check('C11 description du skill : eco et normal gardent 400 lignes pour l\'architecte', /400 lignes/.test(desc), desc);
check('C11 SKILL.md : en max, de 50 à 150 lignes, reviewer-tests et reviewer-securite puis verifier', /max/.test(etape(3)) && /50/.test(etape(3)) && /reviewer-tests/.test(etape(3)), etape(3));
check('C11 SKILL.md : en max, au-delà de 150 lignes, architect en parallèle des deux relecteurs, puis verifier', /architect[^\n]*(150[^\n]*max|max[^\n]*150)/.test(etape(3)), etape(3));
check('C11 SKILL.md : eco et normal gardent l\'architecte au-delà de 400 lignes', /architect[^\n]*400 lignes/.test(etape(3)), etape(3));
check('C11 SKILL.md : sans relecture, le seuil est 150 lignes, dès 50 en max (C14-M : 49 ou moins)', /150 lignes ou moins \(49 lignes ou moins en profil max/.test(skill), skill.split('\n').pop());
check('C11 SKILL.md : une ligne par relecteur avec trouvés, corrigés, écartés', /une ligne par relecteur/.test(etape(6)) && /trouvés/.test(etape(6)) && /corrigés/.test(etape(6)) && /écartés/.test(etape(6)), etape(6));
check('C11 SKILL.md : la ligne 15 reprend la ligne « RELECTURE CODEX : » du script, plus « Codex : N Ko envoyés »', /RELECTURE CODEX : /.test(etape(6)) && !/Codex : N Ko envoyés/.test(skill), etape(6));
check('C11 SKILL.md : rien à envoyer, Codex n\'est pas appelé', /Codex n'est (alors )?pas appelé/.test(etape(3)), etape(3));
check('C11 CLAUDE.md : relecture dès 50 lignes en profil max, 150 sinon', /150 lignes/.test(ligne(doc, /^- Relecture/)) && /50 lignes/.test(ligne(doc, /^- Relecture/)) && /max/.test(ligne(doc, /^- Relecture/)), ligne(doc, /^- Relecture/));
check('C11 CLAUDE.md : au-delà de 150 lignes en max, reviewer-tests, reviewer-securite et architect en parallèle puis verifier', /reviewer-tests/.test(ligne(doc, /^- Relecture/)) && /architect/.test(ligne(doc, /^- Relecture/)) && /verifier/.test(ligne(doc, /^- Relecture/)), ligne(doc, /^- Relecture/));
check('CLAUDE.md : le rapport ventile par relecteur, dans tous les profils', /une ligne par relecteur/.test(ligne(doc, /Relu ou pas/)) && /trouvés/.test(ligne(doc, /Relu ou pas/)) && /écartés/.test(ligne(doc, /Relu ou pas/)), ligne(doc, /Relu ou pas/));

// C12 : architect en amont (plan court avant les workers) et escalade d'un worker qui échoue deux fois.
const archi = lit('profils', 'gabarits', 'architect.md');
const roles = ligne(doc, /^Ne lance jamais/);
const orch = doc.slice(doc.indexOf('## Orchestration'), doc.indexOf('## Rôles et profils'));
const escalade = ligne(orch, /échoue deux fois/);
const descArchi = (/^description:\s*(.*)$/m.exec(archi) || [])[1] || '';
check('C12 gabarit architect : mode plan en amont, avant les workers, avec découpage, interfaces, risques, ce qui sera vérifié', /Plan en amont/.test(archi) && /avant les workers/.test(archi) && /découpage/i.test(archi) && /interfaces/i.test(archi) && /risques/i.test(archi) && /vérifié/.test(archi), archi.slice(0, 400));
check('C12 gabarit architect : la description annonce le plan en amont', /plan/i.test(descArchi), descArchi);
check('C12 gabarit architect : ne code toujours pas, lecture seule', /Ne code jamais/.test(archi) && /disallowedTools: Write, Edit, NotebookEdit/.test(archi), archi.slice(0, 300));
check('C12 CLAUDE.md : architecture, nouveau module ou diff prévu de plus de 300 lignes : architect fait un plan court avant les workers', /architecture/.test(orch) && /crée un module/.test(orch) && /300 lignes/.test(orch) && /architect[^\n]*plan court[^\n]*avant les workers/.test(orch), orch);
check('C12 CLAUDE.md : la session suit le plan ou explique au rapport pourquoi elle s\'en écarte', /s'en écarte/.test(orch) && /rapport/.test(ligne(orch, /s'en écarte/)), orch);
check('C12 CLAUDE.md : un worker qui échoue deux fois passe la main à un worker d\'un cran au-dessus, noté au rapport', /worker/.test(escalade) && /cran/.test(escalade) && /rapport/.test(escalade), escalade);
check('C12 CLAUDE.md : exception (c) au « ne passe jamais de modèle à l\'appel »', /\(c\)/.test(roles) && /cran/.test(roles), roles);
check('C12 CLAUDE.md : l\'alerte de télémétrie se déclenche alors, c\'est voulu', /alerte/.test(escalade + roles) && /voulu/.test(escalade + roles), escalade + roles);
// Table Fable 5.2 (sortie de Fable 5.2 et benchmarks par effort, 2026-11-09) : les deux cas C12 « worker déjà en opus, sans Fable pour le worker » et « relance Fable de (b) sans objet en max »
// sont remplacés à la demande de l'utilisateur : le worker du profil max est sur Fable, architect est sur Fable en normal et en max, eco n'a pas de Fable ;
// l'exception (b) devient une relance d'architect à l'effort du cran au-dessus, sans changer de modèle, et l'utilisateur n'est prévenu que si architect est déjà en xhigh.
// Table v5-fable52b (limite Fable séparée constatée le 2026-11-10) : le worker du profil max passe de Fable à Opus ; les deux cas « worker déjà sur Fable » suivent la nouvelle règle.
// Table v5-fable52d (incohérences de la table relevées le 2026-11-12) : le worker normal passe sur Opus ; la règle d'escalade couvre donc les profils normal et max (medium → high, high → xhigh).
check('Fable 5.2d CLAUDE.md : un worker déjà sur Opus (profils normal et max) garde son modèle et monte l\'effort d\'un cran (medium → high, high → xhigh), sans paramètre model ; en eco, sonnet → opus au même effort ; plus de « worker déjà sur Fable »', /déjà sur Opus \(profils normal et max\)/.test(escalade) && !/déjà sur Fable/.test(escalade) &&/effort d'un cran/.test(escalade) && /high → xhigh/.test(escalade) && /medium → high, high → xhigh, paramètre effort/.test(escalade) && /sans paramètre model/.test(escalade) && /en profil eco, un cran de modèle \(sonnet → opus, même effort, paramètre model de l'appel\)/.test(escalade), escalade);
check('Fable 5.2 CLAUDE.md : échec encore : architect en débogage ; plus de « sans Fable pour le worker »', /Échec encore → architect en débogage/.test(escalade) && !/sans Fable pour le worker/.test(doc), escalade);
const relance = (/Si ce passage n'a pas résolu l'erreur[^.]*\./.exec(escalade) || [''])[0]; // la phrase de la relance (b), seule
check('Fable 5.2 CLAUDE.md : (b) architect relancé une seule fois à l\'effort du cran au-dessus (high → xhigh), sans changer de modèle, même brief complété', /relance architect une seule fois/.test(relance) && /effort d'un cran/.test(relance) && /high → xhigh/.test(relance) && /sans paramètre model/.test(relance) && /même brief/.test(relance) && /\(b\)/.test(relance) && !/avec le modèle Fable/.test(doc), relance || escalade);
check('Fable 5.2 CLAUDE.md : (b) architect déjà en xhigh (profil max) : pas de relance, alors seulement prévenir l\'utilisateur', /déjà en xhigh[^;.]*: pas de relance/.test(relance) && /alors seulement prévenir l'utilisateur/.test(relance) && (escalade.match(/prévenir l'utilisateur/g) || []).length === 1, relance || escalade);
check('Fable 5.2 CLAUDE.md : (b) est une exception au « ni modèle ni effort à l\'appel », et l\'ancienne (b) vers Fable a disparu', /\(b\)[^;]*architect[^;]*effort/.test(roles) && !/escalade de débogage vers Fable/.test(doc) && !/n'existe plus/.test(roles), roles);
check('Fable 5.2 CLAUDE.md : Fable là où la table le dit ; l\'ancienne règle « Fable ne tourne que dans » a disparu', /Fable tourne là où la table le dit/.test(roles) && !/Fable ne tourne que dans/.test(doc), roles);
check('Fable 5.2d CLAUDE.md : en profil eco, aucun Fable dans les sous-agents, sans exception (le conseil y passe sur Opus) ; plus de « sauf le conseil »', /en profil eco, aucun Fable dans les sous-agents, sans exception \(le conseil y passe sur Opus\)/.test(roles) && !/sauf le conseil/.test(roles), roles);
check('Fable 5.2 CLAUDE.md : l\'effort max ne s\'utilise jamais, quel que soit le rôle', /effort max ne s'utilise jamais, quel que soit le rôle/.test(roles), roles);
check('Fable 5.2d CLAUDE.md : l\'exception (c) couvre l\'effort d\'un worker déjà sur Opus ; Fable n\'est jamais pour le worker', /\(c\)[^;]*effort[^;]*Opus/.test(roles) && !/\(c\)[^;]*Fable/.test(roles) && /jamais au worker/.test(roles) && !/pas dans le worker/.test(roles), roles);
check('C12 CLAUDE.md : l\'arrêt après 3 tentatives reste', /3 tentatives ont échoué/.test(doc), 'ligne « Quand t\'arrêter » absente');

// C13 : le conseil n'écrit que dans rapports\ et dans son scratchpad ; Bash lui reste, la trace est non bloquante (telemetrie.js).
const conseil = lit('profils', 'gabarits', 'conseil.md');
check('C13 gabarit conseil : écrit seulement dans rapports\\ (son rapport) et dans son scratchpad (fichiers de travail)', /rapports/.test(conseil) && /scratchpad/.test(conseil) && /seulement|n'écris que/.test(ligne(conseil, /scratchpad/)), ligne(conseil, /^- Lecture seule/));
check('C13 gabarit conseil : une écriture ailleurs (redirection, tee, cp, mv, sed -i, Set-Content) est signalée par la télémétrie', /télémétrie/.test(conseil) && /redirection/.test(conseil) && /Set-Content/.test(conseil), ligne(conseil, /^- Lecture seule/));
check('C13 gabarit conseil : Bash reste, aucun outil retiré', /^tools: Read, Grep, Glob, Bash, Write$/m.test(conseil) && /^disallowedTools: Edit, NotebookEdit, Agent$/m.test(conseil), conseil.slice(0, 300));

// C14-M : « dès 50 lignes » : un diff de 50 lignes pile est relu en profil max (CLAUDE.md, description et dernière ligne de SKILL.md).
const relec = ligne(doc, /^- Relecture/);
check('C14-M CLAUDE.md : en profil max, dès 50 lignes (50 pile est relu), 150 sinon', /dès 50 lignes/.test(relec) && /dépasse 150 lignes/.test(relec) && !/\(50 en profil max\)/.test(relec), relec);
check('C14-M description du skill : dès 50 lignes en profil max, au-delà de 150 sinon', /dès 50 lignes en profil max/.test(desc) && /dépasse 150 lignes/.test(desc) && !/150 lignes \(ajoutées \+ supprimées\), 50 lignes en profil max/.test(desc), desc);
check('C14-M SKILL.md : sans relecture, 150 lignes ou moins (49 ou moins en profil max)', /150 lignes ou moins \(49 lignes ou moins en profil max/.test(skill) && !/\(50 en profil max\)/.test(skill), skill.split('\n').pop());

// C14-N : la taille du diff compte aussi les fichiers créés par la tâche (non suivis ou ignorés par git).
check('C14-N SKILL.md étape 1 : la taille ajoute les lignes des fichiers créés par la tâche, non suivis ou ignorés', /shortstat/.test(etape(1)) && /créés par la tâche/.test(etape(1)) && /non suivis/.test(etape(1)) && /ignorés/.test(etape(1)) && /wc -l/.test(etape(1)), etape(1));

// C14-H : agents/*.md sont générés.
check('C14-H CLAUDE.md : agents/*.md sont générés, retoucher profils/gabarits/', /agents\/\*\.md sont générés : retoucher profils\/gabarits\//.test(doc), ligne(doc, /agents\/\*/));

// C14-J : le conseil, gabarit (description et ligne sur la télémétrie).
check('C14-J gabarit conseil : la description dit qu\'il écrit seulement dans rapports\\ et son scratchpad', /^description:[^\n]*écrit seulement dans rapports\\ et son scratchpad/m.test(conseil), conseil.split('\n')[2]);
check('C14-J gabarit conseil : la télémétrie signale « les écritures visibles dans le texte de la commande », plus « toute écriture »', /les écritures visibles dans le texte de la commande/.test(conseil) && !/toute écriture/.test(conseil), ligne(conseil, /télémétrie/));

// C14-O : settings.exemple.json : chaque hook du kit (événement, matcher, commande) et les deux règles Agent(...).
const settings = JSON.parse(lit('settings.exemple.json'));
const hooks = settings.hooks || {};
const node = (script) => `node "$HOME/.claude/hooks/${script}"`;
const ATTENDU = [['SessionStart', null, node('profil.js')], ['PreToolUse', 'Read', node('rappels.js')], ['PostToolUse', 'Bash|PowerShell|Write', node('rappels.js')], ['UserPromptSubmit', null, node('rappels.js')], ['SubagentStop', null, `${node('telemetrie.js')} agent`], ['Stop', null, `${node('telemetrie.js')} session`]];
check('C14-O settings.exemple.json : exactement les six événements du kit', JSON.stringify(Object.keys(hooks).sort()) === JSON.stringify(ATTENDU.map((a) => a[0]).sort()), Object.keys(hooks));
for (const [ev, matcher, commande] of ATTENDU) {
  const groupes = hooks[ev] || [];
  const h = groupes.length === 1 ? groupes[0] : {};
  check(`C14-O settings.exemple.json ${ev}${matcher ? ` (matcher ${matcher})` : ' (sans matcher)'} : une commande ${commande}`, groupes.length === 1 && (h.matcher == null ? null : h.matcher) === matcher && Array.isArray(h.hooks) && h.hooks.length === 1 && h.hooks[0].type === 'command' && h.hooks[0].command === commande && typeof h.hooks[0].timeout === 'number', groupes);
  const script = (/hooks\/([\w-]+\.js)/.exec(commande) || [])[1];
  check(`C14-O settings.exemple.json ${ev} : le script ${script} existe dans le kit`, !!script && fs.existsSync(path.join(kit, 'hooks', script)), script);
}
const deny = (settings.permissions || {}).deny || [];
check('C14-O settings.exemple.json : les règles Agent(claude) et Agent(general-purpose) refusent ces deux types d\'agent', deny.includes('Agent(claude)') && deny.includes('Agent(general-purpose)'), deny.filter((r) => /^Agent/.test(r)));

// C14-E / C14-D : SKILL.md dit de toujours passer `--` et décrit les plages de lignes.
check('C14-E SKILL.md : toujours passer `--` (sans lui, la liste n\'est pas fournie : « partielle », jamais « RAS »)', /toujours `--`/.test(etape(3)) && /partielle/.test(ligne(etape(3), /toujours `--`/)) && /RAS/.test(ligne(etape(3), /toujours `--`/)), etape(3));
check('C14-D SKILL.md : un fichier seul de plus de 150 Ko part en plages de lignes, le reste est nommé', /plages de lignes/.test(etape(3)), etape(3));

// Interrupteur « sans Fable » (limite Fable séparée constatée le 2026-11-10) : en langage libre, même mécanique que le forçage, conseil compris.
const sansFable = ligne(doc, /« sans Fable »/);
check('sans Fable CLAUDE.md : « sans Fable » ou formule équivalente lance profil.js fable coupe ; « Fable autorisé » lance profil.js fable autorise', /formule équivalente/.test(sansFable) && /hooks\/profil\.js fable coupe`/.test(sansFable) && /« Fable autorisé »/.test(sansFable) && /hooks\/profil\.js fable autorise`/.test(sansFable), sansFable);
check('sans Fable CLAUDE.md : chaque rôle Fable passe sur Opus au même effort, conseil compris', /Fable passe sur Opus au même effort, conseil compris/.test(sansFable), sansFable);
check('sans Fable CLAUDE.md : comme le forçage, jusqu\'au retour, sur toutes les sessions, noté dans profils.jsonl et annoncé au démarrage', /jusqu'au retour/.test(sansFable) && /toutes les sessions/.test(sansFable) && /profils\.jsonl/.test(sansFable) && /annoncé au démarrage/.test(sansFable), sansFable);
check('sans Fable CLAUDE.md : l\'en-tête du rapport le dit quand il est actif', /« profil : <profil actif, mode, rythme> » \(forçage compris, et « sans Fable » s'il est actif\)/.test(doc), ligne(doc, /profil : </));

// Table v5-fable52d. Incident : incohérences de la table relevées le 2026-11-12. Trois blocs, un par point.
// ===== POINT 1 (table) : la table de CLAUDE.md reproduit profils/profils.json, ligne par ligne =====
const profils = JSON.parse(lit('profils', 'profils.json'));
const lignesTable = doc.split('\n').filter((l) => /^\| [\w-]+ \| (haiku|sonnet|opus|fable) \w+ \| (haiku|sonnet|opus|fable) \w+ \| (haiku|sonnet|opus|fable) \w+ \|/.test(l));
const dansDoc = Object.fromEntries(lignesTable.map((l) => { const c = l.split('|').map((x) => x.trim()); return [c[1], c.slice(2, 5).join(' | ')]; }));
const dansJson = Object.fromEntries(Object.entries(profils).filter(([k]) => k !== '_table').map(([role, v]) => [role, `${v.eco} | ${v.normal} | ${v.max}`]));
const ecartsTable = [...new Set([...Object.keys(dansDoc), ...Object.keys(dansJson)])].filter((r) => dansDoc[r] !== dansJson[r]).map((r) => `${r} : CLAUDE.md « ${dansDoc[r]} » / profils.json « ${dansJson[r]} »`);
check('POINT 1 CLAUDE.md : la table des rôles reproduit profils.json ligne par ligne (9 rôles, eco | normal | max, aucun rôle en trop ni en moins)', lignesTable.length === 9 && Object.keys(dansJson).length === 9 && ecartsTable.length === 0, ecartsTable);
check('POINT 1 profils.json : version de la table v5-fable52d', profils._table === 'v5-fable52d', profils._table);

// ===== POINT 2 (règles) : Fable réservé, escalade, relance (b), « sans Fable » =====
check('POINT 2 CLAUDE.md : Fable réservé aux rôles de raisonnement, de planification et de recherche (researcher, architect, conseil), jamais au worker', /il est réservé aux rôles de raisonnement, de planification et de recherche \(researcher, architect, conseil\), jamais au worker/.test(roles), roles);
check('POINT 2 CLAUDE.md : Fable tourne là où la table le dit ; en eco aucun Fable sans exception, le conseil y passe sur Opus', /Fable tourne là où la table le dit : en profil eco, aucun Fable dans les sous-agents, sans exception \(le conseil y passe sur Opus\)/.test(roles), roles);
check('POINT 2 CLAUDE.md : escalade du worker, en eco sonnet → opus au même effort (paramètre model), déjà sur Opus (normal et max) l\'effort d\'un cran (medium → high, high → xhigh, paramètre effort, sans paramètre model)', /en profil eco, un cran de modèle \(sonnet → opus, même effort, paramètre model de l'appel\) ; un worker déjà sur Opus \(profils normal et max\) garde son modèle et monte l'effort d'un cran \(medium → high, high → xhigh, paramètre effort de l'appel, sans paramètre model\)/.test(escalade), escalade);
check('POINT 2 CLAUDE.md : relance (b) de l\'architect, effort d\'un cran, même modèle (medium → high, high → xhigh) : opus high → opus xhigh en eco, fable medium → fable high en normal, fable high → fable xhigh en max', /effort d'un cran \(exception \(b\) : medium → high, high → xhigh, paramètre effort de l'appel, sans paramètre model : opus high → opus xhigh en eco, fable medium → fable high en normal, fable high → fable xhigh en max\)/.test(relance), relance);
check('POINT 2 CLAUDE.md : « sans Fable » remplace chaque rôle Fable par Opus au même effort, conseil compris ; l\'effort max ne s\'utilise jamais', /chaque rôle sur Fable passe sur Opus au même effort, conseil compris/.test(sansFable) && /effort max ne s'utilise jamais, quel que soit le rôle/.test(roles), [sansFable, roles]);

// ===== POINT 3 (cohérence) : la règle de cohérence de la table est écrite, et dit qu'elle est testée par profil-test.js =====
const coherenceDoc = ligne(doc, /^Cohérence de la table/);
check('POINT 3 CLAUDE.md : cohérence de la table, testée par hooks/profil-test.js sur profils/profils.json', /testée par hooks\/profil-test\.js sur profils\/profils\.json/.test(coherenceDoc), coherenceDoc);
check('POINT 3 CLAUDE.md : r1, sur chaque ligne d\'eco à max le modèle ne descend jamais de gamme (haiku < sonnet < opus < fable) et à modèle égal l\'effort ne descend jamais', /d'eco à max, le modèle ne descend jamais de gamme \(haiku < sonnet < opus < fable\) et, à modèle égal, l'effort ne descend jamais/.test(coherenceDoc), coherenceDoc);
check('POINT 3 CLAUDE.md : r2, d\'un profil au suivant une ligne ne saute pas de gamme, sauf le researcher (sonnet → fable), avec sa raison', /d'un profil au suivant, une ligne ne saute pas de gamme, sauf le researcher \(sonnet → fable\), parce qu'en recherche Fable en low fait mieux qu'Opus en medium pour le même coût/.test(coherenceDoc), coherenceDoc);

// Brief d'un worker (rapport 2026-11-16_00h25-workers-longs.md : 35 briefs longs sur 50 renvoyaient à un long document, contre 2 sur 16 chez les courts).
const briefW = ligne(doc, /^- Brief d'un worker/); const worker = lit('profils', 'gabarits', 'worker.md');
check('BRIEF CLAUDE.md : le brief d\'un worker donne l\'extrait du plan de son étape, les fichiers à toucher et les plages de lignes', /extrait du plan/.test(briefW) && /fichiers à toucher/.test(briefW) && /plages de lignes/.test(briefW), briefW);
check('BRIEF CLAUDE.md : jamais « lis le plan » pour un document de plus de 10 000 caractères ; sans les plages, un scout d\'abord', /jamais « lis le plan »/.test(briefW) && /10 000 caractères/.test(briefW) && /scout/.test(briefW) && /avant de lancer le worker/.test(briefW), briefW);
check('BRIEF gabarit worker : renvoi à un long document sans extrait, ne lire que la partie de son étape', /long document sans extrait/.test(worker) && /seulement la partie qui concerne ton étape/.test(worker), worker);
// Attente d'une commande longue (même rapport : 66 pauses de plus de 5 min, 73,30 $ de cache réécrit ; essai du 2026-11-16 : commande au premier plan passée en arrière-plan à 180 s).
const archiG = lit('profils', 'gabarits', 'architect.md');
check('ATTENTE gabarit worker : commande longue en arrière-plan, attendue par des appels au premier plan de 170 s au plus, jamais par une fin de tour', /plus de 3 min/.test(worker) && /run_in_background/.test(worker) && /FIN \$\?/.test(worker) && /170 s au plus/.test(worker) && /timeout: 170000/.test(worker) && /[Nn]e termine jamais ton tour pour attendre/.test(worker), worker);
check('ATTENTE gabarit worker : attente totale bornée à 45 min, puis rendre la main en le disant', /45 min/.test(worker) && /rends la main en le disant/.test(worker), worker);
check('ATTENTE gabarit architect : un test long s\'attend comme le worker, 170 s au plus, jamais par une fin de tour', /plus de 3 min/.test(archiG) && /170 s au plus/.test(archiG) && /jamais par une fin de tour/.test(archiG), archiG);

process.exit(fail);
