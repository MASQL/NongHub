// js/chat.js
let activeChannelId = null;
let activeChannelName = "";
let activeChannelCode = "";
let activeChannelAvatarUrl = null;
let messageSubscription = null;
let channelPresenceSubscription = null;
let channelUpdatesSubscription = null;
let profileUpdatesSubscription = null;
let presenceHeartbeatInterval = null;
let globalInboxSubscription = null;
let currentUserId = null;
let currentUsername = "";
let typingTimeout = null;
let isCurrentlyTyping = false;

// State untuk fitur Long-Press Pop-up & Reply
let replyingToUsername = null;
let activeMessagePopupEl = null;
let activeMessageBoxEl = null;

const userCache = {};
const userAvatarCache = {}; // { userId: avatar_url }
const channelCache = {}; // { channelId: { name, code, avatar_url, bio, created_by } }
const joinedChannelIds = new Set(); // Daftar ID channel yang diikuti user ini (untuk privasi notifikasi)
const renderedMessageIds = new Set();
const recentActiveSenders = new Map();
let unreadNotifications = [];

// Palet warna khas untuk setiap user (kontras dengan tema gelap NongkrongHub)
const USER_NAME_COLORS = [
  "#ff9f43", // Oranye
  "#00e5ff", // Cyan
  "#ff6b81", // Coral Pink
  "#2ed573", // Hijau Mint
  "#a29bfe", // Ungu Lavender
  "#feca57", // Kuning Emas
  "#ff4dff", // Magenta Terang
  "#54a0ff", // Biru Langit
  "#1dd1a1", // Tosca
  "#ff793f"  // Jingga Tua
];

// Kontrol Drawer Sidebar Mobile
function openMobileSidebar() {
  const sidebar = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (sidebar) sidebar.classList.add("mobile-open");
  if (backdrop) backdrop.classList.add("active");
}

function closeMobileSidebar() {
  const sidebar = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  const popup = document.getElementById("profile-popup");
  if (sidebar) sidebar.classList.remove("mobile-open");
  if (backdrop) backdrop.classList.remove("active");
  if (popup) popup.classList.remove("active");
}

function getUserColor(username) {
  if (!username) return "#00b8d4";
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % USER_NAME_COLORS.length;
  return USER_NAME_COLORS[index];
}

document.addEventListener("DOMContentLoaded", async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  currentUserId = session.user.id;
  await refreshAllProfilesCache();
  currentUsername = await getUsernameById(session.user.id, session.user.email, true);

  const profileEl = document.getElementById("display-profile-name");
  if (profileEl && currentUsername) {
    profileEl.textContent = currentUsername;
  }

  injectNavInboxDot();
  renderInboxNotifications();
  setupTypingListener();
  setupGlobalMessagePopupDismiss();

  await loadUserChannels(currentUserId);
  subscribeGlobalInbox(currentUserId);
  subscribeChannelUpdates(currentUserId);
  subscribeProfileUpdates(currentUserId);
});

window.addEventListener("beforeunload", () => {
  if (channelPresenceSubscription) {
    channelPresenceSubscription.untrack();
  }
});

// Tutup pop-up aksi pesan jika klik/sentuh di luar area pop-up
function setupGlobalMessagePopupDismiss() {
  document.addEventListener("mousedown", (e) => {
    if (activeMessagePopupEl && !activeMessagePopupEl.contains(e.target)) {
      closeMessageActionPopup();
    }
  });
  document.addEventListener("touchstart", (e) => {
    if (activeMessagePopupEl && !activeMessagePopupEl.contains(e.target)) {
      closeMessageActionPopup();
    }
  }, { passive: true });
}

function closeMessageActionPopup() {
  if (activeMessagePopupEl) {
    activeMessagePopupEl.remove();
    activeMessagePopupEl = null;
  }
  if (activeMessageBoxEl) {
    activeMessageBoxEl.classList.remove("popup-open", "pressing");
    activeMessageBoxEl = null;
  }
}

function getCopyableMessageText(rawText) {
  if (rawText.startsWith("[IMG]|")) {
    const parts = rawText.split("|");
    return parts[1] || rawText;
  }
  if (rawText.startsWith("[FILE]|")) {
    const parts = rawText.split("|");
    return `${parts[2] || "File"} (${parts[1] || ""})`;
  }
  return rawText;
}

function showMessageActionPopup(boxEl, senderName, rawText) {
  closeMessageActionPopup();

  const popup = document.createElement("div");
  popup.className = "msg-action-popup";

  // 1. Tombol Salin text
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-popup-btn";
  copyBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span>Salin text</span>
  `;
  copyBtn.onclick = async (e) => {
    e.stopPropagation();
    const textToCopy = getCopyableMessageText(rawText);
    try {
      await navigator.clipboard.writeText(textToCopy);
    } catch (err) {
      const tempInput = document.createElement("textarea");
      tempInput.value = textToCopy;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand("copy");
      tempInput.remove();
    }
    copyBtn.innerHTML = `<span style="color: #2ed573;">✓ Tersalin</span>`;
    setTimeout(() => closeMessageActionPopup(), 550);
  };

  const divider = document.createElement("div");
  divider.className = "msg-popup-divider";

  // 2. Tombol Reply / Balas
  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "msg-popup-btn";
  replyBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 17 4 12 9 7"></polyline>
      <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
    </svg>
    <span>Reply/Balas</span>
  `;
  replyBtn.onclick = (e) => {
    e.stopPropagation();
    closeMessageActionPopup();
    startReplyToUser(senderName);
  };

  popup.appendChild(copyBtn);
  popup.appendChild(divider);
  popup.appendChild(replyBtn);

  boxEl.classList.add("popup-open");
  boxEl.appendChild(popup);
  activeMessagePopupEl = popup;
  activeMessageBoxEl = boxEl;
}

// Pasang trigger tekan lama (tahan klik mouse di browser / tahan sentuh di HP)
function attachLongPressHandlers(boxEl, senderName, rawText) {
  let pressTimer = null;
  const LONG_PRESS_DURATION = 450; // 450ms tekan lama

  const startPress = (e) => {
    if (e.type === "mousedown" && e.button !== 0) return;
    if (e.target.closest(".msg-action-popup")) return;

    boxEl.classList.add("pressing");
    pressTimer = setTimeout(() => {
      boxEl.classList.remove("pressing");
      showMessageActionPopup(boxEl, senderName, rawText);
    }, LONG_PRESS_DURATION);
  };

  const cancelPress = () => {
    boxEl.classList.remove("pressing");
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  // Event Desktop (Browser Mouse)
  boxEl.addEventListener("mousedown", startPress);
  boxEl.addEventListener("mouseup", cancelPress);
  boxEl.addEventListener("mouseleave", cancelPress);

  // Event Mobile (Touchscreen)
  boxEl.addEventListener("touchstart", startPress, { passive: true });
  boxEl.addEventListener("touchend", cancelPress);
  boxEl.addEventListener("touchmove", cancelPress, { passive: true });
  boxEl.addEventListener("touchcancel", cancelPress);

  // Cegah menu klik kanan bawaan browser/HP saat tekan lama pada bubble chat
  boxEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });
}

function startReplyToUser(targetUsername) {
  replyingToUsername = targetUsername;
  const bar = document.getElementById("reply-preview-bar");
  const label = document.getElementById("reply-preview-label");
  const input = document.getElementById("chat-input");

  if (bar && label) {
    label.textContent = `Reply (${targetUsername})`;
    bar.style.display = "flex";
  }

  if (input) {
    input.placeholder = `Balas pesan ${targetUsername}...`;
    input.focus();
  }
}

function cancelReply() {
  replyingToUsername = null;
  const bar = document.getElementById("reply-preview-bar");
  const input = document.getElementById("chat-input");

  if (bar) {
    bar.style.display = "none";
  }
  if (input) {
    input.placeholder = "Apa yang ingin kamu bahas?";
  }
}

async function refreshAllProfilesCache() {
  const { data: profiles } = await supabaseClient
    .from("profiles")
    .select("id, username, avatar_url");

  if (profiles) {
    profiles.forEach(p => {
      if (p.username) {
        userCache[p.id] = p.username;
      }
      if (p.avatar_url) {
        userAvatarCache[p.id] = p.avatar_url;
      } else {
        delete userAvatarCache[p.id];
      }
    });
  }
}

function injectNavInboxDot() {
  const navInbox = document.getElementById("nav-inbox");
  if (!navInbox || document.getElementById("nav-inbox-red-dot")) return;

  const svgIcon = navInbox.querySelector("svg");
  if (svgIcon) {
    const wrapper = document.createElement("div");
    wrapper.className = "nav-inbox-wrapper";
    svgIcon.parentNode.insertBefore(wrapper, svgIcon);
    wrapper.appendChild(svgIcon);

    const dot = document.createElement("span");
    dot.id = "nav-inbox-red-dot";
    dot.className = "unread-red-dot nav-inbox-dot";
    wrapper.appendChild(dot);
  }
}

async function getUsernameById(userId, fallbackEmail = "", forceRefresh = false) {
  if (!userId) return "User";
  if (!forceRefresh && userCache[userId]) return userCache[userId];

  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("username, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (profile) {
    if (profile.avatar_url) {
      userAvatarCache[userId] = profile.avatar_url;
    }
    if (profile.username) {
      userCache[userId] = profile.username;
      return profile.username;
    }
  }

  if (fallbackEmail) {
    const extracted = fallbackEmail.split("@")[0];
    userCache[userId] = extracted;
    return extracted;
  }

  return "User";
}

async function getUserAvatarById(userId, forceRefresh = false) {
  if (!userId) return null;
  if (!forceRefresh && Object.prototype.hasOwnProperty.call(userAvatarCache, userId)) {
    return userAvatarCache[userId];
  }

  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("username, avatar_url")
    .eq("id", userId)
    .maybeSingle();

  if (profile) {
    if (profile.username) userCache[userId] = profile.username;
    userAvatarCache[userId] = profile.avatar_url || null;
    return userAvatarCache[userId];
  }

  return null;
}

// Perbarui seluruh foto profil user pada gelembung chat & notifikasi secara instan
function applyUserAvatarToChat(userId, avatarUrl) {
  const bgValue = avatarUrl ? `url('${avatarUrl}')` : "none";

  document.querySelectorAll(`.avatar-circle[data-sender-id="${userId}"]`).forEach(el => {
    el.style.backgroundImage = bgValue;
  });

  unreadNotifications.forEach(item => {
    if (item.senderId === userId) {
      item.senderAvatar = avatarUrl || null;
    }
  });
}

// Listener Real-Time: Perubahan foto profil atau username user langsung ter-update di semua layar
function subscribeProfileUpdates(userId) {
  if (profileUpdatesSubscription) {
    supabaseClient.removeChannel(profileUpdatesSubscription);
  }

  profileUpdatesSubscription = supabaseClient
    .channel("profiles-realtime-updates-" + userId + "-" + Math.random().toString(36).slice(2, 7))
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "profiles"
      },
      (payload) => {
        const updated = payload.new;
        if (!updated || !updated.id) return;

        const newAvatar = updated.avatar_url || null;
        userAvatarCache[updated.id] = newAvatar;
        applyUserAvatarToChat(updated.id, newAvatar);

        if (updated.username) {
          userCache[updated.id] = updated.username;
          const newColor = getUserColor(updated.username);
          document.querySelectorAll(`.msg-meta[data-sender-id="${updated.id}"]`).forEach(metaEl => {
            metaEl.textContent = updated.username;
            metaEl.style.color = newColor;
          });
        }
      }
    )
    .subscribe();
}

async function getChannelInfoById(channelId) {
  if (channelCache[channelId]) return channelCache[channelId];

  const { data: ch } = await supabaseClient
    .from("channels")
    .select("*")
    .eq("id", channelId)
    .maybeSingle();

  if (ch) {
    channelCache[channelId] = {
      name: ch.name,
      code: ch.channel_code,
      avatar_url: ch.avatar_url || null,
      bio: ch.bio || "",
      created_by: ch.created_by || null
    };
    return channelCache[channelId];
  }

  return { name: "Channel", code: "NH-0000", avatar_url: null, bio: "", created_by: null };
}

function applyChannelAvatarVisual(channelId, avatarUrl) {
  const bgValue = avatarUrl ? `url('${avatarUrl}')` : "none";

  // 1. Update ikon lingkaran di sidebar kiri
  const navEl = document.getElementById("nav-ch-" + channelId);
  if (navEl) {
    const iconCircle = navEl.querySelector(".nav-icon-circle");
    if (iconCircle) iconCircle.style.backgroundImage = bgValue;
  }

  // 2. Jika user sedang membuka channel ini, update header chat & halaman bio
  if (activeChannelId === channelId) {
    activeChannelAvatarUrl = avatarUrl || null;

    const headerAvatar = document.getElementById("active-channel-avatar");
    if (headerAvatar) headerAvatar.style.backgroundImage = bgValue;

    const bioAvatar = document.getElementById("bio-channel-avatar");
    if (bioAvatar) bioAvatar.style.backgroundImage = bgValue;
  }
}

// Listener Real-Time: Perubahan foto profil & bio channel langsung muncul di layar user lain
function subscribeChannelUpdates(userId) {
  if (channelUpdatesSubscription) {
    supabaseClient.removeChannel(channelUpdatesSubscription);
  }

  channelUpdatesSubscription = supabaseClient
    .channel("channel-realtime-updates-" + userId + "-" + Math.random().toString(36).slice(2, 7))
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "channels"
      },
      (payload) => {
        const updated = payload.new;
        if (!updated || !joinedChannelIds.has(updated.id)) return;

        channelCache[updated.id] = {
          name: updated.name,
          code: updated.channel_code,
          avatar_url: updated.avatar_url || null,
          bio: updated.bio || "",
          created_by: updated.created_by || null
        };

        applyChannelAvatarVisual(updated.id, updated.avatar_url || null);

        if (activeChannelId === updated.id) {
          const bioDescEl = document.getElementById("bio-channel-desc");
          if (bioDescEl) {
            bioDescEl.textContent = updated.bio || "Belum ada bio untuk channel ini.";
          }
        }
      }
    )
    .subscribe();
}

// 1. Memuat daftar channel milik user ke sidebar & simpan ke joinedChannelIds
async function loadUserChannels(userId) {
  const { data: memberships, error } = await supabaseClient
    .from("channel_members")
    .select(`
      channel_id,
      channels ( * )
    `)
    .eq("user_id", userId);

  if (error) {
    console.error("Gagal memuat channel:", error.message);
    return;
  }

  joinedChannelIds.clear();

  const container = document.getElementById("channel-list-container");
  container.querySelectorAll(".dynamic-channel").forEach(el => el.remove());

  const dummy1 = document.getElementById("nav-channel-1");
  const dummy2 = document.getElementById("nav-channel-2");
  if (dummy1) dummy1.remove();
  if (dummy2) dummy2.remove();

  if (memberships && memberships.length > 0) {
    memberships.forEach(item => {
      if (item.channels) {
        joinedChannelIds.add(item.channels.id);
        channelCache[item.channels.id] = {
          name: item.channels.name,
          code: item.channels.channel_code,
          avatar_url: item.channels.avatar_url || null,
          bio: item.channels.bio || "",
          created_by: item.channels.created_by || null
        };
        appendChannelToSidebar(
          item.channels.id,
          item.channels.name,
          item.channels.channel_code,
          item.channels.avatar_url || null
        );
      }
    });
  }
}

function appendChannelToSidebar(channelId, name, code, avatarUrl = null) {
  const navId = "nav-ch-" + channelId;
  joinedChannelIds.add(channelId);
  channelCache[channelId] = {
    ...(channelCache[channelId] || {}),
    name,
    code,
    avatar_url: avatarUrl
  };

  const existing = document.getElementById(navId);
  if (existing) {
    applyChannelAvatarVisual(channelId, avatarUrl);
    return;
  }

  const newNav = document.createElement("div");
  newNav.className = "nav-item dynamic-channel";
  newNav.id = navId;
  newNav.onclick = () => {
    const latest = channelCache[channelId] || { name, code, avatar_url: avatarUrl };
    openChannel(channelId, latest.name, latest.code, navId, latest.avatar_url);
  };

  const bgStyle = avatarUrl ? `style="background-image: url('${avatarUrl}');"` : "";
  newNav.innerHTML = `
    <div class="nav-icon-circle" ${bgStyle}></div>
    <span>${name}</span>
  `;

  const container = document.getElementById("channel-list-container");
  const addBtn = document.getElementById("nav-add-channel");
  container.insertBefore(newNav, addBtn);
}

function setActiveNav(navId) {
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));
  if (navId) {
    const target = document.getElementById(navId);
    if (target) target.classList.add("active");
  }
}

async function leaveChannelPresence() {
  isCurrentlyTyping = false;
  recentActiveSenders.clear();
  closeMessageActionPopup();
  cancelReply();

  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
  if (presenceHeartbeatInterval) {
    clearInterval(presenceHeartbeatInterval);
    presenceHeartbeatInterval = null;
  }
  if (channelPresenceSubscription) {
    try {
      await channelPresenceSubscription.untrack();
    } catch (e) {}
    await supabaseClient.removeChannel(channelPresenceSubscription);
    channelPresenceSubscription = null;
  }
}

async function switchScreen(screenName) {
  closeMobileSidebar();
  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  const screen = document.getElementById("screen-" + screenName);
  if (screen) screen.classList.add("active");

  if (screenName === "inbox") {
    activeChannelId = null;
    await leaveChannelPresence();
    setActiveNav("nav-inbox");
    renderInboxNotifications();
  }
  if (screenName === "explore") {
    activeChannelId = null;
    await leaveChannelPresence();
    setActiveNav("nav-add-channel");
  }
}

// 2. Notifikasi Pesan Masuk Terbatas: HANYA untuk channel yang sudah diikuti user ini
function subscribeGlobalInbox(userId) {
  if (globalInboxSubscription) {
    supabaseClient.removeChannel(globalInboxSubscription);
  }

  globalInboxSubscription = supabaseClient
    .channel("global-broadcast-" + userId + "-" + Math.random().toString(36).slice(2, 7))
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages"
      },
      async (payload) => {
        const newMsg = payload.new;

        if (newMsg.sender_id === currentUserId) return;
        if (!joinedChannelIds.has(newMsg.channel_id)) return;

        const isChatScreenOpen = document.getElementById("screen-chat").classList.contains("active");
        if (isChatScreenOpen && activeChannelId === newMsg.channel_id) {
          return;
        }

        const senderName = await getUsernameById(newMsg.sender_id, "", true);
        const senderAvatar = await getUserAvatarById(newMsg.sender_id, true);
        const channelInfo = await getChannelInfoById(newMsg.channel_id);

        unreadNotifications.unshift({
          id: newMsg.id,
          channelId: newMsg.channel_id,
          channelName: channelInfo.name,
          channelCode: channelInfo.code,
          channelAvatar: channelInfo.avatar_url || null,
          senderId: newMsg.sender_id,
          senderName: senderName,
          senderAvatar: senderAvatar,
          content: newMsg.content,
          createdAt: new Date(newMsg.created_at || Date.now())
        });

        updateInboxBadge();
        renderInboxNotifications();
      }
    )
    .subscribe();
}

function updateInboxBadge() {
  const redDot = document.getElementById("nav-inbox-red-dot");
  if (!redDot) return;

  if (unreadNotifications.length > 0) {
    redDot.classList.add("active");
  } else {
    redDot.classList.remove("active");
  }
}

function formatTimeAgo(dateObj) {
  const diffSec = Math.max(1, Math.floor((Date.now() - dateObj.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec} dtk`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} mnt`;
  const diffHour = Math.floor(diffMin / 60);
  return `${diffHour} jam`;
}

function renderInboxNotifications() {
  const inboxList = document.getElementById("inbox-list");
  if (!inboxList) return;

  inboxList.innerHTML = "";

  if (unreadNotifications.length === 0) {
    inboxList.innerHTML = '<div class="empty-state" style="margin-top: 80px;">Tidak ada pesan masuk baru</div>';
    return;
  }

  unreadNotifications.forEach(item => {
    const card = document.createElement("div");
    card.className = "inbox-card";
    card.onclick = () => {
      unreadNotifications = unreadNotifications.filter(n => n.channelId !== item.channelId);
      updateInboxBadge();
      const latest = channelCache[item.channelId] || {
        name: item.channelName,
        code: item.channelCode,
        avatar_url: item.channelAvatar || null
      };
      openChannel(item.channelId, latest.name, latest.code, "nav-ch-" + item.channelId, latest.avatar_url);
    };

    const senderColor = getUserColor(item.senderName);
    const resolvedAvatar = (item.senderId && userAvatarCache[item.senderId]) || item.senderAvatar || null;
    const avatarStyle = resolvedAvatar ? `style="background-image: url('${resolvedAvatar}');"` : "";
    const senderDataAttr = item.senderId ? `data-sender-id="${item.senderId}"` : "";

    card.innerHTML = `
      <div class="inbox-card-left">
        <div class="avatar-circle" ${senderDataAttr} ${avatarStyle}></div>
        <div class="inbox-text">
          <strong style="color: ${senderColor};">${item.senderName} <small style="color: var(--cyan); font-weight: normal;">[${item.channelName}]</small></strong>
          <span>${formatMessagePreview(item.content)}</span>
        </div>
      </div>
      <div class="inbox-card-right">
        <span class="inbox-time" style="margin-left: 0;">${formatTimeAgo(item.createdAt)}</span>
        <span class="unread-red-dot active" title="Pesan belum dibaca"></span>
      </div>
    `;
    inboxList.appendChild(card);
  });
}

// 3. Membuka Channel & Mengaktifkan Presence (Online Count + Typing) & Chat Real-Time
async function openChannel(channelId, channelName, channelCode, navId, avatarUrl = null) {
  closeMobileSidebar();

  if (activeChannelId && activeChannelId !== channelId) {
    await leaveChannelPresence();
  } else {
    closeMessageActionPopup();
    cancelReply();
  }

  activeChannelId = channelId;
  activeChannelName = channelName;
  activeChannelCode = channelCode;
  activeChannelAvatarUrl = avatarUrl || channelCache[channelId]?.avatar_url || null;

  unreadNotifications = unreadNotifications.filter(n => n.channelId !== channelId);
  updateInboxBadge();

  document.getElementById("active-channel-title").textContent = activeChannelName;
  document.getElementById("active-channel-code").textContent = activeChannelCode;
  applyChannelAvatarVisual(channelId, activeChannelAvatarUrl);

  const infoEl = document.getElementById("channel-presence-info");
  if (infoEl) {
    infoEl.classList.remove("typing-active");
    infoEl.textContent = "1 online • Anda";
  }

  setActiveNav(navId);

  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-chat").classList.add("active");

  await fetchChannelMessages(channelId);
  subscribeToChannelMessages(channelId);
  await subscribeToChannelPresence(channelId);
}

async function subscribeToChannelPresence(channelId) {
  await leaveChannelPresence();

  if (!currentUsername || currentUsername === "User") {
    currentUsername = await getUsernameById(currentUserId, "", true);
  }

  const presenceTopic = `channel-presence-${channelId}`;
  channelPresenceSubscription = supabaseClient.channel(presenceTopic, {
    config: {
      presence: {
        key: currentUserId
      }
    }
  });

  const sendPresenceTrack = async () => {
    if (!channelPresenceSubscription) return;
    await channelPresenceSubscription.track({
      user_id: currentUserId,
      username: currentUsername,
      is_typing: isCurrentlyTyping,
      online_at: new Date().toISOString()
    });
  };

  channelPresenceSubscription
    .on("presence", { event: "sync" }, () => {
      updateChannelPresenceHeader();
    })
    .on("presence", { event: "join" }, ({ key, newPresences }) => {
      if (key && key !== currentUserId && newPresences?.length) {
        const info = newPresences[newPresences.length - 1];
        recentActiveSenders.set(key, {
          username: info.username || "User",
          lastSeen: Date.now()
        });
      }
      updateChannelPresenceHeader();
    })
    .on("presence", { event: "leave" }, ({ key }) => {
      if (key) {
        recentActiveSenders.delete(key);
      }
      updateChannelPresenceHeader();
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await sendPresenceTrack();
        setTimeout(() => {
          sendPresenceTrack();
          updateChannelPresenceHeader();
        }, 1200);
      }
    });

  presenceHeartbeatInterval = setInterval(() => {
    if (channelPresenceSubscription && activeChannelId === channelId) {
      sendPresenceTrack();
    }
  }, 8000);
}

function updateChannelPresenceHeader() {
  const infoEl = document.getElementById("channel-presence-info");
  if (!infoEl) return;

  const userMap = new Map();
  const typingUsers = [];

  userMap.set(currentUserId, "Anda");

  if (channelPresenceSubscription) {
    const state = channelPresenceSubscription.presenceState();
    Object.keys(state).forEach((uid) => {
      const entries = state[uid];
      if (!entries || entries.length === 0) return;
      const latest = entries[entries.length - 1];
      const uname = latest.username || userCache[uid] || "User";

      if (uid !== currentUserId) {
        userMap.set(uid, uname);
        if (latest.is_typing) {
          typingUsers.push(uname);
        }
      }
    });
  }

  const now = Date.now();
  recentActiveSenders.forEach((val, uid) => {
    if (uid !== currentUserId && now - val.lastSeen < 60000) {
      if (!userMap.has(uid)) {
        userMap.set(uid, val.username);
      }
    } else {
      recentActiveSenders.delete(uid);
    }
  });

  if (typingUsers.length > 0) {
    infoEl.classList.add("typing-active");
    if (typingUsers.length === 1) {
      infoEl.textContent = `${typingUsers[0]} sedang mengetik...`;
    } else if (typingUsers.length === 2) {
      infoEl.textContent = `${typingUsers[0]} dan ${typingUsers[1]} sedang mengetik...`;
    } else {
      infoEl.textContent = `${typingUsers[0]} dan ${typingUsers.length - 1} lainnya sedang mengetik...`;
    }
  } else {
    infoEl.classList.remove("typing-active");
    const onlineNames = Array.from(userMap.values());
    const totalOnline = onlineNames.length;
    infoEl.textContent = `${totalOnline} online • ${onlineNames.join(", ")}`;
  }
}

function setupTypingListener() {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) return;

  chatInput.addEventListener("input", () => {
    if (!channelPresenceSubscription || !activeChannelId) return;

    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      channelPresenceSubscription.track({
        user_id: currentUserId,
        username: currentUsername,
        is_typing: true
      });
    }

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isCurrentlyTyping = false;
      if (channelPresenceSubscription) {
        channelPresenceSubscription.track({
          user_id: currentUserId,
          username: currentUsername,
          is_typing: false
        });
      }
    }, 1500);
  });
}

async function fetchChannelMessages(channelId) {
  const container = document.getElementById("chat-messages-area");
  container.innerHTML = '<div class="empty-state">Memuat pesan...</div>';
  renderedMessageIds.clear();

  await refreshAllProfilesCache();

  const { data: messages, error } = await supabaseClient
    .from("messages")
    .select("id, sender_id, content, created_at")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: true });

  if (error) {
    container.innerHTML = `<div class="empty-state">Gagal memuat pesan: ${error.message}</div>`;
    return;
  }

  container.innerHTML = "";
  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state" id="empty-msg-placeholder">No Message</div>';
    return;
  }

  for (const msg of messages) {
    const senderName = await getUsernameById(msg.sender_id);
    const senderAvatar = await getUserAvatarById(msg.sender_id);
    renderSingleMessage(senderName, msg.content, msg.id, msg.sender_id, senderAvatar);
  }
}

function subscribeToChannelMessages(channelId) {
  if (messageSubscription) {
    supabaseClient.removeChannel(messageSubscription);
  }

  messageSubscription = supabaseClient
    .channel("room-" + channelId + "-" + currentUserId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `channel_id=eq.${channelId}`
      },
      async (payload) => {
        const newMsg = payload.new;
        if (activeChannelId !== channelId) return;
        if (newMsg.id && renderedMessageIds.has(newMsg.id)) return;

        const senderName =
          newMsg.sender_id === currentUserId
            ? currentUsername
            : await getUsernameById(newMsg.sender_id, "", true);

        const senderAvatar = await getUserAvatarById(newMsg.sender_id, newMsg.sender_id !== currentUserId);

        if (newMsg.sender_id !== currentUserId) {
          recentActiveSenders.set(newMsg.sender_id, {
            username: senderName,
            lastSeen: Date.now()
          });
          updateChannelPresenceHeader();
        }

        renderSingleMessage(senderName, newMsg.content, newMsg.id, newMsg.sender_id, senderAvatar);
      }
    )
    .subscribe();
}

function formatMessagePreview(rawText) {
  if (rawText.startsWith("[IMG]|")) return "📷 Mengirim gambar";
  if (rawText.startsWith("[FILE]|")) {
    const parts = rawText.split("|");
    return `📎 File: ${parts[2] || "Dokumen"}`;
  }
  return rawText;
}

function escapeHtmlSafe(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSingleMessage(senderName, text, msgId = null, senderId = null, senderAvatarUrl = null) {
  if (msgId) {
    if (renderedMessageIds.has(msgId)) return;
    renderedMessageIds.add(msgId);
  }

  const container = document.getElementById("chat-messages-area");
  const placeholder = document.getElementById("empty-msg-placeholder");
  if (placeholder) placeholder.remove();

  let bodyHtml = "";

  if (text.startsWith("[IMG]|")) {
    const [, fileUrl, fileName] = text.split("|");
    bodyHtml = `
      <a href="${fileUrl}" target="_blank" title="Klik untuk memperbesar gambar">
        <img src="${fileUrl}" alt="${fileName || 'Gambar'}" class="chat-attached-image" />
      </a>
    `;
  } else if (text.startsWith("[FILE]|")) {
    const [, fileUrl, fileName, fileSize] = text.split("|");
    bodyHtml = `
      <a href="${fileUrl}" target="_blank" download="${fileName}" class="chat-attached-file">
        <span class="file-badge">FILE</span>
        <div>
          <div style="font-weight: 600; word-break: break-all;">${fileName}</div>
          <small style="color: var(--text-muted);">${fileSize || ""} • Klik untuk unduh</small>
        </div>
      </a>
    `;
  } else {
    const replyMatch = text.match(/^(Replyed\s+[^:]+:\s*)(.*)$/s);
    if (replyMatch) {
      bodyHtml = `<div class="msg-text"><span class="msg-reply-tag">${escapeHtmlSafe(replyMatch[1])}</span>${escapeHtmlSafe(replyMatch[2])}</div>`;
    } else {
      bodyHtml = `<div class="msg-text">${escapeHtmlSafe(text)}</div>`;
    }
  }

  const nameColor = getUserColor(senderName);
  const resolvedAvatar = (senderId && userAvatarCache[senderId]) || senderAvatarUrl || null;
  const avatarStyle = resolvedAvatar ? `style="background-image: url('${resolvedAvatar}');"` : "";
  const senderDataAttr = senderId ? `data-sender-id="${senderId}"` : "";

  const row = document.createElement("div");
  row.className = "msg-bubble-row";
  row.innerHTML = `
    <div class="avatar-circle" ${senderDataAttr} ${avatarStyle}></div>
    <div class="msg-content-box">
      <div class="msg-meta" ${senderDataAttr} style="color: ${nameColor};">${escapeHtmlSafe(senderName)}</div>
      ${bodyHtml}
    </div>
  `;

  const boxEl = row.querySelector(".msg-content-box");
  if (boxEl) {
    attachLongPressHandlers(boxEl, senderName, text);
  }

  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// 4. Mengirim Pesan ke Supabase & langsung matikan status typing
document.addEventListener("DOMContentLoaded", () => {
  const chatForm = document.getElementById("chat-form");
  if (!chatForm) return;

  chatForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const rawTypedText = input.value.trim();
    if (!rawTypedText || !activeChannelId || !currentUserId) return;

    const finalMessageText = replyingToUsername
      ? `Replyed ${replyingToUsername} : ${rawTypedText}`
      : rawTypedText;

    const targetChannelId = activeChannelId;
    const senderId = currentUserId;
    input.value = "";
    cancelReply();

    if (isCurrentlyTyping && channelPresenceSubscription) {
      isCurrentlyTyping = false;
      if (typingTimeout) clearTimeout(typingTimeout);
      channelPresenceSubscription.track({
        user_id: currentUserId,
        username: currentUsername,
        is_typing: false
      });
    }

    const { error } = await supabaseClient
      .from("messages")
      .insert([
        {
          channel_id: targetChannelId,
          sender_id: senderId,
          content: finalMessageText
        }
      ]);

    if (error) {
      alert("Gagal mengirim pesan: " + error.message);
    }
  });
});

// 5. Buat Channel Baru + Kode Unik di Database
async function createNewChannel() {
  const input = document.getElementById("channel-action-input");
  const name = input.value.trim();
  if (!name) {
    alert("Masukkan nama channel terlebih dahulu, lalu klik tombol Buat (+).");
    input.focus();
    return;
  }

  if (!currentUserId) return;

  const randomCode = "NH-" + Math.floor(1000 + Math.random() * 9000);

  const { data: newChannel, error: chError } = await supabaseClient
    .from("channels")
    .insert([
      {
        name: name,
        channel_code: randomCode,
        created_by: currentUserId
      }
    ])
    .select()
    .single();

  if (chError) {
    alert("Gagal membuat channel: " + chError.message);
    return;
  }

  await supabaseClient.from("channel_members").insert([
    {
      channel_id: newChannel.id,
      user_id: currentUserId
    }
  ]);

  joinedChannelIds.add(newChannel.id);
  channelCache[newChannel.id] = {
    name: newChannel.name,
    code: newChannel.channel_code,
    avatar_url: null,
    bio: "",
    created_by: currentUserId
  };

  input.value = "";
  appendChannelToSidebar(newChannel.id, newChannel.name, newChannel.channel_code, null);
  openChannel(newChannel.id, newChannel.name, newChannel.channel_code, "nav-ch-" + newChannel.id, null);
}

// 6. Cari & Gabung Channel via Kode / Nama
async function searchAndJoinChannel() {
  const input = document.getElementById("channel-action-input");
  const query = input.value.trim();
  if (!query) {
    alert("Masukkan Kode (contoh: NH-4821) atau Nama Channel yang ingin dicari.");
    input.focus();
    return;
  }

  if (!currentUserId) return;

  const { data: foundChannels, error } = await supabaseClient
    .from("channels")
    .select("*")
    .or(`channel_code.ilike.${query},name.ilike.${query}`)
    .limit(1);

  if (error || !foundChannels || foundChannels.length === 0) {
    alert("Channel tidak terdeteksi di database! Kembali ke Homepage.");
    switchScreen("welcome");
    setActiveNav(null);
    return;
  }

  const targetChannel = foundChannels[0];

  await supabaseClient
    .from("channel_members")
    .upsert(
      [{ channel_id: targetChannel.id, user_id: currentUserId }],
      { onConflict: "channel_id,user_id" }
    );

  joinedChannelIds.add(targetChannel.id);
  channelCache[targetChannel.id] = {
    name: targetChannel.name,
    code: targetChannel.channel_code,
    avatar_url: targetChannel.avatar_url || null,
    bio: targetChannel.bio || "",
    created_by: targetChannel.created_by || null
  };

  input.value = "";
  appendChannelToSidebar(
    targetChannel.id,
    targetChannel.name,
    targetChannel.channel_code,
    targetChannel.avatar_url || null
  );
  openChannel(
    targetChannel.id,
    targetChannel.name,
    targetChannel.channel_code,
    "nav-ch-" + targetChannel.id,
    targetChannel.avatar_url || null
  );
}

function copyChannelCode() {
  if (!activeChannelCode) return;
  navigator.clipboard.writeText(activeChannelCode);
  alert(`Kode Channel "${activeChannelName}" (${activeChannelCode}) berhasil disalin! Bagikan kode ini ke temanmu untuk bergabung.`);
}

function filterInbox() {
  const query = document.getElementById("search-inbox").value.toLowerCase();
  document.querySelectorAll(".inbox-card").forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(query) ? "flex" : "none";
  });
}

// Upload Gambar atau File ke Supabase Storage (Maksimal 50MB)
async function handleFileUpload(event, type) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  if (!activeChannelId || !currentUserId) {
    alert("Buka salah satu Channel terlebih dahulu sebelum mengirim file.");
    return;
  }

  const MAX_SIZE_BYTES = 50 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    alert("Ukuran file melebihi batas maksimal 50MB!");
    return;
  }

  const chatInput = document.getElementById("chat-input");
  const originalPlaceholder = chatInput.placeholder;
  chatInput.disabled = true;
  chatInput.placeholder = `Mengunggah ${file.name}...`;

  try {
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${activeChannelId}/${Date.now()}_${cleanFileName}`;

    const { error: uploadError } = await supabaseClient.storage
      .from("chat-uploads")
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabaseClient.storage
      .from("chat-uploads")
      .getPublicUrl(filePath);

    const fileUrl = publicUrlData.publicUrl;
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2) + " MB";

    const formattedPayload =
      type === "image"
        ? `[IMG]|${fileUrl}|${file.name}`
        : `[FILE]|${fileUrl}|${file.name}|${sizeMB}`;

    const { error: msgError } = await supabaseClient
      .from("messages")
      .insert([
        {
          channel_id: activeChannelId,
          sender_id: currentUserId,
          content: formattedPayload
        }
      ]);

    if (msgError) throw msgError;
  } catch (err) {
    alert("Gagal mengunggah file: " + err.message);
  } finally {
    chatInput.disabled = false;
    chatInput.placeholder = originalPlaceholder;
  }
}

// Buka halaman Bio Channel saat titik 3 di header chat ditekan
async function openChannelBio() {
  if (!activeChannelId) return;

  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-channel-bio").classList.add("active");

  document.getElementById("bio-channel-name").textContent = activeChannelName;
  document.getElementById("bio-channel-code").textContent = activeChannelCode;
  document.getElementById("bio-channel-desc").textContent = "Memuat bio channel...";

  const editBox = document.getElementById("bio-edit-box");
  const dangerText = document.getElementById("btn-channel-danger-text");
  const bioAvatar = document.getElementById("bio-channel-avatar");

  editBox.style.display = "none";
  dangerText.textContent = "Keluar Channel";
  if (bioAvatar) {
    bioAvatar.classList.remove("editable-channel-avatar");
    bioAvatar.removeAttribute("title");
    bioAvatar.onclick = null;
  }

  applyChannelAvatarVisual(activeChannelId, activeChannelAvatarUrl);

  const { data: channelData, error } = await supabaseClient
    .from("channels")
    .select("*")
    .eq("id", activeChannelId)
    .maybeSingle();

  if (error || !channelData) {
    document.getElementById("bio-channel-desc").textContent = "Belum ada bio untuk channel ini.";
    return;
  }

  const bioText = channelData.bio || "Belum ada bio untuk channel ini.";
  document.getElementById("bio-channel-desc").textContent = bioText;

  const latestAvatar = channelData.avatar_url || null;
  activeChannelAvatarUrl = latestAvatar;
  channelCache[activeChannelId] = {
    name: channelData.name,
    code: channelData.channel_code,
    avatar_url: latestAvatar,
    bio: channelData.bio || "",
    created_by: channelData.created_by || null
  };
  applyChannelAvatarVisual(activeChannelId, latestAvatar);

  const isCreator = String(channelData.created_by) === String(currentUserId);

  if (isCreator) {
    editBox.style.display = "block";
    document.getElementById("bio-edit-input").value = channelData.bio || "";
    dangerText.textContent = "Delete Channel";

    if (bioAvatar) {
      bioAvatar.classList.add("editable-channel-avatar");
      bioAvatar.title = "Klik untuk mengganti foto profil channel";
      bioAvatar.onclick = () => {
        document.getElementById("channel-avatar-input").click();
      };
    }
  } else {
    editBox.style.display = "none";
    dangerText.textContent = "Keluar Channel";
  }
}

// Unggah / Ubah Foto Profil Channel (Hanya Admin / Pembuat Channel)
async function uploadChannelAvatar(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !activeChannelId || !currentUserId) return;

  if (!file.type.startsWith("image/")) {
    alert("Harap pilih file gambar (JPG/PNG) untuk foto profil channel.");
    return;
  }

  const MAX_SIZE_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    alert("Ukuran foto profil channel maksimal 5MB!");
    return;
  }

  try {
    const { data: checkCh } = await supabaseClient
      .from("channels")
      .select("created_by")
      .eq("id", activeChannelId)
      .maybeSingle();

    if (!checkCh || String(checkCh.created_by) !== String(currentUserId)) {
      alert("Hanya pembuat channel (admin) yang dapat mengubah foto profil channel.");
      return;
    }

    const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `channel-avatars/${activeChannelId}_${Date.now()}_${cleanName}`;

    const { error: upErr } = await supabaseClient.storage
      .from("chat-uploads")
      .upload(filePath, file);

    if (upErr) throw upErr;

    const { data: urlData } = supabaseClient.storage
      .from("chat-uploads")
      .getPublicUrl(filePath);

    const newAvatarUrl = urlData.publicUrl;

    const { error: dbErr } = await supabaseClient
      .from("channels")
      .update({ avatar_url: newAvatarUrl })
      .eq("id", activeChannelId);

    if (dbErr) throw dbErr;

    if (channelCache[activeChannelId]) {
      channelCache[activeChannelId].avatar_url = newAvatarUrl;
    }
    applyChannelAvatarVisual(activeChannelId, newAvatarUrl);
    alert("Profile chanel berhasil di ubah");
  } catch (err) {
    alert("Gagal mengubah foto profil channel: " + err.message);
  }
}

function backToChannelChat() {
  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-chat").classList.add("active");
}

async function saveChannelBio() {
  if (!activeChannelId) return;
  const newBio = document.getElementById("bio-edit-input").value.trim();

  const { error } = await supabaseClient
    .from("channels")
    .update({ bio: newBio })
    .eq("id", activeChannelId);

  if (error) {
    alert("Gagal menyimpan bio: " + error.message);
    return;
  }

  if (channelCache[activeChannelId]) {
    channelCache[activeChannelId].bio = newBio;
  }
  document.getElementById("bio-channel-desc").textContent = newBio || "Belum ada bio untuk channel ini.";
  alert("Bio channel berhasil diperbarui!");
}

async function handleDeleteOrLeaveChannel() {
  if (!activeChannelId || !currentUserId) return;

  const { data: channelData } = await supabaseClient
    .from("channels")
    .select("created_by")
    .eq("id", activeChannelId)
    .maybeSingle();

  const isCreator = String(channelData?.created_by) === String(currentUserId);

  if (isCreator) {
    if (!confirm(`Hapus permanen channel "${activeChannelName}"?`)) return;
    await supabaseClient.from("channels").delete().eq("id", activeChannelId);
  } else {
    if (!confirm(`Keluar dari channel "${activeChannelName}"?`)) return;
    await supabaseClient
      .from("channel_members")
      .delete()
      .eq("channel_id", activeChannelId)
      .eq("user_id", currentUserId);
  }

  joinedChannelIds.delete(activeChannelId);

  const navEl = document.getElementById("nav-ch-" + activeChannelId);
  if (navEl) navEl.remove();

  await leaveChannelPresence();
  activeChannelId = null;
  switchScreen("welcome");
  setActiveNav(null);
}