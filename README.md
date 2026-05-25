# NexChat - Real-time Chat App

A full-stack real-time chat application built with Node.js, Express, Socket.IO, and MongoDB.

## Project Structure

```text
fileschat/
|-- backend/
|   `-- server.js
|-- public/
|   |-- index.html
|   `-- assets/
|       |-- css/styles.css
|       `-- js/app.js
|-- server.js
|-- package.json
|-- .env.example
`-- README.md
```

## Storage

MongoDB is used for persistent storage of:
- Global messages
- Room messages
- Private messages
- Room metadata (ID/name/members)
- DM request records

Online socket presence is in-memory and resets on restart.

## Setup

1. Install dependencies
```bash
npm install
```

2. Configure environment
```bash
cp .env.example .env
```
Set `MONGO_URI` in `.env`.

Auth-related env options:
- `ALLOW_SIGNUP=false` blocks new account creation (recommended for production).
- If `ALLOW_SIGNUP` is not set: signup is allowed in development and blocked in production.
- `SIGNUP_INVITE_CODE=<code>` requires this code for new signup when signup is enabled.
- Login is case-insensitive for usernames (display case is preserved from the stored account).

Deployment-related env options:
- `NODE_ENV=production` enables production mode checks.
- `CORS_ORIGIN=https://yourdomain.com` (or comma-separated list) is required in production.
- `PORT=3000` (or your hosting platform port).

3. Start app
```bash
npm start
```

Open `http://localhost:<PORT>` (for example `http://localhost:3000`).

## Production Notes

- `GET /healthz` returns a basic health payload for uptime checks.
- The server now exits gracefully on `SIGINT`/`SIGTERM` (closes HTTP + MongoDB connection).
- Registration/login attempts are rate-limited per socket address (10 failed attempts per 5 minutes).

## Login Troubleshooting

- If the page stays on login, check the inline error under the button.
- When new signup is blocked, only existing accounts can log in.
