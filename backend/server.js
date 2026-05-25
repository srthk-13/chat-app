require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

const app = express();
const server = http.createServer(app);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes("*");

const io = new Server(server, {
  cors: {
    origin(origin, cb) {
      if (!origin || ALLOW_ALL_ORIGINS || CORS_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("CORS origin not allowed"), false);
    },
    methods: ["GET", "POST"],
  },
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

const users = new Map(); // socketId -> { username, socketId }
const rooms = new Map(); // roomId -> { id, name, members:Set<socketId>, createdBy }
const pendingDmRequests = new Map(); // toSocketId -> Map<fromSocketId, request>
const dmContacts = new Map(); // username -> Set<username>

const MAX_HISTORY = 50;
const MAX_MESSAGE_LENGTH = 2000;
const GLOBAL_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 10;
const authAttempts = new Map(); // key -> { count, firstAt }

const messageSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ["global", "room", "private"], required: true },
    roomId: { type: String, index: true },
    from: { type: String, required: true },
    fromId: { type: String, required: true },
    to: { type: String },
    toId: { type: String },
    text: { type: String, required: true },
    type: { type: String, enum: ["message", "system"], default: "message" },
    timestamp: { type: Number, required: true },
  },
  { versionKey: false }
);
messageSchema.index(
  { timestamp: 1 },
  {
    expireAfterSeconds: 24 * 60 * 60,
    partialFilterExpression: { scope: "global" },
  }
);

const roomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    createdByUsername: { type: String, required: true },
    createdAt: { type: Number, required: true },
    members: { type: [String], default: [] },
  },
  { versionKey: false }
);

const dmRequestSchema = new mongoose.Schema(
  {
    fromUsername: { type: String, required: true },
    toUsername: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "accepted", "rejected"], required: true, index: true },
    createdAt: { type: Number, required: true, index: true },
    respondedAt: { type: Number },
  },
  { versionKey: false }
);
const userAccountSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false }
);

const ChatMessage = mongoose.model("ChatMessage", messageSchema);
const ChatRoom = mongoose.model("ChatRoom", roomSchema);
const DmRequest = mongoose.model("DmRequest", dmRequestSchema);
const UserAccount = mongoose.model("UserAccount", userAccountSchema);

function normalizeName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMessage(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function getAuthKey(socket) {
  return socket.handshake.address || socket.id;
}

function isAuthRateLimited(socket) {
  const key = getAuthKey(socket);
  const record = authAttempts.get(key);
  if (!record) return false;
  if (Date.now() - record.firstAt > AUTH_WINDOW_MS) {
    authAttempts.delete(key);
    return false;
  }
  return record.count >= MAX_AUTH_ATTEMPTS;
}

function recordAuthAttempt(socket, success) {
  const key = getAuthKey(socket);
  if (success) {
    authAttempts.delete(key);
    return;
  }

  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || now - current.firstAt > AUTH_WINDOW_MS) {
    authAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  current.count += 1;
}

function generateRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = (stored || "").split(":");
    if (!salt || !expected) return false;

    const expectedBuf = Buffer.from(expected, "hex");
    if (expectedBuf.length !== 64) return false;

    const candidateBuf = crypto.scryptSync(password, salt, 64);
    if (candidateBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
  } catch {
    return false;
  }
}

function findAccountByUsername(username) {
  const rx = new RegExp(`^${escapeRegex(username)}$`, "i");
  return UserAccount.findOne({ username: rx }).lean();
}

function getUserList() {
  return [...users.values()].map((u) => ({ username: u.username, socketId: u.socketId }));
}

function getVisibleRoomsForSocket(socketId) {
  const visible = [];
  for (const room of rooms.values()) {
    if (!room.members.has(socketId)) continue;
    visible.push({
      id: room.id,
      name: room.name,
      memberCount: room.members.size,
      members: [...room.members].map((id) => users.get(id)?.username).filter(Boolean),
    });
  }
  return visible;
}

function emitUsersUpdate() {
  io.emit("users:update", getUserList());
}

function emitRoomsUpdate() {
  for (const [socketId] of io.sockets.sockets) {
    io.to(socketId).emit("rooms:update", getVisibleRoomsForSocket(socketId));
  }
}

function emitDmRequestsFor(socketId) {
  const requests = [...(pendingDmRequests.get(socketId)?.values() ?? [])];
  io.to(socketId).emit("dm:requests:update", requests);
}

function ensureContactSet(username) {
  if (!dmContacts.has(username)) dmContacts.set(username, new Set());
  return dmContacts.get(username);
}

function addDmContactPair(a, b) {
  ensureContactSet(a).add(b);
  ensureContactSet(b).add(a);
}

function areDmContacts(a, b) {
  return dmContacts.get(a)?.has(b) || false;
}

function removeUserFromDmContacts(username) {
  // Keep accepted contacts persistent across sessions; only remove offline mapping from socket maps.
  if (!username) return;
}

function getDmContactsForSocket(socketId) {
  const me = users.get(socketId);
  if (!me) return [];
  const names = [...(dmContacts.get(me.username) ?? new Set())];
  return names
    .map((uname) => [...users.values()].find((u) => u.username === uname))
    .filter(Boolean)
    .map((u) => ({ username: u.username, socketId: u.socketId }));
}

function emitDmContactsFor(socketId) {
  io.to(socketId).emit("dm:contacts:update", getDmContactsForSocket(socketId));
}

function emitDmContactsUpdate() {
  for (const [socketId] of io.sockets.sockets) emitDmContactsFor(socketId);
}

function addPendingDmRequest(fromSocketId, toSocketId) {
  const fromUser = users.get(fromSocketId);
  if (!fromUser) return null;

  if (!pendingDmRequests.has(toSocketId)) {
    pendingDmRequests.set(toSocketId, new Map());
  }

  const req = {
    fromSocketId,
    fromUsername: fromUser.username,
    createdAt: Date.now(),
  };

  pendingDmRequests.get(toSocketId).set(fromSocketId, req);
  return req;
}

function removePendingDmRequest(fromSocketId, toSocketId) {
  const bucket = pendingDmRequests.get(toSocketId);
  if (!bucket) return;
  bucket.delete(fromSocketId);
  if (bucket.size === 0) pendingDmRequests.delete(toSocketId);
}

async function persistMessage(msg, scope, roomId = null) {
  await ChatMessage.create({
    scope,
    roomId,
    from: msg.from,
    fromId: msg.fromId,
    to: msg.to,
    toId: msg.toId,
    text: msg.text,
    type: msg.type || "message",
    timestamp: msg.timestamp,
  });
}

async function persistSystemMessage(text, scope, roomId = null, from = "System", fromId = "system") {
  const msg = { type: "system", text, from, fromId, timestamp: Date.now() };
  await persistMessage(msg, scope, roomId);
  return msg;
}

async function loadGlobalHistory() {
  const minTs = Date.now() - GLOBAL_TTL_MS;
  const docs = await ChatMessage.find({ scope: "global", timestamp: { $gte: minTs } })
    .sort({ timestamp: -1 })
    .limit(MAX_HISTORY)
    .lean();
  return docs.reverse().map((d) => ({
    type: d.type,
    text: d.text,
    from: d.from,
    fromId: d.fromId,
    to: d.to,
    toId: d.toId,
    timestamp: d.timestamp,
  }));
}

async function deleteOldGlobalMessages() {
  const minTs = Date.now() - GLOBAL_TTL_MS;
  await ChatMessage.deleteMany({ scope: "global", timestamp: { $lt: minTs } });
}

async function loadRoomHistory(roomId) {
  const docs = await ChatMessage.find({ scope: "room", roomId }).sort({ timestamp: -1 }).limit(MAX_HISTORY).lean();
  return docs.reverse().map((d) => ({
    type: d.type,
    text: d.text,
    from: d.from,
    fromId: d.fromId,
    to: d.to,
    toId: d.toId,
    timestamp: d.timestamp,
  }));
}

async function loadRoomsIntoMemory() {
  const docs = await ChatRoom.find({}).lean();
  for (const doc of docs) {
    rooms.set(doc.roomId, {
      id: doc.roomId,
      name: doc.name,
      createdBy: doc.createdByUsername,
      members: new Set(),
    });
  }
}

async function loadDmContactsIntoMemory() {
  dmContacts.clear();
  const accepted = await DmRequest.find({ status: "accepted" }).lean();
  for (const req of accepted) {
    addDmContactPair(req.fromUsername, req.toUsername);
  }
}

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on("register", async (payload = {}, cb = () => {}) => {
    try {
      console.log(`[auth] register attempt socket=${socket.id}`);
      const fail = (error) => {
        console.warn(`[auth] register failed for socket=${socket.id} user=${trimmed || "<empty>"} reason="${error}"`);
        recordAuthAttempt(socket, false);
        return cb({ ok: false, error });
      };
      if (isAuthRateLimited(socket)) {
        return cb({ ok: false, error: "Too many login attempts. Please wait a few minutes." });
      }

      const trimmed = normalizeName(payload.username);
      const password = typeof payload.password === "string" ? payload.password : "";
      const signupCode = normalizeName(payload.signupCode);

      if (!trimmed || trimmed.length < 2 || trimmed.length > 20) {
        return fail("Username must be 2-20 characters.");
      }
      if (!password || password.length < 6) {
        return fail("Password must be at least 6 characters.");
      }

      const existingAccount = await findAccountByUsername(trimmed);
      if (!existingAccount) {
        const allowSignupEnv = (process.env.ALLOW_SIGNUP || "").toLowerCase();
        const allowSignup = allowSignupEnv ? allowSignupEnv === "true" : !IS_PROD;
        const inviteCode = normalizeName(process.env.SIGNUP_INVITE_CODE || "");
        const accountCount = await UserAccount.estimatedDocumentCount();
        const allowBootstrapFirstUser = accountCount === 0;
        if (!allowSignup && !allowBootstrapFirstUser) {
          return fail("Signup disabled. Ask admin for an account.");
        }
        if (!allowBootstrapFirstUser && inviteCode && signupCode !== inviteCode) {
          return fail("Invalid signup code.");
        }
        await UserAccount.create({
          username: trimmed,
          passwordHash: hashPassword(password),
          createdAt: Date.now(),
        });
      } else if (!verifyPassword(password, existingAccount.passwordHash)) {
        return fail("Invalid username or password.");
      }

      const usernameForSession = existingAccount?.username || trimmed;
      const taken = [...users.values()].some(
        (u) => u.username.toLowerCase() === usernameForSession.toLowerCase()
      );
      if (taken) return fail("Username already taken. Choose another.");

      users.set(socket.id, { username: usernameForSession, socketId: socket.id });
      socket.join("__global__");
      recordAuthAttempt(socket, true);

      cb({ ok: true, username: usernameForSession, socketId: socket.id });

      socket.emit("global:history", await loadGlobalHistory());
      emitUsersUpdate();
      emitRoomsUpdate();
      emitDmRequestsFor(socket.id);
      emitDmContactsFor(socket.id);

      const sysMsg = await persistSystemMessage(`${usernameForSession} joined the chat`, "global");
      io.to("__global__").emit("global:message", sysMsg);
    } catch (err) {
      console.error("register error", err);
      recordAuthAttempt(socket, false);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("global:send", async (payload = {}) => {
    try {
      const user = users.get(socket.id);
      const text = normalizeMessage(payload.text);
      if (!user || !text) return;

      const msg = { type: "message", from: user.username, fromId: socket.id, text, timestamp: Date.now() };
      await persistMessage(msg, "global");
      io.to("__global__").emit("global:message", msg);
    } catch (err) {
      console.error("global:send error", err);
    }
  });

  socket.on("room:create", async (payload = {}, cb = () => {}) => {
    try {
      const user = users.get(socket.id);
      if (!user) return cb({ ok: false, error: "Not registered." });

      const name = normalizeName(payload.roomName);
      if (!name || name.length < 2 || name.length > 30) {
        return cb({ ok: false, error: "Room name must be 2-30 characters." });
      }

      let roomId = generateRoomId();
      while (rooms.has(roomId) || (await ChatRoom.exists({ roomId }))) roomId = generateRoomId();

      const room = { id: roomId, name, members: new Set([socket.id]), createdBy: user.username };
      rooms.set(roomId, room);
      socket.join(`room:${roomId}`);

      await ChatRoom.create({
        roomId,
        name,
        createdByUsername: user.username,
        createdAt: Date.now(),
        members: [user.username],
      });

      const sysMsg = await persistSystemMessage(`${user.username} created the room`, "room", roomId, user.username, socket.id);

      cb({ ok: true, roomId, roomName: name });
      io.to(`room:${roomId}`).emit("room:message", { roomId, roomName: name, msg: sysMsg });
      emitRoomsUpdate();
    } catch (err) {
      console.error("room:create error", err);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("room:join", async (payload = {}, cb = () => {}) => {
    try {
      const user = users.get(socket.id);
      if (!user) return cb({ ok: false, error: "Not registered." });

      const roomId = normalizeName(payload.roomId).toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return cb({ ok: false, error: "Invalid room ID." });

      room.members.add(socket.id);
      socket.join(`room:${roomId}`);

      await ChatRoom.updateOne({ roomId }, { $addToSet: { members: user.username } });

      const history = await loadRoomHistory(roomId);
      cb({ ok: true, roomId, roomName: room.name, history });

      const sysMsg = await persistSystemMessage(`${user.username} joined the room`, "room", roomId, user.username, socket.id);
      io.to(`room:${roomId}`).emit("room:message", { roomId, roomName: room.name, msg: sysMsg });
      emitRoomsUpdate();
    } catch (err) {
      console.error("room:join error", err);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("room:leave", async (payload = {}) => {
    try {
      const user = users.get(socket.id);
      const roomId = normalizeName(payload.roomId).toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return;

      room.members.delete(socket.id);
      socket.leave(`room:${roomId}`);

      if (user?.username) {
        await ChatRoom.updateOne({ roomId }, { $pull: { members: user.username } });
      }

      if (room.members.size > 0) {
        const sysMsg = await persistSystemMessage(`${user?.username ?? "Someone"} left the room`, "room", roomId, user?.username ?? "System", socket.id);
        io.to(`room:${roomId}`).emit("room:message", { roomId, roomName: room.name, msg: sysMsg });
      }

      emitRoomsUpdate();
    } catch (err) {
      console.error("room:leave error", err);
    }
  });

  socket.on("room:send", async (payload = {}) => {
    try {
      const user = users.get(socket.id);
      const roomId = normalizeName(payload.roomId).toUpperCase();
      const text = normalizeMessage(payload.text);
      const room = rooms.get(roomId);
      if (!user || !text || !room || !room.members.has(socket.id)) return;

      const msg = { type: "message", from: user.username, fromId: socket.id, text, timestamp: Date.now() };
      await persistMessage(msg, "room", roomId);
      io.to(`room:${roomId}`).emit("room:message", { roomId, roomName: room.name, msg });
    } catch (err) {
      console.error("room:send error", err);
    }
  });

  socket.on("dm:request", async (payload = {}, cb = () => {}) => {
    try {
      const requester = users.get(socket.id);
      const targetUsername = normalizeName(payload.toUsername);
      if (!requester) return cb({ ok: false, error: "Not registered." });
      if (!targetUsername) return cb({ ok: false, error: "Enter a username." });

      const target = [...users.values()].find(
        (u) => u.username.toLowerCase() === targetUsername.toLowerCase()
      );

      if (!target) return cb({ ok: false, error: "User not found or offline." });
      if (target.socketId === socket.id) return cb({ ok: false, error: "You cannot request yourself." });

      const req = addPendingDmRequest(socket.id, target.socketId);
      if (!req) return cb({ ok: false, error: "Could not create request." });

      await DmRequest.create({
        fromUsername: requester.username,
        toUsername: target.username,
        status: "pending",
        createdAt: Date.now(),
      });

      emitDmRequestsFor(target.socketId);
      cb({ ok: true, toUsername: target.username });
    } catch (err) {
      console.error("dm:request error", err);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("dm:request:respond", async (payload = {}, cb = () => {}) => {
    try {
      const me = users.get(socket.id);
      if (!me) return cb({ ok: false, error: "Not registered." });

      const fromSocketId = normalizeName(payload.fromSocketId);
      const action = payload.action === "accept" ? "accept" : "reject";
      const requester = users.get(fromSocketId);

      const pending = pendingDmRequests.get(socket.id)?.get(fromSocketId);
      if (!pending || !requester) {
        return cb({ ok: false, error: "Request no longer available." });
      }

      removePendingDmRequest(fromSocketId, socket.id);
      emitDmRequestsFor(socket.id);

      await DmRequest.findOneAndUpdate(
        { fromUsername: requester.username, toUsername: me.username, status: "pending" },
        { status: action === "accept" ? "accepted" : "rejected", respondedAt: Date.now() },
        { sort: { createdAt: -1 } }
      );

      if (action === "accept") {
        addDmContactPair(me.username, requester.username);
        emitDmContactsUpdate();
        io.to(fromSocketId).emit("dm:request:accepted", {
          bySocketId: socket.id,
          byUsername: me.username,
        });
        io.to(socket.id).emit("dm:request:accepted", {
          bySocketId: fromSocketId,
          byUsername: requester.username,
        });
        return cb({ ok: true });
      }

      io.to(fromSocketId).emit("dm:request:rejected", {
        bySocketId: socket.id,
        byUsername: me.username,
      });
      cb({ ok: true });
    } catch (err) {
      console.error("dm:request:respond error", err);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("private:send", async (payload = {}, cb = () => {}) => {
    try {
      const sender = users.get(socket.id);
      const toSocketId = payload.toSocketId;
      const text = normalizeMessage(payload.text);
      const recipient = users.get(toSocketId);
      if (!sender || !recipient || !text) return cb({ ok: false, error: "Invalid request." });
      if (!areDmContacts(sender.username, recipient.username)) {
        return cb({ ok: false, error: "Private request must be accepted first." });
      }

      const msg = {
        type: "message",
        from: sender.username,
        fromId: socket.id,
        to: recipient.username,
        toId: toSocketId,
        text,
        timestamp: Date.now(),
      };

      await persistMessage(msg, "private");
      io.to(toSocketId).emit("private:message", msg);
      socket.emit("private:message", msg);
      cb({ ok: true });
    } catch (err) {
      console.error("private:send error", err);
      cb({ ok: false, error: "Server error." });
    }
  });

  socket.on("typing:global", () => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to("__global__").emit("typing:global", { username: user.username });
  });

  socket.on("typing:room", (payload = {}) => {
    const user = users.get(socket.id);
    const roomId = normalizeName(payload.roomId).toUpperCase();
    const room = rooms.get(roomId);
    if (!user || !room || !room.members.has(socket.id)) return;
    socket.to(`room:${roomId}`).emit("typing:room", { roomId, username: user.username });
  });

  socket.on("typing:private", (payload = {}) => {
    const user = users.get(socket.id);
    const toSocketId = payload.toSocketId;
    const toUser = users.get(toSocketId);
    if (!user || !toUser) return;
    if (!areDmContacts(user.username, toUser.username)) return;
    io.to(toSocketId).emit("typing:private", { fromId: socket.id, username: user.username });
  });

  socket.on("disconnect", async () => {
    const user = users.get(socket.id);
    if (!user) return;

    try {
      for (const [roomId, room] of rooms.entries()) {
        if (!room.members.has(socket.id)) continue;
        room.members.delete(socket.id);
        await ChatRoom.updateOne({ roomId }, { $pull: { members: user.username } });

        if (room.members.size !== 0) {
          const sysMsg = await persistSystemMessage(`${user.username} left the room`, "room", roomId, user.username, socket.id);
          io.to(`room:${roomId}`).emit("room:message", { roomId, roomName: room.name, msg: sysMsg });
        }
      }

      const sysMsg = await persistSystemMessage(`${user.username} left the chat`, "global", null, user.username, socket.id);
      io.to("__global__").emit("global:message", sysMsg);
    } catch (err) {
      console.error("disconnect error", err);
    } finally {
      users.delete(socket.id);
      removeUserFromDmContacts(user.username);

      pendingDmRequests.delete(socket.id);
      for (const [toSocketId, reqMap] of pendingDmRequests.entries()) {
        if (reqMap.delete(socket.id) && reqMap.size === 0) pendingDmRequests.delete(toSocketId);
        emitDmRequestsFor(toSocketId);
      }

      emitUsersUpdate();
      emitRoomsUpdate();
      emitDmContactsUpdate();
    }
  });
});

let cleanupTimer;

async function start() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error("MONGO_URI is not set. Add it in environment variables or .env file.");
  }
  if (IS_PROD && ALLOW_ALL_ORIGINS) {
    throw new Error("CORS_ORIGIN must be set in production (comma-separated allowed origins).");
  }

  await mongoose.connect(mongoUri);
  await deleteOldGlobalMessages();
  await loadRoomsIntoMemory();
  await loadDmContactsIntoMemory();

  cleanupTimer = setInterval(() => {
    deleteOldGlobalMessages().catch((err) => {
      console.error("global ttl cleanup error", err);
    });
  }, 60 * 60 * 1000);

  const parsedPort = Number.parseInt(process.env.PORT, 10);
  const PORT = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3000;
  server.listen(PORT, () => {
    console.log(`Chat server running -> http://localhost:${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    console.error("shutdown error", err);
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    console.error("shutdown error", err);
    process.exit(1);
  });
});

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
