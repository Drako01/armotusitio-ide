/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Work Management stays in the extension: provider processes never receive its credential. */
import { redactSecrets } from './native-redact.ts';

export const MCP_TOOL_PREFIX = 'armotusitio__';
const READ = new Set(['list_projects', 'get_project_context', 'get_project_board', 'get_project_sprints', 'get_project_repositories', 'get_project_releases', 'get_project_okrs', 'get_okr_dashboard', 'list_issues', 'search_issues', 'get_issue', 'get_issue_context']);
const WRITE = new Set(['create_issue', 'create_subtask', 'edit_issue', 'assign_issue', 'transition_issue', 'set_issue_priority', 'set_issue_sprint', 'move_issue_to_backlog', 'add_issue_comment']);
export interface WorkMcpTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface WorkMcpClient { tools(): Promise<WorkMcpTool[]>; call(name: string, args: Record<string, unknown>): Promise<unknown> }
export interface WorkMcpBridge {
	tools(): Promise<WorkMcpTool[]>;
	call(name: string, args: unknown): Promise<unknown>;
}

/** Explicit tool allowlists; annotations supplied by a remote server cannot grant write authority. */
export function createWorkMcpBridge(options: {
	client: WorkMcpClient;
	enabled(): boolean;
	canWrite(): boolean;
	confirmWrite(name: string, args: Record<string, unknown>): Promise<boolean>;
}): WorkMcpBridge {
	const allowed = (name: string): boolean => READ.has(name) || (options.canWrite() && WRITE.has(name));
	return {
		async tools() {
			if (!options.enabled()) { return []; }
			const tools = await options.client.tools();
			if (!options.enabled()) { return []; }
			return tools.filter(tool => allowed(tool.name)).map(tool => ({ ...tool, name: MCP_TOOL_PREFIX + tool.name }));
		},
		async call(name, value) {
			const remote = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : '';
			if (!options.enabled() || !allowed(remote)) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
			if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 128 * 1024) { throw Error('HARNESS_MCP_INPUT_INVALID'); }
			const args = structuredClone(value) as Record<string, unknown>;
			if (WRITE.has(remote) && JSON.stringify(args).length > 12000) { throw Error('HARNESS_MCP_INPUT_INVALID'); }
			if (!(await options.client.tools()).some(tool => tool.name === remote)) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
			if (WRITE.has(remote) && !await options.confirmWrite(remote, args)) { throw Error('HARNESS_MCP_WRITE_DENIED'); }
			if (!options.enabled() || !allowed(remote)) { throw Error('HARNESS_MCP_TOOL_DENIED'); }
			const result = await options.client.call(remote, args);
			return JSON.parse(redactSecrets(JSON.stringify(result)));
		}
	};
}
