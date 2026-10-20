<p align="center">
    <a href="https://bitcraftonline.com#gh-dark-mode-only" target="_blank">
    <img width="320" src="./images/dark/logo.svg" alt="BitCraft Logo">
    </a>
    <a href="https://bitcraftonline.com#gh-light-mode-only" target="_blank">
    <img width="320" src="./images/light/logo.svg" alt="BitCraft Logo">
    </a>
</p>

<p align="center">
    <a href="https://store.steampowered.com/app/3454650/BitCraft_Online/#gh-dark-mode-only" target="_blank">
    <img width="200" src="./images/dark/steam-button.svg" alt="Play Now">
    </a>
    <a href="https://store.steampowered.com/app/3454650/BitCraft_Online/#gh-light-mode-only" target="_blank">
    <img width="200" src="./images/light/steam-button.svg" alt="Play Now">
    </a>
</p>
<p align="center">
    <a href="https://discord.com/invite/bitcraft#gh-dark-mode-only"><img height="25" src="./images/dark/social/Discord.svg" alt="Discord"></a>
    <a href="https://discord.com/invite/bitcraft#gh-light-mode-only"><img height="25" src="./images/light/social/Discord.svg" alt="Discord"></a>
    &nbsp;
    <a href="https://twitter.com/BitCraftOnline#gh-dark-mode-only"><img height="25" src="./images/dark/social/X.svg" alt="X"></a>
    <a href="https://twitter.com/BitCraftOnline#gh-light-mode-only"><img height="25" src="./images/light/social/X.svg" alt="X"></a>
    &nbsp;
    <a href="https://www.facebook.com/BitCraftOnline#gh-dark-mode-only"><img height="25" src="./images/dark/social/Facebook.svg" alt="Facebook"></a>
    <a href="https://www.facebook.com/BitCraftOnline#gh-light-mode-only"><img height="25" src="./images/light/social/Facebook.svg" alt="Facebook"></a>
    &nbsp;
    <a href="https://www.instagram.com/bitcraftonline/#gh-dark-mode-only"><img height="25" src="./images/dark/social/Instagram.svg" alt="Instagram"></a>
    <a href="https://www.instagram.com/bitcraftonline/#gh-light-mode-only"><img height="25" src="./images/light/social/Instagram.svg" alt="Instagram"></a>
    &nbsp;
    <a href="https://www.tiktok.com/@bitcraftonline#gh-dark-mode-only"><img height="25" src="./images/dark/social/TikTok.svg" alt="TikTok"></a>
    <a href="https://www.tiktok.com/@bitcraftonline#gh-light-mode-only"><img height="25" src="./images/light/social/TikTok.svg" alt="TikTok"></a>
    &nbsp;
    <a href="https://bsky.app/profile/bitcraftonline.bsky.social#gh-dark-mode-only"><img height="25" src="./images/dark/social/BlueSky.svg" alt="BlueSky"></a>
    <a href="https://bsky.app/profile/bitcraftonline.bsky.social#gh-light-mode-only"><img height="25" src="./images/light/social/BlueSky.svg" alt="BlueSky"></a>
    &nbsp;
</p>

This repository contains the **server-side code** for **BitCraft**, a community sandbox MMORPG developed by Clockwork Labs.

BitCraft blends cooperative gameplay, city-building, crafting, exploration, and survival — all in a single seamless world shared by players around the globe.
This repository represents the first phase of our open source initiative. It is being made available for public inspection, experimentation, and contribution.

In this first phase we are only open sourcing the server side code. You can read more about our decision to open source the game here:
- [Open Sourcing BitCraft Online](https://bitcraftonline.com/news/open-sourcing-bitcraft-online)
- [BitCraft Open Sourcing Update](https://bitcraftonline.com/news/bitcraft-open-sourcing-update)

## Web prototype in this fork: KayKit Arena (`web/`)

> **Not BitCraft, and not affiliated with Clockwork Labs.** The BitCraft client is closed source and the game's static data is not public, so the real game cannot be played from this repository (details in [PROJECT_AUDIT.md](./PROJECT_AUDIT.md)). `web/` adds a separate, original, browser-playable multiplayer prototype built on the **same server stack** (SpacetimeDB 2.10, Rust module, server-authoritative reducers and scheduled agents, external login service), with free CC0 [KayKit](https://github.com/KayKit-Game-Assets) art.

| | |
|---|---|
| What you get | Top-down 3D action RPG: 4 hero classes, skeleton enemies with AI, melee + ranged combat, health, death/respawn, potions and gold, leaderboard, login/registration, HUD, minimap, keyboard/mouse and mobile touch controls, live multiplayer. |
| Server | `web/arena-module` (SpacetimeDB module) + `web/gateway` (Node: REST auth, health, static hosting, allow-listed WebSocket proxy) |
| Client | `web/client` (TypeScript, Vite, three.js, SpacetimeDB SDK) |

### Quick start

Prerequisites: Node.js ≥ 22.13, Rust with `rustup target add wasm32-unknown-unknown`, and the [SpacetimeDB CLI 2.10.x](https://spacetimedb.com/install).

```bash
cd web
npm install
spacetime login --server-issued-login local   # once: an identity for your local SpacetimeDB
npm run dev      # starts SpacetimeDB (if needed), publishes the module, runs the gateway + Vite → http://127.0.0.1:5173
# or
npm start        # production-style: builds the client and serves everything from the gateway → http://127.0.0.1:8080
```

Health check: `curl http://127.0.0.1:8080/api/health`. Tests: `npm test` in `web/` (gateway unit + integration tests, then the browser end-to-end test), `cargo test` in `web/arena-module`.

Controls: **WASD/arrows** move, **click/Space** attack (mouse aims), **Q** potion, **I** inventory, **L** leaderboard, **Esc** menu. On phones: left virtual joystick, ⚔ attack (auto-aims), 🧪 potion.

Documentation: [PROJECT_AUDIT.md](./PROJECT_AUDIT.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [TEST_REPORT.md](./TEST_REPORT.md) · [KAYKIT_ASSET_INVENTORY.md](./KAYKIT_ASSET_INVENTORY.md) · [ASSET_CREDITS.md](./ASSET_CREDITS.md)

### Single-player page (no server)

`npm run build:offline` in `web/` builds a version where the arena rules run in the browser (`client/src/offline/sim.ts`, a port of the module's reducers and `world_tick`). The result in `web/client/dist-offline/` is a static page that needs no server; `artifact.html` is the same page for hosts that wrap pages in their own document (it is published as a claude.ai page). There is no login and no multiplayer; progress is kept in the browser. Test it with `npm run test:offline`.

### Share a public test link from your computer

Uses a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no account). It only exposes the gateway; SpacetimeDB stays on localhost.

1. Install `cloudflared` (macOS `brew install cloudflared`, Windows `winget install --id Cloudflare.cloudflared`, Linux/WSL: [release binary](https://github.com/cloudflare/cloudflared/releases)).
2. Put `TRUST_PROXY=1` in `web/.env`, so login rate limits apply per visitor.
3. Terminal 1: `spacetime start --listen-addr 127.0.0.1:3000`
4. Terminal 2 (in `web/`): `npm start`
5. Terminal 3 (in `web/`): `npm run tunnel`, then share the printed `https://….trycloudflare.com` address.

The link stays the same while the tunnel runs, so to update the game run `git pull` and restart `npm start` in terminal 2. The link stops working when you close the tunnel or your computer sleeps. For an always-on server, see the deployment section of [ARCHITECTURE.md](./ARCHITECTURE.md).

### Building the original BitCraft server modules locally

```bash
cd BitCraftServer/packages/game && spacetime build          # ~5 min, produces target/wasm32-unknown-unknown/release/bitcraft_spacetimedb.wasm
spacetime publish -s local --bin-path target/wasm32-unknown-unknown/release/bitcraft_spacetimedb.wasm bitcraft-local-1
cd ../global_module && spacetime build && spacetime publish -s local bitcraft-local-global
```

This was verified to build, publish and run `init` / `generate_flat_world`; gameplay needs the unpublished static data. Keep such databases on localhost: with the default `dev` config every identity has admin rights.

## About BitCraft

BitCraft is a community-driven MMORPG where players collaborate to shape a procedurally generated world. There are no fixed classes or roles — instead, players build, craft, explore, trade,
and govern together to shape their civilizations.

- Game website: [https://bitcraftonline.com](https://bitcraftonline.com)  
- Steam page: [https://store.steampowered.com/app/3454650/BitCraft_Online/](https://store.steampowered.com/app/3454650/BitCraft_Online/)

## About This Repository

This repository contains the code for running a BitCraft server. It includes game logic, state management, and server-side systems, but does not yet include the client or tools required to connect to the official game.

The server for BitCraft is built on [SpacetimeDB](https://spacetimedb.com), a real-time, reactive, backend platform designed for multiplayer game development.
The BitCraft server is structured as a SpacetimeDB module, all the data is stored in spacetimeDB `tables` and all the logic runs inside `reducers`.

The source code for SpacetimeDB itself is also [available on GitHub](https://github.com/clockworklabs/SpacetimeDB). If you're interested in learning bout SpacetimeDB, please give the repo a star!

If you're interested in exploring the server or trying to run a minimal version locally, start with the spacetimeDB documentation:

- [SpacetimeDB Docs](https://spacetimedb.com/docs)

## Contributing

We welcome contributions that improve correctness, stability, or player experience.

Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on contribution scope and process.

## Reporting Exploits

We truly appreciate any reporting of in game exploits. To ensure that exploits are addressed quickly and not abused by other players, we ask that you submit them to us privately using 
[**this form**](https://docs.google.com/forms/d/e/1FAIpQLSdlQMdxjTmUScKeVL9T-rs7lZOU4VrYl80ida0Kb0d38Nah8w/viewform?usp=sharing&ouid=112232658922648279400).

Accounts that report meaningful, previously unreported, and verified exploits will receive a unique in-game reward that cannot be obtained through normal gameplay.

## License

The BitCraft source code is licensed under the Apache 2.0 license. See [LICENSE](./LICENSE) for license details. The license applies only to the contents of this repository. It doesn't extend to any other assets or code that is not part of BitCraftPublic. For more information see [NOTICE](./NOTICE).

## What you can and cannot do

To avoid any confusion, here is a clear summary what is allowed and what is not allowed:

You can:
- Read and study the code to better understand how the game works
- Modify and experiment with the code locally
- Run your own servers for experimentation
- Use it as a reference for building your own projects
- Make a game similar to BitCraft with your own IP (art and themes) using our code as a basis

You cannot:
- Use BitCraft’s art, game content, music, or other protected assets
- Use BitCraft’s IP or present forks as official
- Share information about any discovered exploits in the game with anyone other than us
- Operate official, unofficial, private or any otherwise competing BitCraft servers
- Do anything that violates the open source license

The game’s assets and IP remain protected, and the official BitCraft servers will continue to be operated by us.

For more information see [NOTICE](./NOTICE).

This repository is released as part of our commitment to openness and long-term collaboration with the community. It is not connected to the live game infrastructure, and any changes here will not affect the official BitCraft servers.
