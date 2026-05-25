const socket = io();

let myUsername = null;
let mySocketId = null;
let onlineUsers = [];
let dmContacts = [];
let knownOnlineUsernames = new Set();
let roomList = []; // [{id,name,memberCount,members}] joined only
let joinedRooms = new Set(); // room ids
let pendingDmRequests = [];

let currentChat = { type: "global", id: null };

const histories = {
  global: [],
  rooms: {}, // roomId -> []
  private: {}, // socketId -> []
};

const unread = {};
let lastTyped = 0;
let typingPeers = {};

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function initials(name) {
  return (name || "?").slice(0, 2).toUpperCase();
}

function avatarColor(name) {
  let h = 0;
  for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return `hsl(${h % 360}, 70%, 55%)`;
}

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const prefix = type === "success" ? "[OK]" : type === "error" ? "[ERR]" : "[INFO]";
  el.innerHTML = `<span>${prefix}</span> ${esc(msg)}`;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function getRoomById(roomId) {
  return roomList.find((r) => r.id === roomId);
}

function resetRegisterButton() {
  const btn = document.getElementById("join-btn");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = "Join Chat ->";
}

function doRegister() {
  try {
    const input = document.getElementById("username-input");
    const passInput = document.getElementById("password-input");
    const signupCodeInput = document.getElementById("signup-code-input");
    const errEl = document.getElementById("register-error");
    const btn = document.getElementById("join-btn");

    const username = input.value.trim();
    const password = passInput.value;
    const signupCode = signupCodeInput.value.trim();
    if (!username) {
      errEl.textContent = "Enter a username.";
      return;
    }
    if (!password || password.length < 6) {
      errEl.textContent = "Enter a password (min 6 chars).";
      return;
    }
    if (!socket.connected) {
      errEl.textContent = "Not connected to server. Retrying...";
      socket.connect();
      return;
    }

    errEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Connecting...";

    const payload = { username, password, signupCode };
    const handleResponse = (response = {}) => {
      const { ok, error, username: uname, socketId } = response;
      if (!ok) {
        errEl.textContent = error || "Login failed.";
        resetRegisterButton();
        return;
      }

      myUsername = uname;
      mySocketId = socketId;
      onRegistered();
    };

    // Fallback for older Socket.IO clients that do not expose socket.timeout().
    if (typeof socket.timeout === "function") {
      socket.timeout(10000).emit("register", payload, (err, response = {}) => {
        if (err) {
          errEl.textContent = "Server did not respond. Check connection and try again.";
          resetRegisterButton();
          return;
        }
        handleResponse(response);
      });
      return;
    }

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      errEl.textContent = "Server did not respond. Check connection and try again.";
      resetRegisterButton();
    }, 10000);

    socket.emit("register", payload, (response = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handleResponse(response);
    });
  } catch (err) {
    const errEl = document.getElementById("register-error");
    if (errEl) errEl.textContent = "Unexpected login error. Please refresh and retry.";
    resetRegisterButton();
    console.error("doRegister error", err);
  }
}

function onRegistered() {
  document.getElementById("register-screen").classList.add("hidden");
  document.getElementById("app").classList.add("visible");

  document.getElementById("my-badge").style.display = "flex";
  document.getElementById("my-username-display").textContent = myUsername;
  const av = document.getElementById("my-avatar");
  av.textContent = initials(myUsername);
  av.style.background = avatarColor(myUsername);

  document.getElementById("send-btn").disabled = false;
  updateInputPlaceholder();
}

socket.on("connect", () => document.getElementById("conn-dot").classList.remove("offline"));
socket.on("disconnect", () => {
  document.getElementById("conn-dot").classList.add("offline");
  const errEl = document.getElementById("register-error");
  if (!myUsername && errEl) errEl.textContent = "Disconnected from server.";
  resetRegisterButton();
  toast("Disconnected from server", "error");
});
socket.on("connect_error", () => {
  const errEl = document.getElementById("register-error");
  if (!myUsername && errEl) errEl.textContent = "Unable to connect to server.";
  resetRegisterButton();
  toast("Connection error", "error");
});

socket.on("global:history", (msgs) => {
  histories.global = msgs;
  if (currentChat.type === "global") renderMessages();
});

socket.on("global:message", (msg) => {
  histories.global.push(msg);
  if (currentChat.type === "global") {
    appendMessage(msg);
  } else {
    incrementUnread("global");
  }
});

socket.on("room:message", ({ roomId, msg }) => {
  if (!histories.rooms[roomId]) histories.rooms[roomId] = [];
  histories.rooms[roomId].push(msg);
  if (currentChat.type === "room" && currentChat.id === roomId) {
    appendMessage(msg);
  } else if (joinedRooms.has(roomId)) {
    incrementUnread(`room:${roomId}`);
  }
});

socket.on("private:message", (msg) => {
  const peerId = msg.fromId === mySocketId ? msg.toId : msg.fromId;
  if (!histories.private[peerId]) histories.private[peerId] = [];
  histories.private[peerId].push(msg);

  if (currentChat.type === "private" && currentChat.id === peerId) {
    appendMessage(msg);
  } else if (msg.fromId !== mySocketId) {
    incrementUnread(`private:${peerId}`);
    toast(`DM from ${msg.from}: ${msg.text.slice(0, 40)}`);
  }
});

socket.on("users:update", (users) => {
  const prev = new Set(knownOnlineUsernames);
  const next = new Set(users.map((u) => u.username));

  if (myUsername) {
    users.forEach((u) => {
      if (!prev.has(u.username) && u.username !== myUsername) {
        toast(`${u.username} joined the chat`, "info");
      }
    });
    prev.forEach((uname) => {
      if (!next.has(uname) && uname !== myUsername) {
        toast(`${uname} left the chat`, "info");
      }
    });
  }

  knownOnlineUsernames = next;
  onlineUsers = users;
  renderUserList();
  renderGlobalOnlinePanel();
  updateRightPanel();
});

socket.on("dm:contacts:update", (contacts) => {
  dmContacts = contacts || [];
  renderUserList();
});

socket.on("rooms:update", (rooms) => {
  roomList = rooms;
  joinedRooms = new Set(rooms.map((r) => r.id));
  renderRoomList();
  document.getElementById("room-count").textContent = rooms.length;
  updateRightPanel();
});

socket.on("dm:requests:update", (requests) => {
  pendingDmRequests = requests;
  renderDmRequests();
});

socket.on("dm:request:accepted", ({ bySocketId, byUsername }) => {
  toast(`${byUsername} accepted your DM request`, "success");
  switchChat("private", bySocketId, byUsername);
});

socket.on("dm:request:rejected", ({ byUsername }) => {
  toast(`${byUsername} rejected your DM request`, "info");
});

socket.on("typing:global", ({ username }) => {
  if (currentChat.type !== "global") return;
  showTyping(`g_${username}`, username);
});

socket.on("typing:room", ({ roomId, username }) => {
  if (currentChat.type !== "room" || currentChat.id !== roomId) return;
  showTyping(`r_${username}`, username);
});

socket.on("typing:private", ({ fromId, username }) => {
  if (currentChat.type !== "private" || currentChat.id !== fromId) return;
  showTyping(`p_${fromId}`, username);
});

function showTyping(key, username) {
  clearTimeout(typingPeers[key]?.timer);
  typingPeers[key] = {
    username,
    timer: setTimeout(() => {
      delete typingPeers[key];
      refreshTypingUI();
    }, 2500),
  };
  refreshTypingUI();
}

function refreshTypingUI() {
  const el = document.getElementById("typing-indicator");
  const relevant = Object.values(typingPeers);
  if (!relevant.length) {
    el.innerHTML = "";
    return;
  }
  const names = relevant.map((p) => `<strong>${esc(p.username)}</strong>`).join(", ");
  el.innerHTML = `${names} ${relevant.length > 1 ? "are" : "is"} typing
    <span class="typing-dots"><span></span><span></span><span></span></span>`;
}

function renderMessages() {
  const wrap = document.getElementById("messages");
  wrap.innerHTML = "";

  let msgs = [];
  if (currentChat.type === "global") msgs = histories.global;
  else if (currentChat.type === "room") msgs = histories.rooms[currentChat.id] || [];
  else if (currentChat.type === "private") msgs = histories.private[currentChat.id] || [];

  msgs.forEach((m) => {
    if (currentChat.type === "global" && m.type === "system") return;
    appendMessage(m, false);
  });
  scrollToBottom();
}

function appendMessage(msg, scroll = true) {
  const wrap = document.getElementById("messages");

  if (currentChat.type === "global" && msg.type === "system") {
    if (scroll) scrollToBottom();
    return;
  }

  if (msg.type === "system") {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = msg.text;
    wrap.appendChild(div);
    if (scroll) scrollToBottom();
    return;
  }

  const mine = msg.fromId === mySocketId;
  const row = document.createElement("div");
  row.className = `msg-row${mine ? " mine" : ""}`;

  const av = document.createElement("div");
  av.className = "msg-avatar";
  av.textContent = initials(msg.from);
  av.style.background = mine ? "linear-gradient(135deg, var(--green), #00b8d4)" : avatarColor(msg.from);

  const body = document.createElement("div");
  body.className = "msg-body";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.innerHTML = `<span class="msg-author">${esc(msg.from)}</span>
                    <span class="msg-time">${fmtTime(msg.timestamp)}</span>`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = msg.text;

  body.appendChild(meta);
  body.appendChild(bubble);
  row.appendChild(av);
  row.appendChild(body);
  wrap.appendChild(row);

  if (scroll) scrollToBottom();
}

function renderGlobalOnlinePanel() {
  const panel = document.getElementById("global-online-panel");
  const list = document.getElementById("global-online-list");
  if (!panel || !list) return;

  if (currentChat.type !== "global") {
    panel.classList.remove("visible");
    return;
  }

  panel.classList.add("visible");
  list.innerHTML = "";
  onlineUsers.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "global-online-chip";
    chip.textContent = u.username === myUsername ? `${u.username} (you)` : u.username;
    list.appendChild(chip);
  });
}

function scrollToBottom() {
  const wrap = document.getElementById("messages");
  wrap.scrollTop = wrap.scrollHeight;
}

function incrementUnread(key) {
  unread[key] = (unread[key] || 0) + 1;
  renderRoomList();
  renderUserList();
  updateTabBadge();
}

function clearUnread(key) {
  delete unread[key];
  renderRoomList();
  renderUserList();
  updateTabBadge();
}

function updateTabBadge() {
  const globalBadge = unread.global || 0;
  const globalItem = document.getElementById("tab-global");
  let badge = globalItem.querySelector(".unread-badge");
  if (globalBadge > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "unread-badge";
      globalItem.appendChild(badge);
    }
    badge.textContent = globalBadge;
  } else if (badge) {
    badge.remove();
  }
}

function renderRoomList() {
  const container = document.getElementById("room-list");
  container.innerHTML = "";

  roomList.forEach((room) => {
    const key = `room:${room.id}`;
    const isActive = currentChat.type === "room" && currentChat.id === room.id;
    const u = unread[key] || 0;

    const div = document.createElement("div");
    div.className = `chat-item${isActive ? " active" : ""}`;
    div.innerHTML = `
      <div class="chat-item-icon">#</div>
      <div style="flex:1;min-width:0">
        <div class="chat-item-name">${esc(room.name)}</div>
        <div class="chat-item-sub">ID: ${esc(room.id)} | ${room.memberCount} members</div>
      </div>
      ${u > 0 ? `<span class="unread-badge">${u}</span>` : ""}
    `;
    div.onclick = () => switchChat("room", room.id);
    container.appendChild(div);
  });
}

function renderUserList() {
  const container = document.getElementById("user-list");
  container.innerHTML = "";
  const list = [
    ...dmContacts,
    ...(mySocketId ? [{ username: myUsername, socketId: mySocketId }] : []),
  ];
  document.getElementById("user-count").textContent = list.length;

  list.forEach((u) => {
    const isMe = u.socketId === mySocketId;
    const key = `private:${u.socketId}`;
    const un = unread[key] || 0;

    const div = document.createElement("div");
    div.className = `online-user-item${isMe ? " me" : ""}`;

    const dot = document.createElement("div");
    dot.className = "user-dot";

    const nameEl = document.createElement("div");
    nameEl.className = "online-username";
    nameEl.textContent = `${u.username}${isMe ? " (you)" : ""}`;

    div.appendChild(dot);
    div.appendChild(nameEl);

    if (un > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = un;
      div.appendChild(badge);
    }

    if (!isMe) div.onclick = () => switchChat("private", u.socketId, u.username);
    container.appendChild(div);
  });
}

function renderDmRequests() {
  const container = document.getElementById("dm-requests-list");
  container.innerHTML = "";
  if (!pendingDmRequests.length) {
    container.innerHTML = '<div class="chat-item-sub">No pending requests</div>';
    return;
  }

  pendingDmRequests.forEach((req) => {
    const row = document.createElement("div");
    row.className = "chat-item";
    row.style.cssText = "margin-bottom:4px;border:1px solid var(--border);border-radius:8px;cursor:default;";
    row.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="chat-item-name">${esc(req.fromUsername)}</div>
        <div class="chat-item-sub">wants to chat privately</div>
      </div>
      <button class="icon-btn" data-act="accept" style="width:auto;padding:0 8px;font-size:11px;">Accept</button>
      <button class="icon-btn" data-act="reject" style="width:auto;padding:0 8px;font-size:11px;">Reject</button>
    `;

    row.querySelector('[data-act="accept"]').onclick = () => respondDmRequest(req.fromSocketId, "accept");
    row.querySelector('[data-act="reject"]').onclick = () => respondDmRequest(req.fromSocketId, "reject");
    container.appendChild(row);
  });
}

function respondDmRequest(fromSocketId, action) {
  socket.emit("dm:request:respond", { fromSocketId, action }, ({ ok, error }) => {
    if (!ok) return toast(error || "Failed to respond", "error");
    if (action === "accept") toast("Request accepted", "success");
  });
}

function updateRightPanel() {
  const panel = document.getElementById("right-panel");
  const body = document.getElementById("right-panel-body");

  if (currentChat.type !== "room") {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  body.innerHTML = "";

  const room = getRoomById(currentChat.id);
  if (!room) return;

  room.members.forEach((uname) => {
    const div = document.createElement("div");
    div.className = "member-item";

    const av = document.createElement("div");
    av.className = "avatar sm";
    av.textContent = initials(uname);
    av.style.background = avatarColor(uname);

    const nameEl = document.createElement("div");
    nameEl.style.cssText = "font-size:12px;color:var(--text2);flex:1";
    nameEl.textContent = `${uname}${uname === myUsername ? " (you)" : ""}`;

    const dot = document.createElement("div");
    dot.className = "user-dot";

    div.appendChild(av);
    div.appendChild(nameEl);
    div.appendChild(dot);
    body.appendChild(div);
  });
}

function switchChat(type, id = null, label = null) {
  typingPeers = {};
  refreshTypingUI();
  currentChat = { type, id };

  document.querySelectorAll(".chat-item").forEach((el) => el.classList.remove("active"));
  if (type === "global") document.getElementById("tab-global").classList.add("active");
  renderRoomList();

  const icon = document.getElementById("chat-icon");
  const name = document.getElementById("chat-name");
  const sub = document.getElementById("chat-sub");
  const acts = document.getElementById("room-actions");

  if (type === "global") {
    icon.textContent = "G";
    name.textContent = "Global";
    sub.textContent = "Everyone in the server";
    acts.style.display = "none";
    clearUnread("global");
    updateTabBadge();
  } else if (type === "room") {
    const room = getRoomById(id) || { name: id, memberCount: 0 };
    icon.textContent = "R";
    name.textContent = room.name;
    sub.textContent = `Room ID: ${id} | ${room.memberCount} members`;
    acts.style.display = "flex";
    document.getElementById("leave-room-btn").onclick = () => leaveRoom(id);
    clearUnread(`room:${id}`);
  } else {
    const peer = dmContacts.find((u) => u.socketId === id);
    icon.textContent = "DM";
    name.textContent = peer ? peer.username : label || id;
    sub.textContent = "Private conversation";
    acts.style.display = "none";
    clearUnread(`private:${id}`);
  }

  updateInputPlaceholder();
  updateRightPanel();
  renderGlobalOnlinePanel();
  renderMessages();
}

function updateInputPlaceholder() {
  const inp = document.getElementById("msg-input");
  if (!inp) return;

  if (currentChat.type === "global") inp.placeholder = "Message #global...";
  else if (currentChat.type === "room") inp.placeholder = `Message #${currentChat.id}...`;
  else {
    const peer = dmContacts.find((u) => u.socketId === currentChat.id);
    inp.placeholder = `Message @${peer?.username ?? "user"}`;
  }
}

function sendMessage() {
  const inp = document.getElementById("msg-input");
  const text = inp.value.trim();
  if (!text || !myUsername) return;

  if (currentChat.type === "global") {
    socket.emit("global:send", { text });
  } else if (currentChat.type === "room") {
    socket.emit("room:send", { roomId: currentChat.id, text });
  } else {
    socket.emit("private:send", { toSocketId: currentChat.id, text }, ({ ok, error }) => {
      if (!ok) toast(error || "Failed to send", "error");
    });
  }

  inp.value = "";
  inp.style.height = "auto";
}

function openRoomModal() {
  document.getElementById("room-modal").classList.add("open");
}

function closeRoomModal() {
  document.getElementById("room-modal").classList.remove("open");
}

function switchRoomTab(tab) {
  document.getElementById("tab-create").classList.toggle("active", tab === "create");
  document.getElementById("tab-join").classList.toggle("active", tab === "join");
  document.getElementById("create-panel").style.display = tab === "create" ? "" : "none";
  document.getElementById("join-panel").style.display = tab === "join" ? "" : "none";
}

function createRoom() {
  const inp = document.getElementById("new-room-name");
  const errEl = document.getElementById("create-room-error");
  const roomName = inp.value.trim();
  if (!roomName) {
    errEl.textContent = "Enter a room name.";
    return;
  }

  socket.emit("room:create", { roomName }, ({ ok, error, roomId, roomName: createdName }) => {
    if (!ok) {
      errEl.textContent = error;
      return;
    }

    errEl.textContent = "";
    inp.value = "";
    closeRoomModal();
    toast(`Room created. Share this Room ID: ${roomId}`, "success");
    histories.rooms[roomId] = histories.rooms[roomId] || [];
    switchChat("room", roomId, createdName);
  });
}

function joinRoomById() {
  const inp = document.getElementById("join-room-id");
  const roomId = inp.value.trim().toUpperCase();
  if (!roomId) return toast("Enter room ID", "error");

  socket.emit("room:join", { roomId }, ({ ok, error, history, roomName, roomId: joinedId }) => {
    if (!ok) return toast(error || "Could not join room", "error");

    histories.rooms[joinedId] = history || [];
    inp.value = "";
    closeRoomModal();
    toast(`Joined ${roomName} (${joinedId})`, "success");
    switchChat("room", joinedId, roomName);
  });
}

function leaveRoom(roomId) {
  socket.emit("room:leave", { roomId });
  delete histories.rooms[roomId];
  delete unread[`room:${roomId}`];
  if (currentChat.type === "room" && currentChat.id === roomId) switchChat("global");
  toast("Left room", "info");
}

function sendDmRequest() {
  const input = document.getElementById("dm-search-input");
  const toUsername = input.value.trim();
  if (!toUsername) return toast("Enter username", "error");

  socket.emit("dm:request", { toUsername }, ({ ok, error, toUsername: resolved }) => {
    if (!ok) return toast(error || "Failed to send request", "error");
    toast(`Request sent to ${resolved}`, "success");
    input.value = "";
  });
}

document.getElementById("join-btn").onclick = doRegister;
document.getElementById("username-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doRegister();
});
document.getElementById("password-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doRegister();
});

document.getElementById("send-btn").onclick = sendMessage;
document.getElementById("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById("msg-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = `${Math.min(this.scrollHeight, 120)}px`;

  const now = Date.now();
  if (now - lastTyped < 1500) return;
  lastTyped = now;

  if (currentChat.type === "global") socket.emit("typing:global");
  else if (currentChat.type === "room") socket.emit("typing:room", { roomId: currentChat.id });
  else if (currentChat.type === "private") socket.emit("typing:private", { toSocketId: currentChat.id });
});

document.getElementById("open-room-modal").onclick = () => {
  if (!myUsername) return toast("Please register first", "error");
  openRoomModal();
};
document.getElementById("close-room-modal").onclick = closeRoomModal;
document.getElementById("room-modal").onclick = (e) => {
  if (e.target === document.getElementById("room-modal")) closeRoomModal();
};

document.getElementById("create-room-btn").onclick = createRoom;
document.getElementById("new-room-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createRoom();
});

document.getElementById("join-room-by-id-btn").onclick = joinRoomById;
document.getElementById("join-room-id").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoomById();
});

document.getElementById("dm-request-btn").onclick = sendDmRequest;
document.getElementById("dm-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendDmRequest();
});

window.switchRoomTab = switchRoomTab;
window.switchChat = switchChat;
