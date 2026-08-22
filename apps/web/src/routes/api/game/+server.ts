import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { finishVoiceGame } from '$lib/server/quotas';
import { recordMetric } from '$lib/server/redis';
import { readAccessPass } from '$lib/server/security/accessPass';
import { hasExpectedOrigin, validOpaqueId } from '$lib/server/security/requestSecurity';

export const POST: RequestHandler = async (event) => {
	if (!hasExpectedOrigin(event)) return json({ error: 'The request origin is invalid.' }, { status: 403 });
	const pass = readAccessPass(event.cookies);
	if (!pass) return json({ error: 'Voice access has expired.' }, { status: 401 });

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ error: 'The game request could not be read.' }, { status: 400 });
	}
	const gameId = isRecord(payload) ? payload.gameId : undefined;
	if (!validOpaqueId(gameId)) return json({ error: 'The game identifier is invalid.' }, { status: 400 });

	try {
		const result = await finishVoiceGame(pass.sessionId, gameId);
		void recordMetric('games_finished');
		return json(result);
	} catch (error) {
		console.error(error);
		return json({ error: 'Voice limits are temporarily unavailable.' }, { status: 503 });
	}
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
