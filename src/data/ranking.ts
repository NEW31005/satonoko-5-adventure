import { DifficultyId } from "./difficulty";

export type RoundRankingEntry = {
  id: string;
  dateKey: string;
  playerName: string;
  round: number;
  difficulty: DifficultyId;
  score: number;
  coins: number;
  timeMs: number;
  points: number;
};

export type SavedRoundRanking = {
  entry: RoundRankingEntry;
  dailyRank: number;
  allTimeRank: number;
  dailyTop: RoundRankingEntry[];
  allTimeTop: RoundRankingEntry[];
};

const playerNameStorageKey = "satonoko.playerName.v1";
const firestoreCollection = "satonokoRoundRankings";

export function getStoredPlayerName(): string {
  try {
    return sanitizePlayerName(window.localStorage.getItem(playerNameStorageKey) ?? "");
  } catch {
    return "ゲスト";
  }
}

export function saveStoredPlayerName(name: string): string {
  const safeName = sanitizePlayerName(name);
  try {
    window.localStorage.setItem(playerNameStorageKey, safeName);
  } catch {
    // Name storage is a local convenience only; world ranking still depends on the remote backend.
  }
  return safeName;
}

export function sanitizePlayerName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return (trimmed || "ゲスト").slice(0, 10);
}

export function calculateRoundPoints(score: number, coins: number, timeMs: number): number {
  const seconds = Math.max(0, Math.ceil(timeMs / 1000));
  const timeBonus = Math.max(0, 1200 - seconds * 12);
  return Math.max(0, score + coins * 10 + timeBonus);
}

export function formatTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(timeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export async function submitWorldRoundRanking(
  entry: Omit<RoundRankingEntry, "id" | "dateKey">,
): Promise<SavedRoundRanking | undefined> {
  const config = getFirebaseConfig();
  if (!config) {
    return undefined;
  }

  const complete: RoundRankingEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    dateKey: getTodayKey(),
  };

  await createFirestoreDocument(config, complete);
  const rankings = await fetchFirestoreRankings(config);
  const allForRound = sortRankings(rankings.filter((item) => item.round === complete.round));
  const dailyForRound = sortRankings(allForRound.filter((item) => item.dateKey === complete.dateKey));

  return {
    entry: complete,
    dailyRank: dailyForRound.findIndex((item) => item.id === complete.id) + 1,
    allTimeRank: allForRound.findIndex((item) => item.id === complete.id) + 1,
    dailyTop: dailyForRound.slice(0, 3),
    allTimeTop: allForRound.slice(0, 3),
  };
}

function getFirebaseConfig(): { projectId: string; apiKey: string } | undefined {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  if (!projectId || !apiKey) {
    return undefined;
  }
  return { projectId, apiKey };
}

async function createFirestoreDocument(
  config: { projectId: string; apiKey: string },
  entry: RoundRankingEntry,
): Promise<void> {
  const response = await fetch(`${firestoreBaseUrl(config)}/${firestoreCollection}?key=${config.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        id: { stringValue: entry.id },
        dateKey: { stringValue: entry.dateKey },
        playerName: { stringValue: entry.playerName },
        difficulty: { stringValue: entry.difficulty },
        round: { integerValue: `${entry.round}` },
        score: { integerValue: `${entry.score}` },
        coins: { integerValue: `${entry.coins}` },
        timeMs: { integerValue: `${entry.timeMs}` },
        points: { integerValue: `${entry.points}` },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to submit world ranking");
  }
}

async function fetchFirestoreRankings(config: { projectId: string; apiKey: string }): Promise<RoundRankingEntry[]> {
  const response = await fetch(`${firestoreBaseUrl(config)}/${firestoreCollection}?pageSize=250&key=${config.apiKey}`);
  if (!response.ok) {
    throw new Error("Failed to fetch world ranking");
  }
  const payload = (await response.json()) as { documents?: FirestoreDocument[] };
  return (payload.documents ?? []).map(parseFirestoreDocument).filter((entry): entry is RoundRankingEntry => Boolean(entry));
}

function firestoreBaseUrl(config: { projectId: string }): string {
  return `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
}

type FirestoreDocument = {
  fields?: Record<
    string,
    {
      stringValue?: string;
      integerValue?: string;
    }
  >;
};

function parseFirestoreDocument(document: FirestoreDocument): RoundRankingEntry | undefined {
  const fields = document.fields;
  if (!fields) {
    return undefined;
  }

  const entry: RoundRankingEntry = {
    id: fields.id?.stringValue ?? "",
    dateKey: fields.dateKey?.stringValue ?? "",
    playerName: fields.playerName?.stringValue ?? "ゲスト",
    difficulty: (fields.difficulty?.stringValue as DifficultyId | undefined) ?? "normal",
    round: Number(fields.round?.integerValue ?? 0),
    score: Number(fields.score?.integerValue ?? 0),
    coins: Number(fields.coins?.integerValue ?? 0),
    timeMs: Number(fields.timeMs?.integerValue ?? 0),
    points: Number(fields.points?.integerValue ?? 0),
  };

  return entry.id && entry.round > 0 ? entry : undefined;
}

function sortRankings(entries: RoundRankingEntry[]): RoundRankingEntry[] {
  return [...entries].sort((a, b) => b.points - a.points || a.timeMs - b.timeMs || b.coins - a.coins);
}

function getTodayKey(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
