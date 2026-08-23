import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createMoveInterpreterRequest,
	MoveInterpreterProviderError
} from './moveInterpreter.ts';
import { createSlmMoveInterpreter } from './slmMoveInterpreter.ts';

const release = Object.freeze({
	releaseId: 'qwen-move-intent-v2',
	identity: 'b'.repeat(64)
});

test('the remote SLM adapter forwards only the fixed finalized-transcript request', async () => {
	let requestBody: Record<string, unknown> | undefined;
	let headers: Headers | undefined;
	let requestUrl = '';
	const interpreter = createSlmMoveInterpreter({
		endpoint: 'https://private-inference.example/',
		bearerToken: 'server-only-token',
		release,
		fetcher: async (input, init) => {
			requestUrl = String(input);
			headers = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				schema: 'move-interpreter-response/v1',
				behavior_contract: 'move-intent-behavior/v2',
				compact: 'M|N|f3|-|-|-|-|-|-',
				release: {
					release_id: release.releaseId,
					identity_sha256: release.identity
				}
			});
		}
	});

	const result = await interpreter.interpret(
		createMoveInterpreterRequest('knight to f three'),
		{ signal: new AbortController().signal }
	);

	assert.equal(requestUrl, 'https://private-inference.example/v1/move-interpretations');
	assert.equal(headers?.get('authorization'), 'Bearer server-only-token');
	assert.deepEqual(requestBody, {
		schema: 'move-interpreter-request/v1',
		behavior_contract: 'move-intent-behavior/v2',
		finalized_transcript: 'knight to f three'
	});
	for (const forbidden of ['fen', 'legal_moves', 'san', 'history', 'alternatives', 'confidence', 'prompt']) {
		assert.equal(Object.hasOwn(requestBody ?? {}, forbidden), false, forbidden);
	}
	assert.deepEqual(result, { compact: 'M|N|f3|-|-|-|-|-|-', release });
});

test('a malformed or mismatched SLM response is a provider failure, not a compact interpretation', async () => {
	const interpreter = createSlmMoveInterpreter({
		endpoint: 'https://private-inference.example',
		bearerToken: 'server-only-token',
		release,
		fetcher: async () => Response.json({
			schema: 'move-interpreter-response/v1',
			behavior_contract: 'move-intent-behavior/v2',
			compact: 'M|N|f3|-|-|-|-|-|-',
			release: { release_id: release.releaseId, identity_sha256: 'c'.repeat(64) }
		})
	});

	await assert.rejects(
		() => interpreter.interpret(createMoveInterpreterRequest('knight to f three'), {
			signal: new AbortController().signal
		}),
		MoveInterpreterProviderError
	);
});

test('a remote SLM timeout remains classified as a timeout', async () => {
	const timeout = new Error('timed out');
	timeout.name = 'TimeoutError';
	const interpreter = createSlmMoveInterpreter({
		endpoint: 'https://private-inference.example',
		bearerToken: 'server-only-token',
		release,
		fetcher: async () => {
			throw timeout;
		}
	});

	await assert.rejects(
		async () => {
			await interpreter.interpret(createMoveInterpreterRequest('knight to f three'), {
				signal: new AbortController().signal
			});
		},
		(error: unknown) => error instanceof MoveInterpreterProviderError && error.failure === 'timeout'
	);
});
