import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseSlot,
  controlledPositionIds,
  createRoom,
  joinRoom,
  reconnectPlayer,
  setPlayerDisconnected,
  startGame,
  toRoomState,
  toggleReady,
} from "../server/room.ts";

function fakeSocket() {
  return {
    closeCalled: false,
    close() { this.closeCalled = true; },
  };
}

function fakeGame() {
  return {
    players: [
      { id: "r1", label: "红方", team: "red", position: 60, hand: [{ id: "rock-1", kind: "action", suit: "rock", cost: 1 }, { id: "football", kind: "ball" }], nextTurnPenalty: 0 },
      { id: "b1", label: "蓝方", team: "blue", position: 4, hand: [{ id: "bishop-1", kind: "action", suit: "bishop", cost: 1 }], nextTurnPenalty: 0 },
    ],
    deck: [{ id: "knight-1", kind: "action", suit: "knight", cost: 1 }],
    discard: [], offense: "red", scores: { red: 0, blue: 0 }, turnIndex: 0,
    turn: { actionsRemaining: 1, actionsSpent: 0, tackleUsed: false, acquiredBall: false, cardsPlayed: 0, longPassReady: false },
    phase: "setup", discardQueue: [], log: [], kickoffReason: "赛前布阵",
    eventSeq: 0, traceSeq: 0, traces: [],
  };
}

test("lobby capacity counts players who have not selected a seat", () => {
  const { room } = createRoom("1v1", "房主");
  const second = joinRoom(room, undefined, "蓝方");
  const third = joinRoom(room, undefined, "观众");

  assert.equal(second.slot.isSpectator, false);
  assert.equal(third.slot.isSpectator, true);
});

test("closing a replaced socket cannot disconnect the resumed session", () => {
  const { room, playerId, reconnectToken } = createRoom("1v1", "断线玩家");
  const oldSocket = fakeSocket();
  const newSocket = fakeSocket();
  room.connections.set(playerId, oldSocket);

  const resumed = joinRoom(room, reconnectToken, "");
  reconnectPlayer(room, resumed.slot.playerId, newSocket);
  setPlayerDisconnected(room, playerId, oldSocket);

  assert.equal(oldSocket.closeCalled, true);
  assert.equal(room.connections.get(playerId), newSocket);
  assert.equal(resumed.slot.isConnected, true);
});

test("room snapshots reveal only the viewer hand and public ball holder", () => {
  const { room, playerId } = createRoom("1v1", "红方");
  room.slots[0].positionId = "r1";
  room.slots[0].team = "red";
  const blue = joinRoom(room, undefined, "蓝方");
  blue.slot.positionId = "b1";
  blue.slot.team = "blue";
  room.gameState = fakeGame();

  const redRealIds = room.gameState.players.find((player) => player.id === "r1").hand.map((card) => card.id);
  const blueRealIds = room.gameState.players.find((player) => player.id === "b1").hand.map((card) => card.id);
  const snapshot = toRoomState(room, playerId).gameState;
  const redView = snapshot.players.find((player) => player.id === "r1");
  const blueView = snapshot.players.find((player) => player.id === "b1");

  assert.deepEqual(redView.hand.map((card) => card.id), redRealIds);
  assert.equal(blueView.hand.length, blueRealIds.length);
  assert.equal(blueView.hand.every((card) => card.id.startsWith("hidden-")), true);
  assert.equal(snapshot.deck.every((card) => card.id.startsWith("hidden-deck-")), true);
});

test("3v3 duel uses two human seats that each control a complete team", () => {
  const { room, playerId } = createRoom("3v3-duel", "红队教练");
  const blue = joinRoom(room, undefined, "蓝队教练");

  assert.equal(room.boardMode, "3v3");
  assert.equal(room.playerSlotsPerTeam, 1);
  assert.equal(chooseSlot(room, playerId, "r1"), true);
  assert.equal(chooseSlot(room, blue.slot.playerId, "b1"), true);
  assert.deepEqual(controlledPositionIds(room.slots[0]), ["r1", "r2", "r3"]);
  assert.deepEqual(controlledPositionIds(blue.slot), ["b1", "b2", "b3"]);

  toggleReady(room, playerId);
  toggleReady(room, blue.slot.playerId);
  assert.equal(startGame(room), true);
});

test("4v4 duo assigns interleaved pairs and requires four ready humans", () => {
  const { room, playerId } = createRoom("4v4-duo", "红方甲");
  const redTwo = joinRoom(room, undefined, "红方乙");
  const blueOne = joinRoom(room, undefined, "蓝方甲");
  const blueTwo = joinRoom(room, undefined, "蓝方乙");

  assert.equal(room.boardMode, "4v4");
  assert.equal(room.playerSlotsPerTeam, 2);
  assert.equal(chooseSlot(room, playerId, "r1"), true);
  assert.equal(chooseSlot(room, redTwo.slot.playerId, "r2"), true);
  assert.equal(chooseSlot(room, blueOne.slot.playerId, "b1"), true);
  assert.equal(chooseSlot(room, blueTwo.slot.playerId, "b2"), true);
  assert.deepEqual(controlledPositionIds(room.slots[0]), ["r1", "r3"]);
  assert.deepEqual(controlledPositionIds(redTwo.slot), ["r2", "r4"]);
  assert.deepEqual(controlledPositionIds(blueOne.slot), ["b1", "b3"]);
  assert.deepEqual(controlledPositionIds(blueTwo.slot), ["b2", "b4"]);

  [playerId, redTwo.slot.playerId, blueOne.slot.playerId].forEach((id) => toggleReady(room, id));
  assert.equal(startGame(room), false);
  toggleReady(room, blueTwo.slot.playerId);
  assert.equal(startGame(room), true);
});

test("multi-controller snapshots reveal all owned hands but not a teammate controller hand", () => {
  const { room, playerId } = createRoom("4v4-duo", "红方甲");
  chooseSlot(room, playerId, "r1");
  room.gameState = fakeGame();
  room.gameState.players = ["r1", "r2", "r3", "r4", "b1", "b2", "b3", "b4"].map((id, index) => ({
    id,
    label: id.toUpperCase(),
    team: id.startsWith("r") ? "red" : "blue",
    position: index,
    hand: [{ id: `${id}-card`, kind: "action", suit: "rock", cost: 1 }],
    nextTurnPenalty: 0,
  }));

  const snapshot = toRoomState(room, playerId).gameState;
  assert.equal(snapshot.players.find((player) => player.id === "r1").hand[0].id, "r1-card");
  assert.equal(snapshot.players.find((player) => player.id === "r3").hand[0].id, "r3-card");
  assert.match(snapshot.players.find((player) => player.id === "r2").hand[0].id, /^hidden-r2-/);
  assert.match(snapshot.players.find((player) => player.id === "b1").hand[0].id, /^hidden-b1-/);
});
