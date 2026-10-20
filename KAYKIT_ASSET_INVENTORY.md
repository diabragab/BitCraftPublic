# KayKit Asset Inventory

Source organisation: <https://github.com/KayKit-Game-Assets> (official GitHub organisation of Kay Lousberg / KayKit).

The GitHub API and web pages for the organisation were not reachable from the build environment (only `git` over HTTPS was allowed), so repositories were discovered by probing known pack names with `git ls-remote`. Repositories confirmed to exist (2026-10-20):

| Repository | HEAD | Used? |
|---|---|---|
| KayKit-Character-Pack-Adventures-1.0 | `672074b` | ✅ |
| KayKit-Character-Pack-Skeletons-1.0 | `15b62b9` | ✅ |
| KayKit-Dungeon-Remastered-1.0 | `b0ca9bd` | ✅ |
| KayKit-Medieval-Hexagon-Pack-1.0 | `84fa4e9` | ✅ (nature props only) |
| KayKit-Prototype-Bits-1.0, KayKit-Halloween-Bits-1.0, KayKit-Furniture-Bits-1.0, KayKit-Restaurant-Bits-1.0, KayKit-City-Builder-Bits-1.0, KayKit-Space-Base-Bits-1.0 | — | ❌ not needed for a fantasy arena |

Not found on GitHub under the probed names: a Forest Nature pack and the Character Animations pack (KayKit distributes those via itch.io). They were **not** downloaded from anywhere else; the animations embedded in the character packs were sufficient, and forest props come from the Medieval Hexagon pack.

## License verification

Every used repository contains `LICENSE.txt` stating **Creative Commons Zero (CC0 1.0)** — "free to use in personal, educational and commercial projects", attribution not required. Only the free files in these public repositories were used; no EXTRA/SOURCE (paid) tier content was used or claimed. The original license files are copied to `web/client/public/assets/licenses/`.

## Pipeline

`web/tools/build-assets.mjs` (run with `npm run assets` in `web/`):

1. Partial-clones each repository at the **pinned commit** above (`--filter=blob:none`, so only the needed files are downloaded).
2. Character GLBs: keeps only the 10 animation clips the game uses (of 76–95), removes accessory meshes the class does not use, then `dedup → weld → resample → prune → quantize`.
3. Props (`.gltf.glb`, `.gltf + .bin + .png`): same optimisation, converted to single `.glb` files.
4. Writes `web/client/public/assets/manifest.json` (source path → output, sizes).

Result: **≈30 MB of source files → 6.8 MB** (72 files) on disk, and roughly half that over the wire (the gateway serves gzip; e.g. `knight.glb` 521 KB → 204 KB).

## Selected files

| Category | Pack | Files (output names) | Notes |
|---|---|---|---|
| Player characters (rigged, animated) | Adventurers | `characters/knight`, `barbarian`, `mage`, `rogue` | Rogue_Hooded skipped. Clips kept: Idle, Running_A, 1H/2H melee chop, Dual-wield stab, Spellcast_Shoot, Hit_A, Death_A, Death_A_Pose, Cheer. |
| Enemies (rigged, animated) | Skeletons | `characters/skeleton_minion`, `skeleton_warrior`, `skeleton_rogue`, `skeleton_mage` | Clips additionally include Walking_A and Spawn_Ground_Skeletons. |
| Weapons / equipment | Skeletons | `weapons/skeleton_blade`, `skeleton_axe`, `skeleton_staff`, `skeleton_shield_small_a` | Attached to `handslot.r` / `handslot.l` bones at runtime. Player weapons are part of the Adventurers character files. |
| Dungeon environment | Dungeon Remastered | floors (`floor_tile_large`, `floor_dirt_large`, `floor_tile_large_rocks`), walls (`wall`, `wall_cracked`), `pillar`, `column`, `rubble_half`, `banner_patternA_red`, `banner_shield_red`, `torch_lit`, `candle_triple` | 4×4 m modules; used unscaled. |
| Medieval props | Dungeon Remastered | `barrel_large`, `barrel_small_stack`, `box_large`, `box_stacked`, `crates_stacked`, `chest_gold`, `table_medium_decorated_A`, `keg_decorated`, `trunk_large_A`, `sword_shield` | |
| Pickups / resources | Dungeon Remastered | `bottle_A_green` (health potion), `coin_stack_small` (gold) | |
| Forest, rocks, terrain decoration | Medieval Hexagon | `tree_single_A/B`, `trees_A_large`, `trees_A_medium`, `trees_B_large`, `rock_single_A/B/C`, `hills_A_trees`, `mountain_A/B_grass_trees` | Authored for 2 m hex tiles; scaled 2.5–9× in the map. |
| Open-world village and buildings | Medieval Hexagon | `village/building_home_A_blue`, `building_home_B_blue`, `building_blacksmith_blue`, `building_well_blue`, `building_market_blue`, `building_tavern_blue`, `building_windmill_blue`, `building_tower_A_blue`, `building_destroyed` (ruins) | Scaled ×4.5–6.5; the blacksmith doubles as the player-built forge, home A as the player house. |
| Open-world placeables and props | Medieval Hexagon | `village/fence_wood_straight`, `wall_straight`, `tent`, `resource_lumber` (campfire base), `resource_stone`, `crate_A_big`, `barrel`, `flag_blue`, `weaponrack`, `sack`, `wheelbarrow` | Scaled ×3–6. |
| Open-world harvesting | Medieval Hexagon | `nature/tree_single_A_cut`, `tree_single_B_cut` (felled trees), `rock_single_D`, `rock_single_E` (also tinted as iron veins), `trees_B_medium` | |
| UI | — | none | KayKit has no free UI pack in these repos; the HUD is HTML/CSS and class portraits are rendered at runtime from the character models. |

## Compatibility checks

| Check | Result |
|---|---|
| Scale | Characters ≈2.5 m tall; dungeon tiles 4 m — used 1:1. Hexagon nature scaled per prop in `shared/map.json`. |
| Textures / materials | One small gradient atlas per pack (14–17 KB PNG), embedded in each GLB; standard PBR materials load in three.js without changes. |
| Animations | All characters share the same 41-joint rig; clips play through `THREE.AnimationMixer` (verified in browser). |
| Performance | Static props are drawn with `InstancedMesh` (≈300 placements); characters are ~10 skinned sub-meshes each (merge is a listed follow-up). |
| Loading | All 51 files load with zero 404s/console errors (E2E "all game assets load" step). |
