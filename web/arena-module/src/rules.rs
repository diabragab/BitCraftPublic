//! Balance data for player classes and enemy kinds. Lives on the server only;
//! clients are told the results (positions, health), never trusted with them.

pub struct ClassStats {
    pub max_hp: i32,
    pub speed: f32,
    pub damage: i32,
    pub range: f32,
    /// Half-angle of the melee cone in radians. Ranged classes use a line instead.
    pub arc: f32,
    pub cooldown_ms: i64,
    pub ranged: bool,
}

pub const CLASSES: [&str; 4] = ["knight", "barbarian", "mage", "rogue"];

pub fn class_stats(class: &str) -> Option<ClassStats> {
    Some(match class {
        "knight" => ClassStats {
            max_hp: 140,
            speed: 5.0,
            damage: 22,
            range: 2.3,
            arc: 1.1,
            cooldown_ms: 650,
            ranged: false,
        },
        "barbarian" => ClassStats {
            max_hp: 120,
            speed: 5.2,
            damage: 34,
            range: 2.6,
            arc: 1.3,
            cooldown_ms: 950,
            ranged: false,
        },
        "mage" => ClassStats {
            max_hp: 85,
            speed: 5.0,
            damage: 26,
            range: 10.0,
            arc: 0.0,
            cooldown_ms: 800,
            ranged: true,
        },
        "rogue" => ClassStats {
            max_hp: 95,
            speed: 6.2,
            damage: 16,
            range: 2.0,
            arc: 1.0,
            cooldown_ms: 380,
            ranged: false,
        },
        _ => return None,
    })
}

pub struct EnemyStats {
    pub max_hp: i32,
    pub speed: f32,
    pub damage: i32,
    pub range: f32,
    pub cooldown_ms: i64,
    pub aggro: f32,
    pub gold: u32,
}

pub fn enemy_stats(kind: &str) -> EnemyStats {
    match kind {
        "warrior" => EnemyStats {
            max_hp: 110,
            speed: 3.2,
            damage: 14,
            range: 2.0,
            cooldown_ms: 1400,
            aggro: 10.0,
            gold: 8,
        },
        "rogue" => EnemyStats {
            max_hp: 55,
            speed: 4.6,
            damage: 8,
            range: 1.8,
            cooldown_ms: 800,
            aggro: 12.0,
            gold: 6,
        },
        "mage" => EnemyStats {
            max_hp: 50,
            speed: 3.0,
            damage: 10,
            range: 8.0,
            cooldown_ms: 1800,
            aggro: 12.0,
            gold: 7,
        },
        _ => EnemyStats {
            max_hp: 60,
            speed: 3.6,
            damage: 9,
            range: 1.8,
            cooldown_ms: 1100,
            aggro: 9.0,
            gold: 4,
        },
    }
}

pub const TICK_MS: u64 = 50;
pub const PLAYER_RESPAWN_MS: i64 = 5_000;
pub const ENEMY_RESPAWN_MS: i64 = 12_000;
pub const PICKUP_RESPAWN_MS: i64 = 20_000;
pub const PICKUP_RADIUS: f32 = 1.3;
pub const POTION_HEAL: i32 = 40;
pub const LEASH_DISTANCE: f32 = 18.0;
/// Inputs older than this are treated as "stopped" so a lost connection never leaves a player running.
pub const INPUT_TIMEOUT_MS: i64 = 1_000;
pub const ENEMY_RADIUS: f32 = 0.55;
pub const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;

pub struct Reentry {
    pub hp: i32,
    /// True when the character comes back from death and must be placed at a spawn point.
    pub respawn: bool,
}

/// Health when an existing character (re-)enters the world, possibly as a new class.
/// Dead characters must wait for their respawn timer, and neither re-entering nor
/// switching class heals: the health fraction is kept.
pub fn reentry(alive: bool, respawn_due: bool, hp: i32, old_max: i32, new_max: i32) -> Result<Reentry, String> {
    if !alive {
        if !respawn_due {
            return Err("You are dead: wait for the respawn timer".into());
        }
        return Ok(Reentry {
            hp: new_max,
            respawn: true,
        });
    }
    let scaled = (hp as i64 * new_max as i64 / old_max.max(1) as i64) as i32;
    Ok(Reentry {
        hp: scaled.clamp(1, new_max),
        respawn: false,
    })
}

/// Smallest signed difference between two angles.
pub fn angle_diff(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % std::f32::consts::TAU;
    if d > std::f32::consts::PI {
        d -= std::f32::consts::TAU;
    } else if d < -std::f32::consts::PI {
        d += std::f32::consts::TAU;
    }
    d
}

/// Facing angle convention shared with the client: 0 faces +Z, angle = atan2(dx, dz).
pub fn facing_to(dx: f32, dz: f32) -> f32 {
    dx.atan2(dz)
}

/// Whether a target at (tx, tz) is hit by an attack from (x, z) facing `facing`.
pub fn attack_hits(stats: &ClassStats, x: f32, z: f32, facing: f32, tx: f32, tz: f32) -> bool {
    let (dx, dz) = (tx - x, tz - z);
    let dist = (dx * dx + dz * dz).sqrt();
    if stats.ranged {
        // distance along the aim line and perpendicular distance from it
        let (fx, fz) = (facing.sin(), facing.cos());
        let along = dx * fx + dz * fz;
        let perp = (dx * fz - dz * fx).abs();
        along > 0.0 && along <= stats.range && perp <= 1.0
    } else {
        dist <= stats.range + ENEMY_RADIUS && (dist < 0.6 || angle_diff(facing_to(dx, dz), facing).abs() <= stats.arc)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn melee_cone() {
        let k = class_stats("knight").unwrap();
        assert!(attack_hits(&k, 0.0, 0.0, 0.0, 0.0, 2.0)); // straight ahead (+Z)
        assert!(!attack_hits(&k, 0.0, 0.0, 0.0, 0.0, -2.0)); // behind
        assert!(!attack_hits(&k, 0.0, 0.0, 0.0, 0.0, 4.0)); // too far
    }

    #[test]
    fn ranged_line() {
        let m = class_stats("mage").unwrap();
        let east = std::f32::consts::FRAC_PI_2; // facing +X
        assert!(attack_hits(&m, 0.0, 0.0, east, 8.0, 0.5));
        assert!(!attack_hits(&m, 0.0, 0.0, east, 8.0, 2.0));
        assert!(!attack_hits(&m, 0.0, 0.0, east, -3.0, 0.0));
    }

    #[test]
    fn reentry_never_skips_death_or_heals() {
        assert!(reentry(false, false, 0, 140, 140).is_err(), "dead before the respawn timer");
        let r = reentry(false, true, 0, 140, 85).unwrap();
        assert!(r.respawn && r.hp == 85, "respawn when the timer has passed");
        let r = reentry(true, false, 70, 140, 140).unwrap();
        assert!(!r.respawn && r.hp == 70, "re-entering keeps health");
        let r = reentry(true, false, 70, 140, 120).unwrap();
        assert_eq!(r.hp, 60, "class switch keeps the health fraction");
        assert_eq!(reentry(true, false, 1, 140, 85).unwrap().hp, 1);
    }

    #[test]
    fn unknown_class_rejected() {
        assert!(class_stats("dragon").is_none());
    }
}
