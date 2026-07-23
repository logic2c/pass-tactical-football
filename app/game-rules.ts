export type RuleTeam = "red" | "blue";
export type RuleSuit = "rock" | "bishop" | "knight";

type RuleCard = { kind: string };
type RulePlayer = {
  team: RuleTeam;
  position: number;
  hand: RuleCard[];
};
type RuleGame = {
  offense: RuleTeam;
  players: Array<{ position: number }>;
  looseBall?: number;
};

export const RED_GOAL = 60;
export const BLUE_GOAL = 4;

export function isGoal(position: number) {
  return position === RED_GOAL || position === BLUE_GOAL;
}

export function enemyGoal(team: RuleTeam) {
  return team === "red" ? BLUE_GOAL : RED_GOAL;
}

function playerHasBall(player: RulePlayer) {
  return player.hand.some((card) => card.kind === "ball");
}

export function movementTargets(game: RuleGame, player: RulePlayer, suit: RuleSuit) {
  const targets = new Set<number>();
  const row = Math.floor(player.position / 8);
  const col = player.position % 8;
  const occupied = new Set(game.players.map((item) => item.position));
  const add = (nextRow: number, nextCol: number) => {
    if (nextRow < 0 || nextRow > 7 || nextCol < 0 || nextCol > 7) return;
    const position = nextRow * 8 + nextCol;
    if (occupied.has(position)) return;
    const route = movementPath(player.position, position, suit);
    if (!route || route.slice(0, -1).some((cell) => occupied.has(cell))) return;
    if (isGoal(position)) {
      const collectsLooseBall =
        game.looseBall !== undefined && movementPath(player.position, position, suit)?.includes(game.looseBall);
      if (position === enemyGoal(player.team) && (playerHasBall(player) || collectsLooseBall)) targets.add(position);
      return;
    }
    targets.add(position);
  };

  if (suit === "knight") {
    [
      [-2, -1],
      [-2, 1],
      [-1, -2],
      [-1, 2],
      [1, -2],
      [1, 2],
      [2, -1],
      [2, 1],
    ].forEach(([rowDelta, colDelta]) => add(row + rowDelta, col + colDelta));
  } else {
    const directions =
      suit === "rock"
        ? [
            [-1, 0],
            [1, 0],
            [0, -1],
            [0, 1],
          ]
        : [
            [-1, -1],
            [-1, 1],
            [1, -1],
            [1, 1],
          ];
    const range = 3;
    directions.forEach(([rowDelta, colDelta]) => {
      for (let distance = 1; distance <= range; distance += 1) {
        add(row + rowDelta * distance, col + colDelta * distance);
      }
    });
  }

  return targets;
}

export function sprintTargets(game: RuleGame, player: RulePlayer, distance: number) {
  const targets = new Set<number>();
  const row = Math.floor(player.position / 8);
  const col = player.position % 8;
  const occupied = new Set(game.players.map((item) => item.position));
  for (let nextRow = 0; nextRow < 8; nextRow += 1) {
    for (let nextCol = 0; nextCol < 8; nextCol += 1) {
      const position = nextRow * 8 + nextCol;
      if (
        Math.abs(nextRow - row) + Math.abs(nextCol - col) === distance &&
        !occupied.has(position) &&
        (!isGoal(position) || (position === enemyGoal(player.team) && playerHasBall(player)))
      ) {
        targets.add(position);
      }
    }
  }
  return targets;
}

export function passPath(from: number, to: number, suit: RuleSuit): number[] | null {
  const fromRow = Math.floor(from / 8);
  const fromCol = from % 8;
  const toRow = Math.floor(to / 8);
  const toCol = to % 8;
  const rowDelta = toRow - fromRow;
  const colDelta = toCol - fromCol;

  if (suit === "knight") {
    const rowDistance = Math.abs(rowDelta);
    const colDistance = Math.abs(colDelta);
    if (!((rowDistance === 2 && colDistance === 1) || (rowDistance === 1 && colDistance === 2))) {
      return null;
    }
    const middleRow = fromRow + Math.sign(rowDelta) * (rowDistance === 2 ? 1 : 0);
    const middleCol = fromCol + Math.sign(colDelta) * (colDistance === 2 ? 1 : 0);
    return [middleRow * 8 + middleCol];
  }

  const isRock = suit === "rock" && (rowDelta === 0 || colDelta === 0);
  const isBishop = suit === "bishop" && Math.abs(rowDelta) === Math.abs(colDelta);
  if (!isRock && !isBishop) return null;

  const rowStep = Math.sign(rowDelta);
  const colStep = Math.sign(colDelta);
  const distance = Math.max(Math.abs(rowDelta), Math.abs(colDelta));
  const path: number[] = [];
  for (let step = 1; step < distance; step += 1) {
    path.push((fromRow + rowStep * step) * 8 + fromCol + colStep * step);
  }
  return path;
}

/** All squares crossed by a move, including its destination. */
export function movementPath(from: number, to: number, suit: RuleSuit): number[] | null {
  const path = passPath(from, to, suit);
  return path ? [...path, to] : null;
}

export function passBlockedByPlayer(
  from: number,
  to: number,
  suit: RuleSuit,
  players: Array<{ position: number }>,
) {
  const path = passPath(from, to, suit);
  return path ? path.some((cell) => players.some((player) => player.position === cell)) : true;
}

export function passBlockerCount(
  from: number,
  to: number,
  suit: RuleSuit,
  players: Array<{ position: number }>,
) {
  const path = passPath(from, to, suit);
  if (!path) return Number.POSITIVE_INFINITY;
  return path.filter((cell) => players.some((player) => player.position === cell)).length;
}
