// js/voice.js
let peerInstance = null;
let localMediaStream = null;
let voicePresenceChannel = null;
let isMicMuted = false;
let currentCallIsVideo = false;
let audioMonitorInterval = null;
let audioContext = null;

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

// Memulai Voice Call atau Video Call & Masuk ke Layar Call UI
async function startGroupCall(callType) {
  if (!activeChannelId) {
    alert("Buka salah satu Channel terlebih dahulu sebelum memulai panggilan.");
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
      audio: true,
      video: currentCallIsVideo
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

  // Daftarkan diri sendiri sebagai peserta pertama (Layout-Call-Idle)
  registerParticipant(myPeerId, "You", true, localMediaStream);
  renderCallParticipantsLayout();
  startAudioLevelMonitor();

  peerInstance = new Peer(myPeerId, {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    }
  });

  peerInstance.on("call", (incomingCall) => {
    incomingCall.answer(localMediaStream);
    const callerName = incomingCall.metadata?.username || "Teman";
    handleCallStream(incomingCall, callerName);
  });

  peerInstance.on("open", async (id) => {
    const roomTopic = `voice-room-${activeChannelId}`;
    voicePresenceChannel = supabaseClient.channel(roomTopic, {
      config: { presence: { key: id } }
    });

    voicePresenceChannel
      .on("presence", { event: "sync" }, () => {
        const state = voicePresenceChannel.presenceState();
        const peerIdsInRoom = Object.keys(state);

        peerIdsInRoom.forEach((remotePeerId) => {
          const presenceInfo = state[remotePeerId]?.[0];
          const remoteName = presenceInfo?.username || "Teman";

          if (remotePeerId !== id) {
            if (callParticipants[remotePeerId]) {
              callParticipants[remotePeerId].name = remoteName;
            }
            if (!activePeerCalls[remotePeerId]) {
              const outgoingCall = peerInstance.call(remotePeerId, localMediaStream, {
                metadata: { username: myUsername }
              });
              if (outgoingCall) {
                handleCallStream(outgoingCall, remoteName);
              }
            }
          }
        });
      })
      .on("presence", { event: "leave" }, ({ key }) => {
        if (activePeerCalls[key]) {
          activePeerCalls[key].close();
          delete activePeerCalls[key];
        }
        removeParticipant(key);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await voicePresenceChannel.track({
            peer_id: id,
            user_id: session.user.id,
            username: myUsername,
            call_type: callType
          });
        }
      });
  });

  peerInstance.on("error", (err) => {
    console.error("PeerJS Error:", err);
  });
}

function handleCallStream(call, remoteName) {
  const remoteId = call.peer;
  activePeerCalls[remoteId] = call;

  call.on("stream", (remoteStream) => {
    registerParticipant(remoteId, remoteName, false, remoteStream);
    renderCallParticipantsLayout();
  });

  call.on("close", () => {
    delete activePeerCalls[remoteId];
    removeParticipant(remoteId);
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

function createParticipantCardElement(participant, index) {
  const card = document.createElement("div");
  const borderClass = index % 2 === 0 ? "border-magenta" : "border-cyan";
  card.className = `participant-card ${borderClass}`;
  card.id = `call-card-${participant.peerId}`;

  const hasVideo = currentCallIsVideo || (participant.stream && participant.stream.getVideoTracks().length > 0);

  if (hasVideo && participant.stream) {
    const videoEl = document.createElement("video");
    videoEl.className = "participant-video";
    videoEl.srcObject = participant.stream;
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    if (participant.isLocal) videoEl.muted = true;
    card.appendChild(videoEl);
  } else {
    card.insertAdjacentHTML("beforeend", WAVE_SVG);
    // Putar audio peserta remote lewat elemen <audio> tersembunyi
    if (!participant.isLocal && participant.stream) {
      let audioEl = document.getElementById(`hidden-audio-${participant.peerId}`);
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.id = `hidden-audio-${participant.peerId}`;
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = participant.stream;
    }
  }

  card.insertAdjacentHTML(
    "beforeend",
    `
      <div class="participant-info">
        <span class="participant-name">${participant.name}</span>
        <span class="participant-status">
          <span class="status-dot"></span> online
        </span>
      </div>
      <div class="participant-mic-badge" id="mic-badge-${participant.peerId}">
        ${MIC_BADGE_SVG}
      </div>
    `
  );

  return card;
}

// Pantau suara setiap peserta: Jika terdeteksi bicara -> card membesar & mic berubah hijau
function startAudioLevelMonitor() {
  if (audioMonitorInterval) clearInterval(audioMonitorInterval);

  audioMonitorInterval = setInterval(() => {
    Object.values(callParticipants).forEach((p) => {
      const cardEl = document.getElementById(`call-card-${p.peerId}`);
      if (!cardEl) return;

      if (p.isLocal && isMicMuted) {
        cardEl.classList.remove("speaking");
        return;
      }

      if (p.analyser && p.dataArray) {
        p.analyser.getByteFrequencyData(p.dataArray);
        let sum = 0;
        for (let i = 0; i < p.dataArray.length; i++) {
          sum += p.dataArray[i];
        }
        const averageVolume = sum / p.dataArray.length;

        if (averageVolume > 14) {
          cardEl.classList.add("speaking");
        } else {
          cardEl.classList.remove("speaking");
        }
      }
    });
  }, 120);
}

// Mute / Unmute Mikrofon dari Bar Kontrol Bawah
function toggleMute() {
  if (!localMediaStream) return;
  isMicMuted = !isMicMuted;

  localMediaStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });

  const btn = document.getElementById("btn-mute-toggle");
  if (btn) {
    btn.classList.toggle("muted", isMicMuted);
  }
}

// Keluar dari Panggilan & Kembali ke Layar Chat Channel
async function endGroupCall() {
  if (audioMonitorInterval) {
    clearInterval(audioMonitorInterval);
    audioMonitorInterval = null;
  }

  Object.keys(activePeerCalls).forEach((key) => {
    activePeerCalls[key].close();
    delete activePeerCalls[key];
  });

  Object.keys(callParticipants).forEach((key) => {
    const audioEl = document.getElementById(`hidden-audio-${key}`);
    if (audioEl) audioEl.remove();
    delete callParticipants[key];
  });

  if (voicePresenceChannel) {
    await supabaseClient.removeChannel(voicePresenceChannel);
    voicePresenceChannel = null;
  }

  if (peerInstance) {
    peerInstance.destroy();
    peerInstance = null;
  }

  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => track.stop());
    localMediaStream = null;
  }

  // Kembalikan tampilan ke halaman chat channel aktif
  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-chat").classList.add("active");
}