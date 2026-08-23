import assert from 'node:assert/strict';
import test from 'node:test';
import { moveAnnouncement } from './moveAnnouncement.ts';

test('announces common SAN without exposing arbitrary text', () => {
	assert.equal(moveAnnouncement({ color: 'white', san: 'e4' }), 'White played: Pawn to e4.');
	assert.equal(moveAnnouncement({ color: 'black', san: 'Nxf7+' }), 'Black played: Knight takes f7. Check.');
	assert.equal(moveAnnouncement({ color: 'white', san: 'O-O' }), 'White played: Castle kingside.');
	assert.equal(
		moveAnnouncement({ color: 'black', san: 'e8=Q#' }),
		'Black played: Pawn to e8, promoting to Queen. Checkmate.'
	);
});
