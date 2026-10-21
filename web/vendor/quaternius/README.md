# Quaternius packs (to be added)

These packs were requested for Hearthwild, but this project's build machine cannot reach quaternius.com, itch.io or OpenGameArt to download them. Put the downloaded zip files in this folder (as they come, no need to unzip) and the asset pipeline will import them.

| Pack | Use in the game | Page |
|---|---|---|
| Universal Base Characters | player characters | https://quaternius.com/packs/universalbasecharacters.html |
| Modular Character Outfits – Fantasy | outfits for those characters | https://quaternius.com/packs/modularcharacteroutfitsfantasy.html |
| Universal Animation Library 2 | animations (same rig as the base characters) | https://quaternius.com/packs/universalanimationlibrary2.html |
| Bestiary – Dungeon Monsters Kit | enemies | https://quaternius.com/packs/bestiarydungeonmonsterskit.html |
| Stylized Nature MegaKit | trees, rocks, plants for the island | https://quaternius.com/packs/stylizednaturemegakit.html |

Use the free download of each pack and check that its page states the CC0 license; keep any license file that comes in the zip. The glTF/GLB files are the ones the game uses, so a zip that only contains the glTF folder is enough.

**Uploading on GitHub:** open the `claude/stoic-hawking-vsucsf` branch of the repository, go to `web/vendor/quaternius/`, then *Add file → Upload files*. The web uploader takes files up to 25 MB each; for a bigger zip, upload only its glTF/GLB folder, or push it with git from your computer.
