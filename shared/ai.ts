import type { AiCandidate, AiSelection } from "./types";
import { BLUE_GOALS, RED_GOALS, positionCoordinate } from "./game-rules";

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

export function topBandCandidates<T>(candidates: AiCandidate<T>[], maxGap = 3, maxCount = 4) {
  if (candidates.length === 0) return [];
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const bestScore = sorted[0].score;
  return sorted.filter((candidate) => candidate.score >= bestScore - maxGap).slice(0, maxCount);
}

export function weightedTopBandAiChoice<T>(
  candidates: AiCandidate<T>[],
  temperature = 1.2,
  random = Math.random,
  maxGap = 3,
  maxCount = 4,
) {
  return weightedAiChoice(topBandCandidates(candidates, maxGap, maxCount), temperature, random);
}

export function gridDistance(from: number, to: number) {
  const fromCoordinate = positionCoordinate(from);
  const toCoordinate = positionCoordinate(to);
  if (!fromCoordinate || !toCoordinate) return Number.POSITIVE_INFINITY;
  const { row: fromRow, col: fromCol } = fromCoordinate;
  const { row: toRow, col: toCol } = toCoordinate;
  return Math.abs(fromRow - toRow) + Math.abs(fromCol - toCol);
}

export function goalDistance(team: "red" | "blue", position: number) {
  const goals = team === "red" ? BLUE_GOALS : RED_GOALS;
  return Math.min(...goals.map((goal) => gridDistance(position, goal)));
}

export function progressGain(team: "red" | "blue", from: number, to: number) {
  return goalDistance(team, from) - goalDistance(team, to);
}

export function closestDistance(position: number, others: number[]) {
  if (others.length === 0) return 8;
  return Math.min(...others.map((other) => gridDistance(position, other)));
}
