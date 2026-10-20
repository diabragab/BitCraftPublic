//! KayKit Arena: a small server-authoritative action-RPG module for SpacetimeDB.
//!
//! It follows the same architecture as the BitCraft server modules in
//! `BitCraftServer/packages`: all state lives in tables, clients only call
//! reducers to express intent (movement input, attack, use item), and a
//! scheduled "agent" reducer advances the simulation. Like BitCraft, a trusted
//! login service (here `web/gateway`) authorizes identities before they may play.

pub mod map;
pub mod rules;

use std::time::Duration;

use spacetimedb::{log, Identity, ReducerContext, ScheduleAt, Table, Timestamp};

use map::map;
use rules::*;

// ---------------------------------------------------------------- tables

/// Identities allowed to administer the module (the publisher is added on init).
#[spacetimedb::table(accessor = admin)]
pub struct Admin {
    #[primary_key]
    pub identity: Identity,
}

/// Identities of trusted login gateways that may authorize player sessions.
#[spacetimedb::table(accessor = gateway)]
pub struct Gateway {
    #[primary_key]
    pub identity: Identity,
}

/// Which account an identity has been authorized for (written by the gateway only).
#[spacetimedb::table(accessor = account_session)]
pub struct AccountSession {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    pub username: String,
    pub authorized_at: Timestamp,
}

#[spacetimedb::table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    pub username: String,
    pub class: String,
    pub x: f32,
    pub z: f32,
    pub facing: f32,
    pub moving: bool,
    pub hp: i32,
    pub max_hp: i32,
    pub alive: bool,
    pub online: bool,
    pub in_world: bool,
    pub gold: u32,
    pub potions: u32,
    pub kills: u32,
    pub deaths: u32,
    pub respawn_at: Timestamp,
    pub last_attack: Timestamp,
    /// Incremented on every accepted attack, so clients can play the animation.
    pub attack_seq: u32,
    /// Incremented whenever the player takes damage.
    pub hit_seq: u32,
}

/// Latest movement intent per player. Private: other clients only see the result.
#[spacetimedb::table(accessor = player_input)]
pub struct PlayerInput {
    #[primary_key]
    pub identity: Identity,
    pub dx: f32,
    pub dz: f32,
    pub updated: Timestamp,
}

#[spacetimedb::table(accessor = enemy, public)]
pub struct Enemy {
    #[primary_key]
    pub id: u32,
    pub kind: String,
    pub x: f32,
    pub z: f32,
    pub facing: f32,
    pub moving: bool,
    pub hp: i32,
    pub max_hp: i32,
    pub alive: bool,
    pub target: Option<Identity>,
    pub respawn_at: Timestamp,
    pub last_attack: Timestamp,
    pub attack_seq: u32,
    pub hit_seq: u32,
}

#[spacetimedb::table(accessor = pickup, public)]
pub struct Pickup {
    #[primary_key]
    pub id: u32,
    pub kind: String,
    pub x: f32,
    pub z: f32,
    pub available: bool,
    pub respawn_at: Timestamp,
}

/// Short-lived combat feed (damage numbers, kill messages). Old rows are trimmed every tick.
#[spacetimedb::table(accessor = combat_event, public)]
pub struct CombatEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub at: Timestamp,
    pub kind: String,
    pub x: f32,
    pub z: f32,
    pub amount: i32,
    pub text: String,
}

#[spacetimedb::table(accessor = world, public)]
pub struct World {
    #[primary_key]
    pub version: u32,
    pub tick: u64,
    pub last_tick: Timestamp,
    pub map_version: u32,
}

#[spacetimedb::table(accessor = tick_timer, scheduled(world_tick, at = scheduled_at))]
pub struct TickTimer {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

// ---------------------------------------------------------------- helpers

fn ms_between(later: Timestamp, earlier: Timestamp) -> i64 {
    (later.to_micros_since_unix_epoch() - earlier.to_micros_since_unix_epoch()) / 1000
}

fn after_ms(ts: Timestamp, ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ts.to_micros_since_unix_epoch() + ms * 1000)
}

fn is_admin(ctx: &ReducerContext) -> bool {
    ctx.sender() == ctx.database_identity() || ctx.db.admin().identity().find(ctx.sender()).is_some()
}

fn valid_username(name: &str) -> bool {
    (3..=16).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn session(ctx: &ReducerContext) -> Result<AccountSession, String> {
    let s = ctx
        .db
        .account_session()
        .identity()
        .find(ctx.sender())
        .ok_or_else(|| "Not signed in: log in through the gateway first".to_string())?;
    // Same rule as BitCraft's is_authenticated(): an authorization is valid for one day.
    if ms_between(ctx.timestamp, s.authorized_at) > SESSION_TTL_MS {
        return Err("Session expired: log in again".into());
    }
    Ok(s)
}

fn live_player(ctx: &ReducerContext) -> Result<Player, String> {
    session(ctx)?;
    let p = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or("No character: call enter_world first")?;
    if !p.in_world {
        return Err("Character is not in the world".into());
    }
    Ok(p)
}

fn event(ctx: &ReducerContext, kind: &str, x: f32, z: f32, amount: i32, text: String) {
    ctx.db.combat_event().insert(CombatEvent {
        id: 0,
        at: ctx.timestamp,
        kind: kind.into(),
        x,
        z,
        amount,
        text,
    });
}

fn pick_player_spawn(ctx: &ReducerContext) -> (f32, f32) {
    let m = map();
    let occupied: Vec<(f32, f32)> = ctx
        .db
        .player()
        .iter()
        .filter(|p| p.in_world && p.alive)
        .map(|p| (p.x, p.z))
        .collect();
    // first free spawn point, otherwise the first one
    m.player_spawns
        .iter()
        .map(|s| (s[0], s[1]))
        .find(|(x, z)| occupied.iter().all(|(ox, oz)| (ox - x).powi(2) + (oz - z).powi(2) > 1.0))
        .unwrap_or((m.player_spawns[0][0], m.player_spawns[0][1]))
}

fn spawn_world(ctx: &ReducerContext) {
    let m = map();
    for (i, s) in m.enemy_spawns.iter().enumerate() {
        let st = enemy_stats(&s.kind);
        ctx.db.enemy().insert(Enemy {
            id: i as u32,
            kind: s.kind.clone(),
            x: s.x,
            z: s.z,
            facing: 0.0,
            moving: false,
            hp: st.max_hp,
            max_hp: st.max_hp,
            alive: true,
            target: None,
            respawn_at: ctx.timestamp,
            last_attack: Timestamp::UNIX_EPOCH,
            attack_seq: 0,
            hit_seq: 0,
        });
    }
    for (i, s) in m.pickup_spawns.iter().enumerate() {
        ctx.db.pickup().insert(Pickup {
            id: i as u32,
            kind: s.kind.clone(),
            x: s.x,
            z: s.z,
            available: true,
            respawn_at: ctx.timestamp,
        });
    }
}

// ---------------------------------------------------------------- lifecycle

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.admin().insert(Admin { identity: ctx.sender() });
    ctx.db.world().insert(World {
        version: 0,
        tick: 0,
        last_tick: ctx.timestamp,
        map_version: map().version,
    });
    spawn_world(ctx);
    ctx.db.tick_timer().insert(TickTimer {
        scheduled_id: 0,
        scheduled_at: Duration::from_millis(TICK_MS).into(),
    });
    log::info!(
        "KayKit arena initialized: {} enemies, {} pickups, {} colliders",
        ctx.db.enemy().count(),
        ctx.db.pickup().count(),
        map().colliders.len()
    );
}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    // Anyone may connect and watch public tables (the login screen needs a connection
    // to obtain its identity); every gameplay reducer requires an authorized session.
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.online = true;
        ctx.db.player().identity().update(p);
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.online = false;
        p.moving = false;
        ctx.db.player().identity().update(p);
    }
    ctx.db.player_input().identity().delete(ctx.sender());
}

// ---------------------------------------------------------------- admin / gateway

/// Registers a login gateway identity. Admin only (run by the publisher via `spacetime call`).
#[spacetimedb::reducer]
pub fn register_gateway(ctx: &ReducerContext, gateway_identity: Identity) -> Result<(), String> {
    if !is_admin(ctx) {
        return Err("Only an admin can register a gateway".into());
    }
    if ctx.db.gateway().identity().find(gateway_identity).is_none() {
        ctx.db.gateway().insert(Gateway {
            identity: gateway_identity,
        });
    }
    log::info!("Registered gateway {}", gateway_identity.to_hex());
    Ok(())
}

/// Called by the gateway after it verified the account password and the
/// player's identity token. Binds `player_identity` to `username`; logging in
/// from a new device moves the existing character to the new identity.
#[spacetimedb::reducer]
pub fn authorize_session(ctx: &ReducerContext, player_identity: Identity, username: String) -> Result<(), String> {
    if ctx.db.gateway().identity().find(ctx.sender()).is_none() && !is_admin(ctx) {
        return Err("Only the login gateway may authorize sessions".into());
    }
    if !valid_username(&username) {
        return Err("Invalid username".into());
    }
    // One live session per account and per identity.
    if let Some(old) = ctx.db.account_session().username().find(&username) {
        ctx.db.account_session().identity().delete(old.identity);
    }
    ctx.db.account_session().identity().delete(player_identity);
    ctx.db.account_session().insert(AccountSession {
        identity: player_identity,
        username: username.clone(),
        authorized_at: ctx.timestamp,
    });

    if let Some(mut p) = ctx.db.player().username().find(&username) {
        if p.identity != player_identity {
            ctx.db.player().identity().delete(p.identity);
            ctx.db.player_input().identity().delete(p.identity);
            ctx.db.player().identity().delete(player_identity);
            p.identity = player_identity;
            p.online = true;
            ctx.db.player().insert(p);
        }
    } else if let Some(stale) = ctx.db.player().identity().find(player_identity) {
        // this identity previously played another account
        ctx.db.player().identity().delete(stale.identity);
    }
    log::info!("Authorized session for '{}' ({})", username, player_identity.to_hex());
    Ok(())
}

// ---------------------------------------------------------------- player reducers

#[spacetimedb::reducer]
pub fn enter_world(ctx: &ReducerContext, class: String) -> Result<(), String> {
    let s = session(ctx)?;
    let stats = class_stats(&class).ok_or("Unknown class")?;
    let (x, z) = pick_player_spawn(ctx);
    match ctx.db.player().identity().find(ctx.sender()) {
        Some(mut p) => {
            let changed = p.class != class;
            p.class = class;
            p.max_hp = stats.max_hp;
            if changed || !p.alive || !p.in_world {
                p.hp = stats.max_hp;
                p.alive = true;
                p.x = x;
                p.z = z;
            }
            p.hp = p.hp.min(p.max_hp);
            p.in_world = true;
            p.online = true;
            ctx.db.player().identity().update(p);
        }
        None => {
            ctx.db.player().insert(Player {
                identity: ctx.sender(),
                username: s.username.clone(),
                class,
                x,
                z,
                facing: std::f32::consts::PI,
                moving: false,
                hp: stats.max_hp,
                max_hp: stats.max_hp,
                alive: true,
                online: true,
                in_world: true,
                gold: 0,
                potions: 1,
                kills: 0,
                deaths: 0,
                respawn_at: ctx.timestamp,
                last_attack: Timestamp::UNIX_EPOCH,
                attack_seq: 0,
                hit_seq: 0,
            });
        }
    }
    event(ctx, "join", x, z, 0, format!("{} entered the arena", s.username));
    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_world(ctx: &ReducerContext) -> Result<(), String> {
    let mut p = live_player(ctx)?;
    p.in_world = false;
    p.moving = false;
    ctx.db.player().identity().update(p);
    ctx.db.player_input().identity().delete(ctx.sender());
    Ok(())
}

/// Movement intent: a direction vector (length <= 1). The server integrates
/// positions every tick with the class speed and collision; clients never send positions.
#[spacetimedb::reducer]
pub fn set_input(ctx: &ReducerContext, dx: f32, dz: f32) -> Result<(), String> {
    live_player(ctx)?;
    if !dx.is_finite() || !dz.is_finite() {
        return Err("Invalid input".into());
    }
    let len = (dx * dx + dz * dz).sqrt();
    let (dx, dz) = if len > 1.0 { (dx / len, dz / len) } else { (dx, dz) };
    let row = PlayerInput {
        identity: ctx.sender(),
        dx,
        dz,
        updated: ctx.timestamp,
    };
    if ctx.db.player_input().identity().find(ctx.sender()).is_some() {
        ctx.db.player_input().identity().update(row);
    } else {
        ctx.db.player_input().insert(row);
    }
    Ok(())
}

/// Attack in the direction `facing` (radians, 0 = +Z). Cooldown, range and
/// damage are enforced here.
#[spacetimedb::reducer]
pub fn attack(ctx: &ReducerContext, facing: f32) -> Result<(), String> {
    let mut p = live_player(ctx)?;
    if !p.alive {
        return Err("You are dead".into());
    }
    if !facing.is_finite() {
        return Err("Invalid facing".into());
    }
    let stats = class_stats(&p.class).ok_or("Unknown class")?;
    if ms_between(ctx.timestamp, p.last_attack) < stats.cooldown_ms {
        return Err("Attack on cooldown".into());
    }
    p.facing = facing;
    p.last_attack = ctx.timestamp;
    p.attack_seq = p.attack_seq.wrapping_add(1);

    let mut targets: Vec<Enemy> = ctx
        .db
        .enemy()
        .iter()
        .filter(|e| e.alive && attack_hits(&stats, p.x, p.z, facing, e.x, e.z) && map().line_of_sight(p.x, p.z, e.x, e.z))
        .collect();
    if stats.ranged {
        // a bolt stops at the first enemy
        targets.sort_by(|a, b| {
            let da = (a.x - p.x).powi(2) + (a.z - p.z).powi(2);
            let db = (b.x - p.x).powi(2) + (b.z - p.z).powi(2);
            da.partial_cmp(&db).unwrap()
        });
        targets.truncate(1);
    }
    for mut e in targets {
        let crit = ctx.random::<f32>() < 0.12;
        let dmg = if crit { stats.damage * 2 } else { stats.damage };
        e.hp -= dmg;
        e.hit_seq = e.hit_seq.wrapping_add(1);
        e.target = Some(p.identity);
        event(ctx, if crit { "crit" } else { "damage" }, e.x, e.z, dmg, String::new());
        if e.hp <= 0 {
            let st = enemy_stats(&e.kind);
            e.hp = 0;
            e.alive = false;
            e.moving = false;
            e.target = None;
            e.respawn_at = after_ms(ctx.timestamp, ENEMY_RESPAWN_MS);
            p.kills += 1;
            p.gold += st.gold;
            event(
                ctx,
                "kill",
                e.x,
                e.z,
                st.gold as i32,
                format!("{} defeated a skeleton {}", p.username, e.kind),
            );
        }
        ctx.db.enemy().id().update(e);
    }
    ctx.db.player().identity().update(p);
    Ok(())
}

#[spacetimedb::reducer]
pub fn use_potion(ctx: &ReducerContext) -> Result<(), String> {
    let mut p = live_player(ctx)?;
    if !p.alive {
        return Err("You are dead".into());
    }
    if p.potions == 0 {
        return Err("No potions left".into());
    }
    if p.hp >= p.max_hp {
        return Err("Already at full health".into());
    }
    p.potions -= 1;
    let healed = POTION_HEAL.min(p.max_hp - p.hp);
    p.hp += healed;
    event(ctx, "heal", p.x, p.z, healed, String::new());
    ctx.db.player().identity().update(p);
    Ok(())
}

// ---------------------------------------------------------------- simulation

#[spacetimedb::reducer]
pub fn world_tick(ctx: &ReducerContext, _timer: TickTimer) -> Result<(), String> {
    // Scheduled reducers run as the database identity; reject client calls.
    if ctx.sender() != ctx.database_identity() {
        return Err("world_tick is internal".into());
    }
    let mut world = ctx.db.world().version().find(0).ok_or("world row missing")?;
    let dt = (ms_between(ctx.timestamp, world.last_tick) as f32 / 1000.0).clamp(0.0, 0.25);
    world.tick += 1;
    world.last_tick = ctx.timestamp;
    let tick = world.tick;
    ctx.db.world().version().update(world);

    tick_players(ctx, dt);
    tick_enemies(ctx, dt);
    tick_pickups(ctx);
    if tick % 20 == 0 {
        // keep ~5s of combat events
        let cutoff = after_ms(ctx.timestamp, -5_000);
        let old: Vec<u64> = ctx.db.combat_event().iter().filter(|e| e.at < cutoff).map(|e| e.id).collect();
        for id in old {
            ctx.db.combat_event().id().delete(id);
        }
    }
    Ok(())
}

fn tick_players(ctx: &ReducerContext, dt: f32) {
    let m = map();
    let players: Vec<Player> = ctx.db.player().iter().filter(|p| p.in_world).collect();
    for mut p in players {
        let before = (p.x, p.z, p.facing, p.moving, p.alive);
        if !p.alive {
            if ctx.timestamp >= p.respawn_at && p.online {
                let (x, z) = pick_player_spawn(ctx);
                p.x = x;
                p.z = z;
                p.hp = p.max_hp;
                p.alive = true;
            }
        } else if p.online {
            let input = ctx.db.player_input().identity().find(p.identity);
            let (dx, dz) = match input {
                Some(i) if ms_between(ctx.timestamp, i.updated) <= INPUT_TIMEOUT_MS => (i.dx, i.dz),
                _ => (0.0, 0.0),
            };
            let speed = class_stats(&p.class).map(|s| s.speed).unwrap_or(5.0);
            if dx != 0.0 || dz != 0.0 {
                let (nx, nz) = m.slide(p.x, p.z, dx * speed * dt, dz * speed * dt, m.player_radius);
                p.moving = (nx - p.x).abs() > 1e-4 || (nz - p.z).abs() > 1e-4;
                p.x = nx;
                p.z = nz;
                p.facing = facing_to(dx, dz);
            } else {
                p.moving = false;
            }
        }
        if before != (p.x, p.z, p.facing, p.moving, p.alive) {
            ctx.db.player().identity().update(p);
        }
    }
}

fn tick_enemies(ctx: &ReducerContext, dt: f32) {
    let m = map();
    let players: Vec<Player> = ctx.db.player().iter().filter(|p| p.in_world && p.online && p.alive).collect();
    let enemies: Vec<Enemy> = ctx.db.enemy().iter().collect();
    for mut e in enemies {
        let spawn = &m.enemy_spawns[e.id as usize];
        let st = enemy_stats(&e.kind);
        let before = (e.x, e.z, e.facing, e.moving, e.alive, e.target);
        if !e.alive {
            if ctx.timestamp >= e.respawn_at {
                e.alive = true;
                e.hp = e.max_hp;
                e.x = spawn.x;
                e.z = spawn.z;
                e.target = None;
                event(ctx, "spawn", e.x, e.z, 0, String::new());
            }
        } else {
            // keep the current target while valid, otherwise pick the closest player in aggro range
            let valid =
                |p: &Player| !m.in_camp(p.x, p.z) && (p.x - spawn.x).powi(2) + (p.z - spawn.z).powi(2) < LEASH_DISTANCE * LEASH_DISTANCE;
            let (ex, ez) = (e.x, e.z);
            let visible = |p: &Player| m.line_of_sight(ex, ez, p.x, p.z);
            let current = e.target.and_then(|id| players.iter().find(|p| p.identity == id && valid(p)));
            let target = current.or_else(|| {
                players
                    .iter()
                    .filter(|p| valid(p) && (p.x - e.x).powi(2) + (p.z - e.z).powi(2) < st.aggro * st.aggro && visible(p))
                    .min_by(|a, b| {
                        let da = (a.x - e.x).powi(2) + (a.z - e.z).powi(2);
                        let db = (b.x - e.x).powi(2) + (b.z - e.z).powi(2);
                        da.partial_cmp(&db).unwrap()
                    })
            });
            e.target = target.map(|p| p.identity);
            match target {
                Some(t) => {
                    let (dx, dz) = (t.x - e.x, t.z - e.z);
                    let dist = (dx * dx + dz * dz).sqrt();
                    e.facing = facing_to(dx, dz);
                    if dist > st.range {
                        let step = (st.speed * dt).min(dist - st.range * 0.8);
                        let (nx, nz) = m.slide(e.x, e.z, dx / dist * step, dz / dist * step, ENEMY_RADIUS);
                        e.moving = (nx - e.x).abs() > 1e-4 || (nz - e.z).abs() > 1e-4;
                        e.x = nx;
                        e.z = nz;
                    } else {
                        e.moving = false;
                        // no attacking through walls (matters for the 8 m skeleton mage)
                        if ms_between(ctx.timestamp, e.last_attack) >= st.cooldown_ms && visible(t) {
                            e.last_attack = ctx.timestamp;
                            e.attack_seq = e.attack_seq.wrapping_add(1);
                            damage_player(ctx, t.identity, st.damage, &e.kind);
                        }
                    }
                }
                None => {
                    // walk back to the spawn point
                    let (dx, dz) = (spawn.x - e.x, spawn.z - e.z);
                    let dist = (dx * dx + dz * dz).sqrt();
                    if dist > 0.3 {
                        let step = (st.speed * 0.6 * dt).min(dist);
                        let (nx, nz) = m.slide(e.x, e.z, dx / dist * step, dz / dist * step, ENEMY_RADIUS);
                        e.moving = (nx - e.x).abs() > 1e-4 || (nz - e.z).abs() > 1e-4;
                        e.x = nx;
                        e.z = nz;
                        e.facing = facing_to(dx, dz);
                    } else {
                        e.moving = false;
                        if e.hp < e.max_hp {
                            e.hp = e.max_hp;
                            ctx.db.enemy().id().update(e);
                            continue;
                        }
                    }
                }
            }
        }
        if before != (e.x, e.z, e.facing, e.moving, e.alive, e.target) {
            ctx.db.enemy().id().update(e);
        }
    }
}

fn damage_player(ctx: &ReducerContext, identity: Identity, damage: i32, source: &str) {
    let Some(mut p) = ctx.db.player().identity().find(identity) else {
        return;
    };
    if !p.alive {
        return;
    }
    p.hp -= damage;
    p.hit_seq = p.hit_seq.wrapping_add(1);
    event(ctx, "player_damage", p.x, p.z, damage, String::new());
    if p.hp <= 0 {
        p.hp = 0;
        p.alive = false;
        p.moving = false;
        p.deaths += 1;
        p.respawn_at = after_ms(ctx.timestamp, PLAYER_RESPAWN_MS);
        event(
            ctx,
            "death",
            p.x,
            p.z,
            0,
            format!("{} was slain by a skeleton {}", p.username, source),
        );
    }
    ctx.db.player().identity().update(p);
}

fn tick_pickups(ctx: &ReducerContext) {
    let pickups: Vec<Pickup> = ctx.db.pickup().iter().collect();
    for mut pk in pickups {
        if !pk.available {
            if ctx.timestamp >= pk.respawn_at {
                pk.available = true;
                ctx.db.pickup().id().update(pk);
            }
            continue;
        }
        let collector = ctx
            .db
            .player()
            .iter()
            .find(|p| p.in_world && p.alive && p.online && (p.x - pk.x).powi(2) + (p.z - pk.z).powi(2) < PICKUP_RADIUS * PICKUP_RADIUS);
        if let Some(mut p) = collector {
            match pk.kind.as_str() {
                "potion" => p.potions += 1,
                _ => p.gold += 10,
            }
            event(ctx, "pickup", pk.x, pk.z, 0, pk.kind.clone());
            ctx.db.player().identity().update(p);
            pk.available = false;
            pk.respawn_at = after_ms(ctx.timestamp, PICKUP_RESPAWN_MS);
            ctx.db.pickup().id().update(pk);
        }
    }
}
