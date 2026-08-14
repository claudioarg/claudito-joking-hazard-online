/**
 * In-memory room state + pure helpers that don't need to emit socket events.
 */
const { shuffle } = require('./shuffle');

function createRoomStore({ config, cardRegistry }) {
  const rooms = {};

  function createRoom(targetScore = config.DEFAULT_TARGET_SCORE) {
    const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
    const deck = cardRegistry.buildDeckWithUsageAvoidance(shuffle);
    rooms[roomId] = {
      id: roomId,
      players: [],        // { id, name, score, hand }
      deck,
      table: [],          // card ids on the table
      submissions: {},    // { playerId: { cards: [] } }
      votes: {},          // { voterId: submissionPlayerId }
      judgeIndex: 0,
      phase: 'waiting',   // waiting | judge_play | player_play | voting | round_result | deck_swap | game_over
      paused: false,
      disconnectedIds: [],
      targetScore,
      isRedRound: false,
      roundWinnerId: null,
      roundWinnerIds: [],
      roundPoints: 1,
      roundPointsAssigned: false,
      tieRounds: 0,
      lastVoteCounts: null,
      lastRoundSubmissions: null,
      swapDone: {},
      pendingJoins: [],
      hostId: null,
      createdAt: Date.now(),
    };
    return roomId;
  }

  function getPublicRoom(room) {
    return {
      id: room.id,
      hostId: room.hostId,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        handCount: p.hand.length,
      })),
      judgeIndex: room.judgeIndex,
      phase: room.phase,
      paused: room.paused,
      disconnectedIds: room.disconnectedIds || [],
      table: room.table,
      isRedRound: room.isRedRound,
      roundWinnerId: room.roundWinnerId,
      roundWinnerIds: room.roundWinnerIds || (room.roundWinnerId ? [room.roundWinnerId] : []),
      roundPoints: room.roundPoints,
      targetScore: room.targetScore,
      submittedIds: Object.keys(room.submissions),
      votedIds: Object.keys(room.votes || {}),
      swapDoneIds: Object.keys(room.swapDone || {}),
      pendingJoinCount: (room.pendingJoins || []).length,
    };
  }

  function listPublicRooms() {
    return Object.values(rooms)
      .filter(room => room.phase === 'waiting')
      .map(room => {
        const host = room.players.find(p => p.id === room.hostId) || room.players[0];
        return {
          id: room.id,
          hostName: host ? host.name : 'Jugador',
          playerCount: room.players.length,
          createdAt: room.createdAt,
        };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function normalizePlayerName(name, fallback = 'Jugador') {
    const value = String(name || '').trim();
    return value || fallback;
  }

  function normalizeRoomCode(roomInput) {
    const raw = String(roomInput || '').trim();
    if (!raw) return '';

    // Accept full join URLs pasted by users.
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        const q = u.searchParams.get('room');
        if (q) return normalizeRoomCode(q);
      } catch {
        // fall through to regex parsing
      }
    }

    // Accept strings containing query params like ?room=ABCDE
    const match = raw.match(/[?&]room=([A-Za-z0-9]+)/i);
    if (match && match[1]) {
      return normalizeRoomCode(match[1]);
    }

    // Keep only alphanumeric room token and normalize case.
    return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  }

  function findPlayerByName(room, name) {
    const normalized = normalizePlayerName(name).toLowerCase();
    return room.players.find(p => String(p.name || '').trim().toLowerCase() === normalized);
  }

  function migratePlayerSocketInRoom(room, oldId, newId) {
    if (!room || !oldId || !newId || oldId === newId) return;

    if (room.submissions && room.submissions[oldId]) {
      room.submissions[newId] = room.submissions[oldId];
      delete room.submissions[oldId];
    }

    if (room.votes) {
      const migratedVotes = {};
      for (const [voterId, votedForId] of Object.entries(room.votes)) {
        const newVoterId = voterId === oldId ? newId : voterId;
        const newVotedForId = votedForId === oldId ? newId : votedForId;
        migratedVotes[newVoterId] = newVotedForId;
      }
      room.votes = migratedVotes;
    }

    if (room.swapDone && room.swapDone[oldId]) {
      room.swapDone[newId] = room.swapDone[oldId];
      delete room.swapDone[oldId];
    }

    room.disconnectedIds = (room.disconnectedIds || []).filter(id => id !== oldId);
    if (room.hostId === oldId) room.hostId = newId;
  }

  return {
    rooms,
    createRoom,
    getPublicRoom,
    listPublicRooms,
    normalizePlayerName,
    normalizeRoomCode,
    findPlayerByName,
    migratePlayerSocketInRoom,
  };
}

module.exports = { createRoomStore };
