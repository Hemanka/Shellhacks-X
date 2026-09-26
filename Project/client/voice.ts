import type { NavigationDecision } from '../navigation/types.js';
import { speechForDecision } from '../voice/speechMapper.js';

export interface SpeechMeasurement {
  action: NavigationDecision['action'];
  text: string;
  decisionReceivedAt: number;
  requestStartedAt: number;
  firstAudioAvailableAt: number;
  playbackStartedAt: number;
  serverTtsLatencyMs: number | null;
}

class DecisionSpeaker {
  private audioContext: AudioContext | null = null;

  async speakDecision(decision: NavigationDecision): Promise<SpeechMeasurement | null> {
    const text = speechForDecision(decision);
    if (!text) return null;
    const decisionReceivedAt = performance.now();
    this.audioContext ??= new AudioContext();
    await this.audioContext.resume();
    const requestStartedAt = performance.now();
    console.info('[GuideSight Voice]', { action: decision.action, text, event: 'request-started' });
    const response = await fetch('/api/speech', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(response.status === 503 ? 'ElevenLabs is not configured.' : 'Speech generation failed.');
    const audioBytes = await response.arrayBuffer();
    const firstAudioAvailableAt = performance.now();
    const buffer = await this.audioContext.decodeAudioData(audioBytes);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const playbackStartedAt = performance.now();
    source.start();
    const serverLatency = Number(response.headers.get('X-TTS-Latency-Ms'));
    const measurement: SpeechMeasurement = { action: decision.action, text, decisionReceivedAt, requestStartedAt, firstAudioAvailableAt, playbackStartedAt, serverTtsLatencyMs: Number.isFinite(serverLatency) ? serverLatency : null };
    console.info('[GuideSight Voice]', { action: decision.action, text, source: 'ElevenLabs', ttsLatencyMs: measurement.serverTtsLatencyMs, audioAvailableMs: firstAudioAvailableAt - requestStartedAt, playbackStartedMs: playbackStartedAt - decisionReceivedAt });
    return measurement;
  }
}

export const decisionSpeaker = new DecisionSpeaker();
