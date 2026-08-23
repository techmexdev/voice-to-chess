import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestHandler } from './$types';
import {
	createOperatorReleasePreflightHandler
} from '$lib/server/operatorReleasePreflight';
import {
	checkRedisQuotaAvailability,
	runReleasePreflight
} from '$lib/server/releasePreflight';
import { redisCommand } from '$lib/server/redis';

/**
 * Deliberately not a public health endpoint. The response is a safe release
 * receipt and requires a separately scoped server-only operator bearer.
 */
export const GET: RequestHandler = async (event) => {
	const handler = createOperatorReleasePreflightHandler({
		operatorToken: env.RELEASE_PREFLIGHT_OPERATOR_TOKEN,
		run: () => runReleasePreflight({
			// Include public names only so preflight can fail a deployment that
			// accidentally exposes an endpoint or credential to the browser.
			environment: { ...env, ...publicEnv },
			fetcher: event.fetch,
			checkQuota: () => checkRedisQuotaAvailability(redisCommand)
		})
	});
	return handler(event.request);
};
