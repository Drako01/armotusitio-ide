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
function append(text, role) { const message = document.createElement('pre'); message.className = role; message.textContent = text; document.getElementById('messages').append(message); message.scrollIntoView({ block: 'nearest' }); }
function pending(value) { busy = value; send.disabled = value; cancel.disabled = !value; configure.disabled = value; }
form.addEventListener('submit', event => {
	event.preventDefault();
	if (busy || !prompt.value.trim() || prompt.value.length > 10000) { return; }
	const text = prompt.value.trim(); append(text, 'question'); prompt.value = ''; pending(true); api.postMessage({ action: 'send', text });
});
cancel.addEventListener('click', () => { if (busy) { api.postMessage({ action: 'cancel' }); } });
configure.addEventListener('click', () => api.postMessage({ action: 'configure' }));
window.addEventListener('message', event => { if (event.data?.type === 'response' && typeof event.data.text === 'string') { append(event.data.text, 'answer'); pending(false); prompt.focus(); } });
