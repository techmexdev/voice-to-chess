import { Chess, type Move } from 'chess.js';
import type { BoardColor, BoardMoveRequest, Square } from '../board/types.ts';
import type { ResolvedMoveIdentity } from './MoveResolver.ts';
import {
	createVoiceResolverContext as createReplayableVoiceResolverContext,
	replayVoiceResolverContext,
	sameResolvedMoveIdentity,
	type VoiceResolverContext
} from './VoiceResolverContext.ts';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export type GameStatus =
	| 'active'
	| 'checkmate'
	| 'stalemate'
	| 'draw-insufficient-material'
	| 'draw-threefold'
	| 'draw-fifty-move';

export type GameMove = {
	color: BoardColor;
	from: Square;
	to: Square;
	san: string;
	promotion?: PromotionPiece;
	captured?: string;
};

export type GameSnapshot = {
	fen: string;
	turn: BoardColor;
	lastMove?: readonly [Square, Square];
	check?: BoardColor;
	legalDestinations: ReadonlyMap<Square, readonly Square[]>;
	moves: readonly GameMove[];
	status: GameStatus;
};

export type AcceptedMove = {
	kind: 'accepted';
	move: GameMove;
	snapshot: GameSnapshot;
};

export type PromotionRequired = {
	kind: 'promotion-required';
	request: BoardMoveRequest;
	choices: readonly PromotionPiece[];
	snapshot: GameSnapshot;
};

export type RejectedMove = {
	kind: 'rejected';
	message: string;
	snapshot: GameSnapshot;
};

export type MoveAttemptResult = AcceptedMove | PromotionRequired | RejectedMove;

/** Applying a delayed voice result can fail safely when its session context is stale. */
export type VoiceMoveCommitResult =
	| AcceptedMove
	| {
		kind: 'illegal';
		snapshot: GameSnapshot;
	}
	| {
		kind: 'stale';
		snapshot: GameSnapshot;
	};

export type UndoResult =
	| {
		kind: 'undone';
		move: GameMove;
		snapshot: GameSnapshot;
	}
	| {
		kind: 'nothing-to-undo';
		snapshot: GameSnapshot;
	};

const coordinateNotation = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i;

/**
 * The local rules authority for the single-browser MVP.
 *
 * UI adapters may request a move, but only this class owns a Chess instance and
 * returns committed snapshots. A multiplayer version can move this exact seam
 * behind an API without teaching the board or speech UI chess rules.
 */
export class GameSession {
	readonly #chess: Chess;
	readonly #initialFen: string;
	#gameRevision = 0;
	#nextVoiceContextId = 0;

	constructor(fen?: string) {
		this.#chess = new Chess(fen);
		this.#initialFen = this.#chess.fen();
	}

	snapshot(): GameSnapshot {
		const history = this.#chess.history({ verbose: true });
		const latestMove = history[history.length - 1];

		return {
			fen: this.#chess.fen(),
			turn: toBoardColor(this.#chess.turn()),
			lastMove: latestMove ? [asSquare(latestMove.from), asSquare(latestMove.to)] : undefined,
			check: this.#chess.isCheck() ? toBoardColor(this.#chess.turn()) : undefined,
			legalDestinations: this.legalDestinations(),
			moves: history.map(toGameMove),
			status: this.status()
		};
	}

	attemptBoardMove(request: BoardMoveRequest): MoveAttemptResult {
		return this.attemptCoordinates(request.from, request.to, request.promotion);
	}

	/**
	 * Local input for canonical SAN or coordinate notation. Provider-produced SAN
	 * still passes through this strict rules check before the board can change.
	 */
	attemptNotation(notation: string): MoveAttemptResult {
		const normalizedNotation = notation.trim();
		const coordinateMatch = normalizedNotation.match(coordinateNotation);

		if (coordinateMatch) {
			return this.attemptCoordinates(
				asSquare(coordinateMatch[1].toLowerCase()),
				asSquare(coordinateMatch[2].toLowerCase()),
				coordinateMatch[3]?.toLowerCase() as PromotionPiece | undefined
			);
		}

		try {
			const move = this.#chess.move(normalizedNotation, { strict: true });
			this.#gameRevision += 1;
			return {
				kind: 'accepted',
				move: toGameMove(move),
				snapshot: this.snapshot()
			};
		} catch {
			return {
				kind: 'rejected',
				message: 'That is not a legal SAN or coordinate move for this position.',
				snapshot: this.snapshot()
			};
		}
	}

	/**
	 * Capture the exact resolver state for one ordinary voice turn. The caller
	 * sends this host-owned context beside the transcript-only interpreter
	 * request, then reuses it to reject a delayed result after any game change.
	 */
	createVoiceResolverContext(): VoiceResolverContext {
		const movesBeforeResolution = this.moveHistoryIdentities();
		const currentFen = this.#chess.fen();
		return createReplayableVoiceResolverContext({
			contextId: this.newVoiceContextId(),
			gameRevision: this.#gameRevision,
			initialFen: this.#initialFen,
			movesBeforeResolution,
			resolverFen: currentFen,
			expectedFen: currentFen,
			correction: null
		});
	}

	/**
	 * Capture a voice correction before the latest committed move. Returning
	 * undefined leaves the caller with the existing no-move-to-correct behavior.
	 */
	createVoiceCorrectionResolverContext(): VoiceResolverContext | undefined {
		const history = this.#chess.history({ verbose: true });
		const previousMove = history[history.length - 1];
		if (previousMove === undefined) return undefined;

		const movesBeforeResolution = Object.freeze(
			history.slice(0, -1).map(toResolvedMoveIdentity)
		);
		return createReplayableVoiceResolverContext({
			contextId: this.newVoiceContextId(),
			gameRevision: this.#gameRevision,
			initialFen: this.#initialFen,
			movesBeforeResolution,
			resolverFen: replayFen(this.#initialFen, movesBeforeResolution),
			expectedFen: this.#chess.fen(),
			correction: Object.freeze({
				kind: 'replace-last',
				previousMove: toResolvedMoveIdentity(previousMove)
			})
		});
	}

	/**
	 * Commit only a resolved playable identity. SAN and all other model output
	 * are deliberately absent from this boundary and are derived by chess.js.
	 */
	applyResolvedVoiceMove(
		context: VoiceResolverContext,
		identity: ResolvedMoveIdentity
	): VoiceMoveCommitResult {
		let replayed: ReturnType<typeof replayVoiceResolverContext>;
		try {
			replayed = replayVoiceResolverContext(context);
		} catch {
			return { kind: 'stale', snapshot: this.snapshot() };
		}
		if (!this.isCurrentVoiceContext(replayed.context)) {
			return { kind: 'stale', snapshot: this.snapshot() };
		}

		if (replayed.context.correction === null) {
			return this.commitVoiceIdentity(identity);
		}

		const previousMove = this.#chess.undo();
		if (previousMove === null) {
			return { kind: 'stale', snapshot: this.snapshot() };
		}
		if (
			!sameResolvedMoveIdentity(
				toResolvedMoveIdentity(previousMove),
				replayed.context.correction.previousMove
			)
		) {
			this.restoreMove(previousMove);
			return { kind: 'stale', snapshot: this.snapshot() };
		}

		const replacement = this.commitVoiceIdentity(identity);
		if (replacement.kind === 'accepted') return replacement;

		this.restoreMove(previousMove);
		return { kind: 'illegal', snapshot: this.snapshot() };
	}

	/**
	 * Atomically replaces the latest move with notation resolved from the position
	 * before it. A rejected replacement restores the original move.
	 */
	replaceLastNotation(notation: string): MoveAttemptResult {
		const previousMove = this.#chess.undo();
		if (!previousMove) {
			return {
				kind: 'rejected',
				message: 'There is no move to replace.',
				snapshot: this.snapshot()
			};
		}

		const replacement = this.attemptNotation(notation);
		if (replacement.kind === 'accepted') return replacement;

		this.#chess.move({
			from: previousMove.from,
			to: previousMove.to,
			promotion: previousMove.promotion
		});

		return {
			kind: 'rejected',
			message:
				replacement.kind === 'promotion-required'
					? 'Include the promotion piece when correcting this move.'
					: replacement.message,
			snapshot: this.snapshot()
		};
	}

	undo(): UndoResult {
		const move = this.#chess.undo();

		if (!move) {
			return { kind: 'nothing-to-undo', snapshot: this.snapshot() };
		}
		this.#gameRevision += 1;

		return {
			kind: 'undone',
			move: toGameMove(move),
			snapshot: this.snapshot()
		};
	}

	private attemptCoordinates(
		from: Square,
		to: Square,
		promotion?: PromotionPiece
	): MoveAttemptResult {
		const candidates = this.#chess
			.moves({ verbose: true })
			.filter((move) => move.from === from && move.to === to);
		const promotionChoices = uniquePromotionChoices(candidates);

		if (candidates.length === 0) {
			return {
				kind: 'rejected',
				message: 'That move is not legal in the current position.',
				snapshot: this.snapshot()
			};
		}

		if (promotionChoices.length > 0 && !promotion) {
			return {
				kind: 'promotion-required',
				request: { from, to },
				choices: promotionChoices,
				snapshot: this.snapshot()
			};
		}
		if (promotion && !promotionChoices.includes(promotion)) {
			return {
				kind: 'rejected',
				message: 'That promotion choice is not legal for this move.',
				snapshot: this.snapshot()
			};
		}

		try {
			const move = this.#chess.move({ from, to, promotion });
			this.#gameRevision += 1;
			return {
				kind: 'accepted',
				move: toGameMove(move),
				snapshot: this.snapshot()
			};
		} catch {
			return {
				kind: 'rejected',
				message: 'That move is not legal in the current position.',
				snapshot: this.snapshot()
			};
		}
	}

	private commitVoiceIdentity(identity: ResolvedMoveIdentity): VoiceMoveCommitResult {
		try {
			const move = this.#chess.move({
				from: identity.from,
				to: identity.to,
				...(identity.promotion === undefined ? {} : { promotion: identity.promotion })
			});
			this.#gameRevision += 1;
			return {
				kind: 'accepted',
				move: toGameMove(move),
				snapshot: this.snapshot()
			};
		} catch {
			return { kind: 'illegal', snapshot: this.snapshot() };
		}
	}

	private restoreMove(move: Move): void {
		this.#chess.move({
			from: move.from,
			to: move.to,
			promotion: move.promotion
		});
	}

	private isCurrentVoiceContext(context: VoiceResolverContext): boolean {
		if (
			context.gameRevision !== this.#gameRevision ||
			context.initialFen !== this.#initialFen ||
			context.expectedFen !== this.#chess.fen()
		) {
			return false;
		}

		const expectedHistory =
			context.correction === null
				? context.movesBeforeResolution
				: [...context.movesBeforeResolution, context.correction.previousMove];
		const currentHistory = this.moveHistoryIdentities();
		return (
			currentHistory.length === expectedHistory.length &&
			currentHistory.every((move, index) => {
				const expected = expectedHistory[index];
				return expected !== undefined && sameResolvedMoveIdentity(move, expected);
			})
		);
	}

	private moveHistoryIdentities(): readonly ResolvedMoveIdentity[] {
		return Object.freeze(this.#chess.history({ verbose: true }).map(toResolvedMoveIdentity));
	}

	private newVoiceContextId(): string {
		this.#nextVoiceContextId += 1;
		return `voice-turn-${this.#nextVoiceContextId}`;
	}

	private legalDestinations(): ReadonlyMap<Square, readonly Square[]> {
		const destinations = new Map<Square, Square[]>();

		for (const move of this.#chess.moves({ verbose: true })) {
			const from = asSquare(move.from);
			const to = asSquare(move.to);
			const currentDestinations = destinations.get(from) ?? [];

			if (!currentDestinations.includes(to)) currentDestinations.push(to);
			destinations.set(from, currentDestinations);
		}

		return destinations;
	}

	private status(): GameStatus {
		if (this.#chess.isCheckmate()) return 'checkmate';
		if (this.#chess.isStalemate()) return 'stalemate';
		if (this.#chess.isInsufficientMaterial()) return 'draw-insufficient-material';
		if (this.#chess.isThreefoldRepetition()) return 'draw-threefold';
		if (this.#chess.isDrawByFiftyMoves()) return 'draw-fifty-move';
		return 'active';
	}
}

function asSquare(square: string): Square {
	return square as Square;
}

function toBoardColor(color: 'w' | 'b'): BoardColor {
	return color === 'w' ? 'white' : 'black';
}

function toGameMove(move: Move): GameMove {
	return {
		color: toBoardColor(move.color),
		from: asSquare(move.from),
		to: asSquare(move.to),
		san: move.san,
		promotion: move.promotion as PromotionPiece | undefined,
		captured: move.captured
	};
}

function toResolvedMoveIdentity(move: Move): ResolvedMoveIdentity {
	return Object.freeze({
		from: asSquare(move.from),
		to: asSquare(move.to),
		...(move.promotion === 'q' || move.promotion === 'r' || move.promotion === 'b' || move.promotion === 'n'
			? { promotion: move.promotion }
			: {})
	});
}

function replayFen(initialFen: string, moves: readonly ResolvedMoveIdentity[]): string {
	const chess = new Chess(initialFen);
	for (const move of moves) {
		chess.move({
			from: move.from,
			to: move.to,
			...(move.promotion === undefined ? {} : { promotion: move.promotion })
		});
	}
	return chess.fen();
}

function uniquePromotionChoices(moves: readonly Move[]): PromotionPiece[] {
	return [
		...new Set(
			moves
				.map((move) => move.promotion)
				.filter((promotion): promotion is PromotionPiece => promotion !== undefined)
		)
	];
}
