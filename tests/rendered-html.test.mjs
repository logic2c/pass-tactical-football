import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { BLUE_GOAL, movementPath, movementTargets, passBlockedByOpponent, passPath } = await import(
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

  assert.match(source, /specialCards: \{ tackle: 6 \}/);
  assert.match(source, /drawInto\(game, player, GAME_BALANCE\.turnDraw\);/);
  assert.match(source, /game\.discardQueue = \[player\.id\];/);
  assert.match(source, /game\.turn\.cardsPlayed !== 0/);
  assert.match(source, /if \(game\.turn\.acquiredBall\) return false;/);
  assert.match(source, /game\.turn\.tackleUsed = true;/);
  assert.match(rules, /const range = player\.team === game\.offense \? 3 : 7;/);
  assert.doesNotMatch(source, /pass-response|runAiResponse|takeInterceptCard|越位/);
});

test("movement ranges and goal access follow the current rules", () => {
  const defender = { team: "red", position: 35, hand: [{ kind: "action" }] };
  const defenseGame = { offense: "blue", players: [defender] };
  const offenseGame = { offense: "red", players: [defender] };

  assert.equal(movementTargets(defenseGame, defender, "rock").has(39), true);
  assert.equal(movementTargets(offenseGame, defender, "rock").has(39), false);
  assert.equal(movementTargets(defenseGame, defender, "bishop").has(7), true);
  assert.equal(movementTargets(offenseGame, defender, "bishop").has(7), false);

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

test("knight routes expose the first square and landing square for loose-ball pickup", () => {
  assert.deepEqual(passPath(35, 52, "knight"), [43]);
  assert.deepEqual(passPath(35, 45, "knight"), [36]);
  assert.deepEqual(movementPath(35, 52, "knight"), [43, 52]);
  assert.equal(passPath(35, 53, "knight"), null);
});

test("opponents block pass targets before the pass, while teammates do not", () => {
  assert.equal(
    passBlockedByOpponent(56, 0, "rock", "red", [
      { position: 48, team: "red" },
      { position: 40, team: "blue" },
    ]),
    true,
  );
  assert.equal(
    passBlockedByOpponent(56, 0, "rock", "red", [{ position: 48, team: "red" }]),
    false,
  );
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

  assert.match(source, /if \(game\.phase === "turn"\) runAiTurn\(game\)/);
  assert.match(source, /else if \(game\.phase === "discard"\) runAiDiscard\(game\)/);
  assert.match(source, /kind: "skip-draw"/);
  assert.match(source, /kind: "tackle"/);
  assert.match(source, /kind: "pass"/);
  assert.doesNotMatch(source, /pass-response|pass-target|intercept/);

  const response = await render();
  const html = await response.text();
  assert.match(html, /1 HUMAN · 5 AI/);
  assert.match(html, /选择本局由你控制的球员/);
});
