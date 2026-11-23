const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 600 * 1024 // 600 KB ceiling for compressed image payloads
});

const PORT = process.env.PORT || 3000;
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || "1x00000000000000000000AA";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "1x0000000000000000000000000000000AA";

const MAX_CONNECTIONS_PER_IP = 4;
const FALLBACK_WAIT_MS = 3000;
const MESSAGE_COOLDOWN_MS = 400;
const MAX_MESSAGE_LENGTH = 500;
const MAX_IMAGE_BYTES = 350 * 1024; // 350 KB max image payload
const FREE_DAILY_PHOTO_LIMIT = 3;
const FREE_REPORT_BAN_THRESHOLD = 3;
const PREMIUM_REPORT_BAN_THRESHOLD = 10;
const BAN_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DAY_MS = 24 * 60 * 60 * 1000;

const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "omeway",
  "system",
  "moderator",
  "mod",
  "support",
  "staff",
  "official",
  "stranger"
]);

app.set("trust proxy", true);
app.use(express.json({ limit: "64kb" }));

// In-memory state (RAM only for Phase 1)
const waitingQueue = []; // [{ socketId, profile, joinedAt }]
const activeRooms = new Map(); // socketId -> { roomId, partnerId, reported: boolean }
const activeUsernames = new Map(); // usernameLower -> socketId
const validCaptchaTokens = new Map(); // sessionToken -> { ip, expiresAt }
const ipConnections = new Map(); // ip -> count
const lastMessageTime = new Map(); // socketId -> timestamp
const ipPhotoQuotas = new Map(); // ip -> { count, resetAt }
const ipReports = new Map(); // ip -> count
const bannedIps = new Map(); // ip -> bannedUntil (timestamp)

function getHttpIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

function getSocketIp(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return socket.handshake.address || "unknown";
}

function getActiveBan(ip) {
  const bannedUntil = bannedIps.get(ip);
  if (!bannedUntil) return null;
  if (Date.now() >= bannedUntil) {
    bannedIps.delete(ip);
    ipReports.delete(ip);
    return null;
  }
  return bannedUntil;
}

function formatRemainingBan(bannedUntil) {
  const msLeft = Math.max(0, bannedUntil - Date.now());
  const days = Math.floor(msLeft / DAY_MS);
  const hours = Math.ceil((msLeft % DAY_MS) / (60 * 60 * 1000));
  if (days > 0) return `${days} day(s) and ${hours} hour(s)`;
  return `${Math.max(1, hours)} hour(s)`;
}

function getPhotoQuota(ip) {
  const now = Date.now();
  let record = ipPhotoQuotas.get(ip);
  if (!record || now >= record.resetAt) {
    record = { count: 0, resetAt: now + DAY_MS };
    ipPhotoQuotas.set(ip, record);
  }
  return record;
}

function validateUsername(raw) {
  if (typeof raw !== "string") return { valid: false, reason: "Username required" };
  const trimmed = raw.trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(trimmed)) {
    return { valid: false, reason: "3–20 letters, numbers, or _" };
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_USERNAMES.has(lower)) {
    return { valid: false, reason: "Reserved name" };
  }
  return { valid: true, username: trimmed, lower };
}

function sanitizeInterests(rawInterests) {
  if (!Array.isArray(rawInterests)) return [];
  const unique = new Set();
  for (const item of rawInterests) {
    if (typeof item !== "string") continue;
    const cleaned = item
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\-_ ]/g, "")
      .slice(0, 20);
    if (cleaned.length > 0) {
      unique.add(cleaned);
    }
    if (unique.size >= 8) break;
  }
  return Array.from(unique);
}

function sanitizeProfile(raw = {}, socketId = null) {
  const check = validateUsername(raw.username);
  let username = check.valid ? check.username : `guest_${crypto.randomBytes(3).toString("hex")}`;
  let lower = username.toLowerCase();

  // Ensure uniqueness if collision occurs
  const owner = activeUsernames.get(lower);
  if (owner && owner !== socketId) {
    username = `${username.slice(0, 14)}_${crypto.randomBytes(2).toString("hex")}`;
    lower = username.toLowerCase();
  }

  const bio = typeof raw.bio === "string"
    ? raw.bio.replace(/[\r\n]+/g, " ").trim().slice(0, 160)
    : "";

  const parsedAvatar = Number.parseInt(raw.avatarId, 10);
  const avatarId = Number.isInteger(parsedAvatar) && parsedAvatar >= 1 && parsedAvatar <= 16
    ? parsedAvatar
    : 1;

  const interests = sanitizeInterests(raw.interests);

  return { username, lower, bio, avatarId, interests, isPremium: false };
}

function getCommonInterests(listA, listB) {
  if (!listA.length || !listB.length) return [];
  const setB = new Set(listB);
  return listA.filter((tag) => setB.has(tag));
}

function removeFromQueue(socketId) {
  const idx = waitingQueue.findIndex((entry) => entry.socketId === socketId);
  if (idx !== -1) {
    waitingQueue.splice(idx, 1);
  }
}

function releaseSocketUsername(socket) {
  if (socket.data && socket.data.usernameLower) {
    if (activeUsernames.get(socket.data.usernameLower) === socket.id) {
      activeUsernames.delete(socket.data.usernameLower);
    }
    socket.data.usernameLower = null;
  }
}

function broadcastOnlineCount() {
  io.emit("online_count", { count: Math.max(1, io.engine.clientsCount) });
}

// Periodic cleanup of expired Captcha session tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, info] of validCaptchaTokens.entries()) {
    if (now >= info.expiresAt) {
      validCaptchaTokens.delete(token);
    }
  }
}, 5 * 60 * 1000);

// Security headers & IP ban check on API endpoints
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Serve static assets from /public
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// =========================================================
// REST API ENDPOINTS
// =========================================================

app.get("/api/config", (req, res) => {
  const ip = getHttpIp(req);
  const bannedUntil = getActiveBan(ip);
  res.json({
    turnstileSiteKey: TURNSTILE_SITE_KEY,
    banned: Boolean(bannedUntil),
    bannedUntil,
    banMessage: bannedUntil
      ? `Your IP address is suspended for ${formatRemainingBan(bannedUntil)} due to community reports.`
      : null
  });
});

app.post("/api/verify-captcha", async (req, res) => {
  const ip = getHttpIp(req);
  const bannedUntil = getActiveBan(ip);
  if (bannedUntil) {
    return res.status(403).json({
      ok: false,
      banned: true,
      bannedUntil,
      error: `Access suspended for ${formatRemainingBan(bannedUntil)}.`
    });
  }

  const token = req.body && typeof req.body.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    return res.status(400).json({ ok: false, error: "Please complete the Captcha check first." });
  }

  try {
    const formBody = new URLSearchParams();
    formBody.append("secret", TURNSTILE_SECRET_KEY);
    formBody.append("response", token);
    if (ip && ip !== "unknown") {
      formBody.append("remoteip", ip);
    }

    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formBody
    });
    const outcome = await verifyRes.json();

    if (!outcome.success) {
      return res.status(400).json({
        ok: false,
        error: "Captcha verification failed or expired. Please try again."
      });
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");
    validCaptchaTokens.set(sessionToken, {
      ip,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours
    });

    const quota = getPhotoQuota(ip);
    return res.json({
      ok: true,
      sessionToken,
      photosRemaining: Math.max(0, FREE_DAILY_PHOTO_LIMIT - quota.count),
      photoLimit: FREE_DAILY_PHOTO_LIMIT
    });
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return res.status(502).json({
      ok: false,
      error: "Security service temporarily unavailable. Please retry."
    });
  }
});

app.get("/api/username-available", (req, res) => {
  const raw = typeof req.query.username === "string" ? req.query.username : "";
  const currentSocketId = typeof req.query.socketId === "string" ? req.query.socketId : "";
  const check = validateUsername(raw);

  if (!check.valid) {
    return res.json({ available: false, reason: check.reason });
  }

  const existingOwner = activeUsernames.get(check.lower);
  if (existingOwner && existingOwner !== currentSocketId) {
    return res.json({ available: false, reason: "Already taken" });
  }

  return res.json({ available: true, reason: "Available" });
});

// =========================================================
// PAGE & SEO ROUTES
// =========================================================

app.get("/", (req, res) => {
  res.status(200).sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/robots.txt", (req, res) => {
  res.status(200).type("text/plain").sendFile(path.join(__dirname, "public", "robots.txt"));
});

app.get("/sitemap.xml", (req, res) => {
  res.status(200).type("application/xml").sendFile(path.join(__dirname, "public", "sitemap.xml"));
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

// =========================================================
// MATCHMAKING & ROOM HELPERS
// =========================================================

function pairUsers(entryA, entryB) {
  const socketA = io.sockets.sockets.get(entryA.socketId);
  const socketB = io.sockets.sockets.get(entryB.socketId);

  if (!socketA || !socketB || socketA.id === socketB.id) {
    if (socketA) waitingQueue.unshift(entryA);
    if (socketB) waitingQueue.unshift(entryB);
    return;
  }

  const roomId = `room_${socketA.id}_${socketB.id}`;
  const commonInterests = getCommonInterests(entryA.profile.interests, entryB.profile.interests);

  socketA.join(roomId);
  socketB.join(roomId);

  activeRooms.set(socketA.id, { roomId, partnerId: socketB.id, reported: false });
  activeRooms.set(socketB.id, { roomId, partnerId: socketA.id, reported: false });

  socketA.emit("matched", {
    commonInterests,
    partner: {
      username: entryB.profile.username,
      bio: entryB.profile.bio,
      avatarId: entryB.profile.avatarId,
      interests: entryB.profile.interests
    }
  });

  socketB.emit("matched", {
    commonInterests,
    partner: {
      username: entryA.profile.username,
      bio: entryA.profile.bio,
      avatarId: entryA.profile.avatarId,
      interests: entryA.profile.interests
    }
  });
}

function leaveCurrentRoom(socket, reason) {
  const roomInfo = activeRooms.get(socket.id);
  if (!roomInfo) return;

  const { roomId, partnerId } = roomInfo;
  activeRooms.delete(socket.id);
  activeRooms.delete(partnerId);

  socket.leave(roomId);

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (partnerSocket) {
    partnerSocket.leave(roomId);
    partnerSocket.emit("partner_left", { reason });
  }
}

// Matchmaking fallback loop: pairs users waiting > 3 seconds even without shared tags
setInterval(() => {
  const now = Date.now();
  while (waitingQueue.length >= 2) {
    const oldest = waitingQueue[0];
    if (now - oldest.joinedAt < FALLBACK_WAIT_MS) {
      break;
    }
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();
    pairUsers(userA, userB);
  }
}, 1000);

// =========================================================
// SOCKET.IO HANDSHAKE & EVENTS
// =========================================================

io.use((socket, next) => {
  const ip = getSocketIp(socket);
  const bannedUntil = getActiveBan(ip);
  if (bannedUntil) {
    return next(new Error(`IP_BANNED:${bannedUntil}`));
  }

  const sessionToken = socket.handshake.auth && socket.handshake.auth.sessionToken;
  const sessionRecord = sessionToken ? validCaptchaTokens.get(sessionToken) : null;
  if (!sessionRecord || Date.now() >= sessionRecord.expiresAt) {
    return next(new Error("CAPTCHA_REQUIRED"));
  }

  socket.data.clientIp = ip;
  return next();
});

io.on("connection", (socket) => {
  const clientIp = socket.data.clientIp;
  const currentIpCount = ipConnections.get(clientIp) || 0;

  if (currentIpCount >= MAX_CONNECTIONS_PER_IP) {
    socket.emit("system_error", { message: "Too many active tabs from your network." });
    socket.disconnect(true);
    return;
  }

  ipConnections.set(clientIp, currentIpCount + 1);
  broadcastOnlineCount();

  // Send initial quota info
  const quota = getPhotoQuota(clientIp);
  socket.emit("quota_update", {
    photosRemaining: Math.max(0, FREE_DAILY_PHOTO_LIMIT - quota.count),
    photoLimit: FREE_DAILY_PHOTO_LIMIT
  });

  // Register or update ephemeral guest profile
  socket.on("save_profile", (rawProfile = {}, ack) => {
    const sanitized = sanitizeProfile(rawProfile, socket.id);

    releaseSocketUsername(socket);
    activeUsernames.set(sanitized.lower, socket.id);
    socket.data.usernameLower = sanitized.lower;
    socket.data.profile = sanitized;

    if (typeof ack === "function") {
      ack({ ok: true, profile: sanitized });
    }
  });

  // Join matchmaking queue
  socket.on("find_partner", (rawProfile) => {
    leaveCurrentRoom(socket, "skipped");
    removeFromQueue(socket.id);

    if (rawProfile && typeof rawProfile === "object") {
      const sanitized = sanitizeProfile(rawProfile, socket.id);
      releaseSocketUsername(socket);
      activeUsernames.set(sanitized.lower, socket.id);
      socket.data.usernameLower = sanitized.lower;
      socket.data.profile = sanitized;
    } else if (!socket.data.profile) {
      const fallbackProfile = sanitizeProfile({}, socket.id);
      activeUsernames.set(fallbackProfile.lower, socket.id);
      socket.data.usernameLower = fallbackProfile.lower;
      socket.data.profile = fallbackProfile;
    }

    const profile = socket.data.profile;
    const newEntry = {
      socketId: socket.id,
      profile,
      joinedAt: Date.now()
    };

    // Priority 1: Match with someone sharing >= 1 interest tag
    if (profile.interests.length > 0) {
      const matchIndex = waitingQueue.findIndex(
        (candidate) =>
          candidate.socketId !== socket.id &&
          getCommonInterests(profile.interests, candidate.profile.interests).length > 0
      );

      if (matchIndex !== -1) {
        const [partnerEntry] = waitingQueue.splice(matchIndex, 1);
        pairUsers(partnerEntry, newEntry);
        return;
      }
    }

    waitingQueue.push(newEntry);
    socket.emit("searching", { onlineCount: Math.max(1, io.engine.clientsCount) });
  });

  // Send text message
  socket.on("send_message", (payload = {}, ack) => {
    const roomInfo = activeRooms.get(socket.id);
    if (!roomInfo) return;

    const now = Date.now();
    const lastSent = lastMessageTime.get(socket.id) || 0;
    if (now - lastSent < MESSAGE_COOLDOWN_MS) {
      if (typeof ack === "function") ack({ ok: false, error: "Sending too fast." });
      return;
    }

    if (typeof payload.text !== "string") return;
    const cleanedText = payload.text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!cleanedText) return;

    lastMessageTime.set(socket.id, now);

    const partnerSocket = io.sockets.sockets.get(roomInfo.partnerId);
    if (partnerSocket) {
      partnerSocket.emit("receive_message", {
        text: cleanedText,
        timestamp: now
      });
    }

    if (typeof ack === "function") ack({ ok: true, timestamp: now });
  });
    // Pause matchmaking while user inspects Gender/Country filter or Premium modal
  socket.on("pause_search", () => {
    removeFromQueue(socket.id);
    socket.emit("search_paused");
  });

  // Send picture (3/day free quota)
  socket.on("send_image", (payload = {}, ack) => {
    const roomInfo = activeRooms.get(socket.id);
    if (!roomInfo) return;

    const now = Date.now();
    const lastSent = lastMessageTime.get(socket.id) || 0;
    if (now - lastSent < MESSAGE_COOLDOWN_MS) {
      if (typeof ack === "function") ack({ ok: false, error: "Please wait a moment." });
      return;
    }

    const userQuota = getPhotoQuota(clientIp);
    if (userQuota.count >= FREE_DAILY_PHOTO_LIMIT) {
      socket.emit("premium_required", {
        feature: "photos",
        message: "You have used all 3 free picture shares today. Upgrade to Premium for 50 daily photos!"
      });
      if (typeof ack === "function") ack({ ok: false, reason: "premium_required" });
      return;
    }

    const dataUrl = typeof payload.image === "string" ? payload.image : "";
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
      if (typeof ack === "function") ack({ ok: false, error: "Invalid image format." });
      return;
    }

    if (Buffer.byteLength(dataUrl, "utf8") > MAX_IMAGE_BYTES) {
      if (typeof ack === "function") ack({ ok: false, error: "Image is too large after compression." });
      return;
    }

    userQuota.count += 1;
    lastMessageTime.set(socket.id, now);

    const remaining = Math.max(0, FREE_DAILY_PHOTO_LIMIT - userQuota.count);
    socket.emit("quota_update", {
      photosRemaining: remaining,
      photoLimit: FREE_DAILY_PHOTO_LIMIT
    });

    const partnerSocket = io.sockets.sockets.get(roomInfo.partnerId);
    if (partnerSocket) {
      partnerSocket.emit("receive_image", {
        image: dataUrl,
        timestamp: now
      });
    }

    if (typeof ack === "function") {
      ack({ ok: true, timestamp: now, photosRemaining: remaining });
    }
  });

  // Premium-gated Voice Note check
  socket.on("send_voice", () => {
    socket.emit("premium_required", {
      feature: "voice",
      message: "This feature is only available in Premium"
    });
  });

  // Typing indicator
  socket.on("typing", (payload = {}) => {
    const roomInfo = activeRooms.get(socket.id);
    if (!roomInfo) return;

    const partnerSocket = io.sockets.sockets.get(roomInfo.partnerId);
    if (partnerSocket) {
      partnerSocket.emit("typing", { isTyping: Boolean(payload.isTyping) });
    }
  });

  // Report stranger -> 3 lifetime reports = 7-day IP ban
  socket.on("report_partner", (ack) => {
    const roomInfo = activeRooms.get(socket.id);
    if (!roomInfo || roomInfo.reported) {
      if (typeof ack === "function") ack({ ok: false, error: "Already reported or not in chat." });
      return;
    }

    roomInfo.reported = true;
    const partnerSocket = io.sockets.sockets.get(roomInfo.partnerId);
    const partnerIp = partnerSocket ? partnerSocket.data.clientIp : null;

    // End current conversation immediately
    leaveCurrentRoom(socket, "reported");

    if (partnerIp && partnerIp !== "unknown") {
      const totalReports = (ipReports.get(partnerIp) || 0) + 1;
      ipReports.set(partnerIp, totalReports);

      const threshold = (partnerSocket && partnerSocket.data.profile && partnerSocket.data.profile.isPremium)
        ? PREMIUM_REPORT_BAN_THRESHOLD
        : FREE_REPORT_BAN_THRESHOLD;

      if (totalReports >= threshold) {
        const bannedUntil = Date.now() + BAN_DURATION_MS;
        bannedIps.set(partnerIp, bannedUntil);

        // Disconnect all active sockets belonging to the banned IP
        for (const [, s] of io.sockets.sockets) {
          if (s.data && s.data.clientIp === partnerIp) {
            removeFromQueue(s.id);
            leaveCurrentRoom(s, "banned");
            s.emit("ip_banned", {
              bannedUntil,
              message: "Your IP address has received 3 community reports and is suspended for 7 days."
            });
            s.disconnect(true);
          }
        }
      }
    }

    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("skip_partner", () => {
    leaveCurrentRoom(socket, "skipped");
    removeFromQueue(socket.id);
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket, "disconnected");
    releaseSocketUsername(socket);
    lastMessageTime.delete(socket.id);

    const updatedCount = (ipConnections.get(clientIp) || 1) - 1;
    if (updatedCount <= 0) {
      ipConnections.delete(clientIp);
    } else {
      ipConnections.set(clientIp, updatedCount);
    }

    broadcastOnlineCount();
  });
});

server.listen(PORT, () => {
  console.log(`Omeway Phase 1 server running on http://localhost:${PORT}`);
});
