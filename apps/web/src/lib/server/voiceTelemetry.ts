import type { VoiceTurnFailure, VoiceTurnOutcome } from '../game/VoiceTurn.ts';
import type { InterpreterAuthority } from './moveInterpreter.ts';

/**
 * Bounded operational evidence for a Voice Turn. This deliberately has no
 * field that can carry an audio sample, transcript, compact output, resolver
 * context, FEN, or move history.
 */
export type VoiceTelemetryPhase =
	| 'transcription'
	| 'interpretation'
	| 'resolver'
	| 'feedback'
	| 'quota'
	| 'shadow';

export type VoiceTelemetryStatus =
	| 'ok'
	| 'allowed'
	| 'rejected'
	| 'unavailable'
	| 'scheduled'
	| 'shed'
	| 'resolved'
	| 'unknown'
	| 'ambiguous'
	| 'illegal'
	| VoiceTurnFailure;

export type VoiceTelemetryEvent = Readonly<{
	phase: VoiceTelemetryPhase;
	status: VoiceTelemetryStatus;
	elapsedMs?: number;
	authority?: InterpreterAuthority;
	shadow?: boolean;
}>;

export type VoiceMetricRecorder = (name: string, increment?: number) => void | Promise<void>;

/** An observer is always best-effort and is never awaited by a player turn. */
export interface VoiceTelemetry {
	record(event: VoiceTelemetryEvent): void;
	/** A bounded, content-free copy for the current Voice Turn's evidence. */
	snapshot(): readonly VoiceTelemetryEvent[];
}

export function createVoiceTelemetry(
	recorder: VoiceMetricRecorder = () => {}
): VoiceTelemetry {
	const events: VoiceTelemetryEvent[] = [];
	return Object.freeze({
		record(event: VoiceTelemetryEvent): void {
			const safeEvent = boundedEvent(event);
			if (events.length === 24) events.shift();
			events.push(safeEvent);
			const metricBase = metricBaseFor(safeEvent);
			recordSafely(recorder, `${metricBase}_count`);
			recordSafely(recorder, `${metricBase}_${safeEvent.status}`);
			if (safeEvent.elapsedMs !== undefined) {
				recordSafely(recorder, `${metricBase}_latency_ms_sum`, safeEvent.elapsedMs);
			}
		},
		snapshot(): readonly VoiceTelemetryEvent[] {
			return Object.freeze(events.map((event) => Object.freeze({ ...event })));
		}
	});
}

export function telemetryStatusForOutcome(outcome: VoiceTurnOutcome): VoiceTelemetryStatus {
	return outcome.kind === 'failure' ? outcome.failure : outcome.kind;
}

function metricBaseFor(event: VoiceTelemetryEvent): string {
	if (event.phase === 'quota') return 'voice_quota';
	if (event.phase === 'feedback') return 'voice_feedback';
	if (event.phase === 'shadow') return 'voice_shadow';

	const lane = event.shadow ? 'shadow' : event.authority ?? 'gateway';
	return `voice_${lane}_${event.phase}`;
}

function boundedMilliseconds(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(60_000, Math.round(value)));
}

function boundedEvent(event: VoiceTelemetryEvent): VoiceTelemetryEvent {
	return Object.freeze({
		phase: event.phase,
		status: event.status,
		...(event.elapsedMs === undefined ? {} : { elapsedMs: boundedMilliseconds(event.elapsedMs) }),
		...(event.authority === undefined ? {} : { authority: event.authority }),
		...(event.shadow === undefined ? {} : { shadow: event.shadow })
	});
}

function recordSafely(recorder: VoiceMetricRecorder, name: string, increment = 1): void {
	try {
		const recorded = recorder(name, increment);
		if (recorded && typeof (recorded as Promise<void>).catch === 'function') {
			void (recorded as Promise<void>).catch(() => {
				// Operational metrics cannot affect the player result.
			});
		}
	} catch {
		// Operational metrics cannot affect the player result.
	}
}
