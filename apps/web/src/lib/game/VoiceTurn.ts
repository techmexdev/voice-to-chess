import type { Square } from '../board/types.ts';
import type { GameSession, VoiceMoveCommitResult } from './GameSession.ts';
import type { MoveResolution, ResolvedMoveIdentity } from './MoveResolver.ts';
import type { VoiceResolverContext } from './VoiceResolverContext.ts';

/** The browser-facing result of one host-owned Voice Turn. */
export const VOICE_TURN_OUTCOME_SCHEMA = 'voice-turn-outcome/v1' as const;

export type VoiceTurnFailure = 'adapter' | 'provider' | 'timeout' | 'quota' | 'internal';

export type ResolvedVoiceTurnOutcome = Readonly<{
	schema: typeof VOICE_TURN_OUTCOME_SCHEMA;
	contextId: string;
	kind: 'resolved';
	move: ResolvedMoveIdentity;
}>;

export type UnresolvedVoiceTurnOutcome = Readonly<{
	schema: typeof VOICE_TURN_OUTCOME_SCHEMA;
	contextId: string;
	kind: 'unknown' | 'ambiguous' | 'illegal';
}>;

export type FailedVoiceTurnOutcome = Readonly<{
	schema: typeof VOICE_TURN_OUTCOME_SCHEMA;
	contextId: string;
	kind: 'failure';
	failure: VoiceTurnFailure;
}>;

export type VoiceTurnOutcome =
	| ResolvedVoiceTurnOutcome
	| UnresolvedVoiceTurnOutcome
	| FailedVoiceTurnOutcome;

/** Raw compact interpreter output never crosses this response boundary. */
export type VoiceTurnResponse = Readonly<{
	transcript: string | null;
	outcome: VoiceTurnOutcome;
}>;

export type NonResolvedVoiceTurnOutcome = Exclude<VoiceTurnOutcome, ResolvedVoiceTurnOutcome>;
export type AppliedVoiceTurnOutcome = VoiceMoveCommitResult | NonResolvedVoiceTurnOutcome;

/** A malformed server response is distinct from a player-level failure outcome. */
export class VoiceTurnOutcomeValidationError extends Error {
	readonly name = 'VoiceTurnOutcomeValidationError';
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(issues.join(', '));
		this.issues = issues;
	}
}

/** Convert the pure Move Resolver result into the stable browser contract. */
export function voiceTurnOutcomeFromResolution(
	contextId: string,
	resolution: MoveResolution
): VoiceTurnOutcome {
	if (resolution.kind === 'resolved') {
		return Object.freeze({
			schema: VOICE_TURN_OUTCOME_SCHEMA,
			contextId,
			kind: 'resolved',
			move: resolution.move
		});
	}

	return Object.freeze({
		schema: VOICE_TURN_OUTCOME_SCHEMA,
		contextId,
		kind: resolution.kind
	});
}

export function failedVoiceTurnOutcome(
	contextId: string,
	failure: VoiceTurnFailure
): FailedVoiceTurnOutcome {
	return Object.freeze({
		schema: VOICE_TURN_OUTCOME_SCHEMA,
		contextId,
		kind: 'failure',
		failure
	});
}

/**
 * Verify the public response before the browser asks its Game Session to
 * commit a Resolved Move identity. Extra envelope fields are permitted for
 * quota metadata, but every outcome itself has an exact schema.
 */
export function loadVoiceTurnResponse(input: unknown): VoiceTurnResponse {
	const value = requireRecord(input, 'voice_turn_response_must_be_object');
	if (value.transcript !== null && typeof value.transcript !== 'string') {
		fail('invalid_voice_turn_transcript');
	}

	return Object.freeze({
		transcript: value.transcript,
		outcome: loadVoiceTurnOutcome(value.outcome)
	});
}

/**
 * A response can be applied only to the exact context that created it. The
 * Game Session then performs its own replay and staleness check before it
 * changes board state.
 */
export function applyVoiceTurnOutcome(
	session: GameSession,
	context: VoiceResolverContext,
	outcome: VoiceTurnOutcome
): AppliedVoiceTurnOutcome {
	if (outcome.contextId !== context.contextId) {
		return { kind: 'stale', snapshot: session.snapshot() };
	}
	if (outcome.kind !== 'resolved') return outcome;

	return session.applyResolvedVoiceMove(context, outcome.move);
}

export function loadVoiceTurnOutcome(input: unknown): VoiceTurnOutcome {
	const value = requireRecord(input, 'voice_turn_outcome_must_be_object');
	if (value.schema !== VOICE_TURN_OUTCOME_SCHEMA) fail('invalid_voice_turn_outcome_schema');
	if (typeof value.contextId !== 'string' || value.contextId.length === 0 || value.contextId.length > 128) {
		fail('invalid_voice_turn_context_id');
	}

	switch (value.kind) {
		case 'resolved':
			assertExactKeys(value, ['schema', 'contextId', 'kind', 'move'], 'resolved_voice_turn');
			return Object.freeze({
				schema: VOICE_TURN_OUTCOME_SCHEMA,
				contextId: value.contextId,
				kind: 'resolved',
				move: loadResolvedMoveIdentity(value.move)
			});
		case 'unknown':
		case 'ambiguous':
		case 'illegal':
			assertExactKeys(value, ['schema', 'contextId', 'kind'], `${value.kind}_voice_turn`);
			return Object.freeze({
				schema: VOICE_TURN_OUTCOME_SCHEMA,
				contextId: value.contextId,
				kind: value.kind
			});
		case 'failure':
			assertExactKeys(value, ['schema', 'contextId', 'kind', 'failure'], 'failed_voice_turn');
			if (!isVoiceTurnFailure(value.failure)) fail('invalid_voice_turn_failure');
			return Object.freeze({
				schema: VOICE_TURN_OUTCOME_SCHEMA,
				contextId: value.contextId,
				kind: 'failure',
				failure: value.failure
			});
		default:
			return fail('invalid_voice_turn_outcome_kind');
	}
}

function loadResolvedMoveIdentity(input: unknown): ResolvedMoveIdentity {
	const value = requireRecord(input, 'resolved_move_must_be_object');
	const expected = ['from', 'to', 'promotion'];
	const unknown = Object.keys(value).filter((key) => !expected.includes(key));
	const missing = ['from', 'to'].filter((key) => !Object.hasOwn(value, key));
	if (unknown.length > 0 || missing.length > 0) {
		fail(
			...unknown.map((key) => `resolved_move_unknown_field:${key}`),
			...missing.map((key) => `resolved_move_missing_field:${key}`)
		);
	}

	const from = loadSquare(value.from, 'invalid_resolved_move_from');
	const to = loadSquare(value.to, 'invalid_resolved_move_to');
	if (!Object.hasOwn(value, 'promotion')) return Object.freeze({ from, to });
	if (value.promotion !== 'q' && value.promotion !== 'r' && value.promotion !== 'b' && value.promotion !== 'n') {
		fail('invalid_resolved_move_promotion');
	}
	return Object.freeze({ from, to, promotion: value.promotion });
}

function loadSquare(value: unknown, issue: string): Square {
	if (typeof value !== 'string' || !/^[a-h][1-8]$/.test(value)) fail(issue);
	return value as Square;
}

function isVoiceTurnFailure(value: unknown): value is VoiceTurnFailure {
	return value === 'adapter' || value === 'provider' || value === 'timeout' || value === 'quota' || value === 'internal';
}

function assertExactKeys(value: RecordValue, expected: readonly string[], location: string): void {
	const unknown = Object.keys(value).filter((key) => !expected.includes(key));
	const missing = expected.filter((key) => !Object.hasOwn(value, key));
	if (unknown.length > 0 || missing.length > 0) {
		fail(
			...unknown.map((key) => `${location}_unknown_field:${key}`),
			...missing.map((key) => `${location}_missing_field:${key}`)
		);
	}
}

type RecordValue = Record<string, unknown>;

function requireRecord(value: unknown, issue: string): RecordValue {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(issue);
	return value as RecordValue;
}

function fail(...issues: string[]): never {
	throw new VoiceTurnOutcomeValidationError(issues);
}
