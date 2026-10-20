// Procedural audio: every sound effect, the ambience and the music are synthesized with the
// Web Audio API, so there are no audio files to download or license. Browsers only allow
// sound after a user gesture, so call start() from a click (e.g. the Play button).

export type Sfx =
  | 'chop' | 'mine' | 'swing' | 'zap' | 'hit' | 'crit' | 'hurt' | 'enemy-swing' | 'enemy-death' | 'pickup' | 'loot'
  | 'craft' | 'build' | 'potion' | 'levelup' | 'death' | 'respawn' | 'step' | 'click' | 'error';

type Mood = 'day' | 'night';

const NOTE = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// Chord progressions as MIDI note sets (root position triads plus a colour tone)
const DAY = { bpm: 84, chords: [[62, 66, 69, 73], [59, 62, 66, 69], [55, 59, 62, 66], [57, 61, 64, 69]], scale: [62, 64, 66, 69, 71, 74, 76, 78, 81] };
const NIGHT = { bpm: 62, chords: [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]], scale: [57, 60, 62, 64, 67, 69, 72, 74, 76] };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private combatBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;
  private nextBeat = 0;
  private beat = 0;
  private melody = 4;
  private scheduler: number | undefined;
  private ambienceTimer: number | undefined;
  private mood: Mood = 'day';
  private combat = 0;
  private volumes = { music: 0.5, sfx: 0.8 };
  /** Counters for tests and the debug overlay. */
  readonly stats = { started: false, notes: 0, sfx: 0 };

  get running() {
    return this.ctx?.state === 'running';
  }

  /** Creates (or resumes) the audio graph. Must be called from a user gesture. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    this.master.connect(limiter).connect(ctx.destination);
    this.musicBus = this.bus(this.volumes.music * 0.6);
    this.sfxBus = this.bus(this.volumes.sfx);
    this.ambBus = this.bus(this.volumes.sfx * 0.7);
    this.combatBus = ctx.createGain();
    this.combatBus.gain.value = 0;
    this.combatBus.connect(this.musicBus);

    // white noise, reused by every noisy sound
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // a generated impulse response gives the music and a few effects some space
    this.reverb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 2.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    this.reverb.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.startWind();
    this.nextBeat = ctx.currentTime + 0.2;
    this.scheduler = window.setInterval(() => this.schedule(), 50);
    this.ambienceTimer = window.setInterval(() => this.ambience(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void ctx.suspend();
      else void ctx.resume();
    });
    this.stats.started = true;
  }

  stop() {
    window.clearInterval(this.scheduler);
    window.clearInterval(this.ambienceTimer);
    void this.ctx?.close();
    this.ctx = null;
  }

  private bus(level: number) {
    const g = this.ctx!.createGain();
    g.gain.value = level;
    g.connect(this.master);
    return g;
  }

  setVolumes(music: number, sfx: number) {
    this.volumes = { music, sfx };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(music * 0.6, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(sfx, t, 0.1);
    this.ambBus.gain.setTargetAtTime(sfx * 0.7, t, 0.1);
  }

  /** Night changes key and tempo at the next bar; combat fades a drum layer in or out. */
  setMood(night: boolean, combat: boolean) {
    this.mood = night ? 'night' : 'day';
    const target = combat ? 1 : 0;
    if (this.ctx && target !== this.combat) {
      this.combat = target;
      this.combatBus.gain.setTargetAtTime(target * 0.9, this.ctx.currentTime, combat ? 0.4 : 2.5);
    }
  }

  // ---------------------------------------------------------------- music

  private schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // If the page stalled (slow frame, tab switch), skip ahead instead of firing a burst of notes.
    if (this.nextBeat < ctx.currentTime - 0.3) this.nextBeat = ctx.currentTime + 0.05;
    while (this.nextBeat < ctx.currentTime + 0.25) {
      this.playBeat(this.nextBeat);
      const song = this.mood === 'night' ? NIGHT : DAY;
      this.nextBeat += 60 / song.bpm / 2; // eighth notes
      this.beat++;
    }
  }

  private playBeat(t: number) {
    const song = this.mood === 'night' ? NIGHT : DAY;
    const eighth = 60 / song.bpm / 2;
    const step = this.beat % 8;
    const bar = Math.floor(this.beat / 8);
    const chord = song.chords[bar % song.chords.length];
    if (step === 0) {
      this.pad(chord, t, eighth * 8);
      this.bassNote(NOTE(chord[0] - 24), t, eighth * 3.5);
    }
    if (step === 4) this.bassNote(NOTE(chord[0] - 24 + (bar % 2 ? 7 : 0)), t, eighth * 3.5);
    // melody: a gentle random walk over the scale, denser by day
    const density = this.mood === 'night' ? 0.28 : 0.45;
    if (Math.random() < density && step % 2 === (bar % 2)) {
      this.melody = Math.max(0, Math.min(song.scale.length - 1, this.melody + Math.round((Math.random() - 0.5) * 3)));
      this.pluck(NOTE(song.scale[this.melody]), t);
    }
    // combat layer: kick on beats, hats off-beat (silent unless the combat bus is open)
    if (step % 2 === 0) this.kick(t);
    else this.hat(t);
    if (step === 4 || step === 0) this.stats.notes++;
  }

  private pad(notes: number[], t: number, dur: number) {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = this.mood === 'night' ? 650 : 1000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.035, t + 1.2);
    env.gain.setValueAtTime(0.035, t + dur - 0.6);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.8);
    filter.connect(env);
    env.connect(this.musicBus);
    env.connect(this.reverbSend);
    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = NOTE(n);
        o.detune.value = detune;
        o.connect(filter);
        o.start(t);
        o.stop(t + dur + 1);
      }
    }
  }

  private pluck(freq: number, t: number) {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.11, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    env.connect(this.musicBus);
    env.connect(this.reverbSend);
    for (const [type, mult, level] of [['triangle', 1, 1], ['sine', 2, 0.35]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(env);
      o.start(t);
      o.stop(t + 1);
    }
  }

  private bassNote(freq: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.13, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(env).connect(this.musicBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.5, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(env).connect(this.combatBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  private hat(t: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.06, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp).connect(env).connect(this.combatBus);
    src.start(t, Math.random() * 0.5, 0.06);
  }

  // ---------------------------------------------------------------- ambience

  private startWind() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 380;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    // slow gusts
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain).connect(g.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.11;
    const lfo2Gain = ctx.createGain();
    lfo2Gain.gain.value = 160;
    lfo2.connect(lfo2Gain).connect(bp.frequency);
    src.connect(bp).connect(g).connect(this.ambBus);
    src.start();
    lfo.start();
    lfo2.start();
  }

  private ambience() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + Math.random() * 0.8;
    if (this.mood === 'day' && Math.random() < 0.3) {
      // a bird: a few quick rising chirps
      const base = 2300 + Math.random() * 1600;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) this.chirp(base * (1 + Math.random() * 0.1), t + i * 0.13, this.ambBus);
    } else if (this.mood === 'night' && Math.random() < 0.5) {
      // a cricket: an amplitude-pulsed high tone
      const o = ctx.createOscillator();
      o.frequency.value = 4300 + Math.random() * 500;
      const am = ctx.createGain();
      am.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 28;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.02;
      lfo.connect(lfoGain).connect(am.gain);
      o.connect(am).connect(this.ambBus);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.35);
      lfo.stop(t + 0.35);
    }
  }

  private chirp(freq: number, t: number, out: AudioNode) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.45, t + 0.07);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.025, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(env).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }

  // ---------------------------------------------------------------- effects

  /** Plays a sound effect; `volume` lets callers fade distant sounds. */
  play(name: Sfx, volume = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || volume <= 0.01) return;
    this.stats.sfx++;
    const t = ctx.currentTime + 0.005;
    const out = ctx.createGain();
    out.gain.value = volume;
    out.connect(this.sfxBus);
    const vary = 0.92 + Math.random() * 0.16;
    switch (name) {
      case 'chop':
        this.noiseHit(t, out, { type: 'bandpass', freq: 900 * vary, q: 1.2, level: 0.5, decay: 0.12 });
        this.tone(t, out, { freq: 160 * vary, to: 70, level: 0.5, decay: 0.15 });
        break;
      case 'mine':
        this.noiseHit(t, out, { type: 'highpass', freq: 2500, q: 0.7, level: 0.25, decay: 0.06 });
        this.tone(t, out, { freq: 1750 * vary, level: 0.18, decay: 0.35, type: 'triangle' });
        this.tone(t, out, { freq: 2630 * vary, level: 0.1, decay: 0.25, type: 'triangle' });
        break;
      case 'swing':
        this.noiseSweep(t, out, { from: 600, to: 3200, level: 0.35, dur: 0.18 });
        break;
      case 'enemy-swing':
        this.noiseSweep(t, out, { from: 400, to: 1800, level: 0.25, dur: 0.2 });
        break;
      case 'zap':
        this.tone(t, out, { freq: 700, to: 1900, level: 0.18, decay: 0.25, type: 'sawtooth', lowpass: 2500 });
        this.tone(t + 0.02, out, { freq: 1400, to: 2600, level: 0.08, decay: 0.2, type: 'sine' });
        break;
      case 'hit':
        this.noiseHit(t, out, { type: 'lowpass', freq: 1400, q: 0.8, level: 0.45, decay: 0.09 });
        this.tone(t, out, { freq: 220 * vary, to: 90, level: 0.35, decay: 0.12 });
        break;
      case 'crit':
        this.noiseHit(t, out, { type: 'lowpass', freq: 2200, q: 0.8, level: 0.55, decay: 0.12 });
        this.tone(t, out, { freq: 300, to: 80, level: 0.45, decay: 0.18 });
        this.tone(t + 0.03, out, { freq: 1200, level: 0.12, decay: 0.2, type: 'triangle' });
        break;
      case 'hurt':
        this.tone(t, out, { freq: 180, to: 110, level: 0.35, decay: 0.18, type: 'square', lowpass: 900 });
        this.noiseHit(t, out, { type: 'lowpass', freq: 700, q: 0.7, level: 0.35, decay: 0.1 });
        break;
      case 'enemy-death':
        // rattling bones: a short run of clicks
        for (let i = 0; i < 6; i++) this.noiseHit(t + i * 0.045 + Math.random() * 0.02, out, { type: 'bandpass', freq: 1800 + Math.random() * 1500, q: 4, level: 0.35, decay: 0.03 });
        this.tone(t, out, { freq: 260, to: 90, level: 0.2, decay: 0.4, type: 'triangle' });
        break;
      case 'pickup':
        this.tone(t, out, { freq: 988, level: 0.12, decay: 0.12, type: 'triangle' });
        this.tone(t + 0.06, out, { freq: 1319, level: 0.12, decay: 0.16, type: 'triangle' });
        break;
      case 'loot':
        [1047, 1319, 1568, 2093].forEach((f, i) => this.tone(t + i * 0.07, out, { freq: f, level: 0.12, decay: 0.3, type: 'triangle', reverb: true }));
        break;
      case 'craft':
        this.tone(t, out, { freq: 1500, level: 0.15, decay: 0.2, type: 'triangle' });
        this.noiseHit(t, out, { type: 'highpass', freq: 3000, q: 0.7, level: 0.2, decay: 0.05 });
        this.tone(t + 0.16, out, { freq: 1700, level: 0.15, decay: 0.25, type: 'triangle' });
        this.noiseHit(t + 0.16, out, { type: 'highpass', freq: 3000, q: 0.7, level: 0.2, decay: 0.05 });
        break;
      case 'build':
        for (let i = 0; i < 3; i++) {
          this.tone(t + i * 0.14, out, { freq: 140 + i * 10, to: 70, level: 0.45, decay: 0.12 });
          this.noiseHit(t + i * 0.14, out, { type: 'bandpass', freq: 700, q: 1.5, level: 0.35, decay: 0.08 });
        }
        break;
      case 'potion':
        for (let i = 0; i < 4; i++) this.tone(t + i * 0.06, out, { freq: 500 + i * 140 + Math.random() * 60, to: 900 + i * 150, level: 0.08, decay: 0.08, type: 'sine' });
        break;
      case 'levelup':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(t + i * 0.09, out, { freq: f, level: 0.13, decay: 0.6, type: 'triangle', reverb: true }));
        break;
      case 'death':
        this.tone(t, out, { freq: 330, to: 110, level: 0.25, decay: 1.2, type: 'sawtooth', lowpass: 800, reverb: true });
        this.tone(t + 0.25, out, { freq: 247, to: 82, level: 0.2, decay: 1.2, type: 'sawtooth', lowpass: 700, reverb: true });
        break;
      case 'respawn':
        [392, 523, 659].forEach((f, i) => this.tone(t + i * 0.12, out, { freq: f, level: 0.1, decay: 0.7, type: 'sine', reverb: true }));
        break;
      case 'step':
        this.noiseHit(t, out, { type: 'lowpass', freq: 500 * vary, q: 0.7, level: 0.12, decay: 0.05 });
        break;
      case 'click':
        this.tone(t, out, { freq: 1800, level: 0.05, decay: 0.03, type: 'square', lowpass: 4000 });
        break;
      case 'error':
        this.tone(t, out, { freq: 220, level: 0.1, decay: 0.12, type: 'square', lowpass: 1200 });
        this.tone(t + 0.1, out, { freq: 185, level: 0.1, decay: 0.15, type: 'square', lowpass: 1200 });
        break;
    }
  }

  private tone(t: number, out: AudioNode, o: { freq: number; to?: number; level: number; decay: number; type?: OscillatorType; lowpass?: number; reverb?: boolean }) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + o.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(o.level, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
    let node: AudioNode = osc;
    if (o.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.lowpass;
      node = node.connect(f);
    }
    node.connect(env).connect(out);
    if (o.reverb) env.connect(this.reverbSend);
    osc.start(t);
    osc.stop(t + o.decay + 0.05);
  }

  private noiseHit(t: number, out: AudioNode, o: { type: BiquadFilterType; freq: number; q: number; level: number; decay: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.frequency.value = o.freq;
    f.Q.value = o.q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(o.level, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
    src.connect(f).connect(env).connect(out);
    src.start(t, Math.random() * 0.8, o.decay + 0.05);
  }

  private noiseSweep(t: number, out: AudioNode, o: { from: number; to: number; level: number; dur: number }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(o.from, t);
    f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(o.level, t + o.dur * 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(env).connect(out);
    src.start(t, Math.random() * 0.5, o.dur + 0.05);
  }
}

export const audio = new AudioEngine();
