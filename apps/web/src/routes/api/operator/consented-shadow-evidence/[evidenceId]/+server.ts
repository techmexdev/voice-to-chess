import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	isConsentedShadowEvidenceId,
	operatorConsentedShadowEvidenceStore
} from '$lib/server/consentedShadowEvidence';
import { redisCommand } from '$lib/server/redis';
import { hasOperatorBearerToken } from '$lib/server/security/operatorAccess';

/**
 * A deliberately server-only review/deletion seam. It is not linked from the
 * browser and never accepts a browser-selected interpreter or model endpoint.
 */
export const GET: RequestHandler = async ({ request, params }) => {
	if (!authorized(request) || !isConsentedShadowEvidenceId(params.evidenceId)) return notFound();
	const evidence = await operatorConsentedShadowEvidenceStore(redisCommand).read(params.evidenceId);
	if (!evidence) return notFound();
	return json(evidence, { headers: { 'Cache-Control': 'no-store' } });
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	if (!authorized(request) || !isConsentedShadowEvidenceId(params.evidenceId)) return notFound();
	await operatorConsentedShadowEvidenceStore(redisCommand).delete(params.evidenceId);
	return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};

function authorized(request: Request): boolean {
	return hasOperatorBearerToken(
		request.headers.get('authorization'),
		env.SHADOW_EVIDENCE_OPERATOR_TOKEN
	);
}

function notFound(): Response {
	return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
