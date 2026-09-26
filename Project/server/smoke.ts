import { config } from 'dotenv';
import sharp from 'sharp';
import { GeminiService } from './gemini.js';

config({ path: '.env.local' });
const service = new GeminiService();
if (!service.configured) {
  console.error('Smoke test skipped: GEMINI_API_KEY is not configured.');
  process.exitCode = 1;
} else {
  let stage = 'synthetic image';
  try {
    // Synthetic imagery avoids uploading personal camera data during verification.
    const jpeg = (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()).toString('base64');
    const frame = { id: 1, capturedAt: Date.now(), receivedAt: Date.now(), jpeg, revision: 1 };
    stage = 'vision';
    const visionStart = Date.now();
    const { observation, tokens: visionTokens } = await service.observe({ frame, recent: [], target: null, query: 'A red mug', hand: 'right', phase: 'searching' });
    const visionMs = Date.now() - visionStart;
    stage = 'reasoning';
    const reasonStart = Date.now();
    const { proposal, tokens: reasonTokens } = await service.reason({ observation, phase: 'searching', lastAction: null, hand: 'right' });
    if (!['STOP', 'HOLD', 'ADJUST_VIEW', 'NO_CHANGE'].includes(proposal.action)) throw new Error('Unexpected searching action.');
    console.log(`Gemini smoke passed: validated vision and reasoning JSON; ${visionTokens + reasonTokens} total tokens; action ${proposal.action}; vision ${visionMs}ms; reasoning ${Date.now() - reasonStart}ms.`);
  } catch {
    console.error(`Gemini smoke failed at ${stage}: API access, timeout, model availability, or response validation failed. No vendor payload was logged.`);
    process.exitCode = 1;
  }
}
