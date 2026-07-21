import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { BLUE_GOAL, movementTargets, passPath } = await import(
  new URL("../app/game-rules.ts", import.meta.url)
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
  assert.match(html, /<title>PASS — 足球卡牌策略原型<\/title>/i);
  assert.match(html, /TACTICAL FOOTBALL CARD GAME/);
  assert.match(html, /FIRST TO 3/);
  assert.match(html, /8乘8足球棋盘/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("source keeps the reported rule regressions fixed", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const rules = await readFile(new URL("../app/game-rules.ts", import.meta.url), "utf8");

  assert.match(source, /const endingPlayer = activePlayer\(game\);/);
  assert.match(source, /game\.discardQueue = \[endingPlayer\.id\];/);
  assert.match(rules, /const range = player\.team === game\.offense \? 3 : 7;/);
  assert.match(source, /responseStep: "card"/);
  assert.match(source, /next\.pass\.responseStep = "discard";/);
  assert.match(source, /if \(passTargets\(next\)\.size === 0\)/);
  assert.match(
    rules,
    /position === enemyGoal\(player\.team\) && playerHasBall\(player\)/,
  );
  assert.doesNotMatch(rules, /targets\.add\(enemyGoal\(player\.team\)\)/);
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
});

test("knight passes expose the first orthogonal square for interception", () => {
  assert.deepEqual(passPath(35, 52, "knight"), [43]);
  assert.deepEqual(passPath(35, 45, "knight"), [36]);
  assert.equal(passPath(35, 53, "knight"), null);
});
