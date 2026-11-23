(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // Views & Navbar
  const gatewayView = $("gatewayView");
  const profileView = $("profileView");
  const matchingView = $("matchingView");
  const chatView = $("chatView");
  const onlineCountEl = $("onlineCount");
  const navPremiumBtn = $("navPremiumBtn");
  const navEditProfileBtn = $("navEditProfileBtn");

  // Gateway & Turnstile
  const captchaStatus = $("captchaStatus");
  const btnGuest = $("btnGuest");
  const btnLogin = $("btnLogin");
  const btnSignup = $("btnSignup");
  const gatewayError = $("gatewayError");

  // Profile Builder
  const profileForm = $("profileForm");
  const profileFormTitle = $("profileFormTitle");
  const closeProfileBtn = $("closeProfileBtn");
  const profileUsername = $("profileUsername");
  const usernameStatus = $("usernameStatus");
  const profileBio = $("profileBio");
  const bioCount = $("bioCount");
  const avatarGrid = $("avatarGrid");
  const selectedTagsEl = $("selectedTags");
  const interestInput = $("interestInput");
  const quickTagsEl = $("quickTags");
  const profileError = $("profileError");
  const saveProfileBtn = $("saveProfileBtn");

  // Matching / Loading Screen
  const searchSpinner = $("searchSpinner");
  const searchHeading = $("searchHeading");
  const searchSubtext = $("searchSubtext");
  const openGenderFilterBtn = $("openGenderFilterBtn");
  const openCountryFilterBtn = $("openCountryFilterBtn");
  const editFromMatchBtn = $("editFromMatchBtn");
  const cancelMatchBtn = $("cancelMatchBtn");

  // Chat Room
  const reportBtn = $("reportBtn");
  const nextBtn = $("nextBtn");
  const partnerBanner = $("partnerBanner");
  const partnerAvatar = $("partnerAvatar");
  const partnerName = $("partnerName");
  const partnerBio = $("partnerBio");
  const sharedTagsEl = $("sharedTags");
  const feed = $("feed");
  const typingRow = $("typingRow");
  const typingUser = $("typingUser");
  const imgBtn = $("imgBtn");
  const photoQuotaBadge = $("photoQuotaBadge");
  const fileInput = $("fileInput");
  const voiceBtn = $("voiceBtn");
  const msgInput = $("msgInput");
  const sendBtn = $("sendBtn");

  // Modals & Overlays
  const premiumModal = $("premiumModal");
  const premiumPaywallBox = $("premiumPaywallBox");
  const premiumReason = $("premiumReason");
  const activeFilterBox = $("activeFilterBox");
  const activeFilterTitle = $("activeFilterTitle");
  const genderOptionsWrap = $("genderOptionsWrap");
  const countryOptionsWrap = $("countryOptionsWrap");
  const closePremiumModal = $("closePremiumModal");
  const checkoutPreviewBtn = $("checkoutPreviewBtn");

  const authModal = $("authModal");
  const authModalTitle = $("authModalTitle");
  const closeAuthModal = $("closeAuthModal");
  const otpPreviewForm = $("otpPreviewForm");
  const authEmailInput = $("authEmailInput");
  const authStatusNote = $("authStatusNote");
  const authFallbackGuestBtn = $("authFallbackGuestBtn");

  const banModal = $("banModal");
  const banMessage = $("banMessage");
  const lightbox = $("lightbox");
  const lightboxImg = lightbox.querySelector("img");
  const toastEl = $("toast");

  // Ephemeral sessionStorage keys (wipes automatically when tab/browser closes)
  const STORAGE_PROFILE_KEY = "omeway_guest_profile_v1";
  const STORAGE_TOKEN_KEY = "omeway_session_token_v1";

  // Application State
  let socket = null;
  let turnstileSiteKey = null;
  let turnstileWidgetId = null;
  let captchaToken = "";
  let sessionToken = sessionStorage.getItem(STORAGE_TOKEN_KEY) || "";
  let photosRemaining = 3;
  let photoLimit = 3;
  let isPremiumUser = false; // Unlocks in Phase 3 upon subscription
  let resumeSearchOnModalClose = false;

  let profile = loadStoredProfile() || {
    username: "",
    bio: "",
    avatarId: 1,
    interests: []
  };

  let usernameValid = false;
  let usernameCheckTimer = null;
  let chatState = "idle"; // "idle" | "searching" | "connected" | "ended"
  let confirmSkip = false;
  let confirmSkipTimer = null;
  let typingTimer = null;
  let isCurrentlyTyping = false;
  let toastTimer = null;

  /* =========================================================
     UTILITIES
  ========================================================= */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2800);
  }

  function showBannerError(el, msg) {
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent = msg;
    el.hidden = false;
  }

  function loadStoredProfile() {
    try {
      const raw = sessionStorage.getItem(STORAGE_PROFILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        username: typeof parsed.username === "string" ? parsed.username : "",
        bio: typeof parsed.bio === "string" ? parsed.bio.slice(0, 160) : "",
        avatarId: Number.isInteger(parsed.avatarId) && parsed.avatarId >= 1 && parsed.avatarId <= 16
          ? parsed.avatarId
          : 1,
        interests: Array.isArray(parsed.interests) ? parsed.interests.slice(0, 8) : []
      };
    } catch {
      return null;
    }
  }

  function saveStoredProfile() {
    try {
      sessionStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Ignore storage quota errors in strict private modes
    }
  }

  function updateQuotaDisplay(remaining, limit) {
    if (typeof remaining === "number") photosRemaining = remaining;
    if (typeof limit === "number") photoLimit = limit;
    photoQuotaBadge.textContent = `${photosRemaining}/${photoLimit}`;
  }

  function switchView(target) {
    gatewayView.hidden = target !== "gateway";
    profileView.hidden = target !== "profile";
    matchingView.hidden = target !== "matching";
    chatView.hidden = target !== "chat";
    navEditProfileBtn.hidden = target !== "chat" && target !== "matching";
  }

  function openFilterOrPremiumModal(mode) {
    // Pause active matchmaking while user inspects the filter/upgrade box
    if (chatState === "searching" && socket && socket.connected) {
      socket.emit("pause_search");
      resumeSearchOnModalClose = true;
      searchSpinner.classList.add("paused");
      searchHeading.textContent = "Search paused";
      searchSubtext.textContent = "Close the popup (×) to resume matchmaking";
    } else {
      resumeSearchOnModalClose = false;
    }

    if (isPremiumUser && (mode === "gender" || mode === "country")) {
      premiumPaywallBox.hidden = true;
      activeFilterBox.hidden = false;
      activeFilterTitle.textContent = mode === "gender" ? "Filter by Gender" : "Filter by Country";
      genderOptionsWrap.hidden = mode !== "gender";
      countryOptionsWrap.hidden = mode !== "country";
    } else {
      activeFilterBox.hidden = true;
      premiumPaywallBox.hidden = false;
      premiumReason.textContent =
        typeof mode === "string" && mode.length > 10
          ? mode
          : "This feature is only available in Premium. Upgrade to unlock Gender & Country filters, Voice Notes, 50 daily photo shares, and 10-report account protection.";
    }

    premiumModal.hidden = false;
  }

  function closePremiumAndResume() {
    premiumModal.hidden = true;
    if (resumeSearchOnModalClose) {
      resumeSearchOnModalClose = false;
      startSearch();
    }
  }

  function showBanScreen(msg) {
    banMessage.textContent =
      msg || "Your IP address has received 3 community reports and is suspended for 7 days.";
    banModal.hidden = false;
  }

  /* =========================================================
     CLOUDFLARE TURNSTILE & CONFIG INIT
  ========================================================= */
  async function initConfigAndTurnstile() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();

      if (data.banned) {
        showBanScreen(data.banMessage);
        return;
      }

      turnstileSiteKey = data.turnstileSiteKey;
      renderTurnstileWhenReady();
    } catch {
      captchaStatus.textContent = "Could not load security check. Refresh to retry.";
    }
  }

  function renderTurnstileWhenReady() {
    if (!turnstileSiteKey) return;
    if (window.turnstile && typeof window.turnstile.render === "function") {
      turnstileWidgetId = window.turnstile.render("#turnstileWidget", {
        sitekey: turnstileSiteKey,
        theme: "dark",
        callback: (token) => {
          captchaToken = token;
          captchaStatus.textContent = "Security check passed";
          showBannerError(gatewayError, "");
        },
        "expired-callback": () => {
          captchaToken = "";
          captchaStatus.textContent = "Security check expired — please verify again";
          if (turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
        },
        "error-callback": () => {
          captchaToken = "";
          captchaStatus.textContent = "Captcha error — please retry";
        }
      });
    } else {
      setTimeout(renderTurnstileWhenReady, 200);
    }
  }

  async function ensureCaptchaSession() {
    if (sessionToken) return true;

    if (!captchaToken) {
      showBannerError(gatewayError, "Please complete the Captcha verification first.");
      return false;
    }

    btnGuest.disabled = true;
    showBannerError(gatewayError, "");

    try {
      const res = await fetch("/api/verify-captcha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: captchaToken })
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        if (data.banned) {
          showBanScreen(data.error);
          return false;
        }
        captchaToken = "";
        if (window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId);
        }
        showBannerError(gatewayError, data.error || "Captcha verification failed.");
        return false;
      }

      sessionToken = data.sessionToken;
      sessionStorage.setItem(STORAGE_TOKEN_KEY, sessionToken);
      updateQuotaDisplay(data.photosRemaining, data.photoLimit);
      return true;
    } catch {
      showBannerError(gatewayError, "Network error verifying Captcha. Please retry.");
      return false;
    } finally {
      btnGuest.disabled = false;
    }
  }

  /* =========================================================
     GATEWAY BUTTONS (GUEST / LOG IN / SIGN UP)
  ========================================================= */
  btnGuest.addEventListener("click", async () => {
    const ok = await ensureCaptchaSession();
    if (!ok) return;
    openProfileEditor(false);
  });

  btnLogin.addEventListener("click", () => {
    authModalTitle.textContent = "Log In to Omeway";
    authStatusNote.hidden = true;
    authModal.hidden = false;
  });

  btnSignup.addEventListener("click", () => {
    authModalTitle.textContent = "Create Omeway Account";
    authStatusNote.hidden = true;
    authModal.hidden = false;
  });

  otpPreviewForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = authEmailInput.value.trim();
    if (!email) return;
    authStatusNote.textContent =
      `Email OTP login for ${email} activates in Phase 2. Click below to start chatting as a Guest right now!`;
    authStatusNote.hidden = false;
  });

  authFallbackGuestBtn.addEventListener("click", async () => {
    authModal.hidden = true;
    const ok = await ensureCaptchaSession();
    if (ok) openProfileEditor(false);
  });

  closeAuthModal.addEventListener("click", () => {
    authModal.hidden = true;
  });

  /* =========================================================
     GUEST PROFILE BUILDER (16 .JPG AVATARS, USERNAME, TAGS)
  ========================================================= */
  function buildAvatarGrid() {
    avatarGrid.textContent = "";
    for (let id = 1; id <= 16; id += 1) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-option" + (profile.avatarId === id ? " selected" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(profile.avatarId === id));
      btn.setAttribute("aria-label", `Avatar ${id}`);
      btn.dataset.avatarId = String(id);

      const img = document.createElement("img");
      img.src = `/omeavatar/${id}.jpg`;
      img.alt = `Avatar ${id}`;
      img.loading = "lazy";

      btn.appendChild(img);
      btn.addEventListener("click", () => selectAvatar(id));
      avatarGrid.appendChild(btn);
    }
  }

  function selectAvatar(id) {
    profile.avatarId = id;
    const buttons = avatarGrid.querySelectorAll(".avatar-option");
    buttons.forEach((btn) => {
      const active = Number(btn.dataset.avatarId) === id;
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-checked", String(active));
    });
  }

  function renderInterestPills() {
    selectedTagsEl.textContent = "";
    profile.interests.forEach((tag, idx) => {
      const pill = document.createElement("span");
      pill.className = "tag-pill";

      const text = document.createElement("span");
      text.textContent = `#${tag}`;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", `Remove ${tag}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        profile.interests.splice(idx, 1);
        renderInterestPills();
      });

      pill.appendChild(text);
      pill.appendChild(removeBtn);
      selectedTagsEl.appendChild(pill);
    });
  }

  function addInterestTag(rawTag) {
    const cleaned = String(rawTag || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\-_ ]/g, "")
      .slice(0, 20);

    if (!cleaned) return;
    if (profile.interests.length >= 8) {
      toast("Maximum 8 interests allowed.");
      return;
    }
    if (profile.interests.includes(cleaned)) {
      toast("Interest already added.");
      return;
    }

    profile.interests.push(cleaned);
    renderInterestPills();
  }

  interestInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addInterestTag(interestInput.value);
      interestInput.value = "";
    } else if (e.key === "Backspace" && !interestInput.value && profile.interests.length > 0) {
      profile.interests.pop();
      renderInterestPills();
    }
  });

  quickTagsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    addInterestTag(chip.dataset.tag);
  });

  profileBio.addEventListener("input", () => {
    bioCount.textContent = `${profileBio.value.length}/160`;
  });

  function setUsernameFeedback(stateClass, text, isValid) {
    usernameStatus.className = "status-tag" + (stateClass ? ` ${stateClass}` : "");
    usernameStatus.textContent = text;
    usernameValid = Boolean(isValid);
  }

  async function checkUsernameAvailability(rawName) {
    const trimmed = rawName.trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(trimmed)) {
      setUsernameFeedback("err", "3–20 chars", false);
      return false;
    }

    setUsernameFeedback("", "Checking...", false);

    try {
      const qs = new URLSearchParams({
        username: trimmed,
        socketId: socket && socket.id ? socket.id : ""
      });
      const res = await fetch(`/api/username-available?${qs.toString()}`);
      const data = await res.json();

      if (data.available) {
        setUsernameFeedback("ok", "Available", true);
        return true;
      }
      setUsernameFeedback("err", data.reason || "Taken", false);
      return false;
    } catch {
      setUsernameFeedback("err", "Check failed", false);
      return false;
    }
  }

  profileUsername.addEventListener("input", () => {
    clearTimeout(usernameCheckTimer);
    const val = profileUsername.value;
    usernameCheckTimer = setTimeout(() => {
      checkUsernameAvailability(val);
    }, 300);
  });

  function openProfileEditor(isEditingMidSession) {
    showBannerError(profileError, "");
    profileFormTitle.textContent = isEditingMidSession ? "Edit Guest Profile" : "Create Guest Profile";
    saveProfileBtn.textContent = isEditingMidSession ? "Save & Find Match" : "Start Matching";
    closeProfileBtn.hidden = !isEditingMidSession;

    profileUsername.value = profile.username;
    profileBio.value = profile.bio;
    bioCount.textContent = `${profile.bio.length}/160`;

    buildAvatarGrid();
    renderInterestPills();
    switchView("profile");

    if (profile.username) {
      checkUsernameAvailability(profile.username);
    } else {
      setUsernameFeedback("", "3–20 chars", false);
    }
  }

  closeProfileBtn.addEventListener("click", () => {
    startSearch();
  });

  navEditProfileBtn.addEventListener("click", () => {
    if (socket && socket.connected) socket.emit("pause_search");
    openProfileEditor(true);
  });

  profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showBannerError(profileError, "");

    if (interestInput.value.trim()) {
      addInterestTag(interestInput.value);
      interestInput.value = "";
    }

    const isAvailable = await checkUsernameAvailability(profileUsername.value);
    if (!isAvailable || !usernameValid) {
      showBannerError(profileError, "Please choose a valid, available username (3–20 letters, numbers, or _).");
      profileUsername.focus();
      return;
    }

    profile.username = profileUsername.value.trim();
    profile.bio = profileBio.value.trim().slice(0, 160);
    saveStoredProfile();

    startSearch();
  });

  /* =========================================================
     MATCHMAKING LOADING SCREEN & FILTER BLOCKS
  ========================================================= */
  openGenderFilterBtn.addEventListener("click", () => openFilterOrPremiumModal("gender"));
  openCountryFilterBtn.addEventListener("click", () => openFilterOrPremiumModal("country"));

  editFromMatchBtn.addEventListener("click", () => {
    if (socket && socket.connected) socket.emit("pause_search");
    openProfileEditor(true);
  });

  cancelMatchBtn.addEventListener("click", () => {
    if (socket && socket.connected) socket.emit("pause_search");
    chatState = "idle";
    switchView("gateway");
  });

  /* =========================================================
     SOCKET.IO CONNECTION & REAL-TIME CHAT
  ========================================================= */
  function connectSocketAndMatch() {
    if (socket && socket.connected) {
      socket.emit("save_profile", profile, (res) => {
        if (res && res.ok && res.profile) {
          profile = res.profile;
          saveStoredProfile();
        }
        socket.emit("find_partner", profile);
      });
      return;
    }

    if (socket) {
      socket.disconnect();
    }

    socket = io({
      auth: { sessionToken }
    });

    socket.on("connect", () => {
      socket.emit("save_profile", profile, (res) => {
        if (res && res.ok && res.profile) {
          profile = res.profile;
          saveStoredProfile();
        }
        socket.emit("find_partner", profile);
      });
    });

    socket.on("connect_error", (err) => {
      const msg = err && err.message ? err.message : "";
      if (msg.startsWith("IP_BANNED:")) {
        showBanScreen("Your IP address has received 3 community reports and is suspended for 7 days.");
        return;
      }
      if (msg === "CAPTCHA_REQUIRED") {
        sessionToken = "";
        sessionStorage.removeItem(STORAGE_TOKEN_KEY);
        switchView("gateway");
        showBannerError(gatewayError, "Session expired. Please complete Captcha to continue.");
        if (window.turnstile && turnstileWidgetId !== null) {
          window.turnstile.reset(turnstileWidgetId);
        }
      }
    });

    socket.on("online_count", (data) => {
      if (data && typeof data.count === "number") {
        onlineCountEl.textContent = String(Math.max(1, data.count));
      }
    });

    socket.on("quota_update", (data) => {
      if (data) {
        updateQuotaDisplay(data.photosRemaining, data.photoLimit);
      }
    });

    socket.on("matched", (data) => {
      feed.textContent = "";
      chatState = "connected";
      resumeSearchOnModalClose = false;
      setComposerEnabled(true);
      reportBtn.disabled = false;
      resetNextButton();
      switchView("chat");

      const partner = (data && data.partner) || {};
      const common = data && Array.isArray(data.commonInterests) ? data.commonInterests : [];

      renderPartnerBanner(partner, common);

      if (common.length > 0) {
        appendSystemMessage(`Connected with @${partner.username || "stranger"} — Shared interests: ${common.join(", ")}`);
      } else {
        appendSystemMessage(`Connected with @${partner.username || "stranger"}. Say hello!`);
      }
    });

    socket.on("receive_message", (data) => {
      if (!data || typeof data.text !== "string") return;
      typingRow.hidden = true;
      appendMessage({ mine: false, text: data.text, timestamp: data.timestamp });
    });

    socket.on("receive_image", (data) => {
      if (!data || typeof data.image !== "string") return;
      typingRow.hidden = true;
      appendMessage({ mine: false, image: data.image, timestamp: data.timestamp });
    });

    socket.on("typing", (data) => {
      if (chatState !== "connected") return;
      typingRow.hidden = !(data && data.isTyping);
    });

    socket.on("partner_left", (data) => {
      chatState = "ended";
      setComposerEnabled(false);
      reportBtn.disabled = true;
      partnerBanner.hidden = true;
      resetNextButton();

      const reason = data && data.reason;
      if (reason === "reported") {
        appendSystemMessage("Report submitted. Conversation ended.");
      } else if (reason === "skipped") {
        appendSystemMessage("Stranger skipped the chat.");
      } else {
        appendSystemMessage("Stranger disconnected.");
      }
    });

    socket.on("premium_required", (data) => {
      openFilterOrPremiumModal((data && data.message) || "This feature is only available in Premium");
    });

    socket.on("ip_banned", (data) => {
      chatState = "ended";
      setComposerEnabled(false);
      showBanScreen(data && data.message);
    });

    socket.on("system_error", (data) => {
      toast((data && data.message) || "Connection notice.");
    });

    socket.on("disconnect", () => {
      if (chatState === "connected" || chatState === "searching") {
        chatState = "ended";
        setComposerEnabled(false);
        reportBtn.disabled = true;
        resetNextButton();
        appendSystemMessage("Disconnected from server. Click Find Match to reconnect.");
      }
    });
  }

  /* =========================================================
     CHAT UI HELPERS & MESSAGE RENDERING (STRICTLY XSS-SAFE)
  ========================================================= */
  function renderPartnerBanner(partner, commonInterests) {
    const avatarId = Number.isInteger(partner.avatarId) && partner.avatarId >= 1 && partner.avatarId <= 16
      ? partner.avatarId
      : 1;

    partnerAvatar.src = `/omeavatar/${avatarId}.jpg`;
    partnerName.textContent = `@${partner.username || "stranger"}`;
    typingUser.textContent = `@${partner.username || "Stranger"}`;
    partnerBio.textContent = partner.bio || "No bio provided.";

    sharedTagsEl.textContent = "";
    const allTags = Array.isArray(partner.interests) ? partner.interests : [];
    const commonSet = new Set(commonInterests);

    allTags.forEach((tag) => {
      const pill = document.createElement("span");
      pill.className = "tag-pill" + (commonSet.has(tag) ? " shared" : "");
      pill.textContent = `#${tag}`;
      sharedTagsEl.appendChild(pill);
    });

    partnerBanner.hidden = false;
  }

  function appendSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "sys-msg";
    div.textContent = text;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
  }

  function appendMessage({ mine, text, image, timestamp }) {
    const bubble = document.createElement("div");
    bubble.className = "msg" + (mine ? " mine" : "") + (image ? " has-image" : "");

    if (!mine) {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = partnerName.textContent || "Stranger";
      bubble.appendChild(who);
    }

    if (image) {
      const img = document.createElement("img");
      img.src = image;
      img.alt = "Shared photo";
      img.addEventListener("load", () => {
        feed.scrollTop = feed.scrollHeight;
      });
      img.addEventListener("click", () => {
        lightboxImg.src = image;
        lightbox.hidden = false;
      });
      bubble.appendChild(img);
    }

    if (text) {
      const body = document.createElement("div");
      body.className = "txt";
      body.textContent = text;
      bubble.appendChild(body);
    }

    const time = document.createElement("time");
    const dt = timestamp ? new Date(timestamp) : new Date();
    time.textContent = dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    bubble.appendChild(time);

    feed.appendChild(bubble);
    feed.scrollTop = feed.scrollHeight;
  }

  function setComposerEnabled(enabled) {
    msgInput.disabled = !enabled;
    sendBtn.disabled = !enabled;
    if (!enabled) {
      typingRow.hidden = true;
    } else if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
      msgInput.focus();
    }
  }

  function resetNextButton() {
    confirmSkip = false;
    clearTimeout(confirmSkipTimer);
    nextBtn.textContent = chatState === "connected" ? "Next" : "Find Match";
  }

  function startSearch() {
    feed.textContent = "";
    partnerBanner.hidden = true;
    reportBtn.disabled = true;
    chatState = "searching";
    setComposerEnabled(false);
    resetNextButton();

    searchSpinner.classList.remove("paused");
    searchHeading.textContent = "Finding a stranger...";
    searchSubtext.textContent = profile.interests.length > 0
      ? `Matching interests: ${profile.interests.join(", ")}`
      : "Connecting you with the next available stranger";

    switchView("matching");
    connectSocketAndMatch();
  }

  /* =========================================================
     TEXT, IMAGE COMPRESSION (3/DAY) & VOICE LOCK
  ========================================================= */
  function sendTextMessage() {
    if (chatState !== "connected" || !socket) return;
    const text = msgInput.value.trim();
    if (!text) return;

    msgInput.value = "";
    emitTypingStop();

    socket.emit("send_message", { text }, (res) => {
      if (res && res.ok) {
        appendMessage({ mine: true, text, timestamp: res.timestamp });
      } else {
        toast((res && res.error) || "Message could not be sent.");
      }
    });
  }

  sendBtn.addEventListener("click", sendTextMessage);

  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendTextMessage();
    }
  });

  function emitTypingStop() {
    if (isCurrentlyTyping && socket && socket.connected) {
      isCurrentlyTyping = false;
      socket.emit("typing", { isTyping: false });
    }
  }

  msgInput.addEventListener("input", () => {
    if (chatState !== "connected" || !socket) return;
    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      socket.emit("typing", { isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(emitTypingStop, 1500);
  });

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const MAX_WIDTH = 720;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > MAX_WIDTH) {
          h = Math.round((h * MAX_WIDTH) / w);
          w = MAX_WIDTH;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#0b0e14";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(objectUrl);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Invalid image"));
      };
      img.src = objectUrl;
    });
  }

  imgBtn.addEventListener("click", () => {
    if (photosRemaining <= 0) {
      openFilterOrPremiumModal("You have used all 3 free picture shares today. Upgrade to Premium for 50 daily photos!");
      return;
    }
    if (chatState !== "connected") {
      toast("Connect with a stranger first to share a photo.");
      return;
    }
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file || chatState !== "connected" || !socket) return;

    try {
      const compressedDataUrl = await compressImage(file);
      socket.emit("send_image", { image: compressedDataUrl }, (res) => {
        if (res && res.ok) {
          appendMessage({ mine: true, image: compressedDataUrl, timestamp: res.timestamp });
        } else if (res && res.reason === "premium_required") {
          openFilterOrPremiumModal("This feature is only available in Premium");
        } else {
          toast((res && res.error) || "Could not send photo.");
        }
      });
    } catch {
      toast("Could not process that image file.");
    }
  });

  // Premium-Gated Controls
  voiceBtn.addEventListener("click", () => {
    openFilterOrPremiumModal("This feature is only available in Premium");
  });

  navPremiumBtn.addEventListener("click", () => {
    openFilterOrPremiumModal("This feature is only available in Premium");
  });

  closePremiumModal.addEventListener("click", closePremiumAndResume);

  checkoutPreviewBtn.addEventListener("click", () => {
    toast("UPI ($4.99/mo & $29.99/yr) & PayPal checkout activate in Phase 3!");
  });

  // Next / Confirm Skip / Report
  nextBtn.addEventListener("click", () => {
    if (chatState === "idle" || chatState === "ended") {
      startSearch();
      return;
    }
    if (chatState === "searching") {
      startSearch();
      return;
    }
    if (!confirmSkip) {
      confirmSkip = true;
      nextBtn.textContent = "Sure?";
      confirmSkipTimer = setTimeout(resetNextButton, 3000);
    } else {
      clearTimeout(confirmSkipTimer);
      emitTypingStop();
      if (socket) socket.emit("skip_partner");
      startSearch();
    }
  });

  reportBtn.addEventListener("click", () => {
    if (chatState !== "connected" || !socket) return;
    socket.emit("report_partner", (res) => {
      if (res && res.ok) {
        toast("User reported. 3 lifetime reports trigger a 7-day IP ban.");
      }
    });
  });

  // Lightbox & Escape Key
  lightbox.addEventListener("click", () => {
    lightbox.hidden = true;
    lightboxImg.removeAttribute("src");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!lightbox.hidden) {
        lightbox.hidden = true;
        lightboxImg.removeAttribute("src");
      } else if (!premiumModal.hidden) {
        closePremiumAndResume();
      } else if (!authModal.hidden) {
        authModal.hidden = true;
      }
    }
  });

  // Boot
  initConfigAndTurnstile();
})();