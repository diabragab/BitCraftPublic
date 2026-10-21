# Project Audit

Audit date: 2026-10-20 · Branch: `claude/stoic-hawking-vsucsf` · Base commit: `3bf2fb7` ("release oct-08")

## 1. What this repository actually is

| Question | Finding |
|---|---|
| Engine | **None in this repo.** It is not an Unreal Engine project (no `.uproject`, `.uasset`, `.umap`, Blueprints, or C++ game code). The official BitCraft client is a **Unity** game that is *not* published here (see `generate-client-files.sh`, which writes C# bindings to `../../../Assets/_Project/autogen`, and `src/game/unity_helpers/`). |
| What is here | The **server-side code of BitCraft Online** (Clockwork Labs), written in Rust as two **SpacetimeDB modules**. |
| Server framework | SpacetimeDB **2.10.0** (`spacetimedb = "=2.10.0"`), compiled to `wasm32-unknown-unknown`. All state lives in SpacetimeDB tables; all logic runs in reducers; periodic systems run as scheduled "agents". |
| Status | A production codebase mirrored by a release bot (38 commits, all "release …" by `bitcraft-release-bot`, latest 2026-10-08). Not a partial project, but **only one half of a game**: no client, no tools, no game data. |
| Uncommitted user work | None. The working tree was clean when the audit started; nothing was moved or deleted. |

### Size

| Package | Rust files | Lines | `#[table]` | `#[reducer]` | Static-data (`*_desc`) tables |
|---|---:|---:|---:|---:|---:|
| `BitCraftServer/packages/game` (region module) | 579 | 84,016 | 420 | 764 | 125 |
| `BitCraftServer/packages/global_module` | 157 | 25,486 | 38 | 405 | 125 (shared definitions) |

### Architecture (as found)

```
 Unity client (not in repo) ──WebSocket (SpacetimeDB protocol)──► region modules  bitcraft-live-1..25   (packages/game)
                                                               └► global module    bitcraft-live-global (packages/global_module)
 Login server (not in repo, TypeScript: "bitcraft-login-server") ─► writes user_authentication_state / roles
 Region ⇄ global communication: inter_module/* reducers
```

- **Gameplay systems present (server side):** movement validation (`player_move.rs`), combat (`attack.rs`), crafting, building, claims, empires, trading, vaults, housing, quests, NPC AI, world generation (`world_gen/`, `dev_island`, `flat_world`), resources regrowth, day/night, duels, chat, moderation; 21 agents in `src/agents`.
- **Networking model:** SpacetimeDB client protocol over WebSocket; clients call reducers and subscribe to SQL queries. Server-authoritative by construction (movement is validated against speed, terrain and timestamps).
- **Authentication model:** an external login service records `user_authentication_state`; `is_authenticated()` accepts an identity for 24 h. **In `env = "dev"` config every identity has every role**, including Admin (`has_role()` returns `true`).
- **Deployment:** GitHub Actions (`.github/workflows/upload-module.yml`, `delete-module.yml`) publish to a SpacetimeDB server using `secrets.SPACETIME_TOKEN`; shell scripts publish 25 regions + 1 global module.

## 2. Maps, characters, Blueprints, assets

- **Maps / Blueprints / Unreal assets:** none exist.
- **Art assets:** only `images/` (logo, Steam button, social icons). These are BitCraft trademarks and may not be reused (see NOTICE).
- **Game data:** none. The 125 `*_desc` static-data tables (items, skills, buildings, NPCs, `parameters_desc`, `parameters_player_move_desc`, …) are loaded at runtime via `stage_*`/`import_*` admin reducers from data that is **not** in the repository and is licensed separately ("world data … balance … procedural data" are excluded from the Apache license by `NOTICE`).

## 3. What was verified in this environment

| Check | Result |
|---|---|
| SpacetimeDB 2.10.0 CLI + standalone downloaded from the official GitHub release | ✅ |
| `spacetime build` of `packages/game` | ✅ 5 m 20 s, 10.8 MB wasm (unoptimised; `wasm-opt` not installed) |
| `spacetime build` of `packages/global_module` | ✅ 3 m 28 s |
| Publish both to a **local** SpacetimeDB (`bitcraft-local-1`, `bitcraft-local-global`) | ✅ `init` ran: "Initialized bitcraft spacetimedb." |
| `generate_flat_world` on the local region module | ✅ 25 terrain chunks created |
| Agents / gameplay | ❌ `ERROR … Could not load parameter values to initialize agents.` — static data missing. `player_move` etc. `unwrap()` static rows and cannot run. |
| A browser client for BitCraft | ❌ none exists (the official client is a native Unity build and not open source) |

## 4. Critical blockers

| # | Blocker | Impact | Status |
|---|---|---|---|
| B1 | **No client in the repository** (Unity, closed source) | The original game cannot be played from this repo at all. | Not fixable here. |
| B2 | **No static game data** (125 tables) | Server boots and generates terrain but players, movement, combat and agents cannot run. | Not fixable without the licensed data; inventing it would be a large design effort and would still not be "the original game". |
| B3 | **Licensing (NOTICE / BitCraft Community License)** | BitCraft art, world data, names and branding may not be used outside the official client; "operate or emulate BitCraft servers" is not granted. | Respected: nothing BitCraft-branded is shipped; the playable prototype is a separate, original game using CC0 KayKit art. The BitCraft modules were only run locally for verification. |
| B4 | **Not Unreal Engine** | Pixel Streaming (Strategy B) is not applicable; it also needs a GPU host. | Strategy C chosen (see IMPLEMENTATION_PLAN.md). |
| B5 | No GPU in the cloud session | Browser tests run with software WebGL (~2–3 FPS); visual/perf testing on real hardware still needed. | Documented in TEST_REPORT.md. |
| B6 | No persistent hosting | The session container is ephemeral; no public deployment was made (and none was authorised). | Deployment steps documented in README/ARCHITECTURE. |

## 5. Security observations (existing code, not changed)

- `packages/game/config/default.json` commits a development cheat password (`cheats.dev_pw`). It is only meaningful for dev config, but it should not be reused anywhere real.
- With `env: "dev"` (the default inserted by `init`), `has_role()` and `is_authenticated()` allow **everything** for **every identity**. Never expose a freshly published BitCraft module to a network before uploading a non-dev config.
- CI publishes with a token from GitHub secrets (good: not committed).

These are reported, not modified: the upstream CONTRIBUTING.md asks for small, focused server PRs, and changing auth defaults is out of scope for this task. Exploits should be reported privately via the form in SECURITY.md.
