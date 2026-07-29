import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { BOARD_HEIGHT, BOARD_SIZE, BLUE_GOAL, BLUE_GOALS, RED_PENALTY_AREA, movementPath, movementTargets, passBlockerCount, passBlockedByPlayer, passPath } = await import(
  new URL("../shared/game-rules.ts", import.meta.url)
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

// Read all game source files for pattern checks
async function allSource() {
  const files = [
    "../app/page.tsx",
    "../app/components/GameBoard.tsx",
    "../shared/types.ts",
    "../shared/constants.ts",
    "../shared/game-rules.ts",
    "../shared/ai.ts",
    "../shared/game-engine.ts",
    "../shared/ai-engine.ts",
  ];
  const contents = await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url), "utf8")));
  return contents.join("\n");
}

test("server-renders the PASS game shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PASS — 战术足球卡牌游戏<\/title>/i);
  // Title-case in og:title meta tag (UI content is client-rendered via RSC)
  assert.match(html, /Tactical Football Card Game/i);
  // RSC hydration bootstrap
  assert.match(html, /<script[^>]*\bid="_R_"[^>]*>/i);
  assert.match(html, /__VINEXT_RSC_DONE__/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("source implements staged turns and end-of-turn rule checks", async () => {
  const source = await allSource();
  const rules = await readFile(new URL("../shared/game-rules.ts", import.meta.url), "utf8");

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
  assert.doesNotMatch(source, /pressUsed|maxPressesPerTurn/);
  assert.match(source, /function countedHandSize\(player: Player\)/);
  assert.match(rules, /const range = suit === "bishop" \? 2 : 3;/);
  assert.match(source, /type Phase = "setup" \| "turn" \| "save-response"/);
  assert.doesNotMatch(source, /hasOffsidePlayer/);
});

test("the temporary test deck contains only movement cards", async () => {
  const engine = await readFile(new URL("../shared/game-engine.ts", import.meta.url), "utf8");
  const buildDeckBody = engine.slice(engine.indexOf("export function buildDeck"), engine.indexOf("export function emptyTurn"));
  assert.match(buildDeckBody, /\["rock", "bishop", "knight"\]/);
  assert.match(buildDeckBody, /GAME_BALANCE\.actionCardsPerSuit/);
  assert.doesNotMatch(buildDeckBody, /specialCards|SpecialCard/);
});

test("the pitch is 8 by 10 with single-character rank X", async () => {
  const engine = await readFile(new URL("../shared/game-engine.ts", import.meta.url), "utf8");
  assert.equal(BOARD_HEIGHT, 10);
  assert.equal(BOARD_SIZE, 80);
  assert.deepEqual(RED_PENALTY_AREA, [74, 75, 76, 77]);
  assert.match(engine, /numericRank === 10 \? "X"/);
  assert.match(engine, /\.team === "red" \? 44 : 35/);
});

test("movement ranges stop at three orthogonal or two diagonal squares and never enter goals", () => {
  const defender = { team: "red", position: 35, hand: [{ kind: "action" }] };
  const defenseGame = { offense: "blue", players: [defender] };
  const offenseGame = { offense: "red", players: [defender] };

  assert.equal(movementTargets(defenseGame, defender, "rock").has(38), true);
  assert.equal(movementTargets(offenseGame, defender, "rock").has(38), true);
  assert.equal(movementTargets(defenseGame, defender, "rock").has(39), false);
  assert.equal(movementTargets(defenseGame, defender, "bishop").has(17), true);
  assert.equal(movementTargets(offenseGame, defender, "bishop").has(17), true);
  assert.equal(movementTargets(defenseGame, defender, "bishop").has(8), false);
  assert.equal(movementTargets(defenseGame, defender, "rock").has(BLUE_GOAL), false);
  assert.equal(movementPath(35, 8, "bishop"), null);
  assert.equal(movementPath(35, 3, "rock"), null);
});

test("passes have doubled movement range and external-goal paths", () => {
  assert.deepEqual(passPath(48, 0, "rock"), [40, 32, 24, 16, 8]);
  assert.equal(passPath(56, 0, "rock"), null);
  assert.deepEqual(passPath(43, 15, "bishop"), [36, 29, 22]);
  assert.equal(passPath(50, 15, "bishop"), null);

  assert.deepEqual(passPath(11, BLUE_GOALS[0], "rock"), [3]);
  assert.deepEqual(passPath(12, BLUE_GOALS[1], "rock"), [4]);
});

test("defending penalty-area occupancy is limited on entry", () => {
  const b1 = { team: "blue", position: 2, hand: [] };
  const b2 = { team: "blue", position: 11, hand: [] };
  const game = { offense: "red", players: [b1, b2] };
  assert.equal(movementTargets(game, b2, "rock").has(3), false);
});

test("foul, initial defender draw, shooting restriction, and unlimited paid press are wired into the engine", async () => {
  const engine = await readFile(new URL("../shared/game-engine.ts", import.meta.url), "utf8");
  assert.match(engine, /player\.team === game\.offense \|\| !isInOwnPenaltyArea\(player\.team, player\.position\)/);
  assert.match(engine, /kickoff\(game, receiverId, "禁区超员犯规后开球：", player\.id, true\)/);
  assert.match(engine, /candidate\.team !== game\.offense/);
  assert.match(engine, /defenders\.forEach\(\(defender\) => drawInto\(game, defender, 1\)\)/);
  assert.match(engine, /game\.phase === "setup"/);
  assert.doesNotMatch(engine, /game\.phase === "setup" \|\| game\.phase === "kickoff"/);
  assert.match(engine, /isGoal\(position\) && isInEnemyPenaltyArea\(passer\.team, passer\.position\)/);
  assert.match(engine, /resolvePressAction\(game: GameState, costCardId: string, targetId: string/);
  assert.match(engine, /game\.discard\.push\(costCard\)/);
  assert.match(engine, /!hasBall\(target\)/);
  assert.doesNotMatch(engine, /pressUsed|maxPressesPerTurn/);
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
    passBlockedByPlayer(48, 0, "rock", [
      { position: 40, team: "red" },
      { position: 32, team: "blue" },
    ]),
    true,
  );
  assert.equal(
    passBlockedByPlayer(48, 0, "rock", [{ position: 40, team: "red" }]),
    true,
  );
  assert.equal(passBlockedByPlayer(56, 48, "rock", [{ position: 48, team: "red" }]), false);
  assert.equal(passBlockedByPlayer(35, 52, "knight", [{ position: 43, team: "red" }]), true);
});

test("long passes may cross one player but never a second", () => {
  assert.equal(passBlockerCount(48, 0, "rock", [{ position: 40 }]), 1);
  assert.equal(passBlockerCount(48, 0, "rock", [{ position: 40 }, { position: 32 }]), 2);
  assert.equal(passBlockerCount(35, 52, "knight", [{ position: 43 }]), 1);
});

test("AI choices remain random while favoring higher board value", async () => {
  const ai = await readFile(new URL("../shared/ai.ts", import.meta.url), "utf8");
  const engine = await readFile(new URL("../shared/ai-engine.ts", import.meta.url), "utf8");
  assert.match(ai, /Math\.exp\(Math\.max\(-16, Math\.min\(16, \(candidate\.score - maxScore\) \/ safeTemperature\)\)\)/);
  assert.match(ai, /random\(\)/);
  assert.match(ai, /goalDistance/);
  assert.match(ai, /topBandCandidates/);
  assert.match(engine, /weightedTopBandAiChoice\(choices, 1\.15, random, 3, 4\)/);
});

test("AI plans around turn-order responsibility, friendly hands, and loose-ball races", async () => {
  const engine = await readFile(new URL("../shared/ai-engine.ts", import.meta.url), "utf8");
  assert.match(engine, /export function defensiveResponsibilityIds/);
  assert.match(engine, /if \(candidate\.team === player\.team\) break;/);
  assert.match(engine, /candidate\.team === passer\.team/);
  assert.match(engine, /firstLikelyLooseBallCollector\(game, player, position\)/);
  assert.match(engine, /ownCollector \? 24 : collector \? -55 : -8/);
  assert.match(engine, /potentialShotLanes/);
  assert.match(engine, /urgentShotThreat \? 28 : 0/);
  assert.doesNotMatch(engine, /weightedAiChoice\(movePlans|weightedAiChoice\(passPlans/);
});

test("AI automation covers multi-card turns and discarding without legacy pass phases", async () => {
  const source = await allSource();

  assert.match(source, /if \(game\.phase === "turn"\) runAiTurn\(game, humanPlayerIds/);
  assert.match(source, /else if \(game\.phase === "save-response"\) runAiSaveResponse\(game/);
  assert.match(source, /else if \(game\.phase === "discard"\) runAiDiscard\(game/);
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
  assert.doesNotMatch(source, /scoreGoal\(game, player, "移动", from, path\)/);
  assert.match(source, /ALL_GOALS\.map/);
  assert.match(source, /className="card-cost"/);
  assert.match(source, /className=\{`trace-line/);

  // UI content is now client-rendered — verify in source instead of HTML
  assert.match(source, /你控制全队 · 对方由 AI 控制/);
  assert.match(source, /选择本局由你控制的球队/);
  assert.match(source, /humanPlayerIds=\{humanPlayerIds\}/);
  assert.match(source, /等待第一步行动/);
  assert.match(source, /aria-live=\{/);
  assert.match(source, /aria-atomic/);
});

test("large-screen wrapped hands start at the first row and remain vertically scrollable", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.command-deck \.card-fan \{ display: grid; grid-template-columns: repeat\(2, 100px\); grid-auto-rows: 130px; align-content: start;/);
  assert.match(css, /overflow-x: hidden; overflow-y: auto;/);
});

test("the active controlled player hand follows each new turn without blocking teammate inspection", async () => {
  const board = await readFile(new URL("../app/components/GameBoard.tsx", import.meta.url), "utf8");
  assert.match(board, /handView\.turnActorId !== current\.id/);
  assert.match(board, /currentHumanTurnStarted \? current\.id : defaultViewedPlayerId/);
  assert.match(board, /setHandView\(\{ turnActorId: current\.id, playerId: player\.id \}\)/);
});

test("zero action points automatically finish when no zero-cost card remains", async () => {
  const source = await allSource();
  assert.match(source, /game\.turn\.actionsRemaining !== 0/);
  assert.match(source, /card\.kind !== "ball" && card\.cost === 0/);
  assert.match(source, /autoFinishTurnIfNeeded\(next\)/);
  assert.match(source, /autoFinishTurnIfNeeded\(game\)/);
});

test("reduced-motion users retain static event highlights", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.pitch-cell\.event-route/);
  assert.match(css, /\.pitch-cell\.event-to \{ outline:/);
  assert.match(css, /\.player-token\.event-actor \{ box-shadow:/);
});

test("multiplayer entry and copy never masquerade as single-player AI", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const board = await readFile(new URL("../app/components/GameBoard.tsx", import.meta.url), "utf8");

  assert.match(page, /params\.has\("singleplayer"\)/);
  assert.match(page, /if \(singlePlayerFromUrl\)/);
  assert.match(page, /返回联机大厅/);
  assert.match(page, /return <MultiplayerApp \/>;/);
  assert.doesNotMatch(page, /manualMultiplayer/);
  assert.match(board, /const aiThinking = !isMultiplayer/);
  assert.match(board, /!isMultiplayer && game\.aiNote/);
  assert.match(board, /每位玩家控制自己的球员/);
  assert.match(board, /等待 \$\{current\.label\} 行动/);
  assert.match(board, /双方玩家的移动、传球、上抢与球权变化/);
  assert.match(board, /isMultiplayer \? "remote-player" : "ai"/);
});
