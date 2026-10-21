// Fetches the selected CC0 KayKit packs from the official GitHub organization
// (https://github.com/KayKit-Game-Assets) at pinned commits, then optimizes the
// files used by the web client into web/client/public/assets.
//
// Usage: node tools/build-assets.mjs [--cache <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, weld, quantize } from '@gltf-transform/functions';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const out = join(webRoot, 'client/public/assets');
const cacheArg = process.argv.indexOf('--cache');
const cache = cacheArg > 0 ? resolve(process.argv[cacheArg + 1]) : join(webRoot, '.kaykit-cache');

export const PACKS = {
  adventurers: { repo: 'KayKit-Character-Pack-Adventures-1.0', sha: '672074b73ba276876a19e8816ecdc5241817ab47', root: 'addons/kaykit_character_pack_adventures' },
  skeletons: { repo: 'KayKit-Character-Pack-Skeletons-1.0', sha: '15b62b9bad122f72926c10fb14d622c73819fa54', root: 'addons/kaykit_character_pack_skeletons' },
  dungeon: { repo: 'KayKit-Dungeon-Remastered-1.0', sha: 'b0ca9bd96a8072ab36a3a5464f00ed1e06a16d07', root: 'addons/kaykit_dungeon_remastered' },
  hexagon: { repo: 'KayKit-Medieval-Hexagon-Pack-1.0', sha: '84fa4e91af6a88989be7c99e0891cede11f2ca38', root: 'addons/kaykit_medieval_hexagon_pack' },
};

// Animation clips the game uses. Everything else is stripped to cut download size.
const PLAYER_CLIPS = ['Idle', 'Running_A', '1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Stab',
  'Spellcast_Shoot', 'Hit_A', 'Death_A', 'Death_A_Pose', 'Cheer',
  // Hearthwild skills
  '1H_Melee_Attack_Slice_Horizontal', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin', 'Dualwield_Melee_Attack_Slice',
  'Spellcast_Raise', 'Spellcast_Long', 'Dodge_Forward', 'Block', 'Jump_Full_Short'];
const ENEMY_CLIPS = ['Idle', 'Running_A', 'Walking_A', '1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Spellcast_Shoot',
  'Hit_A', 'Death_A', 'Death_A_Pose', 'Spawn_Ground_Skeletons'];

const CHARACTERS = [
  // [pack, source file, output name, accessory meshes to keep, clips]
  ['adventurers', 'Characters/gltf/Knight.glb', 'knight', ['1H_Sword', 'Round_Shield'], PLAYER_CLIPS],
  ['adventurers', 'Characters/gltf/Barbarian.glb', 'barbarian', ['2H_Axe'], PLAYER_CLIPS],
  ['adventurers', 'Characters/gltf/Mage.glb', 'mage', ['2H_Staff'], PLAYER_CLIPS],
  ['adventurers', 'Characters/gltf/Rogue.glb', 'rogue', ['Knife', 'Knife_Offhand'], PLAYER_CLIPS],
  ['skeletons', 'Characters/gltf/Skeleton_Minion.glb', 'skeleton_minion', [], ENEMY_CLIPS],
  ['skeletons', 'Characters/gltf/Skeleton_Warrior.glb', 'skeleton_warrior', [], ENEMY_CLIPS],
  ['skeletons', 'Characters/gltf/Skeleton_Rogue.glb', 'skeleton_rogue', [], ENEMY_CLIPS],
  ['skeletons', 'Characters/gltf/Skeleton_Mage.glb', 'skeleton_mage', [], ENEMY_CLIPS],
];
const ACCESSORY_NAMES = new Set(['1H_Sword_Offhand', 'Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield', '1H_Sword',
  '2H_Sword', '1H_Axe_Offhand', 'Barbarian_Round_Shield', '1H_Axe', '2H_Axe', 'Mug', 'Spellbook', 'Spellbook_open', '1H_Wand',
  '2H_Staff', 'Knife_Offhand', '1H_Crossbow', '2H_Crossbow', 'Knife', 'Throwable']);

const WEAPONS = ['Skeleton_Blade', 'Skeleton_Axe', 'Skeleton_Staff', 'Skeleton_Shield_Small_A'];

// Only models referenced by shared/map.json or the client (pickups) are exported.
const DUNGEON = ['floor_tile_large', 'floor_dirt_large', 'floor_tile_large_rocks', 'wall', 'wall_cracked', 'pillar', 'column',
  'barrel_large', 'barrel_small_stack', 'box_large', 'box_stacked', 'crates_stacked', 'chest_gold', 'coin_stack_small',
  'bottle_A_green', 'torch_lit', 'banner_patternA_red', 'banner_shield_red', 'rubble_half', 'table_medium_decorated_A',
  'keg_decorated', 'sword_shield', 'candle_triple', 'trunk_large_A'];
const DUNGEON_FILE = (n) => (['chest', 'chest_gold', 'wall_doorway'].includes(n) ? `${n}.glb` : `${n}.gltf.glb`);

const NATURE = ['decoration/nature/trees_A_large', 'decoration/nature/trees_A_medium', 'decoration/nature/trees_B_large',
  'decoration/nature/tree_single_A', 'decoration/nature/tree_single_B', 'decoration/nature/rock_single_A',
  'decoration/nature/rock_single_B', 'decoration/nature/rock_single_C', 'decoration/nature/hills_A_trees',
  'decoration/nature/mountain_A_grass_trees', 'decoration/nature/mountain_B_grass_trees',
  // open world: harvested trees, more rocks, village buildings, placeable structures and props
  'decoration/nature/tree_single_A_cut', 'decoration/nature/tree_single_B_cut', 'decoration/nature/rock_single_D',
  'decoration/nature/rock_single_E', 'decoration/nature/trees_B_medium',
  'buildings/blue/building_home_A_blue', 'buildings/blue/building_home_B_blue', 'buildings/blue/building_blacksmith_blue',
  'buildings/blue/building_well_blue', 'buildings/blue/building_market_blue', 'buildings/blue/building_tavern_blue',
  'buildings/blue/building_windmill_blue', 'buildings/blue/building_tower_A_blue',
  'buildings/neutral/building_destroyed', 'buildings/neutral/fence_wood_straight', 'buildings/neutral/wall_straight',
  'decoration/props/tent', 'decoration/props/resource_lumber', 'decoration/props/resource_stone', 'decoration/props/crate_A_big',
  'decoration/props/barrel', 'decoration/props/flag_blue', 'decoration/props/weaponrack', 'decoration/props/sack',
  'decoration/props/wheelbarrow'];
const NATURE_TEXTURE_DIRS = [...new Set(NATURE.map((n) => n.split('/').slice(0, -1).join('/')))];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
}

function fetchPack(key, paths) {
  const p = PACKS[key];
  const dir = join(cache, p.repo);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir);
    git(['remote', 'add', 'origin', `https://github.com/KayKit-Game-Assets/${p.repo}.git`], dir);
  }
  // Partial clone: only the blobs we check out are downloaded.
  git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', p.sha], dir);
  git(['checkout', '-q', p.sha, '--', ...paths.map((x) => (x.startsWith('/') ? x.slice(1) : `${p.root}/${x}`))], dir);
  return (rel) => join(dir, rel.startsWith('/') ? rel.slice(1) : `${p.root}/${rel}`);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// Drops accessors nothing references any more (stripped animations leave many behind).
function disposeOrphanAccessors(doc) {
  for (const acc of doc.getRoot().listAccessors()) {
    if (acc.listParents().every((p) => p.propertyType === 'Root')) acc.dispose();
  }
}

async function optimize(doc) {
  disposeOrphanAccessors(doc);
  await doc.transform(dedup(), weld(), resample(), prune(), quantize({ quantizeNormal: 10, quantizeTexcoord: 12 }));
  disposeOrphanAccessors(doc);
  return doc;
}

async function writeGlb(doc, file) {
  mkdirSync(dirname(file), { recursive: true });
  await io.write(file, doc);
  return statSync(file).size;
}

const manifest = { generated: new Date().toISOString(), packs: PACKS, files: [] };
const record = (pack, src, dst, bytes) => manifest.files.push({ pack, source: src, output: dst.replace(out + '/', ''), bytes });

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'licenses'), { recursive: true });

// Characters
{
  const adv = fetchPack('adventurers', ['LICENSE.txt', ...CHARACTERS.filter((c) => c[0] === 'adventurers').map((c) => c[1])]);
  const ske = fetchPack('skeletons', ['LICENSE.txt', ...CHARACTERS.filter((c) => c[0] === 'skeletons').map((c) => c[1]),
    ...WEAPONS.flatMap((w) => [`Assets/gltf/${w}.gltf`, `Assets/gltf/${w}.bin`]), 'Assets/gltf/skeleton_texture.png']);
  const resolvers = { adventurers: adv, skeletons: ske };
  for (const [pack, src, name, keep, clips] of CHARACTERS) {
    const doc = await io.read(resolvers[pack](src));
    const root = doc.getRoot();
    for (const anim of root.listAnimations()) if (!clips.includes(anim.getName())) {
      anim.listSamplers().forEach((s) => s.dispose());
      anim.listChannels().forEach((c) => c.dispose());
      anim.dispose();
    }
    for (const node of root.listNodes()) if (ACCESSORY_NAMES.has(node.getName()) && !keep.includes(node.getName())) node.dispose();
    await optimize(doc);
    const dst = join(out, 'characters', `${name}.glb`);
    record(pack, src, dst, await writeGlb(doc, dst));
  }
  for (const w of WEAPONS) {
    const doc = await optimize(await io.read(ske(`Assets/gltf/${w}.gltf`)));
    const dst = join(out, 'weapons', `${w.toLowerCase()}.glb`);
    record('skeletons', `Assets/gltf/${w}.gltf`, dst, await writeGlb(doc, dst));
  }
  copyFileSync(adv('LICENSE.txt'), join(out, 'licenses', 'KayKit-Character-Pack-Adventures-1.0.LICENSE.txt'));
  copyFileSync(ske('LICENSE.txt'), join(out, 'licenses', 'KayKit-Character-Pack-Skeletons-1.0.LICENSE.txt'));
}

// Dungeon environment
{
  const d = fetchPack('dungeon', ['Assets/LICENSE.txt', ...DUNGEON.map((n) => `Assets/gltf/${DUNGEON_FILE(n)}`)]);
  for (const n of DUNGEON) {
    const doc = await optimize(await io.read(d(`Assets/gltf/${DUNGEON_FILE(n)}`)));
    const dst = join(out, 'dungeon', `${n}.glb`);
    record('dungeon', `Assets/gltf/${DUNGEON_FILE(n)}`, dst, await writeGlb(doc, dst));
  }
  copyFileSync(d('Assets/LICENSE.txt'), join(out, 'licenses', 'KayKit-Dungeon-Remastered-1.0.LICENSE.txt'));
}

// Nature (Medieval Hexagon pack)
{
  const h = fetchPack('hexagon', ['LICENSE.txt', ...NATURE_TEXTURE_DIRS.map((d) => `Assets/gltf/${d}/hexagons_medieval.png`),
    ...NATURE.flatMap((n) => [`Assets/gltf/${n}.gltf`, `Assets/gltf/${n}.bin`])]);
  for (const n of NATURE) {
    const doc = await optimize(await io.read(h(`Assets/gltf/${n}.gltf`)));
    const dst = join(out, n.startsWith('decoration/nature') ? 'nature' : 'village', `${n.split('/').pop()}.glb`);
    record('hexagon', `Assets/gltf/${n}.gltf`, dst, await writeGlb(doc, dst));
  }
  copyFileSync(h('LICENSE.txt'), join(out, 'licenses', 'KayKit-Medieval-Hexagon-Pack-1.0.LICENSE.txt'));
}

// Shader code ported from GDQuest's Godot Shaders (MIT): its licence ships with the assets too
copyFileSync(new URL('../client/src/openworld/shaders.LICENSE.txt', import.meta.url), join(out, 'licenses', 'GDQuest-godot-shaders.LICENSE.txt'));
// rollshade (MIT), the spell-effects library bundled into the open world
copyFileSync(new URL('../node_modules/rollshade/LICENSE', import.meta.url), join(out, 'licenses', 'rollshade-0.6.0.LICENSE.txt'));

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = manifest.files.reduce((s, f) => s + f.bytes, 0);
console.log(`Wrote ${manifest.files.length} assets, ${(total / 1024 / 1024).toFixed(2)} MiB total -> ${out}`);
