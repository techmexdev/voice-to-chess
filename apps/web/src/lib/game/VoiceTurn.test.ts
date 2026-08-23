import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from './GameSession.ts';
import {
	VoiceTurnOutcomeValidationError,
	applyVoiceTurnOutcome,
	loadVoiceTurnResponse
} from './VoiceTurn.ts';

test('the browser accepts only a host-owned Resolved Move identity and commits it through Game Session', () => {
	const session = new GameSession();
	const context = session.createVoiceResolverContext();
	const response = loadVoiceTurnResponse({
		transcript: 'pawn to e4',
		outcome: {
			schema: 'voice-turn-outcome/v1',
			contextId: context.contextId,
			kind: 'resolved',
			move: { from: 'e2', to: 'e4' }
		},
		remainingGames: 2
	});

	assert.equal('san' in response.outcome, false);
	const result = applyVoiceTurnOutcome(session, context, response.outcome);
	assert.equal(result.kind, 'accepted');
	if (result.kind !== 'accepted') throw new Error('Expected the voice identity to commit.');
	assert.equal(result.move.san, 'e4');
});

test('a Voice Turn correction uses its pre-correction context and keeps the original move on stale or unresolved outcomes', () => {
	const correctionSession = new GameSession();
	assert.equal(correctionSession.attemptNotation('Nf3').kind, 'accepted');
	const correctionContext = correctionSession.createVoiceCorrectionResolverContext();
	if (correctionContext === undefined) throw new Error('Expected a correction context.');
	const replacement = applyVoiceTurnOutcome(correctionSession, correctionContext, {
		schema: 'voice-turn-outcome/v1',
		contextId: correctionContext.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.equal(replacement.kind, 'accepted');
	assert.deepEqual(correctionSession.snapshot().moves.map((move) => move.san), ['e4']);

	const staleSession = new GameSession();
	assert.equal(staleSession.attemptNotation('Nf3').kind, 'accepted');
	const staleContext = staleSession.createVoiceCorrectionResolverContext();
	if (staleContext === undefined) throw new Error('Expected a correction context.');
	assert.equal(staleSession.attemptNotation('e5').kind, 'accepted');
	const beforeStaleOutcome = staleSession.snapshot();
	const stale = applyVoiceTurnOutcome(staleSession, staleContext, {
		schema: 'voice-turn-outcome/v1',
		contextId: staleContext.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.equal(stale.kind, 'stale');
	assert.deepEqual(staleSession.snapshot(), beforeStaleOutcome);

	const unresolvedSession = new GameSession();
	const unresolvedContext = unresolvedSession.createVoiceResolverContext();
	const beforeUnknown = unresolvedSession.snapshot();
	const unknown = applyVoiceTurnOutcome(unresolvedSession, unresolvedContext, {
		schema: 'voice-turn-outcome/v1',
		contextId: unresolvedContext.contextId,
		kind: 'unknown'
	});
	assert.equal(unknown.kind, 'unknown');
	assert.deepEqual(unresolvedSession.snapshot(), beforeUnknown);

	const mismatched = applyVoiceTurnOutcome(unresolvedSession, unresolvedContext, {
		schema: 'voice-turn-outcome/v1',
		contextId: 'voice-turn-different',
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.equal(mismatched.kind, 'stale');
	assert.deepEqual(unresolvedSession.snapshot(), beforeUnknown);
});

test('the browser rejects a provider-shaped SAN response instead of reparsing it', () => {
	assert.throws(
		() => loadVoiceTurnResponse({ transcript: 'pawn to e4', outcome: { status: 'ok', san: 'e4' } }),
		VoiceTurnOutcomeValidationError
	);
});
