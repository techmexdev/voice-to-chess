import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../game/GameSession.ts';
import { replayVoiceResolverContext } from '../game/VoiceResolverContext.ts';
import { completeHostedVoiceTurn } from './voiceTurn.ts';

test('the hosted Voice Turn resolves compact interpretation on the host without changing the Game Session', async () => {
	const session = new GameSession();
	const before = session.snapshot();
	const resolverContext = replayVoiceResolverContext(session.createVoiceResolverContext());
	let interpreterPayload: Record<string, unknown> | undefined;
	const result = await completeHostedVoiceTurn({
		audio: new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' }),
		resolverContext,
		apiKey: 'test-key',
		fetcher: async (input, init) => {
			if (String(input).endsWith('/audio/transcriptions')) return Response.json({ text: 'pawn to e4' });
			interpreterPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return structuredResponse({ kind: 'move', piece: 'P', destination: 'e4' });
		}
	});

	assert.equal(result.transcript, 'pawn to e4');
	assert.deepEqual(result.outcome, {
		schema: 'voice-turn-outcome/v1',
		contextId: resolverContext.context.contextId,
		kind: 'resolved',
		move: { from: 'e2', to: 'e4' }
	});
	assert.equal('san' in result.outcome, false);
	assert.equal(interpreterPayload?.input, 'pawn to e4');
	assert.deepEqual(session.snapshot(), before);
});

test('the Voice Turn returns host-owned unresolved and adapter-failure outcomes', async () => {
	for (const [structured, expectedKind] of [
		[{ kind: 'unknown' }, 'unknown'],
		[{ kind: 'move', piece: 'N' }, 'ambiguous'],
		[{ kind: 'move', piece: 'N', destination: 'e4' }, 'illegal'],
		[{ kind: 'move', piece: 'N', destination: 'e4', source_square: 'e2', source_file: 'e' }, 'failure']
	] as const) {
		const session = new GameSession();
		const before = session.snapshot();
		const resolverContext = replayVoiceResolverContext(session.createVoiceResolverContext());
		const result = await completeHostedVoiceTurn({
			audio: new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' }),
			resolverContext,
			apiKey: 'test-key',
			fetcher: async (input) => {
				if (String(input).endsWith('/audio/transcriptions')) return Response.json({ text: 'try a move' });
				return structuredResponse(structured);
			}
		});

		assert.equal(result.outcome.kind, expectedKind, JSON.stringify(structured));
		if (expectedKind === 'failure') {
			assert.equal(result.outcome.kind, 'failure');
			if (result.outcome.kind === 'failure') assert.equal(result.outcome.failure, 'adapter');
		}
		assert.deepEqual(session.snapshot(), before);
	}
});

function structuredResponse(fields: Readonly<Record<string, string>>): Response {
	return Response.json({
		output: [{
			content: [{
				type: 'output_text',
				text: JSON.stringify({
					kind: fields.kind,
					piece: fields.piece ?? '-',
					destination: fields.destination ?? '-',
					source_square: fields.source_square ?? '-',
					source_file: fields.source_file ?? '-',
					source_rank: fields.source_rank ?? '-',
					capture: fields.capture ?? '-',
					promotion: fields.promotion ?? '-',
					special: fields.special ?? '-'
				})
			}]
		}]
	});
}

test('a hosted interpreter timeout is a retry-safe failure outcome after transcription', async () => {
	const session = new GameSession();
	const before = session.snapshot();
	const resolverContext = replayVoiceResolverContext(session.createVoiceResolverContext());
	const timeout = new Error('timed out');
	timeout.name = 'TimeoutError';
	const result = await completeHostedVoiceTurn({
		audio: new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' }),
		resolverContext,
		apiKey: 'test-key',
		fetcher: async (input) => {
			if (String(input).endsWith('/audio/transcriptions')) return Response.json({ text: 'pawn to e4' });
			throw timeout;
		}
	});

	assert.deepEqual(result, {
		transcript: 'pawn to e4',
		outcome: {
			schema: 'voice-turn-outcome/v1',
			contextId: resolverContext.context.contextId,
			kind: 'failure',
			failure: 'timeout'
		}
	});
	assert.deepEqual(session.snapshot(), before);
});
