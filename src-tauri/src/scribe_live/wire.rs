//! Exactly one manual commit may be outstanding. The recorder retains the
//! next segment locally while we await its predecessor's acknowledgement.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    sync::oneshot,
    time::{interval, timeout, MissedTickBehavior},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, protocol::WebSocketConfig, Error as WsError, Message,
    },
    MaybeTlsStream, WebSocketStream,
};

pub(super) const ENDPOINT: &str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v3_live&audio_format=pcm_16000&commit_strategy=manual&include_timestamps=false";
const RATE: usize = 16_000;
const FRAME: usize = RATE / 10;
const SEGMENT: usize = RATE * 24;
const MIN_COMMIT: usize = RATE * 3 / 10;
pub(super) const MAX_PENDING: usize = RATE * 12;
pub(super) const CONNECT_WAIT: Duration = Duration::from_secs(6);
const ACK_WAIT: Duration = Duration::from_secs(6);
const WRITE_WAIT: Duration = Duration::from_secs(3);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub(super) type ReadAudio =
    Arc<dyn Fn(usize) -> Option<std::result::Result<Vec<f32>, ()>> + Send + Sync>;
pub(super) type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    MissingKey,
    Authentication,
    Quota,
    Connection,
    Timeout,
    Coverage,
    Provider,
}

impl Failure {
    pub(super) fn message(self) -> &'static str {
        match self {
            Self::MissingKey => "Add your ElevenLabs key in Settings → API Keys to use Scribe v3 Live.",
            Self::Authentication => "ElevenLabs could not authenticate this key. Check Settings → API Keys.",
            Self::Quota => "ElevenLabs reached a usage or rate limit. Check your ElevenLabs account or choose another model.",
            Self::Connection => "Could not connect to ElevenLabs. Check your connection or choose another model.",
            Self::Timeout => "Scribe v3 Live timed out. Try again or choose another model.",
            Self::Coverage => "Scribe v3 Live could not confirm the complete recording. Try again or choose another model.",
            Self::Provider => "Scribe v3 Live could not transcribe this recording. Try again or choose another model.",
        }
    }

    fn handshake(error: WsError) -> Self {
        match error {
            WsError::Http(response) => match response.status().as_u16() {
                401 | 403 => Self::Authentication,
                402 | 429 => Self::Quota,
                _ => Self::Connection,
            },
            _ => Self::Connection,
        }
    }
}

#[derive(Deserialize)]
struct Event {
    message_type: String,
    text: Option<String>,
    config: Option<Config>,
}

#[derive(Deserialize)]
struct Config {
    model_id: Option<String>,
    audio_format: Option<String>,
    sample_rate: Option<u32>,
}

impl Event {
    fn parse(message: Message) -> Result<Option<Self>> {
        match message {
            Message::Ping(_) | Message::Pong(_) => Ok(None),
            Message::Text(body) => {
                let event: Event = serde_json::from_str(&body).map_err(|_| Failure::Provider)?;
                match event.message_type.as_str() {
                    "session_started" | "committed_transcript" => Ok(Some(event)),
                    "partial_transcript" | "warning" => Ok(None),
                    "auth_error" | "unauthorized" => Err(Failure::Authentication),
                    "quota_exceeded"
                    | "rate_limited"
                    | "queue_overflow"
                    | "resource_exhausted"
                    | "session_time_limit_exceeded" => Err(Failure::Quota),
                    "commit_throttled" => Err(Failure::Coverage),
                    _ => Err(Failure::Provider),
                }
            }
            _ => Err(Failure::Connection),
        }
    }
}

async fn read_event(socket: &mut Socket) -> Result<Option<Event>> {
    let message = socket
        .next()
        .await
        .ok_or(Failure::Connection)?
        .map_err(|_| Failure::Connection)?;
    Event::parse(message)
}

async fn expect_event(socket: &mut Socket, expected: &str, wait: Duration) -> Result<Event> {
    timeout(wait, async {
        loop {
            if let Some(event) = read_event(socket).await? {
                return if event.message_type == expected {
                    Ok(event)
                } else {
                    Err(Failure::Coverage)
                };
            }
        }
    })
    .await
    .map_err(|_| Failure::Timeout)?
}

struct Stream {
    socket: Socket,
    offset: usize,
    uncommitted: usize,
    text: String,
}

impl Stream {
    async fn connect(endpoint: &str, key: &str) -> Result<Self> {
        let mut request = endpoint
            .into_client_request()
            .map_err(|_| Failure::Connection)?;
        let mut header: tokio_tungstenite::tungstenite::http::HeaderValue =
            key.parse().map_err(|_| Failure::Authentication)?;
        header.set_sensitive(true);
        request.headers_mut().insert("xi-api-key", header);
        let config = WebSocketConfig::default()
            .max_frame_size(Some(256 * 1024))
            .max_message_size(Some(256 * 1024));
        let (mut socket, _) = timeout(
            CONNECT_WAIT,
            connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| Failure::Timeout)?
        .map_err(Failure::handshake)?;
        let started = expect_event(&mut socket, "session_started", CONNECT_WAIT).await?;
        if started.config.is_some_and(|config| {
            config
                .model_id
                .as_deref()
                .is_some_and(|id| id != "scribe_v3_live")
                || config
                    .audio_format
                    .as_deref()
                    .is_some_and(|format| format != "pcm_16000")
                || config.sample_rate.is_some_and(|rate| rate != RATE as u32)
        }) {
            return Err(Failure::Coverage);
        }
        Ok(Self {
            socket,
            offset: 0,
            uncommitted: 0,
            text: String::new(),
        })
    }

    async fn send(&mut self, samples: &[f32], padding: usize, commit: bool) -> Result<()> {
        let mut bytes = Vec::with_capacity((samples.len() + padding) * 2);
        for sample in samples {
            let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            bytes.extend_from_slice(&pcm.to_le_bytes());
        }
        bytes.resize(bytes.len() + padding * 2, 0);
        let payload = json!({"message_type": "input_audio_chunk", "audio_base_64": STANDARD.encode(bytes), "sample_rate": RATE, "commit": commit});
        timeout(
            WRITE_WAIT,
            self.socket.send(Message::Text(payload.to_string().into())),
        )
        .await
        .map_err(|_| Failure::Timeout)?
        .map_err(|_| Failure::Connection)?;
        self.offset += samples.len();
        self.uncommitted += samples.len();
        if commit {
            let event = expect_event(&mut self.socket, "committed_transcript", ACK_WAIT).await?;
            let segment = event.text.ok_or(Failure::Coverage)?;
            if !segment.trim().is_empty() {
                if !self.text.is_empty() {
                    self.text.push(' ');
                }
                self.text.push_str(segment.trim());
            }
            self.uncommitted = 0;
        }
        Ok(())
    }

    async fn audio(&mut self, mut samples: &[f32], final_chunk: bool) -> Result<()> {
        if samples.len() > MAX_PENDING {
            return Err(Failure::Coverage);
        }
        while !samples.is_empty() {
            let len = samples.len().min(FRAME).min(SEGMENT - self.uncommitted);
            let (frame, rest) = samples.split_at(len);
            let total = self.uncommitted + len;
            let commit = total == SEGMENT || (final_chunk && rest.is_empty());
            let padding = if commit {
                MIN_COMMIT.saturating_sub(total)
            } else {
                0
            };
            self.send(frame, padding, commit).await?;
            samples = rest;
        }
        if final_chunk && self.uncommitted > 0 {
            self.send(&[], MIN_COMMIT.saturating_sub(self.uncommitted), true)
                .await?;
        }
        Ok(())
    }
}

pub(super) async fn run(
    endpoint: &str,
    key: &str,
    read: ReadAudio,
    mut finish: oneshot::Receiver<Vec<f32>>,
) -> Result<String> {
    let mut stream = Stream::connect(endpoint, key).await?;
    let mut tick = interval(Duration::from_millis(80));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            event = read_event(&mut stream.socket) => {
                // An unsolicited commit cannot be assigned to an exact sample range.
                if event?.is_some() { return Err(Failure::Coverage); }
            }
            recording = &mut finish => {
                let recording = recording.map_err(|_| Failure::Connection)?;
                let tail = recording.get(stream.offset..).ok_or(Failure::Coverage)?;
                stream.audio(tail, true).await?;
                return Ok(stream.text);
            }
            _ = tick.tick() => {
                let read = read.clone();
                let offset = stream.offset;
                let chunk = tokio::task::spawn_blocking(move || read(offset)).await.map_err(|_| Failure::Coverage)?;
                if let Some(chunk) = chunk {
                    stream.audio(&chunk.map_err(|_| Failure::Coverage)?, false).await?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scribe_live::{cancel, spawn_session, take_for_stop, LiveGate};
    use serde_json::Value;
    use std::time::Instant;
    use tokio::{net::TcpListener, sync::oneshot};
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    async fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://{}{}",
            listener.local_addr().unwrap(),
            &ENDPOINT["wss://api.elevenlabs.io".len()..]
        );
        (listener, endpoint)
    }

    async fn accept(listener: TcpListener) -> WebSocketStream<TcpStream> {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(tcp, |request: &Request, response: Response| {
            assert_eq!(request.headers()["xi-api-key"], "test-local");
            assert!(request
                .uri()
                .query()
                .unwrap()
                .contains("model_id=scribe_v3_live"));
            Ok(response)
        })
        .await
        .unwrap();
        event(&mut socket, json!({"message_type":"session_started","config":{"model_id":"scribe_v3_live","audio_format":"pcm_16000","sample_rate":16000}})).await;
        socket
    }

    async fn event(socket: &mut WebSocketStream<TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    async fn frame(socket: &mut WebSocketStream<TcpStream>) -> (Vec<u8>, bool) {
        let msg = timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        assert_eq!(value["message_type"], "input_audio_chunk");
        assert_eq!(value["sample_rate"], 16000);
        (
            STANDARD
                .decode(value["audio_base_64"].as_str().unwrap())
                .unwrap(),
            value["commit"].as_bool().unwrap(),
        )
    }

    // test_disposition: permanent. A release racing an earlier commit used to
    // be indistinguishable from the final acknowledgement in the provider probe.
    #[tokio::test]
    async fn release_during_commit_preserves_every_sample_and_repeated_segment() {
        let (listener, endpoint) = listener().await;
        let (pending, wait_pending) = oneshot::channel();
        let (release_ack, ack_allowed) = oneshot::channel();
        let reference: Vec<i16> = (0..SEGMENT * 2 + 1234)
            .map(|i| (i as i16).wrapping_mul(37) % 32000)
            .collect();
        let captured: Vec<f32> = reference
            .iter()
            .map(|n| *n as f32 / i16::MAX as f32)
            .collect();
        let during_hold = captured[..SEGMENT * 2].to_vec();
        let read: ReadAudio = Arc::new(move |offset| {
            let end = (offset + RATE * 8).min(during_hold.len());
            Some(Ok(during_hold[offset..end].to_vec()))
        });
        let (finish, rx) = oneshot::channel();
        let client = tokio::spawn(async move { run(&endpoint, "test-local", read, rx).await });
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            let mut wire_audio = Vec::new();
            let mut pending = Some(pending);
            let mut ack_allowed = Some(ack_allowed);
            for (index, text) in ["repeat", "repeat", "distinct ending"].iter().enumerate() {
                loop {
                    let (bytes, committed) = frame(&mut socket).await;
                    wire_audio.extend(
                        bytes
                            .chunks_exact(2)
                            .map(|v| i16::from_le_bytes([v[0], v[1]])),
                    );
                    if committed {
                        break;
                    }
                }
                if index == 1 {
                    pending.take().unwrap().send(()).unwrap();
                    ack_allowed.take().unwrap().await.unwrap();
                }
                event(
                    &mut socket,
                    json!({"message_type":"committed_transcript","text":text}),
                )
                .await;
            }
            wire_audio
        });
        timeout(Duration::from_secs(4), wait_pending)
            .await
            .unwrap()
            .unwrap();
        finish.send(captured).unwrap();
        release_ack.send(()).unwrap();
        assert_eq!(
            client.await.unwrap().unwrap(),
            "repeat repeat distinct ending"
        );
        let received = server.await.unwrap();
        assert_eq!(&received[..reference.len()], reference);
        assert_eq!(received.len(), SEGMENT * 2 + MIN_COMMIT);
        assert!(received[reference.len()..]
            .iter()
            .all(|&sample| sample == 0));
    }

    // test_disposition: permanent. A finalization handle must remain cancellable by operation ID.
    #[tokio::test]
    async fn cancel_pending_final_ack_closes_socket_without_touching_new_owner() {
        let (listener, endpoint) = listener().await;
        let (sent, pending) = oneshot::channel();
        let server = tokio::spawn(async move {
            let mut socket = accept(listener).await;
            while !frame(&mut socket).await.1 {}
            sent.send(()).unwrap();
            let end = timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap();
            assert!(matches!(
                end,
                None | Some(Err(_)) | Some(Ok(Message::Close(_)))
            ));
        });
        let first = u64::MAX - 100;
        let second = first - 1;
        spawn_session(
            first,
            LiveGate::Open,
            Instant::now(),
            move |finish| async move { run(&endpoint, "test-local", Arc::new(|_| None), finish).await },
        );
        let finalizing = tokio::spawn(take_for_stop(first).unwrap().finish(vec![0.1; 5000]));
        timeout(Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap();
        spawn_session(
            second,
            LiveGate::Open,
            Instant::now(),
            |finish| async move {
                assert_eq!(finish.await.unwrap().len(), 1);
                Ok("new owner".into())
            },
        );
        cancel(first);
        assert!(finalizing.await.unwrap().is_err());
        server.await.unwrap();
        assert_eq!(
            take_for_stop(second)
                .unwrap()
                .finish(vec![0.1])
                .await
                .unwrap(),
            "new owner"
        );
        cancel(second);
    }

    // test_disposition: permanent. Wire errors discard interim text and raw provider details.
    #[tokio::test]
    async fn quota_and_missing_ack_return_bounded_content_free_errors() {
        for (send_error, expected) in [(true, Failure::Quota), (false, Failure::Timeout)] {
            let (listener, endpoint) = listener().await;
            let server = tokio::spawn(async move {
                let mut socket = accept(listener).await;
                while !frame(&mut socket).await.1 {}
                event(
                    &mut socket,
                    json!({"message_type":"partial_transcript","text":"private partial"}),
                )
                .await;
                if send_error {
                    event(
                        &mut socket,
                        json!({"message_type":"quota_exceeded","error":"private billing detail"}),
                    )
                    .await;
                } else {
                    let _ = socket.next().await;
                }
            });
            let (finish, rx) = oneshot::channel();
            finish.send(vec![0.2; 300]).unwrap();
            let result = timeout(
                ACK_WAIT + Duration::from_secs(3),
                run(&endpoint, "test-local", Arc::new(|_| None), rx),
            )
            .await
            .unwrap();
            assert_eq!(result, Err(expected));
            assert!(!expected.message().contains("private"));
            server.await.unwrap();
        }
    }
}
