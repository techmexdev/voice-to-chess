import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoveSpeech, TTS_MODEL, TTS_VOICE } from './textToSpeech.ts';

test('uses the pinned OpenAI voice model and does not store arbitrary server state', async () => {
	let requestBody: Record<string, unknown> | undefined;
	const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
	};

	const audio = await createMoveSpeech('Pawn to e4.', 'test-key', fakeFetch as typeof fetch);
	assert.equal(audio.byteLength, 3);
	assert.equal(requestBody?.model, TTS_MODEL);
	assert.equal(requestBody?.voice, TTS_VOICE);
	assert.equal(requestBody?.input, 'Pawn to e4.');
});
