import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';

const COOKIE_NAME = 'vtc_access';
const PASS_SECONDS = 7 * 24 * 60 * 60;

export type AccessPass = {
	sessionId: string;
	expiresAt: number;
};

export function issueAccessPass(cookies: Cookies): AccessPass {
	const pass = {
		sessionId: randomBytes(24).toString('base64url'),
		expiresAt: Math.floor(Date.now() / 1000) + PASS_SECONDS
	};
	const payload = Buffer.from(JSON.stringify(pass)).toString('base64url');
	const value = `${payload}.${signature(payload)}`;

	cookies.set(COOKIE_NAME, value, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: PASS_SECONDS
	});

	return pass;
}

export function readAccessPass(cookies: Cookies): AccessPass | undefined {
	const value = cookies.get(COOKIE_NAME);
	if (!value) return undefined;
	const separator = value.lastIndexOf('.');
	if (separator < 1) return undefined;

	const payload = value.slice(0, separator);
	const supplied = value.slice(separator + 1);
	const expected = signature(payload);
	const suppliedBytes = Buffer.from(supplied);
	const expectedBytes = Buffer.from(expected);
	if (
		suppliedBytes.length !== expectedBytes.length ||
		!timingSafeEqual(suppliedBytes, expectedBytes)
	) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
		if (!isRecord(parsed)) return undefined;
		if (typeof parsed.sessionId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(parsed.sessionId)) {
			return undefined;
		}
		if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() / 1000) {
			return undefined;
		}
		return { sessionId: parsed.sessionId, expiresAt: parsed.expiresAt };
	} catch {
		return undefined;
	}
}

function signature(payload: string): string {
	const secret = env.ACCESS_COOKIE_SECRET;
	if (!secret || secret.length < 32) {
		throw new Error('ACCESS_COOKIE_SECRET must contain at least 32 characters.');
	}
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
