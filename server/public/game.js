// === State ===
const socketUnavailable = typeof io !== 'function';
const socket = socketUnavailable
  ? { id: null, on() {}, emit() {} }
  : io();
let myId = null;
let myName = '';
let roomId = null;
let isHost = false;
let gameState = null;
let myHand = [];
let isJudge = false;
let selectedCard = null;          // card id selected from hand
let redSelectionBefore = null;    // card id for before slot (red round)
let redSelectionAfter = null;     // card id for after slot (red round)
let pendingAction = null;         // 'judge_place' | null
let myHasSubmitted = false;       // true after this player sends a card
let swapSelection = [];           // 1 to 3 cards to discard during deck_swap
let swapLocked = false;           // true after confirming swap in current deck_swap
let draggedJudgeCardId = null;    // current dragged card id during judge drag/drop
let draggedSourceType = null;     // 'hand' | 'deck' | null
let judgeDeckSlot = 2;            // temporary slot for first(deck) card during judge_play
let mouseDragState = null;        // state for custom desktop drag
let qrRoomCode = null;            // room code coming from /join?room=XXXX
let pendingJudgePlacement = null;
let judgePlacementPreview = null;
let initialCardChangePending = false;
let pauseRecoveryTimer = null;
let pauseRecoveryInFlight = false;

const POPUP_TUNER_STORAGE_KEY = 'jh_popup_tuner_v1';
const POPUP_TUNER_DEFAULTS = {
  desktop: {
    position: 0,
    confirm: 0,
    discard: 0,
  },
  mobile: {
    position: 100,
    confirm: 100,
    discard: 130,
  },
  preview: false,
};

function syncJudgeState(room = gameState) {
  if (!room?.players) {
    isJudge = false;
    return false;
  }
  const judge = room.players[room.judgeIndex];
  isJudge = !!(judge && judge.id === myId);
  return isJudge;
}

function resetRoundInteractionState() {
  selectedCard = null;
  redSelectionBefore = null;
  redSelectionAfter = null;
  pendingAction = null;
  swapSelection = [];
  swapLocked = false;
  draggedJudgeCardId = null;
  draggedSourceType = null;
  judgeDeckSlot = 2;
  mouseDragState = null;
  myHasSubmitted = false;
  judgePlacementPreview = null;
  pendingJudgePlacement = null;
}

function isLocalJudge() {
  const byRoom = !!(gameState?.players?.[gameState?.judgeIndex] && gameState.players[gameState.judgeIndex].id === myId);
  return byRoom || !!isJudge;
}

function clearJudgeCardSelectionUI() {
  document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.mesa-placeholder').forEach(p => p.classList.remove('active'));
}

function updateJudgeControls() {
  const deckButtons = [1, 2, 3].map(slot => $('btn-deck-slot-' + slot));
  const judgeButtons = [1, 2, 3].map(slot => $('btn-judge-slot-' + slot));
  const inJudgePhase = !!(gameState && gameState.phase === 'judge_play');
  const chosenJudgeCardId = draggedJudgeCardId || selectedCard;
  const enabled = !!inJudgePhase;

  if (deckButtons[0] && judgeButtons[0]) {
    deckButtons.forEach((btn, idx) => {
      const slot = idx + 1;
      btn.disabled = !enabled;
      btn.classList.toggle('active-slot', slot === judgeDeckSlot);
    });
    judgeButtons.forEach((btn, idx) => {
      const slot = idx + 1;
      btn.disabled = !enabled || !chosenJudgeCardId || slot === judgeDeckSlot;
    });
  }
}

function setJudgeDeckSlot(slot) {
  if (!gameState || gameState.phase !== 'judge_play') return;
  judgeDeckSlot = slot;
  draggedSourceType = null;
  clearJudgeCardSelectionUI();
  renderTableCards(gameState.table || []);
  updateJudgeControls();
}

function getJudgePlaceholderAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.closest) return null;
  return el.closest('.mesa-placeholder.drop-ready');
}

function beginMouseJudgeDrag(type, cardId, cardEl, startEvent) {
  if (!gameState || gameState.phase !== 'judge_play') return;
  if (startEvent.button !== 0) return;

  // For judge hand cards, use explicit button-based placement only.
  if (type === 'hand') {
    startEvent.preventDefault();
    draggedSourceType = null;
    draggedJudgeCardId = cardId;
    selectedCard = cardId;
    clearJudgeCardSelectionUI();
    if (cardEl) cardEl.classList.add('selected');
    show('judge-placement');
    updateJudgeControls();
    return;
  }

  startEvent.preventDefault();
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  let moved = false;
  clearJudgeCardSelectionUI();
  if (cardEl) cardEl.classList.add('selected');

  draggedSourceType = type;
  draggedJudgeCardId = type === 'hand' ? cardId : null;
  mouseDragState = { type, cardId };
  show('judge-placement');
  updateJudgeControls();

  const onMove = (ev) => {
    if (!moved) {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (dx > 4 || dy > 4) moved = true;
    }
    document.querySelectorAll('.mesa-placeholder.drop-ready').forEach(p => p.classList.remove('active'));
    const ph = getJudgePlaceholderAt(ev.clientX, ev.clientY);
    if (ph) ph.classList.add('active');
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    const ph = getJudgePlaceholderAt(ev.clientX, ev.clientY);
    if (!moved && mouseDragState?.type === 'hand') {
      // Treat click (without drag) as card selection for button-based placement.
      draggedSourceType = 'hand';
      draggedJudgeCardId = mouseDragState.cardId;
      selectedCard = mouseDragState.cardId;
      clearJudgeCardSelectionUI();
      if (cardEl) cardEl.classList.add('selected');
      show('judge-placement');
      updateJudgeControls();
    } else if (ph) {
      const slot = Number(ph.dataset.slot);
      if (mouseDragState?.type === 'deck') {
        judgeDeckSlot = slot;
        draggedSourceType = null;
        clearJudgeCardSelectionUI();
        renderTableCards(gameState?.table || []);
        updateJudgeControls();
      }
    } else {
      draggedSourceType = null;
      draggedJudgeCardId = null;
      clearJudgeCardSelectionUI();
      updateJudgeControls();
    }

    mouseDragState = null;
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function emitJudgePlacementForSlot(slot) {
  if (!gameState || gameState.phase !== 'judge_play') return;
  const chosenJudgeCardId = draggedJudgeCardId || selectedCard;
  if (!chosenJudgeCardId) {
    toast('Elegí una carta de tu mano primero.', true);
    return;
  }
  if (slot === judgeDeckSlot) {
    toast('Ese lugar ya está ocupado por la carta inicial. Elegí otro recuadro.', true);
    return;
  }

  const previewTable = [...(gameState.table || [])].map(entry => ({ ...entry }));
  const deckEntry = previewTable.find(entry => entry.playerId === 'deck');
  if (deckEntry) {
    deckEntry.position = judgeDeckSlot;
  }
  previewTable.push({ cardId: chosenJudgeCardId, playerId: 'judge', position: slot });

  pendingJudgePlacement = {
    previousGameState: gameState,
    previousMyHand: [...myHand],
    previousSelectedCard: selectedCard,
    previousJudgeDeckSlot: judgeDeckSlot,
    previousJudgePlacementPreview: judgePlacementPreview,
  };
  judgePlacementPreview = previewTable;

  gameState = {
    ...gameState,
    phase: 'player_play',
    table: previewTable,
  };
  myHand = myHand.filter(cardId => cardId !== chosenJudgeCardId);
  selectedCard = null;
  draggedJudgeCardId = null;
  draggedSourceType = null;
  clearJudgeCardSelectionUI();
  renderTableCards(previewTable);
  renderHand();
  updateJudgeControls();
  hide('judge-placement');
  $('status-bar').textContent = '🧩 Ubicación enviada. Esperando la siguiente fase...';

  socket.emit('judge_play', {
    cardId: chosenJudgeCardId,
    judgePos: slot,
    deckPos: judgeDeckSlot,
  });
}

// === DOM shortcuts ===
const $ = id => document.getElementById(id);
const on = (id, eventName, handler) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(eventName, handler);
};
const show = id => {
  const el = $(id);
  if (!el) return;
  el.classList.remove('hidden');
  el.style.display = '';
};
const hide = id => {
  const el = $(id);
  if (!el) return;
  el.classList.add('hidden');
  el.style.display = 'none';
};

function screen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const next = $(`screen-${name}`);
  if (next) next.classList.add('active');
  if (name === 'join') {
    startRoomListAutoRefresh();
  } else {
    stopRoomListAutoRefresh();
  }
}

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '') + ' show';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function readPopupTunerConfig() {
  try {
    const raw = localStorage.getItem(POPUP_TUNER_STORAGE_KEY);
    if (!raw) return { ...POPUP_TUNER_DEFAULTS };
    const parsed = JSON.parse(raw);

    const readMode = (modeName) => {
      const src = parsed?.[modeName] || {};
      const fallback = POPUP_TUNER_DEFAULTS[modeName];
      return {
        position: Number.isFinite(Number(src.position)) ? Number(src.position) : fallback.position,
        confirm: Number.isFinite(Number(src.confirm)) ? Number(src.confirm) : fallback.confirm,
        discard: Number.isFinite(Number(src.discard)) ? Number(src.discard) : fallback.discard,
      };
    };

    return {
      desktop: readMode('desktop'),
      mobile: readMode('mobile'),
      preview: !!parsed?.preview,
    };
  } catch {
    return JSON.parse(JSON.stringify(POPUP_TUNER_DEFAULTS));
  }
}

function writePopupTunerConfig(config) {
  localStorage.setItem(POPUP_TUNER_STORAGE_KEY, JSON.stringify(config));
}

function getPopupTunerMode() {
  return window.matchMedia('(max-width: 720px)').matches ? 'mobile' : 'desktop';
}

function applyPopupPreviewMode(enabled) {
  document.body.classList.toggle('popup-tuner-preview', !!enabled);
  const previewText = $('confirm-preview');
  if (previewText && enabled && !previewText.textContent.trim()) {
    previewText.textContent = 'Vista previa confirmacion';
  }
  if (previewText && !enabled && previewText.textContent === 'Vista previa confirmacion') {
    previewText.textContent = '';
  }
  const previewBtn = $('btn-toggle-popup-preview');
  if (previewBtn) {
    previewBtn.textContent = `Vista previa: ${enabled ? 'ON' : 'OFF'}`;
  }
}

function applyPopupTunerConfig(config) {
  const mode = getPopupTunerMode();
  const modeValues = config?.[mode] || POPUP_TUNER_DEFAULTS[mode];
  const root = document.documentElement;
  root.style.setProperty('--popup-position-offset-y', String(modeValues.position));
  root.style.setProperty('--popup-judge-lift-mobile', String(modeValues.position));
  root.style.setProperty('--popup-confirm-offset-y', String(modeValues.confirm));
  root.style.setProperty('--popup-discard-offset-y', String(modeValues.discard));

  // Direct inline transforms as a robust fallback in case CSS vars are overridden.
  const judgePlacement = $('judge-placement');
  const confirmBar = $('confirm-bar');
  const discardPanel = $('deck-swap-panel');
  if (judgePlacement) judgePlacement.style.transform = `translateY(${-Number(modeValues.position)}px)`;
  if (confirmBar) confirmBar.style.transform = `translateY(${-Number(modeValues.confirm)}px)`;
  if (discardPanel) discardPanel.style.transform = `translateY(${-Number(modeValues.discard)}px)`;

  const modeLabel = $('overlay-tuner-mode');
  if (modeLabel) modeLabel.textContent = `Modo: ${mode}`;

  const vPosition = $('value-popup-position');
  const vConfirm = $('value-popup-confirm');
  const vDiscard = $('value-popup-discard');
  if (vPosition) vPosition.textContent = String(modeValues.position);
  if (vConfirm) vConfirm.textContent = String(modeValues.confirm);
  if (vDiscard) vDiscard.textContent = String(modeValues.discard);

  const sPosition = $('slider-popup-position');
  const sConfirm = $('slider-popup-confirm');
  const sDiscard = $('slider-popup-discard');
  if (sPosition) sPosition.value = String(modeValues.position);
  if (sConfirm) sConfirm.value = String(modeValues.confirm);
  if (sDiscard) sDiscard.value = String(modeValues.discard);

  applyPopupPreviewMode(!!config.preview);
}

function initPopupTuner() {
  let config = readPopupTunerConfig();
  applyPopupTunerConfig(config);

  window.addEventListener('resize', () => {
    applyPopupTunerConfig(config);
  });

  const toggleBtn = $('btn-toggle-overlay-tuner');
  const panel = $('overlay-tuner-panel');
  const resetBtn = $('btn-reset-overlay-tuner');
  const sPosition = $('slider-popup-position');
  const sConfirm = $('slider-popup-confirm');
  const sDiscard = $('slider-popup-discard');

  if (!toggleBtn || !panel || !resetBtn || !sPosition || !sConfirm || !sDiscard) return;

  const bindSlider = (sliderEl, key) => {
    const applyFromSlider = () => {
      const mode = getPopupTunerMode();
      config = {
        ...config,
        [mode]: {
          ...config[mode],
          [key]: Number(sliderEl.value),
        },
      };
      applyPopupTunerConfig(config);
      writePopupTunerConfig(config);
    };
    sliderEl.addEventListener('input', applyFromSlider);
    sliderEl.addEventListener('change', applyFromSlider);
  };

  bindSlider(sPosition, 'position');
  bindSlider(sConfirm, 'confirm');
  bindSlider(sDiscard, 'discard');

  const bindStep = (decId, incId, sliderEl, key) => {
    const min = Number(sliderEl.min || -80);
    const max = Number(sliderEl.max || 180);
    const step = Number(sliderEl.step || 1);

    const applyStep = (delta) => {
      const next = Math.max(min, Math.min(max, Number(sliderEl.value) + delta));
      sliderEl.value = String(next);
      const mode = getPopupTunerMode();
      config = {
        ...config,
        [mode]: {
          ...config[mode],
          [key]: next,
        },
      };
      applyPopupTunerConfig(config);
      writePopupTunerConfig(config);
    };

    on(decId, 'click', () => applyStep(-step));
    on(incId, 'click', () => applyStep(step));
  };

  bindStep('btn-popup-position-dec', 'btn-popup-position-inc', sPosition, 'position');
  bindStep('btn-popup-confirm-dec', 'btn-popup-confirm-inc', sConfirm, 'confirm');
  bindStep('btn-popup-discard-dec', 'btn-popup-discard-inc', sDiscard, 'discard');

  on('btn-toggle-popup-preview', 'click', () => {
    config = {
      ...config,
      preview: !config.preview,
    };
    applyPopupTunerConfig(config);
    writePopupTunerConfig(config);
  });

  on('btn-toggle-overlay-tuner', 'click', () => {
    panel.classList.toggle('hidden');
    applyPopupTunerConfig(config);
  });

  on('btn-reset-overlay-tuner', 'click', () => {
    config = JSON.parse(JSON.stringify(POPUP_TUNER_DEFAULTS));
    applyPopupTunerConfig(config);
    writePopupTunerConfig(config);
    toast('Ajustes de emergentes reseteados.');
  });
}

function ensureConfirmBarVisible() {
  const bar = $('confirm-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  if (!window.matchMedia('(max-width: 720px)').matches) return;
  requestAnimationFrame(() => {
    bar.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
}

function getStoredSession() {
  try {
    const raw = sessionStorage.getItem('jh_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.roomId || !parsed.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setStoredSession(data) {
  if (!data?.roomId || !data?.name) return;
  sessionStorage.setItem('jh_session', JSON.stringify({ roomId: data.roomId, name: data.name }));
}

function clearStoredSession() {
  sessionStorage.removeItem('jh_session');
}

function maybeAutoRejoin() {
  if (socketUnavailable) return;
  const stored = getStoredSession();
  if (!stored) return;

  const urlRoom = new URLSearchParams(window.location.search).get('room');
  if (urlRoom && stored.roomId.toUpperCase() !== String(urlRoom).toUpperCase()) {
    return;
  }

  socket.emit('rejoin_game', stored);
}

function requestStateSync() {
  if (socketUnavailable || !socket.id) return;
  const activeRoomId = roomId || gameState?.id || getStoredSession()?.roomId;
  if (!activeRoomId) return;
  socket.emit('request_state_sync', { roomId: activeRoomId });
}

function updatePauseBanner(room, message) {
  const textEl = $('pause-text');
  if (!textEl) return;

  const disconnected = new Set(room?.disconnectedIds || []);
  const missingNames = (room?.players || [])
    .filter(p => disconnected.has(p.id))
    .map(p => p.name);

  let detail = '';
  if (missingNames.length > 0) {
    detail = ` Falta reconectar: ${missingNames.join(', ')}.`;
  }

  textEl.textContent = `${message || 'La partida está en pausa hasta que todos vuelvan a conectarse.'}${detail}`;
}

function triggerPauseRecoveryAttempt() {
  if (pauseRecoveryInFlight) return;
  if (socketUnavailable) return;
  if (!gameState?.paused) return;

  pauseRecoveryInFlight = true;
  const stored = getStoredSession();
  if (stored?.roomId && stored?.name) {
    socket.emit('rejoin_game', { roomId: stored.roomId, name: stored.name });
  }
  requestStateSync();
  setTimeout(() => {
    pauseRecoveryInFlight = false;
  }, 1200);
}

function startPauseRecovery() {
  if (pauseRecoveryTimer) return;
  pauseRecoveryTimer = setInterval(() => {
    triggerPauseRecoveryAttempt();
  }, 3000);
}

function stopPauseRecovery() {
  if (!pauseRecoveryTimer) return;
  clearInterval(pauseRecoveryTimer);
  pauseRecoveryTimer = null;
  pauseRecoveryInFlight = false;
}

function renderRoundResultView({ winnerId, winnerName, winnerIds, winnerNames, tied, points, voteCounts, submissions, room }) {
  gameState = room;
  syncJudgeState(room);
  setVotingLayout(false);
  hide('deck-swap-panel');
  const names = winnerNames && winnerNames.length ? winnerNames : [winnerName];
  const iAmWinner = (winnerIds && winnerIds.includes(myId)) || winnerId === myId;
  const winner = (submissions || []).find(s => s.playerId === winnerId);

  if (tied) {
    $('result-title').textContent = `🤝 Empate: ${names.join(' y ')} (+${points} c/u)`;
  } else {
    $('result-title').textContent = iAmWinner
      ? `🎉 ¡Ganaste esta ronda! +${points} punto${points > 1 ? 's' : ''}`
      : `🏅 Ganó: ${winnerName} (+${points})`;
  }

  const storyEl = $('result-story');
  storyEl.innerHTML = '';
  if (winner) {
    const mesaEntries = normalizeMesaEntries(room.table || [], 2);
    const storyCards = composeStoryCards(mesaEntries, winner);
    storyCards.forEach(cardId => {
      const card = cardEl(cardId);
      const img = card.querySelector('img');
      card.style.width = '100px';
      if (img) img.style.width = '100px';
      storyEl.appendChild(card);
    });
  }

  renderResultScores(room.players, voteCounts, submissions);
  hide('judge-point-controls');
  $('result-waiting').textContent = room.phase === 'game_over' ? '' : 'Pasando a MAZO...';
  show('result-waiting');
  hide('btn-next-round');
  screen('result');
}

function applyRoomSnapshot({ room, hand, isJudge: judge, phaseData }, { announceRejoin = false } = {}) {
  if (!room) return;

  roomId = room.id;
  gameState = room;
  myHand = Array.isArray(hand) ? hand : myHand;
  isJudge = !!judge;
  isHost = room.hostId === myId;
  syncJudgeState(room);
  resetRoundInteractionState();
  updateTerminateButton();

  if (room.phase === 'waiting') {
    $('lobby-room-id').textContent = room.id;
    renderLobbyPlayers(room.players);
    if (isHost) {
      show('lobby-settings-host');
      show('btn-start-game');
      hide('lobby-waiting-msg');
    } else {
      hide('lobby-settings-host');
      hide('btn-start-game');
      $('lobby-waiting-msg').textContent = 'Esperando que el host inicie el juego...';
      show('lobby-waiting-msg');
    }
    screen('lobby');
    if (announceRejoin) toast('Reconectado a la sala');
    return;
  }

  if (room.paused) {
    $('pause-text').textContent = 'La partida está en pausa hasta que todos vuelvan a conectarse.';
    show('pause-banner');
  } else {
    hide('pause-banner');
  }

  if (room.phase === 'round_result' && phaseData) {
    renderRoundResultView({ ...phaseData, room });
    if (announceRejoin) toast('Reconectado a la partida');
    return;
  }

  screen('game');
  setVotingLayout(room.phase === 'voting');
  renderScoreBar();
  renderTableCards(room.table || []);
  renderHand();
  updateDeckSwapPanel();
  updateJudgeControls();

  if (room.phase === 'voting') {
    hide('deck-swap-panel');
    hide('judge-placement');
    hide('confirm-bar');
    hide('red-slot-chooser');
    $('submissions-label').textContent = '🗳️ Jugadas — tocá la que preferís';
    show('submissions-area');
    renderVotingSubmissions(phaseData?.shuffledSubmissions || [], room.table);
    $('status-bar').textContent = 'Elegí la mejor historia (tocá una)';
  } else {
    hide('submissions-area');
    $('submissions-list').innerHTML = '';
    updateStatus(room);
    if (room.phase === 'judge_play' && isJudge) {
      show('judge-placement');
    }
  }

  if (announceRejoin) toast('Reconectado a la partida');
}

// === Init ===
socket.on('connect', () => {
  myId = socket.id;
  maybeAutoRejoin();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) requestStateSync();
});
window.addEventListener('focus', requestStateSync);
window.addEventListener('online', requestStateSync);

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    initPopupTuner();
  });
} else {
  initPopupTuner();
}

// Check if joined via QR link
window.addEventListener('DOMContentLoaded', () => {
  if (socketUnavailable) {
    window.alert('No se pudo cargar la conexión en tiempo real. Recargá la página.');
  }
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) {
    const code = room.toUpperCase();
    qrRoomCode = code;
    $('join-room-code').value = code;
    $('join-room-code').style.display = 'none';
    $('join-room-display').textContent = code;
    $('join-room-display').classList.remove('hidden');
    startRoomListAutoRefresh();
    setTimeout(() => $('join-player-name').focus(), 100);
  } else {
    screen('home');
  }
});

// === Home screen ===
const btnCreate = $('btn-create');
if (btnCreate) {
  btnCreate.addEventListener('click', () => {
    myName = $('player-name').value.trim() || 'Jugador 1';
    socket.emit('create_room', { name: myName, targetScore: 3 });
  });
}

function renderRoomList(rooms) {
  const el = $('room-list');
  if (!el) {
    console.warn('[room-list] #room-list not found');
    return;
  }
  el.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    el.innerHTML = '<p class="muted">No hay partidas disponibles en este momento.</p>';
    return;
  }
  rooms.forEach(room => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.innerHTML = `
      <div class="room-item-info">
        <span class="room-item-code">${room.id}</span>
        <span class="room-item-meta">Partida creada por ${room.hostName}</span>
      </div>
      <span class="room-item-players">${room.playerCount} / 8</span>
    `;
    item.addEventListener('click', () => {
      $('join-room-code').value = room.id;
      $('join-player-name').focus();
    });
    el.appendChild(item);
  });
}

let roomListInterval = null;

function startRoomListAutoRefresh() {
  stopRoomListAutoRefresh();
  requestRoomList();
  roomListInterval = setInterval(requestRoomList, 3000);
}

function stopRoomListAutoRefresh() {
  if (roomListInterval) {
    clearInterval(roomListInterval);
    roomListInterval = null;
  }
}

function requestRoomList() {
  if (socketUnavailable) return;
  if (socket.connected) {
    console.log('[room-list] requestRoomList connected, emitting list_rooms');
    socket.emit('list_rooms');
  } else {
    console.log('[room-list] requestRoomList waiting for connect');
    socket.once('connect', () => socket.emit('list_rooms'));
  }
}

socket.on('rooms_list', (rooms) => {
  console.log('[room-list] rooms_list received', rooms);
  renderRoomList(rooms);
});

const btnRefreshRooms = $('btn-refresh-rooms');
if (btnRefreshRooms) {
  btnRefreshRooms.addEventListener('click', () => {
    requestRoomList();
  });
}

const btnJoinOpen = $('btn-join-open');
if (btnJoinOpen) {
  btnJoinOpen.addEventListener('click', () => {
    screen('join');
  });
}

const btnBackHome = $('btn-back-home');
if (btnBackHome) {
  btnBackHome.addEventListener('click', () => {
    stopRoomListAutoRefresh();
    screen('home');
  });
}

function submitJoinRoom() {
  myName = $('join-player-name').value.trim() || $('player-name').value.trim() || 'Jugador';
  const raw = $('join-room-code').value.trim() || qrRoomCode || '';
  const code = raw
    .replace(/[?&]room=([A-Za-z0-9]+)/i, '$1')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8);
  if (!code) { toast('Ingresá el código de sala', true); return; }
  qrRoomCode = code;
  socket.emit('join_room', { roomId: code, name: myName });
}

const btnJoinConfirm = $('btn-join-confirm');
if (btnJoinConfirm) {
  btnJoinConfirm.addEventListener('click', submitJoinRoom);
}

const joinPlayerNameInput = $('join-player-name');
if (joinPlayerNameInput) {
  joinPlayerNameInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    submitJoinRoom();
  });
}

// === Lobby ===
socket.on('room_created', ({ roomId: rid, joinUrl, qrDataUrl, room }) => {
  stopRoomListAutoRefresh();
  roomId = rid;
  isHost = true;
  myName = myName || $('player-name').value.trim() || 'Host';
  setStoredSession({ roomId: rid, name: myName });
  $('lobby-room-id').textContent = rid;
  $('qr-image').src = qrDataUrl;
  $('join-url').textContent = joinUrl;
  renderLobbyPlayers(room.players);
  show('lobby-settings-host');
  show('btn-start-game');
  hide('lobby-waiting-msg');
  updateTerminateButton();
  screen('lobby');
});

socket.on('room_joined', ({ roomId: rid, room }) => {
  stopRoomListAutoRefresh();
  roomId = rid;
  isHost = room.hostId === myId;
  setStoredSession({ roomId: rid, name: myName });
  $('lobby-room-id').textContent = rid;
  hide('qr-image');
  hide('join-url');
  $('qr-image').parentElement.style.display = 'none';
  renderLobbyPlayers(room.players);
  hide('lobby-settings-host');
  hide('btn-start-game');
  $('lobby-waiting-msg').textContent = 'Esperando que el host inicie el juego...';
  show('lobby-waiting-msg');
  updateTerminateButton();
  screen('lobby');
});

socket.on('room_updated', (room) => {
  if (room && room.hostId) {
    isHost = room.hostId === myId;
    updateTerminateButton();
  }
  if (gameState) {
    gameState = room;
    renderScoreBar();
  }
  renderLobbyPlayers(room.players);
});

socket.on('join_queued', ({ room, message }) => {
  roomId = room.id;
  gameState = room;
  isHost = room.hostId === myId;
  isJudge = false;
  myHand = [];
  myHasSubmitted = true;
  setStoredSession({ roomId: room.id, name: myName });

  screen('game');
  setVotingLayout(room.phase === 'voting');
  renderScoreBar();
  renderTableCards(room.table || []);
  renderHand();
  hide('judge-placement');
  hide('confirm-bar');
  hide('red-slot-chooser');
  hide('red-round-info');
  updateTerminateButton();

  $('status-bar').textContent = message || 'Te uniste en cola. Entrás cuando termine la ronda actual.';
  toast('Listo: te sumás al finalizar la ronda');
});

function renderLobbyPlayers(players) {
  const list = $('lobby-players');
  list.innerHTML = players.map(p => `
    <div class="player-item">
      <div class="player-avatar">${p.name.charAt(0).toUpperCase()}</div>
      <span>${p.name}${p.id === myId ? ' (vos)' : ''}</span>
    </div>
  `).join('');
}

function updateTerminateButton() {
  const terminateBtn = $('btn-terminate-match');
  const changeCardBtn = $('btn-change-initial-card');
  const canChangeInitialCard = !!(isHost && gameState && gameState.phase === 'judge_play');

  if (terminateBtn) {
    if (isHost) show('btn-terminate-match');
    else hide('btn-terminate-match');
  }

  if (changeCardBtn) {
    if (canChangeInitialCard) show('btn-change-initial-card');
    else hide('btn-change-initial-card');
    changeCardBtn.disabled = !canChangeInitialCard || initialCardChangePending;
  }
}

function setVotingLayout(isVoting) {
  const tableArea = $('table-area');
  const handArea = $('hand-area');
  const gameLayout = $('game-layout');
  if (gameLayout) {
    gameLayout.classList.toggle('voting-mode', !!isVoting);
  }
  if (tableArea) tableArea.style.display = isVoting ? 'none' : '';
  if (handArea) handArea.style.display = isVoting ? 'none' : '';
}

function updateDeckSwapPanel() {
  const panel = $('deck-swap-panel');
  const btn = $('btn-confirm-swap');
  if (!panel || !btn) return;
  const active = !!(gameState && gameState.phase === 'deck_swap');
  if (active) show('deck-swap-panel');
  else hide('deck-swap-panel');
  if (!active) {
    btn.disabled = true;
    return;
  }
  btn.disabled = swapLocked || swapSelection.length < 1;
  const n = swapSelection.length;
  btn.textContent = n > 0 ? `Descartar ${n} y Robar ${n}` : 'Descartar y Robar';
}

function updateRedSlotChooser() {
  const chooser = $('red-slot-chooser');
  if (!chooser) return;
  const active = !!(gameState && gameState.phase === 'player_play' && gameState.isRedRound && !myHasSubmitted && selectedCard);
  if (active) show('red-slot-chooser');
  else hide('red-slot-chooser');
}

on('btn-start-game', 'click', () => {
  const targetScore = parseInt($('target-score-select').value);
  socket.emit('start_game', { targetScore });
});

// Rejoin after page refresh
socket.on('rejoined', (snapshot) => {
  applyRoomSnapshot(snapshot, { announceRejoin: true });
});

socket.on('state_sync', (snapshot) => {
  applyRoomSnapshot(snapshot);
});

socket.on('player_disconnected', ({ playerId }) => {
  if (gameState) {
    const p = gameState.players.find(p => p.id === playerId);
    if (p) toast(`${p.name} se desconectó (60s para reconectarse)`);
  }
});

socket.on('room_paused', ({ room, message }) => {
  gameState = room;
  isHost = room.hostId === myId;
  updatePauseBanner(room, message);
  show('pause-banner');
  updateTerminateButton();
  $('status-bar').textContent = '⏸️ Partida en pausa';
  renderScoreBar();
  startPauseRecovery();
});

socket.on('room_resumed', ({ room }) => {
  gameState = room;
  isHost = room.hostId === myId;
  stopPauseRecovery();
  updateTerminateButton();
  setVotingLayout(room.phase === 'voting');
  hide('pause-banner');
  updateStatus(room);
  renderScoreBar();
  requestStateSync();
});

socket.on('match_terminated', ({ players }) => {
  stopPauseRecovery();
  clearStoredSession();
  roomId = null;
  gameState = null;
  isHost = false;
  $('gameover-winner').textContent = '🏁 La partida fue terminada por el host';
  const scoresEl = $('gameover-scores');
  const sorted = [...players].sort((a, b) => b.score - a.score);
  scoresEl.innerHTML = sorted.map(p => `
    <div class="score-row ${p.id === myId ? 'winner' : ''}">
      <span>${p.name}</span>
      <span class="pts">${p.score} pts</span>
    </div>
  `).join('');
  hide('pause-banner');
  screen('gameover');
});

// === Game started ===
socket.on('game_started', (room) => {
  gameState = room;
  isHost = room.hostId === myId;
  syncJudgeState(room);
  resetRoundInteractionState();
  updateTerminateButton();
  setVotingLayout(false);
  screen('game');
  renderScoreBar();
  $('status-bar').textContent = 'El juego comenzó. ¡Buena suerte!';
});

socket.on('round_started', (room) => {
  gameState = room;
  screen('game');
  isHost = room.hostId === myId;
  syncJudgeState(room);
  resetRoundInteractionState();
  updateTerminateButton();
  setVotingLayout(false);

  hide('judge-placement');
  hide('confirm-bar');
  hide('red-slot-chooser');
  hide('red-round-info');
  hide('deck-swap-panel');
  hide('submissions-area');
  $('submissions-list').innerHTML = '';

  renderScoreBar();
  renderTableCards(room.table);
  $('hand-cards').innerHTML = '';

  updateDeckSwapPanel();
  updateJudgeControls();
  updateStatus(room);
});

socket.on('round_phase_updated', (room) => {
  gameState = room;
  syncJudgeState(room);
  screen('game');
  setVotingLayout(false);
  if (room.phase !== 'judge_play') {
    hide('judge-placement');
  }
  renderScoreBar();
  renderTableCards(room.table);
  renderHand();
  updateDeckSwapPanel();
  updateJudgeControls();
  updateStatus(room);
});

socket.on('your_hand', ({ hand, isJudge: judge }) => {
  myHand = hand;
  if (typeof judge === 'boolean') {
    isJudge = judge;
  } else {
    syncJudgeState(gameState);
  }
  swapSelection = swapSelection.filter(cid => myHand.includes(cid));
  renderHand();
  if (!myHasSubmitted) {
    $('hand-cards').querySelectorAll('.game-card').forEach(c => {
      c.style.opacity = '1';
      c.style.pointerEvents = 'auto';
    });
  }
  if (gameState && gameState.phase === 'judge_play' && isLocalJudge()) {
    show('judge-placement');
  } else {
    hide('judge-placement');
  }
  updateDeckSwapPanel();
  updateJudgeControls();
  if (myHasSubmitted) return;
  if (!selectedCard) {
    updateActionUI();
  } else {
    const el = document.querySelector(`#hand-cards .game-card[data-card-id="${selectedCard}"]`);
    if (el) el.classList.add('selected');
    updateRedSlotChooser();
  }
});

socket.on('judge_played', (room) => {
  pendingJudgePlacement = null;
  judgePlacementPreview = null;
  gameState = room;
  syncJudgeState(room);
  isHost = room.hostId === myId;
  updateTerminateButton();
  setVotingLayout(false);
  draggedJudgeCardId = null;
  draggedSourceType = null;
  renderTableCards(room.table);
  renderScoreBar();
  hide('judge-placement');
  updateDeckSwapPanel();
  updateJudgeControls();
  updateStatus(room);
});

socket.on('initial_card_changed', ({ room, previousCardId, newCardId }) => {
  initialCardChangePending = false;
  gameState = room;
  syncJudgeState(room);
  isHost = room.hostId === myId;
  renderTableCards(room.table);
  updateDeckSwapPanel();
  updateJudgeControls();
  updateTerminateButton();
  updateStatus(room);

  if (Number.isInteger(previousCardId) && Number.isInteger(newCardId)) {
    toast(`Carta inicial cambiada: ${previousCardId} -> ${newCardId}`);
  } else {
    toast('Carta inicial cambiada.');
  }
});

socket.on('player_submitted', ({ playerId, room, submissions }) => {
  gameState = room;
  screen('game');
  setVotingLayout(false);
  hide('judge-placement');
  const count = room.submittedIds.length;
  const total = room.players.length;

  // Lock MY hand if I'm the one who just submitted
  if (playerId === myId) {
    myHasSubmitted = true;
    $('hand-cards').querySelectorAll('.game-card').forEach(c => {
      c.style.opacity = '0.3';
      c.style.pointerEvents = 'none';
    });
    hide('confirm-bar');
    hide('red-slot-chooser');
    selectedCard = null;
  }

  // Before voting, do not reveal plays; only show progress.
  hide('submissions-area');
  $('status-bar').textContent = `Jugadas recibidas: ${count} / ${total}`;
});

socket.on('voting_phase', ({ shuffledSubmissions, tieMessage, tied, ...room }) => {
  gameState = room;
  syncJudgeState(room);
  screen('game');
  setVotingLayout(true);
  hide('judge-placement');
  hide('deck-swap-panel');
  renderScoreBar();
  hide('red-round-info');
  hide('confirm-bar');
  $('submissions-label').textContent = tied ? '🔁 Empate — votá otra vez' : '🗳️ Jugadas — tocá la que preferís';
  show('submissions-area');
  renderVotingSubmissions(shuffledSubmissions, room.table);
  $('status-bar').textContent = tieMessage || 'Elegí la mejor historia (tocá una)';
});

socket.on('vote_cast', ({ votedBy, room }) => {
  gameState = room;
  const count = room.votedIds ? room.votedIds.length : 0;
  if (votedBy !== myId) {
    $('status-bar').textContent = `Votos: ${count} / ${room.players.length}`;
  }
});

socket.on('round_result', ({ winnerId, winnerName, winnerIds, winnerNames, tied, points, voteCounts, submissions, room }) => {
  hide('judge-placement');
  renderRoundResultView({ winnerId, winnerName, winnerIds, winnerNames, tied, points, voteCounts, submissions, room });
});

socket.on('game_over', ({ winner, players }) => {
  stopPauseRecovery();
  setVotingLayout(false);
  hide('judge-placement');
  hide('deck-swap-panel');
  clearStoredSession();
  $('gameover-winner').textContent = `🏆 Ganó: ${winner}`;
  const scoresEl = $('gameover-scores');
  const sorted = [...players].sort((a, b) => b.score - a.score);
  scoresEl.innerHTML = sorted.map(p => `
    <div class="score-row ${p.id === myId ? 'winner' : ''}">
      <span>${p.name}</span>
      <span class="pts">${p.score} pts</span>
    </div>
  `).join('');
  screen('gameover');
});

socket.on('error', ({ message }) => {
  if (message === 'Sala no encontrada o expirada.' || message === 'No se encontró tu sesión.' || message === 'Tu sesión ya no está activa en esta sala.') {
    clearStoredSession();
  }
  if (pendingJudgePlacement) {
    gameState = pendingJudgePlacement.previousGameState;
    myHand = pendingJudgePlacement.previousMyHand;
    selectedCard = pendingJudgePlacement.previousSelectedCard;
    judgeDeckSlot = pendingJudgePlacement.previousJudgeDeckSlot;
    judgePlacementPreview = pendingJudgePlacement.previousJudgePlacementPreview;
    pendingJudgePlacement = null;
    renderHand();
    renderTableCards(gameState?.table || []);
    updateJudgeControls();
    if (gameState?.phase === 'judge_play' && isLocalJudge()) show('judge-placement');
  }
  toast(message, true);
});

on('btn-retry-sync', 'click', () => {
  triggerPauseRecoveryAttempt();
  toast('Reintentando conexion...');
});

socket.on('deck_swap_started', (room) => {
  gameState = room;
  screen('game');
  syncJudgeState(room);
  setVotingLayout(false);
  resetRoundInteractionState();
  hide('submissions-area');
  hide('judge-placement');
  hide('confirm-bar');
  hide('red-round-info');
  renderScoreBar();
  renderTableCards(room.table);
  updateDeckSwapPanel();
  updateStatus(room);
  $('status-bar').textContent = '🃏 MAZO: descartá entre 1 y 3 cartas de tu mano para continuar';
});

socket.on('deck_swap_progress', ({ room, doneIds }) => {
  gameState = room;
  const done = (doneIds || []).length;
  const total = room.players.length;
  $('status-bar').textContent = `🃏 MAZO: ${done} / ${total} jugadores ya descartaron`;
});

// === Next round ===
on('btn-next-round', 'click', () => {
  // Auto-advance is handled by server after voting result.
});

on('btn-terminate-match', 'click', () => {
  const ok = window.confirm('¿Seguro que querés terminar la partida?');
  if (!ok) return;
  socket.emit('terminate_match');
});

function requestInitialCardChange() {
  if (!isHost) return;
  if (!gameState || gameState.phase !== 'judge_play') {
    toast('Solo se puede cambiar la carta durante la colocacion inicial del juez.', true);
    return;
  }
  if (initialCardChangePending) return;
  const ok = window.confirm('¿Cambiar la carta inicial de mesa por otra del mazo?');
  if (!ok) return;

  initialCardChangePending = true;
  updateTerminateButton();
  toast('Cambiando carta inicial...');

  const releasePendingTimer = setTimeout(() => {
    initialCardChangePending = false;
    updateTerminateButton();
  }, 3000);

  socket.emit('change_initial_card', (result) => {
    clearTimeout(releasePendingTimer);
    initialCardChangePending = false;
    updateTerminateButton();

    if (!result) return;

    if (result.ok) {
      // Fallback: if broadcast arrives late/lost for this client, update host view from ack.
      if (gameState && Array.isArray(gameState.table) && Number.isInteger(result.newCardId)) {
        const deckEntry = gameState.table.find(entry => entry.playerId === 'deck');
        if (deckEntry) deckEntry.cardId = result.newCardId;
        renderTableCards(gameState.table);
      }
      return;
    }

    if (result.message) toast(result.message, true);
  });
}

const bindTouchFriendlyButton = (id, handler) => {
  const el = $(id);
  if (!el) return;
  ['click', 'pointerup', 'touchend'].forEach(eventName => {
    el.addEventListener(eventName, (ev) => {
      if (eventName === 'pointerup' || eventName === 'touchend') {
        ev.preventDefault();
      }
      handler(ev);
    });
  });
};

bindTouchFriendlyButton('btn-deck-slot-1', () => setJudgeDeckSlot(1));
bindTouchFriendlyButton('btn-deck-slot-2', () => setJudgeDeckSlot(2));
bindTouchFriendlyButton('btn-deck-slot-3', () => setJudgeDeckSlot(3));
bindTouchFriendlyButton('btn-judge-slot-1', () => emitJudgePlacementForSlot(1));
bindTouchFriendlyButton('btn-judge-slot-2', () => emitJudgePlacementForSlot(2));
bindTouchFriendlyButton('btn-judge-slot-3', () => emitJudgePlacementForSlot(3));
bindTouchFriendlyButton('btn-change-initial-card', () => requestInitialCardChange());

on('btn-confirm-swap', 'click', () => {
  if (!gameState || gameState.phase !== 'deck_swap') return;
  if (swapSelection.length < 1 || swapSelection.length > 3) return;
  swapLocked = true;
  updateDeckSwapPanel();
  socket.emit('swap_cards', { cardIds: [...swapSelection] });
});

const btnRedSlot1 = $('btn-red-slot-1');
if (btnRedSlot1) {
  btnRedSlot1.addEventListener('click', () => {
    if (!gameState || !gameState.isRedRound || gameState.phase !== 'player_play') return;
    assignSelectedRedCardToSlot(1);
  });
}

const btnRedSlot2 = $('btn-red-slot-2');
if (btnRedSlot2) {
  btnRedSlot2.addEventListener('click', () => {
    if (!gameState || !gameState.isRedRound || gameState.phase !== 'player_play') return;
    assignSelectedRedCardToSlot(2);
  });
}

const btnRedSlotCancel = $('btn-red-slot-cancel');
if (btnRedSlotCancel) {
  btnRedSlotCancel.addEventListener('click', () => {
    selectedCard = null;
    renderHand();
    updateRedSlotChooser();
  });
}

// === Play again ===
on('btn-play-again', 'click', () => {
  location.reload();
});

// === Rendering helpers ===
function cardEl(cardId, clickHandler) {
  const wrapper = document.createElement('div');
  wrapper.className = 'game-card';
  wrapper.dataset.cardId = cardId;
  const img = document.createElement('img');
  img.src = `/cards/card_${String(cardId).padStart(4,'0')}.png`;
  img.alt = `Carta ${cardId}`;
  img.draggable = false;
  wrapper.appendChild(img);
  if (clickHandler) wrapper.addEventListener('click', () => clickHandler(cardId, wrapper));
  return wrapper;
}

function syncRedRoundControls() {
  const before = $('slot-before');
  const after = $('slot-after');
  const submit = $('btn-submit-red');
  if (!before || !after || !submit) return;

  if (redSelectionBefore) {
    before.innerHTML = `<img src="/cards/card_${String(redSelectionBefore).padStart(4,'0')}.png" alt="antes"/>`;
  } else {
    before.innerHTML = '<span class="slot-empty">vacío</span>';
  }

  if (redSelectionAfter) {
    after.innerHTML = `<img src="/cards/card_${String(redSelectionAfter).padStart(4,'0')}.png" alt="después"/>`;
  } else {
    after.innerHTML = '<span class="slot-empty">vacío</span>';
  }

  submit.disabled = !(redSelectionBefore && redSelectionAfter);
}

function assignSelectedRedCardToSlot(slot, forcedCardId = null) {
  const cardToPlace = forcedCardId || selectedCard;
  if (!cardToPlace) {
    toast('Elegí una carta de tu mano primero.', true);
    return;
  }

  if (!myHand.includes(cardToPlace)) {
    toast('Esa carta ya no está en tu mano.', true);
    return;
  }

  if (slot === 1) {
    if (cardToPlace === redSelectionAfter) {
      toast('Esa carta ya está en Pos 2.', true);
      return;
    }
    redSelectionBefore = cardToPlace;
  } else if (slot === 2) {
    if (cardToPlace === redSelectionBefore) {
      toast('Esa carta ya está en Pos 1.', true);
      return;
    }
    redSelectionAfter = cardToPlace;
  }

  selectedCard = null;
  renderHand();
  renderTableCards(gameState?.table || []);
  syncRedRoundControls();
  updateRedSlotChooser();

  if (redSelectionBefore && redSelectionAfter && !myHasSubmitted) {
    myHasSubmitted = true;
    myHand = myHand.filter(cid => cid !== redSelectionBefore && cid !== redSelectionAfter);
    socket.emit('play_card', { cards: [redSelectionBefore, redSelectionAfter] });
    redSelectionBefore = null;
    redSelectionAfter = null;
    renderHand();
    $('hand-cards').querySelectorAll('.game-card').forEach(c => {
      c.style.opacity = '0.3';
      c.style.pointerEvents = 'none';
      c.classList.remove('selected');
    });
    hide('red-slot-chooser');
    $('status-bar').textContent = 'Jugada enviada. Esperando al resto...';
  }
}

function submitNormalCardToSlot(slot, forcedCardId = null) {
  if (!gameState || gameState.phase !== 'player_play' || gameState.isRedRound || myHasSubmitted) return;
  const cardToPlay = forcedCardId || selectedCard;
  if (!cardToPlay) {
    toast('Elegí una carta de tu mano primero.', true);
    return;
  }

  // Defensive check: selected position should be empty in mesa.
  const occupied = new Set(normalizeMesaEntries(gameState.table || [], 2).map(e => e.position));
  if (occupied.has(slot)) {
    toast('Ese recuadro ya está ocupado.', true);
    return;
  }

  myHasSubmitted = true;
  myHand = myHand.filter(cid => cid !== cardToPlay);
  selectedCard = null;
  socket.emit('play_card', { cardId: cardToPlay, position: slot });
  renderHand();
  hide('confirm-bar');
  $('status-bar').textContent = `Jugada enviada en Pos ${slot}. Esperando al resto...`;
}

function normalizeMesaEntries(tableCards, preferredDeckSlot = 2) {
  const positioned = [];
  const used = new Set();
  let unpositionedDeck = null;

  for (const entry of tableCards || []) {
    if (entry.position >= 1 && entry.position <= 3) {
      positioned.push(entry);
      used.add(entry.position);
    } else if (!unpositionedDeck && entry.playerId === 'deck') {
      unpositionedDeck = entry;
    }
  }

  if (unpositionedDeck) {
    let slot = preferredDeckSlot;
    if (used.has(slot)) {
      slot = [1, 2, 3].find(s => !used.has(s)) || 2;
    }
    positioned.push({ ...unpositionedDeck, position: slot });
  }

  return positioned.sort((a, b) => (a.position || 99) - (b.position || 99));
}

function renderTableCards(table) {
  const el = $('table-cards');
  el.innerHTML = '';
  if (!table || table.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem;padding:10px">Sin cartas aún</span>';
    return;
  }

  // Red rounds: fixed red card in slot 3; player chooses cards for slots 1 and 2.
  if (gameState && gameState.isRedRound) {
    const redEntry = (table || []).find(e => e.playerId === 'deck') || table[0];
    for (let slot = 1; slot <= 3; slot++) {
      const slotEl = document.createElement('div');
      slotEl.className = 'mesa-slot';

      if (slot === 3 && redEntry) {
        const redCard = cardEl(redEntry.cardId);
        redCard.classList.add('table-card');
        redCard.classList.add('red-card');
        slotEl.appendChild(redCard);
      } else {
        const chosen = slot === 1 ? redSelectionBefore : redSelectionAfter;
        if (chosen) {
          const chosenCard = cardEl(chosen, () => {
            if (!gameState || gameState.phase !== 'player_play' || myHasSubmitted) return;
            if (slot === 1) redSelectionBefore = null;
            if (slot === 2) redSelectionAfter = null;
            renderTableCards(gameState.table || []);
            syncRedRoundControls();
          });
          chosenCard.classList.add('table-card');
          slotEl.appendChild(chosenCard);
        } else {
          const ph = document.createElement('div');
          ph.className = 'mesa-placeholder';
          ph.textContent = `Pos ${slot}`;
          if (gameState.phase === 'player_play' && !myHasSubmitted) {
            ph.classList.add('drop-ready');
            ph.dataset.slot = String(slot);
            ph.addEventListener('dragover', (ev) => {
              ev.preventDefault();
              ph.classList.add('active');
            });
            ph.addEventListener('dragleave', () => ph.classList.remove('active'));
            ph.addEventListener('drop', (ev) => {
              ev.preventDefault();
              ph.classList.remove('active');
              const droppedCardId = Number(ev.dataTransfer?.getData('text/plain'));
              if (!Number.isFinite(droppedCardId)) return;
              assignSelectedRedCardToSlot(slot, droppedCardId);
            });
            ph.addEventListener('click', () => assignSelectedRedCardToSlot(slot));
          }
          slotEl.appendChild(ph);
        }
      }

      el.appendChild(slotEl);
    }
    return;
  }

  // Normal rounds use 3 mesa slots (1,2,3) with placeholders for empty positions.
  if (gameState && !gameState.isRedRound) {
    const preferredDeckSlot = (gameState.phase === 'judge_play' && isLocalJudge()) ? judgeDeckSlot : 2;
    const tableForRender = (gameState.phase === 'judge_play' && isLocalJudge())
      ? (table || []).map(entry => entry.playerId === 'deck' ? { ...entry, position: judgeDeckSlot } : entry)
      : table;
    const normalized = normalizeMesaEntries(tableForRender, preferredDeckSlot);
    const positioned = new Map(normalized.map(e => [e.position, e]));

    for (let slot = 1; slot <= 3; slot++) {
      const slotEl = document.createElement('div');
      slotEl.className = 'mesa-slot';
      const entry = positioned.get(slot);

      if (entry) {
        const card = cardEl(entry.cardId);
        card.classList.add('table-card');
        if (gameState.phase === 'judge_play' && isLocalJudge() && entry.playerId === 'deck') {
          card.setAttribute('draggable', 'false');
          card.style.cursor = 'grab';
          const deckImg = card.querySelector('img');
          if (deckImg) deckImg.draggable = false;

          const startDeckDrag = (ev) => {
            draggedSourceType = 'deck';
            draggedJudgeCardId = null;
            if (ev && ev.dataTransfer) {
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', 'deck');
            }
          };

          card.addEventListener('mousedown', (ev) => beginMouseJudgeDrag('deck', null, card, ev));
          if (deckImg) deckImg.addEventListener('mousedown', (ev) => beginMouseJudgeDrag('deck', null, card, ev));
          card.addEventListener('touchstart', () => {
            draggedSourceType = 'deck';
            draggedJudgeCardId = null;
            clearJudgeCardSelectionUI();
          }, { passive: true });
          card.addEventListener('touchmove', (ev) => {
            const touch = ev.touches[0];
            if (!touch) return;
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            const ph = target && target.closest ? target.closest('.mesa-placeholder.drop-ready') : null;
            document.querySelectorAll('.mesa-placeholder.drop-ready').forEach(p => p.classList.remove('active'));
            if (ph) ph.classList.add('active');
          }, { passive: true });
          card.addEventListener('touchend', (ev) => {
            const touch = ev.changedTouches[0];
            if (!touch) return;
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            const ph = target && target.closest ? target.closest('.mesa-placeholder.drop-ready') : null;
            if (ph) {
              const slot = Number(ph.dataset.slot);
              judgeDeckSlot = slot;
              clearJudgeCardSelectionUI();
              renderTableCards(table);
              updateJudgeControls();
            }
            draggedSourceType = null;
          });
        }
        if (entry.playerId === 'deck' && gameState.isRedRound) {
          card.classList.add('red-card');
        }
        slotEl.appendChild(card);
      } else {
        const ph = document.createElement('div');
        ph.className = 'mesa-placeholder';
        ph.textContent = `Pos ${slot}`;

        if (gameState.phase === 'judge_play' && isLocalJudge()) {
          ph.classList.add('drop-ready');
          ph.dataset.slot = String(slot);
          ph.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            ph.classList.add('active');
          });
          ph.addEventListener('dragleave', () => ph.classList.remove('active'));
          ph.addEventListener('drop', (ev) => {
            ev.preventDefault();
            ph.classList.remove('active');
            if (draggedSourceType === 'deck') {
              judgeDeckSlot = slot;
              draggedSourceType = null;
              renderTableCards(table);
              updateJudgeControls();
              return;
            }
          });
          // Mobile fallback: tap selected card, then tap target placeholder.
          ph.addEventListener('click', () => {
            if (draggedSourceType === 'deck') {
              judgeDeckSlot = slot;
              draggedSourceType = null;
              renderTableCards(table);
              updateJudgeControls();
              return;
            }
          });
        } else if (gameState.phase === 'player_play' && !gameState.isRedRound && !myHasSubmitted) {
          ph.classList.add('drop-ready');
          ph.dataset.slot = String(slot);
          ph.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            ph.classList.add('active');
          });
          ph.addEventListener('dragleave', () => ph.classList.remove('active'));
          ph.addEventListener('drop', (ev) => {
            ev.preventDefault();
            ph.classList.remove('active');
            const droppedCardId = Number(ev.dataTransfer?.getData('text/plain'));
            if (!Number.isFinite(droppedCardId)) return;
            submitNormalCardToSlot(slot, droppedCardId);
          });
          ph.addEventListener('click', () => submitNormalCardToSlot(slot));
        }

        slotEl.appendChild(ph);
      }

      el.appendChild(slotEl);
    }
    return;
  }

  [...table].sort((a, b) => (a.position || 99) - (b.position || 99)).forEach(entry => {
    const card = cardEl(entry.cardId);
    card.classList.add('table-card');
    if (entry.playerId === 'deck') {
      if (gameState && gameState.isRedRound) card.classList.add('red-card');
    }
    el.appendChild(card);
  });
}

function renderHand() {
  const el = $('hand-cards');
  el.innerHTML = '';
  if (!myHand.length) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:.85rem;padding:10px">Sin cartas</span>';
    return;
  }
  myHand.forEach(cardId => {
    const card = cardEl(cardId, onCardClick);
    if (gameState && gameState.phase === 'judge_play') {
      card.setAttribute('draggable', 'false');
      const handImg = card.querySelector('img');
      if (handImg) handImg.draggable = false;

      const startHandDrag = (ev) => {
        draggedSourceType = 'hand';
        draggedJudgeCardId = cardId;
        clearJudgeCardSelectionUI();
        card.classList.add('selected');
        if (ev && ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', String(cardId));
        }
      };

      card.addEventListener('mousedown', (ev) => beginMouseJudgeDrag('hand', cardId, card, ev));
      if (handImg) handImg.addEventListener('mousedown', (ev) => beginMouseJudgeDrag('hand', cardId, card, ev));

      // Touch on judge card = selection only; placement is done via buttons.
      card.addEventListener('touchstart', () => {
        draggedSourceType = null;
        draggedJudgeCardId = cardId;
        clearJudgeCardSelectionUI();
        card.classList.add('selected');
        show('judge-placement');
        updateJudgeControls();
      }, { passive: true });
    } else if (gameState && gameState.phase === 'player_play' && gameState.isRedRound && !myHasSubmitted) {
      card.setAttribute('draggable', 'true');
      const handImg = card.querySelector('img');
      if (handImg) handImg.draggable = false;
      card.addEventListener('dragstart', (ev) => {
        if (!ev.dataTransfer) return;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(cardId));
        document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
        selectedCard = cardId;
        card.classList.add('selected');
      });
      card.addEventListener('dragend', () => {
        document.querySelectorAll('.mesa-placeholder.drop-ready').forEach(p => p.classList.remove('active'));
      });
    } else if (gameState && gameState.phase === 'player_play' && !gameState.isRedRound && !myHasSubmitted) {
      card.setAttribute('draggable', 'true');
      const handImg = card.querySelector('img');
      if (handImg) handImg.draggable = false;
      card.addEventListener('dragstart', (ev) => {
        if (!ev.dataTransfer) return;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(cardId));
        document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
        selectedCard = cardId;
        card.classList.add('selected');
      });
      card.addEventListener('dragend', () => {
        document.querySelectorAll('.mesa-placeholder.drop-ready').forEach(p => p.classList.remove('active'));
      });
    }
    el.appendChild(card);
  });
}

function onCardClick(cardId, wrapper) {
  if (!gameState) return;

  if (gameState.phase === 'deck_swap') {
    if (swapLocked) return;
    const idx = swapSelection.indexOf(cardId);
    if (idx !== -1) {
      swapSelection.splice(idx, 1);
      wrapper.classList.remove('selected');
    } else {
      if (swapSelection.length >= 3) {
        toast('Podés descartar como máximo 3 cartas.', true);
        return;
      }
      swapSelection.push(cardId);
      wrapper.classList.add('selected');
    }
    updateDeckSwapPanel();
    $('status-bar').textContent = `🃏 MAZO: seleccionadas ${swapSelection.length} / 3 (mínimo 1)`;
    return;
  }

  if (gameState && gameState.isRedRound) {
    if (!gameState || gameState.phase !== 'player_play') return;
    document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
    if (selectedCard === cardId) {
      selectedCard = null;
    } else {
      selectedCard = cardId;
      wrapper.classList.add('selected');
    }
    updateRedSlotChooser();
    return;
  }

  if (gameState.phase === 'judge_play') {
    draggedJudgeCardId = cardId;
    selectedCard = cardId;
    clearJudgeCardSelectionUI();
    wrapper.classList.add('selected');
    show('judge-placement');
    updateJudgeControls();
    $('status-bar').textContent = 'Arrastrá la carta o elegí con botones: Primero mové "Primera carta", después tocá la posición de "Tu carta"';
    return;
  }

  if (gameState.phase === 'player_play') {
    hide('judge-placement');
    // Show confirm bar instead of playing immediately
    document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
    if (selectedCard === cardId) {
      selectedCard = null;
      hide('confirm-bar');
    } else {
      selectedCard = cardId;
      wrapper.classList.add('selected');
      // Show preview in confirm bar
      $('confirm-preview').innerHTML = `<img src="/cards/card_${String(cardId).padStart(4,'0')}.png" alt="carta"/>`;
      show('confirm-bar');
      ensureConfirmBarVisible();
    }
  }
}

// Confirm / cancel play
on('btn-confirm-play', 'click', () => {
  if (!selectedCard) return;
  const cardId = selectedCard;
  myHand = myHand.filter(cid => cid !== cardId);
  selectedCard = null;
  hide('confirm-bar');
  renderHand();
  $('hand-cards').querySelectorAll('.game-card').forEach(c => {
    c.style.opacity = '0.3';
    c.style.pointerEvents = 'none';
  });
  myHasSubmitted = true;
  socket.emit('play_card', { cardId });
});
on('btn-cancel-play', 'click', () => {
  document.querySelectorAll('#hand-cards .game-card').forEach(c => c.classList.remove('selected'));
  selectedCard = null;
  hide('confirm-bar');
  hide('red-slot-chooser');
});

const btnSubmitRed = $('btn-submit-red');
if (btnSubmitRed) {
  btnSubmitRed.addEventListener('click', () => {
    if (!redSelectionBefore || !redSelectionAfter || myHasSubmitted) return;
    myHasSubmitted = true;
    myHand = myHand.filter(cid => cid !== redSelectionBefore && cid !== redSelectionAfter);
    socket.emit('play_card', { cards: [redSelectionBefore, redSelectionAfter] });
    redSelectionBefore = null;
    redSelectionAfter = null;
    selectedCard = null;
    renderHand();
    renderTableCards(gameState?.table || []);
    syncRedRoundControls();
    hide('red-round-info');
  });
}

// Voting submissions — show full story: table cards + player's card
function renderSubmissions(submissions, tableCards) {
  const el = $('submissions-list');
  el.innerHTML = '';
  const mesaEntries = normalizeMesaEntries(tableCards || gameState?.table || [], 2);
  (submissions || []).forEach((sub) => {
    const group = document.createElement('div');
    group.className = 'submission-group';
    group.style.flexDirection = 'column';
    group.style.alignItems = 'flex-start';

    const name = document.createElement('div');
    name.textContent = sub.playerName || 'Jugador';
    name.style.cssText = 'font-size:.75rem;color:var(--text-muted);margin-bottom:4px';
    group.appendChild(name);

    const row = document.createElement('div');
    row.className = 'submission-cards';
    const storyCards = composeStoryCards(mesaEntries, sub);
    storyCards.forEach(cardId => {
      const c = cardEl(cardId);
      c.style.width = '62px';
      c.querySelector('img').style.width = '62px';
      row.appendChild(c);
    });

    group.appendChild(row);
    el.appendChild(group);
  });
}

function renderVotingSubmissions(submissions, tableCards) {
  const el = $('submissions-list');
  el.innerHTML = '';
  const votingCardWidth = 124;
  const mesaEntries = normalizeMesaEntries(tableCards || gameState?.table || [], 2);
  const selfVoteBlocked = (gameState?.players?.length || 0) >= 3;
  submissions.forEach((sub) => {
    const isOwn = sub.submissionId === myId;
    const canVoteForThisSubmission = !(selfVoteBlocked && isOwn);
    const group = document.createElement('div');
    group.className = 'submission-group';
    group.style.flexDirection = 'column';
    group.style.alignItems = 'flex-start';
    if (isOwn) {
      const badge = document.createElement('div');
      badge.textContent = selfVoteBlocked ? '← Tu jugada · no votable' : '← Tu jugada';
      badge.style.cssText = 'font-size:.7rem;color:var(--text-muted);margin-bottom:4px';
      group.appendChild(badge);
    }
    // Full story row: table cards + submitted card
    const row = document.createElement('div');
    row.className = 'submission-cards';
    const storyCards = composeStoryCards(mesaEntries, sub);
    storyCards.forEach(cardId => {
      const c = cardEl(cardId);
      c.style.width = `${votingCardWidth}px`;
      c.querySelector('img').style.width = `${votingCardWidth}px`;
      row.appendChild(c);
    });
    group.appendChild(row);
    group.addEventListener('click', () => {
      if (!canVoteForThisSubmission) {
        $('status-bar').textContent = 'Con 3 o más jugadores no podés votarte a vos mismo';
        return;
      }
      if (group.dataset.pending === '1') {
        // Second tap = confirm vote
        socket.emit('cast_vote', { votedForId: sub.submissionId });
        document.querySelectorAll('.submission-group').forEach(g => {
          g.style.pointerEvents = 'none';
          g.style.opacity = '0.35';
          delete g.dataset.pending;
        });
        group.style.opacity = '1';
        group.style.border = '2px solid var(--green)';
        $('status-bar').textContent = '\u2705 Voto registrado. Esperando a los demás...';
      } else {
        // First tap = highlight, ask to confirm
        document.querySelectorAll('.submission-group').forEach(g => {
          g.style.border = '2px solid transparent';
          delete g.dataset.pending;
        });
        group.style.border = '2px solid var(--accent2)';
        group.dataset.pending = '1';
        $('status-bar').textContent = 'Tocá de nuevo para confirmar tu voto';
      }
    });
    if (!canVoteForThisSubmission) {
      group.style.opacity = '0.55';
      group.style.cursor = 'not-allowed';
    }
    el.appendChild(group);
  });
}

function composeStoryCards(mesaEntries, submission) {
  const submissionCards = Array.isArray(submission)
    ? submission
    : (submission?.cards || []);
  const submissionPosition = Array.isArray(submission)
    ? null
    : submission?.position;

  // Red-card variant: mesa card fixed in slot 3, player cards go to slots 1 and 2.
  if (submissionCards && submissionCards.length === 2) {
    const slots = [null, null, null];
    const redEntry = (mesaEntries || []).find(e => e.position === 3) || (mesaEntries || [])[0];
    if (redEntry) slots[2] = redEntry.cardId;
    slots[0] = submissionCards[0] || null;
    slots[1] = submissionCards[1] || null;
    return slots.filter(Boolean);
  }

  // Normal rounds now support layouts 1-2, 1-3, 2-3; missing slot is filled by the player's card.
  if (!submissionCards || submissionCards.length !== 1 || !mesaEntries || mesaEntries.length < 2) {
    return [...(mesaEntries || [])].sort((a, b) => (a.position || 99) - (b.position || 99)).map(e => e.cardId).concat(submissionCards || []);
  }

  const positioned = mesaEntries.filter(e => e.position >= 1 && e.position <= 3);
  if (positioned.length < 2) {
    return [...mesaEntries.map(e => e.cardId), ...submissionCards];
  }

  const slots = [null, null, null];
  for (const entry of positioned) {
    slots[entry.position - 1] = entry.cardId;
  }
  const preferredIdx = Number.isInteger(submissionPosition) && submissionPosition >= 1 && submissionPosition <= 3
    ? submissionPosition - 1
    : -1;
  if (preferredIdx !== -1 && slots[preferredIdx] === null) {
    slots[preferredIdx] = submissionCards[0];
  } else {
    const gapIndex = slots.findIndex(v => v === null);
    if (gapIndex !== -1) {
      slots[gapIndex] = submissionCards[0];
    } else {
      // Fallback: if no gap exists for any reason, append submission at the end.
      return [...slots.filter(Boolean), submissionCards[0]];
    }
  }
  return slots.filter(Boolean);
}

function renderScoreBar() {
  if (!gameState) return;
  const el = $('score-bar');
  el.innerHTML = gameState.players.map((p, i) => {
    const cls = [
      'score-player',
      i === gameState.judgeIndex ? 'is-judge' : '',
      p.id === myId ? 'is-me' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="${cls}">
        ${i === gameState.judgeIndex ? '<span class="judge-badge">JUEZ</span>' : ''}
        <span class="score-name">${p.name}</span>
        <span class="score-pts">${p.score}</span>
      </div>
    `;
  }).join('');
}

function renderResultScores(players, voteCounts, submissions) {
  const el = $('result-scores');
  const sorted = [...players].sort((a, b) => b.score - a.score);
  el.innerHTML = sorted.map(p => {
    const votes = voteCounts ? (voteCounts[p.id] || 0) : null;
    const voteStr = votes !== null ? ` · ${votes} voto${votes !== 1 ? 's' : ''}` : '';
    return `
      <div class="score-row ${p.id === myId ? 'winner' : ''}">
        <span>${p.name}${p.id === myId ? ' (vos)' : ''}${voteStr}</span>
        <span class="pts">${p.score} / ${gameState?.targetScore || 3}</span>
      </div>
    `;
  }).join('');
}

function updateStatus(room) {
  const judge = room.players[room.judgeIndex];
  const judgeIsMe = judge?.id === myId;
  syncJudgeState(room);

  if (room.phase === 'judge_play') {
    $('status-bar').textContent = judgeIsMe
      ? '\u270B Sos el juez — elegí una carta para poner en la mesa (recibís una de reemplazo)'
      : `\u23F3 ${judge?.name} está poniendo la carta del juez...`;
  } else if (room.phase === 'player_play') {
    $('status-bar').textContent = '\uD83C\uDCA7 Elegí la carta con la que completás la historia';
  } else if (room.phase === 'deck_swap') {
    $('status-bar').textContent = '🃏 MAZO: descartá entre 1 y 3 cartas para recibir esa misma cantidad';
  }
  renderScoreBar();
}

function updateActionUI() {
  hide('judge-placement');
  hide('confirm-bar');
  hide('red-slot-chooser');
  hide('red-round-info');
  updateDeckSwapPanel();
  // Don't hide submissions-area if already visible (player submitted or voting in progress)
  if (!myHasSubmitted && gameState?.phase !== 'voting') {
    hide('submissions-area');
  }
  if (gameState?.phase !== 'judge_play') {
    selectedCard = null;
    draggedJudgeCardId = null;
  }

  if (!gameState) return;
}
