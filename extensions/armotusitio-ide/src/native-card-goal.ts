/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Goals from a card (block U): "Implement ABC-001-257" reads the card from Work Management and uses its description and
 * acceptance criteria as the base of the specification. Moving the card and commenting happen only when the user's key
 * has those tools and the charter authorizes it; without them, the goal runs read-only towards the card.
 */

export interface CardClient {
	tools(): Promise<Array<{ name: string }>>;
	call(name: string, args: Record<string, unknown>): Promise<{ structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }>;
}
export interface CardContext { key: string; title: string; description: string; criteria: string[]; canTransition: boolean; canComment: boolean }

const CARD_KEY = /\b([A-Z][A-Z0-9]{1,9}(?:-\d+){1,2})\b/;

/** The card key named in an instruction, if any. */
export function cardKeyOf(instruction: string): string | undefined { return CARD_KEY.exec(instruction)?.[1]; }

/** Acceptance criteria from a card body: a "Criterios de aceptacion" / "Acceptance criteria" list, or checkbox items. */
export function cardCriteria(text: string): string[] {
	const section = /(?:criterios de aceptaci[o\u00f3]n|acceptance criteria)[^\n]*\n([\s\S]*?)(?:\n#{1,6}\s|\n\n\S[^\n]*:\n|$)/i.exec(text)?.[1] ?? '';
	const source = section || text;
	return source.split('\n').map(line => /^\s*(?:[-*] \[[ x]\]|[-*]|\d+[.)])\s+(.+)$/i.exec(line)?.[1]?.trim()).filter((item): item is string => !!item && item.length > 3).slice(0, 30);
}

export async function readCard(client: CardClient, key: string): Promise<CardContext> {
	const tools = new Set((await client.tools()).map(tool => tool.name));
	const result = await client.call('get_issue_context', { issue_key: key });
	const data = (result.structuredContent ?? {}) as { issue?: { title?: string; summary?: string; description?: string }; title?: string; description?: string };
	const text = result.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n') ?? '';
	const issue = data.issue ?? data;
	const description = String(issue.description ?? text).slice(0, 8000);
	return { key, title: String((issue as { title?: string; summary?: string }).title ?? (issue as { summary?: string }).summary ?? key).slice(0, 200), description, criteria: cardCriteria(description), canTransition: tools.has('transition_issue'), canComment: tools.has('add_issue_comment') };
}

/** The goal objective built from the card: its title, description and criteria as the base of the specification. */
export function cardObjective(instruction: string, card: CardContext): string {
	return instruction + '\n\nCard ' + card.key + ': ' + card.title + '\n' + card.description + (card.criteria.length ? '\n\nAcceptance criteria from the card (keep their meaning; ask once about anything ambiguous):\n' + card.criteria.map((item, index) => 'C' + (index + 1) + ': ' + item).join('\n') : '');
}

/** Milestone comment ("plan aprobado", "entrega lista") when the key allows it; otherwise it reports read-only mode. */
export async function commentMilestone(client: CardClient, card: CardContext, text: string): Promise<'commented' | 'read-only'> {
	if (!card.canComment) { return 'read-only'; }
	await client.call('add_issue_comment', { issue_key: card.key, content: text.slice(0, 2000) });
	return 'commented';
}
