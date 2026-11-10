/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import base from '../../product.json' with { type: 'json' };
import overrides from '../armotusitio/product-overrides.json' with { type: 'json' };
import { officialExtensions, withOfficialExtensions } from './armotusitioOfficialExtensions.ts';

/** Client, native packagers and REH must use one product identity and release revision. */
export const armotusitioProduct = {
	...base, ...overrides, release: String(overrides.armotusitioUpdate.revision),
	builtInExtensions: withOfficialExtensions(base.builtInExtensions),
	armotusitioOfficialExtensions: officialExtensions.map(extension => extension.name),
	autoUpdateBuiltinExtensionsByDefault: officialExtensions.map(extension => extension.name),
	builtInExtensionsEnabledWithAutoUpdates: [...new Set([...base.builtInExtensionsEnabledWithAutoUpdates, ...officialExtensions.map(extension => extension.name)])]
};
