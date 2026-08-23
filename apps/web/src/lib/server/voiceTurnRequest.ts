import {
	replayVoiceResolverContext,
	type ReplayedVoiceResolverContext
} from '../game/VoiceResolverContext.ts';

export const MAX_VOICE_AUDIO_BYTES = 384 * 1024;
export const MAX_VOICE_RESOLVER_CONTEXT_CHARS = 48 * 1024;
export const DIAGNOSTIC_CONSENT_VALUE = 'per-turn-shadow-evidence/v1' as const;

const acceptedAudioTypes = new Set([
	'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm'
]);
const opaqueIdPattern = /^[A-Za-z0-9_-]{8,80}$/;
const forbiddenInterpreterFields = Object.freeze([
	'fen',
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
	'legalMoves',
	'legal_moves',
	'moveHistory',
	'move_history',
	'history',
	'alternatives',
	'transcriptAlternatives',
	'transcript_alternatives',
	'nbest',
	'nBest',
	'n_best',
	'transcript',
	'finalizedTranscript',
	'finalized_transcript',
	'partial',
	'partialTranscript',
	'partial_transcript',
	'partialAudio',
	'partial_audio',
	'partialAudioText',
	'partial_audio_text',
	'partialText',
	'partial_text',
	'audioText',
	'audio_text',
	'asrConfidence',
	'asr_confidence',
	'confidence'
]);

export type VoiceTurnRequest = Readonly<{
	audio: File;
	resolverContext: ReplayedVoiceResolverContext;
	gameId: string;
	requestId: string;
	diagnosticConsent: boolean;
}>;

export class VoiceTurnRequestError extends Error {
	readonly status: 400 | 413 | 415;

	constructor(message: string, status: 400 | 413 | 415 = 400) {
		super(message);
		this.name = 'VoiceTurnRequestError';
		this.status = status;
	}
}

/**
 * Decode the browser request before it reaches quota reservation. Direct chess
 * state fields are deliberately rejected; replayable resolver context is the
 * sole host-side state carrier for a Voice Turn.
 */
export function readVoiceTurnRequest(form: FormData): VoiceTurnRequest {
	if (forbiddenInterpreterFields.some((field) => form.has(field))) {
		throw new VoiceTurnRequestError('The chess state must be supplied only as a voice resolver context.');
	}
	if (
		form.has('interpreter') ||
		form.has('authority') ||
		form.has('interpreterPolicy') ||
		form.has('policy')
	) {
		throw new VoiceTurnRequestError('The server selects the Move Interpreter policy.');
	}

	const audio = form.get('audio');
	if (!(audio instanceof File) || audio.size === 0) {
		throw new VoiceTurnRequestError('Record a move before submitting it.');
	}
	if (audio.size > MAX_VOICE_AUDIO_BYTES) {
		throw new VoiceTurnRequestError('The recording is too large.', 413);
	}
	const audioType = audio.type.split(';', 1)[0];
	if (audioType && !acceptedAudioTypes.has(audioType)) {
		throw new VoiceTurnRequestError('This audio format is not supported.', 415);
	}

	const gameId = form.get('gameId');
	const requestId = form.get('requestId');
	if (!isOpaqueId(gameId) || !isOpaqueId(requestId)) {
		throw new VoiceTurnRequestError('The voice request identifier is invalid.');
	}
	const submittedConsent = form.get('diagnosticConsent');
	if (submittedConsent !== null && submittedConsent !== DIAGNOSTIC_CONSENT_VALUE) {
		throw new VoiceTurnRequestError('The diagnostic consent value is invalid.');
	}

	const serializedContext = form.get('resolverContext');
	if (typeof serializedContext !== 'string' || serializedContext.length > MAX_VOICE_RESOLVER_CONTEXT_CHARS) {
		throw new VoiceTurnRequestError('The voice resolver context is missing or invalid.');
	}

	try {
		return Object.freeze({
			audio,
			resolverContext: replayVoiceResolverContext(JSON.parse(serializedContext)),
			gameId,
			requestId,
			diagnosticConsent: submittedConsent === DIAGNOSTIC_CONSENT_VALUE
		});
	} catch {
		throw new VoiceTurnRequestError('The voice resolver context is missing or invalid.');
	}
}

function isOpaqueId(value: FormDataEntryValue | null): value is string {
	return typeof value === 'string' && opaqueIdPattern.test(value);
}
