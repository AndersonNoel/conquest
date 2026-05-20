// ─────────────────────────────────────────────
//  dashboard.js  –  Player-facing game dashboard
//
//  Responsibilities:
//   • Connect to the server via Socket.IO and keep the UI in sync with
//     live game state updates (map pins, scores, timer, chat).
//   • Render the interactive map with location pins positioned over the
//     uploaded map image.
//   • Handle in-game chat (two channels: "all players" and "my team").
//   • Enable pinch-to-zoom and single-finger pan on the map for mobile.
//   • Show overlays for game-over results and SOS alerts.
// ─────────────────────────────────────────────

const socket = io();

// The logged-in player's profile, fetched from /api/player on load.
let player = null;

// Most recent full game state received from the server — kept so the map
// and timer can be re-rendered when related events arrive (e.g. timerTick).
let lastGameState = null;

// Prevents the game-over overlay from reappearing once the player dismisses it
// during the same game session.
let gameOverDismissed = false;

// On very first state arrival we suppress the game-over overlay for games
// that were already ended before this player connected (they didn't play it,
// so they shouldn't be shown the results banner immediately).
let firstStateReceived = false;

async function init() {
  const res = await fetch('/api/player');
  // If the session has expired, bounce back to login.
  if (res.status === 401) { window.location.href = '/login'; return; }
  player = await res.json();
  applyMapAuthorization();
  renderPlayerHeader();
  loadMessages();

  // The QR-code capture route redirects here with query params to show a toast.
  const params = new URLSearchParams(window.location.search);
  if (params.has('captured')) {
    toast(`${params.get('captured')} captured for ${params.get('team')}!`, 'success');
    // Clean up the URL so refreshing doesn't re-show the toast.
    history.replaceState({}, '', '/dashboard');
  } else if (params.has('capture_error')) {
    toast(params.get('capture_error'), 'danger');
    history.replaceState({}, '', '/dashboard');
  }
}

// Show or hide the map based on the player's authorization status.
// Unauthorized players see the default placeholder but can still use the Capture FAB.
// renderMap() also checks this flag to prevent the socket state update from
// overriding the hidden state.
function applyMapAuthorization() {
  const locked = player && player.authorized === false;
  if (locked) {
    document.getElementById('map-placeholder').style.display = 'none';
    document.getElementById('map-viewport').style.display   = 'none';
  }
}

// Show the player's callsign and coloured team badge in the header.
// If they haven't been assigned to a team yet, just show the callsign.
function renderPlayerHeader() {
  const hdr = document.getElementById('header-player-info');
  if (!player.team_id) {
    hdr.innerHTML = `<span class="hdr-username" style="color:var(--text-muted)">${player.username}</span>`;
  } else {
    hdr.innerHTML = `
      <span class="hdr-username" style="color:var(--text-muted); margin-right:4px">${player.username}</span>
      <span class="team-badge" style="background:${player.team_color}">${player.team_name}</span>`;
  }
}

// Format milliseconds as MM:SS, rounding up so the display reaches 00:00
// at the exact moment the timer expires rather than jumping from 00:01.
function formatTime(ms) {
  if (ms == null) return '--:--';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Info bar rendering ───────────────────────

function renderInfoBar(state) {
  // Status chip
  const statusMap = {
    waiting:   ['status-waiting',   'Waiting'],
    countdown: ['status-countdown', 'Countdown'],
    running:   ['status-running',   'Live'],
    paused:    ['status-paused',    'Paused'],
    ended:     ['status-ended',     'Game Over']
  };
  const [cls, label] = statusMap[state.gameState] || ['status-waiting', state.gameState];
  document.getElementById('info-status').innerHTML = `<div class="status-chip ${cls}">${label}</div>`;

  // Round counter — only meaningful while the game is active.
  const roundEl = document.getElementById('info-round');
  if (['running', 'paused', 'ended'].includes(state.gameState)) {
    // currentReset is 0-indexed (0 = first round in progress), so add 1 for display.
    roundEl.innerHTML = `Round <strong>${state.currentReset + 1}</strong>&thinsp;/&thinsp;<strong>${state.totalResets}</strong>`;
  } else {
    roundEl.innerHTML = '';
  }

  updateTimerDisplay(state);
  renderScoreChips(state.teams);
}

// Update just the timer portion of the info bar.
// Called both from renderInfoBar (full redraw) and from the timerTick /
// countdownTick socket events (lightweight update every second).
function updateTimerDisplay(state) {
  const timerEl = document.getElementById('info-timer');
  const labelEl = document.getElementById('info-timer-label');

  timerEl.className = 'info-timer';

  if (state.gameState === 'running') {
    timerEl.textContent = formatTime(state.timeRemaining);
    labelEl.textContent = 'next reset';
  } else if (state.gameState === 'countdown') {
    timerEl.textContent = formatTime(state.countdownRemaining);
    timerEl.classList.add('countdown');
    labelEl.textContent = 'game starts';
  } else if (state.gameState === 'paused') {
    timerEl.textContent = formatTime(state.timeRemaining);
    timerEl.classList.add('paused');
    labelEl.textContent = 'paused';
  } else if (state.gameState === 'ended') {
    timerEl.textContent = 'END';
    timerEl.classList.add('ended');
    labelEl.textContent = 'game over';
  } else {
    timerEl.textContent = '--:--';
    labelEl.textContent = 'waiting';
  }
}

// Render one coloured score pill per team, sorted by descending score.
// The player's own team gets a highlighted border so they can spot it quickly.
function renderScoreChips(teams) {
  const el = document.getElementById('info-scores');
  if (!teams || teams.length === 0) { el.innerHTML = ''; return; }

  const sorted = [...teams].sort((a, b) => b.total_points - a.total_points);
  el.innerHTML = sorted.map((t, i) => {
    const isMe = player && player.team_id === t.id;
    const rankIcon = '';
    return `
      <div class="team-score-chip ${isMe ? 'my-team' : ''}"
           style="${isMe ? `border-color:${t.color}` : ''}">
        <span style="width:9px;height:9px;border-radius:50%;background:${t.color};flex-shrink:0;display:inline-block"></span>
        <span style="${isMe ? `color:${t.color}` : ''}">${rankIcon}${t.name}</span>
        <strong style="font-size:1rem; color:var(--accent)">${t.total_points}</strong>
      </div>`;
  }).join('');
}

// ── Map rendering ────────────────────────────

// Calculate the actual pixel rectangle occupied by the image inside its
// container element, taking the CSS object-fit rendering into account.
//
// Because the image is rendered with object-fit: contain (or cover on mobile),
// it may not fill the full container — there will be letterbox bars on two sides.
// Pin positions are stored as percentages of the image itself, so we need to
// know where the image actually starts/ends inside the container to convert
// those percentages to pixel offsets.
//
// Returns { x, y, w, h } in pixels, or null if the image isn't loaded yet.
function getImageBounds(img) {
  const cw = img.clientWidth;
  const ch = img.clientHeight;
  if (!cw || !ch || !img.naturalWidth) return null;

  const imgRatio = img.naturalWidth / img.naturalHeight;
  const containerRatio = cw / ch;
  const cover = window.getComputedStyle(img).objectFit === 'cover';
  let w, h, x, y;

  // object-fit: contain → the image fits entirely inside the container (letterboxed).
  //   Wider-than-container → full width, pillarboxed top/bottom.
  //   Taller-than-container → full height, letterboxed left/right.
  // object-fit: cover → image fills the container, cropped on two sides.
  //   The inequality is inverted compared to contain.
  if (cover ? (imgRatio < containerRatio) : (imgRatio > containerRatio)) {
    w = cw;  h = cw / imgRatio;  x = 0;            y = (ch - h) / 2;
  } else {
    h = ch;  w = ch * imgRatio;  x = (cw - w) / 2; y = 0;
  }

  return { x, y, w, h };
}

// Place map pins over the image by converting each location's percentage
// coordinates into absolute pixel positions within the overlay div.
// All pins are rebuilt from scratch on each call — simple and always correct.
function renderPins(locations) {
  const overlay = document.getElementById('map-overlay');
  const img = document.getElementById('map-img');

  // If the map hasn't loaded yet (or isn't shown), clear any stale pins.
  if (!img || img.style.display === 'none' || !img.naturalWidth) {
    overlay.innerHTML = '';
    return;
  }

  const bounds = getImageBounds(img);
  if (!bounds) { overlay.innerHTML = ''; return; }

  overlay.innerHTML = locations.map(loc => {
    // Convert the stored percentage (0–100) to pixels within the actual image area.
    const px = bounds.x + (loc.x_percent / 100) * bounds.w;
    const py = bounds.y + (loc.y_percent / 100) * bounds.h;
    const color = loc.team_color || 'var(--uncontrolled)';
    const teamLabel = loc.team_name || 'Uncontrolled';
    return `
      <div class="map-pin" style="left:${px}px; top:${py}px">
        <div class="pin-circle" style="background:${color}">${loc.current_point_value}</div>
        <div class="pin-label">${loc.name} &bull; ${teamLabel}</div>
      </div>`;
  }).join('');
}

function renderMap(state) {
  // Don't touch the map DOM if the player isn't authorized — the locked message
  // is already showing and we don't want to reveal anything beneath it.
  if (player && player.authorized === false) return;

  const placeholder = document.getElementById('map-placeholder');
  const img = document.getElementById('map-img');

  if (!state.mapImage) {
    placeholder.style.display = 'flex';
    img.style.display = 'none';
    document.getElementById('map-overlay').innerHTML = '';
    return;
  }

  placeholder.style.display = 'none';
  img.style.display = 'block';

  const newSrc = `/uploads/${state.mapImage}`;
  if (img.src !== newSrc && !img.src.endsWith(state.mapImage)) {
    img.src = newSrc;
    // Don't call renderPins yet — the image dimensions won't be available until
    // the load event fires.  onMapImageLoad() handles the deferred call.
  } else {
    renderPins(state.locations);
  }
}

// Called by the img element's onload attribute once the image has loaded.
// We can't calculate bounds before this because naturalWidth/Height are 0.
function onMapImageLoad() {
  if (lastGameState) renderPins(lastGameState.locations);
}

// When the window resizes the image may reflow, changing the pixel bounds
// that getImageBounds() returns — re-render pins to stay aligned.
window.addEventListener('resize', () => {
  if (lastGameState) renderPins(lastGameState.locations);
});

// ── Game over overlay ────────────────────────

function showGameOver(state) {
  const el = document.getElementById('game-over-overlay');
  const podium = document.getElementById('game-over-podium');
  if (!el || !podium) return;

  const sorted = [...(state.teams || [])].sort((a, b) => b.total_points - a.total_points);
  podium.innerHTML = sorted.map((t, i) => `
    <div class="podium-row${i === 0 ? ' first' : ''}">
      <div class="podium-rank">${i + 1}</div>
      <div class="podium-dot" style="background:${t.color}"></div>
      <div class="podium-name" style="${i === 0 ? `color:${t.color}` : ''}">${t.name}</div>
      <div class="podium-pts">${t.total_points}<span style="font-size:0.7em;font-weight:400;color:var(--text-muted)"> pts</span></div>
    </div>`).join('');

  el.classList.remove('hidden');
}

function dismissGameOver() {
  gameOverDismissed = true;
  document.getElementById('game-over-overlay').classList.add('hidden');
}

// ── Full game state render ───────────────────

// Master render function called every time a full gameState event arrives.
// Drives all the sub-renders (info bar, map, game-over overlay).
function renderGameState(state) {
  // If the game transitions away from "ended", reset the dismiss flag so the
  // overlay can show again if the game ends a second time.
  if (state.gameState !== 'ended') gameOverDismissed = false;

  // Suppress the game-over overlay for the very first state we receive if the
  // game is already over — the player wasn't watching that game.
  if (!firstStateReceived && state.gameState === 'ended') gameOverDismissed = true;
  firstStateReceived = true;

  lastGameState = state;
  renderInfoBar(state);
  renderMap(state);
  applyTeamChatSetting(state);

  if (state.gameState === 'ended' && !gameOverDismissed) {
    showGameOver(state);
  } else if (state.gameState !== 'ended') {
    document.getElementById('game-over-overlay').classList.add('hidden');
  }
}

// ── Utilities ────────────────────────────────

// Display a temporary notification banner at the bottom of the screen.
// `type` maps to a CSS class (info, success, warning, danger).
function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function logout() {
  if (!confirm('Are you sure you want to log out?')) return;
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

async function triggerPlayerSOS() {
  if (!confirm('Send EMERGENCY SOS to all players?')) return;
  try {
    const res = await fetch('/api/player/sos', { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(d.error || 'Failed to send SOS', 'danger');
    }
  } catch {
    toast('Failed to send SOS — check your connection', 'danger');
  }
}

// ── Socket events ────────────────────────────

// Full game state push — authoritative snapshot of everything.
socket.on('gameState', renderGameState);

// Lightweight timer update every second — updates only the countdown display
// rather than re-rendering the entire game state.
socket.on('timerTick', ({ remaining }) => {
  if (!lastGameState) return;
  lastGameState.timeRemaining = remaining;
  document.getElementById('info-timer').textContent = formatTime(remaining);
});

socket.on('countdownTick', ({ remaining }) => {
  if (!lastGameState) return;
  lastGameState.countdownRemaining = remaining;
  document.getElementById('info-timer').textContent = formatTime(remaining);
});

// Show a toast when any team captures a location.
socket.on('locationCaptured', ({ locationName, teamName, capturedBy }) => {
  toast(`${capturedBy} captured ${locationName} for ${teamName}!`, 'success');
});

// Notify players when a round ends and points are awarded.
socket.on('resetOccurred', ({ resetNumber, totalResets }) => {
  toast(`Round ${resetNumber}/${totalResets} complete — points awarded!`, 'warning');
});

socket.on('gameEnded', () => {
  gameOverDismissed = false;
  toast('Game over! Final scores are in.', 'danger');
});

// Admin cleared all messages — wipe local chat history and re-render.
socket.on('clearMessages', () => {
  allMessages = [];
  unread.all = 0;
  unread.team = 0;
  updateUnreadBadges();
  if (chatOpen) renderMessages();
});

// SOS alert — show the full-screen overlay on all clients except the one
// who sent it (they get a confirmation toast instead to avoid showing the
// alert to themselves).
socket.on('sosAlert', ({ triggeredBy }) => {
  if (player && triggeredBy === player.username) {
    toast('Emergency SOS sent to all players!', 'warning');
    return;
  }
  const caller = document.getElementById('sos-caller');
  if (caller) caller.textContent = triggeredBy ? `Triggered by: ${triggeredBy}` : '';
  document.getElementById('sos-overlay').classList.remove('hidden');
});

// Show or hide the team chat tab based on the teamChatEnabled game state flag.
// Called on every game state update so changes take effect live without a refresh.
function applyTeamChatSetting(state) {
  const enabled = state.teamChatEnabled !== false;
  const teamTab = document.querySelector('.chat-tab-btn[data-channel="team"]');
  if (!teamTab) return;
  teamTab.style.display = enabled ? '' : 'none';
  // If the tab was just hidden and the user is currently on it, switch to all-channel.
  if (!enabled && activeChannel === 'team') switchChannel('all');
}

// ── Chat ─────────────────────────────────────

let chatOpen = false;
let activeChannel = 'team';   // 'team' | 'all'
let allMessages = [];         // all messages fetched or received for this session

// Unread counts per channel — incremented when a message arrives while the
// panel is closed or the other channel is active, reset when the channel is viewed.
const unread = { all: 0, team: 0 };

// Escape HTML entities before inserting user-supplied text into innerHTML
// to prevent XSS from malicious message content.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-messages');
  if (el) el.scrollTop = el.scrollHeight;
}

// Update the unread badge counts in the chat button and tab headers.
function updateUnreadBadges() {
  const total = unread.all + unread.team;
  const hdr = document.getElementById('chat-unread-badge');
  if (hdr) { hdr.textContent = total > 99 ? '99+' : total; hdr.classList.toggle('hidden', total === 0); }

  ['all', 'team'].forEach(ch => {
    const b = document.getElementById(`chat-tab-badge-${ch}`);
    if (b) { b.textContent = unread[ch]; b.classList.toggle('hidden', unread[ch] === 0); }
  });
}

// Re-render the message list for the currently active channel.
function renderMessages() {
  const el = document.getElementById('chat-messages');
  if (!el) return;

  // Team channel is only meaningful if the player is actually on a team.
  if (activeChannel === 'team' && player && !player.team_id) {
    el.innerHTML = '<div class="chat-empty">You are not on a team yet.</div>';
    return;
  }

  const filtered = allMessages.filter(m => m.channel === activeChannel);

  if (filtered.length === 0) {
    el.innerHTML = '<div class="chat-empty">No messages yet. Say something!</div>';
    return;
  }

  el.innerHTML = filtered.map(m => {
    const isMe = player && m.authorId === player.id;
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dot = m.teamColor
      ? `<span class="chat-dot" style="background:${m.teamColor}"></span>`
      : `<span class="chat-dot"></span>`;
    return `
      <div class="chat-msg${isMe ? ' chat-msg-me' : ''}">
        <div class="chat-msg-meta">
          ${dot}
          <span class="chat-msg-author">${isMe ? 'You' : escapeHtml(m.authorName)}</span>
          <span class="chat-msg-time">${time}</span>
        </div>
        <div class="chat-msg-text">${escapeHtml(m.text)}</div>
      </div>`;
  }).join('');
}

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');
  panel.classList.toggle('open', chatOpen);
  document.getElementById('chat-backdrop').classList.toggle('visible', chatOpen);
  if (chatOpen) {
    if (activeChannel === 'roster') {
      loadRoster();
    } else {
      unread[activeChannel] = 0;
      updateUnreadBadges();
      renderMessages();
      requestAnimationFrame(scrollChatToBottom);
      if (window.matchMedia('(hover: hover)').matches) {
        document.getElementById('chat-input').focus();
      }
    }
  } else {
    window.scrollTo(0, 0);
  }
}

function switchChannel(channel) {
  activeChannel = channel;
  document.querySelectorAll('.chat-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.channel === channel);
  });

  const msgEl    = document.getElementById('chat-messages');
  const rosterEl = document.getElementById('roster-panel');
  const formEl   = document.getElementById('chat-form');

  if (channel === 'roster') {
    msgEl.style.display    = 'none';
    formEl.style.display   = 'none';
    rosterEl.style.display = '';
    loadRoster();
  } else {
    rosterEl.style.display = 'none';
    msgEl.style.display    = '';
    formEl.style.display   = '';
    unread[channel] = 0;
    updateUnreadBadges();
    renderMessages();
    requestAnimationFrame(scrollChatToBottom);
    if (window.matchMedia('(hover: hover)').matches) {
      document.getElementById('chat-input').focus();
    }
  }
}

// Fetch and render the list of teammates for the player's team.
async function loadRoster() {
  const el = document.getElementById('roster-panel');
  if (!el) return;
  el.innerHTML = '<div class="chat-empty">Loading…</div>';

  try {
    const res = await fetch('/api/player/teammates');
    if (!res.ok) { el.innerHTML = '<div class="chat-empty">Could not load roster.</div>'; return; }
    const teammates = await res.json();

    if (teammates.length === 0) {
      el.innerHTML = '<div class="chat-empty">You are not assigned to a team yet.</div>';
      return;
    }

    const teamColor = player && player.team_color ? player.team_color : 'var(--uncontrolled)';
    el.innerHTML = teammates.map(t => {
      const isMe = t.id === player.id;
      return `
        <div class="score-row" style="padding:10px 16px">
          <div class="score-dot" style="background:${teamColor}"></div>
          <div class="score-name">
            ${escapeHtml(t.username)}${isMe ? ' <span style="color:var(--text-muted);font-size:0.78rem">(you)</span>' : ''}
          </div>
          ${t.role ? `<div style="font-size:0.8rem;color:var(--text-muted);font-style:italic">${escapeHtml(t.role)}</div>` : ''}
        </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="chat-empty">Could not load roster.</div>';
  }
}

// Fetch chat history from the server on page load.
// The server filters to only return messages this player is allowed to see
// (their own team's channel + the all-players channel).
async function loadMessages() {
  try {
    const res = await fetch('/api/chat/messages');
    if (!res.ok) return;
    allMessages = await res.json();
    if (chatOpen) { renderMessages(); scrollChatToBottom(); }
  } catch { /* non-fatal — chat still works for new incoming messages */ }
}

document.getElementById('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  if (activeChannel === 'team' && player && !player.team_id) {
    toast('You must be on a team to use the team channel', 'warning');
    return;
  }

  input.value = '';

  const res = await fetch('/api/chat/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel: activeChannel })
  });

  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    toast(d.error || 'Failed to send message', 'danger');
    input.value = text;   // restore the text so the player can try again
  }
});

document.querySelectorAll('.chat-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchChannel(btn.dataset.channel));
});

// Handle incoming chat messages over Socket.IO.
socket.on('chatMessage', msg => {
  // Team messages from other teams are broadcast to everyone but filtered here
  // on the client — only keep it if it's ours.
  if (msg.channel === 'team' && (!player || msg.teamId !== player.team_id)) return;
  // Belt-and-suspenders: suppress team messages if team chat is disabled.
  if (msg.channel === 'team' && lastGameState && lastGameState.teamChatEnabled === false) return;

  allMessages.push(msg);

  const isMine = player && msg.authorId === player.id;
  const isActiveView = chatOpen && msg.channel === activeChannel;

  if (isActiveView) {
    renderMessages();
    requestAnimationFrame(scrollChatToBottom);
  } else if (!isMine) {
    // Increment unread count and show a preview toast for messages the player
    // hasn't seen yet (don't count their own messages as "unread").
    unread[msg.channel] = (unread[msg.channel] || 0) + 1;
    updateUnreadBadges();
    const prefix = msg.channel === 'team' ? '[Team] ' : '';
    const preview = msg.text.length > 60 ? msg.text.substring(0, 60) + '…' : msg.text;
    toast(`${prefix}${escapeHtml(msg.authorName)}: ${escapeHtml(preview)}`, 'info');
  }
});

// ── QR Scanner ───────────────────────────────

// Active camera stream — kept so we can stop all tracks when closing.
let qrStream = null;
// Whether the scan loop is running — set to false to exit the rAF loop.
let qrActive = false;
// requestAnimationFrame handle so we can cancel it on close.
let qrFrame  = null;

// Open the scanner: request camera access, start the video, begin scanning.
async function openQrScanner() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera not available on this device or browser', 'danger');
    return;
  }

  document.getElementById('qr-scanner-modal').classList.remove('hidden');
  qrActive = true;

  try {
    // Request the back-facing camera specifically — better for scanning printed QR codes.
    qrStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    });
    const video = document.getElementById('qr-video');
    video.srcObject = qrStream;
    await video.play();
    scanQrFrame();
  } catch {
    closeQrScanner();
    toast('Could not access the camera — please allow camera permissions', 'danger');
  }
}

// Stop the camera and hide the scanner modal.
function closeQrScanner() {
  qrActive = false;
  if (qrFrame)  { cancelAnimationFrame(qrFrame); qrFrame = null; }
  if (qrStream) { qrStream.getTracks().forEach(t => t.stop()); qrStream = null; }
  const video = document.getElementById('qr-video');
  video.srcObject = null;
  document.getElementById('qr-scanner-modal').classList.add('hidden');
}

// Called every animation frame while the scanner is open.
// Draws the current video frame to a hidden canvas, feeds the pixel data
// to jsQR, and navigates to the URL if a valid capture code is found.
function scanQrFrame() {
  if (!qrActive) return;

  const video  = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');

  // Wait until the video has enough data to render a frame.
  if (video.readyState < video.HAVE_ENOUGH_DATA) {
    qrFrame = requestAnimationFrame(scanQrFrame);
    return;
  }

  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert'
  });

  if (code) {
    // App-only format: CONQUEST:<locationId>:<token>
    const custom = code.data.match(/^CONQUEST:(\d+):([a-f0-9]+)$/);
    if (custom) {
      closeQrScanner();
      window.location.href = `/capture/${custom[1]}/${custom[2]}`;
      return;
    }
    // Stable name-based format: CONQUEST:NAME:<slug>
    const stable = code.data.match(/^CONQUEST:NAME:([a-z0-9-]+)$/);
    if (stable) {
      closeQrScanner();
      window.location.href = `/capture-stable/${stable[1]}`;
      return;
    }
    // Public URL format — any camera app can also read these
    try {
      const url = new URL(code.data);
      if (url.pathname.match(/^\/capture\/\d+\/[a-f0-9]+$/)) {
        closeQrScanner();
        window.location.href = code.data;
        return;
      }
    } catch { /* not a valid URL — keep scanning */ }
  }

  qrFrame = requestAnimationFrame(scanQrFrame);
}

// ── Map pinch-to-zoom & pan ──────────────────
//
// This IIFE adds touch gesture support to the map viewport on mobile.
//
// How it works:
//   • 2-finger pinch  → scale the viewport between 1× and 5×.
//     The element point under the pinch midpoint stays fixed as you zoom
//     so the gesture feels anchored to what you're looking at.
//   • 1-finger drag   → pan the map (only when already zoomed in).
//     Translation is clamped so the viewport can't be dragged further than
//     the edge of the parent container (no blank space visible).
//   • Releasing until scale ≤ 1 → snap back to the default position.
//
// The transform is applied to #map-viewport which contains both the image
// and the pin overlay, so pins move with the map during zoom/pan.
//
// touch-action: none (set in CSS on #map-viewport) hands all touch events to
// this JS and prevents the browser from interpreting the gesture as page scroll
// or browser-level pinch-to-zoom.

(function () {
  const vp = document.getElementById('map-viewport');
  if (!vp) return;

  // Current transform state.
  let scale = 1, tx = 0, ty = 0;

  // Captured at the start of each pinch gesture so we can compute the delta.
  let startScale, startTx, startTy, startDist, startMidX, startMidY;

  // Last known touch position during a single-finger pan.
  let lastTouchX, lastTouchY;

  // Apply the current scale + translation to the element.
  // Using translate then scale with transform-origin:0 0 means a point (px, py)
  // in element space maps to (px*scale + tx, py*scale + ty) in parent space —
  // predictable math for clampTranslate and the pinch anchor formula.
  function applyTransform() {
    vp.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Clamp translation so the scaled viewport never reveals blank space inside
  // the parent container.  At scale 1 this forces tx=0, ty=0.
  function clampTranslate(ntx, nty, ns) {
    const pw = vp.parentElement.clientWidth;
    const ph = vp.parentElement.clientHeight;
    return {
      tx: clamp(ntx, pw - vp.clientWidth  * ns, 0),
      ty: clamp(nty, ph - vp.clientHeight * ns, 0)
    };
  }

  // Euclidean distance between two touch points.
  function touchDist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }

  // Midpoint of two touches expressed in the parent element's coordinate space.
  function touchMid(t) {
    const rect = vp.parentElement.getBoundingClientRect();
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top
    };
  }

  vp.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      // Record the start state so touchmove can compute deltas.
      startDist  = touchDist(e.touches);
      const m    = touchMid(e.touches);
      startMidX  = m.x; startMidY = m.y;
      startScale = scale; startTx = tx; startTy = ty;
    } else if (e.touches.length === 1 && scale > 1) {
      // Only allow panning when zoomed in; at 1× there is nothing to pan.
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
    }
  }, { passive: false });

  vp.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const ns  = clamp(startScale * (touchDist(e.touches) / startDist), 1, 5);
      const cur = touchMid(e.touches);

      // Find the element-space point that was under the start midpoint:
      //   epx = (startMidX - startTx) / startScale
      // Then choose ntx so that same point lands under the current midpoint:
      //   cur.x = epx * ns + ntx  →  ntx = cur.x - epx * ns
      const epx = (startMidX - startTx) / startScale;
      const epy = (startMidY - startTy) / startScale;
      const c = clampTranslate(cur.x - epx * ns, cur.y - epy * ns, ns);
      scale = ns; tx = c.tx; ty = c.ty;
      applyTransform();
    } else if (e.touches.length === 1 && scale > 1) {
      e.preventDefault();
      const dx = e.touches[0].clientX - lastTouchX;
      const dy = e.touches[0].clientY - lastTouchY;
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      const c = clampTranslate(tx + dx, ty + dy, scale);
      tx = c.tx; ty = c.ty;
      applyTransform();
    }
  }, { passive: false });

  vp.addEventListener('touchend', e => {
    // If all fingers are lifted and we're back at 1× (or somehow below),
    // snap the translation to zero to ensure a clean reset.
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; applyTransform(); }
    // If one finger remains after a pinch, start tracking it for panning.
    if (e.touches.length === 1 && scale > 1) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
    }
  }, { passive: false });
})();

// The dashboard page itself should never scroll — only the chat message list.
// Intercept touchmove at the document level and block it everywhere except
// the scrollable message/roster containers.
document.addEventListener('touchmove', e => {
  if (!e.target.closest('#chat-messages') && !e.target.closest('#roster-panel')) {
    e.preventDefault();
  }
}, { passive: false });

init();
