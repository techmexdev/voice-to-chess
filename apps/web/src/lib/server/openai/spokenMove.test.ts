import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MOVE_INTERPRETER_MODEL,
	SpokenMoveInputError,
	TRANSCRIPTION_MODEL,
	interpretTranscript,
	transcribeAndInterpretMove
} from './spokenMove.ts';

test('the hosted Move Interpreter receives only one finalized transcript and returns compact v2 text', async () => {
	let interpreterRequest: Record<string, unknown> | undefined;
	const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/audio/transcriptions')) {
			assert.ok(init?.body instanceof FormData);
			assert.equal((init.body as FormData).get('model'), TRANSCRIPTION_MODEL);
			return Response.json({ text: 'knight to f three' });
		}

		assert.equal(url.endsWith('/responses'), true);
		interpreterRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Response.json({
			output: [{ content: [{ type: 'output_text', text: JSON.stringify({
				kind: 'move',
				piece: 'N',
				destination: 'f3',
				source_square: '-',
				source_file: '-',
				source_rank: '-',
				capture: '-',
				promotion: '-',
				special: '-'
			}) }] }]
		});
	};

	const result = await transcribeAndInterpretMove(
		new File(['audio'], 'spoken-move.webm', { type: 'audio/webm' }),
		'test-key',
		fakeFetch as typeof fetch
	);

	assert.deepEqual(result, { transcript: 'knight to f three', compact: 'M|N|f3|-|-|-|-|-|-' });
	assert.equal(interpreterRequest?.model, MOVE_INTERPRETER_MODEL);
	assert.equal(interpreterRequest?.input, 'knight to f three');
	assert.equal(typeof interpreterRequest?.input, 'string');
	for (const forbiddenField of ['fen', 'legal_san', 'legalSan', 'history', 'alternatives', 'confidence']) {
		assert.equal(
			Object.hasOwn(interpreterRequest ?? {}, forbiddenField),
			false,
			`interpreter request must not contain ${forbiddenField}`
		);
	}
});

test('the hosted interpreter rejects a state-shaped value before it can reach OpenAI', async () => {
	let called = false;
	await assert.rejects(
		() => interpretTranscript({ transcript: 'pawn to e4', fen: 'not allowed' } as never, 'test-key', async () => {
			called = true;
			return Response.json({});
		}),
		SpokenMoveInputError
	);
	assert.equal(called, false);
});

test('the hosted interpreter uses strict fields and serializes a destination-only pawn move', async () => {
	let requestBody: Record<string, unknown> | undefined;
	const compact = await interpretTranscript(
		'Move the pawn to c5.',
		'test-key',
		async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				output_text: JSON.stringify({
					kind: 'move',
					piece: 'P',
					destination: 'c5',
					source_square: '-',
					source_file: '-',
					source_rank: '-',
					capture: '-',
					promotion: '-',
					special: '-'
				})
			});
		}
	);

	assert.equal(compact, 'M|P|c5|-|-|-|-|-|-');
	assert.deepEqual((requestBody?.text as { format?: unknown } | undefined)?.format, {
		type: 'json_schema',
		name: 'move_interpretation',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: assertObject((requestBody?.text as { format?: { schema?: unknown } })?.format?.schema).properties,
			required: [
				'kind',
				'piece',
				'destination',
				'source_square',
				'source_file',
				'source_rank',
				'capture',
				'promotion',
				'special'
			]
		}
	});
});

test('the hosted interpreter distinguishes an ordinary capture from a recapture', async () => {
	let requestBody: Record<string, unknown> | undefined;
	const compact = await interpretTranscript(
		'Pawn takes d5.',
		'test-key',
		async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				output_text: JSON.stringify({
					kind: 'move',
					piece: 'P',
					destination: 'd5',
					source_square: '-',
					source_file: '-',
					source_rank: '-',
					capture: 'x',
					promotion: '-',
					special: '-'
				})
			});
		}
	);

	assert.equal(compact, 'M|P|d5|-|-|-|x|-|-');
	assert.match(
		String(requestBody?.instructions),
		/Ordinary capture words such as "takes" and "captures" use kind move with capture x\./
	);
	assert.match(
		String(requestBody?.instructions),
		/Use kind recapture only when the speaker explicitly says "recapture", "takes back", or "take back"\./
	);
});

function assertObject(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, 'object');
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}
