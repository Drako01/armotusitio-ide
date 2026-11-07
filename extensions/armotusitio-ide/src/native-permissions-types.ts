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
 *   git_commit        the structured commit tool, in every project
 *   git_push          the structured push tool, in every project
 *   git_branch_create the structured branch creation tool, in every project
 *   git_pr_upsert     the structured GitHub PR create/update tool, in every project
 *   <git rule>:<glob> the same tool only in projects whose root (`/` separators, lowercase on Windows) matches, e.g. `git_push:c:/work/app`
 * Precedence inside one layer: deny, then ask, then allow. Across layers: floor > project > user > preset; a project file can
 * only add `ask` / `deny` (its `allow` is ignored and reported), because a cloned repository must not grant itself permissions.
 */
export type PermissionDecision = 'allow' | 'ask' | 'deny';
export type PermissionPreset = 'readonly' | 'dev' | 'trusted';
export type PermissionSource = 'floor' | 'project' | 'user' | 'preset' | 'default';

/** On-disk shape of `~/.armotusitio/permissions.json` (user) and `<project>/.armotusitio/permissions.json` (project). */
export interface PermissionFile {
	version: 1;
	preset?: PermissionPreset;
	allow?: string[];
	ask?: string[];
	deny?: string[];
}

/** What an agent wants to do; every tool call that needs a decision is described by exactly one of these. */
export type PermissionRequest =
	| { kind: 'run'; command: string; args: string[]; cwd: string }
	| { kind: 'edit'; path: string }
	| { kind: 'git_commit'; branch: string; files: string[]; message: string }
	| { kind: 'git_push'; branch: string; remote: string }
	| { kind: 'git_branch_create'; repo: string; branch: string; from: string }
	| { kind: 'git_pr_upsert'; repo: string; branch: string; base: string; title: string; body: string };

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
	kind: PermissionRequest['kind'];
	title: string;
	/** Short lines (branch, files, message, command) shown verbatim; never secrets. */
	detail: string[];
	/** Rule persisted when the user answers `always` (written to the USER file, never to the project file). */
	rule: string;
}
export type ApprovalAnswer = 'once' | 'always' | 'deny';
