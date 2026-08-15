/**
 * Central configuration for the game server. Keeping these together makes
 * tuning (hand size, timeouts, valid scores) a one-file change.
 */
module.exports = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 3000,
  HAND_SIZE: 8,
  MAX_PLAYERS: 20,

  // Reconnect handling: short "grace" window absorbs brief mobile network
  // hops without pausing the match; if the grace period expires the room
  // is paused and the player is kept around for DISCONNECT_REMOVE_MS so
  // they can still rejoin before being dropped from the room entirely.
  DISCONNECT_GRACE_MS: process.env.DISCONNECT_GRACE_MS ? Number(process.env.DISCONNECT_GRACE_MS) : 8000,
  DISCONNECT_REMOVE_MS: process.env.DISCONNECT_REMOVE_MS ? Number(process.env.DISCONNECT_REMOVE_MS) : 60000,

  VALID_TARGET_SCORES: [1, 2, 3, 5, 7, 10],
  DEFAULT_TARGET_SCORE: 3,

  ROUND_RESULT_DELAY_MS: process.env.ROUND_RESULT_DELAY_MS ? Number(process.env.ROUND_RESULT_DELAY_MS) : 3000,
};
