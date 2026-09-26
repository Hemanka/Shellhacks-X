const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'mp3_22050_32';
const MAX_AUDIO_BYTES = 2_000_000;

export interface SpeechAudio {
  audio: Buffer;
  latencyMs: number;
}

export class ElevenLabsService {
  constructor(
    private readonly apiKey = process.env.ELEVENLABS_API_KEY ?? '',
    private readonly voiceId = process.env.ELEVENLABS_VOICE_ID ?? '',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey && this.voiceId);
  }

  async synthesize(text: string): Promise<SpeechAudio> {
    if (!this.configured) throw new Error('ElevenLabs is not configured.');
    const startedAt = performance.now();
    const response = await this.fetchImpl(`${ELEVENLABS_BASE_URL}/${encodeURIComponent(this.voiceId)}?output_format=${OUTPUT_FORMAT}`, {
      method: 'POST',
      headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': this.apiKey },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`ElevenLabs request failed with status ${response.status}.`);
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > MAX_AUDIO_BYTES) throw new Error('ElevenLabs audio response is too large.');
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) throw new Error('ElevenLabs returned invalid audio.');
    return { audio, latencyMs: performance.now() - startedAt };
  }
}
