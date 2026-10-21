# Architecture

This repository now contains two independent things:

1. **`BitCraftServer/`** — the upstream BitCraft server modules (unchanged). They build and publish to SpacetimeDB 2.10 but cannot run gameplay without proprietary static data (see PROJECT_AUDIT.md).
2. **`web/`** — *KayKit Arena*, a browser-playable multiplayer prototype built on the same server technology and patterns.

## KayKit Arena overview

```
 Browser (desktop / mobile)
 ├─ three.js renderer, KayKit GLB assets         static files   ┐
 ├─ REST: /api/auth/*, /api/health, /api/leaderboard ───────────┤  HTTPS (TLS terminated by your reverse proxy)
 └─ WebSocket: /v1/database/kaykit-arena/subscribe ─────────────┤
                                                                ▼
                                    ┌──────────────── gateway (Node 22) :8080 ─────────────────┐
                                    │ static host (gzip, CSP)   REST API   allow-listed proxy  │
                                    │ accounts.sqlite (scrypt)  SpacetimeDB identity + token   │
                                    └───────┬───────────────────────────────┬──────────────────┘
                     authorize_session(identity, username)    /v1/identity*, /v1/database/<db>/subscribe
                     SQL read (leaderboard)                   (everything else under /v1 → 403)
                                            ▼                               ▼
                                    ┌──────────── SpacetimeDB 2.10 (127.0.0.1:3000) ───────────┐
                                    │ module "kaykit-arena" (web/arena-module, Rust → wasm)    │
                                    │ tables: player, enemy, pickup, combat_event, world        │
                                    │         (public) · account_session, gateway, admin,      │
                                    │         player_input, tick_timer (private)                │
                                    │ world_tick: scheduled every 50 ms                         │
                                    └───────────────────────────────────────────────────────────┘
```

The browser never talks to SpacetimeDB directly: SpacetimeDB is bound to localhost and the gateway forwards only the endpoints a game client needs. Publishing, HTTP reducer calls, SQL, logs and database deletion are refused with 403 at the gateway (and require the owner's token in SpacetimeDB anyway).

## Mapping to the BitCraft architecture

| BitCraft (`BitCraftServer/`) | KayKit Arena (`web/`) |
|---|---|
| SpacetimeDB module(s), all state in tables | `arena-module`, same SpacetimeDB version (2.10.0) |
| Reducers validate player intents (`player_move` checks speed/terrain/timestamps) | Reducers accept *intents only* (`set_input` direction, `attack` facing); positions are computed by the server |
| Scheduled agents (`src/agents/*`, e.g. `player_regen_agent`) | `world_tick` scheduled reducer (movement, AI, respawns, pickups) |
| External login server writes `user_authentication_state`; 24 h validity | `gateway` calls `authorize_session`; `account_session` valid 24 h |
| `ServerIdentity::validate_server_or_admin` for internal reducers | `world_tick` rejects any caller except the database identity; `register_gateway` is admin-only; `authorize_session` is gateway-only |
| Static data (`*_desc` tables) | `web/shared/map.json` (embedded with `include_str!`) and `rules.rs` constants |

## Authentication flow

```
Browser                         Gateway                               SpacetimeDB / module
  │ WebSocket connect (no token) ─────────── proxied ──────────────────► issues identity I + token T (ES256 JWT)
  │◄────────────────────────────────────────────────────────────────── T  (stored in localStorage)
  │ POST /api/auth/login {username, password, identityToken: T}
  │──────────────────────────────►│ rate-limit per IP, validate input
  │                               │ verify T signature with SpacetimeDB public key → identity I
  │                               │ scrypt-verify password (accounts.sqlite)
  │                               │ call authorize_session(I, username) with the gateway's own token ─►│ checks caller ∈ gateway table
  │◄──────────────────────────────│ 200 {username, identity}                                          │ binds I ↔ account (moves an
  │ reducers: enter_world, set_input, attack, use_potion  ─── WebSocket ──────────────────────────────►│ existing character to I)
```

- Passwords exist only in the login request body and as salted scrypt hashes in `web/.data/accounts.sqlite`.
- The SpacetimeDB identity token proves which identity the browser holds; it is the session credential for the WebSocket (standard SpacetimeDB client practice). "Log out" deletes it from the browser.
- The gateway's own token (`web/.secrets/gateway-token`, mode 600, git-ignored) is the only credential able to authorize sessions. If it leaks: delete the file, restart the gateway, run `scripts/register-gateway.sh`, and remove the old identity from the `gateway` table.

## Gameplay simulation (server-authoritative)

| Concern | Where | Rule |
|---|---|---|
| Movement | `world_tick` → `tick_players` | `position += normalize(input) × class speed × dt`, collision via `slide()` against `map.json` boxes/circles and arena bounds; inputs older than 1 s are ignored (no runaway on disconnect). |
| Player attack | `attack` reducer | Cooldown per class; melee = range + cone (`attack_hits`), mage = 10 m line, first target only; line-of-sight through walls required; 12 % crit ×2; kills award gold. |
| Enemy AI | `tick_enemies` | Aggro on visible players within range, leash 18 m from spawn, never target players inside the camp; chase with collision, steering around trees/pillars when the direct step is blocked (no full pathfinding); attack on cooldown with LOS; return home and heal when idle; respawn after 12 s. |
| Death / respawn | `damage_player`, `tick_players`, `enter_world` | Dead for 5 s, then respawn at a free camp spawn with full HP. `enter_world` refuses dead characters until the timer has passed, and re-entering or switching class keeps the health fraction (no free heals). |
| Pickups | `tick_pickups` | Proximity pickup (1.3 m), potions +1 / gold +10, respawn after 20 s. |
| Items | `use_potion` | Server checks count and full-health. |

Clients **cannot** set position, health, gold, kills or cooldowns: those columns are only written by reducers, and every reducer checks the caller's session.

## Client networking

- **Subscriptions:** `player`, `enemy`, `pickup`, `combat_event`, `world` (all small). Row callbacks drive the scene.
- **Input:** sent on change (event-driven, not frame-driven) plus a 300 ms heartbeat while moving; quantised to 0.01.
- **Prediction / reconciliation:** the local hero moves immediately with the same `slide()` code (`client/src/map.ts`, a port of `map.rs`); errors > 3 m snap, otherwise the predicted position converges to the server's (fully when idle, only for large errors while moving, since the server trails by ~1 RTT).
- **Remote entities:** exponential smoothing towards the latest server position (no fixed interpolation buffer).
- **Animations:** `attack_seq` / `hit_seq` counters on rows trigger one-shot clips, so no event table is needed for them; `combat_event` rows (trimmed to 5 s) drive damage numbers and the kill feed.
- **Connection status & reconnection:** status pill in the HUD; exponential backoff 1 s → 15 s; on reconnect the scene is rebuilt from the client cache. A token from a different server instance is discarded automatically.

## Hearthwild (open world, single-player)

| File | Role |
|---|---|
| `openworld/noise.ts` | Seeded simplex/fbm/ridged noise and a hash RNG. |
| `openworld/terrain.ts` | `WorldGen`: island heightmap (fbm hills + ridged mountains, island falloff, flattened village), biomes, flat-shaded 64 m terrain chunk meshes, deterministic resource nodes per chunk, the village layout and 10 ruins with spawns and chests. Pure functions of the seed. |
| `openworld/content.ts` | All game data: items, recipes (including gear outputs), structures, trade skills with the XP curve, resource nodes, tool bonuses and enemy stats. Also the stats gear and buffs can change, element colours (CSS for icons, linear HDR for effects), gear bases and rarities, the 16 class skills, and the 4 pet species with their auras and skills. Skill effects are one data type (nova, cone, bolt, dash, meteor, chain, buff, heal, taunt) shared by players and pets. |
| `openworld/sim.ts` | `OpenWorld`: the rules. Covers collision (water, village and ruin props, built structures including rotated walls, standing resource nodes), gathering (timed hits, tool and skill speed, depletion and regrowth), crafting, building validation, combat, enemy AI (aggro, leash, steering), night wanderers, regeneration, death and respawn at your home, loot chests and saving. It runs on a 50 ms timer with timestamped input, like the arena's offline simulation. On top of that:

- **Stats** add up gear, buffs and the pet's aura.
- **Skill effects** (`cast`) are shared by your skills and your pet's.
- **Status effects** on enemies: stun, slow, burn, taunt and pet aggro.
- **Combat feel:** knockback, the three-hit combo and the dodge roll with i-frames.
- **Gear:** rolls, drops, crafting quality, equip and salvage.
- **Pet AI:** heel, target what you fight, use skills when it makes sense, get knocked out and recover.
- **Pet XP** comes from your kills. |
| `openworld/render.ts` | `WebGPURenderer` (WebGPU, or its WebGL2 fallback) and rollshade's `FXSystem`, which renders the frame with bloom and camera shake. Chunk streaming (2 chunks built per frame, nearest first), instanced resources, buildings and structures (one draw call per model part), water, sun/moon and sky colour by time of day, campfire flames (rollshade loops on the six nearest campfires, sharing its fixed pool of four lights), the build-placement ghost and terrain picking. `init()` compiles every rollshade effect behind the loading bar. |
| `openworld/shaders.ts` | Effects ported from GDQuest's Godot Shaders (MIT), written in TSL as node materials (`positionNode`, `emissiveNode`, `colorNode`), so lighting, fog and shadows keep working: tree wind (the shadow pass reuses the same `positionNode`, so shadows sway too), grass wind and the push away from the hero, the iron-vein fresnel glow, water (depth from a heightmap texture instead of the depth buffer) and the interact outline. Per-instance origins for the wind seed and the grass push come from a second view of each `InstancedMesh`'s matrix buffer. The x-ray is a second copy of the hero drawn with an inverted depth test between the scene and the hero; the copies carry rollshade's overlay tag so statuses leave them alone. Enemies share one node material per source material whose emissive adds a per-mesh hit flash, read per draw. One clock, one generated noise texture and the hero's position are shared by all effects. |
| `audio.ts` | Procedural Web Audio: a bus mixer (music, effects, ambience) feeding a limiter. Generative music is scheduled 250 ms ahead: a pad, bass and a random-walk melody, in D major by day and A minor at night, with a drum layer faded in during fights. It also plays wind, birds and crickets and synthesizes about 20 effects. Effects fade over 30 m from the hero. It starts on the Play click, because browsers block sound before a gesture, and pauses while the tab is hidden. |
| `openworld/spells.ts` | Game events to rollshade calls. Each skill plays the move `SKILL_LOOKS` (content.ts) names, from the caster's chest anchor to the target. Basic swings, combo finishers, dodges and sprite-pet shots are moves too. Enemy burn, slow and stun are kept in step with the sim as statuses (`burn`, a partial `freeze`, `stun`), never restarted while they run. The hero's shield is the `shield` status and the newest buff an `aura` loop. Deaths `dissolve` and respawns `appear`. Status looks are compiled per kind of model while loading. |
| `openworld/petview.ts` | Pets on screen. The squire is an animated, scaled KayKit skeleton; the sprites are procedural glowing spirits. |
| `openworld/icons.ts` | SVG icons drawn from 32 glyphs on element-coloured tiles, with rarity frames for gear. |
| `openworld/main.ts` | Start screen (continue or new hero), game loop, input, HUD, the hotbar, buffs and pet vitals, the minimap and all panels (inventory, crafting, build, character/gear, skills, pets, map, menu). It also maps world events to sounds and effects, and handles hit-stop (our animations and rollshade's effects freeze together), camera shake (through rollshade) and enemy hit flashes. |

Only changes are saved (player, depleted nodes, structures, chest timers): the untouched world regenerates from the seed. The rules are plain data plus functions with time passed in, so they can move into a SpacetimeDB module for multiplayer the same way the arena's did.

### HDR rendering

rollshade's post pass (`post: { bloom: 'scene' }`) renders the scene into a half-float target, so colours above 1.0 survive. It blooms anything brighter than 1.5, a threshold sunlit terrain does not reach, and the renderer tone-maps the result (ACES) to sRGB once at the end. The pass also adds a light vignette, a little chromatic aberration and a soft brightness knee, which rollshade has no switch for. Effects, ore glow, the outline and pets use HDR colours, so only they glow. The bloom setting in the menu sets the bloom strength to 0. The post pass itself stays, because it also carries the camera shake.

### Spell effects and timing

rollshade moves have their own timing: a fireball charges and flies for about 0.86 s, a nova about 0.8 s. The sim waits for the move's first hit before it applies damage, using the first-hit times from rollshade's `MOVES` table, copied into `SKILL_LOOKS`. The `pending` queue already used for meteors holds them. Targets are picked when the skill is cast, and damage goes to whoever is in range when the hit lands. rollshade's own automatic hit-stop is off (`hitStopScale: 0`): the game freezes only when a spell's first hit lands near a living enemy, and then both clocks freeze together.

## Single-player build

`OFFLINE=1 vite build` (`npm run build:offline`) swaps the backend at build time: `client/src/backend.ts` defines the interface, `net.ts` implements it over SpacetimeDB, and `offline/backend.ts` + `offline/sim.ts` implement it in the browser with the same rules as the module (movement and collision, enemy AI with steering and line of sight, combat, respawns, pickups, the re-entry rule). The simulation exposes the same table callbacks and reducer calls the game reads from a SpacetimeDB connection, so rendering and input code are shared. Differences from the server: one player, no accounts (a hero name and progress are kept in `localStorage`), and time is replayed in 50 ms steps with timestamped input so movement does not depend on frame rate. The bundle contains neither the SpacetimeDB SDK nor `eval`. For page hosts that serve only standard web file types and block `fetch` of `blob:` URLs (claude.ai), models ship as base64 JSON and embedded textures are decoded through `<img>`.

## Rendering & performance

- ~300 static props drawn with one `InstancedMesh` per (model, sub-mesh).
- Assets: 47 GLBs, 5.65 MiB (≈2.5–3 MiB gzip), loaded with 6 parallel requests and a progress bar.
- Mobile: no antialiasing, pixel ratio ≤ 1.5, shadows off by default, no point lights, wider FOV in portrait.
- JS bundle: three.js 149 KB gzip, app 32 KB, SpacetimeDB SDK 27 KB (separate chunks, immutable cache headers).
- Known cost: each character is ~10 skinned sub-meshes (≈240 draw calls with all 22 characters visible).

## Security summary

| Area | Measure |
|---|---|
| Secrets | None in the repo or frontend. `.env`, `.secrets/`, `.data/` are git-ignored; `.env.example` has placeholders only. The gateway token file is 0600, the account data directory 0700 and `accounts.sqlite` 0600. |
| Admin surface | SpacetimeDB on localhost; gateway proxy allow-list; owner-only `register_gateway`; database identity-only `world_tick`. |
| Input validation | Gateway: username regex, password length, JSON body ≤ 16 KB, content-type check, per-IP rate limit on auth. Module: finite-number checks, vector clamping, class whitelist, username regex, session check on every gameplay reducer. |
| Browser hardening | CSP (`script-src 'self' 'unsafe-eval'` — the eval is required by the SpacetimeDB SDK's generated serializers), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. |
| CORS | `/api` allows same-origin plus `ALLOWED_ORIGINS`; cross-origin requests are rejected (403), which also blocks login CSRF. |
| HTTPS | Terminate TLS in a reverse proxy in front of the gateway; set `TRUST_PROXY=1` there so rate limiting sees client IPs. WebSockets then use `wss://` automatically. |

## Deployment (not performed)

No public deployment was made from this session (none was authorised, and the container is ephemeral). A minimal single-host setup:

1. Install SpacetimeDB 2.10.x, Node 22.13+, Rust + `wasm32-unknown-unknown`.
2. `cd web && npm ci && npm run build`.
3. Run SpacetimeDB bound to `127.0.0.1:3000` as a service; `spacetime login --server-issued-login local`; `spacetime publish -s local -p arena-module kaykit-arena`.
4. Run the gateway as a service (`node --disable-warning=ExperimentalWarning gateway/src/index.js`, env from `.env`), then `scripts/register-gateway.sh` once.
5. Put Caddy/nginx with TLS in front of `127.0.0.1:8080` (WebSocket upgrade enabled), set `TRUST_PROXY=1`.
6. Back up the SpacetimeDB data directory and `web/.data/`.

`spacetime publish` without `--delete-data` is non-destructive; schema changes that SpacetimeDB cannot migrate automatically are refused rather than applied.
