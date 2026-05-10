export type DifficultyId = "easy" | "normal" | "hard";

export type DifficultyConfig = {
  id: DifficultyId;
  label: string;
  maxHp: number;
  enemyMultiplier: number;
  color: number;
};

export const defaultDifficultyId: DifficultyId = "normal";

export const difficulties: Record<DifficultyId, DifficultyConfig> = {
  easy: {
    id: "easy",
    label: "かんたん",
    maxHp: 8,
    enemyMultiplier: 1,
    color: 0x4fc3ff,
  },
  normal: {
    id: "normal",
    label: "ふつう",
    maxHp: 5,
    enemyMultiplier: 1,
    color: 0xffd84d,
  },
  hard: {
    id: "hard",
    label: "むずかしい",
    maxHp: 3,
    enemyMultiplier: 3,
    color: 0xff5d80,
  },
};

export function resolveDifficulty(id?: string): DifficultyConfig {
  return difficulties[(id as DifficultyId) ?? defaultDifficultyId] ?? difficulties[defaultDifficultyId];
}
