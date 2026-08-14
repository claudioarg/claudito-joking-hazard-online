/**
 * All `io.on('connection', ...)` wiring. Handlers stay thin: validate the
 * payload, delegate to roomStore/gameFlow, emit the result.
 */
const QRCode = require('qrcode');
const { getLocalIP } = require('./network');

function registerSocketHandlers({ io, config, roomStore, gameFlow, cardRegistry }) {
  const { rooms, createRoom, getPublicRoom, normalizePlayerName, normalizeRoomCode, findPlayerByName, migratePlayerSocketInRoom } = roomStore;
  const localIP = getLocalIP();

  function buildRoomSearchResults(query) {
    const rawQuery = String(query || '').trim();
    const normalizedCodeQuery = normalizeRoomCode(rawQuery);
    const normalizedTextQuery = rawQuery.toLowerCase();

    const matchesQuery = (room, hostName) => {
      if (!rawQuery) return true;
      if (normalizedCodeQuery && room.id.includes(normalizedCodeQuery)) return true;
      return hostName.toLowerCase().includes(normalizedTextQuery);
    };

    return Object.values(rooms)
      .filter(room => room && room.players && room.players.length > 0)
      .filter((room) => {
        const host = room.players.find(p => p.id === room.hostId) || room.players[0];
        const hostName = host?.name || 'Sin host';
        return matchesQuery(room, hostName);
      })
      .map((room) => {
        const host = room.players.find(p => p.id === room.hostId) || room.players[0];
        const pendingNewCount = (room.pendingJoins || []).filter(p => p.type === 'new').length;
        const totalSeatsUsed = room.players.length + pendingNewCount;
        const canJoin = totalSeatsUsed < config.MAX_PLAYERS;

        return {
          roomId: room.id,
          phase: room.phase,
          hostName: host?.name || 'Sin host',
          playerCount: room.players.length,
          maxPlayers: config.MAX_PLAYERS,
          pendingJoinCount: (room.pendingJoins || []).length,
          joinQueued: room.phase !== 'waiting',
          canJoin,
          createdAt: room.createdAt || 0,
        };
      })
      .sort((a, b) => {
        const waitingDiff = Number(b.phase === 'waiting') - Number(a.phase === 'waiting');
        if (waitingDiff !== 0) return waitingDiff;
        const seatDiff = Number(b.canJoin) - Number(a.canJoin);
        if (seatDiff !== 0) return seatDiff;
        return b.createdAt - a.createdAt;
      })
      .slice(0, 30)
      .map(({ createdAt, ...room }) => room);
  }

  function buildClientSnapshot(room, socketId) {
    const player = room.players.find(p => p.id === socketId);
    const snapshot = {
      room: getPublicRoom(room),
      hand: player ? player.hand : [],
      isJudge: room.players[room.judgeIndex]?.id === socketId,
      phaseData: null,
    };

    if (room.phase === 'voting') {
      snapshot.phaseData = {
        shuffledSubmissions: room.lastShuffledSubmissions || [],
      };
    }

    if (room.phase === 'round_result') {
      const winnerIds = room.roundWinnerIds && room.roundWinnerIds.length
        ? room.roundWinnerIds
        : (room.roundWinnerId ? [room.roundWinnerId] : []);
      const winners = winnerIds
        .map(pid => room.players.find(p => p.id === pid))
        .filter(Boolean);
      snapshot.phaseData = {
        winnerId: room.roundWinnerId,
        winnerName: winners[0]?.name,
        winnerIds,
        winnerNames: winners.map(w => w.name),
        tied: winnerIds.length > 1,
        points: room.roundPoints || 1,
        voteCounts: room.lastVoteCounts || {},
        submissions: room.lastRoundSubmissions || [],
      };
    }

    return snapshot;
  }

  io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // Create a new room
    socket.on('create_room', async ({ name, targetScore }) => {
      const roomId = createRoom(targetScore || config.DEFAULT_TARGET_SCORE);
      const room = rooms[roomId];
      room.hostId = socket.id;

      const player = { id: socket.id, name: name || 'Jugador 1', score: 0, hand: [] };
      room.players.push(player);
      socket.join(roomId);
      socket.data.roomId = roomId;

      const external = process.env.RENDER_EXTERNAL_URL || process.env.VERCEL_URL;
      const host = external ? external.replace(/\/$/, '') : `http://${localIP}:${config.PORT}`;
      const joinUrl = `${host}/join?room=${roomId}`;
      const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 256 });

      socket.emit('room_created', {
        roomId,
        joinUrl,
        qrDataUrl,
        room: getPublicRoom(room),
      });
      console.log(`[Room] Created: ${roomId} by ${name}`);
    });

    // Join an existing room
    socket.on('join_room', ({ roomId, name }) => {
      const normalizedRoomId = normalizeRoomCode(roomId);
      const room = rooms[normalizedRoomId];
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada. Revisá el código.' });
        return;
      }
      const normalizedName = normalizePlayerName(name, `Jugador ${room.players.length + 1}`);
      const existingPlayer = findPlayerByName(room, normalizedName);

      if (room.phase !== 'waiting') {
        const pendingNewCount = (room.pendingJoins || []).filter(p => p.type === 'new').length;
        if (!existingPlayer && room.players.length + pendingNewCount >= config.MAX_PLAYERS) {
          socket.emit('error', { message: 'La sala está llena.' });
          return;
        }
        gameFlow.queueJoinForNextRound(room, socket, normalizedName, existingPlayer);
        return;
      }

      // In lobby/waiting, same-name join should behave as reconnect and preserve state.
      if (existingPlayer) {
        const hadGrace = !!existingPlayer._disconnectGraceTimer;
        if (existingPlayer._disconnectGraceTimer) {
          clearTimeout(existingPlayer._disconnectGraceTimer);
          delete existingPlayer._disconnectGraceTimer;
        }
        if (existingPlayer._disconnectTimer) {
          clearTimeout(existingPlayer._disconnectTimer);
          delete existingPlayer._disconnectTimer;
        }

        const oldId = existingPlayer.id;
        existingPlayer.id = socket.id;
        socket.join(room.id);
        socket.data.roomId = room.id;
        migratePlayerSocketInRoom(room, oldId, socket.id);

        if (hadGrace) {
          console.log(`[Reconnect] Recovered before timeout: ${normalizedName} (${oldId} -> ${socket.id}) in ${room.id}`);
        }

        socket.emit('room_joined', { roomId: room.id, room: getPublicRoom(room) });
        io.to(room.id).emit('room_updated', getPublicRoom(room));
        console.log(`[Room] ${normalizedName} rejoined ${room.id}`);
        return;
      }

      if (room.players.length >= config.MAX_PLAYERS) {
        socket.emit('error', { message: 'La sala está llena.' });
        return;
      }

      const player = { id: socket.id, name: normalizedName, score: 0, hand: [] };
      room.players.push(player);
      socket.join(room.id);
      socket.data.roomId = room.id;

      socket.emit('room_joined', { roomId: room.id, room: getPublicRoom(room) });
      io.to(room.id).emit('room_updated', getPublicRoom(room));
      console.log(`[Room] ${name} joined ${room.id}`);
    });

    socket.on('search_rooms', ({ query } = {}) => {
      const roomsFound = buildRoomSearchResults(query);
      socket.emit('rooms_found', { rooms: roomsFound });
    });

    // Host starts the game
    socket.on('start_game', ({ targetScore }) => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.hostId !== socket.id) return;
      if (room.players.length < 2) {
        socket.emit('error', { message: 'Se necesitan al menos 2 jugadores.' });
        return;
      }

      const requestedTargetScore = Number(targetScore);
      if (config.VALID_TARGET_SCORES.includes(requestedTargetScore)) {
        room.targetScore = requestedTargetScore;
      }

      gameFlow.dealInitialHands(room);
      room.phase = 'playing';
      io.to(room.id).emit('game_started', getPublicRoom(room));
      gameFlow.startRound(room);
    });

    // Judge places their setup card on the table (normal round only)
    socket.on('judge_play', ({ cardId, position, layout, judgePos, deckPos }) => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.phase !== 'judge_play') {
        socket.emit('error', { message: 'Esa jugada ya no es válida. Recargá si el juego no avanza.' });
        return;
      }

      const judge = room.players[room.judgeIndex];
      if (!judge || judge.id !== socket.id) {
        socket.emit('error', { message: 'No sos el juez en este momento.' });
        return;
      }

      const idx = judge.hand.indexOf(cardId);
      if (idx === -1) {
        socket.emit('error', { message: 'Esa carta ya no está en tu mano. Recargá la página para sincronizar.' });
        return;
      }
      judge.hand.splice(idx, 1);

      const deckEntry = room.table.find(entry => entry.playerId === 'deck');
      if (!deckEntry) return;

      const map = {
        '12': { judgePos: 1, deckPos: 2 },
        '13': { judgePos: 3, deckPos: 1 },
        '23': { judgePos: 3, deckPos: 2 },
        // Backward compatibility with old client payload values.
        before: { judgePos: 1, deckPos: 2 },
        after: { judgePos: 3, deckPos: 2 },
      };

      const judgePosNum = Number(judgePos);
      const deckPosNum = Number(deckPos);
      const hasExplicitPositions = judgePos !== undefined || deckPos !== undefined;

      let selected = null;
      const validJudgePos = Number.isInteger(judgePosNum) && judgePosNum >= 1 && judgePosNum <= 3;
      const validDeckPos = Number.isInteger(deckPosNum) && deckPosNum >= 1 && deckPosNum <= 3;
      if (validJudgePos && validDeckPos && judgePosNum !== deckPosNum) {
        selected = { judgePos: judgePosNum, deckPos: deckPosNum };
      } else if (hasExplicitPositions) {
        socket.emit('error', { message: 'No se pudo ubicar la carta del juez. Reintentá elegir posición.' });
        return;
      } else {
        selected = map[layout] || map[position] || map['12'];
      }

      deckEntry.position = selected.deckPos;
      room.table.push({ cardId, playerId: 'judge', position: selected.judgePos });

      // The judge places one card on the table and then plays a different card
      // from their hand as their actual submission in the next step.

      // Give judge a replacement card immediately so hand stays at 6 like everyone else
      if (room.deck.length > 0) {
        const replacementCard = room.deck.pop();
        judge.hand.push(replacementCard);
        cardRegistry.markCardsUsed([replacementCard]);
      }

      room.phase = 'player_play';
      io.to(room.id).emit('judge_played', getPublicRoom(room));
      // Only send replacement card to judge, others don't need a hand update
      gameFlow.sendPrivateHand(room, judge.id);
    });

    socket.on('activate_red_round', () => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      const result = gameFlow.activateRedRoundFromJudge(room, socket);
      if (!result.ok) socket.emit('error', { message: result.message });
    });

    socket.on('change_initial_card', (maybeAck) => {
      const ack = typeof maybeAck === 'function' ? maybeAck : null;
      const sendAck = (payload) => {
        if (ack) ack(payload);
      };

      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room) {
        sendAck({ ok: false, message: 'Sala no encontrada.' });
        return;
      }

      if (room.hostId !== socket.id) {
        socket.emit('error', { message: 'Solo el host puede cambiar la carta inicial.' });
        sendAck({ ok: false, message: 'Solo el host puede cambiar la carta inicial.' });
        return;
      }

      if (room.phase !== 'judge_play') {
        socket.emit('error', { message: 'Solo se puede cambiar en la colocacion inicial del juez.' });
        sendAck({ ok: false, message: 'Solo se puede cambiar en la colocacion inicial del juez.' });
        return;
      }

      const deckEntry = room.table.find(entry => entry.playerId === 'deck');
      if (!deckEntry) {
        socket.emit('error', { message: 'No hay carta inicial para cambiar.' });
        sendAck({ ok: false, message: 'No hay carta inicial para cambiar.' });
        return;
      }

      if (room.deck.length === 0) {
        socket.emit('error', { message: 'No quedan cartas en el mazo para reemplazar.' });
        sendAck({ ok: false, message: 'No quedan cartas en el mazo para reemplazar.' });
        return;
      }

      const previousCardId = deckEntry.cardId;
      const newCardId = room.deck.pop();
      deckEntry.cardId = newCardId;
      cardRegistry.markCardsUsed([newCardId]);

      io.to(room.id).emit('initial_card_changed', {
        room: getPublicRoom(room),
        previousCardId,
        newCardId,
      });
      sendAck({ ok: true, previousCardId, newCardId });
    });

    // Backward compatibility with previous client event.
    socket.on('confirm_red_card', ({ isRed }) => {
      if (!isRed) return;
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      const result = gameFlow.activateRedRoundFromJudge(room, socket);
      if (!result.ok) socket.emit('error', { message: result.message });
    });

    // Player submits their card
    socket.on('play_card', ({ cardId, cards, position }) => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.phase !== 'player_play') return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      if (room.isRedRound) {
        // Red round: player submits 2 cards [beforeCard, afterCard]
        if (!cards || cards.length !== 2) return;
        for (const cid of cards) {
          const i = player.hand.indexOf(cid);
          if (i === -1) return;
        }
        for (const cid of cards) {
          player.hand.splice(player.hand.indexOf(cid), 1);
        }
        room.submissions[socket.id] = { cards };
      } else {
        // Normal round: 1 card
        const posNum = Number(position);
        const hasPosition = Number.isInteger(posNum) && posNum >= 1 && posNum <= 3;
        const occupied = new Set((room.table || []).filter(e => e.position >= 1 && e.position <= 3).map(e => e.position));
        if (hasPosition && occupied.has(posNum)) return;

        const i = player.hand.indexOf(cardId);
        if (i === -1) return;
        player.hand.splice(i, 1);
        room.submissions[socket.id] = {
          cards: [cardId],
          position: hasPosition ? posNum : null,
        };
      }

      const submissions = Object.entries(room.submissions).map(([pid, data]) => ({
        playerId: pid,
        playerName: room.players.find(p => p.id === pid)?.name || 'Jugador',
        cards: data.cards,
        position: data.position,
      }));

      io.to(room.id).emit('player_submitted', {
        playerId: socket.id,
        room: getPublicRoom(room),
        submissions,
      });
      // Don't resend hand here — client already knows which card was played
      gameFlow.checkRoundEnd(room);
    });

    // All players vote for the best submission
    socket.on('cast_vote', ({ votedForId }) => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.phase !== 'voting') return;
      if (!room.submissions[votedForId]) return;     // must be a valid submission
      if (room.votes[socket.id]) return;             // already voted
      if (room.players.length >= 3 && votedForId === socket.id) {
        socket.emit('error', { message: 'Con 3 o más jugadores no podés votarte a vos mismo.' });
        return;
      }

      room.votes[socket.id] = votedForId;
      io.to(room.id).emit('vote_cast', {
        votedBy: socket.id,
        room: getPublicRoom(room),
      });
      gameFlow.checkVotingEnd(room);
    });

    // Host terminates the match early
    socket.on('terminate_match', async () => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.hostId !== socket.id) return;
      await gameFlow.terminateMatch(room);
    });

    // Advance to next round
    socket.on('next_round', () => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.phase !== 'round_result') return;
      if (rooms[roomId].hostId !== socket.id) return;
      gameFlow.startNextRoundFromResult(room);
    });

    socket.on('swap_cards', ({ cardIds }) => {
      const roomId = socket.data.roomId;
      const room = rooms[roomId];
      if (!room || room.phase !== 'deck_swap') return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      if (room.swapDone[socket.id]) return;

      if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 3) {
        socket.emit('error', { message: 'Debés descartar entre 1 y 3 cartas.' });
        return;
      }
      const unique = [...new Set(cardIds)];
      if (unique.length !== cardIds.length) {
        socket.emit('error', { message: 'Las cartas descartadas deben ser distintas.' });
        return;
      }
      for (const cid of unique) {
        if (!player.hand.includes(cid)) {
          socket.emit('error', { message: 'No podés descartar cartas que no están en tu mano.' });
          return;
        }
      }

      for (const cid of unique) {
        const i = player.hand.indexOf(cid);
        if (i !== -1) player.hand.splice(i, 1);
      }
      gameFlow.drawCards(room, socket.id, unique.length);

      room.swapDone[socket.id] = true;
      gameFlow.sendPrivateHand(room, socket.id);
      io.to(room.id).emit('deck_swap_progress', {
        room: getPublicRoom(room),
        doneIds: Object.keys(room.swapDone),
      });

      const allDone = room.players.every(p => room.swapDone[p.id]);
      if (allDone) {
        gameFlow.finishDeckSwap(room);
      }
    });

    socket.on('request_state_sync', ({ roomId }) => {
      const normalizedRoomId = normalizeRoomCode(roomId || socket.data.roomId);
      const room = rooms[normalizedRoomId];
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada o expirada.' });
        return;
      }
      const player = room.players.find(p => p.id === socket.id);
      if (!player) {
        socket.emit('error', { message: 'Tu sesión ya no está activa en esta sala.' });
        return;
      }
      socket.join(room.id);
      socket.data.roomId = room.id;
      socket.emit('state_sync', buildClientSnapshot(room, socket.id));
    });

    // Rejoin after disconnect
    socket.on('rejoin_game', ({ roomId, name }) => {
      const normalizedRoomId = normalizeRoomCode(roomId);
      const room = rooms[normalizedRoomId];
      if (!room) { socket.emit('error', { message: 'Sala no encontrada o expirada.' }); return; }

      const normalizedName = normalizePlayerName(name, '').trim();
      let player = normalizedName ? findPlayerByName(room, normalizedName) : null;

      // Host fallback: if name-based recovery fails, allow recovering the
      // currently disconnected host session by hostId.
      if (!player) {
        const hostPlayer = room.players.find(p => p.id === room.hostId);
        const disconnectedIds = room.disconnectedIds || [];
        const hostRecoverable = !!(
          hostPlayer && (
            disconnectedIds.includes(hostPlayer.id) ||
            hostPlayer._disconnectGraceTimer ||
            hostPlayer._disconnectTimer
          )
        );
        if (hostRecoverable) {
          player = hostPlayer;
          console.log(`[Reconnect] Host fallback matched for room ${room.id} (${hostPlayer.name})`);
        }
      }

      if (!player) {
        socket.emit('error', { message: 'No se encontró tu sesión. Si pasó mucho tiempo, volvé a entrar con código de sala.' });
        return;
      }

      const hadGrace = !!player._disconnectGraceTimer;
      if (player._disconnectGraceTimer) {
        clearTimeout(player._disconnectGraceTimer);
        delete player._disconnectGraceTimer;
      }
      // Cancel pending removal timeout
      if (player._disconnectTimer) { clearTimeout(player._disconnectTimer); delete player._disconnectTimer; }

      const oldId = player.id;
      player.id = socket.id;
      socket.join(room.id);
      socket.data.roomId = room.id;
      migratePlayerSocketInRoom(room, oldId, socket.id);
      if (hadGrace) {
        console.log(`[Reconnect] Recovered before timeout: ${player.name} (${oldId} -> ${socket.id}) in ${room.id}`);
      }
      const wasPaused = room.paused;
      if (!room.disconnectedIds.length) {
        room.paused = false;
        gameFlow.resumePausedRoom(room);
      }

      socket.emit('rejoined', buildClientSnapshot(room, socket.id));
      if (wasPaused && !room.paused) {
        io.to(room.id).emit('room_resumed', { room: getPublicRoom(room) });
      } else {
        io.to(room.id).emit('room_updated', getPublicRoom(room));
      }
      console.log(`[Rejoin] ${player.name} rejoined ${room.id}`);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`[-] Disconnected: ${socket.id}`);
      const roomId = socket.data.roomId;
      if (!roomId || !rooms[roomId]) return;

      const room = rooms[roomId];
      const player = room.players.find(p => p.id === socket.id);

      if (player) {
        if (player._disconnectGraceTimer) {
          clearTimeout(player._disconnectGraceTimer);
          delete player._disconnectGraceTimer;
        }
        if (player._disconnectTimer) {
          clearTimeout(player._disconnectTimer);
          delete player._disconnectTimer;
        }

        // Grace period to avoid false disconnect/pause for short mobile network hops.
        console.log(`[Reconnect] Grace started (${config.DISCONNECT_GRACE_MS}ms): ${player.name} (${socket.id}) in ${room.id}`);
        player._disconnectGraceTimer = setTimeout(() => {
          console.log(`[Disconnect] Confirmed after grace: ${player.name} (${socket.id}) in ${room.id}`);
          room.paused = true;
          room.disconnectedIds = Array.from(new Set([...(room.disconnectedIds || []), socket.id]));
          io.to(room.id).emit('room_paused', {
            room: getPublicRoom(room),
            message: 'La partida está en pausa hasta que todos vuelvan a conectarse.',
          });

          // Keep player for DISCONNECT_REMOVE_MS so they can reconnect
          player._disconnectTimer = setTimeout(() => {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
              delete rooms[roomId];
              console.log(`[Room] Deleted empty room: ${roomId}`);
            } else {
              room.disconnectedIds = (room.disconnectedIds || []).filter(id => id !== socket.id);
              if (!room.disconnectedIds.length) room.paused = false;
              if (room.hostId === socket.id) room.hostId = room.players[0].id;
              if (room.judgeIndex >= room.players.length) room.judgeIndex = 0;
              io.to(room.id).emit('room_updated', getPublicRoom(room));
              if (!room.paused) {
                gameFlow.resumePausedRoom(room);
                io.to(room.id).emit('room_resumed', { room: getPublicRoom(room) });
              }
            }
          }, config.DISCONNECT_REMOVE_MS);
        }, config.DISCONNECT_GRACE_MS);

        return;
      }

      io.to(room.id).emit('player_disconnected', { playerId: socket.id });
    });
  });
}

module.exports = { registerSocketHandlers };
