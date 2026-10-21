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

## Shader code: GDQuest "Godot Shaders" (MIT)

The effects in `web/client/src/openworld/shaders.ts` are ports, from Godot's shading language to three.js GLSL, of shaders in [gdquest-demos/godot-shaders](https://github.com/gdquest-demos/godot-shaders) @ `05a3931acc85513b67b80b6e88671a596a3f9693`: `water_3d`, `foliage_wind_tree_leaves`/`_trunk`, `wind_grass`, `dissolve`, `stylized_fire` (itself based on Minionsart's stylized fire), `outline3D` with its smooth-normals variant, `fresnel_crystal`, `force_field` (the shield bubble, in `vfx.ts`) and the x-ray idea of `xray_3d_mask`/`xray_glow`. Their source code is MIT-licensed, Copyright (c) 2020-present GDQuest. The licence text sits next to the code in `shaders.LICENSE.txt` and ships with the game as `assets/licenses/GDQuest-godot-shaders.LICENSE.txt`, and the copyright line is kept in the shipped JavaScript.

That repository's **art** (textures, models) is CC-BY-NC-SA 4.0, a non-commercial licence, and **none of it is used**. Every noise texture the shaders read is generated in code at runtime.

## Icons and effects

The skill, gear, pet and buff icons (`web/client/src/openworld/icons.ts`) are original SVG drawings made for this project. The combat effects in `vfx.ts` and the pet sprites in `petview.ts` are made from code (meshes, particles and shaders) with no image files. The Skeleton Squire pet reuses the KayKit skeleton minion.

## Audio

There are no audio files. The music, ambience and sound effects are synthesized at runtime by `web/client/src/audio.ts` (Web Audio API) and are original to this project.

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

The Quaternius packs requested for Hearthwild have not been imported, because quaternius.com, itch.io and OpenGameArt cannot be reached from the build machine. See `web/vendor/quaternius/README.md` for how to add them. The packs are Universal Animation Library 2, the Bestiary Dungeon Monsters Kit, Universal Base Characters, Modular Character Outfits Fantasy and the Stylized Nature MegaKit.

No BitCraft art, audio, world data, names or logos are used by the web prototype. The `images/` folder (BitCraft logos) belongs to the upstream README only and is governed by the BitCraft Community License in `NOTICE`.
