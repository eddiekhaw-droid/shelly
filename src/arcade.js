// Shelly Invaders — a classic Space Invaders clone, shipped as an arcade
// easter egg. Fully self-contained: builds its own overlay + canvas, runs its
// own loop, and tears everything down on close. No PDF code is touched while
// the game is up.

const W = 640;
const H = 480;
const HS_KEY = 'shelly.arcade.highscore';

const INV_COLS = 11;
const INV_ROWS = 5;
const INV_W = 32;
const INV_H = 22;
const INV_GAP_X = 14;
const INV_GAP_Y = 14;
const PLAYER_Y = H - 56;
const PLAYER_W = 40;
const PLAYER_H = 18;

// Row types, top to bottom: squid (30 pts), crab ×2 (20), octopus ×2 (10) —
// the original's scoring.
const ROW_TYPES = ['squid', 'crab', 'crab', 'octopus', 'octopus'];
const TYPE_POINTS = { squid: 30, crab: 20, octopus: 10 };
const TYPE_COLORS = { squid: '#8e4ec6', crab: '#3d7bfd', octopus: '#46a758' };

// 11×8 pixel-art sprites, two animation frames each. '#' = lit pixel.
const SPRITES = {
  squid: [
    ['...##......', '..####.....', '.######....', '##.##.##...', '###########', '..#.#.#....', '.#.....#...', '#.#...#.#..'],
    ['...##......', '..####.....', '.######....', '##.##.##...', '###########', '.#.#.#.#...', '#.......#..', '.#.....#...'],
  ],
  crab: [
    ['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...'],
    ['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '.#########.', '..#######..', '..#.....#..', '.#.......#.'],
  ],
  octopus: [
    ['....###....', '.#########.', '###########', '###..#..###', '###########', '...##.##...', '..##.#.##..', '##.......##'],
    ['....###....', '.#########.', '###########', '###..#..###', '###########', '..###.###..', '.##..#..##.', '..#.....#..'],
  ],
};

let active = null; // the open game instance, if any

export function currentGame() {
  return active;
}

export function openArcade() {
  if (active) return active;
  active = new Arcade();
  return active;
}

class Arcade {
  constructor() {
    this.buildDom();
    this.audio = new Bleeper();
    this.highScore = Number(localStorage.getItem(HS_KEY)) || 0;
    this.resetMatch();
    this.mode = 'title'; // title | play | pause | cleared | over
    this.keys = {};

    this.onKey = this.onKey.bind(this);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);

    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  buildDom() {
    this.root = document.createElement('div');
    this.root.id = 'arcade';
    this.root.innerHTML = `
      <div id="arcade-cab">
        <div id="arcade-marquee">SHELLY&nbsp;INVADERS</div>
        <canvas width="${W}" height="${H}"></canvas>
        <div id="arcade-help">&larr;&thinsp;&rarr; move &middot; Space fire &middot; P pause &middot; Esc quit</div>
      </div>`;
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  close() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    this.root.remove();
    this.audio.close();
    active = null;
  }

  // ---- state ----

  resetMatch() {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.resetWave();
  }

  resetWave() {
    this.player = { x: W / 2 - PLAYER_W / 2, cooldown: 0, dead: 0 };
    this.shot = null; // one player bullet on screen, like the original
    this.bombs = [];
    this.ufo = null;
    this.ufoTimer = 12 + Math.random() * 10;
    this.buildInvaders();
    this.buildBunkers();
  }

  buildInvaders() {
    this.invaders = [];
    // Each wave starts a row lower, capped so it stays winnable.
    const top = 70 + Math.min(this.level - 1, 4) * (INV_H + INV_GAP_Y) * 0.5;
    for (let r = 0; r < INV_ROWS; r++) {
      for (let c = 0; c < INV_COLS; c++) {
        this.invaders.push({
          x: 60 + c * (INV_W + INV_GAP_X),
          y: top + r * (INV_H + INV_GAP_Y),
          type: ROW_TYPES[r],
          alive: true,
        });
      }
    }
    this.dir = 1;
    this.stepTimer = 0;
    this.animFrame = 0;
    this.marchNote = 0;
  }

  buildBunkers() {
    // Four destructible bunkers, each an 11×8 grid of chunky cells that get
    // eaten away shot by shot.
    this.bunkers = [];
    const cell = 6;
    const shape = ['..#######..', '.#########.', '###########', '###########', '###########', '####...####', '###.....###', '###.....###'];
    for (let b = 0; b < 4; b++) {
      const ox = 70 + b * 140;
      const oy = PLAYER_Y - 70;
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c] === '#') {
            this.bunkers.push({ x: ox + c * cell, y: oy + r * cell, s: cell, alive: true });
          }
        }
      }
    }
  }

  aliveInvaders() {
    return this.invaders.filter((i) => i.alive);
  }

  // ---- input ----

  onKey(e) {
    const k = e.key;
    if (e.type === 'keyup') {
      this.keys[k] = false;
      return;
    }
    // The game owns the keyboard while open, so app shortcuts can't fire.
    e.preventDefault();
    e.stopPropagation();
    this.keys[k] = true;
    if (k === 'Escape') return this.close();
    if (k === 'p' || k === 'P') {
      if (this.mode === 'play') this.mode = 'pause';
      else if (this.mode === 'pause') this.mode = 'play';
      return;
    }
    if (k === ' ' || k === 'Enter') this.advance();
  }

  advance() {
    this.audio.resume();
    if (this.mode === 'title') {
      this.resetMatch();
      this.mode = 'play';
    } else if (this.mode === 'cleared') {
      this.level += 1;
      this.resetWave();
      this.mode = 'play';
    } else if (this.mode === 'over') {
      this.mode = 'title';
    }
    // In play mode, Space is handled in step() as fire.
  }

  // ---- simulation ----

  frame(t) {
    const dt = Math.min((t - this.last) / 1000, 1 / 30);
    this.last = t;
    if (this.mode === 'play') this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  step(dt) {
    const p = this.player;

    // Brief freeze after being hit, then respawn.
    if (p.dead > 0) {
      p.dead -= dt;
      if (p.dead <= 0) {
        p.x = W / 2 - PLAYER_W / 2;
        this.bombs = [];
      }
      return;
    }

    // Player
    const move = 300 * dt;
    if (this.keys.ArrowLeft) p.x -= move;
    if (this.keys.ArrowRight) p.x += move;
    p.x = clamp(p.x, 8, W - PLAYER_W - 8);
    p.cooldown -= dt;
    if (this.keys[' '] && !this.shot && p.cooldown <= 0) {
      this.shot = { x: p.x + PLAYER_W / 2, y: PLAYER_Y - 6 };
      p.cooldown = 0.25;
      this.audio.blip(880, 0.06);
    }

    this.stepInvaders(dt);
    this.stepUfo(dt);
    this.stepShot(dt);
    this.stepBombs(dt);

    // Invaders reaching the player's row is game over, original-style.
    if (this.aliveInvaders().some((i) => i.y + INV_H >= PLAYER_Y)) this.gameOver();
  }

  stepInvaders(dt) {
    const alive = this.aliveInvaders();
    if (alive.length === 0) {
      this.mode = 'cleared';
      this.audio.jingle([523, 659, 784, 1047]);
      return;
    }

    // The classic accelerating march: the fewer invaders, the faster the
    // grid steps. Interval shrinks from ~0.7s to ~0.05s.
    const interval = Math.max(0.05, (0.72 - (this.level - 1) * 0.06) * (alive.length / (INV_ROWS * INV_COLS)) + 0.05);
    this.stepTimer += dt;
    if (this.stepTimer < interval) return;
    this.stepTimer = 0;

    const minX = Math.min(...alive.map((i) => i.x));
    const maxX = Math.max(...alive.map((i) => i.x + INV_W));
    const hitEdge = (this.dir > 0 && maxX >= W - 12) || (this.dir < 0 && minX <= 12);
    if (hitEdge) {
      this.dir = -this.dir;
      for (const inv of this.invaders) inv.y += 14;
    } else {
      for (const inv of this.invaders) inv.x += this.dir * 10;
    }
    this.animFrame = 1 - this.animFrame;
    // The four-note bass march, cycling as the grid steps.
    this.audio.blip([110, 104, 98, 92][this.marchNote], 0.07);
    this.marchNote = (this.marchNote + 1) % 4;

    // Bombing: bottom-most invader of a random occupied column drops one.
    const maxBombs = Math.min(1 + this.level, 4);
    if (this.bombs.length < maxBombs && Math.random() < 0.55) {
      const cols = new Map();
      for (const inv of alive) {
        const key = Math.round(inv.x);
        if (!cols.has(key) || inv.y > cols.get(key).y) cols.set(key, inv);
      }
      const shooters = [...cols.values()];
      const s = shooters[Math.floor(Math.random() * shooters.length)];
      this.bombs.push({ x: s.x + INV_W / 2, y: s.y + INV_H, wobble: Math.random() * Math.PI });
    }
  }

  stepUfo(dt) {
    if (this.ufo) {
      this.ufo.x += this.ufo.vx * dt;
      if (this.ufo.x < -60 || this.ufo.x > W + 60) this.ufo = null;
      else if (Math.floor(performance.now() / 120) % 2 === 0) this.audio.blip(600 + Math.sin(performance.now() / 90) * 120, 0.04, 0, 0.015);
      return;
    }
    this.ufoTimer -= dt;
    if (this.ufoTimer <= 0) {
      const fromLeft = Math.random() < 0.5;
      this.ufo = { x: fromLeft ? -50 : W + 50, y: 44, vx: fromLeft ? 110 : -110 };
      this.ufoTimer = 18 + Math.random() * 14;
    }
  }

  stepShot(dt) {
    const s = this.shot;
    if (!s) return;
    s.y -= 480 * dt;
    if (s.y < 30) {
      this.shot = null;
      return;
    }
    // Invaders
    for (const inv of this.aliveInvaders()) {
      if (s.x >= inv.x && s.x <= inv.x + INV_W && s.y >= inv.y && s.y <= inv.y + INV_H) {
        inv.alive = false;
        this.score += TYPE_POINTS[inv.type];
        this.shot = null;
        this.audio.blip(200, 0.09);
        return;
      }
    }
    // UFO — mystery score, like the original.
    const u = this.ufo;
    if (u && s.x >= u.x && s.x <= u.x + 48 && s.y >= u.y && s.y <= u.y + 20) {
      this.score += [50, 100, 150, 300][Math.floor(Math.random() * 4)];
      this.ufo = null;
      this.shot = null;
      this.audio.jingle([784, 988, 1175], 0.07);
      return;
    }
    // Bunkers
    const cell = this.hitBunker(s.x, s.y);
    if (cell) this.shot = null;
  }

  stepBombs(dt) {
    const p = this.player;
    for (const bomb of [...this.bombs]) {
      bomb.y += (150 + this.level * 15) * dt;
      bomb.wobble += dt * 14;
      if (bomb.y > H) {
        this.bombs.splice(this.bombs.indexOf(bomb), 1);
        continue;
      }
      if (this.hitBunker(bomb.x, bomb.y)) {
        this.bombs.splice(this.bombs.indexOf(bomb), 1);
        continue;
      }
      if (bomb.y >= PLAYER_Y && bomb.y <= PLAYER_Y + PLAYER_H && bomb.x >= p.x && bomb.x <= p.x + PLAYER_W) {
        this.bombs.splice(this.bombs.indexOf(bomb), 1);
        this.lives -= 1;
        this.audio.jingle([392, 311, 262], 0.09);
        if (this.lives <= 0) this.gameOver();
        else p.dead = 1.2;
      }
    }
  }

  hitBunker(x, y) {
    for (const c of this.bunkers) {
      if (c.alive && x >= c.x && x <= c.x + c.s && y >= c.y && y <= c.y + c.s) {
        // Chew a small blast radius out of the bunker.
        for (const n of this.bunkers) {
          if (n.alive && Math.abs(n.x - c.x) <= c.s && Math.abs(n.y - c.y) <= c.s) n.alive = false;
        }
        return c;
      }
    }
    return null;
  }

  gameOver() {
    this.mode = 'over';
    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem(HS_KEY, String(this.highScore));
    }
  }

  // ---- rendering ----

  draw() {
    const g = this.ctx;
    g.fillStyle = '#101116';
    g.fillRect(0, 0, W, H);

    // HUD
    g.font = 'bold 14px "Courier New", monospace';
    g.fillStyle = '#9a9ba3';
    g.textAlign = 'left';
    g.fillText(`SCORE ${String(this.score).padStart(6, '0')}`, 12, 24);
    g.textAlign = 'center';
    g.fillText(`HI ${String(Math.max(this.highScore, this.score)).padStart(6, '0')}`, W / 2, 24);
    g.textAlign = 'right';
    g.fillText(`LEVEL ${this.level}   ${'▲'.repeat(Math.max(this.lives, 0))}`, W - 12, 24);

    // Ground line
    g.fillStyle = '#46a758';
    g.fillRect(8, H - 18, W - 16, 2);

    if (this.mode !== 'title') {
      this.drawInvaders(g);
      this.drawBunkers(g);
      this.drawPlayer(g);
      if (this.ufo) this.drawUfo(g);
      if (this.shot) {
        g.fillStyle = '#e8e8ea';
        g.fillRect(this.shot.x - 1, this.shot.y - 8, 2, 8);
      }
      g.fillStyle = '#ffc53d';
      for (const bomb of this.bombs) {
        g.fillRect(bomb.x - 1 + Math.sin(bomb.wobble) * 2, bomb.y, 2, 7);
      }
    }

    g.textAlign = 'center';
    if (this.mode === 'title') {
      this.drawTitle(g);
    } else if (this.mode === 'pause') {
      this.banner('PAUSED', 'press P to resume');
    } else if (this.mode === 'cleared') {
      this.banner(`WAVE ${this.level} CLEARED`, 'press Space for the next wave');
    } else if (this.mode === 'over') {
      const crowned = this.score >= this.highScore && this.score > 0;
      this.banner('GAME OVER', crowned ? `NEW HIGH SCORE ${this.score}` : 'press Space');
    }

    // Scanlines for the CRT feel.
    g.fillStyle = 'rgba(0,0,0,0.14)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 2);
  }

  drawInvaders(g) {
    for (const inv of this.aliveInvaders()) {
      drawSprite(g, SPRITES[inv.type][this.animFrame], inv.x, inv.y, 3, TYPE_COLORS[inv.type]);
    }
  }

  drawBunkers(g) {
    g.fillStyle = '#46a758';
    for (const c of this.bunkers) if (c.alive) g.fillRect(c.x, c.y, c.s - 1, c.s - 1);
  }

  drawPlayer(g) {
    const p = this.player;
    if (p.dead > 0 && Math.floor(performance.now() / 100) % 2 === 0) return; // hit flicker
    g.fillStyle = '#3d7bfd';
    g.fillRect(p.x, PLAYER_Y + 8, PLAYER_W, PLAYER_H - 8);
    g.fillRect(p.x + 6, PLAYER_Y + 4, PLAYER_W - 12, 6);
    g.fillRect(p.x + PLAYER_W / 2 - 2, PLAYER_Y - 2, 4, 8);
  }

  drawUfo(g) {
    const u = this.ufo;
    g.fillStyle = '#e5484d';
    g.beginPath();
    g.ellipse(u.x + 24, u.y + 10, 24, 9, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffc53d';
    g.fillRect(u.x + 14, u.y + 2, 20, 6);
  }

  drawTitle(g) {
    g.fillStyle = '#e8e8ea';
    g.font = 'bold 40px "Courier New", monospace';
    g.fillText('SHELLY INVADERS', W / 2, 130);

    // Score table, like the original attract screen.
    g.font = 'bold 15px "Courier New", monospace';
    g.fillStyle = '#9a9ba3';
    g.fillText('* SCORE ADVANCE TABLE *', W / 2, 190);
    const rows = [
      ['squid', '= 30 POINTS'],
      ['crab', '= 20 POINTS'],
      ['octopus', '= 10 POINTS'],
    ];
    rows.forEach(([type, label], i) => {
      const y = 220 + i * 44;
      drawSprite(g, SPRITES[type][0], W / 2 - 90, y, 3, TYPE_COLORS[type]);
      g.fillStyle = '#9a9ba3';
      g.textAlign = 'left';
      g.fillText(label, W / 2 - 40, y + 18);
      g.textAlign = 'center';
    });
    g.fillStyle = '#e5484d';
    g.fillText('? MYSTERY', W / 2 + 130, 220 + 18);

    g.fillStyle = '#ffc53d';
    g.font = 'bold 16px "Courier New", monospace';
    if (Math.floor(performance.now() / 500) % 2 === 0) g.fillText('INSERT COIN — press Space', W / 2, 410);
  }

  banner(big, small) {
    const g = this.ctx;
    g.fillStyle = 'rgba(16,17,22,0.72)';
    g.fillRect(0, H / 2 - 70, W, 130);
    g.fillStyle = '#e8e8ea';
    g.font = 'bold 36px "Courier New", monospace';
    g.fillText(big, W / 2, H / 2 - 12);
    g.fillStyle = '#ffc53d';
    g.font = 'bold 16px "Courier New", monospace';
    // Classic attract-mode blink.
    if (Math.floor(performance.now() / 500) % 2 === 0) g.fillText(small, W / 2, H / 2 + 28);
  }
}

function drawSprite(g, rows, x, y, px, color) {
  g.fillStyle = color;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] === '#') g.fillRect(x + c * px, y + r * px, px, px);
    }
  }
}

// Tiny square-wave synth: enough for arcade blips without any assets.
class Bleeper {
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ctx = null;
    }
  }
  resume() {
    this.ctx?.resume().catch(() => {});
  }
  blip(freq, dur = 0.05, at = 0, vol = 0.04) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + at;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }
  jingle(freqs, step = 0.11) {
    freqs.forEach((f, i) => this.blip(f, step, i * step));
  }
  close() {
    this.ctx?.close().catch(() => {});
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// The classic unlock: ↑↑↓↓←→←→BA, listened for app-wide.
const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
export function installKonami() {
  let idx = 0;
  window.addEventListener('keydown', (e) => {
    if (active || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    idx = e.key === KONAMI[idx] ? idx + 1 : e.key === KONAMI[0] ? 1 : 0;
    if (idx === KONAMI.length) {
      idx = 0;
      openArcade();
    }
  });
}
