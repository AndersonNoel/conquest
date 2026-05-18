// ─────────────────────────────────────────────
//  gameEngine.js  –  Game state machine & timer management
//
//  The game runs through these states:
//    waiting → (optional countdown) → running → ended
//                                  ↕ paused
//
//  A "reset" is the event that happens at the end of each round interval:
//   • Points are awarded to each team for every location they hold.
//   • All location control is cleared (locations become unowned again).
//   • Location point values are re-randomised.
//   • If the final reset has been reached, the game ends instead.
//
//  Three separate Node timers keep things ticking:
//   • resetTimer    — fires once when the current round's interval expires
//   • countdownTimer — fires once when the pre-game countdown reaches zero
//   • tickTimer     — fires every second to push timer updates to all clients
// ─────────────────────────────────────────────

const store = require('./store');

// Socket.IO server instance — set by init().
let io;

// One-shot timer that fires when the current round should end.
let resetTimer    = null;
// One-shot timer that fires when the pre-game countdown reaches zero.
let countdownTimer = null;
// Repeating 1-second timer that pushes timerTick / countdownTick events.
let tickTimer     = null;

// Push the full game state to every connected browser.
function broadcastState() {
  io.emit('gameState', getFullGameState());
}

// Build a snapshot of the entire game state that can be serialised to JSON
// and sent to a client.  This is called frequently so it stays side-effect-free.
function getFullGameState() {
  const settings  = store.getSettings();
  // Sort teams by descending score for the leaderboard; break ties by ID.
  const teams     = store.getTeams().sort((a, b) => b.total_points - a.total_points || a.id - b.id);
  const locations = store.getLocationsWithTeam();

  // Calculate how many milliseconds remain in the current round so the
  // client can display a countdown without its own server-round-trip.
  let timeRemaining = null;
  if (settings.game_state === 'running' && settings.reset_start_time) {
    const interval = settings.reset_interval_minutes * 60 * 1000;
    timeRemaining = Math.max(0, interval - (Date.now() - settings.reset_start_time));
  } else if (settings.game_state === 'paused') {
    // When paused we stored the remaining time — just surface it directly.
    timeRemaining = settings.paused_remaining_ms || 0;
  }

  // Separate countdown for the pre-game start countdown (before rounds begin).
  let countdownRemaining = null;
  if (settings.game_state === 'countdown' && settings.countdown_end_time) {
    countdownRemaining = Math.max(0, settings.countdown_end_time - Date.now());
  }

  return {
    gameState: settings.game_state,
    currentReset: settings.current_reset,
    totalResets: settings.total_resets,
    resetIntervalMinutes: settings.reset_interval_minutes,
    maxPointValue: settings.max_point_value,
    mapImage: settings.map_image,
    teams,
    locations,
    timeRemaining,
    countdownRemaining,
    resetStartTime: settings.reset_start_time
  };
}

// Called at the end of every round interval.
// Awards points, clears control, randomises point values, then either
// starts the next round or ends the game if all resets have been used.
function processReset() {
  // Clear the timer handle — we'll schedule the next one ourselves below (or not at all).
  if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }

  const settings  = store.getSettings();
  // Only controlled locations earn points for their team.
  const controlled = store.getLocations().filter(l => l.controlling_team_id !== null);

  // Award each team the point value of every location they currently hold.
  for (const loc of controlled) {
    store.addTeamPoints(loc.controlling_team_id, loc.current_point_value);
  }

  const newReset = settings.current_reset + 1;

  // Strip all team ownership from every location — clean slate for the next round.
  store.resetAllLocationControl();

  // Notify clients which round just ended and what points were awarded.
  io.emit('resetOccurred', {
    resetNumber: newReset,
    totalResets: settings.total_resets,
    pointsAwarded: controlled.map(l => ({
      name: l.name,
      points: l.current_point_value,
      teamId: l.controlling_team_id
    }))
  });

  // If this was the last reset, end the game.
  if (newReset >= settings.total_resets) {
    store.updateSettings({ game_state: 'ended', current_reset: newReset });
    clearTimers();
    broadcastState();
    io.emit('gameEnded');
    return;
  }

  // Otherwise: randomise point values for the next round and schedule the next reset.
  store.randomizeLocationPoints(settings.max_point_value);
  store.updateSettings({ current_reset: newReset, reset_start_time: Date.now() });

  broadcastState();
  scheduleReset(settings.reset_interval_minutes * 60 * 1000);
}

// Schedule processReset to fire after `ms` milliseconds, cancelling any
// previously scheduled reset timer first.
function scheduleReset(ms) {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(processReset, ms);
}

// Transition from "countdown" to "running" and kick off the first round timer.
function startGameNow() {
  if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }

  const settings = store.getSettings();
  store.resetAllLocationControl();
  // Give every location a fresh random point value for the first round.
  store.randomizeLocationPoints(settings.max_point_value);

  const now = Date.now();
  store.updateSettings({
    game_state: 'running',
    game_start_time: now,
    reset_start_time: now,   // round timer starts now
    current_reset: 0,
    countdown_end_time: null
  });

  broadcastState();
  scheduleReset(settings.reset_interval_minutes * 60 * 1000);
}

// Emit timer ticks every second so clients can show a live countdown without
// their own setInterval logic on the client being authoritative.
// The tick event carries the remaining ms so any client that reconnects
// mid-round can immediately render the correct value.
function startTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    const settings = store.getSettings();

    if (settings.game_state === 'running' && settings.reset_start_time) {
      const interval  = settings.reset_interval_minutes * 60 * 1000;
      const remaining = Math.max(0, interval - (Date.now() - settings.reset_start_time));
      io.emit('timerTick', { remaining });
    } else if (settings.game_state === 'countdown' && settings.countdown_end_time) {
      const remaining = Math.max(0, settings.countdown_end_time - Date.now());
      io.emit('countdownTick', { remaining });
    } else if (settings.game_state === 'paused') {
      // Keep broadcasting the frozen remaining time while paused so the client
      // display doesn't go blank.
      io.emit('timerTick', { remaining: settings.paused_remaining_ms || 0 });
    }
  }, 1000);
}

// Stop all three timers and null their handles.
function clearTimers() {
  if (resetTimer)    { clearTimeout(resetTimer);    resetTimer    = null; }
  if (countdownTimer){ clearTimeout(countdownTimer); countdownTimer = null; }
  if (tickTimer)     { clearInterval(tickTimer);     tickTimer     = null; }
}

module.exports = {

  // Called once at server startup with the Socket.IO instance.
  // Recovers in-progress games that were interrupted by a server restart:
  //  • If the game was running and the reset timer would have already fired,
  //    process the missed reset immediately.
  //  • If time still remains, schedule a reset for the leftover duration.
  //  • If a countdown was in progress, resume it from where it left off.
  init({ io: socketIo }) {
    io = socketIo;

    const settings = store.getSettings();

    if (settings.game_state === 'running' && settings.reset_start_time) {
      const interval  = settings.reset_interval_minutes * 60 * 1000;
      const remaining = interval - (Date.now() - settings.reset_start_time);
      if (remaining <= 0) {
        // The reset was supposed to have fired while the server was down — do it now.
        processReset();
      } else {
        scheduleReset(remaining);
        startTick();
      }
    } else if (settings.game_state === 'countdown' && settings.countdown_end_time) {
      const remaining = settings.countdown_end_time - Date.now();
      if (remaining <= 0) {
        // Countdown finished while server was offline — start immediately.
        startGameNow();
      } else {
        countdownTimer = setTimeout(startGameNow, remaining);
      }
      startTick();
    }
  },

  // Start the game, optionally with a pre-game countdown (in seconds).
  // Passing 0 or omitting countdownSeconds starts immediately.
  // Always resets all team scores before starting.
  startGame(countdownSeconds) {
    clearTimers();
    store.resetTeamPoints();

    if (countdownSeconds > 0) {
      const countdownEnd = Date.now() + countdownSeconds * 1000;
      store.updateSettings({ game_state: 'countdown', countdown_end_time: countdownEnd });
      countdownTimer = setTimeout(startGameNow, countdownSeconds * 1000);
      startTick();
      broadcastState();
    } else {
      startGameNow();
      startTick();
    }
  },

  // Freeze the round timer.  Stores how many milliseconds were left so resumeGame
  // can pick up exactly where it left off.
  pauseGame() {
    const settings = store.getSettings();
    if (settings.game_state !== 'running') return false;

    const interval  = settings.reset_interval_minutes * 60 * 1000;
    const remaining = Math.max(0, interval - (Date.now() - settings.reset_start_time));

    clearTimers();
    store.updateSettings({ game_state: 'paused', paused_remaining_ms: remaining });
    broadcastState();
    return true;
  },

  // Resume a paused game.
  // To make the existing "time elapsed since round start" calculation still work,
  // we synthesise a fake reset_start_time that is offset into the past by however
  // much of the round has already elapsed.  This way getFullGameState() and
  // processReset() don't need a special "paused" code path.
  resumeGame() {
    const settings  = store.getSettings();
    if (settings.game_state !== 'paused') return false;

    const remaining = settings.paused_remaining_ms || (settings.reset_interval_minutes * 60 * 1000);
    const interval  = settings.reset_interval_minutes * 60 * 1000;
    // If we have `remaining` ms left and the round is `interval` ms long,
    // then the round "started" (interval - remaining) ms ago.
    const fakeStart = Date.now() - (interval - remaining);

    store.updateSettings({ game_state: 'running', reset_start_time: fakeStart, paused_remaining_ms: null });
    scheduleReset(remaining);
    startTick();
    broadcastState();
    return true;
  },

  // Immediately end the game without processing a final reset — scores stay as-is.
  endGame() {
    clearTimers();
    store.updateSettings({ game_state: 'ended' });
    broadcastState();
  },

  // Full reset: clear scores, un-control all locations, return to "waiting".
  // Does NOT re-randomise point values — those are set fresh at startGameNow().
  resetGame() {
    clearTimers();
    store.resetTeamPoints();
    store.resetAllLocationControl();
    store.updateSettings({
      game_state: 'waiting',
      current_reset: 0,
      reset_start_time: null,
      paused_remaining_ms: null,
      countdown_end_time: null,
      game_start_time: null
    });
    broadcastState();
  },

  // Attempt to capture a location for the player's team.
  // Returns { success: true, ... } or { success: false, error: '...' }.
  captureLocation(locationId, userId) {
    const user = store.getUserWithTeam(userId);
    if (!user || !user.team_id) return { success: false, error: 'You are not assigned to a team yet' };

    const settings = store.getSettings();
    if (settings.game_state !== 'running') return { success: false, error: 'Game is not currently running' };

    const location = store.getLocation(locationId);
    if (!location) return { success: false, error: 'Location not found' };

    // Capturing your own location is a no-op — prevents players from scanning
    // a QR code they already own just to generate a notification.
    if (location.controlling_team_id === user.team_id) {
      return { success: false, error: `${user.team_name} already controls ${location.name}!` };
    }

    store.updateLocation(locationId, { controlling_team_id: user.team_id });

    // Broadcast the capture event separately from the full game state so clients
    // can show a specific "captured!" toast without parsing the whole state diff.
    io.emit('locationCaptured', {
      locationId,
      locationName: location.name,
      teamId: user.team_id,
      teamName: user.team_name,
      teamColor: user.team_color,
      capturedBy: user.username,
      previousTeamId: location.controlling_team_id
    });

    // Follow up with a full state broadcast so the map pin colours update everywhere.
    broadcastState();

    return {
      success: true,
      message: `${location.name} captured for ${user.team_name}!`,
      location: location.name,
      team: user.team_name,
      teamColor: user.team_color,
      pointValue: location.current_point_value
    };
  },

  // Broadcast an SOS alert to every connected client.
  // opts.name is the display name of whoever triggered it (player callsign or "Admin").
  triggerSOS(opts = {}) {
    io.emit('sosAlert', { timestamp: Date.now(), triggeredBy: opts.name || null });
  },

  broadcast: broadcastState,
  getFullGameState
};
