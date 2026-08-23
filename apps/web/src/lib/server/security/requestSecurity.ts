import { createHmac } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';

const DEVELOPMENT_IP_HASH_SECRET = 'blindfold-chess-local-ip-hash-secret';

export function hasExpectedOrigin(event: RequestEvent): boolean {
	const origin = event.request.headers.get('origin');
	if (!origin) return dev;
	return origin === event.url.origin;
}

export function dailyIpHash(event: RequestEvent): string {
	const secret = env.IP_HASH_SECRET ?? (dev ? DEVELOPMENT_IP_HASH_SECRET : undefined);
	if (!secret || secret.length < 32) throw new Error('IP_HASH_SECRET must contain at least 32 characters.');
	const day = new Date().toISOString().slice(0, 10);
	return createHmac('sha256', secret)
		.update(`${day}:${event.getClientAddress()}`)
		.digest('base64url')
		.slice(0, 32);
}

export function validOpaqueId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}
