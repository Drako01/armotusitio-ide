/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * `/skills` and `/skill NAME [request]`: the native and project skills (`.agents`, `.codex` or `.claude` skills folders) offered in the
 * chat like Claude Code offers them. A skill is read with the same bounded, digest-checked reader the reviewed agents use, and it
 * reaches the model as untrusted conventions: it never widens a permission and never runs project code.
 */
import { listEngineeringSkills, readEngineeringSkill, engineeringSkillContext, type EngineeringSkill } from './native-engineering-skills.ts';

type Translate = (text: string, ...args: string[]) => string;
export interface SkillInvocation { message: string; context: string; notice: string }

/** The available skills, one per line with where each comes from. */
export async function skillsListing(root: string, t: Translate, nativeDirectory?: string): Promise<string> {
	const skills = await listEngineeringSkills(root, nativeDirectory);
	if (!skills.length) { return t('Este proyecto no tiene skills (carpetas .agents/skills, .codex/skills o .claude/skills).'); }
	return [t('Skills disponibles (us\u00e1 /skill NOMBRE [pedido]):'), ...skills.map(skill => '  ' + skill.name + '  (' + skill.source + ')')].join('\n');
}

const byName = (skills: EngineeringSkill[], name: string): EngineeringSkill | undefined => skills.find(skill => skill.name.toLowerCase() === name.toLowerCase());

/** The message and context for `/skill NAME [request]`, or the text to show when the skill cannot be used. */
export async function resolveSkillInvocation(root: string, argument: string, t: Translate, nativeDirectory?: string): Promise<SkillInvocation | string> {
	const [name = '', ...rest] = argument.trim().split(/\s+/).filter(Boolean);
	if (!name) { return t('Uso: /skill NOMBRE [pedido]. Mir\u00e1 las disponibles con /skills.'); }
	const skill = byName(await listEngineeringSkills(root, nativeDirectory), name);
	if (!skill) { return t('No encontr\u00e9 la skill \u00ab{0}\u00bb. Mir\u00e1 las disponibles con /skills.', name.slice(0, 64)); }
	const content = await readEngineeringSkill(root, skill, nativeDirectory);

	return {
		message: rest.join(' ') || t('Aplic\u00e1 la skill {0} a lo que estamos haciendo.', skill.name),
		context: engineeringSkillContext(skill, content),
		notice: t('Apliqu\u00e9 la skill {0} ({1}).', skill.name, skill.source)
	};
}
