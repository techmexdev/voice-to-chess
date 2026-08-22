import { Chess } from 'chess.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const TRANSCRIPTION_MODEL = 'gpt-transcribe';
const SAN_MODEL = 'gpt-4o-mini';

export type SpokenMoveInterpretation =
	| { status: 'ok'; san: string }
	| { status: 'ambiguous'; san: null }
	| { status: 'invalid'; san: null };

export type SpokenMoveResult = {
	transcript: string;
	interpretation: SpokenMoveInterpretation;
};

export class SpokenMoveProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SpokenMoveProviderError';
	}
}

export class SpokenMoveInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SpokenMoveInputError';
	}
}

export async function transcribeAndInterpretMove(
	audio: File,
	fen: string,
	apiKey: string,
	fetcher: typeof fetch = fetch
): Promise<SpokenMoveResult> {
	const chess = createPosition(fen);
	const legalSan = chess.moves();
	const transcript = await transcribeAudio(audio, apiKey, fetcher);
	const interpretation = await interpretSan(transcript, fen, legalSan, apiKey, fetcher);

	if (interpretation.status === 'ok' && !legalSan.includes(interpretation.san)) {
		throw new SpokenMoveProviderError('The move model returned SAN outside the legal move set.');
	}

	return { transcript, interpretation };
}

function createPosition(fen: string): Chess {
	try {
		return new Chess(fen);
	} catch {
		throw new SpokenMoveInputError('The supplied chess position is invalid.');
	}
}

async function transcribeAudio(
	audio: File,
	apiKey: string,
	fetcher: typeof fetch
): Promise<string> {
	const body = new FormData();
	body.set('file', audio, audio.name || 'spoken-move.webm');
	body.set('model', TRANSCRIPTION_MODEL);
	body.set(
		'prompt',
		'A chess player is speaking one move in English. Preserve piece names, files, ranks, captures, castling, checks, mates, and promotions exactly as heard.'
	);

	const response = await fetcher(`${OPENAI_API_BASE}/audio/transcriptions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}` },
		body,
		signal: AbortSignal.timeout(15_000)
	});
	const payload = await readJson(response, 'transcription');

	if (!response.ok) throw providerFailure('Transcription', response.status, payload);

	const transcript = isRecord(payload) && typeof payload.text === 'string' ? payload.text.trim() : '';
	if (!transcript) throw new SpokenMoveProviderError('The transcription was empty.');
	if (transcript.length > 240) throw new SpokenMoveInputError('The recording is too long. Say one move only.');

	return transcript;
}

async function interpretSan(
	transcript: string,
	fen: string,
	legalSan: readonly string[],
	apiKey: string,
	fetcher: typeof fetch
): Promise<SpokenMoveInterpretation> {
	const response = await fetcher(`${OPENAI_API_BASE}/responses`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: SAN_MODEL,
			store: false,
			max_output_tokens: 80,
			instructions:
				'Convert one spoken chess move into canonical SAN. Choose only from legal_san. Return ok only when the transcript identifies exactly one legal move. Return ambiguous when more than one legal move fits. Return invalid when no legal move fits or the transcript is not a move. Never guess between legal moves.',
			input: JSON.stringify({ transcript, fen, legal_san: legalSan }),
			text: {
				format: {
					type: 'json_schema',
					name: 'spoken_chess_move',
					strict: true,
					schema: {
						type: 'object',
						additionalProperties: false,
						required: ['status', 'san'],
						properties: {
							status: { type: 'string', enum: ['ok', 'ambiguous', 'invalid'] },
							san: { anyOf: [{ type: 'string' }, { type: 'null' }] }
						}
					}
				}
			}
		}),
		signal: AbortSignal.timeout(12_000)
	});
	const payload = await readJson(response, 'move interpretation');

	if (!response.ok) throw providerFailure('Move interpretation', response.status, payload);

	const outputText = extractOutputText(payload);
	if (!outputText) throw new SpokenMoveProviderError('The move model returned no structured output.');

	let parsed: unknown;
	try {
		parsed = JSON.parse(outputText);
	} catch {
		throw new SpokenMoveProviderError('The move model returned malformed structured output.');
	}

	return parseInterpretation(parsed);
}

function parseInterpretation(value: unknown): SpokenMoveInterpretation {
	if (!isRecord(value)) {
		throw new SpokenMoveProviderError('The move model returned an invalid result.');
	}

	if (value.status === 'ok' && typeof value.san === 'string' && value.san.length > 0) {
		return { status: 'ok', san: value.san };
	}

	if ((value.status === 'ambiguous' || value.status === 'invalid') && value.san === null) {
		return { status: value.status, san: null };
	}

	throw new SpokenMoveProviderError('The move model returned an inconsistent result.');
}

function extractOutputText(payload: unknown): string | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.output)) return undefined;

	for (const item of payload.output) {
		if (!isRecord(item) || !Array.isArray(item.content)) continue;

		for (const content of item.content) {
			if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
				return content.text;
			}
		}
	}

	return undefined;
}

async function readJson(response: Response, operation: string): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new SpokenMoveProviderError(`OpenAI returned a non-JSON ${operation} response.`);
	}
}

function providerFailure(label: string, status: number, payload: unknown): SpokenMoveProviderError {
	const detail =
		isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
			? ` ${payload.error.message}`
			: '';

	return new SpokenMoveProviderError(`${label} failed with status ${status}.${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
