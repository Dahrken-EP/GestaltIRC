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
// a tag (the microphone, the room's mix, one guest's mix), and the mixing pass below
// builds those mixes. The decoder runs twice per connection — once into the local speaker
// buffer, once into a mirror the mixes read — so playing a room to the speakers never
// steals the audio the guests are supposed to hear.
//
// Experimental: stages of the page-side protocol and the hang-up handshake are still
// ahead, so some declared pieces wait to be wired.
#![allow(dead_code)]

use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};

use base64::Engine;
use cpal::{FromSample, SizedSample};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State, WebviewWindow};
use webrtc::{
    api::{setting_engine::SettingEngine, APIBuilder},
    data_channel::{data_channel_init::RTCDataChannelInit, data_channel_message::DataChannelMessage, RTCDataChannel},
    ice::mdns::MulticastDnsMode,
    ice_transport::ice_gathering_state::RTCIceGatheringState,
    media::Sample as MediaSample,
    peer_connection::{
        configuration::RTCConfiguration,
        offer_answer_options::{RTCAnswerOptions, RTCOfferOptions},
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
        RTCPeerConnection,
    },
    rtp_transceiver::{
        rtp_codec::RTPCodecType, rtp_transceiver_direction::RTCRtpTransceiverDirection,
        RTCRtpTransceiverInit,
    },
    sdp,
    track::{
        track_local::{track_local_static_sample::TrackLocalStaticSample, TrackLocal},
        track_remote::TrackRemote,
    },
};

const SAMPLE_RATE: u32 = 48_000;
const FRAME: usize = 960; // 20 ms of mono at the sample rate above
const FRAME_MS: u64 = 20;
const TICK: Duration = Duration::from_millis(FRAME_MS);
const INBOUND_MAX: usize = 24; // decoded frames past this are dropped: never let it lag behind
const RMS_EVERY: u32 = 5; // mixing passes between loudness events: 100 ms
const GATHER_WAIT: Duration = Duration::from_secs(4);
const MIC_KEEP: usize = 8192; // about 170 ms of capture; older is shed

const MIME: &str = "audio/opus";

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const MAX_PCM: f32 = 32767.0;
const MIN_PCM: f32 = -32768.0;

fn log(text: &str) {
    use std::sync::OnceLock;
    static START: OnceLock<Instant> = OnceLock::new();
    let t = START.get_or_init(Instant::now);
    println!("media: {:.3}s {}", t.elapsed().as_secs_f64(), text);
}
pub(crate) fn log_line(text: &str) {
    log(text);
}

fn estr(e: impl std::fmt::Display) -> String {
    format!("{e}")
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
            other if other.starts_with("guest:") && other.len() > 6 => {
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
pub struct MicInfo {
    ok: bool,
    error: String,
}

#[derive(Deserialize)]
pub struct IceServerIn {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
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
    DcMsg {
        id: u64,
        label: String,
        b64: String,
        text: String,
    },
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
    // How many decoded frames have ever arrived, for diagnostics.
    fed: AtomicU64,
    // The leading edge of what was last taken, for the speaking indicator, as f32 bits.
    level: AtomicU32,
}

impl Inbound {
    fn new() -> Self {
        Inbound {
            pending: Mutex::new(Vec::new()),
            frames: Mutex::new(VecDeque::new()),
            fed: AtomicU64::new(0),
            level: AtomicU32::new(0),
        }
    }

    /// Pushes one decoded frame. Far behind, the oldest frames go: better a little noise
    /// than a growing delay.
    fn push(&self, decoded: &[i16]) {
        let mut q = self.frames.lock().unwrap();
        q.push_back(decoded.iter().map(|s| f32::from(*s) / 32768.0).collect());
        while q.len() > INBOUND_MAX {
            let _ = q.pop_front();
        }
        self.fed.fetch_add(1, Ordering::Relaxed);
    }

    /// Pulls exactly `n` samples, applying `gain`, and reports how loud that was *before*
    /// the gain, so a moved volume slider does not move the speaking meter.
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
        drop(frames);
        drop(pending);
        let mut level = 0.0f32;
        for sample in out.iter() {
            level = level.max(sample.abs());
        }
        for sample in out.iter_mut() {
            let v = (*sample * gain).clamp(-1.0, 1.0);
            *sample = v;
        }
        self.level.store(level.to_bits(), Ordering::Relaxed);
        level
    }
}

/// Clamps one mixing sample into the signed 16-bit range Opus wants.
fn to_pcm16(v: f32) -> i16 {
    (v * MAX_PCM).clamp(MIN_PCM, MAX_PCM) as i16
}

/// A linear resampler between two rates, for speakers and microphones that run at rates
/// other than 48 kHz. Good enough for speech.
struct Rs {
    /// Source samples consumed per output sample.
    step: f64,
    /// Position between `s0` and `s1`, in [0, 1).
    u: f64,
    s0: f32,
    s1: f32,
    init: bool,
}

impl Rs {
    fn new(step: f64) -> Rs {
        Rs { step, u: 0.0, s0: 0.0, s1: 0.0, init: false }
    }

    /// The next output sample, taking source samples from `pull` as needed.
    fn next(&mut self, mut pull: impl FnMut() -> f32) -> f32 {
        if !self.init {
            self.s0 = pull();
            self.s1 = pull();
            self.init = true;
        }
        while self.u >= 1.0 {
            self.u -= 1.0;
            self.s0 = self.s1;
            self.s1 = pull();
        }
        let v = self.s0 + (self.s1 - self.s0) * (self.u as f32);
        self.u += self.step;
        v
    }
}

// --- capture ---

/// The capture callback: downmixes whatever channels and sample type the device gives to
/// mono f32 and queues it at the capture rate. Muted, the queue stays empty and any
/// leftover is shed, so the speaking meter reads silence and memory does not grow.
fn recorder<T: SizedSample>(
    inner: Arc<Inner>,
    channels: usize,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    f32: FromSample<T>,
{
    move |data: &[T], _: &cpal::InputCallbackInfo| {
        let mut q = inner.mic.chunks.lock().unwrap();
        if !inner.mic.enabled.load(Ordering::Relaxed) {
            q.clear();
            return;
        }
        let ch = channels.max(1);
        let mut pos = 0;
        while pos + ch <= data.len() {
            let mut sum = 0.0f32;
            for k in 0..ch {
                sum += data[pos + k].to_sample::<f32>();
            }
            q.push_back(sum / ch as f32);
            pos += ch;
        }
        while q.len() > MIC_KEEP {
            let _ = q.pop_front();
        }
    }
}

// --- connections ---

/// One connection: the async half (the peer connection) and the audio halves (what plays,
/// what the mixes read) behind one Arc, so any thread can hold it.
struct Conn {
    id: u64,
    pc: RTCPeerConnection,
    channels: Mutex<HashMap<String, Arc<RTCDataChannel>>>,
    /// The track this connection sends, if any. `None` until the page asks for audio.
    track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
    /// What this connection sends. `None` sends nothing at all (still receiving).
    uplink: Mutex<Option<Uplink>>,
    inbound: Arc<Inbound>,
    /// The mirror of the same decoded audio that the guest mixes read.
    mirror: Arc<Inbound>,
    volume: AtomicU32,
    /// ICE candidate lines collected while our description was being set.
    gathered: Mutex<Vec<String>>,
}

impl Conn {
    fn gain(&self) -> f32 {
        f32::from_bits(self.volume.load(Ordering::Relaxed))
    }
}

// --- the hub ---

/// Everything above one connection. Tauri manages one `Hub` for the process.
pub struct Hub(Arc<Inner>);

struct Inner {
    win: WebviewWindow,
    rt: tokio::runtime::Runtime,
    peers: Mutex<HashMap<u64, Arc<Conn>>>,
    mic: Mic,
    /// Held streams; dropped on app exit, which stops their callback threads.
    output: Mutex<Option<cpal::Stream>>,
    input: Mutex<Option<cpal::Stream>>,
    has_mic: AtomicBool,
    has_output: AtomicBool,
    error: Mutex<String>,
    /// The microphone's capture rate, once capture begins; 0 until then.
    rate: AtomicU64,
    /// GESTALT_MEDIA_FAKE_AUDIO is set: no sound device is opened. A thread supplies a quiet tone as the
    /// microphone and takes what would be played, so the rest of the stack (encoding, RTP, decoding, the
    /// loudness meters) runs as it does with real devices. For machines with no audio, and for tests.
    fake: bool,
    /// Whether the fake microphone is switched on (some voice chat holds the microphone).
    fake_mic: AtomicBool,
}

struct Mic {
    /// Raw mono samples as they arrive, at the capture rate. The mixing pass drains exactly
    /// one 20 ms frame per tick, resampled.
    chunks: Mutex<VecDeque<f32>>,
    enabled: AtomicBool,
    refs: AtomicU32,
    /// The resampler from the capture rate to 48 kHz, built on first use.
    rs: Mutex<Option<Rs>>,
}

impl Mic {
    /// One 20 ms mono frame at 48 kHz, taken from the capture queue. Muted or not started,
    /// it is silence.
    fn frame(&self, inner_rate: u64) -> Vec<f32> {
        if !self.enabled.load(Ordering::Relaxed) || inner_rate == 0 {
            return vec![0.0; FRAME];
        }
        let mut out = Vec::with_capacity(FRAME);
        let mut q = self.chunks.lock().unwrap();
        let mut rs = self.rs.lock().unwrap();
        let rs = rs.get_or_insert_with(|| Rs::new(inner_rate as f64 / SAMPLE_RATE as f64));
        for _ in 0..FRAME {
            let v = rs.next(|| q.pop_front().unwrap_or(0.0));
            out.push(v.clamp(-1.0, 1.0));
        }
        out
    }
}

impl Inner {
    fn fail(&self, text: String) {
        log(&text);
        *self.error.lock().unwrap() = text;
    }

    fn tell(&self, payload: impl Serialize + Clone) {
        let _ = self.win.emit("media", payload);
    }

    /// The connection of that id, cloned out of the map, or "gone".
    fn conn(&self, id: u64) -> Result<Arc<Conn>, String> {
        self.peers.lock().unwrap().get(&id).cloned().ok_or_else(|| "that connection is gone".into())
    }

    // --- speaker ---

    fn open_speaker(self: &Arc<Self>) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            self.fail("no speaker device was found".into());
            return;
        };
        // First ask for the rate the mixing runs at; if the device cannot take it, take the
        // device's own rate and resample while playing.
        let primary = cpal::StreamConfig {
            channels: 2,
            sample_rate: cpal::SampleRate(SAMPLE_RATE),
            buffer_size: cpal::BufferSize::Fixed((FRAME * 2) as u32),
        };
        // The callback with an explicit signature: the stream builder demands a closure
        // that is generic over the lifetimes of its arguments, which inference alone
        // does not give.
        fn play_for(
            inner: Arc<Inner>,
            channels: usize,
            rate: u32,
        ) -> impl FnMut(&mut [f32], &cpal::OutputCallbackInfo) + Send + 'static {
            let mut plays: HashMap<u64, Play> = HashMap::new();
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                let ch = channels.max(1);
                let frames = data.len() / ch;
                // A snapshot of the connections for this pass only, volumes in hand.
                let peers: Vec<(Arc<Conn>, f32)> = inner
                    .peers
                    .lock()
                    .unwrap()
                    .values()
                    .cloned()
                    .map(|c| {
                        let g = c.gain();
                        (c, g)
                    })
                    .collect();
                for s in data.iter_mut() {
                    *s = 0.0;
                }
                for (conn, gain) in peers {
                    let play = plays.entry(conn.id).or_insert_with(|| Play::new(rate));
                    let mono = play.pull(&conn.inbound, frames, gain);
                    for (i, v) in mono.iter().enumerate() {
                        for k in 0..ch {
                            data[i * ch + k] += *v;
                        }
                    }
                }
                for s in data.iter_mut() {
                    *s = s.clamp(-1.0, 1.0);
                }
            }
        }
        let err = |what: &'static str| move |e| log(&format!("{what}: {e}"));
        let inner = self.clone();
        match device.build_output_stream::<f32, _, _>(&primary, play_for(inner, 2, SAMPLE_RATE), err("speaker"), None) {
            Ok(s) => {
                let _ = s.play();
                *self.output.lock().unwrap() = Some(s);
                self.has_output.store(true, Ordering::Relaxed);
            }
            Err(_) => {
                let cfg = match device.default_output_config() {
                    Ok(c) => c,
                    Err(e) => {
                        self.fail(format!("the speaker could not be opened: {e}"));
                        return;
                    }
                };
                let rate = cfg.sample_rate().0;
                let channels = cfg.channels().max(1) as usize;
                let fallback = cpal::StreamConfig { channels: channels as u16, sample_rate: cpal::SampleRate(rate), buffer_size: cpal::BufferSize::Default };
                let inner = self.clone();
                match device.build_output_stream::<f32, _, _>(&fallback, play_for(inner, channels, rate), err("speaker"), None) {
                    Ok(s) => {
                        let _ = s.play();
                        *self.output.lock().unwrap() = Some(s);
                        self.has_output.store(true, Ordering::Relaxed);
                    }
                    Err(e) => self.fail(format!("the speaker could not be opened: {e}")),
                }
            }
        }
    }

    /// The stand-in for the sound devices (see `fake`): every 20 ms it queues a frame of a 440 Hz tone as the
    /// microphone's capture, unless that is switched off or muted, and takes the frame the speaker would have
    /// played from each connection, which also keeps the loudness the page's speaking meters read.
    fn spawn_fake_audio(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let _ = std::thread::Builder::new().name("gestalt-media-fake".into()).spawn(move || {
            let mut phase = 0.0f32;
            let mut next = Instant::now();
            let mut scratch = Vec::new();
            loop {
                next += TICK;
                std::thread::sleep(next.saturating_duration_since(Instant::now()));
                let Some(inner) = weak.upgrade() else { return };
                if inner.fake_mic.load(Ordering::Relaxed) {
                    let mut q = inner.mic.chunks.lock().unwrap();
                    if inner.mic.enabled.load(Ordering::Relaxed) {
                        for _ in 0..FRAME {
                            q.push_back(0.2 * phase.sin());
                            phase = (phase + std::f32::consts::TAU * 440.0 / SAMPLE_RATE as f32) % std::f32::consts::TAU;
                        }
                        while q.len() > MIC_KEEP {
                            let _ = q.pop_front();
                        }
                    } else {
                        q.clear();
                    }
                }
                let peers: Vec<Arc<Conn>> = inner.peers.lock().unwrap().values().cloned().collect();
                for c in peers {
                    c.inbound.take(FRAME, c.gain(), &mut scratch);
                }
            }
        });
    }

    // --- microphone ---

    /// Opens the capture stream. The first ask is at the mixing rate; if the device refuses,
    /// its own rate and format are taken, and the mixing pass resamples.
    fn open_input(self: &Arc<Self>) -> Result<(), String> {
        if self.fake {
            self.rate.store(SAMPLE_RATE as u64, Ordering::Relaxed);
            self.fake_mic.store(true, Ordering::Relaxed);
            return Ok(());
        }
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        use cpal::SampleFormat;
        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("no microphone device was found")?;
        let err = |what: &'static str| move |e| log(&format!("{what}: {e}"));
        let cfg48 = cpal::StreamConfig { channels: 1, sample_rate: cpal::SampleRate(SAMPLE_RATE), buffer_size: cpal::BufferSize::Default };
        let first = recorder::<f32>(self.clone(), 1);
        let stream = match device.build_input_stream::<f32, _, _>(&cfg48, first, err("microphone"), None) {
            Ok(s) => {
                self.rate.store(SAMPLE_RATE as u64, Ordering::Relaxed);
                s
            }
            Err(_) => {
                // Whatever the device prefers: its own rate, channels and sample format.
                let d = device
                    .default_input_config()
                    .map_err(|e| format!("the microphone could not be opened: {e}"))?;
                let cfg = cpal::StreamConfig {
                    channels: d.channels(),
                    sample_rate: d.sample_rate(),
                    buffer_size: cpal::BufferSize::Default,
                };
                let channels = d.channels() as usize;
                let built = match d.sample_format() {
                    SampleFormat::F32 => device.build_input_stream::<f32, _, _>(&cfg, recorder::<f32>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::I16 => device.build_input_stream::<i16, _, _>(&cfg, recorder::<i16>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::U16 => device.build_input_stream::<u16, _, _>(&cfg, recorder::<u16>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::I8 => device.build_input_stream::<i8, _, _>(&cfg, recorder::<i8>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::I32 => device.build_input_stream::<i32, _, _>(&cfg, recorder::<i32>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::I64 => device.build_input_stream::<i64, _, _>(&cfg, recorder::<i64>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::U8 => device.build_input_stream::<u8, _, _>(&cfg, recorder::<u8>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::U32 => device.build_input_stream::<u32, _, _>(&cfg, recorder::<u32>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::U64 => device.build_input_stream::<u64, _, _>(&cfg, recorder::<u64>(self.clone(), channels), err("microphone"), None),
                    SampleFormat::F64 => device.build_input_stream::<f64, _, _>(&cfg, recorder::<f64>(self.clone(), channels), err("microphone"), None),
                    // cpal keeps adding formats; refuse rather than guess.
                    _ => return Err("the microphone's sample format is not supported".into()),
                };
                let s = built.map_err(|e| format!("the microphone could not be opened: {e}"))?;
                self.rate.store(d.sample_rate().0 as u64, Ordering::Relaxed);
                s
            }
        };
        let _ = stream.play();
        *self.input.lock().unwrap() = Some(stream);
        self.has_mic.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn probe_mic(&self) {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        if host.default_input_device().is_some() {
            self.has_mic.store(true, Ordering::Relaxed);
        }
    }

    // --- mixing ---

    /// The mixing pass: pulls the microphone, sends each connection the mix its uplink tag
    /// names, and every so often reports loudness so the page's meters keep working.
    fn spawn_mixer(self: &Arc<Self>) {
        let inner = self.clone();
        let started = std::thread::Builder::new()
            .name("gestalt-media-mix".into())
            .spawn(move || {
                // One encoder per kind of mix, kept so its state carries frame to frame.
                let mut encoders: HashMap<String, opus::Encoder> = HashMap::new();
                let mut pass: u32 = 0;
                let mut next = Instant::now();
                loop {
                    mix_pass(&inner, &mut encoders, pass);
                    pass += 1;
                    next += TICK;
                    let now = Instant::now();
                    if next <= now {
                        next = now;
                    } else {
                        std::thread::sleep(next - now);
                    }
                }
            });
        if let Err(e) = started {
            self.fail(format!("the mixing thread could not start: {e}"));
        }
    }
}

/// The play-side state of one connection: the source samples not yet turned into output,
/// and how far into the fractional part we are.
struct Play {
    src: Vec<f32>,
    /// Index of the current pair's first sample in `src`.
    i: usize,
    /// The fractional position between `src[i]` and `src[i+1]`, in [0, 1).
    frac: f64,
    step: f64,
}

impl Play {
    fn new(rate: u32) -> Play {
        let step = SAMPLE_RATE as f64 / rate.max(1) as f64;
        Play { src: Vec::new(), i: 0, frac: 0.0, step }
    }

    /// Fills `frames` resampled samples from `inbound`, taking more source with `gain`
    /// where the carry runs dry. Starved material becomes silence. When the device runs at
    /// the mixing rate itself, `step` is 1 and the samples pass through untouched.
    fn pull(&mut self, inbound: &Inbound, frames: usize, gain: f32) -> Vec<f32> {
        let want = (self.step * frames as f64).ceil() as usize + 2;
        while self.src.len() - self.i < want {
            inbound.take(want - (self.src.len() - self.i), gain, &mut self.src);
        }
        let mut out = Vec::with_capacity(frames);
        let mut i = self.i;
        let mut frac = self.frac;
        for _ in 0..frames {
            if i + 1 >= self.src.len() {
                break;
            }
            let a = self.src[i];
            let b = self.src[i + 1];
            out.push(a + (b - a) * (frac as f32));
            frac += self.step;
            while frac >= 1.0 {
                frac -= 1.0;
                i += 1;
            }
        }
        while out.len() < frames {
            out.push(0.0);
        }
        // The pair we stopped at is carried to the next callback; what is before it is
        // spent, and shed once enough of it has piled up.
        self.i = i;
        self.frac = frac;
        if self.i > MIC_KEEP {
            self.src.drain(..self.i);
            self.i = 0;
        }
        out
    }
}

const CHUNK: usize = 960;

/// One mixing pass.
fn mix_pass(inner: &Arc<Inner>, encoders: &mut HashMap<String, opus::Encoder>, pass: u32) {
    let peers: Vec<Arc<Conn>> = inner.peers.lock().unwrap().values().cloned().collect();
    if peers.is_empty() {
        return;
    }
    let rms = pass % RMS_EVERY == 0;

    // The microphone frame. Muted or idle, it is silence.
    let rate = inner.rate.load(Ordering::Relaxed);
    let mic_frame = inner.mic.frame(rate);
    if rms {
        let level = mic_frame.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        inner.tell(Event::Rms { src: "mic".into(), level });
    }

    // What each guest said this pass, taken once so the mixes can share it.
    let guests: Vec<Arc<Conn>> = peers
        .iter()
        .filter(|c| matches!(*c.uplink.lock().unwrap(), Some(Uplink::Guest(_))))
        .cloned()
        .collect();
    let mut guest_frames: HashMap<u64, Vec<f32>> = HashMap::new();
    for g in &guests {
        let mut f = Vec::new();
        g.mirror.take(FRAME, 1.0, &mut f);
        guest_frames.insert(g.id, f);
    }
    let sum_of = |frames: Vec<&Vec<f32>>| -> Vec<f32> {
        let mut mix = Vec::with_capacity(FRAME);
        for i in 0..FRAME {
            let mut v = 0.0f32;
            for f in &frames {
                v += f.get(i).copied().unwrap_or(0.0);
            }
            mix.push(v.clamp(-1.0, 1.0));
        }
        mix
    };

    // Frames encoded in this pass, by mix kind, so two listeners of the same mix share one.
    let mut new_frames: HashMap<String, Vec<u8>> = HashMap::new();
    inner.rt.block_on(async {
        for c in &peers {
            let track = c.track.lock().unwrap().clone();
            let Some(track) = track else { continue };
            let up = c.uplink.lock().unwrap().clone();
            let Some(up) = up else { continue };
            let key = match &up {
                Uplink::Mic => "mic".to_owned(),
                Uplink::Room => "room".to_owned(),
                Uplink::Guest(_) => format!("guest:{}", c.id),
            };
            // What this connection is sent: the plain microphone, or what the tag names.
            if !new_frames.contains_key(&key) {
                let mix = match &up {
                    Uplink::Mic => mic_frame.clone(),
                    Uplink::Room => {
                        let all: Vec<&Vec<f32>> = guest_frames.values().collect();
                        sum_of(all)
                    }
                    Uplink::Guest(_) => {
                        // Everyone else's frame, never the guest's own: nobody hears themselves.
                        let others: Vec<&Vec<f32>> = guest_frames.iter().filter(|(id, _)| **id != c.id).map(|(_, f)| f).collect();
                        sum_of(others)
                    }
                };
                let Some(bytes) = encode(encoders, &key, &mix) else { continue };
                new_frames.insert(key.clone(), bytes);
            }
            let Some(bytes) = new_frames.get(&key) else { continue };
            let sample = MediaSample {
                data: bytes::Bytes::from(bytes.clone()),
                timestamp: SystemTime::now(),
                duration: Duration::from_millis(FRAME_MS),
                ..MediaSample::default()
            };
            if let Err(e) = track.write_sample(&sample).await {
                log(&format!("pc {}: send: {e}", c.id));
            }
        }
    });

    if rms {
        for c in &peers {
            let level = f32::from_bits(c.inbound.level.load(Ordering::Relaxed));
            if level > 0.0 {
                inner.tell(Event::Rms { src: format!("pc:{}", c.id), level });
            }
        }
    }
}

/// Encodes one 20 ms frame for the mix named `key`, or nothing when Opus refuses.
fn encode(encoders: &mut HashMap<String, opus::Encoder>, key: &str, feed: &[f32]) -> Option<Vec<u8>> {
    if !encoders.contains_key(key) {
        match opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip) {
            Ok(mut e) => {
                let _ = e.set_bitrate(opus::Bitrate::Bits(40_000));
                encoders.insert(key.to_owned(), e);
            }
            Err(e) => {
                log(&format!("the encoder could not start: {e}"));
                return None;
            }
        }
    }
    let enc = encoders.get_mut(key)?;
    match enc.encode_vec_float(feed, 400) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            log(&format!("encode: {e}"));
            None
        }
    }
}

// --- connection building ---

/// Builds a peer connection and wires everything the page expects to hear about: state
/// changes, gathered candidates, incoming audio, and incoming data channels.
async fn create_conn(inner: Arc<Inner>, id: u64, config: RTCConfiguration) -> Result<Arc<Conn>, String> {
    let api = {
        let mut setting = SettingEngine::default();
        // mDNS names in candidates cannot be resolved across the network this runs on, so the
        // honest local addresses are gathered instead.
        setting.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
        let mut builder = APIBuilder::new();
        builder = builder.with_setting_engine(setting);
        // The sender needs a codec to name in the offer; none is registered unless asked.
        let mut engine = webrtc::api::media_engine::MediaEngine::default();
        engine.register_default_codecs().map_err(estr)?;
        builder = builder.with_media_engine(engine);
        builder.build()
    };
    let pc = api.new_peer_connection(config).await.map_err(estr)?;

    // State changes, described the way the page's PeerSession reads `connectionState`.
    {
        let inner = inner.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            let inner = inner.clone();
            Box::pin(async move {
                let s = match state {
                    RTCPeerConnectionState::New => "new",
                    RTCPeerConnectionState::Connecting => "connecting",
                    RTCPeerConnectionState::Connected => "connected",
                    RTCPeerConnectionState::Disconnected => "disconnected",
                    RTCPeerConnectionState::Failed => "failed",
                    RTCPeerConnectionState::Closed => "closed",
                    _ => return,
                };
                inner.tell(Event::State { id, state: s });
                log(&format!("pc {id}: state {s}"));
                if matches!(s, "failed" | "closed") {
                    inner.peers.lock().unwrap().remove(&id);
                }
            })
        }));
    }

    // Candidates go into one list, injected into the SDP when the page collects our
    // description: nothing trickles over the bridge.
    {
        let inner = inner.clone();
        pc.on_ice_candidate(Box::new(move |c| {
            let inner = inner.clone();
            Box::pin(async move {
                if let Some(c) = c {
                    if let Ok(init) = c.to_json() {
                        let line = init.candidate.strip_prefix("candidate:").map(|s| s.to_owned()).unwrap_or(init.candidate);
                        if let Ok(conn) = inner.conn(id) {
                            conn.gathered.lock().unwrap().push(line);
                        }
                    }
                }
            })
        }));
    }

    // What the far side sends: decoded into the speaker buffer and the mirrors alike.
    {
        let inner = inner.clone();
        pc.on_track(Box::new(move |track, _receiver, _transceiver| {
            let inner = inner.clone();
            Box::pin(async move {
                inner.tell(Event::Track { id });
                tokio::spawn(read_loop(inner, id, track));
            })
        }));
    }

    // A channel the far side opened is wired the same as one we opened.
    {
        let inner = inner.clone();
        pc.on_data_channel(Box::new(move |dc| {
            let inner = inner.clone();
            Box::pin(async move {
                wire_channel(inner, id, dc);
            })
        }));
    }

    let conn = Arc::new(Conn {
        id,
        pc,
        channels: Mutex::new(HashMap::new()),
        track: Mutex::new(None),
        uplink: Mutex::new(None),
        inbound: Arc::new(Inbound::new()),
        mirror: Arc::new(Inbound::new()),
        volume: AtomicU32::new(1.0f32.to_bits()),
        gathered: Mutex::new(Vec::new()),
    });
    inner.peers.lock().unwrap().insert(id, conn.clone());
    Ok(conn)
}

/// The sound of one person, decoded as the packets come, into the speaker buffer and the
/// mirror of the mixes at the same time.
async fn read_loop(inner: Arc<Inner>, id: u64, track: Arc<TrackRemote>) {
    let mut dec = match opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono) {
        Ok(d) => d,
        Err(e) => {
            log(&format!("pc {id}: the decoder could not start: {e}"));
            return;
        }
    };
    let Ok(conn) = inner.conn(id) else { return };
    let read_announced = std::sync::atomic::AtomicBool::new(false);
    loop {
        match track.read_rtp().await {
            Ok((packet, _attrs)) => {
                let payload = packet.payload;
                if payload.len() < 2 {
                    continue;
                }
                let mut pcm = [0i16; FRAME];
                match dec.decode(&payload, &mut pcm, false) {
                    Ok(n) if n > 0 => {
                        let debug_live = std::env::var("GESTALT_MEDIA_LIVE").is_ok();
                if (std::env::var("GESTALT_MEDIA_SELFTEST").is_ok() || debug_live)
                    && !read_announced.swap(true, Ordering::Relaxed)
                {
                            log(&format!("pc {id}: the first packet arrived ({n} samples decoded)"));
                        }
                        conn.inbound.push(&pcm[..n]);
                        conn.mirror.push(&pcm[..n]);
                    }
                    Ok(_) => {}
                    Err(e) => log(&format!("pc {id}: decode: {e}")),
                }
            }
            Err(_) => break, // the track ended, or the connection did
        }
    }
    log(&format!("pc {id}: audio stopped"));
}

/// Hooks one channel's lifetime up to the events the page listens for.
fn wire_channel(inner: Arc<Inner>, id: u64, dc: Arc<RTCDataChannel>) {
    let label = dc.label().to_owned();
    if let Ok(conn) = inner.conn(id) {
        conn.channels.lock().unwrap().insert(label.clone(), dc.clone());
    }
    {
        // A channel that fails (a message too big for the read buffer, a reset) is closed by the library, and
        // without this the only sign was a close the page could not explain.
        let label = label.clone();
        dc.on_error(Box::new(move |e| {
            let label = label.clone();
            Box::pin(async move { log(&format!("pc {id}: channel '{label}' failed: {e}")) })
        }));
    }
    {
        let inner = inner.clone();
        let label = label.clone();
        dc.on_open(Box::new(move || {
            let inner = inner;
            let label = label;
            Box::pin(async move {
                inner.tell(Event::DcOpen { id, label });
            })
        }));
    }
    {
        let inner = inner.clone();
        let label = label.clone();
        dc.on_message(Box::new(move |msg: DataChannelMessage| {
            let inner = inner.clone();
            let label = label.clone();
            Box::pin(async move {
                let (b64, text) = if msg.is_string {
                    (String::new(), String::from_utf8_lossy(&msg.data).into_owned())
                } else {
                    (BASE64.encode(&msg.data), String::new())
                };
                inner.tell(Event::DcMsg { id, label: label.clone(), b64, text });
                inner.tell(Event::DcBuf { id, label, amount: msg.data.len() as u64 });
            })
        }));
    }
    {
        // FnMut: both the connection and the channel keep being owned here, so the
        // closure takes its own clones, and the handler wants a boxed future.
        let inner = inner.clone();
        let label = label.clone();
        dc.on_close(Box::new(move || {
            let inner = inner.clone();
            let label = label.clone();
            Box::pin(async move {
                inner.tell(Event::DcClose { id, label });
            })
        }));
    }
}

/// Returns our full description: we set it, wait out the gathering, and put the candidates
/// into the SDP the way a browser would have, since nothing trickles over the bridge.
async fn described_local(pc: &RTCPeerConnection, conn: &Conn, kind: &str) -> Result<String, String> {
    match kind {
        "offer" => {
            let offer = pc.create_offer(None::<RTCOfferOptions>).await.map_err(estr)?;
            pc.set_local_description(offer).await.map_err(estr)?;
        }
        "answer" => {
            let answer = pc.create_answer(None::<RTCAnswerOptions>).await.map_err(estr)?;
            pc.set_local_description(answer).await.map_err(estr)?;
        }
        other => return Err(format!("unknown kind {other}")),
    }
    // With nothing gathered, the SDP still goes out; the far side finds its own way there.
    let deadline = Instant::now() + GATHER_WAIT;
    loop {
        if pc.ice_gathering_state() == RTCIceGatheringState::Complete || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let cands = conn.gathered.lock().unwrap().clone();
    let desc = pc.local_description().await.ok_or("the local description vanished")?;
    with_candidates(&desc.sdp, &cands)
}

/// Puts the gathered candidate lines into every media section of the description, the way
/// a browser writes them out when gathering is done.
fn with_candidates(sdp: &str, lines: &[String]) -> Result<String, String> {
    if lines.is_empty() {
        return Ok(sdp.to_owned());
    }
    let mut parsed = sdp::SessionDescription::unmarshal(&mut Cursor::new(sdp.as_bytes()))
        .map_err(|e| format!("the description could not be read: {e}"))?;
    for media in parsed.media_descriptions.iter_mut() {
        for line in lines {
            media.attributes.push(sdp::description::common::Attribute { key: "candidate".into(), value: Some(line.clone()) });
        }
        media.attributes.push(sdp::description::common::Attribute { key: "end-of-candidates".into(), value: None });
    }
    Ok(parsed.marshal())
}

// --- the Tauri commands ---

/// What the page asks at start-up to learn whether this build handles media natively.
#[tauri::command]
pub fn native_media(state: State<'_, Hub>) -> Probe {
    Probe {
        available: true,
        mic: state.0.has_mic.load(Ordering::Relaxed),
        output: state.0.has_output.load(Ordering::Relaxed),
        error: state.0.error.lock().unwrap().clone(),
    }
}

/// The permissions the bouncer's page is given for the voice bridge (see `grant_media` in main.rs). They are the
/// commands below and no others, and the right to listen for the "media" events they send back.
pub const PERMISSIONS: &[&str] = &[
    "core:event:allow-listen", "core:event:allow-unlisten",
    "allow-native-media", "allow-pc-create", "allow-pc-local", "allow-pc-remote", "allow-pc-track", "allow-pc-uplink",
    "allow-pc-channel", "allow-pc-send", "allow-pc-volume", "allow-pc-close", "allow-mic-start", "allow-mic-mute",
    "allow-mic-stop",
];

/// The most connections the page may hold at once. A voice room holds one per person, and a room is small.
const MAX_CONNECTIONS: usize = 32;

/// Runs a piece of async work on the media runtime and waits for it without blocking the caller. The commands
/// below are `async` so that Tauri runs them off the main thread: the ones that wait (gathering candidates takes
/// seconds) used to freeze the whole window.
async fn on_media<T: Send + 'static>(
    inner: &Arc<Inner>,
    command: &'static str,
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let done = inner.rt.spawn(work).await.map_err(|e| format!("the media task failed: {e}")).and_then(|r| r);
    if std::env::var_os("GESTALT_MEDIA_TRACE").is_some() && done.is_ok() {
        log(&format!("{command}: ok"));
    }
    if let Err(e) = &done {
        // The page sees the error too, but only as a refused promise; this is where a failed call can be found.
        log(&format!("{command}: {e}"));
    }
    done
}

#[tauri::command]
pub async fn pc_create(state: State<'_, Hub>, id: u64, ice: Vec<IceServerIn>) -> Result<(), String> {
    let config = RTCConfiguration {
        ice_servers: ice
            .into_iter()
            .map(|s| webrtc::ice_transport::ice_server::RTCIceServer {
                urls: s.urls,
                username: s.username,
                credential: s.credential,
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let inner = state.0.clone();
    {
        let peers = inner.peers.lock().unwrap();
        if peers.contains_key(&id) {
            return Err("that connection already exists".into());
        }
        if peers.len() >= MAX_CONNECTIONS {
            return Err("too many connections".into());
        }
    }
    let work = inner.clone();
    on_media(&inner, "pc_create", async move {
        create_conn(work, id, config).await?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pc_local(state: State<'_, Hub>, id: u64, kind: String) -> Result<String, String> {
    let conn = state.0.conn(id)?;
    on_media(&state.0, "pc_local", async move { described_local(&conn.pc, &conn, &kind).await }).await
}

#[tauri::command]
pub async fn pc_remote(state: State<'_, Hub>, id: u64, kind: String, sdp: String) -> Result<(), String> {
    let conn = state.0.conn(id)?;
    on_media(&state.0, "pc_remote", async move {
        let desc = match kind.as_str() {
            "offer" => RTCSessionDescription::offer(sdp),
            "answer" => RTCSessionDescription::answer(sdp),
            other => return Err(format!("unknown kind {other}")),
        }
        .map_err(estr)?;
        conn.pc.set_remote_description(desc).await.map_err(estr)?;
        Ok(())
    })
    .await
}

/// Adds audio: kind "mic" puts our own capture on the connection (and sends, unless a tag
/// is set later), kind "recv" asks to only listen.
#[tauri::command]
pub async fn pc_track(state: State<'_, Hub>, id: u64, kind: String) -> Result<(), String> {
    let conn = state.0.conn(id)?;
    on_media(&state.0, "pc_track", async move {
        match kind.as_str() {
            "mic" => {
                let codec = webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability {
                    mime_type: MIME.into(),
                    clock_rate: SAMPLE_RATE,
                    channels: 1,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
                    ..Default::default()
                };
                let track = Arc::new(TrackLocalStaticSample::new(codec, format!("audio-{id}"), "gestalt".into()));
                conn.pc.add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>).await.map_err(estr)?;
                *conn.track.lock().unwrap() = Some(track.clone());
                if conn.uplink.lock().unwrap().is_none() {
                    *conn.uplink.lock().unwrap() = Some(Uplink::Mic);
                }
            }
            "recv" => {
                conn.pc
                    .add_transceiver_from_kind(
                        RTPCodecType::Audio,
                        Some(RTCRtpTransceiverInit {
                            direction: RTCRtpTransceiverDirection::Recvonly,
                            send_encodings: vec![],
                        }),
                    )
                    .await
                    .map_err(estr)?;
            }
            other => return Err(format!("unknown kind {other}")),
        }
        Ok(())
    })
    .await
}

/// Names what this connection sends: the plain microphone, what a guest hears in a room,
/// or what a room hears the host play. Nothing is sent until audio is on the connection.
#[tauri::command]
pub fn pc_uplink(state: State<'_, Hub>, id: u64, tag: String) -> Result<(), String> {
    let conn = state.0.conn(id)?;
    let up = Uplink::parse(&tag, id);
    *conn.uplink.lock().unwrap() = up;
    Ok(())
}

#[tauri::command]
pub async fn pc_channel(state: State<'_, Hub>, id: u64, label: String) -> Result<(), String> {
    let conn = state.0.conn(id)?;
    let inner = state.0.clone();
    on_media(&state.0, "pc_channel", async move {
        let dc = conn
            .pc
            .create_data_channel(&label, Some(RTCDataChannelInit { ordered: Some(true), ..Default::default() }))
            .await
            .map_err(estr)?;
        wire_channel(inner, id, dc);
        Ok(())
    })
    .await
}

/// Sends on one channel: text as text, bytes from base64. Answers the amount sent.
#[tauri::command]
pub async fn pc_send(state: State<'_, Hub>, id: u64, label: String, text: Option<String>, b64: Option<String>) -> Result<u64, String> {
    let conn = state.0.conn(id)?;
    on_media(&state.0, "pc_send", async move {
        let dc = conn.channels.lock().unwrap().get(&label).cloned().ok_or("no such channel")?;
        let amount = if let Some(text) = text {
            dc.send_text(text).await.map_err(estr)? as u64
        } else if let Some(b64) = b64 {
            let bytes = BASE64.decode(b64.as_bytes()).map_err(estr)?;
            let n = bytes.len();
            dc.send(&bytes::Bytes::from(bytes)).await.map_err(estr)?;
            n as u64
        } else {
            0
        };
        Ok(amount)
    })
    .await
}

#[tauri::command]
pub fn pc_volume(state: State<'_, Hub>, id: u64, v: f32) -> Result<(), String> {
    let conn = state.0.conn(id)?;
    let clamped = if v.is_finite() { v.clamp(0.0, 2.0) } else { 1.0 };
    conn.volume.store(clamped.to_bits(), Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn pc_close(state: State<'_, Hub>, id: u64) -> Result<(), String> {
    let conn = state.0.peers.lock().unwrap().remove(&id);
    let Some(conn) = conn else { return Ok(()) };
    on_media(&state.0, "pc_close", async move { conn.pc.close().await.map_err(estr) }).await
}

/// The microphone is shared by every connection that sends, counted: the first start opens it, the last stop
/// closes it.
#[tauri::command]
pub fn mic_start(state: State<'_, Hub>) -> Result<MicInfo, String> {
    let inner = state.0.clone();
    if inner.mic.refs.fetch_add(1, Ordering::Relaxed) == 0 {
        if let Err(e) = inner.open_input() {
            inner.mic.refs.fetch_sub(1, Ordering::Relaxed);
            return Ok(MicInfo { ok: false, error: e });
        }
    }
    Ok(MicInfo { ok: true, error: String::new() })
}

#[tauri::command]
pub fn mic_mute(state: State<'_, Hub>, muted: bool) -> Result<(), String> {
    state.0.mic.enabled.store(!muted, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn mic_stop(state: State<'_, Hub>) -> Result<(), String> {
    let inner = state.0.clone();
    // Never below zero: a stop the page sends twice must not wrap the count round to "in use" for good.
    let was = inner
        .mic
        .refs
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| Some(n.saturating_sub(1)))
        .unwrap_or(0);
    if was <= 1 {
        // The last listener is gone: the capture stops and its leftovers are shed.
        *inner.input.lock().unwrap() = None;
        inner.fake_mic.store(false, Ordering::Relaxed);
        inner.mic.chunks.lock().unwrap().clear();
        *inner.mic.rs.lock().unwrap() = None;
        inner.rate.store(0, Ordering::Relaxed);
    }
    Ok(())
}

// --- the process's one hub ---

/// Builds what Tauri manages for the process: the tokio runtime the bridge calls run on,
/// the speaker stream that plays the mixes, the mixer thread that builds them, and the
/// device facts the page asks for at start-up. It cannot fail at this point — a machine
/// without the devices answers honestly through the probe, not here.
pub fn hub(win: WebviewWindow) -> Hub {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("could not start the media runtime");
    // Not opened yet: whether the machine has the devices is what the page asks first.
    let has = |input: bool| {
        use cpal::traits::HostTrait;
        let host = cpal::default_host();
        if input {
            host.default_input_device().is_some()
        } else {
            host.default_output_device().is_some()
        }
    };
    let fake = std::env::var_os("GESTALT_MEDIA_FAKE_AUDIO").is_some();
    let inner = Arc::new(Inner {
        win,
        rt,
        peers: Mutex::new(HashMap::new()),
        mic: Mic {
            chunks: Mutex::new(VecDeque::new()),
            enabled: AtomicBool::new(true),
            refs: AtomicU32::new(0),
            rs: Mutex::new(None),
        },
        output: Mutex::new(None),
        input: Mutex::new(None),
        has_mic: AtomicBool::new(fake || has(true)),
        has_output: AtomicBool::new(fake || has(false)),
        error: Mutex::new(String::new()),
        rate: AtomicU64::new(0),
        fake,
        fake_mic: AtomicBool::new(false),
    });
    if fake {
        inner.spawn_fake_audio();
        inner.spawn_mixer();
    } else if inner.has_output.load(Ordering::Relaxed) {
        inner.open_speaker();
        inner.spawn_mixer();
    } else {
        inner.fail("no speaker device was found".into());
    }
    log(&format!(
        "the native stack is up: speaker {} microphone {}",
        if inner.has_output.load(Ordering::Relaxed) { "yes" } else { "NO" },
        if inner.has_mic.load(Ordering::Relaxed) { "yes" } else { "NO" },
    ));
    Hub(inner)
}

// --- the live check ---

/// How long one wait may take, in milliseconds. Generous enough for a slow machine,
/// short enough that a stuck connection does not hold the launch for minutes.
const WAIT: u64 = 20_000;

fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Waits until the connection's state says so, giving up with the word for why.
fn wait_state(h: &Arc<Inner>, id: u64, want: RTCPeerConnectionState) -> Result<(), String> {
    let end = Instant::now() + Duration::from_millis(WAIT);
    loop {
        if let Ok(c) = h.conn(id) {
            let s = c.pc.connection_state();
            if s == want {
                return Ok(());
            }
            if matches!(s, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed) {
                return Err(format!("the connection reached {s:?} instead"));
            }
        }
        if Instant::now() >= end {
            return Err("the connection never got there".into());
        }
        sleep(100);
    }
}

/// Waits until the connection's channel exists and is open.
fn wait_channel(h: &Arc<Inner>, id: u64, label: &str) -> Result<Arc<RTCDataChannel>, String> {
    let end = Instant::now() + Duration::from_millis(WAIT);
    loop {
        if let Ok(c) = h.conn(id) {
            if let Some(dc) = c.channels.lock().unwrap().get(label).cloned() {
                if dc.ready_state() == webrtc::data_channel::data_channel_state::RTCDataChannelState::Open {
                    return Ok(dc);
                }
            }
        }
        if Instant::now() >= end {
            return Err(format!("the channel '{label}' at connection {id} never opened"));
        }
        sleep(50);
    }
}

/// Waits until far sound has been decoded into this connection's mixing buffer —
/// real Opus arriving over the network and being pushed into the parts the speaker reads.
fn wait_audio(h: &Arc<Inner>, id: u64) -> Result<(), String> {
    let end = Instant::now() + Duration::from_millis(WAIT);
    loop {
        if let Ok(c) = h.conn(id) {
            if c.inbound.fed.load(Ordering::Relaxed) > 0 {
                return Ok(());
            }
        }
        if Instant::now() >= end {
            return Err("no decoded sound arrived".into());
        }
        sleep(50);
    }
}

fn wait_gone(h: &Arc<Inner>, ids: &[u64]) -> Result<(), String> {
    let end = Instant::now() + Duration::from_millis(WAIT);
    loop {
        if ids.iter().all(|id| h.conn(*id).is_err()) {
            return Ok(());
        }
        if Instant::now() >= end {
            return Err("the connections did not come down".into());
        }
        sleep(50);
    }
}

/// The whole native voice loop in one process, with no page: two peer connections find
/// each other by their own ICE, a channel passes sends both ways, both sides carry the
/// Rust microphone to the other's mixing buffer, volumes apply, and everything comes
/// down again. GESTALT_MEDIA_SELFTEST=1 runs this at startup, says what it found, and
/// exits so nothing else is left running.
/// The commands are async for Tauri; the selftest has no runtime of its own, so it waits on the media one.
fn block<T>(state: &tauri::State<'_, Hub>, fut: impl std::future::Future<Output = T>) -> T {
    state.0.rt.block_on(fut)
}

pub fn selftest(state: &tauri::State<'_, Hub>) -> Result<(), String> {
    log("selftest: making two connections over one offer");
    block(state, pc_create(state.clone(), 1, Vec::new()))?;
    block(state, pc_create(state.clone(), 2, Vec::new()))?;
    block(state, pc_channel(state.clone(), 1, "s".into()))?;
    block(state, pc_track(state.clone(), 1, "mic".into()))?;
    let offer = block(state, pc_local(state.clone(), 1, "offer".into()))?;
    log("selftest: carried the description over");
    // The answering side puts its own microphone on BEFORE taking the offer: a track
    // added after becomes a second m-line this stack will not fold into the offered one,
    // and browsers fold nothing here either. Before is the order that works everywhere.
    block(state, pc_track(state.clone(), 2, "mic".into()))?;
    block(state, pc_remote(state.clone(), 2, "offer".into(), offer))?;
    let answer = block(state, pc_local(state.clone(), 2, "answer".into()))?;
    block(state, pc_remote(state.clone(), 1, "answer".into(), answer))?;
    log("selftest: exchanging states");
    for (id, side) in [(1u64, "the offerer"), (2u64, "the answerer")] {
        wait_state(&state.0, id, RTCPeerConnectionState::Connected)
            .map_err(|e| format!("{side}: {e}"))?;
    }
    log("selftest: connected");
    let dc1 = wait_channel(&state.0, 1, "s").map_err(|e| format!("the sender's channel: {e}"))?;
    let dc2 = wait_channel(&state.0, 2, "s").map_err(|e| format!("the other's channel: {e}"))?;
    state
        .0
        .rt
        .block_on(async { dc1.send_text("ping".to_string()).await })
        .map_err(estr)?;
    state
        .0
        .rt
        .block_on(async { dc2.send_text("pong".to_string()).await })
        .map_err(estr)?;
    log("selftest: the channel passes sends both ways");
    mic_start(state.clone()).map_err(|e| format!("the microphone: {e}"))?;
    for (id, side) in [(1u64, "the offerer"), (2u64, "the answerer")] {
        wait_audio(&state.0, id).map_err(|e| format!("decoded sound at {side}: {e}"))?;
    }
    log("selftest: both microphones reached the other's mixing buffer");
    pc_volume(state.clone(), 1, 0.5)?;
    pc_volume(state.clone(), 2, 0.5)?;
    for (id, side) in [(1u64, "the offerer"), (2u64, "the answerer")] {
        let gain = state.0.conn(id)?.gain();
        if (gain - 0.5).abs() > 1e-4 {
            return Err(format!("{side} did not take the volume ({gain})"));
        }
    }
    log("selftest: volumes applied");
    block(state, pc_close(state.clone(), 1))?;
    block(state, pc_close(state.clone(), 2))?;
    wait_gone(&state.0, &[1, 2]).map_err(|e| format!("teardown: {e}"))?;
    mic_stop(state.clone())?;
    log("selftest: every connection down, the microphone given back");
    Ok(())
}
