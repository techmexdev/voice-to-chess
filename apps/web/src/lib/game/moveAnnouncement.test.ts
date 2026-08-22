import assert from 'node:assert/strict';
import test from 'node:test';
import { moveAnnouncement } from './moveAnnouncement.ts';

test('announces common SAN without exposing arbitrary text', () => {
	assert.equal(moveAnnouncement({ san: 'e4' }), 'Pawn to e4.');
	assert.equal(moveAnnouncement({ san: 'Nxf7+' }), 'Knight takes f7. Check.');
	assert.equal(moveAnnouncement({ san: 'O-O' }), 'Castle kingside.');
	assert.equal(moveAnnouncement({ san: 'e8=Q#' }), 'Pawn to e8, promoting to Queen. Checkmate.');
});
