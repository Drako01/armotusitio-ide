/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/** Rank confirmed activity ahead of historical and unverified records in every surface. */
function activityRank(entry) {
	return entry.phase === 'stopping' ? 0 : entry.progress?.live && !entry.progressError || entry.phase === 'running' && entry.owned ? 1 : ['questions', 'review', 'blocked'].includes(entry.phase) ? 2 : ['preparing', 'creating'].includes(entry.phase) ? 3 : ['interrupted', 'pending', 'unknown'].includes(entry.phase) ? 4 : 5;
}
function sortActivity(entries) { return [...entries].sort((a, b) => activityRank(a) - activityRank(b) || (b.startedAt || 0) - (a.startedAt || 0) || a.id.localeCompare(b.id)); }

module.exports = { activityRank, sortActivity };
