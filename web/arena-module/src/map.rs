//! Arena layout and collision. The layout comes from `web/shared/map.json`, the
//! same file the browser renders, so server collision matches what players see.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Collider {
    Box {
        #[serde(rename = "minX")]
        min_x: f32,
        #[serde(rename = "minZ")]
        min_z: f32,
        #[serde(rename = "maxX")]
        max_x: f32,
        #[serde(rename = "maxZ")]
        max_z: f32,
    },
    Circle {
        x: f32,
        z: f32,
        r: f32,
    },
}

#[derive(Deserialize, Debug, Clone)]
pub struct SpawnPoint {
    pub kind: String,
    pub x: f32,
    pub z: f32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Camp {
    pub x: f32,
    pub z: f32,
    pub r: f32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ArenaMap {
    pub version: u32,
    pub half: f32,
    pub player_radius: f32,
    pub camp: Camp,
    pub player_spawns: Vec<[f32; 2]>,
    pub enemy_spawns: Vec<SpawnPoint>,
    pub pickup_spawns: Vec<SpawnPoint>,
    pub colliders: Vec<Collider>,
}

static MAP_JSON: &str = include_str!("../../shared/map.json");
static MAP: OnceLock<ArenaMap> = OnceLock::new();

pub fn map() -> &'static ArenaMap {
    MAP.get_or_init(|| serde_json::from_str(MAP_JSON).expect("shared/map.json is invalid"))
}

impl ArenaMap {
    pub fn blocked(&self, x: f32, z: f32, radius: f32) -> bool {
        let lim = self.half - radius;
        if x < -lim || x > lim || z < -lim || z > lim {
            return true;
        }
        self.colliders.iter().any(|c| match *c {
            Collider::Box {
                min_x,
                min_z,
                max_x,
                max_z,
            } => {
                // closest point on the box to the circle centre
                let cx = x.clamp(min_x, max_x);
                let cz = z.clamp(min_z, max_z);
                (x - cx).powi(2) + (z - cz).powi(2) < radius * radius
            }
            Collider::Circle { x: ox, z: oz, r } => (x - ox).powi(2) + (z - oz).powi(2) < (r + radius).powi(2),
        })
    }

    /// Moves a circle by (dx, dz), sliding along obstacles axis by axis.
    /// Movement is split into small steps so fast movers cannot tunnel through walls.
    pub fn slide(&self, x: f32, z: f32, dx: f32, dz: f32, radius: f32) -> (f32, f32) {
        let dist = (dx * dx + dz * dz).sqrt();
        let steps = ((dist / 0.25).ceil() as i32).max(1);
        let (sx, sz) = (dx / steps as f32, dz / steps as f32);
        let (mut px, mut pz) = (x, z);
        for _ in 0..steps {
            if !self.blocked(px + sx, pz, radius) {
                px += sx;
            }
            if !self.blocked(px, pz + sz, radius) {
                pz += sz;
            }
        }
        (px, pz)
    }

    /// Moves up to `step` towards (tx, tz). When the direct route is mostly blocked (a tree, a
    /// pillar), tries directions rotated to either side and takes the one that ends closest to
    /// the target among those that make real progress. A cheap stand-in for pathfinding.
    pub fn steer(&self, x: f32, z: f32, tx: f32, tz: f32, step: f32, radius: f32) -> (f32, f32) {
        let dist = ((tx - x).powi(2) + (tz - z).powi(2)).sqrt();
        if dist < 1e-4 {
            return (x, z);
        }
        let (dx, dz) = ((tx - x) / dist, (tz - z) / dist);
        let direct = self.slide(x, z, dx * step, dz * step, radius);
        let moved = |p: (f32, f32)| ((p.0 - x).powi(2) + (p.1 - z).powi(2)).sqrt();
        if moved(direct) >= step * 0.6 {
            return direct;
        }
        let to_target = |p: (f32, f32)| (p.0 - tx).powi(2) + (p.1 - tz).powi(2);
        [0.6f32, -0.6, 1.2, -1.2, 1.8, -1.8]
            .iter()
            .map(|a| {
                let (sin, cos) = a.sin_cos();
                self.slide(x, z, (dx * cos - dz * sin) * step, (dx * sin + dz * cos) * step, radius)
            })
            .filter(|p| moved(*p) >= step * 0.6)
            .min_by(|a, b| to_target(*a).partial_cmp(&to_target(*b)).unwrap())
            .unwrap_or(direct)
    }

    /// True if no wall (box collider) blocks the straight line between two points.
    /// Round props (trees, pillars) are ignored so they do not make fights frustrating.
    pub fn line_of_sight(&self, x0: f32, z0: f32, x1: f32, z1: f32) -> bool {
        let dist = ((x1 - x0).powi(2) + (z1 - z0).powi(2)).sqrt();
        let steps = ((dist / 0.4).ceil() as i32).max(1);
        (1..steps).all(|i| {
            let t = i as f32 / steps as f32;
            let (x, z) = (x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
            !self.colliders.iter().any(|c| match *c {
                Collider::Box {
                    min_x,
                    min_z,
                    max_x,
                    max_z,
                } => x >= min_x && x <= max_x && z >= min_z && z <= max_z,
                Collider::Circle { .. } => false,
            })
        })
    }

    pub fn in_camp(&self, x: f32, z: f32) -> bool {
        (x - self.camp.x).powi(2) + (z - self.camp.z).powi(2) < self.camp.r * self.camp.r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_parses_and_spawns_are_free() {
        let m = map();
        assert_eq!(m.version, 1);
        for s in &m.player_spawns {
            assert!(!m.blocked(s[0], s[1], m.player_radius), "player spawn {s:?} blocked");
        }
        for s in m.enemy_spawns.iter().chain(m.pickup_spawns.iter()) {
            assert!(!m.blocked(s.x, s.z, 0.5), "spawn {s:?} blocked");
        }
    }

    #[test]
    fn walls_stop_movement() {
        let m = map();
        // keep wall segment on the north side spans x in [-14,-10] around z = -16
        let (_, z) = m.slide(-12.0, -14.0, 0.0, -5.0, 0.5);
        assert!(z > -15.5, "walked through the wall: z = {z}");
        // the gate at x = 0 is open
        let (_, z) = m.slide(0.0, -14.0, 0.0, -5.0, 0.5);
        assert!(z < -18.0, "gate should be open: z = {z}");
    }

    #[test]
    fn walls_block_line_of_sight() {
        let m = map();
        assert!(
            !m.line_of_sight(-12.0, 14.0, -12.0, 19.0),
            "south wall segment at x=-12 should block"
        );
        assert!(m.line_of_sight(0.0, 14.0, 0.0, 19.0), "south gate is open");
        assert!(m.line_of_sight(20.0, 20.0, 25.0, 25.0), "open field");
    }

    #[test]
    fn steering_gets_around_a_tree() {
        let m = map();
        // an outdoor tree well inside the bounds
        let (cx, cz, r) = m
            .colliders
            .iter()
            .find_map(|c| match *c {
                Collider::Circle { x, z, r } if r < 0.75 && x.abs() < 28.0 && z.abs() < 28.0 && z.abs() > 20.0 => Some((x, z, r)),
                _ => None,
            })
            .expect("a tree");
        // start right behind the tree, target straight through it
        let (mut x, mut z) = (cx - (r + 0.6), cz);
        let (tx, tz) = (cx + 4.0, cz);
        let (sx, _) = m.slide(x, z, 4.0 + r + 0.6, 0.0, 0.55);
        assert!(sx < cx, "precondition: the tree blocks the straight path");
        for _ in 0..200 {
            (x, z) = m.steer(x, z, tx, tz, 3.6 * 0.05, 0.55);
        }
        let left = ((x - tx).powi(2) + (z - tz).powi(2)).sqrt();
        assert!(left < 1.0, "stuck {left:.2} m from the target at ({x:.2}, {z:.2})");
    }

    #[test]
    fn bounds_clamp() {
        let m = map();
        let (x, _) = m.slide(0.0, 0.0, 100.0, 0.0, 0.5);
        assert!(x <= m.half);
    }
}
