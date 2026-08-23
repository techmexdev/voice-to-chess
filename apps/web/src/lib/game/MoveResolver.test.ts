import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCompactMoveInterpretation } from '../move-intent/move-interpretation.ts';
import { resolveMoveIntent, type MoveResolverPosition, type ReplayableMove } from './MoveResolver.ts';

function resolve(
	fen: string,
	compact: string,
	replayableHistory: readonly ReplayableMove[] = []
) {
	return resolveMoveIntent(
		Object.freeze({ fen, replayableHistory: Object.freeze([...replayableHistory]) }),
		parseCompactMoveInterpretation(compact)
	);
}

test('resolves ordinary moves using every expressed source and capture constraint', () => {
	const position = '4k3/8/8/3p4/1N6/8/8/4K3 w - - 0 1';

	assert.deepEqual(resolve(position, 'M|N|d5|-|b|-|x|-|-'), {
		kind: 'resolved',
		move: { from: 'b4', to: 'd5' },
		san: 'Nxd5'
	});
	assert.deepEqual(resolve(position, 'M|N|-|b4|-|-|-|-|-'), {
		kind: 'ambiguous'
	});
	assert.deepEqual(resolve(position, 'M|N|a1|-|-|-|-|-|-'), { kind: 'illegal' });
	assert.deepEqual(resolve(position, 'UNKNOWN'), { kind: 'unknown' });
});

test('resolves castling and promotion from chess.js legal-move flags', () => {
	const castlePosition = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
	assert.deepEqual(resolve(castlePosition, 'O-O'), {
		kind: 'resolved',
		move: { from: 'e1', to: 'g1' },
		san: 'O-O'
	});
	assert.deepEqual(resolve(castlePosition, 'O-O-O'), {
		kind: 'resolved',
		move: { from: 'e1', to: 'c1' },
		san: 'O-O-O'
	});

	const promotionPosition = '4k3/P7/8/8/8/8/8/4K3 w - - 0 1';
	assert.deepEqual(resolve(promotionPosition, 'M|P|a8|-|-|-|-|N|-'), {
		kind: 'resolved',
		move: { from: 'a7', to: 'a8', promotion: 'n' },
		san: 'a8=N'
	});
	assert.deepEqual(resolve(promotionPosition, 'M|P|a8|-|-|-|-|-|-'), { kind: 'ambiguous' });
});

test('requires explicit en passant rather than matching an ordinary capture with the same SAN', () => {
	assert.deepEqual(
		resolve('4k3/8/8/2PpP3/8/8/8/4K3 w - d6 0 1', 'M|P|-|e5|-|-|x|-|ep'),
		{
			kind: 'resolved',
			move: { from: 'e5', to: 'd6' },
			san: 'exd6'
		}
	);
	assert.deepEqual(
		resolve('4k3/8/3n4/4P3/8/8/8/4K3 w - - 0 1', 'M|P|d6|-|-|-|x|-|ep'),
		{ kind: 'illegal' }
	);
});

test('resolves recapture only when replayable history records the preceding capture', () => {
	const position: MoveResolverPosition = {
		fen: '4k3/8/8/3p4/5N2/8/8/4K3 w - - 0 2',
		replayableHistory: [
			{
				from: 'e6',
				to: 'd5',
				san: 'exd5',
				wasCapture: true,
				wasEnPassant: false
			}
		]
	};

	assert.deepEqual(resolveMoveIntent(position, parseCompactMoveInterpretation('R|N|-|f4|-|-|-|-|-')), {
		kind: 'resolved',
		move: { from: 'f4', to: 'd5' },
		san: 'Nxd5'
	});
	assert.deepEqual(
		resolve(position.fen, 'R|-|-|-|-|-|-|-|-'),
		{ kind: 'illegal' }
	);
});
