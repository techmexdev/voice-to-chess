import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { moveAnnouncement } from '$lib/game/moveAnnouncement';
import { createMoveSpeech, TextToSpeechProviderError } from '$lib/server/openai/textToSpeech';
import { reserveTts } from '$lib/server/quotas';
import { recordMetric } from '$lib/server/redis';
import { readAccessPass } from '$lib/server/security/accessPass';
import { hasExpectedOrigin } from '$lib/server/security/requestSecurity';
import { createVoiceTelemetry } from '$lib/server/voiceTelemetry';

const SAN_PATTERN = /^(?:O-O(?:-O)?|[KQRBN](?:[a-h]|[1-8]|[a-h][1-8])?x?[a-h][1-8](?:=[QRBN])?|[a-h]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/;
const feedback = {
	unknown: 'I did not understand that move. Say the complete move again.',
	ambiguous: 'Ambiguous move. Say the complete move again.',
	illegal: 'Illegal move. Say the complete move again.',
	failed: 'Voice input failed. Please try again.'
} as const;
const telemetry = createVoiceTelemetry(recordMetric);

export const POST: RequestHandler = async (event) => {
	const { request, fetch } = event;
	if (!hasExpectedOrigin(event)) return json({ error: 'The request origin is invalid.' }, { status: 403 });
	const pass = readAccessPass(event.cookies);
	if (!pass) return json({ error: 'Voice access has expired.' }, { status: 401 });
	if (!env.OPENAI_API_KEY) return json({ error: 'Move announcements are not configured.' }, { status: 503 });

	let payload: unknown;
	const providerStartedAt = Date.now();
	try {
		payload = await request.json();
	} catch {
		return json({ error: 'The move announcement request could not be read.' }, { status: 400 });
	}
	const text = announcementFrom(payload);
	if (!text) return json({ error: 'The move announcement is missing or invalid.' }, { status: 400 });

	const quotaStartedAt = Date.now();
	try {
		const reservation = await reserveTts(pass.sessionId);
		telemetry.record({
			phase: 'quota',
			status: reservation.allowed ? 'allowed' : 'rejected',
			elapsedMs: Date.now() - quotaStartedAt
		});
		if (!reservation.allowed) return json({ error: 'Cloud voice is currently limited. Using the browser voice.' }, { status: 429 });
	} catch (error) {
		telemetry.record({
			phase: 'quota',
			status: 'unavailable',
			elapsedMs: Date.now() - quotaStartedAt
		});
		console.error(error);
		return json({ error: 'Cloud voice is temporarily unavailable. Using the browser voice.' }, { status: 503 });
	}

	try {
		const audio = await createMoveSpeech(text, env.OPENAI_API_KEY, fetch);
		telemetry.record({
			phase: 'feedback',
			status: 'ok',
			elapsedMs: Date.now() - providerStartedAt
		});
		void recordMetric('tts_generated');
		return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		telemetry.record({
			phase: 'feedback',
			status: 'provider',
			elapsedMs: Date.now() - providerStartedAt
		});
		if (error instanceof TextToSpeechProviderError) console.error(error.message);
		else console.error(error);
		return json({ error: 'The move was played, but cloud voice was unavailable.' }, { status: 502 });
	} finally {
		void recordMetric('tts_latency_ms_sum', Date.now() - providerStartedAt);
		void recordMetric('tts_latency_count');
	}
};

function announcementFrom(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	if (
		payload.kind === 'move' &&
		(payload.color === 'white' || payload.color === 'black') &&
		typeof payload.san === 'string'
	) {
		const san = payload.san.trim();
		return SAN_PATTERN.test(san) ? moveAnnouncement({ color: payload.color, san }) : undefined;
	}
	if (payload.kind === 'feedback' && typeof payload.code === 'string' && payload.code in feedback) {
		return feedback[payload.code as keyof typeof feedback];
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
