# 🎵 Spotify Sync Playback Across Multiple Users (Jam)

This project allows multiple users to join a shared room and listen to Spotify tracks **in sync**.  
It uses a **Rust backend (Warp and Tokio)** and a **React frontend**, with **WebSockets** to broadcast live playback state between connected clients.

---

## Purpose
The purpose of this v1 of the project is as follows:
- Understand how Rust works
- Understand how WebSockets work
- Understand the underlying HTTP protocols and upgrading of the HTTP TCP to a WebSocket
- Make a project that makes a practical use of WebSockets
- Understand why architecture needs to change and why there is a need for Redis/Kafka:
    - Sets the stage for v2 of the project where I will try to use Redis to maintain rooms (or topics) in order to understand how Redis works
    - My current architecture has a bottle-neck as it cannot scale up. The application is stateful as it maintains state of where the host playback is
    - The next step is to offload this state maintainence to Redis and make the app stateless and deployable through AWS App Runner or Elastic Beanstalk


## Features
- Create and join rooms using unique IDs.
- WebSocket-based communication between backend and frontend.
- Support for broadcasting different message types (e.g., `PlaybackState` vs. text messages).
- Secure WebSocket connection over **WSS** via Nginx reverse proxy.


## Architecture

### Backend (Rust + Warp)
- Exposes REST API endpoints under `/api/`.
- Provides a WebSocket endpoint at `/ws/:room_id`.
- Maintains an in-memory `Clients` map that tracks connected users.
- Broadcasts **`PlaybackState`** updates when a user’s playback changes:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub track_uri: String,
    pub position_ms: u64,
    pub queue: Vec<String>,
    pub timestamp: u128, // unix millis when captured
}
