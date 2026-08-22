<script lang="ts">
	import { onMount } from 'svelte';
	import { env as publicEnv } from '$env/dynamic/public';
	import ChessgroundBoard from '$lib/board/ChessgroundBoard.svelte';
	import {
		GameSession,
		type GameMove,
		type GameSnapshot,
		type GameStatus,
		type MoveAttemptResult,
		type PromotionPiece
	} from '$lib/game/GameSession';
	import { moveAnnouncement } from '$lib/game/moveAnnouncement';
	import type { BoardColor, BoardMoveRequest, BoardSeatView } from '$lib/board/types';

	type BlindSide = 'none' | 'white' | 'black' | 'both';
	type Theme = 'dark' | 'light';
	type ClockPresetId = '3+2' | '5+3' | '10+5' | '15+10' | 'none';
	type ClockPreset = {
		id: ClockPresetId;
		label: string;
		initialMs: number;
		incrementMs: number;
	};
	type PressSource = 'keyboard' | 'pointer';
	type AudioContextConstructor = new () => AudioContext;
	type SpokenMoveApiResponse = {
		transcript?: unknown;
		interpretation?: {
			status?: unknown;
			san?: unknown;
		};
		error?: unknown;
		remainingGames?: unknown;
	};
	type SpeechRequest =
		| { cacheKey: string; text: string; body: { kind: 'move'; san: string } }
		| { cacheKey: string; text: string; body: { kind: 'feedback'; code: 'ambiguous' | 'illegal' | 'failed' } };
	type TurnstileApi = {
		render: (container: HTMLElement, options: Record<string, unknown>) => string;
		reset: (widgetId?: string) => void;
	};
	type WindowWithTurnstile = Window & typeof globalThis & { turnstile?: TurnstileApi };
	type PendingPromotion = {
		request: BoardMoveRequest;
		choices: readonly PromotionPiece[];
	};
	type SpeechCorrection = {
		id: number;
		fenBefore: string;
		move: GameMove;
		secondsRemaining: number;
	};
	type MoveRow = {
		number: number;
		white?: string;
		black?: string;
	};
	type BrowserWithWebkitAudio = Window &
		typeof globalThis & {
			webkitAudioContext?: AudioContextConstructor;
		};

	const files = 'abcdefgh';
	const speechCorrectionSeconds = 5;
	const clockPresets: readonly ClockPreset[] = [
		{ id: '3+2', label: '3 + 2', initialMs: 3 * 60_000, incrementMs: 2_000 },
		{ id: '5+3', label: '5 + 3', initialMs: 5 * 60_000, incrementMs: 3_000 },
		{ id: '10+5', label: '10 + 5', initialMs: 10 * 60_000, incrementMs: 5_000 },
		{ id: '15+10', label: '15 + 10', initialMs: 15 * 60_000, incrementMs: 10_000 },
		{ id: 'none', label: 'None', initialMs: 0, incrementMs: 0 }
	];
	const promotionLabels: Record<PromotionPiece, string> = {
		q: 'Queen',
		r: 'Rook',
		b: 'Bishop',
		n: 'Knight'
	};
	const boardSquares = Array.from({ length: 64 }, (_, index) => {
		const rankIndex = Math.floor(index / 8);
		const fileIndex = index % 8;

		return {
			coordinate: files[fileIndex] + String(8 - rankIndex),
			dark: (rankIndex + fileIndex) % 2 === 1
		};
	});

	const optionBase =
		'flex-1 rounded-[3px] border px-2 py-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]';
	const optionActive = 'border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--text-strong)]';
	const optionInactive =
		'border-[var(--border-medium)] bg-transparent text-[var(--text-subtle)] hover:border-[var(--border-strong)] hover:text-[var(--text)]';

	let setupOpen = $state(true);
	let theme = $state<Theme>('dark');
	let gameStarted = $state(false);
	let blindSide = $state<BlindSide>('white');
	let clockPresetId = $state<ClockPresetId>('10+5');
	let gameSession = new GameSession();
	let gameSnapshot = $state<GameSnapshot>(gameSession.snapshot());
	let whiteTimeMs = $state(10 * 60_000);
	let blackTimeMs = $state(10 * 60_000);
	let clockLastTickAt = 0;
	let timeExpired = $state<BoardColor | null>(null);
	let listening = $state(false);
	let requestingMicrophone = $state(false);
	let processingVoice = $state(false);
	let activePress = $state<PressSource | null>(null);
	let releaseAnimation = $state(false);
	let typedMove = $state('');
	let transcript = $state('');
	let parseHint = $state('');
	let lastMoveSan = $state('');
	let pendingPromotion = $state<PendingPromotion | undefined>();
	let speechCorrection = $state<SpeechCorrection | undefined>();
	let audioContext: AudioContext | undefined;
	let speechSource: AudioBufferSourceNode | undefined;
	let speechQueue: Promise<void> = Promise.resolve();
	let announcementPending = $state(false);
	let speechGeneration = 0;
	const speechCache = new Map<string, ArrayBuffer>();
	let releaseTimer: number | undefined;
	let recordingTimer: number | undefined;
	let mediaRecorder: MediaRecorder | undefined;
	let mediaStream: MediaStream | undefined;
	let audioChunks: Blob[] = [];
	let recordingFen = '';
	let recordingCorrectionId: number | undefined;
	let voiceRequestSequence = 0;
	let correctionIdSequence = 0;
	let accessReady = $state(false);
	let accessChecking = $state(true);
	let accessMessage = $state('Checking voice access…');
	let turnstileContainer = $state<HTMLDivElement>();
	let turnstileWidgetId: string | undefined;
	let turnstileVerifying = $state(false);
	let gameId = '';
	let gameFinalized = false;
	let remainingVoiceGames = $state(3);
	let handoffConfirmed = $state(true);

	let selectedClock = $derived(
		clockPresets.find((preset) => preset.id === clockPresetId) ?? clockPresets[2]
	);
	let clockEnabled = $derived(selectedClock.id !== 'none');
	let inputColor = $derived(speechCorrection?.move.color ?? gameSnapshot.turn);
	let boardIsMasked = $derived(
		gameStarted && !setupOpen && (isBlindfolded(inputColor) || !handoffConfirmed)
	);
	let blindfoldTurn = $derived(
		gameStarted && !setupOpen && isBlindfolded(inputColor)
	);
	let gameCanAcceptInput = $derived(
		gameStarted &&
			!setupOpen &&
			handoffConfirmed &&
			timeExpired === null &&
			(speechCorrection !== undefined || gameSnapshot.status === 'active')
	);
	let boardCanAcceptMoves = $derived(gameCanAcceptInput && speechCorrection === undefined);
	let clockCanRun = $derived(gameCanAcceptInput);
	let gameIsOver = $derived(
		gameStarted &&
			!setupOpen &&
			speechCorrection === undefined &&
			(gameSnapshot.status !== 'active' || timeExpired !== null)
	);
	let positionDetailsVisible = $derived(
		gameStarted && !setupOpen && handoffConfirmed && !isBlindfolded(inputColor)
	);
	let turnLabel = $derived(
		setupOpen
			? 'Choose game settings'
			: !gameStarted
				? 'Start a game to begin'
				: timeExpired
					? playerName(opponentOf(timeExpired)) + ' wins on time'
					: speechCorrection
						? `${playerName(speechCorrection.move.color)} may correct ${speechCorrection.move.san} · ${speechCorrection.secondsRemaining}s`
					: gameSnapshot.status === 'checkmate'
						? playerName(opponentOf(gameSnapshot.turn)) + ' wins by checkmate'
						: gameSnapshot.status !== 'active'
							? terminalStatusLabel(gameSnapshot.status)
							: gameSnapshot.check
								? playerName(gameSnapshot.turn) + ' is in check'
								: playerName(gameSnapshot.turn) + ' to move'
	);
	let boardView = $derived({
		fen: gameSnapshot.fen,
		orientation: 'white' as const,
		turn: gameSnapshot.turn,
		lastMove: gameSnapshot.lastMove,
		check: gameSnapshot.check,
		legalDestinations: gameSnapshot.legalDestinations,
		inputEnabled: boardCanAcceptMoves && !boardIsMasked && !blindfoldTurn
	} satisfies BoardSeatView);
	let whiteClockActive = $derived(
		clockCanRun && clockEnabled && inputColor === 'white'
	);
	let blackClockActive = $derived(
		clockCanRun && clockEnabled && inputColor === 'black'
	);
	let whiteLowTime = $derived(whiteClockActive && whiteTimeMs <= 10_000);
	let blackLowTime = $derived(blackClockActive && blackTimeMs <= 10_000);

	function optionClass(active: boolean) {
		return optionBase + ' ' + (active ? optionActive : optionInactive);
	}

	function playerName(color: BoardColor) {
		return color === 'white' ? 'White' : 'Black';
	}

	function opponentOf(color: BoardColor): BoardColor {
		return color === 'white' ? 'black' : 'white';
	}

	function isBlindfolded(color: BoardColor) {
		return blindSide === 'both' || blindSide === color;
	}

	function toggleBlindfold(color: BoardColor) {
		if (gameStarted && !setupOpen) cancelVoiceCapture();
		if (color === 'white') {
			blindSide =
				blindSide === 'both'
					? 'black'
					: blindSide === 'white'
						? 'none'
						: blindSide === 'black'
							? 'both'
							: 'white';
			return;
		}

		blindSide =
			blindSide === 'both'
				? 'white'
				: blindSide === 'black'
					? 'none'
					: blindSide === 'white'
						? 'both'
						: 'black';
	}

	function terminalStatusLabel(status: Exclude<GameStatus, 'active'>) {
		switch (status) {
			case 'stalemate':
				return 'Draw by stalemate';
			case 'draw-insufficient-material':
				return 'Draw by insufficient material';
			case 'draw-threefold':
				return 'Draw by threefold repetition';
			case 'draw-fifty-move':
				return 'Draw by fifty-move rule';
			case 'checkmate':
				return 'Checkmate';
		}

		return 'Draw';
	}

	function resultTitle(status: GameStatus, expired: BoardColor | null) {
		if (expired) return playerName(opponentOf(expired)) + ' wins on time';
		if (status === 'checkmate') return playerName(opponentOf(gameSnapshot.turn)) + ' wins';
		if (status === 'active') return '';

		return terminalStatusLabel(status);
	}

	function resultDetail(status: GameStatus, expired: BoardColor | null) {
		if (expired) return playerName(expired) + "'s clock reached zero.";
		if (status === 'checkmate') return playerName(gameSnapshot.turn) + ' is checkmated.';
		if (status === 'active') return '';

		return 'The position is a draw.';
	}

	function positionHint(snapshot: GameSnapshot) {
		if (snapshot.status === 'checkmate') {
			return playerName(opponentOf(snapshot.turn)) + ' wins by checkmate.';
		}
		if (snapshot.status !== 'active') return terminalStatusLabel(snapshot.status) + '.';
		if (snapshot.check) return playerName(snapshot.turn) + ' is in check.';

		return playerName(snapshot.turn) + ' to move.';
	}

	function formatClock(timeMs: number) {
		if (!clockEnabled) return '—';

		const safeMs = Math.max(0, timeMs);
		if (safeMs < 10_000) {
			const seconds = Math.floor(safeMs / 1_000);
			const tenths = Math.floor((safeMs % 1_000) / 100);
			return `${seconds}.${tenths}`;
		}

		const totalSeconds = Math.ceil(safeMs / 1_000);
		const hours = Math.floor(totalSeconds / 3_600);
		const minutes = Math.floor((totalSeconds % 3_600) / 60);
		const seconds = String(totalSeconds % 60).padStart(2, '0');

		return hours > 0
			? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
			: `${minutes}:${seconds}`;
	}

	function chooseClock(preset: ClockPreset) {
		if (gameStarted && !setupOpen) return;
		clockPresetId = preset.id;
		whiteTimeMs = preset.initialMs;
		blackTimeMs = preset.initialMs;
	}

	function syncActiveClock(now = performance.now()) {
		if (!clockEnabled || !clockCanRun) {
			clockLastTickAt = now;
			return true;
		}
		if (clockLastTickAt === 0) {
			clockLastTickAt = now;
			return true;
		}

		const elapsed = Math.max(0, now - clockLastTickAt);
		clockLastTickAt = now;
		if (inputColor === 'white') {
			whiteTimeMs = Math.max(0, whiteTimeMs - elapsed);
			if (whiteTimeMs === 0) {
				endGameOnTime('white');
				return false;
			}
		} else {
			blackTimeMs = Math.max(0, blackTimeMs - elapsed);
			if (blackTimeMs === 0) {
				endGameOnTime('black');
				return false;
			}
		}

		return true;
	}

	function addClockIncrement(color: BoardColor) {
		if (!clockEnabled) return;
		if (color === 'white') whiteTimeMs += selectedClock.incrementMs;
		else blackTimeMs += selectedClock.incrementMs;
		clockLastTickAt = performance.now();
	}

	function removeClockIncrement(color: BoardColor) {
		if (!clockEnabled) return;
		if (color === 'white') whiteTimeMs = Math.max(0, whiteTimeMs - selectedClock.incrementMs);
		else blackTimeMs = Math.max(0, blackTimeMs - selectedClock.incrementMs);
		clockLastTickAt = performance.now();
	}

	function resetLocalGame() {
		cancelMoveAnnouncements();
		gameSession = new GameSession();
		gameSnapshot = gameSession.snapshot();
		whiteTimeMs = selectedClock.initialMs;
		blackTimeMs = selectedClock.initialMs;
		clockLastTickAt = performance.now();
		timeExpired = null;
		pendingPromotion = undefined;
		speechCorrection = undefined;
		lastMoveSan = '';
		handoffConfirmed = blindSide === 'none';
		gameFinalized = false;
		gameId = crypto.randomUUID();
	}

	function startGame() {
		cancelVoiceCapture();
		unlockAudioPlayback();
		resetLocalGame();
		gameStarted = true;
		setupOpen = false;
		listening = false;
		activePress = null;
		releaseAnimation = false;
		typedMove = '';
		transcript = '';
		parseHint = '';
		if (accessReady) {
			void fetch('/api/events', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: `game_started_${blindSide}` })
			});
		}
	}

	function openNewGame() {
		void finishGameQuota();
		cancelVoiceCapture();
		setupOpen = true;
		listening = false;
		activePress = null;
		releaseAnimation = false;
		typedMove = '';
		transcript = '';
		parseHint = '';
		pendingPromotion = undefined;
	}

	function confirmHandoff() {
		handoffConfirmed = true;
		clockLastTickAt = performance.now();
	}

	async function finishGameQuota() {
		if (gameFinalized || !gameId || !accessReady) return;
		gameFinalized = true;
		try {
			const response = await fetch('/api/game', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ gameId })
			});
			const payload = (await response.json()) as { remainingGames?: unknown };
			if (typeof payload.remainingGames === 'number') remainingVoiceGames = payload.remainingGames;
		} catch {
			// Quota finalization is idempotent and can safely be retried by a future request.
		}
	}

	function correctionHint() {
		if (!speechCorrection) return '';

		return `Say or type a replacement, undo, or keep ${speechCorrection.move.san}. ${speechCorrection.secondsRemaining} seconds remaining.`;
	}

	function keepSpeechMove(expired = false) {
		if (!speechCorrection) return;
		if (!syncActiveClock()) return;

		const { move } = speechCorrection;
		cancelVoiceCapture();
		speechCorrection = undefined;
		addClockIncrement(move.color);
		transcript = expired
			? `Correction time ended. Kept ${move.san}.`
			: `Kept ${move.san}.`;
		parseHint = positionHint(gameSnapshot);
		handoffConfirmed = blindSide === 'none' || gameSnapshot.status !== 'active';
		if (gameSnapshot.status !== 'active') void finishGameQuota();
	}

	function endGameOnTime(expired: BoardColor) {
		cancelVoiceCapture();
		speechCorrection = undefined;
		timeExpired = expired;
		transcript = `${playerName(expired)} ran out of time.`;
		parseHint = `${playerName(opponentOf(expired))} wins on time.`;
		handoffConfirmed = true;
		void finishGameQuota();
	}

	function playFeedbackSound(action: 'press' | 'release') {
		try {
			const context = getAudioContext();
			if (!context) return;
			void context.resume();

			const pressed = action === 'press';
			const now = context.currentTime;
			const oscillator = context.createOscillator();
			const gain = context.createGain();
			const duration = pressed ? 0.15 : 0.12;

			oscillator.type = pressed ? 'sine' : 'triangle';
			oscillator.frequency.setValueAtTime(pressed ? 520 : 420, now);
			oscillator.frequency.exponentialRampToValueAtTime(pressed ? 660 : 300, now + duration);
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(pressed ? 0.045 : 0.035, now + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

			oscillator.connect(gain);
			gain.connect(context.destination);
			oscillator.start(now);
			oscillator.stop(now + duration);
		} catch {
			// Sound feedback is optional when the browser does not support Web Audio.
		}
	}

	function getAudioContext() {
		const browserWindow = window as BrowserWithWebkitAudio;
		const AudioContextClass = browserWindow.AudioContext ?? browserWindow.webkitAudioContext;
		if (!AudioContextClass) return undefined;

		if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass();
		return audioContext;
	}

	function unlockAudioPlayback() {
		try {
			const context = getAudioContext();
			if (context?.state === 'suspended') void context.resume();
		} catch {
			// Move speech remains optional in browsers without Web Audio.
		}
	}

	function queueMoveAnnouncement(move: GameMove) {
		const text = moveAnnouncement(move);
		queueSpeech({ cacheKey: `move:${move.san}`, text, body: { kind: 'move', san: move.san } }, 'Move announcement');
	}

	function queueSpokenFeedback(code: 'ambiguous' | 'illegal' | 'failed') {
		const text = code === 'ambiguous'
			? 'Ambiguous move. Say the complete move again.'
			: code === 'illegal'
				? 'Illegal move. Say the complete move again.'
				: 'Voice input failed. Please try again.';
		queueSpeech({ cacheKey: `feedback:${code}`, text, body: { kind: 'feedback', code } }, 'Spoken feedback');
	}

	function queueSpeech(speech: SpeechRequest, errorLabel: string) {
		const generation = speechGeneration;
		announcementPending = true;

		const queued = speechQueue
			.catch(() => undefined)
			.then(async () => {
				if (generation !== speechGeneration) return;
				await speakMove(speech, generation);
			})
			.catch((error) => {
				if (generation === speechGeneration) {
					console.error(`${errorLabel} failed.`, error);
				}
			});
		speechQueue = queued;
		void queued.then(() => {
			if (generation === speechGeneration && speechQueue === queued) announcementPending = false;
		});
	}

	async function speakMove(speech: SpeechRequest, generation: number) {
		let audio = speechCache.get(speech.cacheKey);
		if (!audio) {
			if (!accessReady) return browserSpeak(speech.text, generation);
			try {
				const response = await fetch('/api/move-speech', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(speech.body)
				});
				if (!response.ok) return browserSpeak(speech.text, generation);
				audio = await response.arrayBuffer();
				speechCache.set(speech.cacheKey, audio);
			} catch {
				return browserSpeak(speech.text, generation);
			}
		}
		if (generation !== speechGeneration) return;

		const context = getAudioContext();
		if (!context) throw new Error('This browser does not support audio playback.');
		if (context.state === 'suspended') await context.resume();

		const buffer = await context.decodeAudioData(audio.slice(0));
		if (generation !== speechGeneration) return;

		await new Promise<void>((resolve) => {
			const source = context.createBufferSource();
			speechSource = source;
			source.buffer = buffer;
			source.connect(context.destination);
			source.onended = () => {
				if (speechSource === source) speechSource = undefined;
				resolve();
			};
			source.start();
		});
	}

	async function browserSpeak(text: string, generation: number) {
		if (generation !== speechGeneration || !('speechSynthesis' in window)) return;
		await new Promise<void>((resolve) => {
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = 'en-US';
			utterance.rate = 0.92;
			const englishVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang.startsWith('en'));
			if (englishVoice) utterance.voice = englishVoice;
			utterance.onend = () => resolve();
			utterance.onerror = () => resolve();
			window.speechSynthesis.speak(utterance);
		});
	}

	function cancelMoveAnnouncements() {
		speechGeneration += 1;
		announcementPending = false;
		speechSource?.stop();
		speechSource = undefined;
		speechQueue = Promise.resolve();
		if ('speechSynthesis' in window) window.speechSynthesis.cancel();
	}

	function triggerReleaseAnimation() {
		releaseAnimation = true;
		if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);

		releaseTimer = window.setTimeout(() => {
			releaseAnimation = false;
			releaseTimer = undefined;
		}, 180);
	}

	async function beginListening(source: PressSource) {
		if (
			!gameCanAcceptInput ||
			activePress ||
			requestingMicrophone ||
			processingVoice
		) {
			return;
		}
		if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);

		releaseTimer = undefined;
		releaseAnimation = false;
		activePress = source;
		requestingMicrophone = true;
		transcript = 'Requesting microphone access…';
		parseHint = 'Allow microphone access, then hold the control while you speak.';

		try {
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
				throw new Error('This browser does not support microphone recording.');
			}

			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (activePress !== source) {
				stopMediaStream(stream);
				return;
			}

			const mimeType = preferredAudioMimeType();
			const recorder = new MediaRecorder(stream, {
				...(mimeType ? { mimeType } : {}),
				audioBitsPerSecond: 64_000
			});
			let recordingFailed = false;

			mediaStream = stream;
			mediaRecorder = recorder;
			audioChunks = [];
			recordingFen = speechCorrection?.fenBefore ?? gameSnapshot.fen;
			recordingCorrectionId = speechCorrection?.id;
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) audioChunks.push(event.data);
			};
			recorder.onerror = () => {
				recordingFailed = true;
			};
			recorder.onstop = () => {
				const chunks = audioChunks;
				const recordedType = recorder.mimeType || mimeType || 'audio/webm';
				const fen = recordingFen;
				const correctionId = recordingCorrectionId;

				audioChunks = [];
				recordingCorrectionId = undefined;
				mediaRecorder = undefined;
				stopMediaStream(stream);
				mediaStream = undefined;

				if (recordingFailed) {
					voiceFailure('The recording failed. Please try again.');
					return;
				}

				void submitSpokenMove(new Blob(chunks, { type: recordedType }), fen, correctionId);
			};
			recorder.start();
			requestingMicrophone = false;
			listening = true;
			transcript = 'Listening…';
			parseHint = 'Release when you finish the complete move.';
			playFeedbackSound('press');
			recordingTimer = window.setTimeout(() => stopListening(), 15_000);
		} catch (error) {
			requestingMicrophone = false;
			activePress = null;
			voiceFailure(error instanceof Error ? error.message : 'Microphone access failed.');
		}
	}

	function stopListening(source?: PressSource) {
		if (!activePress || (source && activePress !== source)) return;

		activePress = null;
		if (requestingMicrophone) {
			requestingMicrophone = false;
			transcript = 'Microphone request canceled.';
			parseHint = 'Hold the control again when you are ready.';
			return;
		}
		if (!listening || !mediaRecorder || mediaRecorder.state !== 'recording') return;

		listening = false;
		processingVoice = true;
		transcript = 'Processing your move…';
		parseHint = 'Transcribing speech, then checking it against the legal moves.';
		clearRecordingTimer();
		mediaRecorder.stop();
		triggerReleaseAnimation();
		playFeedbackSound('release');
	}

	async function submitSpokenMove(audio: Blob, fen: string, correctionId?: number) {
		if (audio.size === 0) {
			voiceFailure('No speech was recorded. Please try again.');
			return;
		}

		const body = new FormData();
		const requestSequence = ++voiceRequestSequence;
		const extension = audioExtension(audio.type);
		body.set('audio', new File([audio], `spoken-move.${extension}`, { type: audio.type }));
		body.set('fen', fen);
		body.set('gameId', gameId);
		body.set('requestId', crypto.randomUUID());

		try {
			const response = await fetch('/api/spoken-move', { method: 'POST', body });
			const payload = (await response.json()) as SpokenMoveApiResponse;
			if (requestSequence !== voiceRequestSequence) return;

			if (!response.ok) {
				throw new Error(
					typeof payload.error === 'string'
						? payload.error
						: 'The spoken move could not be processed.'
				);
			}
			if (typeof payload.remainingGames === 'number') remainingVoiceGames = payload.remainingGames;
			const correctionRequest = correctionId !== undefined;
			if (
				correctionRequest
					? !speechCorrection || speechCorrection.id !== correctionId
					: gameSnapshot.fen !== fen
			) {
				throw new Error('The position changed while the move was processing. Please say it again.');
			}
			if (
				typeof payload.transcript !== 'string' ||
				!payload.interpretation ||
				typeof payload.interpretation.status !== 'string'
			) {
				throw new Error('The speech service returned an invalid response.');
			}

			const heard = `Heard “${payload.transcript}”`;
			if (
				payload.interpretation.status === 'ok' &&
				typeof payload.interpretation.san === 'string'
			) {
				if (!syncActiveClock()) return;
				const result = correctionRequest
					? gameSession.replaceLastNotation(payload.interpretation.san)
					: gameSession.attemptNotation(payload.interpretation.san);
				applyMoveResult(result, 'voice', fen);
				if (result.kind === 'accepted') parseHint = `${heard}. ${correctionHint()}`;
				return;
			}

			if (payload.interpretation.status === 'ambiguous' && payload.interpretation.san === null) {
				transcript = 'That could mean more than one legal move. Say the complete move again.';
				parseHint = `${heard}.${speechCorrection ? ` ${correctionHint()}` : ''}`;
				queueSpokenFeedback('ambiguous');
				return;
			}
			if (payload.interpretation.status === 'invalid' && payload.interpretation.san === null) {
				transcript = 'That does not match a legal move. Say the complete move again.';
				parseHint = `${heard}.${speechCorrection ? ` ${correctionHint()}` : ''}`;
				queueSpokenFeedback('illegal');
				return;
			}

			throw new Error('The speech service returned an invalid move result.');
		} catch (error) {
			if (requestSequence !== voiceRequestSequence) return;
			voiceFailure(error instanceof Error ? error.message : 'The spoken move could not be processed.');
		} finally {
			if (requestSequence === voiceRequestSequence) processingVoice = false;
		}
	}

	function voiceFailure(message: string) {
		listening = false;
		processingVoice = false;
		requestingMicrophone = false;
		activePress = null;
		transcript = message;
		parseHint = speechCorrection ? `The original move remains. ${correctionHint()}` : 'No move was played.';
		queueSpokenFeedback('failed');
		clearRecordingTimer();
	}

	function cancelVoiceCapture() {
		voiceRequestSequence += 1;
		clearRecordingTimer();
		activePress = null;
		listening = false;
		requestingMicrophone = false;
		processingVoice = false;

		if (mediaRecorder?.state === 'recording') {
			mediaRecorder.onstop = null;
			mediaRecorder.stop();
		}
		mediaRecorder = undefined;
		audioChunks = [];
		recordingCorrectionId = undefined;
		if (mediaStream) stopMediaStream(mediaStream);
		mediaStream = undefined;
	}

	function clearRecordingTimer() {
		if (recordingTimer === undefined) return;

		window.clearTimeout(recordingTimer);
		recordingTimer = undefined;
	}

	function stopMediaStream(stream: MediaStream) {
		for (const track of stream.getTracks()) track.stop();
	}

	function preferredAudioMimeType() {
		for (const type of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg']) {
			if (MediaRecorder.isTypeSupported(type)) return type;
		}

		return '';
	}

	function audioExtension(mimeType: string) {
		if (mimeType.includes('mp4')) return 'mp4';
		if (mimeType.includes('ogg')) return 'ogg';
		if (mimeType.includes('wav')) return 'wav';
		return 'webm';
	}

	function setTheme(nextTheme: Theme) {
		theme = nextTheme;
		document.documentElement.dataset.theme = nextTheme;
		try {
			localStorage.setItem('voice-to-chess-theme', nextTheme);
		} catch {
			// The visible theme still changes when storage is unavailable.
		}
	}

	function toggleTheme() {
		setTheme(theme === 'dark' ? 'light' : 'dark');
	}

	async function initializeVoiceAccess() {
		try {
			const response = await fetch('/api/access');
			const payload = (await response.json()) as { access?: unknown; voiceAvailable?: unknown; remainingGames?: unknown };
			accessReady = payload.access === true && payload.voiceAvailable !== false;
			if (typeof payload.remainingGames === 'number') remainingVoiceGames = payload.remainingGames;
			accessMessage = accessReady
				? 'Voice access is ready for this browser.'
				: 'Complete the privacy-friendly check to enable paid voice moves.';
		} catch {
			accessReady = false;
			accessMessage = 'Voice access is temporarily unavailable. Typed and board play still work.';
		} finally {
			accessChecking = false;
			if (!accessReady) loadTurnstile();
		}
	}

	function loadTurnstile() {
		if (!publicEnv.PUBLIC_TURNSTILE_SITE_KEY) {
			accessMessage = 'Voice verification is not configured. Typed and board play still work.';
			return;
		}
		const existing = document.querySelector<HTMLScriptElement>('script[data-voice-turnstile]');
		if (existing) {
			if ((window as WindowWithTurnstile).turnstile) renderTurnstile();
			else existing.addEventListener('load', renderTurnstile, { once: true });
			return;
		}
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		script.async = true;
		script.defer = true;
		script.dataset.voiceTurnstile = 'true';
		script.addEventListener('load', renderTurnstile, { once: true });
		document.head.append(script);
	}

	function renderTurnstile() {
		const turnstile = (window as WindowWithTurnstile).turnstile;
		if (!turnstile || !turnstileContainer || turnstileWidgetId) return;
		turnstileWidgetId = turnstile.render(turnstileContainer, {
			sitekey: publicEnv.PUBLIC_TURNSTILE_SITE_KEY,
			action: 'start-game',
			theme,
			callback: (token: string) => void exchangeTurnstileToken(token),
			'expired-callback': () => {
				accessReady = false;
				accessMessage = 'Verification expired. Please try again.';
			},
			'error-callback': () => {
				accessMessage = 'Verification failed to load. Typed and board play still work.';
			}
		});
	}

	async function exchangeTurnstileToken(token: string) {
		turnstileVerifying = true;
		accessMessage = 'Enabling voice access…';
		try {
			const response = await fetch('/api/access', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token })
			});
			const payload = (await response.json()) as { access?: unknown; remainingGames?: unknown; error?: unknown };
			if (!response.ok || payload.access !== true) throw new Error(typeof payload.error === 'string' ? payload.error : 'Verification failed.');
			accessReady = true;
			if (typeof payload.remainingGames === 'number') remainingVoiceGames = payload.remainingGames;
			accessMessage = 'Voice access is ready for this browser.';
		} catch (error) {
			accessReady = false;
			accessMessage = error instanceof Error ? error.message : 'Verification failed. Please try again.';
			(window as WindowWithTurnstile).turnstile?.reset(turnstileWidgetId);
		} finally {
			turnstileVerifying = false;
		}
	}

	function isTextEntryTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;

		return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
	}

	onMount(() => {
		theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
		void initializeVoiceAccess();
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.code !== 'Space' ||
				event.repeat ||
				setupOpen ||
				isTextEntryTarget(event.target)
			) {
				return;
			}

			event.preventDefault();
			beginListening('keyboard');
		};
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code !== 'Space' || activePress !== 'keyboard') return;

			event.preventDefault();
			stopListening('keyboard');
		};
		const cancelPress = () => stopListening();
		clockLastTickAt = performance.now();
		const clockTimer = window.setInterval(() => {
			void syncActiveClock();
		}, 100);
		const correctionTimer = window.setInterval(() => {
			if (!clockCanRun) return;

			if (
				speechCorrection &&
				!announcementPending &&
				!listening &&
				!requestingMicrophone &&
				!processingVoice
			) {
				if (speechCorrection.secondsRemaining <= 1) {
					keepSpeechMove(true);
				} else {
					speechCorrection = {
						...speechCorrection,
						secondsRemaining: speechCorrection.secondsRemaining - 1
					};
				}
			}
		}, 1000);

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', cancelPress);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', cancelPress);
			window.clearInterval(clockTimer);
			window.clearInterval(correctionTimer);
			cancelVoiceCapture();
			cancelMoveAnnouncements();
			if (releaseTimer !== undefined) window.clearTimeout(releaseTimer);
			if (audioContext && audioContext.state !== 'closed') void audioContext.close();
		};
	});

	function repeatLastMessage() {
		if (lastMoveSan) {
			transcript = 'Last accepted move: ' + lastMoveSan;
			parseHint = '';
			const lastMove = gameSnapshot.moves[gameSnapshot.moves.length - 1];
			if (lastMove) queueMoveAnnouncement(lastMove);
			return;
		}

		transcript = 'No move has been played yet.';
		parseHint = '';
	}

	function captureTypedMove(event: SubmitEvent) {
		event.preventDefault();
		const move = typedMove.trim();

		if (!gameCanAcceptInput) {
			transcript =
				setupOpen || !gameStarted ? 'Start a game before entering a move.' : 'This game is finished.';
			parseHint = '';
			return;
		}

		if (!move) {
			transcript = 'Type a SAN or coordinate move before sending it.';
			parseHint = '';
			return;
		}

		const fenBefore = speechCorrection?.fenBefore;
		if (!syncActiveClock()) return;
		const result = speechCorrection
			? gameSession.replaceLastNotation(move)
			: gameSession.attemptNotation(move);
		applyMoveResult(result, 'typed', fenBefore);
		if (result.kind !== 'rejected') typedMove = '';
	}

	function applyMoveResult(
		result: MoveAttemptResult,
		source: 'board' | 'typed' | 'voice',
		fenBefore?: string
	) {
		const previousCorrection = speechCorrection;
		gameSnapshot = result.snapshot;

		if (result.kind === 'accepted') {
			pendingPromotion = undefined;
			lastMoveSan = result.move.san;
			if (previousCorrection || source === 'voice') {
				if (previousCorrection) cancelMoveAnnouncements();
				speechCorrection = {
					id: ++correctionIdSequence,
					fenBefore: previousCorrection?.fenBefore ?? fenBefore ?? result.snapshot.fen,
					move: result.move,
					secondsRemaining: speechCorrectionSeconds
				};
				transcript = previousCorrection
					? `Replaced ${previousCorrection.move.san} with ${result.move.san}.`
					: `Played ${result.move.san}.`;
				parseHint = correctionHint();
			} else {
				addClockIncrement(result.move.color);
				transcript = 'Played ' + result.move.san + '.';
				parseHint = `${
					source === 'typed' ? 'Typed move accepted. ' : 'Board move accepted. '
				}${positionHint(result.snapshot)}`;
				handoffConfirmed = blindSide === 'none' || result.snapshot.status !== 'active';
			}
			queueMoveAnnouncement(result.move);
			if (result.snapshot.status !== 'active' && !speechCorrection) void finishGameQuota();
			return;
		}

		if (result.kind === 'promotion-required') {
			pendingPromotion = { request: result.request, choices: result.choices };
			transcript = 'Choose a piece for promotion on ' + result.request.to + '.';
			parseHint = 'The move will be committed after you choose a promotion piece.';
			return;
		}

		pendingPromotion = undefined;
		transcript = result.message;
		parseHint = speechCorrection
			? `The original move remains. ${correctionHint()}`
			: positionHint(result.snapshot);
		queueSpokenFeedback('illegal');
	}

	function captureBoardMove(request: BoardMoveRequest) {
		if (!boardCanAcceptMoves) return;
		if (!syncActiveClock()) return;
		applyMoveResult(gameSession.attemptBoardMove(request), 'board');
	}

	function choosePromotion(promotion: PromotionPiece) {
		if (!pendingPromotion || !boardCanAcceptMoves) return;
		if (!syncActiveClock()) return;

		const request = { ...pendingPromotion.request, promotion };
		applyMoveResult(gameSession.attemptBoardMove(request), 'board');
	}

	function undoLastMove() {
		if (!gameStarted || setupOpen || timeExpired) return;
		if (!syncActiveClock()) return;

		const wasCorrection = speechCorrection !== undefined;
		cancelVoiceCapture();
		if (wasCorrection) cancelMoveAnnouncements();
		const result = gameSession.undo();
		gameSnapshot = result.snapshot;
		pendingPromotion = undefined;
		speechCorrection = undefined;

		if (result.kind === 'nothing-to-undo') {
			transcript = 'There is no move to undo.';
			parseHint = '';
			return;
		}

		const remainingMoves = result.snapshot.moves;
		if (!wasCorrection) removeClockIncrement(result.move.color);
		else clockLastTickAt = performance.now();
		lastMoveSan = remainingMoves.length > 0 ? remainingMoves[remainingMoves.length - 1].san : '';
		transcript = wasCorrection
			? `Undid ${result.move.san}. Enter the correct move.`
			: 'Undid ' + result.move.san + '.';
		parseHint = positionHint(result.snapshot);
	}

	function moveRows(moves: readonly GameMove[]): MoveRow[] {
		const rows: MoveRow[] = [];

		for (let index = 0; index < moves.length; index += 2) {
			rows.push({
				number: index / 2 + 1,
				white: moves[index]?.san,
				black: moves[index + 1]?.san
			});
		}

		return rows;
	}
</script>

<svelte:head>
	<title>Voice to Chess | Play chess blindfolded with your friends</title>
	<meta name="theme-color" content={theme === 'dark' ? '#100e0c' : '#f1eadf'} />
</svelte:head>

<main id="top" class="app-shell relative min-h-screen overflow-hidden text-[var(--text)]">
	<header class="shadow-nav sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--nav-bg)] backdrop-blur-xl">
		<nav
			class="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-4 px-4 py-3.5 sm:px-8"
			aria-label="Primary"
		>
			<a href="/board" class="group flex items-center gap-3 outline-none">
				<img
					src="/brand/logo-options/01-ribbon-wrap.svg"
					alt=""
					class="size-12 rounded-[14px] shadow-sm transition-transform group-hover:-translate-y-px group-focus-visible:-translate-y-px"
				/>
				<span class="flex flex-col">
					<span class="whitespace-nowrap font-display text-[23px] leading-none tracking-[0.01em]">Voice to Chess</span>
					<span class="mt-0.5 hidden text-[10px] text-[var(--text-faint)] sm:block">Play chess blindfolded</span>
				</span>
			</a>

			<div class="flex items-center gap-4 sm:gap-6">
				<a
					href="#how-to-play"
					class="hidden text-[12px] text-[var(--text-subtle)] underline-offset-4 transition-colors hover:text-[var(--text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent-hover)] sm:inline-block"
					>How to play</a
				>
				<button
					type="button"
					class="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--border)] text-[var(--text-subtle)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
					aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
					title={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
					onclick={toggleTheme}
				>
					{#if theme === 'dark'}
						<svg viewBox="0 0 24 24" class="size-[17px]" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
							<circle cx="12" cy="12" r="3.5"></circle>
							<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"></path>
						</svg>
					{:else}
						<svg viewBox="0 0 24 24" class="size-[17px]" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
							<path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z"></path>
						</svg>
					{/if}
				</button>
				{#if gameStarted && !setupOpen}
					<button
						type="button"
						class="whitespace-nowrap rounded-[3px] border border-[var(--border-strong)] px-3 py-2 text-[12px] text-[var(--accent)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
						onclick={openNewGame}>New game</button
					>
				{/if}
			</div>
		</nav>
	</header>

	<div class="relative z-10 mx-auto flex w-full max-w-[1040px] flex-col gap-[22px] px-4 pt-8 pb-10 sm:px-8 sm:pt-10">

		<div class="flex flex-wrap items-start gap-7">
			<section class="min-w-0 flex-1 basis-[420px]">
				<div class="flex flex-col gap-3.5">
					{#if gameStarted && !setupOpen}
					<div class="flex items-center gap-2.5">
						<div class="flex items-center gap-2.5">
							<span
								class="size-2.5 rounded-full bg-[var(--text)]"
								aria-hidden="true"
							></span>
						<p class="text-[15px] tracking-[0.01em]">
							{positionDetailsVisible ? turnLabel : `${playerName(inputColor)} to move · blindfolded`}
						</p>
						</div>
					</div>
					{/if}

					<div
						class="flex items-center justify-between border-y px-1 py-3 transition-colors"
						class:border-[var(--border-strong)]={blackClockActive && !blackLowTime}
						class:border-[var(--danger-border)]={blackLowTime}
						class:bg-[var(--surface-clock)]={blackClockActive && !blackLowTime}
						class:bg-[var(--surface-danger)]={blackLowTime}
						class:border-[var(--border-faint)]={!blackClockActive}
						class:bg-[var(--surface-low)]={!blackClockActive}
						role="timer"
						aria-label={`Black clock, ${formatClock(blackTimeMs)}`}
					>
						<div>
							<p class="font-mono text-[10px] tracking-[0.16em] text-[var(--text-subtle)]">BLACK</p>
							<p class="mt-0.5 font-mono text-[10px] tracking-[0.1em] text-[var(--text-faint)]">
								{selectedClock.incrementMs > 0
									? `+${selectedClock.incrementMs / 1_000} SEC`
									: clockEnabled
										? 'NO INCREMENT'
										: 'NO CLOCK'}
							</p>
						</div>
						<p
							class="font-mono text-[34px] font-semibold leading-none tabular-nums"
							class:text-[var(--danger)]={blackLowTime}
						>
							{formatClock(blackTimeMs)}
						</p>
					</div>

					<div class="shadow-board-frame relative aspect-square w-full overflow-hidden rounded border border-[var(--border)]">
						{#if boardIsMasked}
							<div class="grid size-full grid-cols-8">
								{#each boardSquares as square}
									<div
										class:!bg-[var(--board-hidden-dark)]={square.dark}
										class:bg-[var(--surface-raised)]={square.dark === false}
										class="relative grid place-items-center"
									>
										<span class="font-mono text-[11px] tracking-[0.04em] text-[var(--board-hidden-text)]">
											{square.coordinate}
										</span>
									</div>
								{/each}
							</div>
						{:else}
							<div class="size-full">
								<ChessgroundBoard view={boardView} onMove={captureBoardMove} />
							</div>
						{/if}
						{#if gameStarted && !setupOpen && !handoffConfirmed}
							<div class="absolute inset-0 grid place-items-center bg-[rgba(16,14,12,.78)] p-6 backdrop-blur-[3px]">
								<div class="max-w-64 text-center">
									<p class="font-display text-[26px] text-[var(--text-strong)]">Pass the device</p>
									<p class="mt-2 text-[13px] leading-5 text-[var(--text-muted)]">
										{playerName(inputColor)} is next. The position stays hidden until they are ready.
									</p>
									<button
										type="button"
										class="shadow-primary mt-5 rounded-[3px] bg-[var(--accent)] px-4 py-2.5 text-[13px] font-semibold text-[var(--accent-text)]"
										onclick={confirmHandoff}>Ready for {playerName(inputColor)}</button
									>
								</div>
							</div>
						{/if}
					</div>

					<div
						class="flex items-center justify-between border-y px-1 py-3 transition-colors"
						class:border-[var(--border-strong)]={whiteClockActive && !whiteLowTime}
						class:border-[var(--danger-border)]={whiteLowTime}
						class:bg-[var(--surface-clock)]={whiteClockActive && !whiteLowTime}
						class:bg-[var(--surface-danger)]={whiteLowTime}
						class:border-[var(--border-faint)]={!whiteClockActive}
						class:bg-[var(--surface-low)]={!whiteClockActive}
						role="timer"
						aria-label={`White clock, ${formatClock(whiteTimeMs)}`}
					>
						<div>
							<p class="font-mono text-[10px] tracking-[0.16em] text-[var(--text-subtle)]">WHITE</p>
							<p class="mt-0.5 font-mono text-[10px] tracking-[0.1em] text-[var(--text-faint)]">
								{selectedClock.incrementMs > 0
									? `+${selectedClock.incrementMs / 1_000} SEC`
									: clockEnabled
										? 'NO INCREMENT'
										: 'NO CLOCK'}
							</p>
						</div>
						<p
							class="font-mono text-[34px] font-semibold leading-none tabular-nums"
							class:text-[var(--danger)]={whiteLowTime}
						>
							{formatClock(whiteTimeMs)}
						</p>
					</div>
				</div>
			</section>

			<aside
				class="w-full min-w-0 flex-1 basis-[280px] md:order-none md:max-w-[330px]"
				class:order-first={!gameStarted || setupOpen}
			>
				<div class="flex flex-col gap-3.5">
					{#if !gameStarted || setupOpen}
					<section
						class="shadow-panel flex flex-col gap-5 bg-[var(--surface)] p-5"
						aria-label="Game settings"
					>
						<fieldset class="flex flex-col gap-2.5">
							<legend class="text-[12px] font-medium text-[var(--text-muted)]">
								Blindfolded player(s)
							</legend>
							<div class="grid grid-cols-2 gap-2" aria-label="Blindfolded players">
								<button
									type="button"
									class={optionClass(isBlindfolded('white'))}
									aria-pressed={isBlindfolded('white')}
									onclick={() => toggleBlindfold('white')}>White</button
								>
								<button
									type="button"
									class={optionClass(isBlindfolded('black'))}
									aria-pressed={isBlindfolded('black')}
									onclick={() => toggleBlindfold('black')}>Black</button
								>
							</div>
						</fieldset>

						<fieldset class="flex flex-col gap-2.5">
							<legend class="text-[12px] font-medium text-[var(--text-muted)]">Clock</legend>
							<div class="grid grid-cols-3 gap-1.5">
								{#each clockPresets as preset}
									<button
										type="button"
										class="whitespace-nowrap rounded-[3px] border px-0.5 py-2 text-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55 sm:text-[11px]"
										class:border-[var(--border-active)]={clockPresetId === preset.id}
										class:bg-[var(--surface-active)]={clockPresetId === preset.id}
										class:text-[var(--text-strong)]={clockPresetId === preset.id}
										class:border-[var(--border-medium)]={clockPresetId !== preset.id}
										class:bg-transparent={clockPresetId !== preset.id}
										class:text-[var(--text-muted)]={clockPresetId !== preset.id}
										disabled={gameStarted && !setupOpen}
										aria-pressed={clockPresetId === preset.id}
										onclick={() => chooseClock(preset)}
									>
										{preset.label}
									</button>
								{/each}
							</div>
							<p class="text-[11px] text-[var(--text-faint)]">
								Minutes plus increment in seconds
							</p>
						</fieldset>

						<div class="border-t border-[var(--border-faint)] pt-4">
							<p class="text-[12px] font-medium text-[var(--text-muted)]">Voice access</p>
							<p class="mt-1 text-[11px] leading-5 text-[var(--text-faint)]">{accessMessage}</p>
							{#if !accessReady}
								<div class="mt-3 min-h-[65px]" bind:this={turnstileContainer}></div>
							{/if}
							<p class="mt-2 text-[10px] leading-4 text-[var(--text-faint)]">
								Audio is sent to OpenAI only after you release the button. It is not stored by this app.
							</p>
							<p class="mt-2 text-[10px] leading-4 text-[var(--text-faint)]">
								Voice recognition is experimental. Check the interpreted move before play continues.
							</p>
						</div>

						<button
							type="button"
							class="shadow-primary rounded-[3px] bg-[var(--accent)] px-3 py-3 text-[14px] font-semibold tracking-[0.01em] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
							disabled={accessChecking || turnstileVerifying}
							onclick={startGame}>Start game</button
						>
					</section>
					{:else}
					<section class="flex flex-col gap-4 border-y border-[var(--border-medium)] py-5">
						<div class="flex items-start justify-between gap-4">
							<div>
								<h2 class="text-[15px] font-medium text-[var(--text)]">Voice input</h2>
								<p class="mt-0.5 text-[12px] text-[var(--text-subtle)]">
									{listening
										? 'Listening now'
										: requestingMicrophone
											? 'Opening the microphone'
										: processingVoice
											? 'Checking the move'
											: accessReady
												? 'Ready for a complete move'
												: 'Voice unavailable — typed play still works'}
								</p>
							</div>
							<button
								type="button"
								class="px-1 py-0.5 text-[12px] text-[var(--text-subtle)] underline-offset-4 transition-colors hover:text-[var(--text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
								onclick={repeatLastMessage}>Repeat last</button
							>
						</div>

						<button
							type="button"
							class="shadow-primary flex min-h-[96px] touch-none select-none items-center gap-4 rounded-[4px] bg-[var(--accent)] px-5 py-4 text-left text-[var(--accent-text)] transition-[background-color,transform,opacity] duration-150 hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:animate-none"
							class:animate-[pulse-ring_1.4s_ease-out_infinite]={listening}
							class:animate-voice-press={listening}
							class:animate-voice-release={releaseAnimation}
							aria-keyshortcuts="Space"
							disabled={requestingMicrophone || processingVoice || !gameCanAcceptInput || !accessReady}
							onpointerdown={() => beginListening('pointer')}
							onpointerup={() => stopListening('pointer')}
							onpointerleave={() => stopListening('pointer')}
							onpointercancel={() => stopListening('pointer')}
							oncontextmenu={(event) => event.preventDefault()}
						>
							<span
								class="grid size-12 shrink-0 place-items-center rounded-full bg-[var(--accent-text)] text-[var(--accent-hover)] motion-reduce:animate-none"
								class:animate-voice-level={listening}
								aria-hidden="true"
							>
								<svg viewBox="0 0 24 24" class="size-6" fill="none" stroke="currentColor" stroke-width="1.8">
									<rect x="9" y="3" width="6" height="11" rx="3"></rect>
									<path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6"></path>
								</svg>
							</span>
							<span class="flex flex-col">
								<span class="text-[17px] font-semibold">
									{listening
										? 'Listening…'
										: requestingMicrophone
											? 'Opening microphone…'
											: processingVoice
												? 'Processing move…'
												: 'Hold to speak'}
								</span>
								<span class="mt-0.5 text-[12px] opacity-70">
									{listening ? 'Release to send' : 'You can also hold Space'}
								</span>
							</span>
						</button>

						<div class="min-h-[68px]" aria-live="polite">
							<p
								class="text-[15px] leading-[1.5] text-pretty"
								class:text-[var(--text)]={transcript !== ''}
								class:text-[var(--text-faint)]={transcript === ''}
							>
								{positionDetailsVisible
									? transcript || 'Your transcript and move result will appear here.'
									: 'Position details are hidden for the blindfolded player.'}
							</p>
							{#if parseHint && positionDetailsVisible}
								<p class="mt-1.5 text-[12px] leading-[1.45] text-[var(--accent)]">
									{parseHint}
								</p>
							{/if}
						</div>

						<form class="border-t border-[var(--border-faint)] pt-4" onsubmit={captureTypedMove}>
							<label class="mb-2 block text-[12px] text-[var(--text-subtle)]" for="typed-move">Or type a move</label>
							<div class="flex gap-2">
								<input
									id="typed-move"
									bind:value={typedMove}
									class="shadow-field min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--field)] px-3 py-2.5 font-mono text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
									placeholder={speechCorrection
										? `Replace ${speechCorrection.move.san}: SAN or UCI`
										: 'Nf3 or e2e4'}
									autocomplete="off"
								/>
								<button
									type="submit"
									class="rounded bg-[var(--border)] px-3.5 text-[13px] text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
									aria-label="Play typed move"
									>Play</button
								>
							</div>
						</form>
					</section>

					{#if lastMoveSan && positionDetailsVisible}
						<section
							class="flex items-center justify-between gap-3 border-b border-[var(--border-faint)] px-1 pb-3.5"
							aria-live="polite"
						>
							<div>
								<p class="text-[13px] text-[var(--text-muted)]">
									Last move <span class="font-mono text-[var(--text)]">{lastMoveSan}</span>
								</p>
								{#if speechCorrection}
									<p class="mt-0.5 font-mono text-[10px] text-[var(--accent)]">
										CORRECT FOR {speechCorrection.secondsRemaining}s
									</p>
								{/if}
							</div>
							<div class="flex shrink-0 gap-2">
								{#if speechCorrection}
									<button
										type="button"
										class="rounded border border-[var(--border-strong)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
										onclick={() => keepSpeechMove()}>Keep</button
									>
								{/if}
								<button
									type="button"
									class="rounded border border-[var(--border-strong)] bg-transparent px-3 py-1.5 text-[12px] text-[var(--accent-soft)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
									onclick={undoLastMove}>Undo</button
								>
							</div>
						</section>
					{/if}
					{#if speechCorrection && !positionDetailsVisible}
						<section class="flex items-center justify-between gap-3 border-b border-[var(--border-faint)] px-1 pb-3.5">
							<p class="text-[12px] text-[var(--text-muted)]">Correction window · {speechCorrection.secondsRemaining}s</p>
							<div class="flex gap-2">
								<button type="button" class="rounded border border-[var(--border-strong)] px-3 py-1.5 text-[12px]" onclick={() => keepSpeechMove()}>Keep</button>
								<button type="button" class="rounded border border-[var(--border-strong)] px-3 py-1.5 text-[12px] text-[var(--accent-soft)]" onclick={undoLastMove}>Undo</button>
							</div>
						</section>
					{/if}

					{#if positionDetailsVisible}
					<section class="flex flex-col gap-2.5 border-t border-[var(--border-faint)] px-1 pt-4">
						<p class="text-[12px] font-medium text-[var(--text-subtle)]">Moves</p>
						<div class="max-h-44 min-h-[72px] overflow-y-auto font-mono text-[13px]">
							{#if gameSnapshot.moves.length > 0}
								<div class="grid grid-cols-[2.5rem_1fr_1fr] gap-x-2 gap-y-1.5 text-[var(--text)]">
									{#each moveRows(gameSnapshot.moves) as row}
										<span class="text-[var(--text-faint)]">{row.number}.</span>
										<span>{row.white}</span>
										<span class="text-[var(--text-muted)]">{row.black ?? ''}</span>
									{/each}
								</div>
							{:else}
								<p class="font-sans text-[12px] text-[var(--text-faint)]">No moves yet.</p>
							{/if}
						</div>
					</section>
					{:else}
						<p class="border-t border-[var(--border-faint)] px-1 pt-4 text-[12px] text-[var(--text-faint)]">Move history hidden during blindfolded play.</p>
					{/if}
					{/if}
				</div>
			</aside>
		</div>

		<footer id="how-to-play" class="mt-10 border-t border-[var(--border)] pt-8 sm:mt-14 sm:pt-10">
			<div class="grid gap-8 sm:grid-cols-[0.8fr_1.2fr] sm:gap-16">
				<div>
					<div class="flex items-center gap-2.5">
						<img src="/brand/logo-options/01-ribbon-wrap.svg" alt="" class="size-8 rounded-[10px] shadow-sm" />
						<p class="font-display text-[22px] text-[var(--text)]">Voice to Chess</p>
					</div>
					<p class="mt-2 max-w-[18rem] text-[13px] leading-6 text-[var(--text-subtle)]">
						A local chess board for sighted and blindfolded play.
					</p>
				</div>
				<div>
					<h2 class="text-[13px] font-medium text-[var(--text-muted)]">How to play</h2>
					<p class="mt-2 max-w-[34rem] text-[13px] leading-6 text-[var(--text-subtle)]">
						Choose the blindfolded player or players and a time control. Hold the voice button, say one complete move, then release it. Sighted players use the board.
					</p>
					<p class="mt-3 text-[12px] leading-5 text-[var(--text-faint)]">
						The microphone starts only while you hold the voice button.
					</p>
				</div>
			</div>
			<div class="mt-8 flex items-center justify-between gap-4 border-t border-[var(--border-faint)] py-5 text-[11px] text-[var(--text-faint)]">
				<span>Local two-player game · Voice is AI-generated</span>
				<div class="flex gap-4">
					<a href="/privacy" class="underline-offset-4 hover:underline">Privacy</a>
					<a href="/about" class="underline-offset-4 hover:underline">License &amp; source</a>
					<a href="#top" class="underline-offset-4 hover:underline">Back to top</a>
				</div>
			</div>
		</footer>
	</div>

	{#if pendingPromotion}
		<div
			class="fixed inset-0 z-30 grid place-items-center bg-[rgba(10,9,8,.82)] p-6 backdrop-blur-[4px]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="promotion-title"
		>
			<section class="shadow-dialog w-full max-w-[360px] rounded-[5px] border border-[var(--border-medium)] bg-[var(--surface)] p-6">
				<p class="font-mono text-[10px] tracking-[0.18em] text-[var(--text-subtle)]">PROMOTION</p>
				<h2 id="promotion-title" class="mt-2 font-display text-[28px] leading-none">
					Choose a piece
				</h2>
				<p class="mt-2 text-[14px] leading-[1.5] text-[var(--text-subtle)]">
					Promote the pawn on {pendingPromotion.request.to} to finish the move.
				</p>
				<div class="mt-5 grid grid-cols-2 gap-2">
					{#each pendingPromotion.choices as promotion}
						<button
							type="button"
							class="rounded border border-[var(--border-medium)] bg-[var(--surface-raised)] px-3 py-3 text-left text-[14px] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
							onclick={() => choosePromotion(promotion)}
						>
							{promotionLabels[promotion]}
						</button>
					{/each}
				</div>
			</section>
		</div>
	{/if}

	{#if gameIsOver}
		<div
			class="fixed inset-0 z-20 grid place-items-center bg-[rgba(10,9,8,.76)] p-6 backdrop-blur-[3px]"
			role="dialog"
			aria-modal="true"
			aria-labelledby="result-title"
		>
			<section class="shadow-dialog flex w-full max-w-[360px] flex-col items-start rounded-[5px] border border-[var(--border-medium)] bg-[var(--surface)] p-6">
				<p class="font-mono text-[10px] tracking-[0.18em] text-[var(--accent)]">GAME OVER</p>
				<h2 id="result-title" class="mt-2 font-display text-[30px] leading-none">
					{resultTitle(gameSnapshot.status, timeExpired)}
				</h2>
				<p class="mt-2 text-[14px] leading-[1.5] text-[var(--text-subtle)]">
					{resultDetail(gameSnapshot.status, timeExpired)}
				</p>
				<p class="mt-3 text-[12px] text-[var(--accent)]">{remainingVoiceGames} of 3 voice games remaining today.</p>
				<button
					type="button"
					class="shadow-primary mt-6 rounded-[3px] bg-[var(--accent)] px-4 py-3 text-[14px] font-semibold text-[var(--accent-text)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-hover)]"
					onclick={openNewGame}>Play again</button
				>
			</section>
		</div>
	{/if}

</main>
