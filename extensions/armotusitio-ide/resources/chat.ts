/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const api = acquireVsCodeApi();
const form = document.getElementById('chat');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const cancel = document.getElementById('cancel');
const configure = document.getElementById('configure');
let busy = false;
let credential = { configured: false, locked: true };
function credentialButtons() { configure.disabled = busy || credential.configured || credential.locked; document.getElementById('change-key').toggleAttribute('disabled', busy); document.getElementById('enable-mcp').toggleAttribute('disabled', busy); }
function append(text, role) { const message = document.createElement('pre'); message.className = role; message.textContent = text; document.getElementById('messages').append(message); message.scrollIntoView({ block: 'nearest' }); }
function pending(value) { busy = value; send.disabled = value; cancel.disabled = !value; credentialButtons(); document.getElementById('home').toggleAttribute('disabled', value); document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => { button.disabled = value; }); document.getElementById('chat-status').textContent = value ? document.getElementById('chat-status').dataset.pending : ''; form.setAttribute('aria-busy', String(value)); }
form.addEventListener('submit', event => {
	event.preventDefault();
	if (busy || !prompt.value.trim() || prompt.value.length > 10000) { return; }
	const text = prompt.value.trim(); append(text, 'question'); prompt.value = ''; pending(true); api.postMessage({ action: 'send', text });
});
cancel.addEventListener('click', () => { if (busy) { api.postMessage({ action: 'cancel' }); } });
configure.addEventListener('click', () => api.postMessage({ action: 'configure' }));
document.getElementById('change-key').addEventListener('click', () => { if (!busy) { api.postMessage({ action: 'changeKey' }); } });
document.getElementById('enable-mcp').addEventListener('click', () => { if (!busy) { api.postMessage({ action: 'enableMcp' }); } });
document.getElementById('home').addEventListener('click', () => { if (!busy) { api.postMessage({ action: 'home' }); } });
document.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => { if (!busy) { prompt.value = button.dataset.prompt; form.requestSubmit(); } }));
prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy) { form.requestSubmit(); } } });
window.addEventListener('message', event => {
	if (event.data?.type === 'credential') {
		credential = event.data;
		const status = document.getElementById('credential-status');
		status.textContent = (credential.configured ? status.dataset.configured : status.dataset.missing) + (event.data.enabled ? '' : ' \u00b7 ' + status.dataset.disabled);
		document.getElementById('change-key').hidden = !credential.configured || credential.locked;
		document.getElementById('enable-mcp').hidden = event.data.enabled || !credential.configured || credential.locked;
		credentialButtons();
	}
	if (event.data?.type === 'response' && typeof event.data.text === 'string') { append(event.data.text, 'answer'); pending(false); prompt.focus(); }
});
api.postMessage({ action: 'ready' });
