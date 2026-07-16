// ─────────────────────────────────────────────
//  store.js  –  In-memory data store with JSON file persistence
//
//  All data lives in plain JavaScript arrays in memory for fast access.
//  Every write immediately flushes to a JSON file in data/ so the state
//  survives a server restart.
//
//  Files use an atomic write pattern: write to a .tmp file first, then
//  rename over the real file.  This prevents a half-written (corrupt) file
//  if the process crashes mid-write.
//
//  Data files:
//    data/settings.json  –  game configuration and runtime state flags
//    data/teams.json     –  team definitions and accumulated scores
//    data/users.json     –  registered players
//    data/locations.json –  capturable map locations
//    data/messages.json  –  in-game chat messages (capped at 200)
// ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) { return path.join(DATA_DIR, name + '.json'); }

// Read a JSON file.  Returns `def` if the file doesn't exist or is corrupt —
// this handles a fresh install gracefully.
function load(name, def) {
  try { return JSON.parse(fs.readFileSync(filePath(name), 'utf8')); }
  catch { return def; }
}

// Atomic write: serialise to a .tmp file and then rename into place.
// On most filesystems rename() is atomic, so readers never see a partial write.
function save(name, data) {
  const file = filePath(name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── In-memory state ──────────────────────────

// All the keys a fresh settings file should contain.
// Also used as the source of truth when migrating older files that are
// missing keys added in later versions of the app.
const DEFAULT_SETTINGS = {
  admin_password_hash: null,
  num_teams: 2,
  reset_interval_minutes: 10,
  intermission_minutes: 2,     // length of the break between rounds
  total_resets: 5,
  max_point_value: 10,
  game_state: 'waiting',       // waiting | countdown | running | intermission | paused | ended
  current_reset: 0,            // how many rounds have completed
  reset_start_time: null,      // Date.now() when the current round started
  intermission_start_time: null, // Date.now() when the current intermission began
  paused_remaining_ms: null,   // ms left on the round/intermission timer when the game was paused
  paused_from_state: null,     // 'running' | 'intermission' — which phase to restore on resume
  game_start_time: null,       // Date.now() when the current game started
  countdown_end_time: null,    // Date.now() target when pre-game countdown expires
  map_image: null,             // filename of the uploaded map (e.g. "map.jpg")
  qr_mode: 'url',              // 'url' = public URL QR | 'custom' = app-only CONQUEST: format | 'stable' = name-based CONQUEST:NAME: format
  team_chat_enabled: true      // false hides the team channel and filters team messages
};

let settings  = load('settings', { ...DEFAULT_SETTINGS });
let teams     = load('teams', []);
let users     = load('users', []);
let locations = load('locations', []);

// Forward-compatibility: if a settings file from an older version is missing
// any keys that were added later, fill them in with their defaults and
// immediately persist so future restarts don't need the loop again.
let _settingsMigrated = false;
for (const k of Object.keys(DEFAULT_SETTINGS)) {
  if (!(k in settings)) { settings[k] = DEFAULT_SETTINGS[k]; _settingsMigrated = true; }
}
if (_settingsMigrated) save('settings', settings);

// Generate the next integer ID for a new record by taking the current maximum
// and adding 1.  Using max() rather than array.length means IDs stay unique
// even if records have been deleted.
function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

// ── Settings ─────────────────────────────────

// Return a shallow copy so callers can't accidentally mutate the live object.
function getSettings() { return { ...settings }; }

function updateSettings(updates) {
  Object.assign(settings, updates);
  save('settings', settings);
}

// ── Teams ─────────────────────────────────────

function getTeams() { return [...teams]; }
function getTeam(id) { return teams.find(t => t.id === id) || null; }

function insertTeam(data) {
  // total_points defaults to 0 but can be overridden by data if needed.
  const team = { total_points: 0, ...data, id: nextId(teams) };
  teams.push(team);
  save('teams', teams);
  return { ...team };
}

function updateTeam(id, updates) {
  const idx = teams.findIndex(t => t.id === id);
  if (idx === -1) return null;
  teams[idx] = { ...teams[idx], ...updates };
  save('teams', teams);
  return { ...teams[idx] };
}

// Deleting a team cascades to users and locations so we don't end up with
// orphaned references.  All three files are saved together in one operation
// (three individual saves — not truly atomic, but acceptable for this use-case).
function deleteTeam(id) {
  teams     = teams.filter(t => t.id !== id);
  users     = users.map(u => u.team_id === id ? { ...u, team_id: null } : u);
  locations = locations.map(l => l.controlling_team_id === id ? { ...l, controlling_team_id: null } : l);
  save('teams', teams);
  save('users', users);
  save('locations', locations);
}

// Zero out scores for all teams — called at the start of every new game.
function resetTeamPoints() {
  teams = teams.map(t => ({ ...t, total_points: 0 }));
  save('teams', teams);
}

// Add `points` to a team's running total — called during processReset().
function addTeamPoints(teamId, points) {
  const idx = teams.findIndex(t => t.id === teamId);
  if (idx !== -1) {
    teams[idx] = { ...teams[idx], total_points: (teams[idx].total_points || 0) + points };
    save('teams', teams);
  }
}

// ── Users ─────────────────────────────────────

function getUsers() { return [...users]; }
function getUser(id) { return users.find(u => u.id === id) || null; }

// Lookup is case-insensitive so "Alpha" and "alpha" resolve to the same player.
function getUserByUsername(username) {
  return users.find(u => u.username.toLowerCase() === username.toLowerCase()) || null;
}

function insertUser(data) {
  // created_at is a Unix timestamp (seconds) — used mainly for sorting in the admin UI.
  const user = { team_id: null, created_at: Math.floor(Date.now() / 1000), is_admin: false, ...data, id: nextId(users) };
  users.push(user);
  save('users', users);
  return { ...user };
}

function updateUser(id, updates) {
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...updates };
  save('users', users);
  return { ...users[idx] };
}

function deleteUser(id) {
  users = users.filter(u => u.id !== id);
  save('users', users);
}

function clearUsers() {
  users = [];
  save('users', users);
}

// Returns a user record with team fields joined in — avoids the caller having
// to do a separate getTeam() lookup.
function getUserWithTeam(id) {
  const user = getUser(id);
  if (!user) return null;
  const team = user.team_id ? teams.find(t => t.id === user.team_id) : null;
  return { ...user, team_name: team?.name || null, team_color: team?.color || null };
}

// Returns all users sorted alphabetically with team fields joined.
// Used by the admin player management table.
function getUsersWithTeam() {
  return users
    .map(user => {
      const team = user.team_id ? teams.find(t => t.id === user.team_id) : null;
      return { ...user, team_name: team?.name || null, team_color: team?.color || null };
    })
    .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
}

// ── Messages ──────────────────────────────────

let messages = load('messages', []);

function getMessages() { return [...messages]; }

function insertMessage(data) {
  const msg = { ...data, id: nextId(messages), timestamp: Date.now() };
  messages.push(msg);
  // Cap the in-memory (and on-disk) history at 200 messages to prevent the
  // file growing unboundedly across long events.
  if (messages.length > 200) messages = messages.slice(-200);
  save('messages', messages);
  return { ...msg };
}

function clearMessages() {
  messages = [];
  save('messages', messages);
}

// ── Locations ─────────────────────────────────

function getLocations() { return [...locations]; }
function getLocation(id) { return locations.find(l => l.id === id) || null; }

// Look up a location by both its ID and its capture token together — both must
// match, which prevents someone from guessing a location ID and capturing it
// without the physical QR code.
function getLocationByToken(id, token) {
  return locations.find(l => l.id === id && l.capture_token === token) || null;
}

// Normalize a location name to a URL-safe slug for stable QR codes.
function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getLocationBySlug(slug) {
  return locations.find(l => toSlug(l.name) === slug) || null;
}

function insertLocation(data) {
  // New locations start with no controlling team and aren't forced low-tier.
  const loc = { controlling_team_id: null, force_low_tier: false, ...data, id: nextId(locations) };
  locations.push(loc);
  save('locations', locations);
  return { ...loc };
}

function updateLocation(id, updates) {
  const idx = locations.findIndex(l => l.id === id);
  if (idx === -1) return null;
  locations[idx] = { ...locations[idx], ...updates };
  save('locations', locations);
  return { ...locations[idx] };
}

function deleteLocation(id) {
  locations = locations.filter(l => l.id !== id);
  save('locations', locations);
}

// Remove all team ownership at the end of a round so the next round starts fresh.
function resetAllLocationControl() {
  locations = locations.map(l => ({ ...l, controlling_team_id: null }));
  save('locations', locations);
}

// Assign each location a new random point value between 1 and maxPts.
// Called at game start and after each reset so point values vary between rounds,
// encouraging teams to re-evaluate which locations are worth fighting over.
// Locations flagged `force_low_tier` always land in the 1–4 range, independent
// of the tier lottery below — they're excluded from it entirely.
function randomizeLocationPoints(numTeams) {
  // Pick a random integer between lo and hi inclusive.
  const rand = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

  const valueMap = {};

  const forced = locations.filter(l => l.force_low_tier);
  const normal = locations.filter(l => !l.force_low_tier);
  for (const l of forced) valueMap[l.id] = rand(1, 4);

  // Shuffle location IDs so tier assignment varies each round.
  const ids = normal.map(l => l.id).sort(() => Math.random() - 0.5);

  const values = [];

  // Tier 1: exactly 1 location guaranteed 9 or 10.
  if (ids.length > values.length) values.push(rand(9, 10));

  // Tier 2: max(0, numTeams - 2) locations — 75% chance of 8–10, else 1–4.
  const tier2Count = Math.max(0, numTeams - 2);
  for (let i = 0; i < tier2Count && ids.length > values.length; i++) {
    values.push(Math.random() < 0.75 ? rand(8, 10) : rand(1, 4));
  }

  // Tier 3: 1 location — 25% chance of 5 or 6, else 1–4.
  if (ids.length > values.length) {
    values.push(Math.random() < 0.25 ? rand(5, 6) : rand(1, 4));
  }

  // Tier 4: all remaining locations at 1–4.
  while (values.length < ids.length) values.push(rand(1, 4));

  // Map values back to locations by shuffled ID order.
  ids.forEach((id, i) => { valueMap[id] = values[i]; });
  locations = locations.map(l => ({ ...l, current_point_value: valueMap[l.id] }));
  save('locations', locations);
}

// Returns locations with controlling team fields joined in — used by the map
// renderer on both the player dashboard and the admin panel.
function getLocationsWithTeam() {
  return locations.map(loc => {
    const team = loc.controlling_team_id ? teams.find(t => t.id === loc.controlling_team_id) : null;
    return { ...loc, team_name: team?.name || null, team_color: team?.color || null };
  });
}

module.exports = {
  getSettings, updateSettings,
  getTeams, getTeam, insertTeam, updateTeam, deleteTeam, resetTeamPoints, addTeamPoints,
  getUsers, getUser, getUserByUsername, insertUser, updateUser, deleteUser, clearUsers, getUserWithTeam, getUsersWithTeam,
  getMessages, insertMessage, clearMessages,
  getLocations, getLocation, getLocationByToken, getLocationBySlug, toSlug,
  insertLocation, updateLocation, deleteLocation,
  resetAllLocationControl, randomizeLocationPoints, getLocationsWithTeam
};
