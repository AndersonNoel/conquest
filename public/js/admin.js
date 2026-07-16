// ─────────────────────────────────────────────
//  admin.js  –  Admin panel logic
//
//  Handles four tabbed sections:
//   1. Settings  — game parameters (teams, intervals, point values)
//   2. Map       — upload map image, place/drag/delete location pins
//   3. Players   — view registrations, assign teams, delete accounts
//   4. Control   — start / pause / resume / end / reset the game, SOS
//
//  The admin panel authenticates with its own password (separate from player
//  accounts) and shows a login overlay until authenticated.
// ─────────────────────────────────────────────

const socket = io();

// Full game state — kept in sync by socket events so control buttons and the
// scoreboard always reflect current reality.
let gameState = null;

// When the user clicks the map to add a location, the click coordinates are
// stored here until they submit the name in the modal dialog.
let pendingPin = null;  // { x_percent, y_percent }

// State for the current drag operation on an admin map pin.
let dragging = null;    // { locId, pinEl, startX, startY, origLeft, origTop }

// Becomes true once the drag has moved beyond 5px in either direction.
// Used to distinguish a "click to edit" from a "drag to reposition".
let dragMoved = false;

// ── Auth ─────────────────────────────────────

// On load, ask the server if this session is already authenticated.
// If so, skip the login overlay and go straight to loading the admin UI.
// If no password has been set yet (first ever launch), the subtitle changes
// to guide the admin through initial setup.
async function checkAuth() {
  const res = await fetch('/api/admin/status');
  const data = await res.json();

  if (data.authenticated) {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-content').style.display = 'block';
    loadAll();
  } else {
    if (!data.hasPassword) {
      document.getElementById('login-subtitle').textContent = 'Set your admin password to get started';
    }
  }
}

document.getElementById('admin-login-btn').addEventListener('click', async () => {
  const pw = document.getElementById('admin-password').value;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('admin-content').style.display = 'block';
    loadAll();
  } else {
    document.getElementById('login-alert').innerHTML = `<div class="alert alert-error">${data.error}</div>`;
  }
});

// Allow submitting the password form with the Enter key.
document.getElementById('admin-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('admin-login-btn').click();
});

async function adminLogout() {
  await fetch('/api/admin/logout', { method: 'POST' });
  location.reload();
}

// ── Tabs ─────────────────────────────────────

// Switch the visible tab pane and update the active button style.
// Also triggers a data reload for tabs that need fresh data every time they're shown.
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  // Keep the dropdown in sync (used on mobile where tabs are too wide to fit).
  document.getElementById('tab-select').value = name;
  // Players table is only loaded when the tab is active to avoid stale data.
  if (name === 'players') loadPlayers();
  if (name === 'map') loadLocations();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// The tab select dropdown mirrors the tab buttons for narrow screens.
document.getElementById('tab-select').addEventListener('change', e => switchTab(e.target.value));

// ── Load all data ─────────────────────────────

// Called once on successful login — pre-loads settings and map data.
// Players are loaded lazily when their tab is selected.
async function loadAll() {
  loadSettings();
  loadLocations();
}

// ── Settings ──────────────────────────────────

async function loadSettings() {
  const res = await fetch('/api/admin/settings');
  if (!res.ok) return;
  const { settings, teams } = await res.json();

  const form = document.getElementById('settings-form');
  form.num_teams.value = settings.num_teams;
  form.reset_interval_minutes.value = settings.reset_interval_minutes;
  form.intermission_minutes.value = settings.intermission_minutes;
  form.total_resets.value = settings.total_resets;
  form.max_point_value.value = settings.max_point_value;
  const qrMode = settings.qr_mode || 'url';
  const radio = document.querySelector(`input[name="qr_mode"][value="${qrMode}"]`);
  if (radio) radio.checked = true;
  document.getElementById('team-chat-enabled').checked = (settings.team_chat_enabled !== false);

  renderTeamsConfig(teams);
  renderSoundEffects(settings);
}

document.getElementById('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      num_teams: f.num_teams.value,
      reset_interval_minutes: f.reset_interval_minutes.value,
      intermission_minutes: f.intermission_minutes.value,
      total_resets: f.total_resets.value,
      max_point_value: f.max_point_value.value,
      qr_mode: document.querySelector('input[name="qr_mode"]:checked')?.value || 'url',
      team_chat_enabled: document.getElementById('team-chat-enabled').checked
    })
  });
  const data = await res.json();
  const el = document.getElementById('settings-alert');
  if (data.success) {
    el.innerHTML = `<div class="alert alert-success">Settings saved!</div>`;
    loadSettings();   // refresh to show any new/removed teams
    setTimeout(() => el.innerHTML = '', 3000);
  } else {
    el.innerHTML = `<div class="alert alert-error">${data.error}</div>`;
  }
});

// Build the team name + colour editor rows from the teams array.
function renderTeamsConfig(teams) {
  const list = document.getElementById('teams-config-list');
  list.innerHTML = teams.map(t => `
    <div class="team-row-config">
      <input type="color" class="color-picker" data-team-id="${t.id}" value="${t.color}">
      <input class="form-input" type="text" data-team-id="${t.id}" data-field="name"
             value="${t.name}" maxlength="30" style="flex:1">
      <span style="font-size:0.8rem; color:var(--text-muted)">ID:${t.id}</span>
    </div>
  `).join('');
}

// Collect all team name/colour inputs and send them to the server in one batch.
document.getElementById('save-teams-btn').addEventListener('click', async () => {
  const nameInputs = document.querySelectorAll('#teams-config-list input[data-field="name"]');
  const colorInputs = document.querySelectorAll('#teams-config-list input.color-picker');

  const teams = [];
  nameInputs.forEach((inp, i) => {
    teams.push({
      id: inp.dataset.teamId,
      name: inp.value.trim(),
      color: colorInputs[i].value
    });
  });

  const res = await fetch('/api/admin/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teams })
  });
  const data = await res.json();
  const el = document.getElementById('teams-alert');
  if (data.success) {
    el.innerHTML = `<div class="alert alert-success">Teams updated!</div>`;
    setTimeout(() => el.innerHTML = '', 3000);
  } else {
    el.innerHTML = `<div class="alert alert-error">${data.error}</div>`;
  }
});

document.getElementById('change-pw-btn').addEventListener('click', async () => {
  const pw = document.getElementById('new-admin-pw').value;
  const res = await fetch('/api/admin/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  const data = await res.json();
  const el = document.getElementById('pw-alert');
  if (data.success) {
    el.innerHTML = `<div class="alert alert-success">Password changed!</div>`;
    document.getElementById('new-admin-pw').value = '';
    setTimeout(() => el.innerHTML = '', 3000);
  } else {
    el.innerHTML = `<div class="alert alert-error">${data.error}</div>`;
  }
});

// ── Sound Effects ─────────────────────────────

// One row per event: key -> { label, settingsField }. The bundled default
// tone for each lives at /sounds/defaults/<key>.wav.
const SOUND_EFFECTS = [
  { key: 'one_minute', label: 'One-Minute Warning',      field: 'sound_one_minute' },
  { key: 'round_end',  label: 'Round End',               field: 'sound_round_end' },
  { key: 'message',    label: 'Message Received',        field: 'sound_message' },
  { key: 'game_start', label: 'Game Start',              field: 'sound_game_start' },
  { key: 'victory',    label: 'Team Victory',            field: 'sound_victory' },
  { key: 'capture',    label: 'You Captured a Location',  field: 'sound_capture' },
  { key: 'team_lost',  label: 'Your Team Lost',           field: 'sound_team_lost' }
];

function soundUrlForAdmin(key, filename) {
  return filename ? `/uploads/sounds/${filename}` : `/sounds/defaults/${key}.wav`;
}

function renderSoundEffects(settings) {
  const list = document.getElementById('sound-effects-list');
  list.innerHTML = SOUND_EFFECTS.map(s => {
    const filename = settings[s.field];
    return `
    <div class="sound-effect-row" data-key="${s.key}">
      <div class="sound-effect-label">
        <div class="sound-effect-name">${s.label}</div>
        <div class="sound-effect-status">${filename ? `Custom: ${filename}` : 'Using default'}</div>
      </div>
      <div class="sound-effect-actions">
        <button class="btn btn-ghost btn-sm" onclick="previewSound('${s.key}')">&#9658; Play</button>
        <label class="btn btn-ghost btn-sm" style="cursor:pointer">
          Upload
          <input type="file" accept="audio/*" style="display:none" onchange="uploadSound('${s.key}', this)">
        </label>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" ${filename ? '' : 'disabled'}
                onclick="resetSound('${s.key}')">Reset</button>
      </div>
    </div>`;
  }).join('');
}

function previewSound(key) {
  const row = document.querySelector(`.sound-effect-row[data-key="${key}"]`);
  const status = row?.querySelector('.sound-effect-status')?.textContent || '';
  const custom = status.startsWith('Custom: ') ? status.slice('Custom: '.length) : null;
  new Audio(soundUrlForAdmin(key, custom)).play().catch(() => toast('Could not play sound', 'danger'));
}

async function uploadSound(key, input) {
  const file = input.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('sound', file);

  const res = await fetch(`/api/admin/upload-sound/${key}`, { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    toast('Sound uploaded!', 'success');
    loadSettings();
  } else {
    toast(data.error || 'Upload failed', 'danger');
  }
  input.value = '';
}

async function resetSound(key) {
  const res = await fetch(`/api/admin/sound/${key}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.success) {
    toast('Reverted to default sound', 'warning');
    loadSettings();
  } else {
    toast(data.error || 'Failed to reset', 'danger');
  }
}

// ── Map ───────────────────────────────────────

// Local copy of locations — kept in sync with the server.
// Used to re-render pins and the locations list without extra API calls.
let mapLocations = [];

// Filename of the currently uploaded map image (e.g. "map.jpg").
let mapImage = null;

// Fetch the current map image filename and all location data, then render both.
async function loadLocations() {
  const settingsRes = await fetch('/api/admin/settings');
  if (!settingsRes.ok) return;
  const { settings } = await settingsRes.json();
  mapImage = settings.map_image;

  if (mapImage) {
    showMapImage(mapImage);
  }

  const res = await fetch('/api/admin/locations');
  if (!res.ok) return;
  mapLocations = await res.json();

  renderAdminPins();
  renderLocationsList();
}

// Handle map file selection — immediately upload the chosen file and update
// the map image display.
document.getElementById('map-upload-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('map', file);

  const alert = document.getElementById('map-alert');
  alert.innerHTML = `<div class="alert alert-info">Uploading...</div>`;

  const res = await fetch('/api/admin/upload-map', { method: 'POST', body: formData });
  const data = await res.json();

  if (data.success) {
    alert.innerHTML = `<div class="alert alert-success">Map uploaded!</div>`;
    mapImage = data.filename;
    showMapImage(data.filename);
    setTimeout(() => alert.innerHTML = '', 3000);
  } else {
    alert.innerHTML = `<div class="alert alert-error">${data.error}</div>`;
  }
  // Clear the input so selecting the same file again still triggers onChange.
  e.target.value = '';
});

// Insert (or update) the map <img> element inside the container.
// A cache-busting timestamp is appended to the URL so the browser doesn't
// show the old image after a new one is uploaded.
function showMapImage(filename) {
  const container = document.getElementById('admin-map-container');
  const placeholder = document.getElementById('admin-map-placeholder');
  let img = document.getElementById('admin-map-img');

  if (!img) {
    // First-ever image: hide the placeholder and create the img element.
    placeholder.style.display = 'none';
    img = document.createElement('img');
    img.id = 'admin-map-img';
    img.className = 'map-image';
    img.style.pointerEvents = 'none';   // click events should reach the container, not the image
    img.alt = 'Game map';
    const overlay = document.getElementById('admin-map-overlay');
    container.insertBefore(img, overlay);
  }

  // Re-render pins once the new image has loaded and its dimensions are known.
  img.onload = renderAdminPins;
  img.src = `/uploads/${filename}?t=${Date.now()}`;
}

// Calculate the pixel bounds of the admin map image inside its container.
// Equivalent to dashboard.js getImageBounds() but always uses object-fit: contain
// (the admin map is never in cover mode).
function getAdminImageBounds() {
  const img = document.getElementById('admin-map-img');
  if (!img || !img.naturalWidth) return null;
  const cw = img.clientWidth;
  const ch = img.clientHeight;
  if (!cw || !ch) return null;
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const containerRatio = cw / ch;
  let w, h, x, y;
  if (imgRatio > containerRatio) {
    // Image is wider relative to container → fits full width, letterboxed top/bottom
    w = cw; h = cw / imgRatio; x = 0; y = (ch - h) / 2;
  } else {
    // Image is taller relative to container → fits full height, pillarboxed left/right
    h = ch; w = ch * imgRatio; x = (cw - w) / 2; y = 0;
  }
  return { x, y, w, h };
}

// Handle a click on the map container to place a new location.
// Clicks that land in the letterbox area (outside the actual image) are ignored.
// Clicks that follow a drag (dragMoved is true) are also ignored — the mouseup
// after dragging would otherwise open the add-location modal.
document.getElementById('admin-map-container').addEventListener('click', e => {
  if (dragMoved) return;
  if (!mapImage) {
    toast('Upload a map image first.', 'warning');
    return;
  }

  const bounds = getAdminImageBounds();
  if (!bounds) return;

  const rect = document.getElementById('admin-map-container').getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  // Only place pins within the actual image area (not in the letterbox bars).
  if (clickX < bounds.x || clickX > bounds.x + bounds.w ||
      clickY < bounds.y || clickY > bounds.y + bounds.h) return;

  // Convert pixel position to a percentage of the image dimensions (0–100).
  // Percentages are stored so pins stay correctly positioned if the map is
  // resized or viewed on a different screen.
  const x = ((clickX - bounds.x) / bounds.w * 100).toFixed(2);
  const y = ((clickY - bounds.y) / bounds.h * 100).toFixed(2);

  pendingPin = { x_percent: parseFloat(x), y_percent: parseFloat(y) };
  document.getElementById('location-pos-display').textContent = `(${parseFloat(x).toFixed(1)}%, ${parseFloat(y).toFixed(1)}%)`;
  document.getElementById('new-location-name').value = '';
  document.getElementById('add-location-modal').classList.remove('hidden');
  // Small delay before focus so the modal animation has started and the
  // keyboard doesn't obscure the content on mobile.
  setTimeout(() => document.getElementById('new-location-name').focus(), 100);
});

document.getElementById('cancel-location-btn').addEventListener('click', () => {
  document.getElementById('add-location-modal').classList.add('hidden');
  pendingPin = null;
});

document.getElementById('save-location-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-location-name').value.trim();
  if (!name) { document.getElementById('new-location-name').focus(); return; }
  if (!pendingPin) return;

  const forceLowTier = document.getElementById('new-location-force-low').checked;

  const res = await fetch('/api/admin/locations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...pendingPin, force_low_tier: forceLowTier })
  });
  const data = await res.json();

  if (data.success) {
    document.getElementById('add-location-modal').classList.add('hidden');
    document.getElementById('new-location-force-low').checked = false;
    pendingPin = null;
    // Add to local array and re-render without a full reload.
    mapLocations.push(data.location);
    renderAdminPins();
    renderLocationsList();
  } else {
    toast(data.error, 'danger');
  }
});

// Keyboard shortcuts for the add-location modal.
document.getElementById('new-location-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('save-location-btn').click();
  if (e.key === 'Escape') document.getElementById('cancel-location-btn').click();
});

// Draw all location pins on the admin map overlay.
// Each pin gets mouse and touch event listeners for drag-to-reposition
// and click-to-edit behaviour.
function renderAdminPins() {
  const overlay = document.getElementById('admin-map-overlay');
  const bounds = getAdminImageBounds();

  if (!bounds) {
    overlay.innerHTML = '';
    return;
  }

  overlay.innerHTML = mapLocations.map(loc => {
    const px = bounds.x + (loc.x_percent / 100) * bounds.w;
    const py = bounds.y + (loc.y_percent / 100) * bounds.h;
    return `
      <div class="map-pin" style="left:${px}px;top:${py}px"
           data-id="${loc.id}" title="${loc.name}">
        <div class="pin-circle" style="background:${loc.team_color || 'var(--uncontrolled)'}">
          ${loc.current_point_value}
        </div>
        <div class="pin-label">${loc.name}</div>
      </div>`;
  }).join('');

  overlay.querySelectorAll('.map-pin').forEach(pin => {
    pin.addEventListener('mousedown', onPinMouseDown);
    pin.addEventListener('touchstart', onPinTouchStart, { passive: false });
    pin.addEventListener('click', e => {
      // stopPropagation prevents the container's click handler from also firing
      // and trying to place a new location at the same spot.
      e.stopPropagation();
      // Only open the edit modal on a clean click, not after a drag.
      if (!dragMoved) openEditModal(parseInt(pin.dataset.id));
    });
  });
}

function onPinMouseDown(e) {
  startDrag(e.currentTarget, e.clientX, e.clientY);
  e.stopPropagation();
}

function onPinTouchStart(e) {
  startDrag(e.currentTarget, e.touches[0].clientX, e.touches[0].clientY);
  e.stopPropagation();
}

// Initialise drag state — called from both mouse and touch start handlers.
function startDrag(pinEl, clientX, clientY) {
  dragging = {
    locId: parseInt(pinEl.dataset.id),
    pinEl,
    startX: clientX,
    startY: clientY,
    origLeft: parseFloat(pinEl.style.left),
    origTop: parseFloat(pinEl.style.top)
  };
  dragMoved = false;
  document.body.style.cursor = 'grabbing';
}

// mousemove/touchmove listeners are on the document (not the pin) so the drag
// continues even if the pointer moves faster than the pin can follow.
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  moveDrag(e.clientX, e.clientY);
});

document.addEventListener('touchmove', e => {
  if (!dragging) return;
  e.preventDefault();   // prevent the page from scrolling while dragging a pin
  moveDrag(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });

// Update the pin's visual position during a drag.
// The 5px threshold before setting dragMoved prevents tiny accidental movements
// from being treated as intentional repositioning.
function moveDrag(clientX, clientY) {
  const dx = clientX - dragging.startX;
  const dy = clientY - dragging.startY;
  if (!dragMoved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) dragMoved = true;
  if (!dragMoved) return;
  dragging.pinEl.style.left = (dragging.origLeft + dx) + 'px';
  dragging.pinEl.style.top  = (dragging.origTop  + dy) + 'px';
}

document.addEventListener('mouseup', endDrag);
document.addEventListener('touchend', endDrag);

// Finalise a drag: convert the pin's new pixel position back to percentages,
// update the local data, and save to the server.
async function endDrag() {
  if (!dragging) return;
  document.body.style.cursor = '';
  const d = dragging;
  dragging = null;

  if (!dragMoved) return;

  // Reset dragMoved in the next event loop tick so the 'click' event that fires
  // after 'mouseup' (part of the browser's event order) still sees dragMoved = true
  // and suppresses the openEditModal call.
  setTimeout(() => { dragMoved = false; }, 0);

  const bounds = getAdminImageBounds();
  if (!bounds) { renderAdminPins(); return; }

  // Clamp the final position to the image bounds so a pin can't be dragged
  // into the letterbox area outside the map.
  const px = Math.max(bounds.x, Math.min(bounds.x + bounds.w, parseFloat(d.pinEl.style.left)));
  const py = Math.max(bounds.y, Math.min(bounds.y + bounds.h, parseFloat(d.pinEl.style.top)));
  const xPct = ((px - bounds.x) / bounds.w * 100).toFixed(2);
  const yPct = ((py - bounds.y) / bounds.h * 100).toFixed(2);

  // Update the local array immediately so subsequent renders use the new position.
  const idx = mapLocations.findIndex(l => l.id === d.locId);
  if (idx !== -1) {
    mapLocations[idx].x_percent = parseFloat(xPct);
    mapLocations[idx].y_percent = parseFloat(yPct);
  }

  const loc = mapLocations[idx];
  if (loc) {
    await fetch(`/api/admin/locations/${d.locId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: loc.name, x_percent: xPct, y_percent: yPct })
    });
  }
  // Re-render to snap the pin to its authoritative pixel position (the DOM
  // position during drag is just a visual preview).
  renderAdminPins();
}

// Reposition pins when the window is resized — their pixel positions change
// even though their percentage positions stay the same.
window.addEventListener('resize', renderAdminPins);

// Render the text list of locations below the map with edit/QR/copy URL buttons.
function renderLocationsList() {
  const list = document.getElementById('locations-list');
  const count = document.getElementById('location-count');

  count.textContent = `${mapLocations.length} location${mapLocations.length !== 1 ? 's' : ''}`;

  if (mapLocations.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem">No locations yet. Click on the map to add them.</p>';
    return;
  }

  list.innerHTML = mapLocations.map(loc => `
    <div class="location-item">
      <div style="width:12px;height:12px;border-radius:50%;background:${loc.team_color || 'var(--uncontrolled)'}; flex-shrink:0"></div>
      <div class="location-name">${loc.name}${loc.force_low_tier ? ' <span class="location-lowtier-badge">Low</span>' : ''}</div>
      <div class="location-pts">${loc.current_point_value} pt${loc.current_point_value !== 1 ? 's' : ''}</div>
      <button class="btn btn-ghost btn-sm" onclick="openEditModal(${loc.id})">Edit</button>
      <button class="btn btn-ghost btn-sm" onclick="copyLocationUrl(${loc.id}, this)">Copy URL</button>
      <a class="btn btn-ghost btn-sm" href="/api/admin/qr/${loc.id}" target="_blank" download>QR</a>
    </div>
  `).join('');
}

// Copy the location's full capture URL to the clipboard so it can be shared
// or printed without downloading a QR code.
function copyLocationUrl(locId, btn) {
  const loc = mapLocations.find(l => l.id === locId);
  if (!loc) return;
  const url = `${window.location.origin}/capture/${loc.id}/${loc.capture_token}`;
  navigator.clipboard.writeText(url).then(() => {
    // Brief confirmation feedback directly on the button.
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }).catch(() => toast('Failed to copy URL', 'danger'));
}

// Open the edit modal pre-filled with the location's current name.
function openEditModal(id) {
  const loc = mapLocations.find(l => l.id === id);
  if (!loc) return;
  document.getElementById('edit-location-id').value = id;
  document.getElementById('edit-location-name').value = loc.name;
  document.getElementById('edit-location-force-low').checked = !!loc.force_low_tier;
  document.getElementById('edit-location-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('edit-location-name').focus(), 100);
}

document.getElementById('cancel-edit-btn').addEventListener('click', () => {
  document.getElementById('edit-location-modal').classList.add('hidden');
});

document.getElementById('save-edit-btn').addEventListener('click', async () => {
  const id = document.getElementById('edit-location-id').value;
  const name = document.getElementById('edit-location-name').value.trim();
  if (!name) return;
  const forceLowTier = document.getElementById('edit-location-force-low').checked;

  const res = await fetch(`/api/admin/locations/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, force_low_tier: forceLowTier })
  });
  const data = await res.json();
  if (data.success) {
    // Update local array so the list re-renders without a full reload.
    const idx = mapLocations.findIndex(l => l.id === parseInt(id));
    if (idx !== -1) { mapLocations[idx].name = name; mapLocations[idx].force_low_tier = forceLowTier; }
    document.getElementById('edit-location-modal').classList.add('hidden');
    renderAdminPins();
    renderLocationsList();
  } else {
    toast(data.error, 'danger');
  }
});

document.getElementById('delete-location-btn').addEventListener('click', async () => {
  const id = document.getElementById('edit-location-id').value;
  if (!confirm('Delete this location?')) return;

  await fetch(`/api/admin/locations/${id}`, { method: 'DELETE' });
  mapLocations = mapLocations.filter(l => l.id !== parseInt(id));
  document.getElementById('edit-location-modal').classList.add('hidden');
  renderAdminPins();
  renderLocationsList();
});

// Keyboard shortcuts for the edit-location modal.
document.getElementById('edit-location-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('save-edit-btn').click();
  if (e.key === 'Escape') document.getElementById('cancel-edit-btn').click();
});

// ── Players ───────────────────────────────────

// Fetch players and teams together so team dropdowns can be built in one pass.
async function loadPlayers() {
  const [playersRes, settingsRes] = await Promise.all([
    fetch('/api/admin/players'),
    fetch('/api/admin/settings')
  ]);
  const players = await playersRes.json();
  const { teams } = await settingsRes.json();

  const wrap = document.getElementById('players-table-wrap');

  if (players.length === 0) {
    wrap.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem">No players registered yet.</p>';
    return;
  }

  wrap.innerHTML = `
    <table class="player-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Map Access</th>
          <th>Role</th>
          <th>Team</th>
          <th>Admin</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${players.map(p => {
          const mapAccess = p.map_access || 'limited';
          const isAdmin = !!p.is_admin;
          return `
          <tr>
            <td><div style="font-weight:600">${p.username}</div></td>
            <td>
              <select class="form-select" style="width:auto; font-size:0.85rem"
                      onchange="setMapAccess(${p.id}, this.value)">
                <option value="none" ${mapAccess === 'none' ? 'selected' : ''}>No Access</option>
                <option value="limited" ${mapAccess === 'limited' ? 'selected' : ''}>Limited</option>
                <option value="full" ${mapAccess === 'full' ? 'selected' : ''}>Full Access</option>
              </select>
            </td>
            <td>
              <input class="form-input" type="text" placeholder="e.g. Captain"
                     maxlength="30" value="${(p.role || '').replace(/"/g, '&quot;')}"
                     style="width:110px; font-size:0.85rem; padding:6px 8px"
                     onchange="setPlayerRole(${p.id}, this.value)">
            </td>
            <td>
              ${p.team_id
                ? `<span style="color:${p.team_color}; font-weight:600">${p.team_name}</span>`
                : `<span class="text-muted">Unassigned</span>`}
            </td>
            <td>
              ${isAdmin
                ? `<button class="btn btn-primary btn-sm" onclick="revokeAdmin(${p.id})">Admin</button>`
                : `<button class="btn btn-ghost btn-sm" onclick="grantAdmin(${p.id})">Grant</button>`}
            </td>
            <td>
              <select class="form-select" style="width:auto; font-size:0.85rem"
                      onchange="assignTeam(${p.id}, this.value)">
                ${teams.map(t => `<option value="${t.id}" ${p.team_id === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
                <option value="" ${!p.team_id ? 'selected' : ''}>Unassigned</option>
              </select>
            </td>
            <td>
              <button class="btn btn-ghost btn-sm" style="color:var(--danger)"
                      onclick="deletePlayer(${p.id}, '${p.username.replace(/'/g, "\\'")}')">Delete</button>
            </td>
          </tr>
        `}).join('')}
      </tbody>
    </table>`;
}

// Set a player's map-access tier ('none' | 'limited' | 'full').
async function setMapAccess(userId, level) {
  const res = await fetch(`/api/admin/players/${userId}/map-access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level })
  });
  if (res.ok) { toast('Map access updated', 'success'); loadPlayers(); }
  else toast('Failed to update map access', 'danger');
}

// Grant a player admin privileges.
async function grantAdmin(userId) {
  const res = await fetch(`/api/admin/players/${userId}/grant-admin`, { method: 'POST' });
  if (res.ok) { toast('Admin privileges granted!', 'success'); loadPlayers(); }
  else toast('Failed to grant admin', 'danger');
}

// Revoke a player's admin privileges.
async function revokeAdmin(userId) {
  const res = await fetch(`/api/admin/players/${userId}/revoke-admin`, { method: 'POST' });
  if (res.ok) { toast('Admin privileges revoked', 'warning'); loadPlayers(); }
  else toast('Failed to revoke admin', 'danger');
}

// Update a player's role label.
async function setPlayerRole(userId, value) {
  const res = await fetch(`/api/admin/players/${userId}/role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: value })
  });
  if (res.ok) toast('Role updated', 'success');
  else toast('Failed to update role', 'danger');
}

// Assign (or un-assign) a player to a team immediately when the dropdown changes.
// Empty string teamId means "unassigned".
async function assignTeam(userId, teamId) {
  const res = await fetch('/api/admin/assign-team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, teamId: teamId || null })
  });
  if (res.ok) toast('Team assigned!', 'success');
  else toast('Failed to assign team', 'danger');
}

async function deletePlayer(userId, username) {
  if (!confirm(`Delete player "${username}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/admin/players/${userId}`, { method: 'DELETE' });
  if (res.ok) { toast(`${username} deleted`, 'warning'); loadPlayers(); }
  else toast('Failed to delete player', 'danger');
}

document.getElementById('clear-messages-btn').addEventListener('click', async () => {
  if (!confirm('Delete ALL chat messages? This cannot be undone.')) return;
  const res = await fetch('/api/admin/messages', { method: 'DELETE' });
  if (res.ok) toast('All messages cleared', 'warning');
  else toast('Failed to clear messages', 'danger');
});

document.getElementById('clear-players-btn').addEventListener('click', async () => {
  if (!confirm('Delete ALL players? This cannot be undone.')) return;
  const res = await fetch('/api/admin/players', { method: 'DELETE' });
  if (res.ok) { toast('All players cleared', 'warning'); loadPlayers(); }
  else toast('Failed to clear players', 'danger');
});

// Assign every unassigned player to a team, balancing team sizes.
// Players who already have a team are left untouched.
document.getElementById('fill-unassigned-btn').addEventListener('click', async () => {
  const res = await fetch('/api/admin/fill-unassigned-teams', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    toast('Unassigned players sorted into teams!', 'success');
    loadPlayers();
  } else {
    toast(data.error || 'Failed', 'danger');
  }
});

// Remove every player's team assignment.
document.getElementById('clear-teams-btn').addEventListener('click', async () => {
  if (!confirm('Remove ALL players from their teams?')) return;

  const res = await fetch('/api/admin/clear-team-assignments', { method: 'POST' });
  const data = await res.json();
  if (data.success) {
    toast('All team assignments cleared', 'warning');
    loadPlayers();
  } else {
    toast(data.error || 'Failed', 'danger');
  }
});

// ── Control ───────────────────────────────────

// Re-render the entire control tab UI based on a game state snapshot.
// Called both from the socket 'gameState' handler and from timerTick so the
// countdown display updates every second without a full page round-trip.
function renderControlStatus(state) {
  if (!state) return;

  const statusMap = {
    waiting:      'WAITING',
    countdown:    'COUNTDOWN',
    running:      'LIVE',
    intermission: 'INTERMISSION',
    paused:       'PAUSED',
    ended:        'ENDED'
  };
  const colorMap = {
    waiting:      'var(--text-muted)',
    countdown:    'var(--warning)',
    running:      'var(--success)',
    intermission: 'var(--warning)',
    paused:       'var(--info)',
    ended:        'var(--danger)'
  };

  const stateLabel = statusMap[state.gameState] || state.gameState.toUpperCase();
  const stateColor = colorMap[state.gameState] || 'var(--text)';

  let statusHtml = `
    <div style="font-size:2rem; font-weight:900; color:${stateColor}; margin-bottom:8px">${stateLabel}</div>
  `;

  if (['running', 'intermission', 'paused'].includes(state.gameState)) {
    // currentReset is 0-indexed, add 1 for a human-readable round number.
    statusHtml += `<div class="info-chip">Round <strong>${state.currentReset + 1}</strong> / ${state.totalResets}</div>`;
  }

  if (state.gameState === 'running' && state.timeRemaining != null) {
    statusHtml += `<div class="info-chip" style="margin-top:6px">Next reset in <strong>${formatTime(state.timeRemaining)}</strong></div>`;
  } else if (state.gameState === 'intermission' && state.timeRemaining != null) {
    statusHtml += `<div class="info-chip" style="margin-top:6px; color:var(--warning)">Next round in <strong>${formatTime(state.timeRemaining)}</strong></div>`;
  } else if (state.gameState === 'countdown' && state.countdownRemaining != null) {
    statusHtml += `<div class="info-chip" style="margin-top:6px">Starting in <strong>${formatTime(state.countdownRemaining)}</strong></div>`;
  } else if (state.gameState === 'paused') {
    statusHtml += `<div class="info-chip" style="margin-top:6px; color:var(--info)">Timer paused at <strong>${formatTime(state.timeRemaining)}</strong></div>`;
  }

  document.getElementById('control-status-display').innerHTML = statusHtml;

  // Live scoreboard sorted by descending points.
  const sb = document.getElementById('control-scoreboard');
  if (state.teams && state.teams.length > 0) {
    const sorted = [...state.teams].sort((a, b) => b.total_points - a.total_points);
    sb.innerHTML = sorted.map((t, i) => `
      <div class="score-row">
        <div class="score-rank">${i + 1}</div>
        <div class="score-dot" style="background:${t.color}"></div>
        <div class="score-name">${t.name}</div>
        <div class="score-value">${t.total_points}</div>
      </div>`).join('');
  } else {
    sb.innerHTML = '<p style="color:var(--text-muted);font-size:0.9rem">No teams yet</p>';
  }

  // Enable/disable control buttons based on what makes sense for the current state.
  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const endBtn = document.getElementById('end-btn');

  const canStart  = ['waiting', 'ended'].includes(state.gameState);
  const canPause  = ['running', 'intermission'].includes(state.gameState);
  const canResume = state.gameState === 'paused';
  const canEnd    = ['running', 'paused', 'countdown', 'intermission'].includes(state.gameState);

  startBtn.disabled = !canStart;
  startBtn.textContent = '▶ Start Game';
  pauseBtn.disabled = !canPause && !canResume;
  // Same button serves as both Pause and Resume — label changes based on state.
  pauseBtn.textContent = canResume ? '▶ Resume Game' : '⏸ Pause Game';
  endBtn.disabled = !canEnd;

  // Update the compact game-state chip in the admin header.
  const headerChip = document.getElementById('admin-game-state');
  headerChip.innerHTML = `<div class="status-chip status-${state.gameState}" style="font-size:0.78rem">${stateLabel}</div>`;

  // Update the slim status bar visible across all tabs.
  const bar = document.getElementById('admin-status-bar');
  let barHtml = `<div class="status-chip status-${state.gameState}">${stateLabel}</div>`;
  if (['running', 'intermission', 'paused'].includes(state.gameState)) {
    barHtml += `<div class="info-chip">Round <strong>${state.currentReset + 1}/${state.totalResets}</strong></div>`;
  }
  if (state.gameState === 'running' && state.timeRemaining != null) {
    barHtml += `<div class="info-chip">Reset in <strong>${formatTime(state.timeRemaining)}</strong></div>`;
  } else if (state.gameState === 'intermission' && state.timeRemaining != null) {
    barHtml += `<div class="info-chip">Next round in <strong>${formatTime(state.timeRemaining)}</strong></div>`;
  }
  bar.innerHTML = barHtml;
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const countdown = parseInt(document.getElementById('countdown-input').value) || 0;
  const res = await fetch('/api/admin/start-game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ countdown_seconds: countdown })
  });
  const data = await res.json();
  if (!data.success) toast(data.error, 'danger');
});

document.getElementById('pause-btn').addEventListener('click', async () => {
  const res = await fetch('/api/admin/pause-game', { method: 'POST' });
  const data = await res.json();
  if (data.success) toast(data.action === 'paused' ? 'Game paused' : 'Game resumed', 'info');
  else toast(data.error, 'danger');
});

document.getElementById('end-btn').addEventListener('click', async () => {
  if (!confirm('End the game now? This will stop all timers.')) return;
  await fetch('/api/admin/end-game', { method: 'POST' });
  toast('Game ended', 'warning');
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (!confirm('Reset game? This will clear all scores and set state to waiting.')) return;
  await fetch('/api/admin/reset-game', { method: 'POST' });
  toast('Game reset', 'info');
});

// ── SOS ───────────────────────────────────────

// SOS requires a two-step confirmation (button → modal confirm) to reduce the
// chance of accidental emergency broadcasts.
document.getElementById('sos-btn').addEventListener('click', () => {
  document.getElementById('sos-modal').classList.remove('hidden');
});

document.getElementById('sos-confirm-btn').addEventListener('click', async () => {
  await fetch('/api/admin/sos', { method: 'POST' });
  document.getElementById('sos-modal').classList.add('hidden');
  toast('SOS alert sent to all players!', 'danger');
});

// ── Utils ─────────────────────────────────────

// Format milliseconds as MM:SS, rounding up so the display reaches 00:00
// at the exact moment the timer fires.
function formatTime(ms) {
  if (ms == null) return '--:--';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Display a temporary notification banner in the bottom-right corner.
function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Socket events ─────────────────────────────

socket.on('gameState', state => {
  gameState = state;
  renderControlStatus(state);

  // If the admin is currently viewing the map tab, update pin colours in real
  // time as teams capture locations (without requiring a manual refresh).
  if (document.getElementById('tab-map').classList.contains('active')) {
    if (state.locations) {
      mapLocations = state.locations;
      renderAdminPins();
    }
  }
});

// Lightweight timer update — re-renders the status display with the new remaining
// time instead of waiting for the next full gameState push.
socket.on('timerTick', ({ remaining }) => {
  if (!gameState || gameState.gameState !== 'running') return;
  const bar = document.getElementById('admin-status-bar');
  const timerEl = bar.querySelector('.timer-bar-val');
  if (timerEl) timerEl.textContent = formatTime(remaining);
  renderControlStatus({ ...gameState, timeRemaining: remaining });
});

socket.on('countdownTick', ({ remaining }) => {
  if (!gameState) return;
  renderControlStatus({ ...gameState, countdownRemaining: remaining });
});

socket.on('intermissionTick', ({ remaining }) => {
  if (!gameState || gameState.gameState !== 'intermission') return;
  renderControlStatus({ ...gameState, timeRemaining: remaining });
});

socket.on('locationCaptured', ({ locationName, teamName }) => {
  toast(`${locationName} captured by ${teamName}`, 'success');
});

socket.on('resetOccurred', ({ resetNumber, totalResets }) => {
  toast(`Round ${resetNumber}/${totalResets} complete — points awarded!`, 'warning');
});

socket.on('gameEnded', () => {
  toast('Game over!', 'danger');
});

// ── Init ──────────────────────────────────────

checkAuth();
