/**
 * End-to-end smoke test for the game server.
 *
 * Spins up a real server process on a throwaway port, drives 3 socket.io
 * clients through create room -> join -> start game -> judge play ->
 * everyone submits -> everyone votes -> round result -> deck swap ->
 * next round, and asserts the important state transitions along the way.
 *
 * This exists to catch regressions from refactors (module split, etc.)
 * without needing a browser. Run with `npm test`.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { io: ioClient } = require('socket.io-client');

const PORT = process.env.SMOKE_TEST_PORT || 3999;
const URL = `http://localhost:${PORT}`;

function createTestDataDir() {
  // Isolated scratch dir so the test's used_cards_memory.json never touches
  // (and pollutes) the real one used by actual games.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'joking-hazard-smoke-'));
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('Local:')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
    child.on('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`Server exited with code ${code}`));
    });
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = ioClient(URL, { transports: ['websocket'], reconnection: false });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function once(socket, event) {
  return onceWithTimeout(socket, event, 8000);
}

function onceWithTimeout(socket, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), ms);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function stopChildProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });
}

function waitForNoEvent(socket, event, ms = 250) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, ms);
    socket.once(event, onEvent);
  });
}

async function createRoomWithPlayers(host, others, targetScore = 10) {
  host.emit('create_room', { name: 'Host', targetScore });
  const created = await onceWithTimeout(host, 'room_created', 5000);
  const roomId = created.roomId;

  for (let i = 0; i < others.length; i++) {
    const socket = others[i];
    socket.emit('join_room', { roomId, name: `P${i + 2}` });
    await onceWithTimeout(socket, 'room_joined', 5000);
  }

  return roomId;
}

async function reachVotingPhase(host, players, targetScore = 10) {
  const handsPromise = Promise.all(players.map(player => onceWithTimeout(player, 'your_hand', 5000)));
  const roundStartedPromise = onceWithTimeout(host, 'round_started', 5000);

  host.emit('start_game', { targetScore });
  const started = await onceWithTimeout(host, 'game_started', 5000);
  assert.strictEqual(started.phase, 'playing');

  const roundStarted = await roundStartedPromise;
  assert.strictEqual(roundStarted.phase, 'judge_play');
  assert.strictEqual(roundStarted.judgeIndex, 0, 'host should be judge in round 1');

  const hands = await handsPromise;
  assert.ok(hands[0].isJudge, 'host should be flagged as judge');

  host.emit('judge_play', { cardId: hands[0].hand[0], judgePos: 1, deckPos: 2 });
  const [, judgeUpdatedHand] = await Promise.all([
    onceWithTimeout(host, 'judge_played', 5000),
    onceWithTimeout(host, 'your_hand', 5000),
  ]);

  host.emit('play_card', { cardId: judgeUpdatedHand.hand[0] });
  for (let i = 1; i < players.length; i++) {
    players[i].emit('play_card', { cardId: hands[i].hand[0] });
  }

  const voting = await onceWithTimeout(host, 'voting_phase', 5000);
  assert.strictEqual(voting.phase, 'voting');
  assert.strictEqual(voting.shuffledSubmissions.length, players.length, 'all players should have submitted');
  return voting;
}

async function runSelfVoteRulesTest() {
  const testDataDir = createTestDataDir();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ROUND_RESULT_DELAY_MS: '200', DATA_DIR: testDataDir },
  });

  let host, p2, p3;
  try {
    await waitForReady(child);
    [host, p2, p3] = await Promise.all([connect(), connect(), connect()]);

    // Scenario 1: with 2 players, self-vote is allowed.
    await createRoomWithPlayers(host, [p2], 10);
    const voting2p = await reachVotingPhase(host, [host, p2], 10);
    const p2OwnSubmission2p = voting2p.shuffledSubmissions.find(s => s.submissionId === p2.id).submissionId;
    const noError2p = waitForNoEvent(p2, 'error');
    p2.emit('cast_vote', { votedForId: p2OwnSubmission2p });
    host.emit('cast_vote', { votedForId: p2OwnSubmission2p });
    const roundResult2p = await once(host, 'round_result');
    await noError2p;
    assert.strictEqual(roundResult2p.winnerId, p2.id, 'self-vote should be allowed with 2 players');

    host.emit('terminate_match');
    await once(host, 'match_terminated');

    // Scenario 2: with 3 players, self-vote is rejected but a later valid vote works.
    await createRoomWithPlayers(host, [p2, p3], 10);
    const voting3p = await reachVotingPhase(host, [host, p2, p3], 10);
    const p2OwnSubmission3p = voting3p.shuffledSubmissions.find(s => s.submissionId === p2.id).submissionId;
    const p3SubmissionId = voting3p.shuffledSubmissions.find(s => s.submissionId === p3.id).submissionId;

    p2.emit('cast_vote', { votedForId: p2OwnSubmission3p });
    const selfVoteError = await once(p2, 'error');
    assert.match(selfVoteError.message, /no podés votarte a vos mismo/i, '3-player self-vote should be rejected');

    // The invalid self-vote must not consume p2's vote; a valid vote right after should still count.
    host.emit('cast_vote', { votedForId: p3SubmissionId });
    p2.emit('cast_vote', { votedForId: p3SubmissionId });
    p3.emit('cast_vote', { votedForId: host.id });
    const roundResult3p = await once(host, 'round_result');
    assert.strictEqual(roundResult3p.winnerId, p3.id, 'valid vote after rejected self-vote should still be accepted');
  } finally {
    [host, p2, p3].forEach(s => s && s.close());
    await stopChildProcess(child);
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function runReconnectSyncTest() {
  console.log('🔎 Reconnect sync test: starting');
  const testDataDir = createTestDataDir();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      ROUND_RESULT_DELAY_MS: '500',
      DISCONNECT_GRACE_MS: '50',
      DISCONNECT_REMOVE_MS: '2000',
      DATA_DIR: testDataDir,
    },
  });

  let host, p2, p3, p2Rejoined, p3Rejoined;
  try {
    await waitForReady(child);
    [host, p2, p3] = await Promise.all([connect(), connect(), connect()]);

    const roomId = await createRoomWithPlayers(host, [p2, p3], 10);
    console.log('🔎 Reconnect sync test: room created, entering voting');
    const voting = await reachVotingPhase(host, [host, p2, p3], 10);
    const votingOrder = voting.shuffledSubmissions.map(s => s.submissionId);
    const p3SubmissionId = votingOrder.find(id => id === p3.id);

    // Reconnect during voting should restore phase + shuffled voting order.
    p2.disconnect();
    await onceWithTimeout(host, 'room_paused', 2500);
    console.log('🔎 Reconnect sync test: paused during voting, rejoining P2');

    p2Rejoined = await connect();
    p2Rejoined.emit('rejoin_game', { roomId, name: 'P2' });
    const votingSnapshot = await onceWithTimeout(p2Rejoined, 'rejoined', 2500);
    assert.strictEqual(votingSnapshot.room.phase, 'voting', 'rejoin during voting should stay in voting phase');
    assert.ok(votingSnapshot.phaseData, 'voting rejoin should include phaseData');
    assert.deepStrictEqual(
      votingSnapshot.phaseData.shuffledSubmissions.map(s => s.submissionId),
      votingOrder,
      'rejoin during voting should preserve shuffled submission order'
    );
    await onceWithTimeout(host, 'room_resumed', 2500);
    console.log('🔎 Reconnect sync test: resumed in voting, finishing votes');

    host.emit('cast_vote', { votedForId: p3SubmissionId });
    p2Rejoined.emit('cast_vote', { votedForId: p3SubmissionId });
    p3.emit('cast_vote', { votedForId: host.id });
    await onceWithTimeout(host, 'round_result', 2500);

    // Reconnect during round_result should restore result snapshot.
    p3.disconnect();
    await onceWithTimeout(host, 'room_paused', 2500);
    console.log('🔎 Reconnect sync test: paused during round_result, rejoining P3');

    p3Rejoined = await connect();
    p3Rejoined.emit('rejoin_game', { roomId, name: 'P3' });
    const resultSnapshot = await onceWithTimeout(p3Rejoined, 'rejoined', 2500);
    assert.strictEqual(resultSnapshot.room.phase, 'round_result', 'rejoin during round_result should stay in result phase');
    assert.ok(resultSnapshot.phaseData, 'round_result rejoin should include phaseData');
    assert.ok(Array.isArray(resultSnapshot.phaseData.submissions), 'round_result snapshot should include submissions');
    assert.ok(resultSnapshot.phaseData.voteCounts && typeof resultSnapshot.phaseData.voteCounts === 'object', 'round_result snapshot should include voteCounts');
    await onceWithTimeout(host, 'room_resumed', 2500);

    // After resume, delayed transition should continue normally.
    const deckSwap = await onceWithTimeout(host, 'deck_swap_started', 3000);
    assert.strictEqual(deckSwap.phase, 'deck_swap', 'room should continue to deck_swap after resuming from round_result');
    console.log('🔎 Reconnect sync test: passed');
  } finally {
    [host, p2, p3, p2Rejoined, p3Rejoined].forEach(s => s && s.close());
    await stopChildProcess(child);
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const testDataDir = createTestDataDir();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ROUND_RESULT_DELAY_MS: '50', DATA_DIR: testDataDir },
  });

  let host, p2, p3;
  try {
    await waitForReady(child);

    [host, p2, p3] = await Promise.all([connect(), connect(), connect()]);

    // --- Create + join ---
    host.emit('create_room', { name: 'Host', targetScore: 10 });
    const created = await once(host, 'room_created');
    const roomId = created.roomId;
    assert.strictEqual(created.room.players.length, 1, 'only host right after create_room');

    p2.emit('join_room', { roomId, name: 'P2' });
    await once(p2, 'room_joined');
    p3.emit('join_room', { roomId, name: 'P3' });
    const joinedRoom = (await once(p3, 'room_joined')).room;
    assert.strictEqual(joinedRoom.players.length, 3, 'all 3 players should be in the room');

    // --- Start game (host is judge for round 1, judgeIndex defaults to 0) ---
    host.emit('start_game', { targetScore: 10 });
    const started = await once(host, 'game_started');
    assert.strictEqual(started.phase, 'playing');

    const roundStarted = await once(host, 'round_started');
    assert.strictEqual(roundStarted.phase, 'judge_play');
    assert.strictEqual(roundStarted.judgeIndex, 0, 'host should be judge in round 1');

    const [hostHand, p2Hand, p3Hand] = await Promise.all([
      once(host, 'your_hand'),
      once(p2, 'your_hand'),
      once(p3, 'your_hand'),
    ]);
    assert.ok(hostHand.isJudge, 'host should be flagged as judge');
    assert.strictEqual(hostHand.hand.length, 8, 'hand size should match HAND_SIZE');

    // --- Judge plays their setup card ---
    host.emit('judge_play', { cardId: hostHand.hand[0], judgePos: 1, deckPos: 2 });
    const [judgePlayed, judgeUpdatedHand] = await Promise.all([
      once(host, 'judge_played'),
      once(host, 'your_hand'),
    ]);
    assert.strictEqual(judgePlayed.phase, 'player_play');
    assert.strictEqual(judgeUpdatedHand.hand.length, 8, 'judge should get a replacement card');

    // --- Everyone (including judge) submits one card ---
    host.emit('play_card', { cardId: judgeUpdatedHand.hand[0] });
    p2.emit('play_card', { cardId: p2Hand.hand[0] });
    p3.emit('play_card', { cardId: p3Hand.hand[0] });
    const voting = await once(host, 'voting_phase');
    assert.strictEqual(voting.phase, 'voting');
    assert.strictEqual(voting.shuffledSubmissions.length, 3, 'all 3 players should have submitted');

    const p2SubmissionId = voting.shuffledSubmissions.find(s => s.submissionId === p2.id).submissionId;

    // --- Everyone votes; p2 gets 2 of 3 votes ---
    host.emit('cast_vote', { votedForId: p2SubmissionId });
    p3.emit('cast_vote', { votedForId: p2SubmissionId });
    p2.emit('cast_vote', { votedForId: host.id });
    const roundResult = await once(host, 'round_result');

    assert.strictEqual(roundResult.winnerId, p2.id, 'p2 should win with 2 of 3 votes');
    const p2Public = roundResult.room.players.find(pl => pl.id === p2.id);
    assert.strictEqual(p2Public.score, 1, 'winner should be awarded 1 point');

    // --- Deck swap -> next round ---
    const [deckSwapHost, hostSwapHand, deckSwapP2, deckSwapP3] = await Promise.all([
      once(host, 'deck_swap_started'),
      once(host, 'your_hand'),
      once(p2, 'your_hand'),
      once(p3, 'your_hand'),
    ]);
    assert.strictEqual(deckSwapHost.phase, 'deck_swap');

    host.emit('swap_cards', { cardIds: [hostSwapHand.hand[0]] });
    p2.emit('swap_cards', { cardIds: [deckSwapP2.hand[0]] });
    p3.emit('swap_cards', { cardIds: [deckSwapP3.hand[0]] });

    const nextRound = await once(host, 'round_started');
    assert.strictEqual(nextRound.phase, 'judge_play');
    assert.strictEqual(nextRound.judgeIndex, 1, 'judge should rotate to player 2 after round 1');

    console.log('\n✅ Smoke test passed: full round (join -> play -> vote -> score -> deck swap -> next round) works end to end.\n');
  } finally {
    [host, p2, p3].forEach(s => s && s.close());
    await stopChildProcess(child);
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
}

async function mainAll() {
  await main();
  await runSelfVoteRulesTest();
  console.log('✅ Self-vote rules passed: allowed for 2 players, blocked for 3+ players.');
  await runReconnectSyncTest();
  console.log('✅ Reconnect sync passed: voting and round_result recover with consistent state.');
}

mainAll().catch((err) => {
  console.error('\n❌ Smoke test failed:', err);
  process.exit(1);
});
