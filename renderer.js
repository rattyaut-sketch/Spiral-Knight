// Canvas renderer — pixel-buffer at low zoom, fillRect at high zoom

const BLOCKED_COLOR = '#2a1e30';

// Pack hex colour into little-endian RGBA Uint32 (for ImageData / Uint32Array)
function hexToU32(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

class Renderer {
  constructor(canvas, game, playerColors) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.playerColors = playerColors;

    this.zoom = 1.0;
    this.panX = 0;
    this.panY = 0;
    this._dragging = false;
    this._dragStart = null;

    this._setupEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _setupEvents() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * devicePixelRatio;
      const my = (e.clientY - rect.top) * devicePixelRatio;
      this.panX = mx - (mx - this.panX) * factor;
      this.panY = my - (my - this.panY) * factor;
      this.zoom = Math.max(0.05, Math.min(50, this.zoom * factor));
      this.renderFull();
      if (this._onZoomChange) this._onZoomChange(this.zoom);
    }, { passive: false });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._dragStart = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      const dpr = devicePixelRatio;
      this.panX = this._dragStart.px + (e.clientX - this._dragStart.x) * dpr;
      this.panY = this._dragStart.py + (e.clientY - this._dragStart.y) * dpr;
      this.renderFull();
    });
    const endDrag = () => { this._dragging = false; this.canvas.style.cursor = 'grab'; };
    this.canvas.addEventListener('mouseup', endDrag);
    this.canvas.addEventListener('mouseleave', endDrag);
  }

  _resize() {
    const dpr = devicePixelRatio;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.renderFull();
  }

  resetView() {
    const cw = this.canvas.width, ch = this.canvas.height;
    const { width, height } = this.game.spiral;
    const cp = Math.min(cw / width, ch / height);
    this.zoom = cp / 16;
    this.panX = cw / 2 - (width / 2) * this._cellPx();
    this.panY = ch / 2 - (height / 2) * this._cellPx();
    this.renderFull();
    if (this._onZoomChange) this._onZoomChange(this.zoom);
  }

  _cellPx() { return 16 * this.zoom; }

  // Spiral (x,y) → canvas top-left pixel
  _toCanvas(sx, sy) {
    const { width, height } = this.game.spiral;
    const cp = this._cellPx();
    return {
      cx: this.panX + (sx + Math.floor(width / 2)) * cp,
      cy: this.panY + (Math.floor(height / 2) - sy) * cp,
    };
  }

  // ── Main render dispatch ──────────────────────────────────────────────────

  renderFull() {
    const cp = this._cellPx();
    // Below ~4px/cell borders vanish; pixel-buffer is far cheaper than 1M fillRects
    if (cp < 4) this._renderPixelBuf();
    else         this._renderCells();
  }

  // ── Pixel-buffer renderer (zoomed out) ───────────────────────────────────

  _renderPixelBuf() {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const cp = this._cellPx();
    const { coordFlat, flatW, flatH } = this.game.spiral;

    // Pre-build U32 colour table: index = board state (0=empty, 1=p1, …)
    const colTable = this.playerColors.map(c => hexToU32(c ?? '#505050'));
    const blockedU32 = hexToU32(BLOCKED_COLOR);
    const bgU32 = hexToU32(this.playerColors[0] ?? '#505050');

    const imageData = ctx.createImageData(cw, ch);
    const buf = new Uint32Array(imageData.data.buffer);
    buf.fill(bgU32);

    // Pre-compute which flat-array column each canvas column maps to
    // flatCol = floor((px - panX) / cp)  — same indexing as canvas columns
    const col0 = Math.max(0, Math.floor(-this.panX / cp));
    const col1 = Math.min(flatW - 1, Math.floor((cw - 1 - this.panX) / cp));
    const row0 = Math.max(0, Math.floor(-this.panY / cp));
    const row1 = Math.min(flatH - 1, Math.floor((ch - 1 - this.panY) / cp));
    if (col0 > col1 || row0 > row1) { ctx.putImageData(imageData, 0, 0); return; }

    // For each canvas pixel in the visible grid rect, write colour directly
    // Group by flat-array cell to avoid recomputing colour per pixel
    for (let frow = row0; frow <= row1; frow++) {
      // Canvas y range for this flat row
      const pyStart = Math.max(0, Math.round(this.panY + frow * cp));
      const pyEnd   = Math.min(ch - 1, Math.round(this.panY + (frow + 1) * cp) - 1);
      if (pyStart > pyEnd) continue;

      for (let fcol = col0; fcol <= col1; fcol++) {
        const cellNum = coordFlat[frow * flatW + fcol];
        let u32;
        if (cellNum < 0) {
          u32 = bgU32;
        } else if (this.game.primeMask?.[cellNum] === 1) {
          u32 = blockedU32;
        } else {
          u32 = colTable[this.game.board[cellNum]] ?? bgU32;
        }

        // Canvas x range for this flat column
        const pxStart = Math.max(0, Math.round(this.panX + fcol * cp));
        const pxEnd   = Math.min(cw - 1, Math.round(this.panX + (fcol + 1) * cp) - 1);
        if (pxStart > pxEnd) continue;

        for (let py = pyStart; py <= pyEnd; py++) {
          const base = py * cw;
          for (let px = pxStart; px <= pxEnd; px++) {
            buf[base + px] = u32;
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  // ── Cell renderer (zoomed in, with borders + labels) ─────────────────────

  _renderCells() {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    const cp = this._cellPx();
    const { coordFlat, flatW, flatH } = this.game.spiral;

    // Background
    ctx.fillStyle = this.playerColors[0] ?? '#505050';
    ctx.fillRect(0, 0, cw, ch);

    const showBorder = cp >= 3;
    const showText   = cp >= 20;
    const thinBorder = cp < 8;

    // Visible flat-array range
    const col0 = Math.max(0, Math.floor(-this.panX / cp));
    const col1 = Math.min(flatW - 1, Math.floor((cw - this.panX) / cp));
    const row0 = Math.max(0, Math.floor(-this.panY / cp));
    const row1 = Math.min(flatH - 1, Math.floor((ch - this.panY) / cp));

    for (let frow = row0; frow <= row1; frow++) {
      const cy = this.panY + frow * cp;
      for (let fcol = col0; fcol <= col1; fcol++) {
        const cellNum = coordFlat[frow * flatW + fcol];
        if (cellNum < 0) continue;

        const cx = this.panX + fcol * cp;
        const blocked = this.game.primeMask?.[cellNum] === 1;
        const state   = this.game.board[cellNum];
        const color   = blocked ? BLOCKED_COLOR : (this.playerColors[state] ?? '#555');

        ctx.fillStyle = color;
        ctx.fillRect(cx, cy, cp, cp);

        if (showBorder && !blocked) {
          ctx.strokeStyle = thinBorder ? 'rgba(80,80,80,0.4)' : 'rgba(80,80,80,0.8)';
          ctx.lineWidth = thinBorder ? 0.3 : 0.5;
          ctx.strokeRect(cx + 0.5, cy + 0.5, cp - 1, cp - 1);
        }

        if (showText) {
          if (blocked) {
            const fs = Math.min(cp * 0.3, 10);
            ctx.fillStyle = 'rgba(140,100,160,0.5)';
            ctx.font = `${fs}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cellNum, cx + cp / 2, cy + cp / 2);
          } else if (state === 0) {
            const fs = Math.min(cp * 0.35, 12);
            ctx.fillStyle = 'rgba(200,200,200,0.5)';
            ctx.font = `${fs}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cellNum, cx + cp / 2, cy + cp / 2);
          }
        }
      }
    }
  }

  // ── Incremental single-cell repaint ───────────────────────────────────────

  renderCell(num) {
    const { numToX, numToY } = this.game.spiral;
    const x = numToX[num], y = numToY[num];
    const { cx, cy } = this._toCanvas(x, y);
    const cp = this._cellPx();
    const cw = this.canvas.width, ch = this.canvas.height;
    if (cx + cp < 0 || cy + cp < 0 || cx > cw || cy > ch) return;

    // In pixel-buf territory just do a full redraw — one cell is sub-pixel anyway
    if (cp < 4) { this.renderFull(); return; }

    const ctx = this.ctx;
    const blocked = this.game.primeMask?.[num] === 1;
    const state   = this.game.board[num];
    const color   = blocked ? BLOCKED_COLOR : (this.playerColors[state] ?? '#555');
    const showBorder = cp >= 3;
    const thinBorder = cp < 8;
    const showText   = cp >= 20;

    ctx.fillStyle = color;
    ctx.fillRect(cx, cy, cp, cp);
    if (showBorder && !blocked) {
      ctx.strokeStyle = thinBorder ? 'rgba(80,80,80,0.4)' : 'rgba(80,80,80,0.8)';
      ctx.lineWidth = thinBorder ? 0.3 : 0.5;
      ctx.strokeRect(cx + 0.5, cy + 0.5, cp - 1, cp - 1);
    }
    if (showText && state === 0) {
      const fs = Math.min(cp * 0.35, 12);
      ctx.fillStyle = 'rgba(200,200,200,0.5)';
      ctx.font = `${fs}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(num, cx + cp / 2, cy + cp / 2);
    }
  }

  zoomBy(factor) {
    const cw = this.canvas.width, ch = this.canvas.height;
    this.panX = cw / 2 - (cw / 2 - this.panX) * factor;
    this.panY = ch / 2 - (ch / 2 - this.panY) * factor;
    this.zoom = Math.max(0.05, Math.min(50, this.zoom * factor));
    this.renderFull();
    if (this._onZoomChange) this._onZoomChange(this.zoom);
  }
}
