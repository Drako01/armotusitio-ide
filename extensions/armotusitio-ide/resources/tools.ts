/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const { revealTask } = require('./workflow.ts');

function toolsUi(ide) {
	const project = document.getElementById('tool-project') as HTMLSelectElement;
	const choice = document.getElementById('tool-choice') as HTMLSelectElement;
	const task = document.getElementById('tool-task') as HTMLInputElement;
	const host = document.getElementById('tool-host') as HTMLSelectElement;
	const run = document.getElementById('tool-run') as HTMLButtonElement;
	const result = document.getElementById('tool-result');
	let latest, displayed;
	function selected() { return latest?.projects.find(item => item.root === project.value)?.tools.find(tool => tool.id === choice.value); }
	function change() {
		const tool = selected();
		document.getElementById('tool-description').textContent = tool?.description || '';
		document.getElementById('tool-task-label').hidden = tool?.input !== 'task';
		task.required = tool?.input === 'task';
		document.getElementById('tool-host-label').hidden = tool?.input !== 'host';
		run.disabled = !latest?.trusted || !tool || latest.toolResult?.running === true;
	}
	function options(select, rows) {
		if (JSON.stringify(rows) === JSON.stringify(Array.from(select.options).map(option => [option.value, option.textContent]))) { return; }
		const value = select.value;
		select.replaceChildren(...rows.map(([id, title]) => { const option = document.createElement('option'); option.value = id; option.textContent = title; return option; }));
		if (rows.some(([id]) => id === value)) { select.value = value; }
	}
	let toolSignature;
	function tools() {
		const all = latest?.projects.find(item => item.root === project.value)?.tools || [];
		const signature = JSON.stringify(all);
		if (signature !== toolSignature) {
			toolSignature = signature;
			const value = choice.value; choice.replaceChildren();
			for (const group of [...new Set(all.map(tool => tool.group))]) {
				const section = document.createElement('optgroup'); section.label = latest.labels.toolGroups[group];
				for (const tool of all.filter(tool => tool.group === group)) { const option = document.createElement('option'); option.value = tool.id; option.textContent = tool.title; section.append(option); }
				choice.append(section);
			}
			if (all.some(tool => tool.id === value)) { choice.value = value; }
		}
		change();
	}
	project.addEventListener('change', tools); choice.addEventListener('change', change);
	document.getElementById('native-tools').addEventListener('submit', event => {
		event.preventDefault();
		if (!(event.target as HTMLFormElement).reportValidity() || run.disabled) { return; }
		ide.postMessage({ action: 'invokeTool', root: project.value, tool: choice.value, task: task.value.trim(), host: host.value });
	});
	return state => {
		latest = state;
		options(project, state.projects.filter(item => item.tools.length).map(item => [item.root, item.name])); tools();
		if (displayed === JSON.stringify([state.toolResult, state.trusted])) { return; }
		displayed = JSON.stringify([state.toolResult, state.trusted]); result.replaceChildren();
		if (!state.toolResult) { return; }
		const heading = document.createElement('h3'); heading.textContent = state.toolResult.title; result.append(heading);
		const status = document.createElement('p'); status.textContent = state.toolResult.running ? state.labels.workflow.running : state.toolResult.code === 0 ? state.labels.toolReady : state.labels.workflow.blocked; result.append(status);
		if (state.toolResult.rows) {
			const label = document.createElement('label'); label.textContent = state.labels.toolSearch;
			const search = document.createElement('input'); search.type = 'search'; label.append(search); result.append(label);
			const count = document.createElement('p'); count.className = 'muted'; count.textContent = `${state.labels.toolShowing}: ${state.toolResult.rows.length} / ${state.toolResult.total}`; result.append(count);
			const rows = document.createElement('div'); result.append(rows);
			const renderRows = () => {
				rows.replaceChildren();
				for (const item of state.toolResult.rows.filter(item => `${item.id} ${item.domain}`.toLowerCase().includes(search.value.toLowerCase()))) {
					const row = document.createElement('div'); row.className = 'task-row';
					const title = document.createElement('strong'); title.textContent = item.id;
					const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = `${state.labels.workflow[item.domain] || item.domain} \u00b7 ${item.state === 'active' ? state.labels.toolRegisteredActive : state.labels.states[item.state] || item.state}`;
					const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.textContent = state.labels.toolOpenTask; open.disabled = !state.trusted;
					open.addEventListener('click', () => { revealTask(item.id, state.toolResult.project); ide.postMessage({ action: 'observeTask', root: state.toolResult.project, id: item.id }); });
					row.append(title, detail, open); rows.append(row);
				}
			};
			search.addEventListener('input', renderRows); renderRows();
			return;
		}
		if (state.toolResult.text) {
			const pre = document.createElement('pre'); pre.className = 'tool-output'; pre.textContent = state.toolResult.text;
			try {
				const data = JSON.parse(state.toolResult.text);
				const render = (parent, value, depth = 0) => {
					if (value === null || typeof value !== 'object') { const text = document.createElement('span'); text.textContent = String(value ?? '\u2014'); parent.append(text); return; }
					if (depth > 4) { const text = document.createElement('pre'); text.className = 'tool-output'; text.textContent = JSON.stringify(value, null, 2); parent.append(text); return; }
					for (const [key, item] of Object.entries(value)) {
						const row = document.createElement('details'); row.open = depth === 0;
						const label = document.createElement('summary'); label.textContent = Array.isArray(value) ? String(Number(key) + 1) : key.replace(/([a-z])([A-Z])/g, '$1 $2'); row.append(label);
						render(row, item, depth + 1); parent.append(row);
					}
				};
				render(result, data);
				const raw = document.createElement('details'); const label = document.createElement('summary'); label.textContent = state.labels.toolRaw; raw.append(label, pre); result.append(raw);
			} catch { result.append(pre); }
		}
	};
}

module.exports = { toolsUi };
