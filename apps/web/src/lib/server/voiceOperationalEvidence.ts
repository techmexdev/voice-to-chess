import type { VoiceTurnFailure, VoiceTurnOutcome } from '../game/VoiceTurn.ts';
import type { InterpreterPolicy } from './interpreterPolicy.ts';
import type { InterpreterAuthority } from './moveInterpreter.ts';
import type {
	VoiceTelemetryEvent,
	VoiceTelemetryPhase,
	VoiceTelemetryStatus
} from './voiceTelemetry.ts';

export const VOICE_OPERATIONAL_EVIDENCE_SCHEMA = 'voice-operational-evidence/v1' as const;
export const VOICE_OPERATIONAL_EVIDENCE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

type RedisCommand = <T>(command: readonly (string | number)[]) => Promise<T>;

export type VoiceOperationalEvidenceInput = Readonly<{
	voiceTurnId: string;
	policy: InterpreterPolicy;
	outcome: VoiceTurnOutcome;
	phaseSummary: readonly VoiceTelemetryEvent[];
}>;

/**
 * A short-lived release-observability record. It intentionally cannot contain
 * player content, chess state, compact model output, or a durable visitor ID.
 */
export type StoredVoiceOperationalEvidence = Readonly<{
	schema: typeof VOICE_OPERATIONAL_EVIDENCE_SCHEMA;
	voiceTurnId: string;
	recordedAt: string;
	expiresAt: string;
	policy: Readonly<{
		version: string;
		authority: InterpreterAuthority;
		releaseId: string;
		releaseIdentity: string;
		shadow: Readonly<{
			authority: InterpreterAuthority;
			releaseId: string;
			releaseIdentity: string;
		}> | null;
	}>;
	outcome: Readonly<{
		class: VoiceTurnOutcome['kind'];
		failure?: VoiceTurnFailure;
	}>;
	phaseSummary: readonly VoiceTelemetryEvent[];
}>;

export type VoiceOperationalEvidenceStore = Readonly<{
	save(input: VoiceOperationalEvidenceInput): Promise<boolean>;
}>;

export type VoiceOperationalEvidenceStoreOptions = Readonly<{
	command?: RedisCommand;
	now?: () => Date;
	retentionSeconds?: number;
}>;

export function createVoiceOperationalEvidenceStore(
	options: VoiceOperationalEvidenceStoreOptions = {}
): VoiceOperationalEvidenceStore {
	const command = options.command ?? unavailableRedis;
	const now = options.now ?? (() => new Date());
	const retentionSeconds = validRetention(options.retentionSeconds)
		? options.retentionSeconds
		: VOICE_OPERATIONAL_EVIDENCE_RETENTION_SECONDS;

	return Object.freeze({
		async save(input: VoiceOperationalEvidenceInput): Promise<boolean> {
			let record: StoredVoiceOperationalEvidence;
			try {
				record = storedEvidence(input, now(), retentionSeconds);
			} catch {
				return false;
			}

			try {
				const result = await command<string | null>([
					'SET',
					evidenceKey(record.voiceTurnId),
					JSON.stringify(record),
					'EX',
					retentionSeconds,
					'NX'
				]);
				return result === 'OK';
			} catch {
				// Evidence is best-effort and never changes a player-facing turn.
				return false;
			}
		}
	});
}

/** Server route helper for content-free Voice Turn release evidence. */
export async function saveVoiceOperationalEvidence(
	input: VoiceOperationalEvidenceInput,
	command: RedisCommand
): Promise<boolean> {
	return createVoiceOperationalEvidenceStore({ command }).save(input);
}

function storedEvidence(
	input: VoiceOperationalEvidenceInput,
	recordedAt: Date,
	retentionSeconds: number
): StoredVoiceOperationalEvidence {
	if (!isOpaqueId(input.voiceTurnId)) throw new Error('invalid voice turn ID');
	if (!isPolicyVersion(input.policy.version)) throw new Error('invalid policy version');
	if (!validRetention(retentionSeconds)) throw new Error('invalid retention');
	const expiresAt = new Date(recordedAt.getTime() + retentionSeconds * 1_000);
	return Object.freeze({
		schema: VOICE_OPERATIONAL_EVIDENCE_SCHEMA,
		voiceTurnId: input.voiceTurnId,
		recordedAt: recordedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		policy: policyEvidence(input.policy),
		outcome: outcomeEvidence(input.outcome),
		phaseSummary: Object.freeze(input.phaseSummary.slice(0, 24).map(safeTelemetryEvent))
	});
}

function policyEvidence(policy: InterpreterPolicy): StoredVoiceOperationalEvidence['policy'] {
	const authoritative = policy.authoritative;
	if (!isInterpreterAuthority(authoritative.authority) || !isIdentifier(authoritative.release.releaseId) || !isIdentifier(authoritative.release.identity)) {
		throw new Error('invalid authoritative release');
	}
	const shadow = policy.shadow;
	if (shadow !== null && (
		!isInterpreterAuthority(shadow.authority) ||
		!isIdentifier(shadow.release.releaseId) ||
		!isIdentifier(shadow.release.identity)
	)) {
		throw new Error('invalid shadow release');
	}
	return Object.freeze({
		version: policy.version,
		authority: authoritative.authority,
		releaseId: authoritative.release.releaseId,
		releaseIdentity: authoritative.release.identity,
		shadow: shadow === null ? null : Object.freeze({
			authority: shadow.authority,
			releaseId: shadow.release.releaseId,
			releaseIdentity: shadow.release.identity
		})
	});
}

function outcomeEvidence(outcome: VoiceTurnOutcome): StoredVoiceOperationalEvidence['outcome'] {
	return Object.freeze({
		class: outcome.kind,
		...(outcome.kind === 'failure' ? { failure: outcome.failure } : {})
	});
}

function safeTelemetryEvent(event: VoiceTelemetryEvent): VoiceTelemetryEvent {
	if (!isPhase(event.phase) || !isStatus(event.status)) throw new Error('invalid telemetry event');
	if (event.authority !== undefined && !isInterpreterAuthority(event.authority)) {
		throw new Error('invalid telemetry authority');
	}
	if (event.shadow !== undefined && typeof event.shadow !== 'boolean') {
		throw new Error('invalid telemetry shadow flag');
	}
	if (event.elapsedMs !== undefined && (!Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0 || event.elapsedMs > 60_000)) {
		throw new Error('invalid telemetry duration');
	}
	return Object.freeze({
		phase: event.phase,
		status: event.status,
		...(event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs }),
		...(event.authority === undefined ? {} : { authority: event.authority }),
		...(event.shadow === undefined ? {} : { shadow: event.shadow })
	});
}

function evidenceKey(voiceTurnId: string): string {
	return `voice-operational:v1:${voiceTurnId}`;
}

function isOpaqueId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function isPolicyVersion(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
}

function isInterpreterAuthority(value: unknown): value is InterpreterAuthority {
	return value === 'hosted' || value === 'slm';
}

function isPhase(value: unknown): value is VoiceTelemetryPhase {
	return value === 'transcription' || value === 'interpretation' || value === 'resolver' ||
		value === 'feedback' || value === 'quota' || value === 'shadow';
}

function isStatus(value: unknown): value is VoiceTelemetryStatus {
	return value === 'ok' || value === 'allowed' || value === 'rejected' ||
		value === 'unavailable' || value === 'scheduled' || value === 'shed' ||
		value === 'resolved' || value === 'unknown' || value === 'ambiguous' ||
		value === 'illegal' || value === 'adapter' || value === 'provider' ||
		value === 'timeout' || value === 'quota' || value === 'internal';
}

function validRetention(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) &&
		value >= 60 && value <= VOICE_OPERATIONAL_EVIDENCE_RETENTION_SECONDS;
}

async function unavailableRedis<T>(): Promise<T> {
	throw new Error('Redis is unavailable.');
}
