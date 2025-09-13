# 🎵 Spotify Sync Playback Across Multiple Users (Jam)

This project allows multiple users to join a shared room and listen to Spotify tracks **in sync**.  
It uses a **Rust backend (Warp and Tokio)** and a **React frontend**, with **WebSockets** to broadcast live playback state between connected clients.

---

## Purpose

The goals of this **v1** implementation are:

- Gain a deeper understanding of **Rust** by building a real-world backend service.
- Learn the fundamentals of **WebSockets**, including connection lifecycle and bidirectional communication.
- Explore the underlying **HTTP protocol** and how HTTP/1.1 requests can be upgraded to persistent WebSocket connections.
- Build a practical application that demonstrates how WebSockets can be applied to synchronize state across multiple clients.
- Establish a foundation for exploring distributed systems:
  - Highlight architectural limitations of a fully **stateful backend**, where playback state is stored in memory and restricts scalability.
  - Prepare for **v2**, which will introduce **Redis** as a pub/sub system for managing rooms (or topics). This will enable the application to become **stateless**, offload state management, and scale horizontally.
  - Experiment with deploying a stateless version to cloud platforms such as **AWS App Runner** or **Elastic Beanstalk**.



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
