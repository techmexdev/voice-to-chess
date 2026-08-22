import { env } from '$env/dynamic/private';

export class RedisUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RedisUnavailableError';
	}
}

export async function redisCommand<T>(command: readonly (string | number)[]): Promise<T> {
	const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
	const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
	if (!url || !token) throw new RedisUnavailableError('Redis is not configured.');

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(command),
			signal: AbortSignal.timeout(4_000)
		});
	} catch {
		throw new RedisUnavailableError('Redis could not be reached.');
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new RedisUnavailableError('Redis returned an unreadable response.');
	}
	if (!response.ok || !isRecord(payload) || !('result' in payload)) {
		throw new RedisUnavailableError('Redis rejected the request.');
	}
	return payload.result as T;
}

export async function recordMetric(name: string, increment = 1): Promise<void> {
	if (!/^[a-z0-9_]{1,48}$/.test(name) || !Number.isSafeInteger(increment)) return;
	const day = new Date().toISOString().slice(0, 10);
	try {
		await redisCommand([
			'EVAL',
			"redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2]); redis.call('EXPIRE', KEYS[1], 7776000); return 1",
			1,
			`metrics:${day}`,
			name,
			increment
		]);
	} catch {
		// Metrics never change the user-visible result or retry provider work.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
