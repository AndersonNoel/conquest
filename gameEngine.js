// ─────────────────────────────────────────────
//  gameEngine.js  –  Game state machine & timer management
//
//  The game runs through these states:
//    waiting → (optional countdown) → running → intermission → running → ... → ended
//                                  ↕ paused (from either running or intermission)
//
//  A round ends when its interval expires:
//   • Points are awarded to each team for every location they hold.
//   • All location control is cleared (locations become unowned again).
//   • If the final reset has been reached, the game ends instead of continuing.
//   • Otherwise the game enters "intermission" — a fixed break during which
//     captures are disabled and point values stay unassigned — before the
//     next round starts and re-randomises point values.
//
//  Four separate Node timers keep things ticking:
//   • resetTimer        — fires once when the current round's interval expires
//   • intermissionTimer — fires once when the intermission break ends
//   • countdownTimer    — fires once when the pre-game countdown reaches zero
//   • tickTimer         — fires every second to push timer updates to all clients
// ─────────────────────────────────────────────

const store = require('./store');

// Socket.IO server instance — set by init().
let io;

// One-shot timer that fires when the current round should end.
let resetTimer    = null;
// One-shot timer that fires when the intermission break should end.
let intermissionTimer = null;
// One-shot timer that fires when the pre-game countdown reaches zero.
let countdownTimer = null;
// Repeating 1-second timer that pushes timerTick / countdownTick / intermissionTick events.
let tickTimer     = null;

// Whether the one-minute-remaining warning has already fired for the current
// round — reset to false each time a new round timer is scheduled.
let oneMinuteWarned = false;

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
  } else if (settings.game_state === 'intermission' && settings.intermission_start_time) {
    const interval = settings.intermission_minutes * 60 * 1000;
    timeRemaining = Math.max(0, interval - (Date.now() - settings.intermission_start_time));
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
    intermissionMinutes: settings.intermission_minutes,
    maxPointValue: settings.max_point_value,
    mapImage: settings.map_image,
    teams,
    locations,
    timeRemaining,
    countdownRemaining,
    resetStartTime: settings.reset_start_time,
    teamChatEnabled: settings.team_chat_enabled !== false,
    sounds: {
      one_minute: settings.sound_one_minute,
      round_end: settings.sound_round_end,
      message: settings.sound_message,
      game_start: settings.sound_game_start,
      victory: settings.sound_victory,
      capture: settings.sound_capture,
      team_lost: settings.sound_team_lost
    }
  };
}

// Called at the end of every round interval.
// Awards points and clears control, then either ends the game (if all resets
// have been used) or enters intermission — point values stay unassigned and
// the next round doesn't start until startNextRound() fires.
function endRound() {
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

  // If this was the last reset, end the game — there's no next round to wait
  // for, so skip intermission entirely.
  if (newReset >= settings.total_resets) {
    store.updateSettings({ game_state: 'ended', current_reset: newReset, reset_start_time: null });
    clearTimers();
    broadcastState();
    io.emit('gameEnded');
    return;
  }

  // Otherwise: enter intermission. Point values are re-randomised only when
  // startNextRound() fires at the end of the break.
  store.updateSettings({
    game_state: 'intermission',
    current_reset: newReset,
    reset_start_time: null,
    intermission_start_time: Date.now()
  });

  broadcastState();
  scheduleIntermission(settings.intermission_minutes * 60 * 1000);
}

// Schedule endRound to fire after `ms` milliseconds, cancelling any
// previously scheduled reset timer first.
function scheduleReset(ms) {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(endRound, ms);
  // A new round is starting — allow the one-minute warning to fire again for it.
  oneMinuteWarned = false;
}

// Schedule startNextRound to fire after `ms` milliseconds, cancelling any
// previously scheduled intermission timer first.
function scheduleIntermission(ms) {
  if (intermissionTimer) clearTimeout(intermissionTimer);
  intermissionTimer = setTimeout(startNextRound, ms);
}

// Called when intermission ends. Randomises point values for the round about
// to start and kicks off its timer.
function startNextRound() {
  if (intermissionTimer) { clearTimeout(intermissionTimer); intermissionTimer = null; }

  const settings = store.getSettings();
  store.randomizeLocationPoints(settings.num_teams);

  store.updateSettings({
    game_state: 'running',
    reset_start_time: Date.now(),
    intermission_start_time: null
  });

  broadcastState();
  scheduleReset(settings.reset_interval_minutes * 60 * 1000);
}

// Transition from "countdown" to "running" and kick off the first round timer.
function startGameNow() {
  if (countdownTimer) { clearTimeout(countdownTimer); countdownTimer = null; }

  const settings = store.getSettings();
  store.resetAllLocationControl();
  // Give every location a fresh random point value for the first round.
  store.randomizeLocationPoints(settings.num_teams);

  const now = Date.now();
  store.updateSettings({
    game_state: 'running',
    game_start_time: now,
    reset_start_time: now,   // round timer starts now
    current_reset: 0,
    countdown_end_time: null,
    intermission_start_time: null
  });

  broadcastState();
  io.emit('gameStarted');
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
      if (!oneMinuteWarned && remaining <= 60000 && remaining > 0) {
        oneMinuteWarned = true;
        io.emit('oneMinuteWarning');
      }
    } else if (settings.game_state === 'intermission' && settings.intermission_start_time) {
      const interval  = settings.intermission_minutes * 60 * 1000;
      const remaining = Math.max(0, interval - (Date.now() - settings.intermission_start_time));
      io.emit('intermissionTick', { remaining });
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

// Stop all four timers and null their handles.
function clearTimers() {
  if (resetTimer)       { clearTimeout(resetTimer);       resetTimer       = null; }
  if (intermissionTimer){ clearTimeout(intermissionTimer); intermissionTimer = null; }
  if (countdownTimer)   { clearTimeout(countdownTimer);   countdownTimer   = null; }
  if (tickTimer)        { clearInterval(tickTimer);       tickTimer        = null; }
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
        endRound();
      } else {
        scheduleReset(remaining);
        startTick();
      }
    } else if (settings.game_state === 'intermission' && settings.intermission_start_time) {
      const interval  = settings.intermission_minutes * 60 * 1000;
      const remaining = interval - (Date.now() - settings.intermission_start_time);
      if (remaining <= 0) {
        // Intermission finished while the server was down — start the next round now.
        startNextRound();
      } else {
        scheduleIntermission(remaining);
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

  // Freeze the round or intermission timer (whichever is active). Stores how
  // many milliseconds were left, and which phase it was paused from, so
  // resumeGame can pick up exactly where it left off.
  pauseGame() {
    const settings = store.getSettings();
    const fromState = settings.game_state;
    if (fromState !== 'running' && fromState !== 'intermission') return false;

    const intervalMs = fromState === 'running'
      ? settings.reset_interval_minutes * 60 * 1000
      : settings.intermission_minutes * 60 * 1000;
    const startTime = fromState === 'running' ? settings.reset_start_time : settings.intermission_start_time;
    const remaining = Math.max(0, intervalMs - (Date.now() - startTime));

    clearTimers();
    store.updateSettings({ game_state: 'paused', paused_remaining_ms: remaining, paused_from_state: fromState });
    broadcastState();
    return true;
  },

  // Resume a paused game back into whichever phase it was paused from.
  // To make the existing "time elapsed since phase start" calculation still work,
  // we synthesise a fake start time that is offset into the past by however
  // much of the phase had already elapsed.  This way getFullGameState() and
  // endRound()/startNextRound() don't need a special "paused" code path.
  resumeGame() {
    const settings  = store.getSettings();
    if (settings.game_state !== 'paused') return false;

    const fromState  = settings.paused_from_state || 'running';
    const intervalMs = fromState === 'running'
      ? settings.reset_interval_minutes * 60 * 1000
      : settings.intermission_minutes * 60 * 1000;
    const remaining  = settings.paused_remaining_ms || intervalMs;
    // If we have `remaining` ms left and the phase is `intervalMs` ms long,
    // then the phase "started" (intervalMs - remaining) ms ago.
    const fakeStart  = Date.now() - (intervalMs - remaining);

    const updates = { game_state: fromState, paused_remaining_ms: null, paused_from_state: null };
    if (fromState === 'running') updates.reset_start_time = fakeStart;
    else                         updates.intermission_start_time = fakeStart;
    store.updateSettings(updates);

    if (fromState === 'running') scheduleReset(remaining);
    else                          scheduleIntermission(remaining);

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
      intermission_start_time: null,
      paused_remaining_ms: null,
      paused_from_state: null,
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
    if (settings.game_state !== 'running') {
      return {
        success: false,
        error: settings.game_state === 'intermission'
          ? 'Intermission — capture reopens when the next round starts'
          : 'Game is not currently running'
      };
    }

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

  // Capture a location on behalf of a team directly (no user account needed).
  // Used by the guest capture flow where non-logged-in users pick a team.
  captureLocationForTeam(locationId, teamId) {
    const team = store.getTeam(teamId);
    if (!team) return { success: false, error: 'Team not found' };

    const settings = store.getSettings();
    if (settings.game_state !== 'running') {
      return {
        success: false,
        error: settings.game_state === 'intermission'
          ? 'Intermission — capture reopens when the next round starts'
          : 'Game is not currently running'
      };
    }

    const location = store.getLocation(locationId);
    if (!location) return { success: false, error: 'Location not found' };

    if (location.controlling_team_id === teamId) {
      return { success: false, error: `${team.name} already controls ${location.name}!` };
    }

    store.updateLocation(locationId, { controlling_team_id: teamId });

    io.emit('locationCaptured', {
      locationId,
      locationName: location.name,
      teamId,
      teamName: team.name,
      teamColor: team.color,
      capturedBy: 'Guest',
      previousTeamId: location.controlling_team_id
    });

    broadcastState();

    return {
      success: true,
      message: `${location.name} captured for ${team.name}!`,
      location: location.name,
      team: team.name,
      teamColor: team.color,
      pointValue: location.current_point_value
    };
  },

  // Broadcast an SOS alert to every connected client.
  // opts.name is the display name of whoever triggered it (player name or "Admin").
  triggerSOS(opts = {}) {
    const name = opts.name || 'Unknown';
    io.emit('sosAlert', { timestamp: Date.now(), triggeredBy: name });

    const msg = store.insertMessage({
      authorId:   null,
      authorName: 'System',
      teamId:     null,
      teamColor:  null,
      channel:    'all',
      text:       `🚨 EMERGENCY SOS — ${name} has called all players to return to base immediately.`
    });
    io.emit('chatMessage', msg);
  },

  broadcast: broadcastState,
  getFullGameState
};
