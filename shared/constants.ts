import type { Suit, SpecialKind, Team } from "./types";

export const TURN_ORDER = ["r1", "b1", "r2", "b2", "r3", "b3"];
export const TURN_ORDER_4V4 = ["r1", "b1", "r2", "b2", "r3", "b3", "r4", "b4"];

export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function getTurnOrder(mode: "3v3" | "4v4") {
  return mode === "4v4" ? TURN_ORDER_4V4 : TURN_ORDER;
}

export const SUIT_INFO: Record<Suit, { name: string; icon: string; caption: string }> = {
  rock: { name: "ROCK", icon: "+", caption: "横纵" },
  bishop: { name: "BISHOP", icon: "×", caption: "斜线" },
  knight: { name: "KNIGHT", icon: "L", caption: "走日" },
};

export const SPECIAL_INFO: Record<SpecialKind, { name: string; icon: string; caption: string; description: string }> = {
  tackle: { name: "TACKLE", icon: "!", caption: "随机抢断", description: "一格内随机抢走1张牌" },
  sprint: { name: "SPRINT", icon: "+1", caption: "冲刺", description: "本回合获得1点行动力" },
  supply: { name: "SUPPLY", icon: "2", caption: "补给", description: "抽取2张牌" },
  "long-pass": { name: "LONG PASS", icon: "↗", caption: "长传", description: "下一次Pass可越过1人" },
  save: { name: "SAVE", icon: "◆", caption: "扑救", description: "响应Pass并弃牌移动" },
  "flying-kick": { name: "FLYING KICK", icon: "−1", caption: "飞踢", description: "一步内压制并夺球" },
};

export const FORMATION_3V3: Record<string, number> = {
  r1: 51,
  r2: 53,
  r3: 44,
  b1: 11,
  b2: 13,
  b3: 20,
};

export const FORMATION_4V4: Record<string, number> = {
  r1: 51,
  r2: 58,
  r3: 53,
  r4: 43,
  b1: 11,
  b2: 2,
  b3: 13,
  b4: 19,
};

export function getFormation(mode: "3v3" | "4v4") {
  return mode === "4v4" ? FORMATION_4V4 : FORMATION_3V3;
}

export const FORMATION = FORMATION_3V3;

export const GAME_BALANCE = {
  actionCardsPerSuit: 13,
  specialCards: { tackle: 2, sprint: 2, supply: 2, "long-pass": 4, save: 1, "flying-kick": 2 },
  startingHand: 3,
  turnDraw: 1,
  skipPlayDraw: 2,
  handLimit: { offense: 5, defense: 6 },
  winningScore: 3,
  maxTacklesPerTurn: 1,
  maxPressesPerTurn: 1,
  actionPoints: { holder: 1, other: 2 },
} as const;

export const AI_TUNING = {
  turnTemperature: 2.05,
  detailTemperature: 1.55,
  discardTemperature: 1.4,
  thinkDelay: { turn: 980, phase: 480 },
} as const;

export function describeTeam(team: Team) {
  return team === "red" ? "红队" : "蓝队";
}
