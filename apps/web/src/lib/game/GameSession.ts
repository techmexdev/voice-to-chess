import { Chess, type Move } from 'chess.js';
import type { BoardColor, BoardMoveRequest, Square } from '$lib/board/types';

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

	constructor(fen?: string) {
		this.#chess = new Chess(fen);
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

function uniquePromotionChoices(moves: readonly Move[]): PromotionPiece[] {
	return [
		...new Set(
			moves
				.map((move) => move.promotion)
				.filter((promotion): promotion is PromotionPiece => promotion !== undefined)
		)
	];
}
