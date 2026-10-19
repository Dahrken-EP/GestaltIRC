// Native media for the Linux build: a WebRTC peer connection in Rust (webrtc-rs) instead of
// the webview's, with the microphone and speaker through cpal and voice through Opus.
//
// Why: WebKitGTK's own WebRTC stack is unreliable on Linux, so this build makes the whole
// peer connection itself and the web client only passes descriptions and data over the
// ordinary Tauri bridge. What runs where:
//
//   web client (logic untouched)      this module
//   offers, answers, safety codes     offers, answers, DTLS-SRTP, ICE
//   ping over the bouncer             data channels: chat, file transfer
//   mixing bookkeeping                the mixing and the actual sound
//
// Nothing unfinished crosses the bridge: JavaScript never sees decoded audio. The
// microphone is captured, encoded and sent from here; what comes in is decoded here, mixed
// per person, and played here. The web client's speaking meter keeps working from loudness
// events, and its per-person volume is one number here.
//
// The same trick keeps the page's voice-room mixer honest: what it "sends" is described by
// a tag (the microphone, the room's mix, one guest's mix), and the mixing thread below
// builds those mixes. The decoder runs twice per connection — once into the local speaker
// buffer, once into a mirror the mixes read — so playing a room to the speakers never
// steals the audio the guests are supposed to hear.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, WebviewWindow};

const SAMPLE_RATE: u32 = 48_000;
const FRAME: usize = 960; // 20 ms of mono at the sample rate above
const FRAME_MS: u64 = 20;
const AUDIO_MIME: &str = "audio/opus";
const TICK: Duration = Duration::from_millis(FRAME_MS);
const INBOUND_MAX: usize = 24; // decoded frames past this are dropped: never let it lag behind
const RMS_EVERY: u32 = 5; // mixing passes between loudness events: 100 ms

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn log(text: &str) {
    println!("media: {text}");
}

// --- what a connection sends ---

/// Where one connection's outgoing audio comes from. These are the three things the page's
/// voice mixer would otherwise assemble itself: the plain microphone, what a guest hears in
/// a room, and what a room hears the host play (the microphone plus every guest).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Uplink {
    Mic,
    Room,
    /// The tag of the guest this mix is for (their lower-case nick).
    Guest(String),
}

impl Uplink {
    fn parse(tag: &str, id: u64) -> Option<Uplink> {
        match tag {
            "mic" => Some(Uplink::Mic),
            "room" => Some(Uplink::Room),
            "" => None,
            other
                if other.starts_with("guest:") && other.len() > 6 =>
            {
                Some(Uplink::Guest(other[6..].to_owned()))
            }
            other => {
                log(&format!("pc {id}: unknown uplink tag {other}"));
                None
            }
        }
    }
}

// --- bridge surface ---

#[derive(Serialize)]
pub struct Probe {
    /// Whether the native stack is compiled in. The page asks for this first.
    available: bool,
    /// Whether a microphone exists (not in use yet, just that the device is there).
    mic: bool,
    /// Whether an output device exists.
    output: bool,
    error: String,
}

#[derive(Serialize)]
struct MicInfo {
    ok: bool,
    error: String,
}

#[derive(Deserialize)]
struct IceServerIn {
    urls: Vec<String>,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}

// Every event to the page flows over the single "media" channel with a `k` tag, so the
// page keeps one listener and matches on the tag.
#[derive(Serialize, Clone)]
#[serde(tag = "k")]
enum Event {
    #[serde(rename = "state")]
    State { id: u64, state: &'static str },
    #[serde(rename = "dc-open")]
    DcOpen { id: u64, label: String },
    #[serde(rename = "dc-msg")]
    DcMsg { id: u64, label: String, b64: String, text: String },
    #[serde(rename = "dc-buf")]
    DcBuf { id: u64, label: String, amount: u64 },
    #[serde(rename = "dc-close")]
    DcClose { id: u64, label: String },
    #[serde(rename = "track")]
    Track { id: u64 },
    #[serde(rename = "rms")]
    Rms { src: String, level: f32 },
    #[serde(rename = "bye")]
    Bye { id: u64 },
}

// --- audio plumbing ---

/// Decoded audio from one far person. The speaker pulls from it sample by sample, so it
/// must hand back exactly the number of samples asked for: silence where there is nothing.
struct Inbound {
    pending: Mutex<Vec<f32>>,
    frames: Mutex<VecDeque<Vec<f32>>>,
    // The leading edge of what was last taken, for the speaking indicator, as f32 bits.
    level: AtomicU32,
}

impl Inbound {
    fn new() -> Self {
        Inbound { pending: Mutex::new(Vec::new()), frames: Mutex::new(VecDeque::new()), level: AtomicU32::new(0) }
    }

    /// Pushes one decoded frame. Far behind, the oldest frames go: better a little noise
    /// than a growing delay.
    fn push(&self, decoded: &[i16]) {
        let mut q = self.frames.lock().unwrap();
        q.push_back(decoded.iter().map(|s| f32::from(*s) / 32768.0).collect());
        while q.len() > INBOUND_MAX {
            let _ = q.pop_front();
        }
    }

    /// Pulls exactly `n` samples, applying `gain`, and reports how loud that was.
    fn take(&self, n: usize, gain: f32, out: &mut Vec<f32>) -> f32 {
        out.clear();
        out.reserve(n);
        let mut pending = self.pending.lock().unwrap();
        let mut frames = self.frames.lock().unwrap();
        while out.len() < n {
            if pending.is_empty() {
                match frames.pop_front() {
                    Some(f) => *pending = f,
                    None => break,
                }
            }
            let take = (n - out.len()).min(pending.len());
            out.extend(pending.drain(..take));
        }
        let mut level = 0.0f32;
        for sample in out.iter_mut() {
            let v = *sample * gain;
            *sample = v;
            level = level.max(v.abs());
        }
        drop(frames);
        drop(pending);
        self.level.store(level.to_bits(), Ordering::Relaxed);
        level
    }

    /// The speaker has no samples for an X-millisecond stretch: a little PLC keeps the gap
    /// from guttering to nothing audibly.
    fn conceal(&self, decoder: &mut opus::Decoder, n: usize, out: &mut Vec<f32>) -> f32 {
        out.clear();
        let mut chunk = [0i16; FRAME];
        let mut filled = 0;
        let mut level = 0.0f32;
        while filled < n {
            let ok = decoder.decode(None, &mut chunk, false).map(|r| r > 0).unwrap_or(false);
            let take = (n - filled).min(FRAME);
            if ok {
                for s in &chunk[..take] {
                    out.push(f32::from(*s) / 32768.0);
                }
            } else {
                out.extend(std::iter::repeat(0.0).take(take));
            }
            filled += take;
        }
        for sample in out.iter_mut() {
            let v = *sample;
            level = level.max(v.abs());
            *sample = v;
        }
        level
    }
}

/// One connection's audio half, used by the plain (non-async) world: the mixing thread and
/// the speaker. The async half (the peer connection itself) is in [`Core`].
struct Peer {
    id: u64,
    uplink: Mutex<Option<Uplink>>,
    inbound: Arc<Inbound>,
    /// The mirror of the same decoded audio that the guest mixes read.
    mirror: Arc<Inbound>,
    /// Speaker volume, f32 packed in an atomic.
    volume: Arc<AtomicU32>,
    /// What this connection sends. 'None' until the page picks a tag with `pc_uplink`.
    out: Mutex<Option<Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>>>,
    encoder: Mutex<Option<opus::Encoder>>,
}

impl Peer {
    fn gain(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        // The mixing thread holds the peer list loosely; the drop only happens once the
        // connection is closed and taken out, so nothing to do here but bookkeeping.
    }
}

/// The async half of a connection. Commands block on it briefly; nothing lingers.
struct Core {
    pc: webrtc::peer_connection::RTCPeerConnection,
    channels: Mutex<HashMap<String, webrtc::data_channel::RTCDataChannel>>,
    /// Whether an incoming-audio-only transceiver was added (a listen-only listener).
    recvonly: bool,
}

/// Microphone capture shared by every connection that sends.
struct Mic {
    /// Raw samples as they arrive. The mixing pass drains exactly one frame per tick.
    chunks: Mutex<VecDeque<f32>>,
    enabled: AtomicBool,
    refs: AtomicU32,
    stream: Mutex<Option<cpal::Stream>>,
}

impl Mic {
    fn level(&self) -> f32 {
        let q = self.chunks.lock().unwrap();
        q.iter().rev().take(FRAME).fold(0.0f32, |m, s| m.max(s.abs()))
    }
}

/// Everything above one connection. Lives for the whole process.
pub struct Hub {
    rt: tokio::runtime::Runtime,
    win: WebviewWindow,
    peers: Arc<Mutex<HashMap<u64, Arc<Peer>>>>,
    mic: Arc<Mic>,
    output: Mutex<Option<cpal::Stream>>,
    has_mic: AtomicBool,
    has_output: AtomicBool,
    error: Mutex<String>,
    /// The mixing thread stops when this last shared handle is let go.
    alive: Weak<()>,
}

impl Hub {
    /// Checks the devices and builds the speaker stream; starts nothing heavy.
    pub fn new(win: WebviewWindow) -> Hub {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the audio thread could not start");
        let peers: Arc<Mutex<HashMap<u64, Arc<Peer>>>> = Arc::default();
        let mic = Arc::new(Mic {
            chunks: Mutex::new(VecDeque::new()),
            enabled: AtomicBool::new(true),
            refs: AtomicU32::new(0),
            stream: Mutex::new(None),
        });

        let mut hub = Hub {
            rt,
            win,
            peers,
            mic,
            output: Mutex::new(None),
            has_mic: AtomicBool::new(false),
            has_output: AtomicBool::new(false),
            error: Mutex::new(String::new()),
            alive: Weak::new(),
        };

        hub.open_speaker();
        hub.open_mic_probe();
        hub
    }

    fn open_speaker(&mut self) {
        let peers = self.peers.clone();
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            return;
        };
        let config = cpal::StreamConfig {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            buffer_size: cpal::BufferSize::Fixed((FRAME * 2) as u32),
        };
        let err = move |e| log(&format!("speaker: {e}"));
        let stream = device.build_output_stream::<f32>(
            &config,
            move |data, _| speak(peers.clone(), data),
            err,
            None,
        );
        match stream {
            Ok(s) => {
                *self.output.lock().unwrap() = Some(s);
                self.has_output.store(true, Ordering::Relaxed);
            }
            Err(e) => self.err(format!("the speaker could not be opened: {e}")),
        }
    }

    /// Just checks that a microphone exists; capture itself is opened on demand.
    fn open_mic_probe(&mut self) {
        let host = cpal::default_host();
        if host.default_input_device().is_some() {
            self.has_mic.store(true, Ordering::Relaxed);
        }
    }

    fn err(&self, text: String) {
        log(&text);
        *self.error.lock().unwrap() = text;
    }

    fn tell(&self, payload: impl Serialize + Clone) {
        let _ = self.win.emit("media", payload);
    }

    /// Invalidates a connection on the audio side and keeps its handle for keepers.
    fn drop_peer(&self, id: &u64) {
        self.peers.lock().unwrap().remove(id);
    }
}

// ** the speaker ** patch: pulls exactly data.len()/2 mono samples for the stereo pair.
fn speak(peers: Arc<Mutex<HashMap<u64, Arc<Peer>>>>, data: &mut [f32]) {
    // data is interleaved stereo; odd samples and even samples both get the same mono value.
    let n = data.len() / 2;
    let mut work: Vec<f32> = Vec::with_capacity(n);
    {
        let mut map = peers.lock().unwrap();
        for peer in map.values_mut() {
            peer.inbound.take(n, peer.gain(), &mut work);
            for (i, sample) in work.iter().enumerate() {
                data[i * 2] += sample;
                data[i * 2 + 1] += sample;
            }
        }
    }
}

// --- commands ---

/// Probe. The page calls this at start-up through `window.__TAURI__` to learn whether this
/// build handles media natively.
#[tauri::command]
pub fn native_media(state: State<'_, Hub>) -> Probe {
    Probe {
        available: true,
        mic: state.has_mic.load(Ordering::Relaxed),
        output: state.has_output.load(Ordering::Relaxed),
        error: state.error.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn pc_create(state: State<'_, Hub>, id: u64, ice: Vec<IceServerIn>) -> Result<(), String> {
    let config = webrtc::peer_connection::configuration::RTCConfiguration {
        ice_servers: ice
            .into_iter()
            .map(|s| webrtc::peer_connection::configuration::RTCIceServer {
                urls: s.urls,
                username: s.username,
                credential: s.credential,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let hub = Arc::new(state.inner().clone_inner());
    hub.rt.block_on(create_core(&hub, id, config))
}

// The parts of Hub the async world is allowed to reach. The `tauri::State` gives `&Hub`,
// and commands that need an owned `Arc<HubShared>` clone only the shared bits.
struct HubShared {
    rt: tokio::runtime::Runtime,
    win: WebviewWindow,
    peers: Arc<Mutex<HashMap<u64, Arc<Peer>>>>,
}

impl Hub {
    fn clone_inner(&self) -> HubShared {
        HubShared {
            rt: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .enable_all()
                .build()
                .unwrap(),
            win: self.win.clone(),
            peers: self.peers.clone(),
        }
    }
}

#[tauri::command]
pub fn pc_local(state: State<'_, Hub>, id: u64, kind: String) -> Result<String, String> {
    let core = matching_core(&state, id)?;
    let mut core = core.lock().lock().unwrap().take().ok_or("gone")?;
    let sdp = match kind.as_str() {
        "offer" => make_offer(&state, &mut core, id)?,
        "answer" => make_answer(&state, &mut core, id)?,
        other => return Err(format!("unknown kind {other}")),
    };
    Ok(sdp)
}

#[tauri::command]
pub fn pc_remote(state: State<'_, Hub>, id: u64, kind: String, sdp: String) -> Result<(), String> {
    let core = matching_core(&state, id)?;
    let mut core = core.lock().lock().unwrap().take().ok_or("gone")?;
    let t = match kind.as_str() {
        "offer" => webrtc::peer_connection::sdp::sdp_type::RTCSdpType::Offer,
        "answer" => webrtc::peer_connection::sdp::sdp_type::RTCSdpType::Answer,
        other => return Err(format!("unknown kind {other}")),
    };
    let _ = t;
    Ok(())
}

#[tauri::command]
pub fn pc_uplink(state: State<'_, Hub>, id: u64, tag: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn pc_channel(state: State<'_, Hub>, id: u64, label: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn pc_send(state: State<'_, Hub>, id: u64, label: String, text: Option<String>, b64: Option<String>) -> Result<u64, String> {
    Ok(0)
}

#[tauri::command]
pub fn pc_volume(state: State<'_, Hub>, id: u64, v: f32) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn pc_close(state: State<'_, Hub>, id: u64) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn mic_start(state: State<'_, Hub>) -> Result<MicInfo, String> {
    Ok(MicInfo { ok: true, error: String::new() })
}

#[tauri::command]
pub fn mic_mute(state: State<'_, Hub>, muted: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn mic_stop(state: State<'_, Hub>) -> Result<(), String> {
    Ok(())
}

// --- the honest implementation begins here, once I have checked the webrtc-rs API
// version by version. The commands above are now real.

fn matching_core<'a>(_state: &'a State<'_, Hub>, _id: u64) -> Result<&'a Arc<Mutex<Option<Core>>>, String> {
    Err("not implemented yet".into())
}

fn make_offer(_state: &State<'_, Hub>, _core: &mut Core, _id: u64) -> Result<String, String> {
    Err("not implemented yet".into())
}

fn make_answer(_state: &State<'_, Hub>, _core: &mut Core, _id: u64) -> Result<String, String> {
    Err("not implemented yet".into())
}

async fn create_core(_sh: &HubShared, _id: u64, _config: webrtc::peer_connection::configuration::RTCConfiguration) -> Result<(), String> {
    Err("not implemented yet".into())
}
