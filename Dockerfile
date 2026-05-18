# ── Build stage ──────────────────────────────
# Use the slim Alpine variant to keep the image small.
FROM node:22-alpine

WORKDIR /app

# Copy package files first so Docker can cache the npm install layer.
# The layer is only re-run when package*.json changes, not on every code edit.
COPY package*.json ./

# --omit=dev skips nodemon and any other devDependencies.
# --frozen-lockfile ensures the exact versions in package-lock.json are used.
RUN npm ci --omit=dev --frozen-lockfile

# Copy the rest of the source (node_modules is excluded by .dockerignore).
COPY . .

# Tell Express to enable production-only behaviour (secure cookies, etc.)
ENV NODE_ENV=production

# Document which port the app listens on.
# The actual binding is controlled by docker-compose.yml, not EXPOSE.
EXPOSE 3000

CMD ["node", "server.js"]
