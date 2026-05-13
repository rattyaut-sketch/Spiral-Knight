// UI: controls, piece editor, color config, auto-play, precompute+replay

const PLAYER_NAMES = ['White', 'Black', 'Red', 'Blue', 'Green', 'Orange'];
const DEFAULT_COLORS = ['#505050', '#f0f0f0', '#101010', '#e05252', '#4a90d9', '#4caf50', '#ff9800'];

class UI {
  constructor() {
    this.playerColors = [...DEFAULT_COLORS];
    this.attackOffsets = [...DEFAULT_ATTACK_OFFSETS];
    this.numPlayers = 2;
    this.gridW = 30;
    this.gridH = 30;
    this.autoPlaying = false;
    this._autoTimer = null;
    this._usingRAF = false;

    // Precompute / playback state
    this.precomputed = null; // null = live mode; Int32Array = precomputed moves
    this.playbackPos = 0;    // how many moves currently displayed

    const spiralData = generateSpiral(this.gridW, this.gridH);
    this.game = new Game(spiralData, this.attackOffsets, this.numPlayers);

    this._buildDOM();
    this._bindEvents();
    this._updatePieceEditor();
    this._updateInfo();
  }

  // ── Game init ────────────────────────────────────────────────────────────

  _initGame() {
    this._stopAuto();
    this.precomputed = null;
    this.playbackPos = 0;
    const spiralData = generateSpiral(this.gridW, this.gridH);
    const prevPrimeMask = this.game?.primeMask !== null; // carry over toggle state
    this.game = new Game(spiralData, this.attackOffsets, this.numPlayers);
    if (prevPrimeMask) {
      this.game.primeMask = buildPrimeMask(this.game.spiral.totalCells);
      this.game.init(); // rebuild attack table with new mask
    }
    this.renderer.game = this.game;
    this._showScrubber(false);
    this.renderer.renderFull();
    this.renderer.resetView();
    this._updateInfo();
  }

  _rebuildAndReset() {
    this._stopAuto();
    this.precomputed = null;
    this.playbackPos = 0;
    this.game.attackOffsets = this.attackOffsets;
    this.game.numPlayers = this.numPlayers;
    this.game.init();
    this.renderer.game = this.game;
    this._showScrubber(false);
    this.renderer.renderFull();
    this._updateInfo();
  }

  // ── Precompute ───────────────────────────────────────────────────────────

  _precompute() {
    this._stopAuto();
    this.btnPrecompute.textContent = 'Computing…';
    this.btnPrecompute.disabled = true;

    // Yield to browser to repaint the button label, then compute
    setTimeout(() => {
      const t0 = performance.now();
      this.precomputed = this.game.computeAll();
      const ms = (performance.now() - t0).toFixed(1);

      // Reset display to move 0 (just White on cell 0)
      this.playbackPos = 0;
      this.game.board.fill(0);
      this.game.board[this.precomputed[0]] = 1; // White on cell 0
      this.playbackPos = 1;

      this.btnPrecompute.textContent = `Recompute (${this.precomputed.length} moves, ${ms}ms)`;
      this.btnPrecompute.disabled = false;
      this._showScrubber(true);
      this.scrubber.max = this.precomputed.length;
      this.scrubber.value = 1;
      this.renderer.renderFull();
      this._updateInfo();
    }, 16);
  }

  // Apply precomputed moves 0..pos (exclusive) to game.board
  _setPlaybackPos(pos) {
    pos = Math.max(0, Math.min(this.precomputed.length, pos));
    if (pos === this.playbackPos) return;

    if (pos > this.playbackPos) {
      // Forward: apply only new moves
      for (let i = this.playbackPos; i < pos; i++) {
        this.game.board[this.precomputed[i]] = (i % this.numPlayers) + 1;
      }
    } else {
      // Backward: full rebuild from scratch
      this.game.board.fill(0);
      for (let i = 0; i < pos; i++) {
        this.game.board[this.precomputed[i]] = (i % this.numPlayers) + 1;
      }
    }
    this.playbackPos = pos;
    this.scrubber.value = pos;
    this._updateInfo();
  }

  _showScrubber(visible) {
    this.scrubberRow.style.display = visible ? 'flex' : 'none';
  }

  // ── Step / Auto ──────────────────────────────────────────────────────────

  _doStep() {
    if (this.precomputed) {
      if (this.playbackPos >= this.precomputed.length) { this._stopAuto(); return; }
      const cell = this.precomputed[this.playbackPos];
      this.game.board[cell] = (this.playbackPos % this.numPlayers) + 1;
      this.playbackPos++;
      this.scrubber.value = this.playbackPos;
      this.renderer.renderCell(cell);
      this._updateInfo();
      if (this.playbackPos >= this.precomputed.length) this._stopAuto();
    } else {
      if (this.game.gameOver) { this._stopAuto(); return; }
      const placed = this.game.step();
      if (placed >= 0) this.renderer.renderCell(placed);
      this._updateInfo();
      if (this.game.gameOver) this._stopAuto();
    }
  }

  _startAuto() {
    this.autoPlaying = true;
    this.btnAuto.textContent = '⏸ Pause';
    this.btnAuto.style.background = '#4a2a2a';
    const stepsPerSec = sliderToSpeed(parseInt(this.speedSlider.value));

    if (stepsPerSec <= 60) {
      this._autoTimer = setInterval(() => this._doStep(), 1000 / stepsPerSec);
      this._usingRAF = false;
    } else {
      // RAF mode: fixed batch OR time-budget (Infinity = as fast as possible)
      const fixed = isFinite(stepsPerSec) ? Math.ceil(stepsPerSec / 60) : null;

      const advance = (n) => {
        if (this.precomputed) {
          const end = n === null
            ? this.precomputed.length
            : Math.min(this.playbackPos + n, this.precomputed.length);
          for (let i = this.playbackPos; i < end; i++) {
            this.game.board[this.precomputed[i]] = (i % this.numPlayers) + 1;
          }
          this.playbackPos = end;
          this.scrubber.value = end;
          return end >= this.precomputed.length;
        } else {
          const count = n ?? 100000;
          for (let i = 0; i < count; i++) {
            if (this.game.gameOver) return true;
            this.game.step();
          }
          return this.game.gameOver;
        }
      };

      const frame = () => {
        if (!this.autoPlaying) return;
        let done;
        if (fixed === null) {
          // Time-budget: step as many as possible in 12ms, render once
          const deadline = performance.now() + 12;
          done = false;
          while (!done && performance.now() < deadline) {
            done = advance(1000);
          }
        } else {
          done = advance(fixed);
        }
        this.renderer.renderFull();
        this._updateInfo();
        if (done) { this._stopAuto(); return; }
        if (this.autoPlaying) this._autoTimer = requestAnimationFrame(frame);
      };
      this._autoTimer = requestAnimationFrame(frame);
      this._usingRAF = true;
    }
  }

  _stopAuto() {
    this.autoPlaying = false;
    this.btnAuto.textContent = '▶ Auto-Play';
    this.btnAuto.style.background = '#2a2a4a';
    if (this._usingRAF) cancelAnimationFrame(this._autoTimer);
    else clearInterval(this._autoTimer);
    this._autoTimer = null;
  }

  // ── Info ─────────────────────────────────────────────────────────────────

  _updateInfo() {
    if (this.precomputed) {
      const pos = this.playbackPos;
      const total = this.precomputed.length;
      const playerIdx = pos < total ? (pos % this.numPlayers) : ((total - 1) % this.numPlayers + 1) % this.numPlayers;
      const playerName = PLAYER_NAMES[playerIdx] ?? `P${playerIdx + 1}`;
      const dot = `<span style="color:${this.playerColors[playerIdx + 1]}">●</span>`;
      const done = pos >= total ? ' | <span style="color:#8f8">Done</span>' : '';
      this.infoBar.innerHTML = `Move: ${pos} / ${total} | Next: ${dot} ${playerName}${done}`;
    } else {
      const g = this.game;
      const playerName = PLAYER_NAMES[g.currentPlayer] ?? `P${g.currentPlayer + 1}`;
      const dot = `<span style="color:${this.playerColors[g.currentPlayer + 1]}">●</span>`;
      const last = g.lastPlaced >= 0 ? ` | Last: ${g.lastPlaced}` : '';
      const status = g.gameOver ? ' | <span style="color:#f88">GAME OVER</span>' : '';
      this.infoBar.innerHTML = `Move: ${g.moveCount} | Next: ${dot} ${playerName}${last}${status}`;
    }
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  _buildDOM() {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#111;color:#ddd;font-family:monospace;display:flex;flex-direction:column;height:100vh;overflow:hidden;';

    const topBar = el('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1e1e2e;flex-shrink:0;flex-wrap:wrap;border-bottom:1px solid #333;' });
    topBar.append(
      el('span', { style: 'font-size:14px;font-weight:bold;color:#adf;margin-right:4px;' }, 'SPIRAL KNIGHT'),
      el('label', {}, 'W:'),
      this.inputW = numInput(this.gridW, 5, 500),
      el('label', {}, '×'),
      this.inputH = numInput(this.gridH, 5, 500),
      this.btnReset = btn('Reset', '#444'),
      sep(),
      this.btnPrecompute = btn('Precompute All', '#3a2a4a'),
      this.btnRunAll = btn('Recompute & Max Auto-play', '#1a3a1a'),
      this.btnPrime = btn('Primes: OFF', '#333'),
      sep(),
      this.btnStep = btn('Step ▶', '#2a4a2a'),
      this.btnAuto = btn('Auto-Play', '#2a2a4a'),
      el('label', {}, 'Speed:'),
      this.speedSlider = range(1, 100, 40),
      this.speedLabel = el('span', { style: 'min-width:44px;font-size:11px;color:#aaa;' }, ''),
      sep(),
      el('label', {}, 'Zoom:'),
      this.btnZoomOut = btn('−', '#333'),
      this.btnZoomIn = btn('+', '#333'),
      this.zoomLabel = el('span', { style: 'min-width:50px;' }, '100%'),
    );

    this.infoBar = el('div', { style: 'font-size:12px;padding:3px 10px;background:#16161e;flex-shrink:0;color:#999;' }, 'Move: 0');

    // Scrubber row (hidden until precomputed)
    this.scrubberRow = el('div', { style: 'display:none;align-items:center;gap:8px;padding:4px 10px;background:#141420;flex-shrink:0;border-bottom:1px solid #333;' });
    this.scrubber = el('input', { type: 'range', min: 0, max: 1, value: 0, style: 'flex:1;accent-color:#88f;' });
    this.scrubberRow.append(el('span', { style: 'font-size:11px;color:#88f;' }, 'SCRUB'), this.scrubber);

    const mainArea = el('div', { style: 'display:flex;flex:1;min-height:0;' });

    const sidebar = el('div', { style: 'width:200px;flex-shrink:0;background:#161622;padding:10px;overflow-y:auto;border-right:1px solid #333;display:flex;flex-direction:column;gap:12px;' });
    sidebar.append(
      el('div', { style: 'font-size:11px;color:#88f;letter-spacing:1px;' }, 'PIECE EDITOR'),
      this.pieceEditorEl = el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:2px;' }),
      this.btnResetPiece = btn('Reset to Knight', '#333', '11px'),
      el('div', { style: 'font-size:11px;color:#88f;letter-spacing:1px;margin-top:4px;' }, 'PLAYERS'),
      this.colorListEl = el('div', { style: 'display:flex;flex-direction:column;gap:4px;' }),
      this.btnAddPlayer = btn('+ Add Player', '#333', '11px'),
    );

    this.canvas = el('canvas', { style: 'flex:1;display:block;cursor:grab;' });
    mainArea.append(sidebar, this.canvas);
    document.body.append(topBar, this.infoBar, this.scrubberRow, mainArea);

    this.renderer = new Renderer(this.canvas, this.game, this.playerColors);
    this.renderer._onZoomChange = (z) => { this.zoomLabel.textContent = Math.round(z * 100) + '%'; };
    this.renderer.resetView();
    this._rebuildColorList();
  }

  _bindEvents() {
    this.btnReset.addEventListener('click', () => {
      this.gridW = parseInt(this.inputW.value) || 30;
      this.gridH = parseInt(this.inputH.value) || 30;
      this._initGame();
    });

    this.btnPrecompute.addEventListener('click', () => this._precompute());

    this.btnRunAll.addEventListener('click', () => {
      // Precompute then immediately start auto-play at MAX speed
      this._stopAuto();
      this.btnRunAll.textContent = 'Computing…';
      this.btnRunAll.disabled = true;
      setTimeout(() => {
        const t0 = performance.now();
        this.precomputed = this.game.computeAll();
        const ms = (performance.now() - t0).toFixed(1);

        this.game.board.fill(0);
        this.game.board[this.precomputed[0]] = 1;
        this.playbackPos = 1;

        this.btnPrecompute.textContent = `Recompute (${this.precomputed.length} moves, ${ms}ms)`;
        this._showScrubber(true);
        this.scrubber.max = this.precomputed.length;
        this.scrubber.value = 1;

        this.btnRunAll.textContent = 'Recompute & Max Auto-play';
        this.btnRunAll.disabled = false;

        // Pin slider to MAX and auto-play
        this.speedSlider.value = 100;
        this._updateSpeedLabel();
        this._updateInfo();
        this._startAuto();
      }, 16);
    });

    this.btnPrime.addEventListener('click', () => {
      const on = this.game.primeMask === null;
      this.game.primeMask = on ? buildPrimeMask(this.game.spiral.totalCells) : null;
      this.btnPrime.textContent = on ? 'Primes: ON' : 'Primes: OFF';
      this.btnPrime.style.background = on ? '#3a1a3a' : '#333';
      this._rebuildAndReset();
    });
    this.btnStep.addEventListener('click', () => this._doStep());
    this.btnAuto.addEventListener('click', () => { if (this.autoPlaying) this._stopAuto(); else this._startAuto(); });
    this.speedSlider.addEventListener('input', () => {
      this._updateSpeedLabel();
      if (this.autoPlaying) { this._stopAuto(); this._startAuto(); }
    });
    this._updateSpeedLabel();
    this.btnZoomIn.addEventListener('click', () => this.renderer.zoomBy(1.3));
    this.btnZoomOut.addEventListener('click', () => this.renderer.zoomBy(1 / 1.3));

    this.scrubber.addEventListener('input', () => {
      this._stopAuto();
      // Store target pos; defer board-rebuild + render to next animation frame
      // so rapid scrubbing doesn't queue up expensive rebuilds
      this._scrubTarget = parseInt(this.scrubber.value);
      if (!this._scrubRAF) {
        this._scrubRAF = requestAnimationFrame(() => {
          this._scrubRAF = null;
          this._setPlaybackPos(this._scrubTarget);
          this.renderer.renderFull();
        });
      }
    });

    this.btnResetPiece.addEventListener('click', () => {
      this.attackOffsets = [...DEFAULT_ATTACK_OFFSETS];
      this._updatePieceEditor();
      this._rebuildAndReset();
    });

    this.btnAddPlayer.addEventListener('click', () => {
      if (this.numPlayers >= 6) return;
      this.numPlayers++;
      this._rebuildAndReset();
      this._rebuildColorList();
    });
  }

  _updateSpeedLabel() {
    const s = sliderToSpeed(parseInt(this.speedSlider.value));
    if (!isFinite(s)) { this.speedLabel.textContent = 'MAX'; return; }
    this.speedLabel.textContent = s >= 1000 ? (s / 1000).toFixed(1) + 'k/s' : s + '/s';
  }

  // ── Piece editor ─────────────────────────────────────────────────────────

  _updatePieceEditor() {
    this.pieceEditorEl.innerHTML = '';
    for (let row = 2; row >= -2; row--) {
      for (let col = -2; col <= 2; col++) {
        const isCenter = col === 0 && row === 0;
        const active = !isCenter && this.attackOffsets.some(o => o.dx === col && o.dy === row);
        const cell = el('div', {
          style: `width:28px;height:28px;display:flex;align-items:center;justify-content:center;
                  font-size:13px;cursor:${isCenter ? 'default' : 'pointer'};border-radius:3px;
                  background:${isCenter ? '#446' : active ? '#4a8a4a' : '#2a2a3a'};
                  border:1px solid ${isCenter ? '#88f' : active ? '#6c6' : '#444'};`,
        }, isCenter ? '♟' : active ? '✕' : '');
        if (!isCenter) {
          cell.addEventListener('click', () => {
            const idx = this.attackOffsets.findIndex(o => o.dx === col && o.dy === row);
            if (idx >= 0) this.attackOffsets.splice(idx, 1);
            else this.attackOffsets.push({ dx: col, dy: row });
            this._updatePieceEditor();
            this._rebuildAndReset();
          });
        }
        this.pieceEditorEl.appendChild(cell);
      }
    }
  }

  // ── Color config ──────────────────────────────────────────────────────────

  _rebuildColorList() {
    this.colorListEl.innerHTML = '';
    for (let p = 0; p < this.numPlayers; p++) {
      const colorIdx = p + 1;
      const row = el('div', { style: 'display:flex;align-items:center;gap:6px;' });
      const picker = el('input', { type: 'color', value: this.playerColors[colorIdx] ?? '#888888', style: 'width:28px;height:22px;cursor:pointer;border:none;background:none;padding:0;' });
      picker.addEventListener('input', () => {
        this.playerColors[colorIdx] = picker.value;
        this.renderer.playerColors = this.playerColors;
        this.renderer.renderFull();
      });
      row.append(picker, el('span', { style: 'font-size:12px;' }, PLAYER_NAMES[p] ?? `P${p + 1}`));
      if (p >= 2) {
        const rmBtn = btn('×', '#3a2222', '11px');
        rmBtn.style.cssText += 'padding:1px 5px;';
        rmBtn.addEventListener('click', () => { this.numPlayers--; this._rebuildAndReset(); this._rebuildColorList(); });
        row.append(rmBtn);
      }
      this.colorListEl.appendChild(row);
    }
  }
}

// ── Speed mapping ─────────────────────────────────────────────────────────
// Logarithmic: slider 1-100 → 1/sec … MAX
// 1→1, 25→10, 50→100, 75→1000, 99→~9000, 100→MAX (time-budget)
function sliderToSpeed(v) {
  if (v >= 100) return Infinity;
  return Math.max(1, Math.round(Math.pow(10, v * 4 / 100)));
}

// ── Helpers ───────────────────────────────────────────────────────────────

function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}

function btn(label, bg = '#333', fontSize = '12px') {
  const b = el('button', { style: `background:${bg};color:#ccc;border:1px solid #555;padding:3px 8px;cursor:pointer;font-family:monospace;font-size:${fontSize};border-radius:3px;` }, label);
  b.addEventListener('mouseover', () => b.style.opacity = '0.8');
  b.addEventListener('mouseout', () => b.style.opacity = '1');
  return b;
}

function numInput(val, min, max) {
  return el('input', { type: 'number', value: val, min, max, style: 'width:52px;background:#222;color:#ddd;border:1px solid #555;padding:2px 4px;font-family:monospace;font-size:12px;' });
}

function range(min, max, val) {
  return el('input', { type: 'range', min, max, value: val, style: 'width:80px;' });
}

function sep() {
  return el('span', { style: 'width:1px;height:20px;background:#444;display:inline-block;' });
}
