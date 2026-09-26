import test from 'node:test';
import assert from 'node:assert/strict';
import { speechForAction, speechForDecision } from '../voice/speechMapper.js';
import { ElevenLabsService } from '../server/elevenLabsService.js';
import type { NavigationDecision } from '../navigation/types.js';

const turnRight: NavigationDecision = { action: 'TURN_RIGHT', confidence: 1, reason: 'PATH_AVAILABLE', path: [], nextCell: null, shouldReplan: true, timing: { preprocessingMs: 0, planningMs: 0, decisionMs: 0, totalMs: 0 } };

test('first voice milestone maps only TURN_RIGHT to concise speech', () => {
  assert.equal(speechForAction('TURN_RIGHT'), 'Turn right.');
  assert.equal(speechForDecision(turnRight), 'Turn right.');
  assert.equal(speechForAction('FORWARD'), null);
});

test('ElevenLabs service requires backend-only configuration', async () => {
  const service = new ElevenLabsService('', '');
  assert.equal(service.configured, false);
  await assert.rejects(service.synthesize('Turn right.'), /not configured/);
});

test('ElevenLabs service uses the current Flash endpoint without exposing its key', async () => {
  let request: { url: string; init?: RequestInit } | null = null;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }) as typeof fetch;
  const service = new ElevenLabsService('private-test-key', 'voice/test', fakeFetch);
  const result = await service.synthesize('Turn right.');
  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.match(request!.url, /text-to-speech\/voice%2Ftest\?output_format=mp3_22050_32$/);
  assert.equal((request!.init?.headers as Record<string, string>)['xi-api-key'], 'private-test-key');
  assert.deepEqual(JSON.parse(String(request!.init?.body)), { text: 'Turn right.', model_id: 'eleven_flash_v2_5' });
});

