import {
	VOICE_RUNTIME_PREFLIGHT_SCHEMA,
	type ReleasePreflight
} from './releasePreflight.ts';
import { hasOperatorBearerToken } from './security/operatorAccess.ts';

export type OperatorReleasePreflightHandler = (request: Request) => Promise<Response>;

export type OperatorReleasePreflightInput = Readonly<{
	operatorToken: string | undefined;
	run: () => Promise<ReleasePreflight>;
}>;

/**
 * Keep the deployment receipt behind a dedicated server-only bearer token.
 * A blocked receipt is still a successful operator response: it is evidence
 * for a release decision, not a public health endpoint.
 */
export function createOperatorReleasePreflightHandler(
	input: OperatorReleasePreflightInput
): OperatorReleasePreflightHandler {
	return async (request) => {
		if (!hasOperatorBearerToken(request.headers.get('authorization'), input.operatorToken)) {
			return notFound();
		}

		try {
			const receipt = await input.run();
			return Response.json(receipt, { headers: noStoreHeaders() });
		} catch {
			return Response.json(unavailableReceipt(), {
				status: 503,
				headers: noStoreHeaders()
			});
		}
	};
}

function unavailableReceipt(): ReleasePreflight {
	return Object.freeze({
		schema: VOICE_RUNTIME_PREFLIGHT_SCHEMA,
		status: 'blocked',
		policy: null,
		topology: null,
		checks: Object.freeze([
			Object.freeze({
				name: 'policy' as const,
				status: 'failed' as const,
				message: 'The release preflight could not run.'
			})
		])
	});
}

function notFound(): Response {
	return new Response(null, { status: 404, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
	return { 'Cache-Control': 'no-store' };
}
