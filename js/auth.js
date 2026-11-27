// js/auth.js
let isRegisterMode = false;

document.addEventListener("DOMContentLoaded", async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();

  if (document.getElementById("auth-form")) {
    if (session) {
      window.location.href = "index.html";
      return;
    }
    setupAuthForm();
  } else if (document.getElementById("display-profile-name")) {
    if (!session) {
      window.location.href = "login.html";
      return;
    }

    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("username, avatar_url, status")
      .eq("id", session.user.id)
      .maybeSingle();

    const resolvedName =
      profile?.username ||
      session.user.user_metadata?.username ||
      session.user.email.split("@")[0];

    sessionStorage.setItem("nh_current_user", resolvedName);
    sessionStorage.setItem("nh_user_id", session.user.id);

    document.getElementById("display-profile-name").textContent = resolvedName;
    const popupName = document.getElementById("popup-profile-name");
    if (popupName) popupName.textContent = resolvedName;

    if (profile?.avatar_url) {
      ["user-avatar", "popup-user-avatar", "edit-profile-avatar-preview", "mobile-welcome-avatar"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.backgroundImage = `url('${profile.avatar_url}')`;
      });

      if (typeof userAvatarCache !== "undefined") {
        userAvatarCache[session.user.id] = profile.avatar_url;
      }
    }

    if (profile?.status) {
      applyStatusVisual(profile.status);
    }
  }
});

function toggleAuthMode() {
  isRegisterMode = !isRegisterMode;
  document.getElementById("auth-title").textContent = isRegisterMode ? "Daftar Akun" : "Login";
  document.getElementById("auth-submit-btn").textContent = isRegisterMode ? "Daftar" : "Login";
  document.getElementById("forgot-link").style.display = isRegisterMode ? "none" : "inline-block";
  document.getElementById("auth-switch-text").textContent = isRegisterMode ? "Sudah punya akun?" : "Belum ada akun?";
  document.getElementById("auth-switch-link").textContent = isRegisterMode ? "Login di sini" : "Daftar Akun";
}

function setupAuthForm() {
  document.getElementById("auth-form").addEventListener("submit", async function (e) {
    e.preventDefault();

    const rawUsername = document.getElementById("username-input").value.trim();
    const password = document.getElementById("password-input").value.trim();
    const submitBtn = document.getElementById("auth-submit-btn");

    if (!rawUsername || !password) return;

    const cleanUsername = rawUsername.toLowerCase().replace(/\s+/g, "");
    const dummyEmail = `${cleanUsername}@nongkronghub.app`;

    submitBtn.disabled = true;
    submitBtn.textContent = "Memproses...";

    try {
      if (isRegisterMode) {
        const { error: authError } = await supabaseClient.auth.signUp({
          email: dummyEmail,
          password: password,
          options: {
            data: {
              username: rawUsername
            }
          }
        });

        if (authError) throw authError;

        alert("Akun berhasil didaftarkan!");
        window.location.href = "index.html";
      } else {
        const { error: loginError } = await supabaseClient.auth.signInWithPassword({
          email: dummyEmail,
          password: password
        });

        if (loginError) {
          const mauDaftar = confirm("Akun tidak ditemukan atau password salah. Ingin mendaftarkan akun baru?");
          if (mauDaftar) toggleAuthMode();
          submitBtn.disabled = false;
          submitBtn.textContent = isRegisterMode ? "Daftar" : "Login";
          return;
        }

        window.location.href = "index.html";
      }
    } catch (err) {
      alert("Terjadi kesalahan: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = isRegisterMode ? "Daftar" : "Login";
    }
  });
}

async function logoutUser() {
  if (confirm("Keluar dari akun NongkrongHub?")) {
    await supabaseClient.auth.signOut();
    sessionStorage.removeItem("nh_current_user");
    sessionStorage.removeItem("nh_user_id");
    window.location.href = "login.html";
  }
}

function toggleProfilePopup(event) {
  if (event) event.stopPropagation();
  const popup = document.getElementById("profile-popup");
  const currentName = document.getElementById("display-profile-name")?.textContent || "";
  const popupName = document.getElementById("popup-profile-name");
  if (popupName && currentName) popupName.textContent = currentName;

  if (popup) {
    popup.classList.toggle("active");
  }
}

document.addEventListener("click", (e) => {
  const popup = document.getElementById("profile-popup");
  const footerBtn = document.getElementById("profile-footer-btn");
  if (popup && popup.classList.contains("active")) {
    if (!popup.contains(e.target) && !footerBtn.contains(e.target)) {
      popup.classList.remove("active");
    }
  }
});

function applyStatusVisual(newStatus) {
  ["profile-status-text", "popup-status-text"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = newStatus;
  });

  ["profile-status-dot", "popup-status-dot"].forEach(id => {
    const dot = document.getElementById(id);
    if (dot) {
      dot.classList.toggle("offline", newStatus === "offline");
    }
  });

  const selectEl = document.getElementById("setting-status-select");
  if (selectEl) selectEl.value = newStatus;
}

async function changeUserStatus(newStatus) {
  applyStatusVisual(newStatus);

  const popup = document.getElementById("profile-popup");
  if (popup) popup.classList.remove("active");

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await supabaseClient
      .from("profiles")
      .update({ status: newStatus })
      .eq("id", session.user.id);
  }
}

function openProfileSubpage(pageName) {
  const popup = document.getElementById("profile-popup");
  if (popup) popup.classList.remove("active");

  if (typeof closeMobileSidebar === "function") {
    closeMobileSidebar();
  }

  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  const target = document.getElementById("screen-" + pageName);
  if (target) target.classList.add("active");

  const currentName = document.getElementById("display-profile-name")?.textContent || "";
  if (pageName === "edit-profile") {
    const input = document.getElementById("edit-username-input");
    if (input) input.value = currentName;
  }
}

async function saveEditedProfile() {
  const newUsername = document.getElementById("edit-username-input").value.trim();
  if (!newUsername) {
    alert("Username tidak boleh kosong.");
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const { error } = await supabaseClient
    .from("profiles")
    .update({ username: newUsername })
    .eq("id", session.user.id);

  if (error) {
    alert("Gagal memperbarui profil: " + error.message);
    return;
  }

  sessionStorage.setItem("nh_current_user", newUsername);
  document.getElementById("display-profile-name").textContent = newUsername;
  const popupName = document.getElementById("popup-profile-name");
  if (popupName) popupName.textContent = newUsername;

  if (typeof userCache !== "undefined") {
    userCache[session.user.id] = newUsername;
  }
  if (typeof currentUsername !== "undefined") {
    currentUsername = newUsername;
  }

  alert("Profil berhasil diperbarui!");
}

async function uploadProfileAvatar(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("Harap pilih file gambar (JPG/PNG) untuk foto profil.");
    return;
  }

  const MAX_SIZE_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    alert("Ukuran foto profil maksimal 5MB!");
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = `avatars/${session.user.id}_${Date.now()}_${cleanName}`;
  const { error: upErr } = await supabaseClient.storage
    .from("chat-uploads")
    .upload(filePath, file);

  if (upErr) {
    alert("Gagal mengunggah foto profil: " + upErr.message);
    return;
  }

  const { data: urlData } = supabaseClient.storage
    .from("chat-uploads")
    .getPublicUrl(filePath);

  const avatarUrl = urlData.publicUrl;

  const { error: dbErr } = await supabaseClient
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("id", session.user.id);

  if (dbErr) {
    alert("Gagal menyimpan foto profil ke database: " + dbErr.message);
    return;
  }

  ["user-avatar", "popup-user-avatar", "edit-profile-avatar-preview", "mobile-welcome-avatar"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.backgroundImage = `url('${avatarUrl}')`;
  });

  if (typeof userAvatarCache !== "undefined") {
    userAvatarCache[session.user.id] = avatarUrl;
  }
  if (typeof applyUserAvatarToChat === "function") {
    applyUserAvatarToChat(session.user.id, avatarUrl);
  }

  alert("Foto profil berhasil diganti!");
}