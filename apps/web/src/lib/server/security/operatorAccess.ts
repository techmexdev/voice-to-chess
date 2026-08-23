import { timingSafeEqual } from 'node:crypto';

/** Compare a bearer credential without revealing whether the configured token exists. */
export function hasOperatorBearerToken(
	authorization: string | null,
	configuredToken: string | undefined
): boolean {
	if (!configuredToken || !authorization?.startsWith('Bearer ')) return false;
	const supplied = Buffer.from(authorization.slice('Bearer '.length));
	const expected = Buffer.from(configuredToken);
	return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
