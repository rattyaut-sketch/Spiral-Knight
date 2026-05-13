// Game state and logic

const DEFAULT_ATTACK_OFFSETS = [
  {dx:1,dy:2},{dx:-1,dy:2},{dx:1,dy:-2},{dx:-1,dy:-2},
  {dx:2,dy:1},{dx:-2,dy:1},{dx:2,dy:-1},{dx:-2,dy:-1}
];

// Returns a Uint8Array mask: mask[n]=1 if cell n is a prime ≥ 5
function buildPrimeMask(total) {
  const composite = new Uint8Array(total);
  composite[0] = composite[1] = 1;
  for (let i = 2; i * i < total; i++)
    if (!composite[i]) for (let j = i * i; j < total; j += i) composite[j] = 1;
  const mask = new Uint8Array(total);
  for (let n = 5; n < total; n++) if (!composite[n]) mask[n] = 1;
  return mask;
}

class Game {
  constructor(spiralData, attackOffsets = DEFAULT_ATTACK_OFFSETS, numPlayers = 2) {
    this.spiral = spiralData;
    this.attackOffsets = attackOffsets;
    this.numPlayers = numPlayers;
    this.primeMask = null;
    this.init();
  }

  init() {
    const total = this.spiral.totalCells;
    this.board      = new Uint8Array(total);
    this.attackTable = this._buildAttackTable();
    this.attackedBy = [];
    for (let p = 0; p < this.numPlayers; p++)
      this.attackedBy.push(new Uint32Array(total));
    this.moveCount     = 0;
    this.currentPlayer = 0;
    this.gameOver      = false;
    this.lastPlaced    = -1;
    this.nextCandidate = new Int32Array(this.numPlayers);
    this._place(0, 0);
    this.currentPlayer = 1;
  }

  _isBlocked(n) { return this.primeMask !== null && this.primeMask[n] === 1; }

  _buildAttackTable() {
    // Store all targets in two flat typed arrays to avoid 1M small Int32Array allocations.
    // atkOff[n]..atkOff[n+1] is the slice of atkFlat that holds cell n's attack targets.
    const { numToX, numToY, coordFlat, flatW, flatH, halfW, halfH, totalCells } = this.spiral;
    const offsets = this.attackOffsets;
    const nOff = offsets.length;
    const dxArr = new Int8Array(nOff), dyArr = new Int8Array(nOff);
    for (let i = 0; i < nOff; i++) { dxArr[i] = offsets[i].dx; dyArr[i] = offsets[i].dy; }

    const atkOff  = new Int32Array(totalCells + 1);
    // Worst case: every cell has nOff targets
    const atkFlat = new Int32Array(totalCells * nOff);
    let pos = 0;

    for (let n = 0; n < totalCells; n++) {
      atkOff[n] = pos;
      const x = numToX[n], y = numToY[n];
      for (let i = 0; i < nOff; i++) {
        const nx = x + dxArr[i], ny = y + dyArr[i];
        if (nx < -halfW || nx > halfW || ny < -halfH || ny > halfH) continue;
        const t = coordFlat[(halfH - ny) * flatW + (nx + halfW)];
        if (t >= 0 && !this._isBlocked(t)) atkFlat[pos++] = t;
      }
    }
    atkOff[totalCells] = pos;
    return { atkFlat, atkOff };
  }

  _place(cellNum, playerIdx) {
    this.board[cellNum] = playerIdx + 1;
    const { atkFlat, atkOff } = this.attackTable;
    const ab = this.attackedBy[playerIdx];
    for (let i = atkOff[cellNum], end = atkOff[cellNum + 1]; i < end; i++) ab[atkFlat[i]]++;
    this.lastPlaced = cellNum;
    this.moveCount++;
  }

  step() {
    if (this.gameOver) return -1;
    const p = this.currentPlayer;
    const total = this.spiral.totalCells;
    let placed = -1;
    for (let n = this.nextCandidate[p]; n < total; n++) {
      if (this.board[n] !== 0 || this._isBlocked(n)) continue;
      let blocked = false;
      for (let opp = 0; opp < this.numPlayers; opp++) {
        if (opp !== p && this.attackedBy[opp][n] > 0) { blocked = true; break; }
      }
      if (!blocked) {
        this._place(n, p);
        this.nextCandidate[p] = n + 1;
        placed = n;
        break;
      }
    }
    if (placed === -1) { this.gameOver = true; return -1; }
    this.currentPlayer = (this.currentPlayer + 1) % this.numPlayers;
    return placed;
  }

  computeAll() {
    // Reuse the already-built attackTable — avoids a second O(N*offsets) build pass
    const total = this.spiral.totalCells;
    const board      = new Uint8Array(total);
    const attackedBy = Array.from({ length: this.numPlayers }, () => new Uint32Array(total));
    const nextCand   = new Int32Array(this.numPlayers);
    const { atkFlat, atkOff } = this.attackTable;
    board[0] = 1;
    for (let i = atkOff[0], end = atkOff[1]; i < end; i++) attackedBy[0][atkFlat[i]]++;
    nextCand[0] = 1;

    const moves = [0];
    const np = this.numPlayers;
    let cur = 1;
    outer: while (true) {
      const p = cur;
      const oppAtk = np === 2 ? attackedBy[1 - p] : null; // fast path for 2 players
      for (let n = nextCand[p]; n < total; n++) {
        if (board[n] !== 0 || this._isBlocked(n)) continue;
        if (oppAtk !== null) {
          if (oppAtk[n] > 0) continue;
        } else {
          let blocked = false;
          for (let opp = 0; opp < np; opp++) {
            if (opp !== p && attackedBy[opp][n] > 0) { blocked = true; break; }
          }
          if (blocked) continue;
        }
        board[n] = p + 1;
        const ab = attackedBy[p];
        for (let i = atkOff[n], end2 = atkOff[n + 1]; i < end2; i++) ab[atkFlat[i]]++;
        nextCand[p] = n + 1;
        moves.push(n);
        cur = (cur + 1) % np;
        continue outer;
      }
      break;
    }
    return new Int32Array(moves);
  }

  rebuild(newOffsets) { this.attackOffsets = newOffsets; this.init(); }
  setNumPlayers(n)    { this.numPlayers = Math.max(2, n); this.init(); }
}
