// js/voice.js
let peerInstance = null;
let localMediaStream = null;
let voicePresenceChannel = null;
let isMicMuted = false;
let currentCallIsVideo = false;
let audioMonitorInterval = null;
let callRetryInterval = null;
let audioContext = null;
let myCurrentPeerId = null;

const activePeerCalls = {};
const connectedRemoteStreams = new Set();
const callParticipants = {};

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

// Kombinasi STUN + TURN OpenRelay (Port 80 & 443 TCP/UDP untuk menembus CGNAT operator seluler HP)
const MOBILE_READY_ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:openrelay.metered.ca:80" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
  iceCandidatePoolSize: 10
};

async function startGroupCall(callType) {
  try {
    if (typeof activeChannelId === "undefined" || !activeChannelId) {
      alert("Buka salah satu Channel terlebih dahulu sebelum memulai panggilan.");
      return;
    }

    if (typeof Peer === "undefined") {
      alert("Modul panggilan belum selesai dimuat. Tunggu 2 detik lalu coba tekan tombol panggilan lagi.");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Browser tidak mendukung akses kamera/mikrofon. Pastikan membuka halaman melalui HTTPS.");
      return;
    }

    if (peerInstance) {
      await endGroupCall();
    }

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
              height: { ideal: 360, max: 480 }
            }
          : false
      });
    } catch (err) {
      alert("Gagal mengakses mikrofon/kamera. Pastikan izin di browser aktif: " + err.message);
      return;
    }

    // Tampilkan layar #screen-call segera
    document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
    const callScreen = document.getElementById("screen-call");
    if (callScreen) callScreen.classList.add("active");

    const titleEl = document.getElementById("call-room-title");
    if (titleEl) {
      const chTitle = typeof activeChannelName !== "undefined" && activeChannelName ? activeChannelName : "Channel";
      titleEl.textContent = `${chTitle} Voice Group`;
    }

    isMicMuted = false;
    const muteBtn = document.getElementById("btn-mute-toggle");
    if (muteBtn) muteBtn.classList.remove("muted");

    const userId =
      (typeof currentUserId !== "undefined" && currentUserId) ||
      sessionStorage.getItem("nh_user_id") ||
      Math.random().toString(36).slice(2, 10);

    const myUsername =
      document.getElementById("display-profile-name")?.textContent ||
      sessionStorage.getItem("nh_current_user") ||
      "You";

    const myPeerId = `nh-${String(userId).slice(0, 8)}-${Date.now()}`;
    myCurrentPeerId = myPeerId;

    registerParticipant(myPeerId, "You", true, localMediaStream);
    renderCallParticipantsLayout();
    startAudioLevelMonitor();

    const peer = new Peer(myPeerId, {
      debug: 1,
      config: MOBILE_READY_ICE_CONFIG
    });
    peerInstance = peer;

    peer.on("call", (incomingCall) => {
      if (!localMediaStream) return;
      incomingCall.answer(localMediaStream);
      const callerName = incomingCall.metadata?.username || "Teman";
      handleCallStream(incomingCall, callerName);
    });

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

          // Jika stream dari remotePeerId belum terhubung, lakukan panggilan (dengan anti-tabrakan)
          if (!connectedRemoteStreams.has(remotePeerId)) {
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
          }
        });
      };

      voicePresenceChannel
        .on("presence", { event: "sync" }, syncAndCallPeers)
        .on("presence", { event: "join" }, syncAndCallPeers)
        .on("presence", { event: "leave" }, ({ key }) => {
          connectedRemoteStreams.delete(key);
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
              user_id: userId,
              username: myUsername,
              call_type: callType,
              joined_at: Date.now()
            });
            setTimeout(syncAndCallPeers, 600);

            // Auto-retry setiap 3.5 detik jika ada peserta di room yang stream-nya belum masuk
            if (callRetryInterval) clearInterval(callRetryInterval);
            callRetryInterval = setInterval(() => {
              if (!voicePresenceChannel) return;
              const state = voicePresenceChannel.presenceState();
              Object.keys(state).forEach((remotePeerId) => {
                if (remotePeerId !== readyPeerId && !connectedRemoteStreams.has(remotePeerId)) {
                  if (activePeerCalls[remotePeerId]) {
                    try {
                      activePeerCalls[remotePeerId].close();
                    } catch (e) {}
                    delete activePeerCalls[remotePeerId];
                  }
                  syncAndCallPeers();
                }
              });
            }, 3500);
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
  } catch (fatalErr) {
    alert("Terjadi kesalahan saat memulai panggilan: " + fatalErr.message);
  }
}

function handleCallStream(call, remoteName) {
  const remoteId = call.peer;
  activePeerCalls[remoteId] = call;

  if (call.peerConnection) {
    call.peerConnection.oniceconnectionstatechange = () => {
      const state = call.peerConnection?.iceConnectionState;
      if (state === "failed" || state === "disconnected") {
        connectedRemoteStreams.delete(remoteId);
        try {
          if (typeof call.peerConnection.restartIce === "function") {
            call.peerConnection.restartIce();
          }
        } catch (e) {}
      }
    };
  }

  call.on("stream", (remoteStream) => {
    connectedRemoteStreams.add(remoteId);
    registerParticipant(remoteId, remoteName, false, remoteStream);
    renderCallParticipantsLayout();
  });

  call.on("close", () => {
    connectedRemoteStreams.delete(remoteId);
    delete activePeerCalls[remoteId];
    removeParticipant(remoteId);
  });

  call.on("error", (err) => {
    console.warn("Call stream error:", err);
    connectedRemoteStreams.delete(remoteId);
    delete activePeerCalls[remoteId];
  });
}

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
  } catch (e) {}

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

function renderCallParticipantsLayout() {
  const list = Object.values(callParticipants);
  const idleView = document.getElementById("call-idle-view");
  const idleSlot = document.getElementById("call-idle-card-slot");
  const gridView = document.getElementById("call-participants-grid");

  if (!idleView || !gridView) return;

  if (list.length <= 1) {
    idleView.style.display = "flex";
    gridView.style.display = "none";
    gridView.innerHTML = "";
    if (idleSlot) {
      idleSlot.innerHTML = "";
      if (list.length === 1) {
        idleSlot.appendChild(createParticipantCardElement(list[0], 0));
      }
    }
    return;
  }

  idleView.style.display = "none";
  if (idleSlot) idleSlot.innerHTML = "";
  gridView.style.display = "grid";
  gridView.innerHTML = "";

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
        mediaEl.muted = true;
        mediaEl.play().catch(() => {});
        const unlockAudio = () => {
          mediaEl.muted = false;
          mediaEl.play().catch(() => {});
          document.removeEventListener("touchstart", unlockAudio);
          document.removeEventListener("click", unlockAudio);
        };
        document.addEventListener("touchstart", unlockAudio, { once: true });
        document.addEventListener("click", unlockAudio, { once: true });
      }
    });
  };

  mediaEl.onloadedmetadata = attemptPlay;
  attemptPlay();
}

function createParticipantCardElement(participant, index) {
  const card = document.createElement("div");
  const borderClass = index % 2 === 0 ? "border-magenta" : "border-cyan";
  card.className = `participant-card ${borderClass}`;
  card.id = `call-card-${participant.peerId}`;

  const videoTracks = participant.stream ? participant.stream.getVideoTracks() : [];
  const hasActiveVideo = videoTracks.length > 0 && videoTracks.some(t => t.readyState === "live");
  const showVideoElement = (participant.isLocal && currentCallIsVideo) || (!participant.isLocal && hasActiveVideo);

  if (showVideoElement && participant.stream) {
    const videoEl = document.createElement("video");
    videoEl.className = "participant-video";
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.setAttribute("playsinline", "");
    videoEl.setAttribute("webkit-playsinline", "");
    videoEl.setAttribute("autoplay", "");

    if (participant.isLocal) {
      videoEl.muted = true;
      videoEl.srcObject = participant.stream;
    } else {
      videoEl.muted = false;
      videoEl.volume = 1.0;
      videoEl.srcObject = participant.stream;
    }

    card.appendChild(videoEl);
    forcePlayMediaElement(videoEl, !participant.isLocal);
  } else {
    card.insertAdjacentHTML("beforeend", WAVE_SVG);
  }

  if (!participant.isLocal && participant.stream && !showVideoElement) {
    let audioEl = document.getElementById(`hidden-audio-${participant.peerId}`);
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = `hidden-audio-${participant.peerId}`;
      audioEl.autoplay = true;
      audioEl.setAttribute("autoplay", "");
      audioEl.setAttribute("playsinline", "");
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = participant.stream;
    audioEl.volume = 1.0;
    forcePlayMediaElement(audioEl, true);
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

async function endGroupCall() {
  if (audioMonitorInterval) {
    clearInterval(audioMonitorInterval);
    audioMonitorInterval = null;
  }

  if (callRetryInterval) {
    clearInterval(callRetryInterval);
    callRetryInterval = null;
  }

  connectedRemoteStreams.clear();

  Object.keys(activePeerCalls).forEach((key) => {
    try {
      activePeerCalls[key].close();
    } catch (e) {}
    delete activePeerCalls[key];
  });

  Object.keys(callParticipants).forEach((key) => {
    const audioEl = document.getElementById(`hidden-audio-${key}`);
    if (audioEl) audioEl.remove();
    delete callParticipants[key];
  });

  if (voicePresenceChannel) {
    try {
      await voicePresenceChannel.untrack();
    } catch (e) {}
    await supabaseClient.removeChannel(voicePresenceChannel);
    voicePresenceChannel = null;
  }

  if (peerInstance) {
    try {
      peerInstance.destroy();
    } catch (e) {}
    peerInstance = null;
  }

  if (localMediaStream) {
    localMediaStream.getTracks().forEach((track) => track.stop());
    localMediaStream = null;
  }

  myCurrentPeerId = null;

  document.querySelectorAll(".screen-section").forEach(sec => sec.classList.remove("active"));
  document.getElementById("screen-chat").classList.add("active");
}

window.startGroupCall = startGroupCall;
window.toggleMute = toggleMute;
window.endGroupCall = endGroupCall;
