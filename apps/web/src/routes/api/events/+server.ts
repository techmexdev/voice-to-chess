import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recordMetric } from '$lib/server/redis';
import { readAccessPass } from '$lib/server/security/accessPass';
import { hasExpectedOrigin } from '$lib/server/security/requestSecurity';

const allowedEvents = new Set([
	'game_started_none',
	'game_started_white',
	'game_started_black',
	'game_started_both'
]);

export const POST: RequestHandler = async (event) => {
	if (!hasExpectedOrigin(event)) return json({ ok: false }, { status: 403 });
	if (!readAccessPass(event.cookies)) return json({ ok: false }, { status: 401 });

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ ok: false }, { status: 400 });
	}
	const name = isRecord(payload) ? payload.name : undefined;
	if (typeof name !== 'string' || !allowedEvents.has(name)) return json({ ok: false }, { status: 400 });
	await recordMetric(name);
	return json({ ok: true });
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
