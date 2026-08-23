/** The only value a Move Interpreter may receive from a Voice Turn. */
export const MOVE_INTERPRETER_REQUEST_SCHEMA = 'move-interpreter-request/v1' as const;
export const MOVE_INTERPRETER_BEHAVIOR_CONTRACT = 'move-intent-behavior/v2' as const;

export type InterpreterAuthority = 'hosted' | 'slm';
export type InterpreterFailure = 'provider' | 'timeout';

export type InterpreterReleaseIdentity = Readonly<{
	releaseId: string;
	identity: string;
}>;

export type MoveInterpreterRequest = Readonly<{
	schema: typeof MOVE_INTERPRETER_REQUEST_SCHEMA;
	behaviorContract: typeof MOVE_INTERPRETER_BEHAVIOR_CONTRACT;
	finalizedTranscript: string;
}>;

export type MoveInterpreterResult = Readonly<{
	compact: string;
	release: InterpreterReleaseIdentity;
}>;

export type MoveInterpreterCallOptions = Readonly<{
	signal: AbortSignal;
}>;

/**
 * Both authorities implement this narrow boundary. Resolver context is absent
 * by type and by construction: an interpreter receives only a final transcript.
 */
export interface MoveInterpreter {
	readonly authority: InterpreterAuthority;
	readonly release: InterpreterReleaseIdentity;
	interpret(
		request: MoveInterpreterRequest,
		options: MoveInterpreterCallOptions
	): Promise<MoveInterpreterResult>;
}

export class MoveInterpreterInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MoveInterpreterInputError';
	}
}

/** A provider-side failure never authorizes trying a different authority. */
export class MoveInterpreterProviderError extends Error {
	readonly failure: InterpreterFailure;

	constructor(message: string, failure: InterpreterFailure = 'provider') {
		super(message);
		this.name = 'MoveInterpreterProviderError';
		this.failure = failure;
	}
}

export function createMoveInterpreterRequest(transcript: unknown): MoveInterpreterRequest {
	if (
		typeof transcript !== 'string' ||
		transcript.length === 0 ||
		transcript.length > 240 ||
		transcript !== transcript.trim()
	) {
		throw new MoveInterpreterInputError('The finalized transcript is invalid.');
	}

	return Object.freeze({
		schema: MOVE_INTERPRETER_REQUEST_SCHEMA,
		behaviorContract: MOVE_INTERPRETER_BEHAVIOR_CONTRACT,
		finalizedTranscript: transcript
	});
}

export function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
