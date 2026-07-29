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
  players: Array<{ position: number; team?: RuleTeam }>;
  looseBall?: number;
};

export const BOARD_WIDTH = 8;
export const BOARD_HEIGHT = 10;
export const BOARD_SIZE = BOARD_WIDTH * BOARD_HEIGHT;

// Goal squares live outside the 8x10 pitch. Player positions always remain 0...(BOARD_SIZE - 1).
export const BLUE_GOALS = [80, 81] as const;
export const RED_GOALS = [82, 83] as const;
// Singular aliases remain for older consumers that only need a representative goal.
export const BLUE_GOAL = BLUE_GOALS[0];
export const RED_GOAL = RED_GOALS[0];
export const ALL_GOALS = [...BLUE_GOALS, ...RED_GOALS] as const;

export const BLUE_PENALTY_AREA = [2, 3, 4, 5] as const;
export const RED_PENALTY_AREA = [74, 75, 76, 77] as const;

export function positionCoordinate(position: number): { row: number; col: number } | undefined {
  if (position >= 0 && position < BOARD_SIZE) return { row: Math.floor(position / BOARD_WIDTH), col: position % BOARD_WIDTH };
  if (position === BLUE_GOALS[0]) return { row: -1, col: 3 };
  if (position === BLUE_GOALS[1]) return { row: -1, col: 4 };
  if (position === RED_GOALS[0]) return { row: BOARD_HEIGHT, col: 3 };
  if (position === RED_GOALS[1]) return { row: BOARD_HEIGHT, col: 4 };
  return undefined;
}

export function isGoal(position: number) {
  return ALL_GOALS.includes(position as (typeof ALL_GOALS)[number]);
}

export function enemyGoal(team: RuleTeam) {
  return team === "red" ? BLUE_GOAL : RED_GOAL;
}

export function enemyGoals(team: RuleTeam): readonly number[] {
  return team === "red" ? BLUE_GOALS : RED_GOALS;
}

export function ownGoals(team: RuleTeam): readonly number[] {
  return team === "red" ? RED_GOALS : BLUE_GOALS;
}

export function ownPenaltyArea(team: RuleTeam): readonly number[] {
  return team === "red" ? RED_PENALTY_AREA : BLUE_PENALTY_AREA;
}

export function enemyPenaltyArea(team: RuleTeam): readonly number[] {
  return team === "red" ? BLUE_PENALTY_AREA : RED_PENALTY_AREA;
}

export function isInOwnPenaltyArea(team: RuleTeam, position: number) {
  return ownPenaltyArea(team).includes(position);
}

export function isInEnemyPenaltyArea(team: RuleTeam, position: number) {
  return enemyPenaltyArea(team).includes(position);
}

export function wouldExceedDefenderPenaltyLimit(game: RuleGame, player: RulePlayer, position: number) {
  if (player.team === game.offense || !isInOwnPenaltyArea(player.team, position)) return false;
  return game.players.some((candidate) =>
    candidate.position !== player.position && candidate.team === player.team && isInOwnPenaltyArea(player.team, candidate.position),
  );
}

function playerHasBall(player: RulePlayer) {
  return player.hand.some((card) => card.kind === "ball");
}

export function movementTargets(game: RuleGame, player: RulePlayer, suit: RuleSuit) {
  const targets = new Set<number>();
  const row = Math.floor(player.position / BOARD_WIDTH);
  const col = player.position % BOARD_WIDTH;
  const occupied = new Set(game.players.map((item) => item.position));
  const add = (nextRow: number, nextCol: number) => {
    if (nextRow < 0 || nextRow >= BOARD_HEIGHT || nextCol < 0 || nextCol >= BOARD_WIDTH) return;
    const position = nextRow * BOARD_WIDTH + nextCol;
    if (occupied.has(position)) return;
    if (wouldExceedDefenderPenaltyLimit(game, player, position)) return;
    const route = movementPath(player.position, position, suit);
    if (!route || route.slice(0, -1).some((cell) => occupied.has(cell))) return;
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
    const range = suit === "bishop" ? 2 : 3;
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
  const row = Math.floor(player.position / BOARD_WIDTH);
  const col = player.position % BOARD_WIDTH;
  const occupied = new Set(game.players.map((item) => item.position));
  for (let nextRow = 0; nextRow < BOARD_HEIGHT; nextRow += 1) {
    for (let nextCol = 0; nextCol < BOARD_WIDTH; nextCol += 1) {
      const position = nextRow * BOARD_WIDTH + nextCol;
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
  const fromCoordinate = positionCoordinate(from);
  const toCoordinate = positionCoordinate(to);
  if (!fromCoordinate || !toCoordinate) return null;
  const { row: fromRow, col: fromCol } = fromCoordinate;
  const { row: toRow, col: toCol } = toCoordinate;
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
    return [middleRow * BOARD_WIDTH + middleCol];
  }

  const isRock = suit === "rock" && (rowDelta === 0 || colDelta === 0);
  const isBishop = suit === "bishop" && Math.abs(rowDelta) === Math.abs(colDelta);
  if (!isRock && !isBishop) return null;

  const rowStep = Math.sign(rowDelta);
  const colStep = Math.sign(colDelta);
  const distance = Math.max(Math.abs(rowDelta), Math.abs(colDelta));
  const maxDistance = suit === "rock" ? 6 : 4;
  if (distance > maxDistance) return null;
  const path: number[] = [];
  for (let step = 1; step < distance; step += 1) {
    const row = fromRow + rowStep * step;
    const col = fromCol + colStep * step;
    if (row < 0 || row >= BOARD_HEIGHT || col < 0 || col >= BOARD_WIDTH) return null;
    path.push(row * BOARD_WIDTH + col);
  }
  return path;
}

/** All squares crossed by a move, including its destination. */
export function movementPath(from: number, to: number, suit: RuleSuit): number[] | null {
  const path = passPath(from, to, suit);
  if (!path) return null;
  const fromCoordinate = positionCoordinate(from);
  const toCoordinate = positionCoordinate(to);
  if (!fromCoordinate || !toCoordinate || isGoal(to)) return null;
  const distance = Math.max(
    Math.abs(toCoordinate.row - fromCoordinate.row),
    Math.abs(toCoordinate.col - fromCoordinate.col),
  );
  if ((suit === "rock" && distance > 3) || (suit === "bishop" && distance > 2)) return null;
  return [...path, to];
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
