/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { capabilities, sortActivity } = require('../src/adapter.ts');
const { nativeRun } = require('../src/workflow.ts');

test('capability negotiation fails closed for unknown versions and incomplete lifecycle contracts', () => {
	const value = { contract: 'armotusitio-harness-ide', version: '1.0.0', schemaVersion: 1, hosts: ['project'], operations: Object.fromEntries(['preflight','run','execute','progress','list','status','resume','retry','abort'].map(name => [name, { supported: true }])) };
	assert.deepEqual(capabilities(value).hosts, ['project']);
	assert.throws(() => capabilities({ ...value, schemaVersion: 2 }), /HARNESS_CONTRACT/);
	assert.throws(() => capabilities({ ...value, operations: {} }), /HARNESS_CAPABILITY/);
});

test('activity order is shared and never puts an interrupted record above running work', () => {
	const rows = [{ id: 'old', phase: 'interrupted', startedAt: 300 }, { id: 'live', phase: 'running', progress: { live: true }, startedAt: 100 }, { id: 'review', phase: 'review', startedAt: 200 }];
	assert.deepEqual(sortActivity(rows).map(row => row.id), ['live', 'review', 'old']);
});

test('native observation shares equivalent reads and bounds subprocess concurrency across roots', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-read-coordinator-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const profiles = [];
	for (let index = 0; index < 4; index++) {
		const directory = path.join(root, String(index)); await fs.mkdir(path.join(directory, '.harness'), { recursive: true });
		await fs.writeFile(path.join(directory, '.harness/core.mjs'), `const start=Date.now(); setTimeout(()=>console.log(JSON.stringify({id:'fixture',pid:process.pid,start,end:Date.now()})),200);`);
		profiles.push({ id: 'redevent', root: directory });
	}
	const results = await Promise.all([nativeRun(profiles[0], ['progress','--json']), nativeRun(profiles[0], ['progress','--json']), ...profiles.slice(1).map(profile => nativeRun(profile, ['progress','--json']))]);
	assert.equal(results[0].value.pid, results[1].value.pid);
	const intervals = results.slice(1).flatMap(result => [{at:result.value.start,delta:1},{at:result.value.end,delta:-1}]).sort((a,b)=>a.at-b.at || a.delta-b.delta);
	let live=0, maximum=0; for (const event of intervals) { live+=event.delta; maximum=Math.max(maximum,live); }
	assert.ok(maximum <= 2);
});

test('streamed diagnostics redact credentials split between stderr chunks', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-redaction-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
	await fs.mkdir(path.join(root,'.harness'));
	await fs.writeFile(path.join(root,'.harness/core.mjs'), `process.stderr.write('api_key='); setTimeout(()=>{process.stderr.write('private-value\\n'); console.log('{}');},50);`);
	let logs=''; await nativeRun({ id:'redevent',root }, ['status','fixture'], { log: text=>{logs+=text;} });
	assert.doesNotMatch(logs,/private-value/); assert.match(logs,/redacted/);
	await fs.writeFile(path.join(root,'.harness/core.mjs'), `process.stderr.write('password='+'synthetic-private-value'.repeat(6000)+String.fromCharCode(10)); console.log('{}');`);
	const oversized = await nativeRun({ id:'redevent',root }, ['status','fixture']);
	assert.doesNotMatch(oversized.error,/synthetic-private-value/);
});


test('versioned producer payloads preserve currentGate.node, domains and terminal outcomes', () => {
	const {progressView}=require('../src/workflow.ts');
	const running=progressView(require('./fixtures/armotusitio-ide-v1/progress-running.json'));
	const cancelled=progressView(require('./fixtures/armotusitio-ide-v1/progress-cancelled.json'));
	assert.deepEqual([running.currentGate.id,running.currentGate.domain,cancelled.outcome],['alpha','fixture','cancelled']);
	const multi=progressView({id:'multi',state:'running',live:true,finalGates:{done:2,total:3,current:'private command'}});
	assert.deepEqual(multi.finalGates[0].gates,{done:2,total:3});
	assert.doesNotMatch(JSON.stringify(multi),/private command/);
});
