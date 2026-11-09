/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Shared contract of the permission system (plan r6). Declarative rules (`allow` / `ask` / `deny`) sit INSIDE the
 * policy floor of `native-command-policy.ts`: a rule can never allow what the floor denies. The floor is a good-faith barrier, not
 * an OS sandbox.
 *
 * Rule grammar (case-sensitive, `*` matches any run of characters, no other wildcard):
 *   run:<glob>        a command line, `command arg1 arg2` joined by single spaces   e.g. `run:pnpm test*`
 *   edit:<glob>       RESERVED, not enforced yet: edits are made by the provider's native tools, which nothing here intercepts
 *   edit:<glob>       also decides the structured delete_path / move_path tools (project-relative path)
 *   mcp:<glob>       a tool of a user-added MCP server, written `server/tool` (e.g. `mcp:github/*`); asked unless a rule allows it
 *   git_commit        the structured commit tool, in every project
 *   git_push          the structured push tool, in every project
 *   git_branch_create the structured branch creation tool, in every project
 *   git_pr_upsert     the structured GitHub PR create/update tool, in every project
 *   git_fetch         the structured fetch tool, in every project
 *   <git rule>:<glob> the same tool only in projects whose root (`/` separators, lowercase on Windows) matches, e.g. `git_push:c:/work/app`
 * Precedence inside one layer: deny, then ask, then allow. Across layers: floor > project > user > preset; a project file can
 * only add `ask` / `deny` (its `allow` is ignored and reported), because a cloned repository must not grant itself permissions.
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type PermissionPreset = 'readonly' | 'dev' | 'trusted';
export type PermissionSource = 'floor' | 'project' | 'user' | 'preset' | 'default';

/** Rules of one decision list. */
export interface PermissionRules {
	allow?: string[];
	ask?: string[];
	deny?: string[];
}

/**
 * On-disk shape of `~/.armotusitio/permissions.json` (user) and `<project>/.armotusitio/permissions.json` (project).
 * `projects` (user file only) holds rules that apply in one project, keyed by `projectKey(root)`: "always" answers go there.
 */
export interface PermissionFile extends PermissionRules {
	version: 1;
	preset?: PermissionPreset;
	projects?: Record<string, PermissionRules>;
}

/** What an agent wants to do; every tool call that needs a decision is described by exactly one of these. */
export type PermissionRequest =
	| { kind: 'run'; command: string; args: string[]; cwd: string }
	| { kind: 'edit'; path: string }
	| { kind: 'git_commit'; branch: string; files: string[]; message: string }
	| { kind: 'git_push'; branch: string; remote: string }
	| { kind: 'git_branch_create'; repo: string; branch: string; from: string }
	| { kind: 'git_pr_upsert'; repo: string; branch: string; base: string; title: string; body: string }
	| { kind: 'git_fetch'; remote: string; branch?: string }
	| { kind: 'mcp'; server: string; tool: string };

export interface PermissionVerdict {
	decision: PermissionDecision;
	source: PermissionSource;
	/** The rule that decided, when one did. */
	rule?: string;
	/** Human-readable reason, already in the user's language through the injected translator. */
	reason?: string;
}

/** Sent by the command runner to the extension when a verdict is `ask`; shown as an approval card in the chat. */
export interface ApprovalRequest {
	id: string;
	/** `sandbox`: the provider asks to reach beyond its own sandbox (network, writes outside the project); never remembered. */
	kind: PermissionRequest['kind'] | 'sandbox';
	title: string;
	/** Short lines (branch, files, message, command) shown verbatim; never secrets. */
	detail: string[];
	/** Rule remembered for `task`, `session` or `always` (always: the USER file's project section, never the project file). */
	rule: string;
	/** Why the action cannot be remembered, when `rule` is empty; the card says so instead of hiding the options silently. */
	noRemember?: NoRememberReason;
	/** The rule may also be remembered for every project; set only for exact rules of inspection commands (`globalRuleAllowed`). */
	global?: boolean;
	/** How much harm a wrong yes can do, shown on the card next to what, where and for how long. */
	risk?: ApprovalRisk;
}
/** `high`: leaves the project or the sandbox, publishes, or cannot be undone with git. */
export type ApprovalRisk = 'low' | 'medium' | 'high';
/**
 * How far an approval reaches: this action only, the rest of the current run, the rest of the IDE session in this project,
 * always in this project, or in every project (`global`, offered only for inspection commands). Anything else is a denial.
 */
export type ApprovalAnswer = 'once' | 'task' | 'session' | 'always' | 'global' | 'deny';
/** Why an approval is offered only once: dependency installs, irreversible file changes, publication, or no exact rule exists. */
export type NoRememberReason = 'dependency' | 'irreversible' | 'publication' | 'inexact';
