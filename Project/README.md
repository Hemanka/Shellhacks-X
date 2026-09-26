# Find & Reach

Text-first camera guidance prototype: type a target, automatically select a visible instance, approach, then guide the free hand until **Found it**. Start with stationary pizza boxes on a table in a cleared room. This is a development demo, not validated mobility assistance.

## Mock-grid navigation engine

The independent decision engine lives in `navigation/`. It accepts a structured occupancy grid, user pose, target and timestamp, replans with four-direction A* on every `decide` call, and returns one next action. Unknown cells are blocked by default; obstacle clearance, unknown traversal cost, confidence threshold and arrival radius are configurable.

```ts
import { Navigator } from './navigation/index.js';

const navigator = new Navigator();
const decision = navigator.decide(state);
```

Run `pnpm test` for all tests and `pnpm nav:benchmark` for the debug grid and timing benchmark.

For downstream voice or logging integration, `navigator.decideJson(state)` returns a versioned JSON envelope containing the next action, confidence, reason, full path, next cell, replanning flag, and timing data. Run `pnpm nav:json` to print an example. The navigation module intentionally provides action data rather than generating spoken text.

## Run on Windows

Install Node.js 22+ and pnpm. From this directory:

```powershell
pnpm install
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node node_modules/tsx/dist/cli.mjs server/index.ts
```

The server listens on `http://127.0.0.1:3000`. Open that locally, or start the downloaded official tunnel helper in a second terminal:

```powershell
.\.runtime\cloudflared.exe tunnel --url http://127.0.0.1:3000 --protocol http2
```

Open the printed HTTPS URL in Safari on the iPhone. Keep the laptop running and Safari visible. Tunnel URLs are temporary and change when restarted. If the helper is absent, obtain the Windows AMD64 executable from Cloudflare's official cloudflared releases and put it in the ignored `.runtime` directory.

## Private configuration

Copy `.env.example` to `.env.local` only if `.env.local` does not already exist. Fill `GEMINI_API_KEY` in your local editor. The code defaults to `gemini-3.8-flash`; this demo's private configuration uses `gemini-3.1-flash-lite` for both roles after live latency checks. These model names are configurable because account availability varies. Restart the server after changing configuration.

Never put a key in a `VITE_` variable or enter it into the browser. The browser automatically receives a short-lived, same-origin session cookie; there is no access-code screen. The backend keeps keys and target reference crops private. The environment file is ignored by Git; `.env.example` contains no credentials.

For the first ElevenLabs milestone, also set backend-only `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`. The server uses the low-latency `eleven_flash_v2_5` model. Restart the server, then open `http://127.0.0.1:3000/?voiceTest=1` and press **Test “Turn right” audio**. The development control sends a mock `TURN_RIGHT` navigation decision through the real mapper, protected backend endpoint, and browser audio playback path.

```powershell
node node_modules/tsx/dist/cli.mjs server/smoke.ts
node node_modules/tsx/dist/cli.mjs --test tests/*.test.ts client/*.test.ts
```

The smoke check calls both Gemini roles using a synthetic image; it does not upload camera recordings. Failure is reported without provider payloads or keys. Never silently substitute fake observations for a failed model call.

## Demo flow

1. Press **Start GuideSight** and allow the rear camera. Choose which free hand will reach; hold the phone with the other hand.
2. Type `pizza box` and start. Keep the phone pointing forward in line with the torso during approach.
3. The app selects the usable match nearest image center. **Find another** explicitly starts a new selection; ambiguity never silently changes the target.
4. Follow one short text cue. “Next check in 2 seconds” is static timing text. When it changes to “Stop—checking your view,” stay still until the next result. API response time varies.
5. Show both the free hand and target. Follow small hand corrections. Tap **Found it** on contact; the app does not detect touch or guide opening/eating.
6. **Pause** stops guidance without completing. Hidden page, camera loss, disconnect, and stale frames stop guidance as well.

Text is for debugging the interaction before audio is added. Validate with a sighted tester in a cleared space; testing supervision is not an input required by the software.

## How the pipeline works

The preview stays live. The server requests one JPEG for each Gemini check, with one inference in flight per session. After a locked-target result it requests one fresh verification JPEG, compared locally with the analyzed image using 32×24 grayscale pixels; this second image does not go to Gemini. The browser also detects changes while waiting without uploading images. Changed views suppress movement and schedule another check. Movement uses the fresh verification frame and preserves the four-second freshness limit. Each result schedules the next check after two seconds; transient errors show their retry delay. One-second lightweight heartbeats replace continuous-frame connection monitoring.

Gemini returns validated target, hand, proximity, and independent reachability observations. The deterministic controller maps these to fixed instructions without a second inference round trip. Near stops walking but never establishes arrival. Two distinct fresh within-reach assessments with the selected hand visible are required for Reach. An out-of-reach assessment after stopping can authorize a final small step; an uncertain assessment asks for a better view. Cycle IDs and session revisions reject duplicate captures and late replies. All controls invalidate pending work.

Proximity is categorical, not measured distance. Gemini can misjudge depth, identity, or hand relationships. No obstacles, room map, exact localization, or physical-contact guarantee is provided.

## Acceptance and troubleshooting

Before a demonstration, record 3 consecutive first-person runs using the actual phone and network. Check one/two/similar boxes, target loss, motion blur, hidden hands, network interruption, pause/resume, and Found it during inference. A wrong-target switch, movement after expiry, or walking instruction during reaching is a failure.

Use the diagnostics panel for frame age, model latency, call counts, token usage, skipped calls, and decision reasons. Repeated stale-frame stops indicate model/network latency is too high; change the configured models or reduce frame size and retest. Do not disable freshness checks to hide the issue. Repeated identity ambiguity requires a clearer distinguishing view or an explicit new search.

Models run on Google's service; the laptop does not need a GPU. Two concurrent socket sessions and two inference pipelines maximum are supported; the single-phone flow is the tested scope. Camera images remain in application memory and are sent to Gemini; no recordings are saved by default.

## Verification recorded during implementation

- Type checking and production frontend build passed; 17 controller, gate, client freshness, HTTP authentication, and WebSocket tests passed.
- Temporary HTTPS endpoint returned 200; the automatic session and WSS handshake succeeded with an HttpOnly/SameSite cookie.
- Current image plus selected crop using Flash-Lite produced several successful combined vision/reasoning checks around 1.8–3.0 seconds. Additional reaching checks included one timeout; latency is variable.
- A bounded replay of a frame from the user-provided third-person demo exercised the actual running server and Gemini: automatic selection → near stop → reaching → explicit Found it completion. Observed visual inference was about 1.6–2.6 seconds. This did not exercise real walking or first-person hand correction.
- First-person iPhone camera behavior, instruction quality while moving, and three complete physical acceptance runs remain unverified. A working link is not evidence that these passed.
