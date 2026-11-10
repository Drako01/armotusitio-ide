/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
/**
 * Shared Codex read-only child limits (one-shot and app-server).
 * V2 ignores agents.max_depth; force V1 explicitly so the depth limit is enforced.
 * Never enable children by default, and never rely on model prompts as a security boundary.
 */
export function readonlyCodexSubagentOverrides(enabled: boolean): string[] {
	return enabled ? [
		'--config', 'features.multi_agent_v2=false',
		'--config', 'features.collab=true',
		'--config', 'tools.web_search=false',
		'--config', 'agents.enabled=true',
		'--config', 'agents.max_concurrent_threads_per_session=2',
		'--config', 'agents.max_depth=1',
		'--config', 'agents.interrupt_message=true'
	] : [];
}
