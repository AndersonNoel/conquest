# Conquest

A real-world capture-point game played outdoors. Teams race to scan QR codes at physical locations to claim them. Points are awarded at the end of each round based on how many locations each team holds. The admin controls the game from a separate panel; players join from their phones.

---

## How It Works

1. The admin uploads a map image and places location pins on it.
2. Each location gets a QR code. Print them and attach them to physical objects at each location.
3. Players join at the website URL, choose a callsign, and are assigned to a team.
4. The admin starts the game. Players run to locations and scan QR codes to capture them.
5. At the end of each round, every team earns the point value shown on each location they hold. Location point values are then re-randomised for the next round.
6. The team with the most points when all rounds are complete wins.

---

## Publishing to the Internet (VPS)

### What You Need

- A Linux VPS
- A domain name pointed at the server's IP address
- SSH access to the server

### One-Time Server Setup

**1. Install Docker on the server**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in so the group change takes effect
```

**2. Open the firewall**
```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP (Caddy redirects this to HTTPS automatically)
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

**3. Point your domain at the server**

In your domain registrar's DNS settings, add an A record:
```
@   A   <your server's public IP>
```
DNS propagation can take a few minutes to an hour.

---

### Deploy the App

**1. Copy the project to the server**

From your local machine:
```bash
scp -r /path/to/game_wedsite user@your-server-ip:~/conquest
```

Or clone from GitHub directly on the server:
```bash
git clone git@github.com:AndersonNoel/conquest.git ~/conquest
```

**2. Create the `.env` file on the server**
```bash
cd ~/conquest

# Generate a strong random secret
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Create the .env file and paste in the generated secret
cp .env.example .env
nano .env
```

Your `.env` should look like:
```
SESSION_SECRET=paste-your-generated-secret-here
```

**3. Edit the `Caddyfile`**

Replace `yourdomain.com` with your actual domain:
```bash
nano Caddyfile
```

**4. Start the site**
```bash
docker compose up -d --build
```

Caddy will automatically obtain a free TLS certificate from Let's Encrypt. The site should be live at `https://yourdomain.com`

**5. Check that it's running**
```bash
docker compose ps        # both 'app' and 'caddy' should show as running
docker compose logs app  # view application logs
```

---

### Updating the Site

After making changes locally:
```bash
# Option A — copy files directly
scp -r /path/to/game_wedsite user@your-server-ip:~/conquest

# Option B — push to GitHub then pull on the server
git pull

# Then rebuild on the server
cd ~/conquest
docker compose up -d --build
```

Your game data (`data/` and `uploads/`) is stored on the host filesystem via Docker volumes and is **never affected by rebuilds**.

---

### Useful Commands

| Command | What it does |
|---|---|
| `docker compose up -d --build` | Build and start (or restart) everything |
| `docker compose down` | Stop and remove containers |
| `docker compose logs -f app` | Follow live application logs |
| `docker compose logs -f caddy` | Follow Caddy/SSL logs |
| `docker compose restart app` | Restart just the game server |
| `docker compose pull caddy && docker compose up -d` | Update Caddy to the latest version |

---

## Running Locally (Development)

**Prerequisites:** Node.js 18+

```bash
npm install
node server.js
```

The server starts at `http://localhost:3000`.  
The admin panel is at `http://localhost:3000/admin`.

---

## Project Structure

```
├── server.js          # Express HTTP server and all API routes
├── gameEngine.js      # Game state machine (rounds, timers, captures)
├── store.js           # In-memory data store with JSON file persistence
├── public/
│   ├── index.html     # Player dashboard
│   ├── admin.html     # Admin panel
│   ├── login.html     # Login / register page
│   ├── css/style.css  # All styles
│   └── js/
│       ├── dashboard.js  # Player dashboard logic
│       └── admin.js      # Admin panel logic
├── data/              # Runtime data (gitignored — Docker volume in production)
├── uploads/           # Uploaded map image (gitignored — Docker volume in production)
├── Dockerfile
├── docker-compose.yml
└── Caddyfile
```

---

## Configuration

All game settings (number of teams, round length, point values) are managed through the admin panel at `/admin`. No config files need editing.

The only things that need setting before first run:

| Setting | Where |
|---|---|
| Domain name | `Caddyfile` |
| Session secret | `.env` file (`SESSION_SECRET`) |
| Admin password | Set interactively on first visit to `/admin` |
