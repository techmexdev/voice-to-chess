import { loadVoiceTurnOutcome } from '../game/VoiceTurn.ts';
import type { ConsentedShadowEvidence, InterpreterOutcomeEvidence } from './voiceTurn.ts';

export const CONSENTED_SHADOW_EVIDENCE_SCHEMA = 'consented-shadow-evidence/v1' as const;
export const CONSENTED_SHADOW_EVIDENCE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

type RedisCommand = <T>(command: readonly (string | number)[]) => Promise<T>;

export type StoredConsentedShadowEvidence = Readonly<{
	schema: typeof CONSENTED_SHADOW_EVIDENCE_SCHEMA;
	evidenceId: string;
	consent: 'per-turn-shadow-evidence/v1';
	recordedAt: string;
	expiresAt: string;
	finalizedTranscript: string;
	policyVersion: string;
	authoritative: ConsentedShadowEvidence['authoritative'];
	shadow: ConsentedShadowEvidence['shadow'];
}>;

export type ConsentedShadowEvidenceStore = Readonly<{
	save(evidence: ConsentedShadowEvidence): Promise<boolean>;
	read(evidenceId: string): Promise<StoredConsentedShadowEvidence | null>;
	delete(evidenceId: string): Promise<boolean>;
}>;

export type ConsentedShadowEvidenceStoreOptions = Readonly<{
	command?: RedisCommand;
	now?: () => Date;
	retentionSeconds?: number;
}>;

/**
 * The only durable store for raw shadow comparison content. Callers receive a
 * boolean rather than an error so a failed write is both fail-closed and unable
 * to alter a player-facing Voice Turn.
 */
export function createConsentedShadowEvidenceStore(
	options: ConsentedShadowEvidenceStoreOptions = {}
): ConsentedShadowEvidenceStore {
	const command = options.command ?? unavailableRedis;
	const now = options.now ?? (() => new Date());
	const retentionSeconds = validRetention(options.retentionSeconds)
		? options.retentionSeconds
		: CONSENTED_SHADOW_EVIDENCE_RETENTION_SECONDS;

	return Object.freeze({
		async save(evidence: ConsentedShadowEvidence): Promise<boolean> {
			let record: StoredConsentedShadowEvidence;
			try {
				record = storedEvidence(evidence, now(), retentionSeconds);
			} catch {
				return false;
			}

			try {
				const result = await command<string | null>([
					'SET',
					evidenceKey(record.evidenceId),
					JSON.stringify(record),
					'EX',
					retentionSeconds,
					'NX'
				]);
				return result === 'OK';
			} catch {
				return false;
			}
		},

		async read(evidenceId: string): Promise<StoredConsentedShadowEvidence | null> {
			if (!isEvidenceId(evidenceId)) return null;
			try {
				const value = await command<string | null>(['GET', evidenceKey(evidenceId)]);
				return decodeStoredEvidence(value, evidenceId);
			} catch {
				return null;
			}
		},

		async delete(evidenceId: string): Promise<boolean> {
			if (!isEvidenceId(evidenceId)) return false;
			try {
				return (await command<number>(['DEL', evidenceKey(evidenceId)])) > 0;
			} catch {
				return false;
			}
		}
	});
}

/** Server route helper; callers must invoke it only after explicit per-turn consent. */
export async function saveConsentedShadowEvidence(
	evidence: ConsentedShadowEvidence,
	command: RedisCommand
): Promise<boolean> {
	return createConsentedShadowEvidenceStore({ command }).save(evidence);
}

/** Server route helper for the private operator review and deletion surface. */
export function operatorConsentedShadowEvidenceStore(command: RedisCommand): ConsentedShadowEvidenceStore {
	return createConsentedShadowEvidenceStore({ command });
}

export function isConsentedShadowEvidenceId(value: unknown): value is string {
	return isEvidenceId(value);
}

function storedEvidence(
	evidence: ConsentedShadowEvidence,
	recordedAt: Date,
	retentionSeconds: number
): StoredConsentedShadowEvidence {
	if (!isEvidenceId(evidence.evidenceId)) throw new Error('invalid evidence ID');
	if (!isPolicyVersion(evidence.policyVersion)) throw new Error('invalid policy version');
	if (!isFinalizedTranscript(evidence.finalizedTranscript)) throw new Error('invalid transcript');
	if (!validRetention(retentionSeconds)) throw new Error('invalid retention');

	const expiresAt = new Date(recordedAt.getTime() + retentionSeconds * 1_000);
	return Object.freeze({
		schema: CONSENTED_SHADOW_EVIDENCE_SCHEMA,
		evidenceId: evidence.evidenceId,
		consent: 'per-turn-shadow-evidence/v1',
		recordedAt: recordedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		finalizedTranscript: evidence.finalizedTranscript,
		policyVersion: evidence.policyVersion,
		authoritative: evidence.authoritative,
		shadow: evidence.shadow
	});
}

function decodeStoredEvidence(
	value: string | null,
	expectedEvidenceId: string
): StoredConsentedShadowEvidence | null {
	if (typeof value !== 'string') return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return null;
		if (
			parsed.schema !== CONSENTED_SHADOW_EVIDENCE_SCHEMA ||
			parsed.evidenceId !== expectedEvidenceId ||
			parsed.consent !== 'per-turn-shadow-evidence/v1' ||
			!isFinalizedTranscript(parsed.finalizedTranscript) ||
			!isPolicyVersion(parsed.policyVersion) ||
			!isIsoDate(parsed.recordedAt) ||
			!isIsoDate(parsed.expiresAt)
		) {
			return null;
		}
		const authoritative = loadInterpreterEvidence(parsed.authoritative);
		const shadow = loadInterpreterEvidence(parsed.shadow);
		return Object.freeze({
			schema: CONSENTED_SHADOW_EVIDENCE_SCHEMA,
			evidenceId: parsed.evidenceId,
			consent: 'per-turn-shadow-evidence/v1',
			recordedAt: parsed.recordedAt,
			expiresAt: parsed.expiresAt,
			finalizedTranscript: parsed.finalizedTranscript,
			policyVersion: parsed.policyVersion,
			authoritative,
			shadow
		});
	} catch {
		return null;
	}
}

function evidenceKey(evidenceId: string): string {
	return `shadow-evidence:v1:${evidenceId}`;
}

function isEvidenceId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function isPolicyVersion(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(value);
}

function isFinalizedTranscript(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 240 && value === value.trim();
}

function validRetention(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 60 && value <= 90 * 24 * 60 * 60;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function loadInterpreterEvidence(value: unknown): InterpreterOutcomeEvidence {
	if (!isRecord(value)) throw new Error('invalid interpreter evidence');
	if (
		!hasExactKeys(value, ['authority', 'releaseId', 'releaseIdentity', 'outcome']) ||
		(value.authority !== 'hosted' && value.authority !== 'slm') ||
		typeof value.releaseId !== 'string' ||
		typeof value.releaseIdentity !== 'string'
	) {
		throw new Error('invalid interpreter evidence');
	}
	return Object.freeze({
		authority: value.authority,
		releaseId: value.releaseId,
		releaseIdentity: value.releaseIdentity,
		outcome: loadVoiceTurnOutcome(value.outcome)
	});
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = []
): boolean {
	const expected = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function unavailableRedis<T>(): Promise<T> {
	throw new Error('Redis is unavailable.');
}
