import './style.css';
import * as THREE from 'three';
import { cloneCharacter, loadAll } from './assets';
import { Game } from './game';
import { Input } from './input';
import { CLASS_IDS, CLASSES, type ClassId } from './map';
import { ApiError, Net, getHealth, getLeaderboard, type ConnState } from './net';
import { createWorld } from './world';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function show(screen: 'loading' | 'login' | 'select' | 'game') {
  for (const s of ['loading', 'login', 'select']) $(`screen-${s}`).classList.toggle('visible', s === screen);
  $('hud').classList.toggle('hidden', screen !== 'game');
  if (screen !== 'game') for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
  document.body.dataset.screen = screen;
}

const prefs = (() => {
  const mobile = matchMedia('(pointer: coarse)').matches;
  try {
    return { shadows: !mobile, stats: false, ...JSON.parse(localStorage.getItem('kaykit-arena.prefs') ?? '{}') };
  } catch {
    return { shadows: !mobile, stats: false };
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem('kaykit-arena.prefs', JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
};

/** Renders each hero's idle pose into a small image for the class picker and HUD. */
function renderPortraits(renderer: THREE.WebGLRenderer): Record<string, string> {
  const size = 192;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#554433', 2.2));
  const key = new THREE.DirectionalLight('#ffffff', 2);
  key.position.set(2, 3, 4);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  cam.position.set(0, 2.0, 4.2);
  cam.lookAt(0, 1.55, 0);
  const target = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
  const pixels = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const out: Record<string, string> = {};
  for (const id of CLASS_IDS) {
    const { root, clips } = cloneCharacter(id);
    const mixer = new THREE.AnimationMixer(root);
    const idle = clips.find((c) => c.name === 'Idle');
    if (idle) mixer.clipAction(idle).play();
    mixer.update(0.3);
    root.rotation.y = -0.35;
    scene.add(root);
    renderer.setRenderTarget(target);
    renderer.setClearColor('#2a2233', 1);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    g.putImageData(img, 0, 0);
    out[id] = canvas.toDataURL('image/png');
    scene.remove(root);
  }
  renderer.setRenderTarget(null);
  target.dispose();
  return out;
}

async function boot() {
  show('loading');
  const net = new Net();
  const configReady = net.init();

  try {
    await loadAll((f, label) => {
      $('loading-bar').style.width = `${Math.round(f * 100)}%`;
      $('loading-text').textContent = `Loading ${label.split('/').pop()}…`;
    });
  } catch (e) {
    $('loading-text').textContent = `Could not load game assets: ${(e as Error).message}. Reload to retry.`;
    return;
  }
  const world = createWorld($<HTMLCanvasElement>('scene'));
  world.setShadows(prefs.shadows);
  const portraits = renderPortraits(world.renderer);
  const input = new Input($<HTMLCanvasElement>('scene'));
  const game = new Game(world, net, input, portraits);
  (window as unknown as { __arena: unknown }).__arena = { game, net, world };
  await configReady;

  // ---- connection status
  const pill = $('conn-pill');
  net.onState = (s: ConnState, detail?: string) => {
    const label: Record<ConnState, string> = { connecting: 'Connecting…', connected: 'Online', reconnecting: 'Reconnecting…', offline: 'Offline' };
    pill.textContent = label[s];
    pill.title = detail ?? '';
    pill.className = `pill ${s === 'connected' ? 'ok' : s === 'offline' ? 'bad' : 'warn'}`;
    if (s === 'reconnecting' && game.active) game.toast(`Connection lost${detail ? `: ${detail}` : ''}`, 'info');
  };
  net.onReady = (conn) => {
    game.attach(conn);
    if (game.active) game.toast('Reconnected', 'info');
  };

  // ---- server status on the login screen
  async function refreshHealth() {
    try {
      const h = await getHealth();
      const ok = h.status === 'ok';
      $('server-dot').className = `dot ${ok ? 'ok' : 'bad'}`;
      $('server-status').textContent = ok ? 'Server online' : 'Server degraded';
    } catch (e) {
      $('server-dot').className = 'dot bad';
      $('server-status').textContent = (e as Error).message;
    }
  }

  // ---- login
  let mode: 'login' | 'register' = 'login';
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    tab.addEventListener('click', () => {
      mode = tab.dataset.mode as typeof mode;
      for (const t of document.querySelectorAll('.tab')) {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      }
      $('login-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
      $<HTMLInputElement>('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('login-error').textContent = '';
    });
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $<HTMLInputElement>('username').value.trim();
    const password = $<HTMLInputElement>('password').value;
    const err = $('login-error');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return void (err.textContent = 'Username: 3-16 letters, digits or _');
    if (password.length < 8) return void (err.textContent = 'Password must be at least 8 characters');
    const btn = $<HTMLButtonElement>('login-submit');
    btn.disabled = true;
    err.textContent = '';
    try {
      await net.login(username, password, mode === 'register');
      $<HTMLInputElement>('password').value = '';
      chosen = null;
      void openSelect();
    } catch (ex) {
      err.textContent = ex instanceof ApiError ? ex.message : `Login failed: ${(ex as Error).message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- class select
  let chosen: ClassId | null = null;
  const list = $('class-list');
  for (const id of CLASS_IDS) {
    const c = CLASSES[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'class-card';
    card.dataset.class = id;
    const bar = (v: number, max: number) => `<i style="width:${Math.round((v / max) * 100)}%"></i>`;
    card.innerHTML = `<img alt="" src="${portraits[id]}"><b></b><small></small>
      <div class="stats"><span>Health</span>${bar(c.hp, 140)}<span>Damage</span>${bar(c.damage * (1000 / c.cooldown), 45)}<span>Speed</span>${bar(c.speed, 6.2)}</div>`;
    card.querySelector('b')!.textContent = c.label;
    card.querySelector('small')!.textContent = c.blurb + (c.ranged ? ' (ranged)' : '');
    card.addEventListener('click', () => select(id));
    list.appendChild(card);
  }
  function select(id: ClassId) {
    chosen = id;
    for (const c of list.querySelectorAll<HTMLElement>('.class-card')) c.classList.toggle('selected', c.dataset.class === id);
    $<HTMLButtonElement>('enter-button').disabled = false;
  }
  async function openSelect() {
    show('select');
    $('select-welcome').textContent = `Welcome, ${net.username}. Pick a class; you can change it from the menu later.`;
    // After logging in on a new device the server moves the character to this identity; that
    // row update can arrive a moment after the HTTP login response, so wait briefly for it.
    for (let i = 0; i < 20 && !chosen; i++) {
      const existing = net.conn && net.identity ? net.conn.db.player.identity.find(net.identity) : undefined;
      if (existing && (CLASS_IDS as string[]).includes(existing.class)) {
        select(existing.class as ClassId);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  $('enter-button').addEventListener('click', async () => {
    if (!chosen) return;
    const btn = $<HTMLButtonElement>('enter-button');
    btn.disabled = true;
    $('select-error').textContent = '';
    try {
      if (!net.conn) await net.connect();
      await game.enter(chosen);
      show('game');
    } catch (e) {
      const msg = (e as Error).message;
      if (/sign|session/i.test(msg)) {
        show('login');
        $('login-error').textContent = 'Your session expired, please log in again.';
      } else {
        $('select-error').textContent = msg;
      }
    } finally {
      btn.disabled = false;
    }
  });
  const logout = async () => {
    if (game.active) await game.leave();
    net.logout();
    show('login');
    void refreshHealth();
    net.connect().catch(() => {});
  };
  $('logout-button').addEventListener('click', logout);

  // ---- in-game panels
  const toggle = (id: string, force?: boolean) => $(id).classList.toggle('hidden', force === undefined ? undefined : !force);
  const openBoard = async () => {
    toggle('panel-board', true);
    const body = $('board-body');
    body.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    try {
      const { players } = await getLeaderboard();
      body.innerHTML = '';
      players.forEach((p, i) => {
        const tr = document.createElement('tr');
        for (const v of [i + 1, p.username, CLASSES[p.class as ClassId]?.label ?? p.class, p.kills, p.deaths, p.gold]) {
          const td = document.createElement('td');
          td.textContent = String(v);
          tr.appendChild(td);
        }
        body.appendChild(tr);
      });
      if (!players.length) body.innerHTML = '<tr><td colspan="6">No heroes yet.</td></tr>';
    } catch (e) {
      body.innerHTML = '';
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6"></td>';
      tr.firstElementChild!.textContent = (e as Error).message;
      body.appendChild(tr);
    }
  };
  $('btn-inventory').addEventListener('click', () => (game.renderInventory(), toggle('panel-inventory')));
  $('btn-board').addEventListener('click', openBoard);
  $('btn-menu').addEventListener('click', () => toggle('panel-menu'));
  for (const b of document.querySelectorAll('.modal .close')) b.addEventListener('click', () => b.closest('.modal')!.classList.add('hidden'));
  for (const m of document.querySelectorAll('.modal')) m.addEventListener('click', (e) => e.target === m && m.classList.add('hidden'));
  input.onKey = (k) => {
    if (document.body.dataset.screen !== 'game') return;
    if (k === 'escape') {
      const open = [...document.querySelectorAll('.modal:not(.hidden)')];
      if (open.length) open.forEach((m) => m.classList.add('hidden'));
      else toggle('panel-menu', true);
    }
    if (k === 'i') (game.renderInventory(), toggle('panel-inventory'));
    if (k === 'l') void openBoard();
  };
  $('btn-change-hero').addEventListener('click', async () => {
    await game.leave();
    void openSelect();
  });
  $('btn-logout-game').addEventListener('click', logout);
  const shadows = $<HTMLInputElement>('opt-shadows');
  shadows.checked = prefs.shadows;
  shadows.addEventListener('change', () => {
    prefs.shadows = shadows.checked;
    world.setShadows(prefs.shadows);
    savePrefs();
  });
  const stats = $<HTMLInputElement>('opt-stats');
  stats.checked = prefs.stats;
  $('fps').classList.toggle('hidden', !prefs.stats);
  stats.addEventListener('change', () => {
    prefs.stats = stats.checked;
    $('fps').classList.toggle('hidden', !prefs.stats);
    savePrefs();
  });

  // ---- render loop
  window.addEventListener('resize', () => world.resize());
  const timer = new THREE.Timer();
  timer.connect(document);
  let frames = 0;
  let fpsTime = 0;
  let minimapTime = 0;
  world.renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    game.update(dt);
    world.renderer.render(world.scene, world.camera);
    game.placeOverlays();
    minimapTime += dt;
    if (minimapTime > 0.1 && game.active) {
      minimapTime = 0;
      game.drawMinimap();
    }
    frames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
      if (prefs.stats) $('fps').textContent = `${Math.round(frames / fpsTime)} fps · ${world.drawCalls()} draws`;
      frames = 0;
      fpsTime = 0;
    }
  });

  // ---- initial screen
  void refreshHealth();
  setInterval(() => document.body.dataset.screen === 'login' && refreshHealth(), 10_000);
  if (net.hasSession) {
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 8000));
    if ((await Promise.race([net.connect(), timeout])) !== 'timeout') {
      void openSelect();
      return;
    }
    $('login-error').textContent = 'Could not reach the game server yet; still retrying in the background.';
  }
  show('login');
  net.connect().catch(() => {});
}

void boot();
