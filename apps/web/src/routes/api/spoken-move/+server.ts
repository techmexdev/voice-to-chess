import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	SpokenMoveInputError,
	SpokenMoveProviderError,
	transcribeAndInterpretMove
} from '$lib/server/openai/spokenMove';
import { reserveVoiceMove, releaseVoiceLock } from '$lib/server/quotas';
import { recordMetric } from '$lib/server/redis';
import { readAccessPass } from '$lib/server/security/accessPass';
import { dailyIpHash, hasExpectedOrigin, validOpaqueId } from '$lib/server/security/requestSecurity';

const MAX_AUDIO_BYTES = 384 * 1024;
const acceptedAudioTypes = new Set([
	'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm'
]);

export const POST: RequestHandler = async (event) => {
	const { request, fetch } = event;
	if (!hasExpectedOrigin(event)) return json({ error: 'The request origin is invalid.' }, { status: 403 });
	const pass = readAccessPass(event.cookies);
	if (!pass) return json({ error: 'Voice access expired. Start a new game to continue.' }, { status: 401 });
	if (!env.OPENAI_API_KEY) return json({ error: 'Speech input is not configured.' }, { status: 503 });

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'The audio request could not be read.' }, { status: 400 });
	}
	const audio = form.get('audio');
	const fen = form.get('fen');
	const gameId = form.get('gameId');
	const requestId = form.get('requestId');

	if (!(audio instanceof File) || audio.size === 0) return json({ error: 'Record a move before submitting it.' }, { status: 400 });
	if (audio.size > MAX_AUDIO_BYTES) return json({ error: 'The recording is too large.' }, { status: 413 });
	const audioType = audio.type.split(';', 1)[0];
	if (audioType && !acceptedAudioTypes.has(audioType)) return json({ error: 'This audio format is not supported.' }, { status: 415 });
	if (typeof fen !== 'string' || fen.length > 120) return json({ error: 'The chess position is missing or invalid.' }, { status: 400 });
	if (!validOpaqueId(gameId) || !validOpaqueId(requestId)) return json({ error: 'The voice request identifier is invalid.' }, { status: 400 });

	let reservation: Awaited<ReturnType<typeof reserveVoiceMove>>;
	try {
		reservation = await reserveVoiceMove({ sessionId: pass.sessionId, ipHash: dailyIpHash(event), gameId, requestId });
	} catch (error) {
		console.error(error);
		return json({ error: 'Voice limits are temporarily unavailable. Use typed or board moves.' }, { status: 503 });
	}
	if (!reservation.allowed) {
		return json(
			{ error: quotaMessage(reservation.reason), remainingGames: reservation.remainingGames },
			{ status: reservation.reason === 'duplicate' || reservation.reason === 'busy' ? 409 : 429 }
		);
	}

	const providerStartedAt = Date.now();
	try {
		const result = await transcribeAndInterpretMove(audio, fen, env.OPENAI_API_KEY, fetch);
		void recordMetric(`voice_${result.interpretation.status}`);
		return json({ ...result, remainingGames: reservation.remainingGames });
	} catch (error) {
		if (error instanceof SpokenMoveInputError) return json({ error: error.message }, { status: 400 });
		if (error instanceof SpokenMoveProviderError) {
			console.error(error.message);
			return json({ error: 'The spoken move could not be processed. Please try again.' }, { status: 502 });
		}
		console.error(error);
		return json({ error: 'The spoken move could not be processed. Please try again.' }, { status: 500 });
	} finally {
		void recordMetric('voice_latency_ms_sum', Date.now() - providerStartedAt);
		void recordMetric('voice_latency_count');
		try {
			await releaseVoiceLock(pass.sessionId, requestId);
		} catch (error) {
			console.error(error);
		}
	}
};

function quotaMessage(reason: string): string {
	switch (reason) {
		case 'pace': return 'Please wait two seconds before the next voice move.';
		case 'minute': return 'Voice input is moving too quickly. Try again in a minute.';
		case 'games': return 'No voice games remain today. Typed and board play are still available.';
		case 'day': return 'This device has reached today\'s voice limit.';
		case 'global_day': return 'Today\'s public voice limit has been reached.';
		case 'global_month': return 'This month\'s public voice budget has been reached.';
		case 'busy': return 'The previous voice move is still processing.';
		case 'duplicate': return 'This voice move was already submitted.';
		default: return 'Voice input is temporarily limited.';
	}
}
