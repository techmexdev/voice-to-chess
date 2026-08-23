import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCompactMoveInterpretation } from '../move-intent/move-interpretation.ts';
import { resolveMoveIntent } from './MoveResolver.ts';
import { GameSession } from './GameSession.ts';
import {
	VoiceResolverContextValidationError,
	replayVoiceResolverContext
} from './VoiceResolverContext.ts';

function resolvedMoveFor(session: GameSession, compact: string) {
	const context = session.createVoiceResolverContext();
	const resolution = resolveMoveIntent(
		replayVoiceResolverContext(context).position,
		parseCompactMoveInterpretation(compact)
	);
	if (resolution.kind !== 'resolved') throw new Error(`Expected a resolved move, got ${resolution.kind}.`);
	return { context, move: resolution.move, san: resolution.san };
}

test('a normal Voice Resolver Context replays the position and commits only its playable identity', () => {
	const session = new GameSession();
	const { context, move, san } = resolvedMoveFor(session, 'M|N|f3|-|-|-|-|-|-');
	const replayed = replayVoiceResolverContext(context);

	assert.equal(replayed.position.fen, session.snapshot().fen);
	assert.deepEqual(replayed.position.replayableHistory, []);
	assert.deepEqual(move, { from: 'g1', to: 'f3' });
	assert.equal(san, 'Nf3');

	const result = session.applyResolvedVoiceMove(context, move);
	assert.equal(result.kind, 'accepted');
	if (result.kind !== 'accepted') throw new Error('Expected the resolved identity to commit.');
	assert.deepEqual(result.move, {
		color: 'white',
		from: 'g1',
		to: 'f3',
		san: 'Nf3',
		captured: undefined,
		promotion: undefined
	});
});

test('a delayed voice result is stale after the Game Session changes', () => {
	const session = new GameSession();
	const { context, move } = resolvedMoveFor(session, 'M|N|f3|-|-|-|-|-|-');
	assert.equal(session.attemptNotation('e4').kind, 'accepted');
	const before = session.snapshot();

	assert.deepEqual(session.applyResolvedVoiceMove(context, move), {
		kind: 'stale',
		snapshot: before
	});
	assert.deepEqual(session.snapshot(), before);
});

test('a correction context resolves before the original move and atomically replaces it', () => {
	const session = new GameSession();
	assert.equal(session.attemptNotation('Nf3').kind, 'accepted');
	const context = session.createVoiceCorrectionResolverContext();
	if (context === undefined) throw new Error('Expected a correction context.');
	const resolution = resolveMoveIntent(
		replayVoiceResolverContext(context).position,
		parseCompactMoveInterpretation('M|P|e4|-|-|-|-|-|-')
	);
	if (resolution.kind !== 'resolved') throw new Error('Expected the correction to resolve.');

	const result = session.applyResolvedVoiceMove(context, resolution.move);
	assert.equal(result.kind, 'accepted');
	if (result.kind !== 'accepted') throw new Error('Expected the correction to commit.');
	assert.equal(result.move.san, 'e4');
	assert.deepEqual(result.snapshot.moves.map((move) => move.san), ['e4']);
});

test('a stale or rejected correction leaves the original Game Session move intact', () => {
	const staleSession = new GameSession();
	assert.equal(staleSession.attemptNotation('Nf3').kind, 'accepted');
	const staleContext = staleSession.createVoiceCorrectionResolverContext();
	if (staleContext === undefined) throw new Error('Expected a correction context.');
	assert.equal(staleSession.attemptNotation('e5').kind, 'accepted');
	const staleBefore = staleSession.snapshot();

	assert.deepEqual(staleSession.applyResolvedVoiceMove(staleContext, { from: 'e2', to: 'e4' }), {
		kind: 'stale',
		snapshot: staleBefore
	});
	assert.deepEqual(staleSession.snapshot(), staleBefore);

	const rejectedSession = new GameSession();
	assert.equal(rejectedSession.attemptNotation('Nf3').kind, 'accepted');
	const rejectedContext = rejectedSession.createVoiceCorrectionResolverContext();
	if (rejectedContext === undefined) throw new Error('Expected a correction context.');
	const rejectedBefore = rejectedSession.snapshot();

	assert.deepEqual(rejectedSession.applyResolvedVoiceMove(rejectedContext, { from: 'a1', to: 'a2' }), {
		kind: 'illegal',
		snapshot: rejectedBefore
	});
	assert.deepEqual(rejectedSession.snapshot(), rejectedBefore);
});

test('replayable history supplies the prior capture required for a recapture', () => {
	const session = new GameSession('4k3/8/4p3/3P4/5N2/8/8/4K3 b - - 0 1');
	assert.equal(session.attemptNotation('e6d5').kind, 'accepted');
	const context = session.createVoiceResolverContext();
	const replayed = replayVoiceResolverContext(context);

	assert.equal(replayed.position.replayableHistory.at(-1)?.wasCapture, true);
	const resolution = resolveMoveIntent(
		replayed.position,
		parseCompactMoveInterpretation('R|N|-|f4|-|-|-|-|-')
	);
	if (resolution.kind !== 'resolved') throw new Error('Expected the recapture to resolve.');
	assert.equal(resolution.san, 'Nxd5');

	const result = session.applyResolvedVoiceMove(context, resolution.move);
	assert.equal(result.kind, 'accepted');
	if (result.kind !== 'accepted') throw new Error('Expected the recapture to commit.');
	assert.equal(result.move.san, 'Nxd5');
});

test('context replay rejects mismatched state instead of accepting a fabricated FEN', () => {
	const context = new GameSession().createVoiceResolverContext();
	assert.throws(
		() => replayVoiceResolverContext({ ...context, resolverFen: '8/8/8/8/8/8/8/8 w - - 0 1' }),
		VoiceResolverContextValidationError
	);
});
