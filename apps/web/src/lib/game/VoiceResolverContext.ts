import { Chess, type Move } from 'chess.js';
import type { Square } from '../board/types.ts';
import type { MoveResolverPosition, ReplayableMove, ResolvedMoveIdentity } from './MoveResolver.ts';

export const VOICE_RESOLVER_CONTEXT_SCHEMA = 'voice-resolver-context/v1' as const;

export type VoiceCorrectionContext = Readonly<{
	kind: 'replace-last';
	previousMove: ResolvedMoveIdentity;
}>;

/**
 * The host-only context that travels beside, never through, the Move
 * Interpreter request. Its move identities replay the resolver position and
 * preserve the immediately preceding capture needed for recapture.
 */
export type VoiceResolverContext = Readonly<{
	schema: typeof VOICE_RESOLVER_CONTEXT_SCHEMA;
	contextId: string;
	gameRevision: number;
	initialFen: string;
	movesBeforeResolution: readonly ResolvedMoveIdentity[];
	resolverFen: string;
	expectedFen: string;
	correction: VoiceCorrectionContext | null;
}>;

export type VoiceResolverContextInput = Omit<VoiceResolverContext, 'schema'>;

export type ReplayedVoiceResolverContext = Readonly<{
	context: VoiceResolverContext;
	position: MoveResolverPosition;
}>;

/** A context error is distinct from a Move Interpretation adapter failure. */
export class VoiceResolverContextValidationError extends Error {
	readonly name = 'VoiceResolverContextValidationError';
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(issues.join(', '));
		this.issues = issues;
	}
}

type RecordValue = Record<string, unknown>;

/** Construct and validate one replayable context before it leaves a Game Session. */
export function createVoiceResolverContext(input: VoiceResolverContextInput): VoiceResolverContext {
	return replayVoiceResolverContext({ schema: VOICE_RESOLVER_CONTEXT_SCHEMA, ...input }).context;
}

/**
 * Validate a serialized context and rebuild the exact resolver position from
 * its initial FEN and playable identities. This is the server-side validation
 * seam: raw client context does not become chess state without replaying.
 */
export function replayVoiceResolverContext(input: unknown): ReplayedVoiceResolverContext {
	const context = loadVoiceResolverContext(input);
	const chess = createChess(context.initialFen, 'invalid_initial_fen');
	const replayableHistory = context.movesBeforeResolution.map((identity, index) =>
		toReplayableMove(applyMove(chess, identity, `invalid_replay_move:${index}`))
	);

	if (chess.fen() !== context.resolverFen) fail('resolver_fen_mismatch');

	if (context.correction === null) {
		if (context.expectedFen !== context.resolverFen) fail('expected_fen_mismatch');
	} else {
		applyMove(chess, context.correction.previousMove, 'invalid_correction_previous_move');
		if (chess.fen() !== context.expectedFen) fail('expected_fen_mismatch');
	}

	return Object.freeze({
		context,
		position: Object.freeze({
			fen: context.resolverFen,
			replayableHistory: Object.freeze(replayableHistory)
		})
	});
}

export function sameResolvedMoveIdentity(
	left: ResolvedMoveIdentity,
	right: ResolvedMoveIdentity
): boolean {
	return left.from === right.from && left.to === right.to && left.promotion === right.promotion;
}

function loadVoiceResolverContext(input: unknown): VoiceResolverContext {
	const value = requireRecord(input, 'context_must_be_object');
	assertExactKeys(
		value,
		[
			'schema',
			'contextId',
			'gameRevision',
			'initialFen',
			'movesBeforeResolution',
			'resolverFen',
			'expectedFen',
			'correction'
		],
		'context'
	);
	if (value.schema !== VOICE_RESOLVER_CONTEXT_SCHEMA) fail('invalid_context_schema');
	if (typeof value.contextId !== 'string' || value.contextId.length === 0) {
		fail('invalid_context_id');
	}
	if (
		typeof value.gameRevision !== 'number' ||
		!Number.isSafeInteger(value.gameRevision) ||
		value.gameRevision < 0
	) {
		fail('invalid_game_revision');
	}
	if (typeof value.initialFen !== 'string') fail('invalid_initial_fen');
	if (typeof value.resolverFen !== 'string') fail('invalid_resolver_fen');
	if (typeof value.expectedFen !== 'string') fail('invalid_expected_fen');
	if (!Array.isArray(value.movesBeforeResolution)) fail('invalid_replay_moves');

	const movesBeforeResolution = Object.freeze(
		value.movesBeforeResolution.map((move, index) => loadMoveIdentity(move, `replay_move:${index}`))
	);
	const correction = loadCorrection(value.correction);

	return Object.freeze({
		schema: VOICE_RESOLVER_CONTEXT_SCHEMA,
		contextId: value.contextId,
		gameRevision: value.gameRevision,
		initialFen: value.initialFen,
		movesBeforeResolution,
		resolverFen: value.resolverFen,
		expectedFen: value.expectedFen,
		correction
	});
}

function loadCorrection(input: unknown): VoiceCorrectionContext | null {
	if (input === null) return null;
	const value = requireRecord(input, 'correction_must_be_object');
	assertExactKeys(value, ['kind', 'previousMove'], 'correction');
	if (value.kind !== 'replace-last') fail('invalid_correction_kind');
	return Object.freeze({
		kind: 'replace-last',
		previousMove: loadMoveIdentity(value.previousMove, 'correction_previous_move')
	});
}

function loadMoveIdentity(input: unknown, location: string): ResolvedMoveIdentity {
	const value = requireRecord(input, `${location}_must_be_object`);
	const expected = ['from', 'to', 'promotion'];
	const unknown = Object.keys(value).filter((key) => !expected.includes(key));
	const missing = ['from', 'to'].filter((key) => !Object.hasOwn(value, key));
	if (unknown.length > 0 || missing.length > 0) {
		fail(
			...unknown.map((key) => `${location}_unknown_field:${key}`),
			...missing.map((key) => `${location}_missing_field:${key}`)
		);
	}

	const from = loadSquare(value.from, `${location}_invalid_from`);
	const to = loadSquare(value.to, `${location}_invalid_to`);
	if (!Object.hasOwn(value, 'promotion')) return Object.freeze({ from, to });
	if (value.promotion !== 'q' && value.promotion !== 'r' && value.promotion !== 'b' && value.promotion !== 'n') {
		fail(`${location}_invalid_promotion`);
	}
	return Object.freeze({ from, to, promotion: value.promotion });
}

function createChess(fen: string, issue: string): Chess {
	try {
		return new Chess(fen);
	} catch {
		return fail(issue);
	}
}

function applyMove(chess: Chess, identity: ResolvedMoveIdentity, issue: string): Move {
	try {
		return chess.move({
			from: identity.from,
			to: identity.to,
			...(identity.promotion === undefined ? {} : { promotion: identity.promotion })
		});
	} catch {
		return fail(issue);
	}
}

function toReplayableMove(move: Move): ReplayableMove {
	return Object.freeze({
		from: move.from as Square,
		to: move.to as Square,
		san: move.san,
		wasCapture: move.isCapture() || move.isEnPassant(),
		wasEnPassant: move.isEnPassant(),
		...(move.promotion === 'q' || move.promotion === 'r' || move.promotion === 'b' || move.promotion === 'n'
			? { promotion: move.promotion }
			: {})
	});
}

function loadSquare(value: unknown, issue: string): Square {
	if (typeof value !== 'string' || !/^[a-h][1-8]$/.test(value)) fail(issue);
	return value as Square;
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

function requireRecord(value: unknown, issue: string): RecordValue {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(issue);
	return value as RecordValue;
}

function fail(...issues: string[]): never {
	throw new VoiceResolverContextValidationError(issues);
}
