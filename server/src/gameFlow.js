/**
 * Game-phase transitions and anything that needs to emit socket events.
 * Depends on `io` + the shared room store, so it's built as a factory
 * instead of a plain module (keeps it testable without a live socket.io
 * server if ever needed).
 */
const { shuffle } = require('./shuffle');

function createGameFlow({ io, config, roomStore, cardRegistry }) {
  const { getPublicRoom, findPlayerByName, migratePlayerSocketInRoom } = roomStore;

  function clearPostRoundTimer(room) {
    if (room && room._postRoundTimer) {
      clearTimeout(room._postRoundTimer);
      room._postRoundTimer = null;
    }
  }

  function continueAfterRoundResult(room) {
    const hasWinner = room.players.some(player => player.score >= room.targetScore);
    if (hasWinner) endGame(room);
    else startDeckSwap(room);
  }

  function schedulePostRoundTransition(room) {
    clearPostRoundTimer(room);
    room._pendingPostRoundTransition = false;
    room._postRoundTimer = setTimeout(() => {
      room._postRoundTimer = null;
      if (room.paused) {
        room._pendingPostRoundTransition = true;
        return;
      }
      continueAfterRoundResult(room);
    }, config.ROUND_RESULT_DELAY_MS);
  }

  function resumePausedRoom(room) {
    if (!room || room.paused) return;
    if (room._pendingPostRoundTransition) {
      room._pendingPostRoundTransition = false;
      continueAfterRoundResult(room);
    }
  }

  function queueJoinForNextRound(room, socket, name, existingPlayer = null) {
    if (!room.pendingJoins) room.pendingJoins = [];

    const normalizedName = roomStore.normalizePlayerName(name, `Jugador ${room.players.length + 1}`);
    const type = existingPlayer ? 'rejoin' : 'new';
    const byName = room.pendingJoins.findIndex(p => p.name.toLowerCase() === normalizedName.toLowerCase());
    const bySocket = room.pendingJoins.findIndex(p => p.socketId === socket.id);
    const targetIndex = byName !== -1 ? byName : bySocket;
    const payload = { socketId: socket.id, name: normalizedName, type };

    if (targetIndex !== -1) room.pendingJoins[targetIndex] = payload;
    else room.pendingJoins.push(payload);

    socket.join(room.id);
    socket.data.roomId = room.id;

    const message = existingPlayer
      ? `Reconectado en cola como ${existingPlayer.name}. Conservás puntos y entrás cuando termine la ronda.`
      : `Te uniste en cola como ${normalizedName}. Entrás cuando termine la ronda actual.`;

    socket.emit('join_queued', {
      room: getPublicRoom(room),
      message,
    });

    io.to(room.id).emit('room_updated', getPublicRoom(room));
  }

  function applyPendingJoins(room) {
    if (!room || !Array.isArray(room.pendingJoins) || room.pendingJoins.length === 0) return 0;

    let applied = 0;
    const stillPending = [];

    for (const pending of room.pendingJoins) {
      const socket = io.sockets.sockets.get(pending.socketId);
      if (!socket) continue;

      socket.join(room.id);
      socket.data.roomId = room.id;

      if (pending.type === 'rejoin') {
        const player = findPlayerByName(room, pending.name);
        if (!player) continue;

        if (player._disconnectTimer) {
          clearTimeout(player._disconnectTimer);
          delete player._disconnectTimer;
        }

        const oldId = player.id;
        player.id = pending.socketId;
        migratePlayerSocketInRoom(room, oldId, pending.socketId);
        applied++;
        continue;
      }

      const liveCount = room.players.length + stillPending.filter(p => p.type === 'new').length;
      if (liveCount >= config.MAX_PLAYERS) {
        socket.emit('error', { message: 'La sala está llena. No se pudo completar la unión.' });
        continue;
      }

      room.players.push({ id: pending.socketId, name: pending.name, score: 0, hand: [] });
      applied++;
    }

    room.pendingJoins = stillPending;
    if (room.judgeIndex >= room.players.length) room.judgeIndex = 0;
    if (applied > 0) {
      io.to(room.id).emit('room_updated', getPublicRoom(room));
    }

    return applied;
  }

  function drawCards(room, playerId, count) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    const dealtNow = [];
    for (let i = 0; i < count && room.deck.length > 0; i++) {
      const cardId = room.deck.pop();
      player.hand.push(cardId);
      dealtNow.push(cardId);
    }
    if (dealtNow.length > 0) cardRegistry.markCardsUsed(dealtNow);
  }

  function topUpHandsToTarget(room) {
    for (const player of room.players) {
      const needed = Math.max(0, config.HAND_SIZE - player.hand.length);
      if (needed > 0) drawCards(room, player.id, needed);
    }
  }

  function dealInitialHands(room) {
    for (const player of room.players) {
      player.hand = [];
      for (let i = 0; i < config.HAND_SIZE && room.deck.length > 0; i++) {
        player.hand.push(room.deck.pop());
      }
      cardRegistry.markCardsUsed(player.hand);
    }
  }

  function sendPrivateHands(room) {
    for (const player of room.players) {
      io.to(player.id).emit('your_hand', {
        hand: player.hand,
        isJudge: room.players[room.judgeIndex]?.id === player.id,
      });
    }
  }

  // Send hand update only to one player (avoids resetting other players' selections)
  function sendPrivateHand(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    io.to(playerId).emit('your_hand', {
      hand: player.hand,
      isJudge: room.players[room.judgeIndex]?.id === playerId,
    });
  }

  function startRound(room) {
    clearPostRoundTimer(room);
    room._pendingPostRoundTransition = false;

    // Activate queued joins/rejoins at round boundary.
    applyPendingJoins(room);

    // Safety net: every new round should begin with target hand size per player.
    topUpHandsToTarget(room);

    room.table = [];
    room.submissions = {};
    room.votes = {};
    room.swapDone = {};
    room.roundWinnerId = null;
    room.roundWinnerIds = [];
    room.roundPoints = 0;
    room.roundPointsAssigned = false;
    room.tieRounds = 0;
    room.isRedRound = false;
    room.lastVoteCounts = null;
    room.lastRoundSubmissions = null;
    room.lastShuffledSubmissions = null;

    if (room.deck.length === 0) {
      endGame(room);
      return;
    }

    // Flip first card from deck
    const firstCard = room.deck.pop();
    room.table.push({ cardId: firstCard, playerId: 'deck', position: null });
    cardRegistry.markCardsUsed([firstCard]);

    // Manual mode: judge always chooses table layout; no automatic red handling.
    room.phase = 'judge_play';

    io.to(room.id).emit('round_started', getPublicRoom(room));
    sendPrivateHands(room);
  }

  function startNextRoundFromResult(room) {
    if (!room || room.phase !== 'round_result' || room.paused) return;

    // Refill hands to target size.
    for (const player of room.players) {
      const needed = config.HAND_SIZE - player.hand.length;
      drawCards(room, player.id, needed);
    }

    // Judge rotates in fixed order (not random)
    room.judgeIndex = (room.judgeIndex + 1) % room.players.length;
    startRound(room);
  }

  function startDeckSwap(room) {
    if (!room || room.phase === 'game_over' || room.paused) return;

    clearPostRoundTimer(room);
    room._pendingPostRoundTransition = false;

    // Before MAZO, players should already be at target hand size.
    topUpHandsToTarget(room);

    room.phase = 'deck_swap';
    room.swapDone = {};
    io.to(room.id).emit('deck_swap_started', getPublicRoom(room));
    sendPrivateHands(room);
  }

  function finishDeckSwap(room) {
    if (!room || room.phase !== 'deck_swap') return;
    // Judge rotates in fixed order, one by one.
    room.judgeIndex = (room.judgeIndex + 1) % room.players.length;
    startRound(room);
  }

  function endGame(room) {
    clearPostRoundTimer(room);
    room._pendingPostRoundTransition = false;
    room.phase = 'game_over';
    room.paused = false;
    const winner = [...room.players].sort((a, b) => b.score - a.score)[0];
    io.to(room.id).emit('game_over', { winner: winner?.name, players: getPublicRoom(room).players });
  }

  async function terminateMatch(room) {
    const roomId = room.id;
    clearPostRoundTimer(room);
    room._pendingPostRoundTransition = false;
    room.phase = 'game_over';
    room.paused = false;
    io.to(roomId).emit('match_terminated', { players: getPublicRoom(room).players });

    // Clear pending disconnect timers and detach sockets from this room.
    for (const player of room.players) {
      if (player._disconnectTimer) {
        clearTimeout(player._disconnectTimer);
        delete player._disconnectTimer;
      }
    }

    const socketsInRoom = await io.in(roomId).fetchSockets();
    for (const s of socketsInRoom) {
      s.data.roomId = null;
      s.leave(roomId);
    }

    delete roomStore.rooms[roomId];
    console.log(`[Room] Terminated and deleted: ${roomId}`);
  }

  function checkRoundEnd(room) {
    const allSubmitted = room.players.every(p => room.submissions[p.id]);
    if (!allSubmitted) return;

    room.phase = 'voting';
    room.votes = {};

    const shuffledSubmissions = shuffle(Object.entries(room.submissions)).map(([pid, data]) => ({
      submissionId: pid,
      cards: data.cards,
      position: data.position,
    }));
    room.lastShuffledSubmissions = shuffledSubmissions;
    io.to(room.id).emit('voting_phase', {
      ...getPublicRoom(room),
      shuffledSubmissions,
    });
  }

  function checkVotingEnd(room) {
    const allVoted = room.players.every(p => room.votes[p.id]);
    if (!allVoted) return;

    const voteCounts = {};
    for (const votedFor of Object.values(room.votes)) {
      voteCounts[votedFor] = (voteCounts[votedFor] || 0) + 1;
    }

    const maxVotes = Math.max(...Object.values(voteCounts));
    const topCandidates = Object.entries(voteCounts).filter(([, v]) => v === maxVotes);

    // Ties share the round point equally: everyone with the highest vote
    // count gets +1, instead of forcing a re-vote or picking one at random.
    const winners = topCandidates
      .map(([pid]) => room.players.find(p => p.id === pid))
      .filter(Boolean);
    if (!winners.length) return;

    for (const winner of winners) winner.score += 1;

    room.roundWinnerId = winners[0].id;
    room.roundWinnerIds = winners.map(w => w.id);
    room.roundPoints = 1;
    room.roundPointsAssigned = true;
    room.lastVoteCounts = voteCounts;
    room.lastRoundSubmissions = Object.entries(room.submissions).map(([pid, data]) => ({
      playerId: pid,
      playerName: room.players.find(p => p.id === pid)?.name,
      cards: data.cards,
      position: data.position,
      votes: voteCounts[pid] || 0,
    }));
    room.phase = 'round_result';

    io.to(room.id).emit('round_result', {
      winnerId: winners[0].id,
      winnerName: winners[0].name,
      winnerIds: room.roundWinnerIds,
      winnerNames: winners.map(w => w.name),
      tied: winners.length > 1,
      points: 1,
      awaitingJudgePoints: false,
      voteCounts,
      submissions: room.lastRoundSubmissions,
      room: getPublicRoom(room),
    });

    schedulePostRoundTransition(room);
  }

  function activateRedRoundFromJudge(room, socket) {
    if (!room) return { ok: false, message: 'Sala no encontrada.' };
    if (room.phase !== 'judge_play') return { ok: false, message: 'Ahora no se puede activar carta roja.' };

    const judge = room.players[room.judgeIndex];
    if (!judge || judge.id !== socket.id) {
      return { ok: false, message: 'Solo el juez puede activar carta roja.' };
    }

    room.isRedRound = true;
    if (room.table[0]) room.table[0].position = 3;
    room.phase = 'player_play';

    io.to(room.id).emit('round_phase_updated', getPublicRoom(room));
    sendPrivateHands(room);
    return { ok: true };
  }

  return {
    queueJoinForNextRound,
    applyPendingJoins,
    drawCards,
    topUpHandsToTarget,
    dealInitialHands,
    startRound,
    startNextRoundFromResult,
    startDeckSwap,
    finishDeckSwap,
    sendPrivateHands,
    sendPrivateHand,
    endGame,
    terminateMatch,
    checkRoundEnd,
    checkVotingEnd,
    resumePausedRoom,
    activateRedRoundFromJudge,
  };
}

module.exports = { createGameFlow };
