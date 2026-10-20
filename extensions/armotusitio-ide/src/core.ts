/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const profiles = Object.freeze({
	redevent: Object.freeze({ id: 'redevent', name: 'RedEvent', packageName: 'redevent', harnessDir: '.harness', repo: 'Drako01/redevent' }),
	armotusitio: Object.freeze({ id: 'armotusitio', name: 'ArmoTuSitio 2.0', packageName: 'armotusitio-next', harnessDir: 'harness', repo: 'Drako01/armotusitio2.0' })
});
const ACTIONS = Object.freeze(['doctor', 'check', 'status', 'context', 'verify', 'report', 'run', 'dispatch', 'plan', 'progress', 'abort', 'metrics', 'tokens', 'changes', 'ci-gaps', 'test', 'handoff', 'memory']);
async function detect(root) {
	let pkg;
	try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
	const profile = Object.values(profiles).find(p => p.packageName === pkg.name);
	if (!profile) { return null; }
	try { if (!(await fs.stat(path.join(root, profile.harnessDir))).isDirectory()) { return null; } } catch { return null; }
	const scripts = pkg.scripts || {};
	if (typeof scripts['harness:check'] !== 'string') { return null; }
	const manager = String(pkg.packageManager || '').startsWith('pnpm@') ? 'pnpm' : 'npm';
	return { ...profile, root, manager, actions: ACTIONS.filter(a => typeof scripts['harness:' + a] === 'string') };
}
function command(project, action) {
	if (!project || !project.actions.includes(action) || !ACTIONS.includes(action)) { throw new Error('Unsupported harness action'); }
	return { executable: project.manager, args: project.manager === 'pnpm' ? ['harness:' + action] : ['run', 'harness:' + action], cwd: project.root };
}
function validatePlan(json) {
	if (!json || !Array.isArray(json.tasks) || !json.tasks.length || json.tasks.length > 100) { throw new Error('Plan must contain 1-100 tasks'); }
	const ids = new Set();
	for (const task of json.tasks) {
		if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(task.id || '') || ids.has(task.id)) { throw new Error('Duplicate or invalid task ID'); }
		ids.add(task.id);
		if (!['claude', 'codex'].includes(task.host) || !Array.isArray(task.command) || !task.command.every(x => typeof x === 'string') || !Array.isArray(task.scope) || !Array.isArray(task.dependencies) || !Number.isSafeInteger(task.budget) || task.budget <= 0 || !['read', 'exclusive'].includes(task.resource)) { throw new Error('Invalid agent task: ' + task.id); }
		if (task.command.some(x => /dangerously-skip-permissions|--yolo|--sandbox[= ]danger-full-access/.test(x))) { throw new Error('Forbidden agent execution flag'); }
	}
	for (const task of json.tasks) { if (task.dependencies.some(id => !ids.has(id) || id === task.id)) { throw new Error('Missing or self dependency'); } }
	const seen = new Set(), active = new Set();
	function visit(id) { if (active.has(id)) { throw new Error('Cyclic plan'); } if (seen.has(id)) { return; } active.add(id); for (const dep of json.tasks.find(t => t.id === id).dependencies) { visit(dep); } active.delete(id); seen.add(id); }
	for (const task of json.tasks) { visit(task.id); }
	return { tasks: json.tasks.length, budget: json.tasks.reduce((n, t) => n + t.budget, 0) };
}
module.exports = { profiles, ACTIONS, detect, command, validatePlan };
