import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { issueAccessPass, readAccessPass } from '$lib/server/security/accessPass';
import { hasExpectedOrigin } from '$lib/server/security/requestSecurity';
import { RedisUnavailableError, recordMetric } from '$lib/server/redis';
import { remainingVoiceGames } from '$lib/server/quotas';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const pass = readAccessPass(cookies) ?? (dev ? issueAccessPass(cookies) : undefined);
		if (!pass) return json({ access: false, remainingGames: 3 });
		return json({ access: true, remainingGames: await remainingVoiceGames(pass.sessionId) });
	} catch (error) {
		if (error instanceof RedisUnavailableError) {
			return json({ access: true, voiceAvailable: false, remainingGames: 0 });
		}
		console.error(error);
		return json({ access: false, remainingGames: 0 }, { status: 503 });
	}
};

export const POST: RequestHandler = async (event) => {
	if (!hasExpectedOrigin(event)) return json({ error: 'The request origin is invalid.' }, { status: 403 });

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ error: 'The verification request could not be read.' }, { status: 400 });
	}
	const token = isRecord(payload) && typeof payload.token === 'string' ? payload.token : '';
	if (!token || token.length > 2048) return json({ error: 'Complete the verification to start.' }, { status: 400 });
	if (!env.TURNSTILE_SECRET_KEY) return json({ error: 'Voice access is not configured.' }, { status: 503 });

	let verification: unknown;
	try {
		const response = await event.fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
			signal: AbortSignal.timeout(5_000)
		});
		verification = await response.json();
	} catch {
		return json({ error: 'Verification is temporarily unavailable.' }, { status: 503 });
	}

	if (!isRecord(verification) || verification.success !== true || verification.action !== 'start-game') {
		return json({ error: 'Verification failed. Please try again.' }, { status: 403 });
	}
	if (verification.hostname !== event.url.hostname) {
		return json({ error: 'Verification was issued for a different site.' }, { status: 403 });
	}

	try {
		const pass = issueAccessPass(event.cookies);
		const remainingGames = await remainingVoiceGames(pass.sessionId);
		void recordMetric('access_granted');
		return json({ access: true, remainingGames });
	} catch (error) {
		console.error(error);
		return json({ error: 'Voice access is temporarily unavailable.' }, { status: 503 });
	}
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
