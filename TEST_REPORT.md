# Test Report

Environment: Claude Code cloud container, Linux x86_64, **no GPU**, Node 22.22.0, Rust 1.97 (`wasm32-unknown-unknown`), SpacetimeDB 2.10.0 (official release binaries), Chromium 141 (Playwright 1.56.1, SwiftShader software WebGL). Date: 2026-10-20.

Everything marked ✅ below was observed in command output in this session. Nothing was deployed publicly.

## 1. Results by stage

| # | Stage | Result | Evidence |
|---|---|---|---|
| 1 | Dependencies install | ✅ | `npm install` in `web/` (workspaces), `cargo` fetch for both crates, `rustup target add wasm32-unknown-unknown` |
| 2 | Backend starts and reports healthy | ✅ | `GET /api/health` → `{"status":"ok", spacetimedb:{reachable:true, databaseFound:true}, accounts:{ok:true}}` |
| 3 | Database connects | ✅ | SpacetimeDB `/v1/ping` 200; module `kaykit-arena` published and ticking (`SELECT tick FROM world` increasing); SQLite account store opened |
| 4 | Web client builds | ✅ | `tsc --noEmit` clean; `vite build` → three 149 KB gz, app ≈32 KB gz, SDK 27 KB gz |
| 5 | Browser loads the game | ✅ | Login screen visible ≈1.7–2.9 s after navigation (headless, local) |
| 6 | Assets load without missing files | ✅ | E2E step "all game assets load…": 0 HTTP ≥ 400, 0 console errors |
| 7 | Movement, camera, combat | ✅ (logic) / ⚠️ (feel) | Server moved the hero 4.9–5.7 m north for 1.5 s of `W`; a skeleton was killed with server-validated hits; wall collision stopped the hero at z ≈ 17.07 (wall face 16.5). Camera follow and animations verified in screenshots only (see §4). |
| 8 | Connect / disconnect | ✅ | Gateway killed and restarted mid-session; client showed "Reconnecting…", came back, and accepted input again |
| 9 | Live state sync | ✅ | Desktop and mobile clients each saw the other hero; positions agreed within 0.5 m |
| 10 | Authentication & errors | ✅ | Register → 201; duplicate → 409; wrong password → 401 "Wrong username or password."; bad token → 400; foreign origin → 403; rate limit → 429; client call to `authorize_session` refused by the module |
| 11 | Desktop & mobile controls | ✅ | Keyboard + Space on desktop; on a 390×844 touch context the joystick (CDP touch events) moved the hero and the ⚔ button produced a server attack |
| 12 | Production start | ✅ | `npm start` built the client and served it from the gateway on :8080; `npm run dev` started gateway + Vite, and Ctrl+C (SIGINT) stopped every child ("shutdown complete") |

## 2. Automated suites

### Arena module (Rust) — `cd web/arena-module && cargo test`
```
test map::tests::map_parses_and_spawns_are_free ... ok
test map::tests::walls_stop_movement ... ok
test map::tests::walls_block_line_of_sight ... ok
test map::tests::bounds_clamp ... ok
test rules::tests::melee_cone ... ok
test rules::tests::ranged_line ... ok
test map::tests::steering_gets_around_a_tree ... ok
test rules::tests::reentry_never_skips_death_or_heals ... ok
test rules::tests::unknown_class_rejected ... ok
test result: ok. 9 passed; 0 failed
```
`cargo fmt --check` clean; `cargo clippy --target wasm32-unknown-unknown` no warnings; `spacetime build` OK; committed TypeScript bindings identical to a fresh `spacetime generate`.

### Gateway (Node) — `npm test -w gateway`
```
ok 1 - credential validation
ok 2 - account store hashes and verifies passwords
ok 3 - account database is private to the gateway user   (dir 0700, file 0600)
ok 4 - proxy only exposes client endpoints
ok 5 - identity token verification            (valid / wrong key / expired / alg "none" / malformed)
ok 6 - auth routes (fake SpacetimeDB)          (201, 409, 401, 400, 403 cross-origin, 429, security headers, /v1 sql → 403)
ok 7 - registration is rolled back when the game server refuses the session
ok 8 - integration: real SpacetimeDB login flow (identity from SpacetimeDB → register → enter_world → class whitelist)
# pass 8  # fail 0
```

### Browser end-to-end — `npm run test:e2e`

After the PR-review fixes the suite was run twice in a row: 17/17 both times. Output of an earlier full run:
```
✔ health endpoint reports SpacetimeDB + module + account store — latency 2ms
✔ admin endpoints are not reachable through the gateway
✔ desktop: register, pick Knight, enter the world — spawned at (0.0, 26.0), 242 draw calls, 0.5 fps (software WebGL)
✔ all game assets load without missing files or console errors
✔ keyboard movement is simulated by the server — server z 26.00 → 20.30
✔ combat: fight a skeleton until it dies (server-validated hits) — kills=1 gold=4 hp=140 deaths=0
✔ collision: walking into the keep wall is stopped server-side — stopped at (6.93, 17.07); wall face at z=16.5
✔ mobile: register, pick Mage, touch controls are shown — class=mage
✔ mobile: virtual joystick moves the hero (touch events) — (0.0, 26.0) → (3.2, 17.0)
✔ mobile: attack button triggers a server attack — attack_seq 0 → 1
✔ multiplayer: each client sees the other hero, positions in sync — desktop sees 2, mobile sees 2
✔ potion: server refuses at full health / consumes when hurt — server said: Already at full health
✔ client cannot call privileged reducers — Only the login gateway may authorize sessions
✔ reconnect: gateway restart drops the WebSocket, client recovers — moved 'w' (0.0,26.0) → (0.0,21.0)
✔ login from a new device moves the character to the new identity — kills carried over (1)
✔ graceful shutdown: SIGTERM exits cleanly — exit code 0
✔ no client errors during the run
17/17 steps passed.
```

### Hearthwild open world — `npm run test:world`

Serves the published page form (`artifact.html` wrapped in a bare document) under the strict policy and plays the game. Output on the final build, which plays its spell effects with rollshade on three.js `WebGPURenderer` (here on its WebGL2 fallback: the container has no GPU, so Chromium runs SwiftShader and has no WebGPU):
```
✔ page loads under the strict policy and shows the start screen
✔ start a new hero and enter the island — 10 ruins, 49 skeletons
✔ sound: the Play click starts the audio and the music plays — AudioContext running, 7 music notes scheduled, 0 effects so far
✔ walk to a tree and chop it (+3 wood, woodcutting XP, outline, chop sounds) — wood=3, woodcutting xp=24, outline parts=1, 7 sound effects
✔ chop a second tree — wood=6
✔ craft two planks from the crafting panel — planks=2, wood left=2
✔ build a wooden fence through the build panel — construction xp=5
✔ progress survives a reload (continue) — wood=2, structures=1
✔ shader effects compile: water, wind, grass, ore glow; campfires burn (rollshade loop) — 2615 grass tufts, 1 campfire loop(s); node materials: crystal, flash, grass, outline, water, wind, xray
✔ a slain skeleton burns away (rollshade dissolve) with its death sound — dissolve status started, 14 sound effect(s)
✔ combat skills: the first skill point learns Shield Bash, key 1 stuns and damages a skeleton — hp 120 → 89 after the hit landed, stun status shown, cooldown 6s on the hotbar, 2 sound effects
✔ action: Shift rolls the hero forward and makes it untouchable for a moment — rolled 4.0 m, untouchable for 426 ms, cooldown 183 ms left
✔ action: three quick attacks chain into a finisher that knocks the skeleton back — combo 0 → 1 → 2; the finisher pushed it from 2.0 m to 3.2 m
✔ gear: craft a bone blade at the workbench, equip it, damage goes up — damage per hit 23 → 31
✔ pets: bond a Skeleton Squire; it follows, fights, gains XP and learns Taunt — pet attacked 3×, pet XP 0 → 20, Taunt learned
✔ HDR: WebGPURenderer with the rollshade bloom pass and ACES tone mapping — webgl2 backend, half-float output, bloom {"strength":0.45,"radius":0.3,"threshold":1.5}
✔ skills, gear and pet survive a reload — skills {"shield_bash":1}, weapon kept, squire with 20 XP and Taunt
✔ no errors or CSP violations on desktop
✔ phone: joystick moves the hero, the ✋ button gathers, a skill button casts — moved 10.5 m, gathering started, skill button cast Shadowstep
19/19 steps passed.
```
On the rollshade build the suite ran four times:
- The first run, before the review fixes, passed 19/19.
- The run on the review fixes failed one step, 18/19: the stun check polled for a running stun, and a 1.5 s stun can start and end between two frames at software-rendering frame rates. The check now counts stuns started instead.
- That version then passed 19/19, the output above.
- The arena page test passed 7/7 on the same build.

"Compile" for the node materials means `compileAsync` finished and no TSL error was logged; "no errors" fails on any console error.

How these were tested, and the limits:

- **What the UI drives:** these go through the real UI, as a player would:
  - learning skills (Learn button) and casting them (key 1, the touch button);
  - crafting and equipping gear (crafting and character panels);
  - bonding a pet and learning its skill (pets panel);
  - attacking with Space;
  - dodging (Shift);
  - saving and continuing.
- **Staged setup:** some setup goes through the simulation's internal methods, to keep the steps short and independent of chance:
  - granting materials and moving the hero to a station or out of the village;
  - spawning skeletons in front of the hero;
  - killing leftover skeletons;
  - a staged kill for the dissolve check.
- **Combo step:** it calls `attack()` three times in one page call with the cooldown cleared. With software rendering a frame blocks the page for about a second, longer than the 1.3 s combo window, so key presses cannot be spaced like a player's.
- **Sound:** the audio context is checked as running, and notes and effects are counted. Nobody listened to it.
- **Shaders and effects:**
  - "Compile" means three.js built a program for each one and nothing was logged as an error.
  - Every class's skills, the pets, the combo, the dodge, the HDR glow by day and night, and the character, skills and pets panels were checked in screenshots. Those screenshots were taken with the page clock slowed so short effects could be captured.
  - Motion (wind, flames, particles) can't be judged from stills at the 1–2 FPS of software rendering.
- **Frame rate under software rendering:** about 0.8 fps after warm-up on the `WebGPURenderer` build. The old `WebGLRenderer` build ran about 1.0 fps with bloom and 1.8–1.9 fps without. Turning bloom off (0.78 fps) or bypassing rollshade's post pass entirely (0.71 fps) did not help, so the extra cost is the renderer's node-material path on SwiftShader, not the bloom. The first ~10 s after entering run at about 0.1 fps while the remaining programs compile. None of this says how it runs on a GPU.
- **Loading:** entering the island compiles every rollshade move, loop and the enemy and hero status materials behind the loading bar. That took 85–97 s under software rendering. It is unmeasured on GPUs.
- **Spell effects in screenshots:** a scripted pass showed a fireball setting a skeleton burning, the meteor falling and the Arcane Shield bubble. A later per-class pass captured only sky: it teleported the hero and shot within one or two frames, before the terrain there streamed in. So not every class's skills were checked in screenshots this round.
- **rollshade's post pass** always adds a light vignette, a little chromatic aberration and a brightness knee; it has no public switch for them.

Not covered by automation yet:

- real fights at ruins, chests and night spawns;
- the iron and forge recipes, and houses;
- skill ranks above 1 and every class's skills (only Shield Bash and Shadowstep are cast in the suite);
- pets other than the squire;
- gear drops, rarities and salvage.

The rules for these are in `sim.ts` and were exercised in the scripted screenshot passes, but they have no assertions.

### Single-player arena page — `npm run test:offline`

Serves `artifact.html` wrapped in a bare document under a strict policy (`script-src 'self'` without eval, `connect-src 'self'`, `img-src 'self' data: blob:`) and records CSP violations:
```
✔ page loads under the strict policy and shows the hero-name prompt
✔ enter a name, pick Knight, the world and skeletons are there — spawned at (0, 26)
✔ movement and wall collision are simulated in the browser
✔ combat: kill a skeleton, gold is awarded — kills=1 gold=4
✔ progress is remembered after a reload — name and 1 kill(s) kept
✔ no errors or CSP violations during desktop play
✔ phone: joystick moves the hero and the attack button attacks
7/7 steps passed.
```
The multiplayer E2E suite was re-run after the backend refactor: 17/17. The page was then published to claude.ai; loading it there could not be tested from this session (the published page needs a signed-in viewer).

### Existing BitCraft modules
| Check | Result |
|---|---|
| `spacetime build` `packages/game` | ✅ (5 min 20 s, warning: `wasm-opt` not installed → unoptimised wasm) |
| `spacetime build` `packages/global_module` | ✅ (3 min 28 s) |
| Publish to local SpacetimeDB + `init` | ✅ both modules |
| `generate_flat_world` | ✅ 25 terrain chunks |
| Agents / gameplay | ❌ "Could not load parameter values to initialize agents." (static data not in repo) |

## 3. Bugs found by testing and fixed

| Found by | Problem | Fix |
|---|---|---|
| Asset pipeline check | Stripped animations left orphan samplers → files stayed 3.6 MB | Dispose samplers/channels explicitly; characters now ≈0.5 MB |
| Unit test | A chest blocked the north gate | Moved it in `generate-map.mjs` |
| First browser run | CSP blocked GLB-embedded textures (`blob:`) and the SpacetimeDB SDK's generated serializers (`Function()`) | `connect-src` allows `blob: data:`; `script-src` allows `'unsafe-eval'` (documented) |
| E2E | Input was only processed once per rendered frame → lost inputs at low FPS | Movement/attacks are sent on the input event itself |
| E2E | Knight died to enemies behind the keep wall | Server line-of-sight checks for aggro and for enemy/player attacks |
| E2E | Touch auto-aim used the predicted position, not the server's | Auto-aim measured from the authoritative position |
| E2E | Class picker on a new device ran before the transferred character row arrived | Picker waits briefly for the row |
| Screenshot review | HUD overlapped on 390 px phones | Narrow-screen layout |
| PR review (Codex) | `enter_world` revived a dead player instantly, and leaving/re-entering or switching class healed to full | `rules::reentry`: dead players wait for the respawn timer; re-entry and class switches keep the health fraction (unit-tested) |
| PR review (Codex) | Account DB created with umask permissions (hashes readable by other local users) | Data dir 0700, `accounts.sqlite` 0600, also applied to existing installs (tested) |
| E2E regression run | Enemies had no obstacle avoidance and could stall on a tree just outside their attack range, making fights (and the combat test) depend on where they snagged | `ArenaMap::steer` tries rotated directions when the direct step is blocked (unit test: gets around a tree); the test's chase loop side-steps when blocked |
| PR review (Codex) | Failed session authorization left the new account behind ("username taken" on retry) | Registration rolled back on that path (tested; both new tests fail on the old code) |
| Screenshot review (shaders) | Half the grass blades were black: a double-sided material flips the normal of back faces, so they were lit from below | Each blade is two triangles of opposite winding, single-sided |
| Screenshot review (shaders) | Campfire flames were pale squares: an alpha bias added in the port kept the quad corners opaque | Alpha erosion now matches the original (`noise × mask − age`); flames sit on top of the log pile and skip tone mapping |
| Screenshot review (shaders) | A felled tree kept its outline until the next HUD refresh | The outline is cleared whenever resource nodes change |
| Screenshot review (HDR) | The x-ray silhouette, in HDR cyan, bloomed into a white haze that hid the hero whenever a tree was in front | The x-ray stays below the bloom threshold; the threshold was raised to 1.5 |
| Screenshot review (HDR) | Wide flashes and buff columns washed the scene out; "steel" effects read as pure white | Wide translucent shapes stay under the threshold (only thin rings, cores and particles glow); steel is a cooler blue-silver; slashes are thin crescents |
| Screenshot review (pets) | The pet nameplate kept the level it was created with | It is refreshed with the HUD |
| E2E | Test skeletons spawned as night wanderers vanished at once in daytime | Tests tie them to a ruin |
| E2E | After the ruin steps the hero could be dead or respawning, so later setup moved a dead hero and every action was refused | Test setup waits for the respawn and heals the hero before each staged scene |
| Code review (rollshade) | Leap and Shadowstep played their effect at the destination: the sim moves the hero at once, and moves read their start anchor every frame | Dashes start from a fixed point where the dash began |
| Code review (rollshade) | Heals flew to a point 2 m ahead instead of onto the hero; pet effects sat 0.25 m underground | Heals target the hero; floors come from the terrain height |
| Code review (rollshade) | Below 20 fps effects ran slower than the sim's wall-clock damage timing (effects clamped to 0.05 s steps) | Effects use the game loop's 0.1 s clamp |
| Code review (rollshade) | Night wanderers vanished instead of burning away; a dodge rippled the shield; statuses were prewarmed only for enemy kinds present at start | Removed enemies dissolve first; "Dodged" is not a shield hit; every kind is prewarmed |

## 4. Not verified here (needs real hardware / hosting)

- **Frame rate and feel on real GPUs/phones.** The container has no GPU; software WebGL ran at ~0.5–2.5 FPS, so smoothness of camera, animation blending and prediction could only be judged from screenshots.
- **Real mobile browsers** (iOS Safari, Android Chrome); only Chromium's mobile emulation with touch events was used.
- **HTTPS/WSS** behind a real reverse proxy (code paths select `wss://` on HTTPS but were exercised over HTTP only).
- **Load**: only 2–3 concurrent clients were tested. The 20 Hz tick updates every moving row; capacity was not measured.
- **Unreal Engine / Pixel Streaming**: not applicable (no Unreal project exists in the repository).
- **The original BitCraft gameplay**: blocked by missing static data and the closed-source client.

## 5. How to reproduce

```bash
cd web
npm install
spacetime login --server-issued-login local
npm run dev            # or: npm start
# in another shell:
(cd arena-module && cargo test)
npm test               # gateway tests + build + browser E2E (needs SpacetimeDB + module + registered gateway running)
```
Set `CHROMIUM_PATH` if Chromium is not at the Playwright default path used in the container.
