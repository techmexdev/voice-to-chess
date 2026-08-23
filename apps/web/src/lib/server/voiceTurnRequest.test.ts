import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../game/GameSession.ts';
import {
	DIAGNOSTIC_CONSENT_VALUE,
	VoiceTurnRequestError,
	readVoiceTurnRequest
} from './voiceTurnRequest.ts';

function validForm() {
	const session = new GameSession();
	const form = new FormData();
	form.set('audio', new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' }));
	form.set('resolverContext', JSON.stringify(session.createVoiceResolverContext()));
	form.set('gameId', 'game-request-123');
	form.set('requestId', 'request-turn-123');
	return { form, session };
}

test('the Voice Turn route accepts replayable resolver context instead of direct chess state', () => {
	const { form, session } = validForm();
	const request = readVoiceTurnRequest(form);

	assert.equal(request.resolverContext.position.fen, session.snapshot().fen);
	assert.equal(request.resolverContext.context.contextId, 'voice-turn-1');
	assert.equal(request.gameId, 'game-request-123');
	assert.equal(request.requestId, 'request-turn-123');
});

test('the Voice Turn route rejects direct chess and ASR boundary fields', () => {
	for (const field of [
		'fen',
		'legalMoves',
		'legal_moves',
		'legalSan',
		'legal_san',
		'legalMoveList',
		'legal_move_list',
		'candidateMoves',
		'candidate_moves',
		'san',
		'recentSan',
		'recent_san',
		'canonicalSan',
		'canonical_san',
		'moveHistory',
		'move_history',
		'alternatives',
		'transcriptAlternatives',
		'nbest',
		'nBest',
		'n_best',
		'transcript',
		'finalizedTranscript',
		'finalized_transcript',
		'partial',
		'partialTranscript',
		'partialAudio',
		'partial_audio_text',
		'audioText',
		'asrConfidence',
		'confidence'
	]) {
		const { form } = validForm();
		form.set(field, 'forbidden');
		assert.throws(() => readVoiceTurnRequest(form), VoiceTurnRequestError, field);
	}
});

test('the browser cannot select an interpreter authority or policy', () => {
	for (const field of ['interpreter', 'authority', 'interpreterPolicy', 'policy']) {
		const { form } = validForm();
		form.set(field, 'slm');
		assert.throws(() => readVoiceTurnRequest(form), VoiceTurnRequestError, field);
	}
});

test('shadow evidence requires its own explicit per-turn consent, not training consent', () => {
	const { form } = validForm();
	form.set('trainingConsent', 'true');
	assert.equal(readVoiceTurnRequest(form).diagnosticConsent, false);

	form.set('diagnosticConsent', DIAGNOSTIC_CONSENT_VALUE);
	assert.equal(readVoiceTurnRequest(form).diagnosticConsent, true);

	form.set('diagnosticConsent', 'true');
	assert.throws(() => readVoiceTurnRequest(form), VoiceTurnRequestError);
});
