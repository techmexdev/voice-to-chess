import {
	MOVE_INTERPRETER_REQUEST_SCHEMA,
	type InterpreterReleaseIdentity,
	type MoveInterpreter,
	type MoveInterpreterCallOptions,
	type MoveInterpreterRequest,
	type MoveInterpreterResult,
	MoveInterpreterProviderError,
	isTimeoutError
} from './moveInterpreter.ts';

const SLM_RESPONSE_SCHEMA = 'move-interpreter-response/v1';

export type SlmMoveInterpreterConfig = Readonly<{
	endpoint: string;
	bearerToken: string;
	release: InterpreterReleaseIdentity;
	fetcher?: typeof fetch;
}>;

export class SlmMoveInterpreterConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SlmMoveInterpreterConfigurationError';
	}
}

/**
 * Gateway-only adapter for the fixed private SLM service. It forwards exactly
 * the service's transcript request and verifies the approved immutable release.
 */
export function createSlmMoveInterpreter(config: SlmMoveInterpreterConfig): MoveInterpreter {
	const endpoint = interpretationEndpoint(config.endpoint);
	if (!config.bearerToken) {
		throw new SlmMoveInterpreterConfigurationError('The private SLM token is not configured.');
	}
	const fetcher = config.fetcher ?? fetch;

	return Object.freeze({
		authority: 'slm' as const,
		release: config.release,
		async interpret(
			request: MoveInterpreterRequest,
			options: MoveInterpreterCallOptions
		): Promise<MoveInterpreterResult> {
			let response: Response;
			try {
				response = await fetcher(endpoint, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${config.bearerToken}`,
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						schema: MOVE_INTERPRETER_REQUEST_SCHEMA,
						behavior_contract: request.behaviorContract,
						finalized_transcript: request.finalizedTranscript
					}),
					signal: options.signal
				});
			} catch (error) {
				throw new MoveInterpreterProviderError(
					'The private SLM request failed.',
					isTimeoutError(error) ? 'timeout' : 'provider'
				);
			}

			const payload = await readResponsePayload(response);
			if (!response.ok) {
				throw new MoveInterpreterProviderError(
					'The private SLM request was rejected.',
					response.status === 408 || response.status === 504 ? 'timeout' : 'provider'
				);
			}

			return Object.freeze({
				compact: loadCompactResponse(payload, config.release),
				release: config.release
			});
		}
	});
}

function interpretationEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SlmMoveInterpreterConfigurationError('The private SLM endpoint is invalid.');
	}
	if (!url.hostname || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
		throw new SlmMoveInterpreterConfigurationError('The private SLM endpoint is invalid.');
	}
	if (url.username || url.password) {
		throw new SlmMoveInterpreterConfigurationError('The private SLM endpoint is invalid.');
	}
	const normalizedPath = url.pathname.replace(/\/$/, '');
	url.pathname = normalizedPath.endsWith('/v1/move-interpretations')
		? normalizedPath
		: `${normalizedPath}/v1/move-interpretations`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

async function readResponsePayload(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new MoveInterpreterProviderError('The private SLM returned an unreadable response.');
	}
}

function loadCompactResponse(payload: unknown, expectedRelease: InterpreterReleaseIdentity): string {
	if (!isRecord(payload) || !hasExactKeys(payload, ['schema', 'behavior_contract', 'compact', 'release'])) {
		throw new MoveInterpreterProviderError('The private SLM returned an invalid response.');
	}
	if (
		payload.schema !== SLM_RESPONSE_SCHEMA ||
		payload.behavior_contract !== 'move-intent-behavior/v2' ||
		typeof payload.compact !== 'string' ||
		!isRecord(payload.release) ||
		payload.release.release_id !== expectedRelease.releaseId ||
		payload.release.identity_sha256 !== expectedRelease.identity
	) {
		throw new MoveInterpreterProviderError('The private SLM release did not match the server policy.');
	}
	return payload.compact;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
