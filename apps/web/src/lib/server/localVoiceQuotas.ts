export type LocalVoiceQuotaEnvironment = Readonly<{
	development: boolean;
	redisUrl?: string;
	redisToken?: string;
}>;

export function shouldUseLocalVoiceQuotas(environment: LocalVoiceQuotaEnvironment): boolean {
	return environment.development && !(environment.redisUrl && environment.redisToken);
}

export class LocalVoiceQuotas {
	readonly #remainingGames: number;
	readonly #gameMoves = new Map<string, number>();
	readonly #requests = new Set<string>();
	readonly #locks = new Map<string, string>();

	constructor(remainingGames = 3) {
		this.#remainingGames = remainingGames;
	}

	async reserveVoiceMove(input: {
		sessionId: string;
		gameId: string;
		requestId: string;
	}): Promise<{ allowed: boolean; reason: string; remainingGames: number }> {
		const requestKey = `${input.sessionId}:${input.requestId}`;
		if (this.#requests.has(requestKey)) {
			return { allowed: false, reason: 'duplicate', remainingGames: this.#remainingGames };
		}
		if (this.#locks.has(input.sessionId)) {
			return { allowed: false, reason: 'busy', remainingGames: this.#remainingGames };
		}

		this.#requests.add(requestKey);
		this.#locks.set(input.sessionId, input.requestId);
		const gameKey = `${input.sessionId}:${input.gameId}`;
		this.#gameMoves.set(gameKey, (this.#gameMoves.get(gameKey) ?? 0) + 1);
		return { allowed: true, reason: 'ok', remainingGames: this.#remainingGames };
	}

	async releaseVoiceLock(sessionId: string, requestId: string): Promise<void> {
		if (this.#locks.get(sessionId) === requestId) this.#locks.delete(sessionId);
	}

	async finishVoiceGame(sessionId: string, gameId: string): Promise<{ remainingGames: number; voiceMoves: number }> {
		const gameKey = `${sessionId}:${gameId}`;
		const voiceMoves = this.#gameMoves.get(gameKey) ?? 0;
		this.#gameMoves.delete(gameKey);
		return { remainingGames: this.#remainingGames, voiceMoves };
	}

	async remainingVoiceGames(_sessionId: string): Promise<number> {
		return this.#remainingGames;
	}

	async reserveTts(_sessionId: string): Promise<{ allowed: boolean; reason: string }> {
		return { allowed: true, reason: 'ok' };
	}
}
