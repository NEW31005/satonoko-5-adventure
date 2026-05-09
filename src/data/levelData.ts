export type RectSpec = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PointSpec = {
  x: number;
  y: number;
};

export type EnemySpec = PointSpec & {
  minX: number;
  maxX: number;
};

export const levelData = {
  worldWidth: 4300,
  worldHeight: 700,
  start: { x: 140, y: 420 },
  checkpoint: { x: 140, y: 420 },
  platforms: [
    { x: 0, y: 500, width: 760, height: 60 },
    { x: 870, y: 500, width: 440, height: 60 },
    { x: 1410, y: 500, width: 450, height: 60 },
    { x: 2160, y: 500, width: 760, height: 60 },
    { x: 3030, y: 500, width: 1040, height: 60 },
    { x: 4100, y: 500, width: 250, height: 60 },
    { x: 520, y: 378, width: 150, height: 24 },
    { x: 700, y: 300, width: 150, height: 24 },
    { x: 925, y: 380, width: 145, height: 24 },
    { x: 1540, y: 410, width: 150, height: 22 },
    { x: 1715, y: 360, width: 150, height: 22 },
    { x: 2250, y: 380, width: 145, height: 22 },
    { x: 2380, y: 320, width: 145, height: 22 },
  ] as RectSpec[],
  dashWalls: [{ x: 1265, y: 404, width: 34, height: 96 }] as RectSpec[],
  rocks: [{ x: 2760, y: 424, width: 92, height: 76 }] as RectSpec[],
  spikes: [
    { x: 3190, y: 480, width: 170, height: 28 },
    { x: 3420, y: 480, width: 170, height: 28 },
  ] as RectSpec[],
  stars: [
    { x: 245, y: 420 },
    { x: 460, y: 420 },
    { x: 585, y: 335 },
    { x: 758, y: 255 },
    { x: 1000, y: 335 },
    { x: 1515, y: 445 },
    { x: 1745, y: 315 },
    { x: 2265, y: 335 },
    { x: 2460, y: 275 },
    { x: 3010, y: 430 },
    { x: 3320, y: 430 },
    { x: 3600, y: 420 },
    { x: 3890, y: 385 },
  ] as PointSpec[],
  hearts: [{ x: 2060, y: 350 }] as PointSpec[],
  enemies: [
    { x: 1030, y: 460, minX: 925, maxX: 1220 },
    { x: 3650, y: 460, minX: 3520, maxX: 3830 },
  ] as EnemySpec[],
  goal: { x: 4065, y: 410, width: 54, height: 160 },
};
