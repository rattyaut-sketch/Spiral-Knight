// CCW spiral: center=0, right=1, up=2, left=3,4, down=5,6, right=7,8,9 ...
// Direction pattern: R1,U1,L2,D2,R3,U3,L4,D4,...
function generateSpiral(width, height) {
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const flatW = 2 * halfW + 1;
  const flatH = 2 * halfH + 1;
  const maxCells = width * height;

  // Typed arrays: no object/string allocation → fast even at 1M+ cells
  const numToX    = new Int32Array(maxCells);
  const numToY    = new Int32Array(maxCells);
  // coordFlat: row-major, row 0 = highest spiral-y (canvas top)
  // index = (halfH - spiralY) * flatW + (spiralX + halfW)
  const coordFlat = new Int32Array(flatW * flatH).fill(-1);

  const DIRS = [[1,0],[0,1],[-1,0],[0,-1]]; // R, U, L, D
  let x = 0, y = 0, num = 0;
  let dir = 0, stepsInLeg = 1, stepsTaken = 0, legsCompleted = 0;
  const maxSteps = (Math.max(width, height) + 2) ** 2 * 2;

  for (let step = 0; step < maxSteps && num < maxCells; step++) {
    if (Math.abs(x) <= halfW && Math.abs(y) <= halfH) {
      numToX[num] = x;
      numToY[num] = y;
      coordFlat[(halfH - y) * flatW + (x + halfW)] = num;
      num++;
    }

    const [dx, dy] = DIRS[dir];
    x += dx; y += dy; stepsTaken++;
    if (stepsTaken === stepsInLeg) {
      stepsTaken = 0;
      dir = (dir + 1) % 4;
      legsCompleted++;
      if (legsCompleted % 2 === 0) stepsInLeg++;
    }
  }

  const totalCells = num;
  return { numToX, numToY, coordFlat, flatW, flatH, halfW, halfH, width, height, totalCells };
}
