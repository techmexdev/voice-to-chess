const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
export const TTS_MODEL = 'gpt-4o-mini-tts-2025-12-15';
export const TTS_VOICE = 'alloy';

export class TextToSpeechProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TextToSpeechProviderError';
	}
}

export async function createMoveSpeech(
	text: string,
	apiKey: string,
	fetcher: typeof fetch = fetch
): Promise<ArrayBuffer> {
	const response = await fetcher(OPENAI_SPEECH_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			Accept: 'audio/mpeg'
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			voice: TTS_VOICE,
			input: text,
			instructions: 'Speak like a calm, concise chess arbiter. Pronounce chess squares clearly, keep a steady pace, and use brief pauses.',
			response_format: 'mp3'
		}),
		signal: AbortSignal.timeout(12_000)
	});

	if (!response.ok) {
		throw new TextToSpeechProviderError(`OpenAI speech generation failed with status ${response.status}.`);
	}
	const audio = await response.arrayBuffer();
	if (audio.byteLength === 0) throw new TextToSpeechProviderError('OpenAI returned empty audio.');
	return audio;
}
