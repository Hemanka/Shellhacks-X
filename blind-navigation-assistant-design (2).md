# Blind Navigation Assistant — System Design

A web application that lets a blind user speak the name of an object, then guides them
via spoken directions to locate and reach it, using a phone/camera, computer vision,
and a spatial map built on the fly.

---

## 1. Pipeline Overview

```
Voice → Intent Extraction → Object Search Loop → BEV Mapping (continuous)
      → Path Planning → Spoken Instructions
```

Five stages, each detailed below.

---

## 2. Stage 1: Voice → Intent

```
Mic → ElevenLabs Scribe (STT) → transcript → Gemini (structured output) → target JSON
```

- **STT**: ElevenLabs **Scribe** model converts speech to text.
- **Intent cleaning**: Instead of a separate NLU API, use **Gemini with a JSON schema
  response** to parse the transcript into a structured target description. Gemini
  handles disfluent speech ("uh, my, um, red mug thing") better than generic NLU.

**Output schema:**
```json
{
  "target_object": "coffee mug",
  "attributes": ["red", "ceramic"],
  "disambiguation_needed": false,
  "raw_transcript": "can you find my red mug",
  "confidence": 0.93
}
```

If `disambiguation_needed` is true, loop back through TTS to ask a clarifying question
before starting the search.

---

## 3. Stage 2: Object Search Loop (rotate-and-scan)

```
Camera frame → Google Vision (object localization) → match against target JSON
```

- Google Vision returns generic labels + bounding boxes — not full attribute
  descriptions. A matching layer is needed on top:
  - **Coarse gate (label match)**: cheap, runs every frame. Discard any detection
    whose label doesn't match `target_object` (or a close synonym) — this keeps
    irrelevant detections (chair, laptop, lamp) from ever being processed further.
  - **Fine gate (attribute match)**: only needed when 2+ candidates pass the coarse
    gate (e.g., two mugs in frame). Crop the bounding box and use Gemini vision to
    answer "is this the red one?" — raw Vision labels can't do color/material
    attributes.

**Per-frame output:**
```json
{
  "frame_id": 41,
  "heading_deg": 135,
  "candidates": [
    {"label": "mug", "score": 0.88, "bbox": [x, y, w, h]}
  ],
  "target_match": {"found": true, "match_confidence": 0.81},
  "next_action": null
}
```

If not found, emit a `next_action` like `"turn_right_45"` and keep sweeping (cap at
360°, then prompt the user to move or re-describe the object).

---

## 4. Stage 3: BEV (Bird's-Eye-View) Mapping

### Key decision: build continuously, not after detection

**Build the BEV incrementally throughout the search loop**, not as a separate pass
once the object is found. Reasons:

1. The rotation sweep already produces frames with depth data — that data is
   available "for free" whether or not you use it for mapping. Discarding it and
   re-scanning after detection duplicates sensing cost.
2. Relating a detected object's position to physical space requires a map to exist
   *at the moment of detection* — waiting until after detection means doing a
   separate mapping pass anyway, with no ability to relate "where I saw it" to
   "where I am now."
3. Continuous mapping lets multiple sightings of the same object be fused (reducing
   single-frame noise) instead of trusting one observation.

### Unified construction: one Vision pass feeds a single object registry

The entire BEV is now built as **one registry of all detected objects** — not a
separate occupancy grid plus a single target struct. Every box Vision returns in a
frame, target or not, goes through the same pipeline and lands as an entry in the
same registry:

```
Each frame:
  Google Vision → list of bounding boxes (label, score, bbox)
      │
      ▼
  for each box:
      sample depth at box → pixel→world (Section 5) → world position
      │
      ▼
  match against existing registry entries (same label, position within threshold)?
      │
      ├─ yes ──► fuse into that entry (update position, num_observations, etc.)
      │
      └─ no ───► create new registry entry
      │
      ▼
  if box label+attributes match target_object → mark entry.is_target = true
```

So there's no longer a target-vs-obstacle fork at the routing stage — **everything
Vision detects becomes a tracked, identified entry**, and the occupancy grid is
simply *derived* from the registry's positions (mark a cell occupied wherever a
registry entry sits), rather than being built as its own separate structure.

### How it's built: Vision boxes + depth (not dense per-pixel depth)

Dense per-pixel depth was tried and rejected for this project — the monocular depth
model, without floor-plane subtraction, was flagging the floor itself (and other flat
surfaces) as obstacles, marking nearly everything in view as occupied. The registry
approach avoids this entirely:

- **Google Vision** gives bounding boxes for recognized objects in each frame — the
  same detections already used for the object search loop.
- For each bounding box, sample **depth at its center (or bottom-center) point only**
  — one representative distance per detected object, not per pixel.
- Use the pixel→world conversion (Section 5) on that single point per box to place
  the object at a location in the room.
- **Device orientation** (IMU / `DeviceOrientationEvent`) still supplies camera
  heading, needed for the camera-frame → world-frame step.

This trades some completeness for simplicity and robustness: only objects Vision
actually recognizes and boxes get a registry entry (and therefore an occupied cell);
things outside Vision's label vocabulary (a low step, a stray cable, an unlabeled
surface) won't appear. For the scope of this project that's an acceptable tradeoff,
since it avoids the floor-plane misclassification problem entirely and needs far
less per-frame computation than scanning every pixel.

### The registry (target and every other detected object, together)

```
BEV map
└── object_registry: every Vision-detected object gets one entry, with
    an is_target flag distinguishing the one being navigated to
```

**Registry entry:**
```json
{
  "object_id": "obj_003",
  "label": "mug",
  "is_target": true,
  "position": [1.8, 0.6],
  "position_variance": 0.12,
  "status": "locked",
  "num_observations": 3,
  "last_seen_frame": 41
}
```

- `object_id` — assigned the first time an object is seen; reused across frames via
  the label+position matching in the diagram above.
- `is_target` — set true the first time an entry's label (and attributes, via the
  fine-gate check from Stage 2) match the target description with enough confidence.
  At most one entry should carry `is_target: true` at a time.
- `status` — `"searching"` → `"locked"` once the target entry's `num_observations`
  and confidence cross a threshold; this is what tells the rest of the pipeline to
  stop searching and start navigating. Non-target entries don't need a `status`
  field — they're just obstacles once they exist.

**Occupancy is a derived view, not a separate structure**: to check if a cell is
occupied, look up whether any registry entry's position falls in it. This keeps a
single source of truth — there's no risk of the registry and the occupancy grid
disagreeing, since one is generated from the other on demand.

> Tracking every detected object (not just the target) does mean revisiting the
> earlier assumption that a single mutable struct was enough — a real registry with
> IDs and matching logic is needed now, since multiple simultaneous objects must be
> distinguished and re-identified across frames. This also sets up follow-up voice
> commands ("now find my keys") to reuse already-seen objects without a fresh scan,
> if that's ever wanted.

---

## 5. Pixel → World Coordinate (shared by both layers)

Conceptually, four steps turn a flat image location into a fixed spot on the room
map:

1. **Start with a flat image location.** A pixel only tells you direction (up/down/
   left/right in the camera's view), not distance.
2. **Add depth.** The depth map supplies "how far away" for that pixel, giving a 3D
   point — but measured relative to the camera itself, as if the camera were the
   origin looking straight ahead.
3. **Account for camera position and heading.** The camera isn't at the room's
   origin — it's wherever the user is standing, facing wherever they're currently
   facing. Rotate/translate the camera-relative point using the camera's real pose
   (from IMU/compass) to convert it into the room's fixed coordinate system.
4. **Snap onto the grid.** Bucket the resulting real-world position into a BEV grid
   cell.

**One-line intuition**: a pixel gives direction, depth gives distance along that
direction, and camera pose gives the frame of reference that direction was even
pointing from — chain them together and a screen coordinate becomes a fixed
location on the map.

### Applied the same way to every registry entry

With the box-based approach, every registry entry — target or not — uses the
**same sampling strategy**: one representative depth point per Vision-detected
bounding box, run through the pixel→world conversion. There's no longer a special
case for the target; it's just the one entry with `is_target: true`.

| | Target entry | Any other registry entry |
|---|---|---|
| Sampling | One point (bbox bottom-center) | Same |
| Purpose | Anchor point to navigate toward, plus an occupied cell | Occupied region to route around |
| Update | Fused with previous estimate (EMA / Kalman) | Same fusion logic |

Because the target is also a physical object, its entry's `position` doubles as both
the navigation goal *and* an occupied cell in the derived occupancy view — the two
should agree; a mismatch signals a bad depth reading or pose estimate.

### Updating a registry entry on a new matching detection

Don't overwrite — fuse, since any single frame's estimate is noisy. This applies to
every entry in the registry, not just the target:

- **`position`**: blend new observation with the old value (exponential moving
  average, or a full Kalman filter for a variance estimate too).
- **`num_observations`**: increment on each consistent sighting.
- **`position_variance`**: decreases as consistent observations accumulate; a
  wildly divergent new observation should *not* shrink variance (possible
  different object or bad reading) — more likely a sign the detection should become
  a *new* entry instead of updating this one.
- **`last_seen_frame`**: updated each sighting — used to detect staleness if the
  target entry goes out of frame for a while after being locked.
- **`status`**: (target entry only) flips to `"locked"` once observation count and
  confidence cross thresholds.

---

## 6. Stage 4: Navigation — Two Options

### Option 1: Gemini reasoning model

Feed a compact scene summary (not raw pixel data — token cost/latency matter in a
loop):

**Input:**
```json
{
  "occupancy_grid": "20x20 downsampled binary grid, derived from object_registry positions",
  "cell_size_m": 0.25,
  "user_position": [0, 0],
  "user_heading_deg": 90,
  "target_position": [1.8, 0.6],
  "target_label": "red mug",
  "target_confidence": 0.81
}
```

**Output (constrained JSON schema):**
```json
{
  "status": "navigating",
  "action": "turn",
  "direction": "left",
  "angle_deg": 30,
  "distance_m": null,
  "instruction_text": "Turn slightly left."
}
```
or, on arrival:
```json
{"status": "arrived", "action": "stop", "instruction_text": "You're right in front of it, reach forward."}
```

### Option 2: Classical planner (recommended for the control loop)

- **Path search**: A* over the occupancy grid (derived from `object_registry`
  positions), or **D\* Lite** if replanning as the live registry updates is needed
  (better fit here since the map is live, not static).
- Convert the resulting grid path into waypoints.
- At each control step:
  - Bearing to next waypoint: `atan2(Δy, Δx)`
  - Turn angle: bearing minus current heading (from IMU/compass)
  - Distance: Euclidean distance to the waypoint
- Re-run every N frames as odometry drifts and the user actually moves, rather than
  planning once and executing blind.

### Recommendation

**Use Option 2 (classical planner) for the control loop; reserve the LLM for
object identification/attribute matching and phrasing the spoken instruction.**

This is a safety-critical, real-time loop guiding a blind person around physical
obstacles — deterministic, low-latency, non-hallucinating math is preferable to an
LLM call that could occasionally produce a wrong turn direction with no way for the
user to visually sanity-check it. A* + bearing math is well understood, fast, and
debuggable. Gemini's strengths (semantic matching, natural phrasing) are best used
where a wrong answer has low risk — not in the part that could walk someone into a
wall.

---

## 7. Stage 5: Output → Speech

- Keep `instruction_text` to a **single short, atomic command per turn** ("Turn
  right a little", "Walk forward three steps", "You've arrived") — avoid stacking
  multiple instructions in one utterance, since the user can't glance ahead at a
  queued list the way a sighted person could.
- Feed the instruction string directly to **ElevenLabs TTS** for playback.

---

## 8. Open Implementation Questions

- **On-device vs. backend depth estimation**: affects BEV update rate and overall
  responsiveness — a real-time latency budget should be worked out before build.
- **Camera pose drift**: IMU/visual-odometry-derived pose drifts over time, which
  silently degrades world-frame coordinate accuracy the longer a search runs.
  Continuous BEV building (Section 4) mitigates this by minimizing time-to-detection.
- **Staleness handling**: define behavior when a locked target goes unseen for
  several frames (e.g., briefly out of frame while turning) — keep the lock and
  continue navigating on the last known position, or fall back to re-searching.
- **Metric depth model choice**: relative-depth models (plain MiDaS) are
  insufficient; a metric-depth checkpoint or a calibration-based conversion is
  required since real distances are spoken to the user.
- **Coverage gap from registry-based occupancy**: obstacles Google Vision doesn't
  recognize/label (steps, cables, unlabeled clutter) never get a registry entry, and
  so never appear in the derived occupancy view, since occupancy is now entirely a
  byproduct of Vision's detections. Worth monitoring in testing to confirm this
  tradeoff is acceptable for real rooms; a reactive depth-based "anything directly
  ahead within N meters" stop-check could be layered on top later as a cheap safety
  net if needed, without going back to full dense-grid mapping.
- **Registry growth and pruning**: with every detected object now getting an entry,
  the registry will grow over a session. Decide whether to cap its size, expire
  entries not seen for N frames, or keep it scoped to just the current room/search.
