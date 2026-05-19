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
- `SIGNUP_INVITE_CODE=<code>` requires this code for new signup when signup is enabled.

3. Start app
```bash
npm start
```

Open `http://localhost:3001`.
