import {
	type InterpreterReleaseIdentity,
	type MoveInterpreter,
	type MoveInterpreterCallOptions,
	type MoveInterpreterRequest,
	type MoveInterpreterResult,
	MoveInterpreterProviderError
} from './moveInterpreter.ts';
import { SpokenMoveProviderError, interpretTranscript } from './openai/spokenMove.ts';

export type HostedMoveInterpreterConfig = Readonly<{
	apiKey: string;
	release: InterpreterReleaseIdentity;
	fetcher?: typeof fetch;
}>;

/** The hosted baseline behind the same transcript-only interpreter contract. */
export function createHostedMoveInterpreter(config: HostedMoveInterpreterConfig): MoveInterpreter {
	const fetcher = config.fetcher ?? fetch;

	return Object.freeze({
		authority: 'hosted' as const,
		release: config.release,
		async interpret(
			request: MoveInterpreterRequest,
			options: MoveInterpreterCallOptions
		): Promise<MoveInterpreterResult> {
			try {
				const compact = await interpretTranscript(request.finalizedTranscript, config.apiKey, fetcher, {
					signal: options.signal
				});
				return Object.freeze({ compact, release: config.release });
			} catch (error) {
				if (error instanceof SpokenMoveProviderError) {
					throw new MoveInterpreterProviderError(error.message, error.failure);
				}
				throw error;
			}
		}
	});
}
