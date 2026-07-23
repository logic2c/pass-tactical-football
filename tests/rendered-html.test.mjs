import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { BLUE_GOAL, movementPath, movementTargets, passBlockerCount, passBlockedByPlayer, passPath } = await import(
  new URL("../app/game-rules.ts", import.meta.url)
);
const { candidateProbabilities, weightedAiChoice } = await import(
  new URL("../app/ai.ts", import.meta.url)
);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the PASS game shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PASS — 足球卡牌人机对战<\/title>/i);
  assert.match(html, /TACTICAL FOOTBALL CARD GAME/);
  assert.match(html, /FIRST TO (?:<!-- -->)?3/);
  assert.match(html, /8乘8足球棋盘/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("source implements staged turns, special cards, and end-of-turn discarding", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const rules = await readFile(new URL("../app/game-rules.ts", import.meta.url), "utf8");

  assert.match(source, /actionCardsPerSuit: 13/);
  assert.match(source, /specialCards: \{ tackle: 2, sprint: 2, supply: 2, "long-pass": 4, save: 1, "flying-kick": 2 \}/);
  assert.match(source, /turnDraw: 1/);
  assert.match(source, /actionPoints: \{ holder: 1, other: 2 \}/);
  assert.match(source, /drawInto\(game, player, GAME_BALANCE\.turnDraw\);/);
  assert.match(source, /game\.discardQueue = \[player\.id\];/);
  assert.match(source, /game\.turn\.cardsPlayed !== 0/);
  assert.match(source, /function markBallAcquired\(game: GameState\)/);
  assert.doesNotMatch(source, /game\.turn\.actionsRemaining = 1;/);
  assert.match(source, /game\.turn\.tackleUsed = true;/);
  assert.match(source, /game\.turn\.pressUsed = true;/);
  assert.match(source, /function countedHandSize\(player: Player\)/);
  assert.match(rules, /const range = 3;/);
  assert.match(source, /type Phase = "setup" \| "turn" \| "save-response"/);
  assert.match(source, /hasOffsidePlayer/);
});

test("movement ranges and goal access follow the current rules", () => {
  const defender = { team: "red", position: 35, hand: [{ kind: "action" }] };
  const defenseGame = { offense: "blue", players: [defender] };
  const offenseGame = { offense: "red", players: [defender] };

  assert.equal(movementTargets(defenseGame, defender, "rock").has(38), true);
  assert.equal(movementTargets(offenseGame, defender, "rock").has(38), true);
  assert.equal(movementTargets(defenseGame, defender, "rock").has(39), false);
  assert.equal(movementTargets(defenseGame, defender, "bishop").has(14), true);
  assert.equal(movementTargets(offenseGame, defender, "bishop").has(14), true);
  assert.equal(movementTargets(defenseGame, defender, "bishop").has(7), false);

  const farBallCarrier = { team: "red", position: 56, hand: [{ kind: "ball" }] };
  const farGame = { offense: "red", players: [farBallCarrier] };
  assert.equal(movementTargets(farGame, farBallCarrier, "bishop").has(BLUE_GOAL), false);

  const alignedBallCarrier = { team: "red", position: 25, hand: [{ kind: "ball" }] };
  const alignedGame = { offense: "red", players: [alignedBallCarrier] };
  assert.equal(movementTargets(alignedGame, alignedBallCarrier, "bishop").has(BLUE_GOAL), true);

  const alignedWithoutBall = { team: "red", position: 25, hand: [{ kind: "action" }] };
  const noBallGame = { offense: "red", players: [alignedWithoutBall] };
  assert.equal(movementTargets(noBallGame, alignedWithoutBall, "bishop").has(BLUE_GOAL), false);

  const looseBallGame = { offense: "red", looseBall: 18, players: [alignedWithoutBall] };
  assert.equal(movementTargets(looseBallGame, alignedWithoutBall, "bishop").has(BLUE_GOAL), true);
});

test("teammates and opponents both block movement routes", () => {
  const mover = { team: "red", position: 56, hand: [{ kind: "action" }] };
  const teammateBlock = { team: "red", position: 48, hand: [] };
  const opponentBlock = { team: "blue", position: 48, hand: [] };
  assert.equal(movementTargets({ offense: "red", players: [mover, teammateBlock] }, mover, "rock").has(32), false);
  assert.equal(movementTargets({ offense: "red", players: [mover, opponentBlock] }, mover, "rock").has(32), false);

  const knight = { team: "red", position: 35, hand: [{ kind: "action" }] };
  const knightBlock = { team: "blue", position: 43, hand: [] };
  assert.equal(movementTargets({ offense: "red", players: [knight, knightBlock] }, knight, "knight").has(52), false);
});

test("knight routes expose the first square and landing square for loose-ball pickup", () => {
  assert.deepEqual(passPath(35, 52, "knight"), [43]);
  assert.deepEqual(passPath(35, 45, "knight"), [36]);
  assert.deepEqual(movementPath(35, 52, "knight"), [43, 52]);
  assert.equal(passPath(35, 53, "knight"), null);
});

test("teammates and opponents both block pass routes", () => {
  assert.equal(
    passBlockedByPlayer(56, 0, "rock", [
      { position: 48, team: "red" },
      { position: 40, team: "blue" },
    ]),
    true,
  );
  assert.equal(
    passBlockedByPlayer(56, 0, "rock", [{ position: 48, team: "red" }]),
    true,
  );
  assert.equal(passBlockedByPlayer(56, 48, "rock", [{ position: 48, team: "red" }]), false);
  assert.equal(passBlockedByPlayer(35, 52, "knight", [{ position: 43, team: "red" }]), true);
});

test("long passes may cross one player but never a second", () => {
  assert.equal(passBlockerCount(56, 0, "rock", [{ position: 48 }]), 1);
  assert.equal(passBlockerCount(56, 0, "rock", [{ position: 48 }, { position: 40 }]), 2);
  assert.equal(passBlockerCount(35, 52, "knight", [{ position: 43 }]), 1);
});

test("AI choices remain random while favoring higher board value", () => {
  const candidates = [
    { value: "poor", score: -2, reason: "low value" },
    { value: "safe", score: 2, reason: "medium value" },
    { value: "strong", score: 7, reason: "high value" },
  ];
  const probabilities = candidateProbabilities(candidates, 2.2);

  assert.equal(probabilities.length, 3);
  assert.ok(probabilities[2] > probabilities[1]);
  assert.ok(probabilities[1] > probabilities[0]);
  assert.ok(Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-10);
  assert.equal(weightedAiChoice(candidates, 2.2, () => 0)?.value, "poor");
  assert.equal(weightedAiChoice(candidates, 2.2, () => 0.999999)?.value, "strong");
});

test("AI automation covers multi-card turns and discarding without legacy pass phases", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(game\.phase === "turn"\) runAiTurn\(game, humanPlayerId\)/);
  assert.match(source, /else if \(game\.phase === "save-response"\) runAiSaveResponse\(game\)/);
  assert.match(source, /else if \(game\.phase === "discard"\) runAiDiscard\(game\)/);
  assert.match(source, /kind: "skip-draw"/);
  assert.match(source, /kind: "tackle"/);
  assert.match(source, /kind: "press"/);
  assert.match(source, /kind: "pass"/);
  assert.match(source, /kind: "sprint"/);
  assert.match(source, /kind: "supply"/);
  assert.match(source, /kind: "long-pass"/);
  assert.match(source, /kind: "flying-kick"/);
  assert.match(source, /resolveSaveResponse/);
  assert.match(source, /recipient\.hand\.push\(ball\)/);
  assert.match(source, /firstPlayer\?\.team === passer\.team/);
  assert.match(source, /className=\{`action-banner/);
  assert.match(source, /aria-live=\{visibleEvent\?\.kind === "goal" \? "assertive" : "polite"\}/);
  assert.match(source, /key=\{position\}/);
  assert.doesNotMatch(source, /key=\{`\$\{position\}-\$\{visibleEvent/);
  assert.match(source, /scoreGoal\(game, player, "移动", from, path\)/);
  assert.match(source, /className="card-cost"/);
  assert.match(source, /className=\{`trace-line/);

  const response = await render();
  const html = await response.text();
  assert.match(html, /1 HUMAN · 5 AI/);
  assert.match(html, /选择本局由你控制的球员/);
  assert.match(html, /等待第一步行动/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
});

test("reduced-motion users retain static event highlights", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pitch-cell\.event-route/);
  assert.match(css, /\.pitch-cell\.event-to \{ outline:/);
  assert.match(css, /\.player-token\.event-actor \{ box-shadow:/);
});
