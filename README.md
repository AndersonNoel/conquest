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

## Publishing to the Internet (VPS + Cloudflare)

Cloudflare handles HTTPS for visitors. The VPS only needs to serve plain HTTP on port 80 — no SSL certificates to manage on the server.

### What You Need

- A Linux VPS (DigitalOcean, Linode, Hetzner, AWS EC2, etc.) — a $6/month droplet is plenty
- A domain name
- A free [Cloudflare](https://cloudflare.com) account

### One-Time Cloudflare Setup

**1. Add your domain to Cloudflare**

1. Sign up at [cloudflare.com](https://cloudflare.com) and click **Add a site**
2. Enter your domain and select the free plan
3. Update your domain's nameservers to Cloudflare's (done at your registrar)

**2. Point your domain at the VPS**

In Cloudflare's DNS dashboard, add an A record:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | `<your VPS public IP>` | Proxied (orange cloud ☁️) |

**3. Set the SSL mode**

In Cloudflare: **SSL/TLS → Overview → Flexible**

This means Cloudflare handles HTTPS for visitors, and connects to your VPS over plain HTTP on port 80. No certificate is needed on the server.

---

### Option A — Deploy via SSH (manual)

**1. Install Docker on the VPS**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

**2. Open the firewall**
```bash
sudo ufw allow 22   # SSH
sudo ufw allow 80   # HTTP — Cloudflare connects here
sudo ufw enable
```

**3. Clone the repo and create a `.env` file**
```bash
git clone https://github.com/AndersonNoel/conquest.git ~/conquest
cd ~/conquest

# Generate a strong random secret (run this and copy the output)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

cp .env.example .env
nano .env   # paste the generated value as SESSION_SECRET
```

**4. Start the site**
```bash
docker compose up -d --build
```

**To update later:**
```bash
cd ~/conquest && git pull && docker compose up -d --build
```

---

### Option B — Deploy via Portainer (web UI, no SSH needed after setup)

Portainer lets you deploy and update the site through a web interface — no SSH required after initial Portainer installation.

**Prerequisites:** Portainer is installed and running on your VPS (typically at `http://<vps-ip>:9000`).

**1. Generate a session secret**

Run this anywhere you have Node.js installed and copy the output:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**2. Create the stack in Portainer**

1. Log in to Portainer
2. Go to **Stacks → Add Stack**
3. Select **Repository**
4. Fill in:
   - **Repository URL:** `https://github.com/AndersonNoel/conquest`
   - **Branch:** `main`
   - **Compose path:** `docker-compose.portainer.yml`
5. Under **Environment variables**, add:
   - Name: `SESSION_SECRET` — Value: *(paste the secret you generated)*
6. Click **Deploy the stack**

Portainer pulls the code, builds the image, and starts the container. The site is live at your domain.

**To update later:** open the stack in Portainer and click **Pull and redeploy**. Your data is untouched.

---

### Useful Commands (SSH deployments)

| Command | What it does |
|---|---|
| `docker compose up -d --build` | Build and (re)start the container |
| `docker compose down` | Stop and remove the container |
| `docker compose logs -f app` | Follow live application logs |
| `docker compose restart app` | Restart without rebuilding |

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
├── server.js                    # Express HTTP server and all API routes
├── gameEngine.js                # Game state machine (rounds, timers, captures)
├── store.js                     # In-memory data store with JSON file persistence
├── public/
│   ├── index.html               # Player dashboard
│   ├── admin.html               # Admin panel
│   ├── login.html               # Login / register page
│   ├── css/style.css            # All styles
│   └── js/
│       ├── dashboard.js         # Player dashboard logic
│       └── admin.js             # Admin panel logic
├── data/                        # Runtime data (gitignored — volume in production)
├── uploads/                     # Uploaded map image (gitignored — volume in production)
├── Dockerfile
├── docker-compose.yml           # SSH / manual deployment
└── docker-compose.portainer.yml # Portainer deployment
```

---

## Configuration

All game settings (number of teams, round length, point values) are managed through the admin panel at `/admin`. No config files need editing.

The only things that need setting before first run:

| Setting | Where |
|---|---|
| Session secret | `.env` file (SSH) or Portainer environment variables |
| Admin password | Set interactively on first visit to `/admin` |
