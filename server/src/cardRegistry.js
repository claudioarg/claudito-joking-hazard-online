/**
 * Card registry + "used cards" persistence.
 *
 * Cards that get dealt (or discarded, which were already dealt) are marked
 * "used" and excluded from future decks until the entire card pool has been
 * used/discarded at least once — then the pool resets so cards can repeat.
 * This is persisted to disk so it also holds across separate matches/restarts.
 */
const fs = require('fs');
const path = require('path');

function createCardRegistry({ cardsJsonPath, dataDir, excludedPages = [112, 113, 114] }) {
  const cardsData = JSON.parse(fs.readFileSync(cardsJsonPath, 'utf-8'))
    .filter(card => !excludedPages.includes(Number(card.page)));
  const ALL_CARD_IDS = cardsData.map(c => c.id);
  const VALID_IDS = new Set(ALL_CARD_IDS);
  const usedCardsFile = path.join(dataDir, 'used_cards_memory.json');

  let usedCardIds = new Set();

  function loadUsedCardIds() {
    try {
      if (!fs.existsSync(usedCardsFile)) return;
      const raw = fs.readFileSync(usedCardsFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      usedCardIds = new Set(parsed
        .map(n => Number(n))
        .filter(id => Number.isInteger(id) && VALID_IDS.has(id)));
    } catch (err) {
      console.warn('[Deck] No se pudo cargar used_cards_memory.json:', err.message);
      usedCardIds = new Set();
    }
  }

  function saveUsedCardIds() {
    try {
      fs.writeFileSync(usedCardsFile, JSON.stringify([...usedCardIds]), 'utf-8');
    } catch (err) {
      console.warn('[Deck] No se pudo guardar used_cards_memory.json:', err.message);
    }
  }

  function markCardsUsed(cardIds) {
    let changed = false;
    for (const raw of cardIds || []) {
      const id = Number(raw);
      if (Number.isInteger(id) && VALID_IDS.has(id) && !usedCardIds.has(id)) {
        usedCardIds.add(id);
        changed = true;
      }
    }
    if (!changed) return;

    // Whole pool used/discarded at least once: reset so cards can be reused.
    if (usedCardIds.size >= ALL_CARD_IDS.length) {
      usedCardIds = new Set();
    }
    saveUsedCardIds();
  }

  function buildDeckWithUsageAvoidance(shuffleFn) {
    const available = ALL_CARD_IDS.filter(id => !usedCardIds.has(id));
    // Safety net: should only trigger if usage tracking got out of sync.
    const pool = available.length > 0 ? available : ALL_CARD_IDS;
    return shuffleFn(pool);
  }

  loadUsedCardIds();

  return { cardsData, ALL_CARD_IDS, markCardsUsed, buildDeckWithUsageAvoidance };
}

module.exports = { createCardRegistry };
