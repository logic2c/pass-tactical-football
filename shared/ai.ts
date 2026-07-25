import type { AiCandidate, AiSelection } from "./types";

export type { AiCandidate, AiSelection };

export function candidateProbabilities<T>(candidates: AiCandidate<T>[], temperature = 2.2) {
  if (candidates.length === 0) return [];
  const safeTemperature = Math.max(0.25, temperature);
  const maxScore = Math.max(...candidates.map((candidate) => candidate.score));
  const weights = candidates.map((candidate) =>
    Math.exp(Math.max(-16, Math.min(16, (candidate.score - maxScore) / safeTemperature))),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

export function weightedAiChoice<T>(
  candidates: AiCandidate<T>[],
  temperature = 2.2,
  random = Math.random,
): AiSelection<T> | undefined {
  if (candidates.length === 0) return undefined;
  const probabilities = candidateProbabilities(candidates, temperature);
  let roll = Math.min(0.999999999, Math.max(0, random()));
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= probabilities[index];
    if (roll <= 0 || index === candidates.length - 1) {
      return { ...candidates[index], probability: probabilities[index] };
    }
  }
  return undefined;
}

export function gridDistance(from: number, to: number) {
  const fromRow = Math.floor(from / 8);
  const fromCol = from % 8;
  const toRow = Math.floor(to / 8);
  const toCol = to % 8;
  return Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
}

export function goalDistance(team: "red" | "blue", position: number) {
  return gridDistance(position, team === "red" ? 4 : 60);
}

export function progressGain(team: "red" | "blue", from: number, to: number) {
  return goalDistance(team, from) - goalDistance(team, to);
}

export function closestDistance(position: number, others: number[]) {
  if (others.length === 0) return 8;
  return Math.min(...others.map((other) => gridDistance(position, other)));
}
