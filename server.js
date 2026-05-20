// ─────────────────────────────────────────────
//  server.js  –  Express HTTP + Socket.IO server
//
//  Responsibilities:
//   • Serve static files (public/) and uploaded images (uploads/)
//   • Handle all REST API routes for auth, game control, and chat
//   • Wire up Socket.IO so the game engine can push live updates
//     to every connected browser
// ─────────────────────────────────────────────

const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const QRCode  = require('qrcode');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');

const store      = require('./store');
const gameEngine = require('./gameEngine');

// Wrap Express inside a plain Node http.Server so Socket.IO can share the
// same port rather than needing its own.
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

// Trust the X-Forwarded-Proto header set by Cloudflare (and other proxies).
// Without this, Express sees the Cloudflare→server leg as plain HTTP and
// refuses to set secure session cookies, breaking login entirely.
app.set('trust proxy', 1);

// Give the game engine a reference to Socket.IO so it can push events
// (timer ticks, captures, resets, etc.) to all connected clients.
gameEngine.init({ io });

// Make sure the uploads directory exists before multer tries to write into it.
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// ── Multer (file upload) ─────────────────────
//
// Multer is configured to save every uploaded map as "map.<ext>" (e.g. map.jpg),
// overwriting whatever was there before.  That way the server never accumulates
// stale map files and the filename is always predictable.

const mapStorage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'map' + ext);
  }
});

const uploadMap = multer({
  storage: mapStorage,
  limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB cap — maps can be hi-res
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files allowed'));
  }
});

// ── Middleware ───────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded map images at /uploads/<filename>
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  // Use a stable secret from the environment in production so sessions survive
  // a server restart.  In development a random secret is fine (everyone just
  // gets logged out when the process restarts).
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Only send the cookie over HTTPS in production to protect the session ID.
    secure: process.env.NODE_ENV === 'production',
    // httpOnly prevents client-side JS from reading the cookie — blocks XSS theft.
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

// Middleware: redirect unauthenticated users to /login.
// For API routes we return JSON instead of a redirect, because the client is
// fetch()-ing and can't follow a redirect.
// We also save the original URL so after login we can bounce them back to where
// they were trying to go (e.g. a QR-code capture link).
// Note: the `authorized` field on users controls map access only — unauthorized
// users still reach the dashboard and can use chat, SOS, and the player roster.
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
};

// Middleware: blocks non-admin requests to admin API routes.
// Admin auth is tracked separately from player auth in the same session object.
const requireAdmin = (req, res, next) => {
  if (!req.session.adminAuthenticated) return res.status(401).json({ error: 'Admin access required' });
  next();
};

// ── Page routes ──────────────────────────────

// Root just redirects based on login state — there's no content at "/"
app.get('/', (req, res) => res.redirect(req.session.userId ? '/dashboard' : '/login'));

app.get('/login', (req, res) => {
  // Already logged in — no reason to show the login page
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// /register has its own dedicated page
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the guest team-selection capture page (no auth needed — anyone who
// scans a QR code and isn't logged in lands here to pick a team).
// Logged-in users are sent back through the authenticated capture route instead.
app.get('/capture-guest/:locationId/:token', (req, res) => {
  if (req.session.userId) {
    return res.redirect(`/capture/${req.params.locationId}/${req.params.token}`);
  }
  const location = store.getLocationByToken(parseInt(req.params.locationId), req.params.token);
  if (!location) return res.status(404).send('<h1>Invalid QR code</h1>');
  res.sendFile(path.join(__dirname, 'public', 'capture.html'));
});

// Admin panel has its own password — it's not tied to any player account.
// No requireAdmin middleware here: the HTML page handles its own auth overlay.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// QR code capture route — a player scans a QR code at a physical location,
// their phone opens this URL, the server performs the capture, then redirects
// back to the dashboard with a success/failure query string.
// Guests (not logged in) are redirected to the team-selection page instead.
app.get('/capture/:locationId/:token', (req, res) => {
  const { locationId, token } = req.params;
  const location = store.getLocationByToken(parseInt(locationId), token);
  if (!location) return res.status(404).send('<h1>Invalid QR code</h1>');

  if (!req.session.userId) {
    return res.redirect(`/capture-guest/${locationId}/${token}`);
  }

  const result = gameEngine.captureLocation(location.id, req.session.userId);
  const qs = result.success
    ? `?captured=${encodeURIComponent(result.location)}&team=${encodeURIComponent(result.team)}`
    : `?capture_error=${encodeURIComponent(result.error)}`;
  res.redirect('/dashboard' + qs);
});

// ── Auth API ─────────────────────────────────

// Shared validation used by both /api/register and /api/login.
// Returns an error message string, or null if everything looks good.
function validateCredentials(raw, password) {
  if (!raw)            return 'Please enter a callsign';
  if (raw.length < 2)  return 'Callsign must be at least 2 characters';
  if (raw.length > 30) return 'Callsign must be 30 characters or less';
  if (!/^[a-zA-Z0-9 _\-]+$/.test(raw)) return 'Callsign can only contain letters, numbers, spaces, hyphens, and underscores';
  if (!password || password.length < 4) return 'Password must be at least 4 characters';
  return null;
}

app.post('/api/register', async (req, res) => {
  const raw      = (req.body.username || '').trim();
  const password = (req.body.password || '');
  const confirm  = (req.body.confirm  || '');

  const err = validateCredentials(raw, password);
  if (err) return res.status(400).json({ error: err });
  if (password !== confirm) return res.status(400).json({ error: 'Passwords do not match' });

  // Callsigns are case-insensitive — "Alpha" and "alpha" are the same player.
  if (store.getUserByUsername(raw)) return res.status(409).json({ error: 'That callsign is already taken' });

  // bcrypt cost factor 10 is the recommended default — expensive enough to slow
  // brute-force attacks but fast enough that a single login doesn't feel slow.
  // New accounts always start as unauthorized for map access — an admin must
  // approve them in the Players tab before they can see the map.
  const user = store.insertUser({
    username: raw,
    password_hash: await bcrypt.hash(password, 10),
    authorized: false
  });
  req.session.userId   = user.id;
  req.session.username = user.username;

  // Honour the returnTo URL saved before the redirect to /login.
  const returnTo = req.session.returnTo || '/dashboard';
  delete req.session.returnTo;
  res.json({ success: true, redirect: returnTo });
});

app.post('/api/login', async (req, res) => {
  const raw      = (req.body.username || '').trim();
  const password = (req.body.password || '');

  const err = validateCredentials(raw, password);
  if (err) return res.status(400).json({ error: err });

  const user = store.getUserByUsername(raw);
  if (!user) return res.status(404).json({ error: 'Callsign not found' });

  // bcrypt.compare handles null/empty hashes safely — returns false rather than throwing.
  if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.userId   = user.id;
  req.session.username = user.username;

  const returnTo = req.session.returnTo || '/dashboard';
  delete req.session.returnTo;
  res.json({ success: true, redirect: returnTo });
});

app.post('/api/logout', (req, res) => {
  // destroy() removes the session from the store and clears the cookie.
  req.session.destroy(() => res.json({ success: true }));
});

// ── Player API ───────────────────────────────

// Returns the logged-in player's record with their team info joined in.
// The dashboard uses this on load to know which team the player is on.
app.get('/api/player', requireAuth, (req, res) => {
  const user = store.getUserWithTeam(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// Full game state snapshot — used for initial page load before the Socket.IO
// connection is established.
app.get('/api/game-state', (req, res) => {
  res.json(gameEngine.getFullGameState());
});

// Returns all players on the same team as the logged-in player.
// Used by the Roster tab in the dashboard chat panel.
app.get('/api/player/teammates', requireAuth, (req, res) => {
  const user = store.getUser(req.session.userId);
  if (!user || !user.team_id) return res.json([]);
  const teammates = store.getUsers()
    .filter(u => u.team_id === user.team_id)
    .map(u => ({ id: u.id, username: u.username, role: u.role || null }))
    .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
  res.json(teammates);
});

// ── Capture API ──────────────────────────────

// GET version returns capture info without actually performing the capture —
// used by QR-code landing pages that want to show location details before
// the player taps "Capture".
app.get('/api/capture-info/:locationId/:token', (req, res) => {
  const loc = store.getLocationByToken(parseInt(req.params.locationId), req.params.token);
  if (!loc) return res.status(404).json({ error: 'Not found' });

  const team = loc.controlling_team_id ? store.getTeam(loc.controlling_team_id) : null;
  const location = { ...loc, team_name: team?.name || null, team_color: team?.color || null };

  const { game_state } = store.getSettings();
  const user = req.session.userId ? store.getUserWithTeam(req.session.userId) : null;
  const teams = store.getTeams().sort((a, b) => a.id - b.id);

  res.json({ location, gameState: game_state, user, teams });
});

// POST version actually performs the capture (called from the dashboard's
// camera FAB flow rather than the QR redirect).
app.post('/api/capture/:locationId/:token', requireAuth, (req, res) => {
  const loc = store.getLocationByToken(parseInt(req.params.locationId), req.params.token);
  if (!loc) return res.status(404).json({ error: 'Invalid capture code' });

  const result = gameEngine.captureLocation(loc.id, req.session.userId);
  res.status(result.success ? 200 : 400).json(result);
});

// Guest capture — no account required.  The team is chosen by the user on
// the /capture-guest page; we perform the capture directly for that team.
app.post('/api/capture-guest/:locationId/:token', (req, res) => {
  const loc = store.getLocationByToken(parseInt(req.params.locationId), req.params.token);
  if (!loc) return res.status(404).json({ error: 'Invalid capture code' });

  const teamId = parseInt(req.body.teamId);
  if (!teamId) return res.status(400).json({ error: 'Team required' });

  const result = gameEngine.captureLocationForTeam(loc.id, teamId);
  res.status(result.success ? 200 : 400).json(result);
});

// ── Admin Auth API ───────────────────────────

// Returns whether this session is already admin-authenticated, and whether
// an admin password has been set at all (first-run detection).
app.get('/api/admin/status', (req, res) => {
  const { admin_password_hash } = store.getSettings();
  res.json({ authenticated: !!req.session.adminAuthenticated, hasPassword: !!admin_password_hash });
});

app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  const { admin_password_hash } = store.getSettings();

  // First-ever admin login: no password hash exists yet, so we treat the
  // submitted password as the new password and store it.
  if (!admin_password_hash) {
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    store.updateSettings({ admin_password_hash: await bcrypt.hash(password, 10) });
    req.session.adminAuthenticated = true;
    return res.json({ success: true, firstSetup: true });
  }

  if (!(await bcrypt.compare(password, admin_password_hash))) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  req.session.adminAuthenticated = true;
  res.json({ success: true });
});

// Admin logout only clears the admin flag — the player session (if any) stays active.
app.post('/api/admin/logout', (req, res) => {
  req.session.adminAuthenticated = false;
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  store.updateSettings({ admin_password_hash: await bcrypt.hash(password, 10) });
  res.json({ success: true });
});

// ── Admin Settings API ───────────────────────

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const s = store.getSettings();
  // Only expose the fields the admin UI needs — don't leak the password hash.
  const settings = {
    num_teams: s.num_teams,
    reset_interval_minutes: s.reset_interval_minutes,
    total_resets: s.total_resets,
    max_point_value: s.max_point_value,
    game_state: s.game_state,
    map_image: s.map_image,
    qr_mode: s.qr_mode || 'url'
  };
  const teams = store.getTeams().sort((a, b) => a.id - b.id);
  res.json({ settings, teams });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const numTeams = parseInt(req.body.num_teams);
  const interval = parseInt(req.body.reset_interval_minutes);
  const resets   = parseInt(req.body.total_resets);
  const maxPts   = parseInt(req.body.max_point_value);

  if (isNaN(numTeams) || numTeams < 2 || numTeams > 6)   return res.status(400).json({ error: 'Teams must be 2–6' });
  if (isNaN(interval) || interval < 1 || interval > 120) return res.status(400).json({ error: 'Reset interval must be 1–120 minutes' });
  if (isNaN(resets)   || resets < 1   || resets > 99)    return res.status(400).json({ error: 'Total resets must be 1–99' });
  if (isNaN(maxPts)   || maxPts < 1   || maxPts > 100)   return res.status(400).json({ error: 'Max points must be 1–100' });

  const qrMode = req.body.qr_mode === 'custom' ? 'custom' : 'url';
  store.updateSettings({ num_teams: numTeams, reset_interval_minutes: interval, total_resets: resets, max_point_value: maxPts, qr_mode: qrMode });

  // Default team names and colours follow the NATO phonetic alphabet.
  // We only create teams that don't exist yet; teams beyond numTeams are deleted.
  const COLORS = ['#4488ff', '#ff4444', '#44bb44', '#ffaa00', '#bb44ff', '#ff44bb'];
  const NAMES  = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const existing = store.getTeams().sort((a, b) => a.id - b.id);

  for (let i = existing.length; i < numTeams; i++) {
    store.insertTeam({ name: NAMES[i], color: COLORS[i] });
  }
  // Deleting a team also un-assigns all its players and clears its location control.
  if (existing.length > numTeams) {
    for (let i = numTeams; i < existing.length; i++) {
      store.deleteTeam(existing[i].id);
    }
  }

  res.json({ success: true });
});

// Update team names and colours in bulk (used by the Teams config section).
app.post('/api/admin/teams', requireAdmin, (req, res) => {
  const { teams } = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'Invalid data' });
  for (const t of teams) {
    if (t.id && t.name && t.color) store.updateTeam(parseInt(t.id), { name: t.name, color: t.color });
  }
  res.json({ success: true });
});

// ── Admin Map API ────────────────────────────

app.post('/api/admin/upload-map', requireAdmin, uploadMap.single('map'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Remove any old map file with a different extension (e.g. if we had map.png
  // and now uploaded map.jpg, delete the old .png so we don't accumulate stale files).
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  for (const ext of exts) {
    const old = path.join(__dirname, 'uploads', 'map' + ext);
    if (old !== req.file.path && fs.existsSync(old)) fs.unlinkSync(old);
  }

  store.updateSettings({ map_image: req.file.filename });

  // Push the new map to all open dashboards immediately so players don't have
  // to refresh to see it.
  io.emit('gameState', gameEngine.getFullGameState());

  res.json({ success: true, filename: req.file.filename });
});

// ── Admin Locations API ──────────────────────

app.get('/api/admin/locations', requireAdmin, (req, res) => {
  res.json(store.getLocationsWithTeam());
});

app.post('/api/admin/locations', requireAdmin, (req, res) => {
  const { name, x_percent, y_percent } = req.body;
  if (!name || x_percent == null || y_percent == null) return res.status(400).json({ error: 'Name and position required' });

  const { max_point_value } = store.getSettings();
  const location = store.insertLocation({
    name,
    x_percent: parseFloat(x_percent),
    y_percent: parseFloat(y_percent),
    // Each new location starts with a random point value between 1 and max_point_value.
    current_point_value: Math.floor(Math.random() * max_point_value) + 1,
    // The capture token is a random secret embedded in the QR code URL so that
    // only someone physically present with the printed QR code can capture the location.
    capture_token: crypto.randomBytes(16).toString('hex')
  });

  res.json({ success: true, location });
});

app.put('/api/admin/locations/:id', requireAdmin, (req, res) => {
  const { name, x_percent, y_percent } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const updates = { name };
  // x_percent / y_percent are optional — omitting them leaves the pin position unchanged.
  if (x_percent != null) updates.x_percent = parseFloat(x_percent);
  if (y_percent != null) updates.y_percent = parseFloat(y_percent);

  const location = store.updateLocation(parseInt(req.params.id), updates);
  if (!location) return res.status(404).json({ error: 'Location not found' });
  res.json({ success: true, location });
});

app.delete('/api/admin/locations/:id', requireAdmin, (req, res) => {
  store.deleteLocation(parseInt(req.params.id));
  res.json({ success: true });
});

// Generate and download a QR code PNG for a location.
// The QR code encodes the full capture URL including the secret token, so
// printing it and sticking it to a physical object is all that's needed.
app.get('/api/admin/qr/:locationId', requireAdmin, async (req, res) => {
  const location = store.getLocation(parseInt(req.params.locationId));
  if (!location) return res.status(404).json({ error: 'Not found' });

  const { qr_mode } = store.getSettings();
  const content = qr_mode === 'custom'
    ? `CONQUEST:${location.id}:${location.capture_token}`
    : `${req.protocol}://${req.get('host')}/capture/${location.id}/${location.capture_token}`;

  // Generate the QR code as SVG paths (fully vector — sharp at any zoom/print size).
  const qrSvgRaw = await QRCode.toString(content, { type: 'svg', errorCorrectionLevel: 'H', margin: 2 });

  // Extract the viewBox and inner elements from the generated SVG so we can
  // nest them inside our labelled wrapper SVG.
  const viewBox  = (qrSvgRaw.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 41 41';
  const qrInner  = (qrSvgRaw.match(/<svg[^>]*>([\s\S]*?)<\/svg>/) || [])[1] || '';

  const modeLabel = qr_mode === 'custom' ? 'Private (app-only)' : 'Public URL';
  const safeName  = location.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="480" viewBox="0 0 400 480">
  <rect width="400" height="480" fill="white"/>
  <svg x="20" y="20" width="360" height="360" viewBox="${viewBox}">${qrInner}</svg>
  <text x="200" y="415" text-anchor="middle"
        font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="bold" fill="#111">${safeName}</text>
  <text x="200" y="450" text-anchor="middle"
        font-family="Arial,Helvetica,sans-serif" font-size="15" fill="#555">${modeLabel}</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${location.name.replace(/[^a-z0-9]/gi, '_')}-qr.svg"`);
  res.send(svg);
});

// ── Admin Players API ────────────────────────

app.get('/api/admin/players', requireAdmin, (req, res) => {
  res.json(store.getUsersWithTeam());
});

// Assign (or un-assign) a player to a team.  teamId can be null to remove them.
app.post('/api/admin/assign-team', requireAdmin, (req, res) => {
  const { userId, teamId } = req.body;
  store.updateUser(parseInt(userId), { team_id: teamId ? parseInt(teamId) : null });
  res.json({ success: true });
});

// Approve a player for map access.
app.post('/api/admin/authorize-user/:id', requireAdmin, (req, res) => {
  const user = store.updateUser(parseInt(req.params.id), { authorized: true });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Revoke a player's map access.
app.post('/api/admin/unauthorize-user/:id', requireAdmin, (req, res) => {
  const user = store.updateUser(parseInt(req.params.id), { authorized: false });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Set a player's role label (free-text, e.g. "Captain", "Scout").
// An empty string clears the role.
app.post('/api/admin/players/:id/role', requireAdmin, (req, res) => {
  const role = (req.body.role || '').trim().substring(0, 30) || null;
  const user = store.updateUser(parseInt(req.params.id), { role });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

app.delete('/api/admin/players/:id', requireAdmin, (req, res) => {
  store.deleteUser(parseInt(req.params.id));
  res.json({ success: true });
});

// Wipe the entire player list — useful between games at an event.
app.delete('/api/admin/players', requireAdmin, (req, res) => {
  store.clearUsers();
  res.json({ success: true });
});

// Shuffle all players evenly across teams in round-robin order.
// Uses a Fisher-Yates-style shuffle (sort with random comparator) then
// assigns team[i % numTeams] to each player.
app.post('/api/admin/random-teams', requireAdmin, (req, res) => {
  const teams   = store.getTeams().sort((a, b) => a.id - b.id);
  const players = store.getUsers();
  if (teams.length === 0) return res.status(400).json({ error: 'No teams configured' });

  const shuffled = [...players].sort(() => Math.random() - 0.5);
  shuffled.forEach((p, i) => store.updateUser(p.id, { team_id: teams[i % teams.length].id }));

  res.json({ success: true });
});

// ── Admin Game Control API ───────────────────

app.post('/api/admin/start-game', requireAdmin, (req, res) => {
  const { game_state } = store.getSettings();
  if (game_state === 'running' || game_state === 'countdown') {
    return res.status(400).json({ error: 'Game is already running' });
  }
  if (store.getLocations().length === 0) {
    return res.status(400).json({ error: 'No locations configured. Add locations first.' });
  }

  // countdown_seconds is optional — pass 0 (or omit) to start immediately.
  gameEngine.startGame(parseInt(req.body.countdown_seconds) || 0);
  res.json({ success: true });
});

// Same endpoint handles both pause and resume — the server decides based on
// current game state.
app.post('/api/admin/pause-game', requireAdmin, (req, res) => {
  const { game_state } = store.getSettings();
  if (game_state === 'running') {
    gameEngine.pauseGame();
    return res.json({ success: true, action: 'paused' });
  } else if (game_state === 'paused') {
    gameEngine.resumeGame();
    return res.json({ success: true, action: 'resumed' });
  }
  res.status(400).json({ error: 'Game is not running or paused' });
});

app.post('/api/admin/end-game',   requireAdmin, (req, res) => { gameEngine.endGame();   res.json({ success: true }); });
app.post('/api/admin/reset-game', requireAdmin, (req, res) => { gameEngine.resetGame(); res.json({ success: true }); });
app.post('/api/admin/sos',        requireAdmin, (req, res) => { gameEngine.triggerSOS({ name: 'Admin' }); res.json({ success: true }); });

// Players can also trigger SOS from their own dashboard.
app.post('/api/player/sos', requireAuth, (req, res) => {
  const name = req.session.username || store.getUser(req.session.userId)?.username || 'Unknown';
  gameEngine.triggerSOS({ name });
  res.json({ success: true });
});

// ── Chat API ─────────────────────────────────

// Returns messages visible to this player: all "all-channel" messages plus
// any "team" messages that belong to their own team.
// Players without a team will only see all-channel messages.
app.get('/api/chat/messages', requireAuth, (req, res) => {
  const user = store.getUserWithTeam(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const msgs = store.getMessages().filter(m =>
    m.channel === 'all' || (m.channel === 'team' && m.teamId === user.team_id)
  );
  res.json(msgs);
});

app.post('/api/chat/message', requireAuth, (req, res) => {
  const text = (req.body.text || '').trim();
  const { channel } = req.body;
  if (!text) return res.status(400).json({ error: 'Message cannot be empty' });
  if (text.length > 300) return res.status(400).json({ error: 'Message too long (max 300 chars)' });
  if (!['all', 'team'].includes(channel)) return res.status(400).json({ error: 'Invalid channel' });

  const user = store.getUserWithTeam(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (channel === 'team' && !user.team_id) return res.status(400).json({ error: 'You are not on a team' });

  const msg = store.insertMessage({
    authorId: user.id,
    authorName: user.username,
    teamId: user.team_id,
    teamColor: user.team_color,
    channel,
    text
  });

  // Broadcast to all connected sockets; each client's dashboard filters
  // team messages to show only those matching the viewer's team.
  io.emit('chatMessage', msg);
  res.json({ success: true, message: msg });
});

// ── Socket.IO ────────────────────────────────

// When a new browser connects, immediately send it the full current game state
// so it doesn't have to wait for the next broadcast.
io.on('connection', (socket) => {
  socket.emit('gameState', gameEngine.getFullGameState());
});

// ── Start ────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Game server running at http://localhost:${PORT}`);
  console.log(`Admin panel:         http://localhost:${PORT}/admin`);
});
