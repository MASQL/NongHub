// js/voice.js
let peerInstance = null;
let localMediaStream = null;
let voicePresenceChannel = null;
let isMicMuted = false;
let currentCallIsVideo = false;
let audioMonitorInterval = null;
let audioContext = null;
let myCurrentPeerId = null;

const activePeerCalls = {};
const callParticipants = {}; // { peerId: { name, isLocal, stream, analyser, dataArray } }

const WAVE_SVG = `
  <div class="voice-wave-visual">
    <svg width="88" height="44" viewBox="0 0 88 44" fill="none">
      <rect x="4" y="18" width="3" height="8" rx="1.5" fill="#09090d"/>
      <rect x="11" y="13" width="3" height="18" rx="1.5" fill="#09090d"/>
      <rect x="18" y="16" width="3" height="12" rx="1.5" fill="#09090d"/>
      <rect x="25" y="7" width="3" height="30" rx="1.5" fill="#09090d"/>
      <rect x="32" y="12" width="3" height="20" rx="1.5" fill="#09090d"/>
      <rect x="39" y="4" width="3" height="36" rx="1.5" fill="#09090d"/>
      <rect x="46" y="10" width="3" height="24" rx="1.5" fill="#09090d"/>
      <rect x="53" y="6" width="3" height="32" rx="1.5" fill="#09090d"/>
      <rect x="60" y="14" width="3" height="16" rx="1.5" fill="#09090d"/>
      <rect x="67" y="11" width="3" height="22" rx="1.5" fill="#09090d"/>
      <rect x="74" y="16" width="3" height="12" rx="1.5" fill="#09090d"/>
      <rect x="81" y="19" width="3" height="6" rx="1.5" fill="#09090d"/>
    </svg>
  </div>
`;

const MIC_BADGE_SVG = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" y1="19" x2="12" y2="23"></line>
    <line x1="8" y1="23" x2="16" y2="23"></line>
  </svg>
`;

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

// Ambil daftar ICE/TURN server aktif dengan timeout singkat agar panggilan tidak tertunda
async function getDynamicIceConfig() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      "https://nonghub.metered.live/api/v1/turn/credentials?apiKey=e8dd65b92f6dde43c1e71001",
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (res.ok) {
      const turnServers = await res.json();
      if (Array.isArray(turnServers) && turnServers.length > 0) {
        return {
          iceServers: [...DEFAULT_ICE_SERVERS, ...turnServers],
          iceCandidatePoolSize: 10
        };
      }
    }
  } catch (e) {
    // Gunakan fallback STUN jika API TURN tidak terjangkau
  }

  return {
    iceServers: DEFAULT_ICE_SERVERS,
    iceCandidatePoolSize: 10
  };
}

// Memulai Voice Call atau Video Call & Masuk ke Layar Call UI
async function startGroupCall(callType) {
  if (!activeChannelId) {
    alert("Buka salah satu Channel terlebih dahulu sebelum memulai panggilan.");
    return;
  }

  if (typeof Peer === "undefined") {
    alert("Modul panggilan belum selesai dimuat. Tunggu 2 detik lalu coba tekan tombol panggilan lagi.");
    return;
  }

  if (peerInstance) {
    await endGroupCall();
  }

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  currentCallIsVideo = callType === "Video Call";

  try {
    localMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: currentCallIsVideo
        ? {
            facingMode: "user",
            width: { ideal: 480, max: 640 },
            height: { ideal: 360, max: 480 },
            frameRate: { ideal: 20, max: 24 }
          }
        : false
    });
  } catch (err) {
    alert("Gagal mengakses mikrofon/kamera. Pastikan izin di browser aktif: " + err.message);
    return;
  }

  // Buka layar #screen-call sesuai UI/UX
  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-call").classList.add("active");
  document.getElementById("call-room-title").textContent = `${activeChannelName} Voice Group`;

  isMicMuted = false;
  document.getElementById("btn-mute-toggle").classList.remove("muted");

  const myUsername = document.getElementById("display-profile-name")?.textContent || "You";
  const myPeerId = `nh-${session.user.id.slice(0, 8)}-${Date.now()}`;
  myCurrentPeerId = myPeerId;

  // Daftarkan diri sendiri sebagai peserta pertama (Layout-Call-Idle)
  registerParticipant(myPeerId, "You", true, localMediaStream);
  renderCallParticipantsLayout();
  startAudioLevelMonitor();

  const iceConfig = await getDynamicIceConfig();

  // Inisialisasi PeerJS
  const peer = new Peer(myPeerId, {
    debug: 1,
    config: iceConfig
  });
  peerInstance = peer;

  // Terima panggilan masuk dari peserta lain di room
  peer.on("call", (incomingCall) => {
    if (!localMediaStream) return;
    incomingCall.answer(localMediaStream);
    const callerName = incomingCall.metadata?.username || "Teman";
    handleCallStream(incomingCall, callerName);
  });

  // Hubungkan ke Supabase Realtime Presence untuk sinkronisasi peserta room
  const connectToVoiceRoomPresence = async (readyPeerId) => {
    if (voicePresenceChannel) return;

    const roomTopic = `voice-room-${activeChannelId}`;
    voicePresenceChannel = supabaseClient.channel(roomTopic, {
      config: { presence: { key: readyPeerId } }
    });

    const syncAndCallPeers = () => {
      if (!voicePresenceChannel || !peerInstance || peerInstance.disconnected) return;
      const state = voicePresenceChannel.presenceState();
      const peerIdsInRoom = Object.keys(state);

      peerIdsInRoom.forEach((remotePeerId) => {
        if (remotePeerId === readyPeerId) return;

        const presenceInfo = state[remotePeerId]?.[state[remotePeerId].length - 1];
        const remoteName = presenceInfo?.username || "Teman";

        if (callParticipants[remotePeerId]) {
          callParticipants[remotePeerId].name = remoteName;
        }

        // Hanya peer dengan ID leksikografis lebih besar yang menginisiasi call
        const shouldInitiate = readyPeerId > remotePeerId;
        if (shouldInitiate && !activePeerCalls[remotePeerId]) {
          try {
            const outgoingCall = peerInstance.call(remotePeerId, localMediaStream, {
              metadata: { username: myUsername }
            });
            if (outgoingCall) {
              handleCallStream(outgoingCall, remoteName);
            }
          } catch (e) {
            console.warn("Gagal memanggil peer:", remotePeerId, e);
          }
        }
      });
    };

    voicePresenceChannel
      .on("presence", { event: "sync" }, syncAndCallPeers)
      .on("presence", { event: "join" }, syncAndCallPeers)
      .on("presence", { event: "leave" }, ({ key }) => {
        if (activePeerCalls[key]) {
          try {
            activePeerCalls[key].close();
          } catch (e) {}
          delete activePeerCalls[key];
        }
        removeParticipant(key);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await voicePresenceChannel.track({
            peer_id: readyPeerId,
            user_id: session.user.id,
            username: myUsername,
            call_type: callType,
            joined_at: Date.now()
          });
          setTimeout(syncAndCallPeers, 800);
        }
      });
  };

  if (peer.open) {
    connectToVoiceRoomPresence(peer.id);
  } else {
    peer.on("open", (id) => {
      connectToVoiceRoomPresence(id);
    });
  }

  peer.on("error", (err) => {
    console.error("PeerJS Error:", err.type, err);
  });
}

function handleCallStream(call, remoteName) {
  const remoteId = call.peer;
  activePeerCalls[remoteId] = call;

  // Pantau koneksi ICE WebRTC untuk memulihkan video jika jalur NAT terputus
  if (call.peerConnection) {
    call.peerConnection.oniceconnectionstatechange = () => {
      const state = call.peerConnection?.iceConnectionState;
      if (state === "failed" || state === "disconnected") {
        try {
          if (typeof call.peerConnection.restartIce === "function") {
            call.peerConnection.restartIce();
          }
        } catch (e) {}
      }
    };
  }

  call.on("stream", (remoteStream) => {
    registerParticipant(remoteId, remoteName, false, remoteStream);
    renderCallParticipantsLayout();
  });

  call.on("close", () => {
    delete activePeerCalls[remoteId];
    removeParticipant(remoteId);
  });

  call.on("error", (err) => {
    console.warn("Call stream error:", err);
    delete activePeerCalls[remoteId];
  });
}

// Daftarkan peserta beserta analyser audio untuk deteksi bicara real-time
function registerParticipant(peerId, name, isLocal, stream) {
  let analyser = null;
  let dataArray = null;

  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
    if (stream && stream.getAudioTracks().length > 0) {
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
  } catch (e) {
    console.warn("Audio analyser tidak aktif:", e);
  }

  callParticipants[peerId] = {
    peerId,
    name,
    isLocal,
    stream,
    analyser,
    dataArray
  };
}

function removeParticipant(peerId) {
  const audioEl = document.getElementById(`hidden-audio-${peerId}`);
  if (audioEl) audioEl.remove();
  delete callParticipants[peerId];
  renderCallParticipantsLayout();
}

// Render otomatis antara Layout-Call-Idle (1 user) dan Layout-Call-Grid (2+ user)
function renderCallParticipantsLayout() {
  const list = Object.values(callParticipants);
  const idleView = document.getElementById("call-idle-view");
  const idleSlot = document.getElementById("call-idle-card-slot");
  const gridView = document.getElementById("call-participants-grid");

  if (!idleView || !gridView) return;

  // Kondisi 1: Baru 1 user yang masuk -> Tampilkan Layout-Call-Idle
  if (list.length <= 1) {
    idleView.style.display = "flex";
    gridView.style.display = "none";
    gridView.innerHTML = "";
    idleSlot.innerHTML = "";

    if (list.length === 1) {
      idleSlot.appendChild(createParticipantCardElement(list[0], 0));
    }
    return;
  }

  // Kondisi 2: Ada user lain yang bergabung -> Pindah ke Layout-Call Grid
  idleView.style.display = "none";
  idleSlot.innerHTML = "";
  gridView.style.display = "grid";
  gridView.innerHTML = "";

  // Urutkan agar peserta lain tampil di atas dan "You" di posisi akhir seperti desain UI
  const sortedList = [
    ...list.filter(p => !p.isLocal),
    ...list.filter(p => p.isLocal)
  ];

  sortedList.forEach((participant, idx) => {
    gridView.appendChild(createParticipantCardElement(participant, idx));
  });
}

function forcePlayMediaElement(mediaEl, isRemote) {
  const attemptPlay = () => {
    mediaEl.play().catch(() => {
      if (isRemote) {
        // Jika browser mobile memblokir autoplay bersuara, mute sementara agar gambar video tetap tampil,
        // lalu aktifkan suara begitu user menyentuh layar
        mediaEl.muted = true;
        mediaEl.play().catch(() => {});
        const unlockAudio = () => {
          mediaEl.muted = false;
          mediaEl.play().catch(() => {});
          document.removeEventListener("touchstart", unlockAudio);
          document.