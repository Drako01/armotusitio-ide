/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import base from '../../product.json' with { type: 'json' };
import overrides from '../armotusitio/product-overrides.json' with { type: 'json' };

/** Client, native packagers and REH must use one product identity and release revision. */
export const armotusitioProduct = {
	...base, ...overrides, release: String(overrides.armotusitioUpdate.revision)
};
