// js/chat.js
let activeChannelId = null;
let activeChannelName = "";
let activeChannelCode = "";
let messageSubscription = null;
let channelPresenceSubscription = null;
let presenceHeartbeatInterval = null;
let globalInboxSubscription = null;
let currentUserId = null;
let currentUsername = "";
let typingTimeout = null;
let isCurrentlyTyping = false;

const userCache = {};
const channelCache = {};
const renderedMessageIds = new Set();
const recentActiveSenders = new Map(); // Fallback pelacak user aktif di channel: { userId: { username, lastSeen } }
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
  currentUsername = await getUsernameById(session.user.id, session.user.email, true);

  const profileEl = document.getElementById("display-profile-name");
  if (profileEl && currentUsername) {
    profileEl.textContent = currentUsername;
  }

  injectNavInboxDot();
  renderInboxNotifications();
  setupTypingListener();

  await refreshAllProfilesCache();
  await loadAllChannelsCache();
  await loadUserChannels(currentUserId);
  subscribeGlobalInbox(currentUserId);
});

// Pastikan presence bersih saat tab ditutup atau di-refresh
window.addEventListener("beforeunload", () => {
  if (channelPresenceSubscription) {
    channelPresenceSubscription.untrack();
  }
});

async function refreshAllProfilesCache() {
  const { data: profiles } = await supabaseClient
    .from("profiles")
    .select("id, username");

  if (profiles) {
    profiles.forEach(p => {
      if (p.username) {
        userCache[p.id] = p.username;
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
    .select("username")
    .eq("id", userId)
    .maybeSingle();

  if (profile && profile.username) {
    userCache[userId] = profile.username;
    return profile.username;
  }

  if (fallbackEmail) {
    const extracted = fallbackEmail.split("@")[0];
    userCache[userId] = extracted;
    return extracted;
  }

  return "User";
}

async function getChannelInfoById(channelId) {
  if (channelCache[channelId]) return channelCache[channelId];

  const { data: ch } = await supabaseClient
    .from("channels")
    .select("id, name, channel_code")
    .eq("id", channelId)
    .maybeSingle();

  if (ch) {
    channelCache[channelId] = { name: ch.name, code: ch.channel_code };
    return channelCache[channelId];
  }

  return { name: "Channel", code: "NH-0000" };
}

async function loadAllChannelsCache() {
  const { data: allChannels } = await supabaseClient
    .from("channels")
    .select("id, name, channel_code");

  if (allChannels) {
    allChannels.forEach(ch => {
      channelCache[ch.id] = { name: ch.name, code: ch.channel_code };
    });
  }
}

// 1. Memuat daftar channel milik user ke sidebar
async function loadUserChannels(userId) {
  const { data: memberships, error } = await supabaseClient
    .from("channel_members")
    .select(`
      channel_id,
      channels ( id, name, channel_code )
    `)
    .eq("user_id", userId);

  if (error) {
    console.error("Gagal memuat channel:", error.message);
    return;
  }

  const container = document.getElementById("channel-list-container");
  container.querySelectorAll(".dynamic-channel").forEach(el => el.remove());

  const dummy1 = document.getElementById("nav-channel-1");
  const dummy2 = document.getElementById("nav-channel-2");
  if (dummy1) dummy1.remove();
  if (dummy2) dummy2.remove();

  if (memberships && memberships.length > 0) {
    memberships.forEach(item => {
      if (item.channels) {
        channelCache[item.channels.id] = {
          name: item.channels.name,
          code: item.channels.channel_code
        };
        appendChannelToSidebar(
          item.channels.id,
          item.channels.name,
          item.channels.channel_code
        );
      }
    });
  }
}

function appendChannelToSidebar(channelId, name, code) {
  const navId = "nav-ch-" + channelId;
  if (document.getElementById(navId)) return;

  channelCache[channelId] = { name, code };

  const newNav = document.createElement("div");
  newNav.className = "nav-item dynamic-channel";
  newNav.id = navId;
  newNav.onclick = () => openChannel(channelId, name, code, navId);
  newNav.innerHTML = `
    <div class="nav-icon-circle"></div>
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

// Lepas presence dari channel saat user berpindah layar
async function leaveChannelPresence() {
  isCurrentlyTyping = false;
  recentActiveSenders.clear();

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

// 2. Broadcast Global: Semua user (kecuali pengirim) mendapat notifikasi pesan masuk
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

        const isChatScreenOpen = document.getElementById("screen-chat").classList.contains("active");
        if (isChatScreenOpen && activeChannelId === newMsg.channel_id) {
          return;
        }

        const senderName = await getUsernameById(newMsg.sender_id, "", true);
        const channelInfo = await getChannelInfoById(newMsg.channel_id);

        unreadNotifications.unshift({
          id: newMsg.id,
          channelId: newMsg.channel_id,
          channelName: channelInfo.name,
          channelCode: channelInfo.code,
          senderName: senderName,
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
    card.onclick = async () => {
      unreadNotifications = unreadNotifications.filter(n => n.channelId !== item.channelId);
      updateInboxBadge();

      if (currentUserId) {
        await supabaseClient
          .from("channel_members")
          .upsert(
            [{ channel_id: item.channelId, user_id: currentUserId }],
            { onConflict: "channel_id,user_id" }
          );
      }

      appendChannelToSidebar(item.channelId, item.channelName, item.channelCode);
      openChannel(item.channelId, item.channelName, item.channelCode, "nav-ch-" + item.channelId);
    };

    const senderColor = getUserColor(item.senderName);

    card.innerHTML = `
      <div class="inbox-card-left">
        <div class="avatar-circle"></div>
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
async function openChannel(channelId, channelName, channelCode, navId) {
  if (activeChannelId && activeChannelId !== channelId) {
    await leaveChannelPresence();
  }

  activeChannelId = channelId;
  activeChannelName = channelName;
  activeChannelCode = channelCode;

  unreadNotifications = unreadNotifications.filter(n => n.channelId !== channelId);
  updateInboxBadge();

  document.getElementById("active-channel-title").textContent = activeChannelName;
  document.getElementById("active-channel-code").textContent = activeChannelCode;

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

// Presence Real-Time dengan sync, join, leave, dan heartbeat agar user baru langsung terdeteksi
async function subscribeToChannelPresence(channelId) {
  await leaveChannelPresence();

  // Pastikan username terbaru terambil sebelum track presence
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
        // Kirim ulang track singkat 1.2 detik setelah masuk untuk memastikan user baru langsung tersinkron
        setTimeout(() => {
          sendPresenceTrack();
          updateChannelPresenceHeader();
        }, 1200);
      }
    });

  // Heartbeat setiap 8 detik agar user baru daftar/gabung langsung terbaca oleh user lama
  presenceHeartbeatInterval = setInterval(() => {
    if (channelPresenceSubscription && activeChannelId === channelId) {
      sendPresenceTrack();
    }
  }, 8000);
}

// Perbarui teks di bawah nama channel (persis seperti grup WhatsApp)
function updateChannelPresenceHeader() {
  const infoEl = document.getElementById("channel-presence-info");
  if (!infoEl) return;

  const userMap = new Map();
  const typingUsers = [];

  // 1. Selalu masukkan diri sendiri sebagai online
  userMap.set(currentUserId, "Anda");

  // 2. Baca semua user dari Supabase Presence State
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

  // 3. Gabungkan dengan pengirim aktif terbaru di channel ini (jika user baru baru saja mengirim pesan)
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

// Deteksi saat user mengetik di kotak pesan & kirim status ke Presence
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
    renderSingleMessage(senderName, msg.content, msg.id);
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

        // Jika pengirim adalah user lain di channel ini, pastikan langsung tercatat sebagai online
        if (newMsg.sender_id !== currentUserId) {
          recentActiveSenders.set(newMsg.sender_id, {
            username: senderName,
            lastSeen: Date.now()
          });
          updateChannelPresenceHeader();
        }

        renderSingleMessage(senderName, newMsg.content, newMsg.id);
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

function renderSingleMessage(senderName, text, msgId = null) {
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
    bodyHtml = `<div class="msg-text">${text}</div>`;
  }

  const nameColor = getUserColor(senderName);

  const row = document.createElement("div");
  row.className = "msg-bubble-row";
  row.innerHTML = `
    <div class="avatar-circle"></div>
    <div class="msg-content-box">
      <div class="msg-meta" style="color: ${nameColor};">${senderName}</div>
      ${bodyHtml}
    </div>
  `;
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
    const text = input.value.trim();
    if (!text || !activeChannelId || !currentUserId) return;

    const targetChannelId = activeChannelId;
    const senderId = currentUserId;
    input.value = "";

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
          content: text
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
    alert("Masukkan nama channel terlebih dahulu, lalu klik tombol (+).");
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

  input.value = "";
  appendChannelToSidebar(newChannel.id, newChannel.name, newChannel.channel_code);
  openChannel(newChannel.id, newChannel.name, newChannel.channel_code, "nav-ch-" + newChannel.id);
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

  input.value = "";
  appendChannelToSidebar(targetChannel.id, targetChannel.name, targetChannel.channel_code);
  openChannel(targetChannel.id, targetChannel.name, targetChannel.channel_code, "nav-ch-" + targetChannel.id);
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
  document.getElementById("bio-channel-desc").textContent = "Memuat bio...";

  const { data: channelData } = await supabaseClient
    .from("channels")
    .select("bio, created_by")
    .eq("id", activeChannelId)
    .maybeSingle();

  const bioText = channelData?.bio || "Belum ada bio untuk channel ini.";
  document.getElementById("bio-channel-desc").textContent = bioText;

  const isCreator = channelData?.created_by === currentUserId;
  const editBox = document.getElementById("bio-edit-box");
  const dangerText = document.getElementById("btn-channel-danger-text");

  if (isCreator) {
    editBox.style.display = "block";
    document.getElementById("bio-edit-input").value = bioText;
    dangerText.textContent = "Delete Channel";
  } else {
    editBox.style.display = "none";
    dangerText.textContent = "Keluar Channel";
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

  const isCreator = channelData?.created_by === currentUserId;

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

  const navEl = document.getElementById("nav-ch-" + activeChannelId);
  if (navEl) navEl.remove();

  await leaveChannelPresence();
  activeChannelId = null;
  switchScreen("welcome");
  setActiveNav(null);
}