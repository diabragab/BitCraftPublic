# Asset Credits

## 3D art — KayKit by Kay Lousberg (CC0 1.0)

All 3D models, textures and animations in the web prototype (`web/client/public/assets/`) are from **KayKit** by **Kay Lousberg** — <https://www.kaylousberg.com>, <https://kaylousberg.itch.io>, GitHub: <https://github.com/KayKit-Game-Assets>.

| Pack | Repository (pinned commit) | License |
|---|---|---|
| KayKit : Adventurers Character Pack 1.0 | [KayKit-Character-Pack-Adventures-1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) @ `672074b73ba276876a19e8816ecdc5241817ab47` | CC0 1.0 |
| KayKit Character Pack : Skeletons 1.0 | [KayKit-Character-Pack-Skeletons-1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0) @ `15b62b9bad122f72926c10fb14d622c73819fa54` | CC0 1.0 |
| KayKit : Dungeon Remastered 1.0 | [KayKit-Dungeon-Remastered-1.0](https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0) @ `b0ca9bd96a8072ab36a3a5464f00ed1e06a16d07` | CC0 1.0 |
| KayKit : Medieval Hexagon Pack 1.0 | [KayKit-Medieval-Hexagon-Pack-1.0](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0) @ `84fa4e91af6a88989be7c99e0891cede11f2ca38` | CC0 1.0 |

CC0 does not require attribution; it is given anyway, as the author requests. The original license texts are preserved verbatim in `web/client/public/assets/licenses/`. Files were optimised (animation clips and unused accessories removed, meshes quantised, converted to GLB) by `web/tools/build-assets.mjs`; `web/client/public/assets/manifest.json` lists the source path of every output file.

Support the author: <http://patreon.com/kaylousberg>.

## Software

| Component | License |
|---|---|
| BitCraft server code (`BitCraftServer/`) | Apache 2.0 — Clockwork Labs (see `LICENSE`, `NOTICE`) |
| SpacetimeDB 2.10 standalone server + CLI (downloaded release binaries, not redistributed) | See the SpacetimeDB repository license — Clockwork Labs |
| `spacetimedb` Rust crate 2.10.0 | Apache 2.0 (crate `LICENSE` file) |
| `spacetimedb` npm package 2.10.0 (TypeScript SDK) | ISC (per its package.json) |
| three.js r186 | MIT |
| Vite 7.1 / TypeScript 5.9 | MIT / Apache 2.0 |
| gltf-transform 4.1 | MIT |
| Playwright 1.56 (tests only) | Apache 2.0 |

## Not used

No BitCraft art, audio, world data, names or logos are used by the web prototype. The `images/` folder (BitCraft logos) belongs to the upstream README only and is governed by the BitCraft Community License in `NOTICE`.
