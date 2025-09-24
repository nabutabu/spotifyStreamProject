use redis::{Client, RedisError, RedisResult};
use redis::aio::{Connection as AsyncConnection, PubSub};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, HashMap};
use std::sync::Arc;
use tokio::sync::{RwLock, mpsc};
use tokio::task::JoinHandle;
use warp::ws::Message;
use futures_util::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    pub track_uri: String,
    pub position_ms: u64,
    pub queue: Vec<String>,
    pub timestamp: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    pub id: String,
    pub host_client_id: Option<String>,
    pub clients: HashSet<String>,
    pub playback_state: Option<PlaybackState>,
}

// WebSocket message types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WebSocketMessage {
    PlaybackUpdate { 
        room_id: String, 
        playback_state: PlaybackState 
    },
    RoomJoined { 
        room_id: String 
    },
    RoomLeft { 
        room_id: String 
    },
    Error {
        message: String
    },
}

// Client connection info for Warp WebSocket
#[derive(Debug, Clone)]
pub struct ClientConnection {
    pub client_id: String,
    pub room_id: Option<String>,
    pub sender: mpsc::UnboundedSender<Result<Message, warp::Error>>,
}

// Room task handle and clients list
#[derive(Debug)]
pub struct RoomTask {
    pub task_handle: JoinHandle<()>,
    pub clients: Arc<RwLock<HashSet<String>>>,
}

pub struct RoomRepository {
    client: Client,
}

impl RoomRepository {
    pub fn new(redis_url: &str) -> RedisResult<Self> {
        let client = Client::open(redis_url)?;
        Ok(Self { client })
    }

    async fn get_connection(&self) -> RedisResult<AsyncConnection> {
        self.client.get_async_connection().await
    }

    fn room_key(&self, room_id: &str) -> String {
        format!("room:{}", room_id)
    }

    fn room_updates_key(&self, room_id: &str) -> String {
        format!("room:{}:updates", room_id)
    }

    pub async fn create_room(&self, room_id: &str, host_client_id: &str) -> RedisResult<Room> {
        use redis::AsyncCommands;
        let mut conn = self.get_connection().await?;
        
        let mut clients = HashSet::new();
        clients.insert(host_client_id.to_string());

        let room = Room {
            id: room_id.to_string(),
            host_client_id: Some(host_client_id.to_string()),
            clients,
            playback_state: None,
        };

        let room_json = serde_json::to_string(&room)
            .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Serialization error")))?;

        let _: () = conn.set(&self.room_key(room_id), room_json).await?;
        Ok(room)
    }

    pub async fn get_room(&self, room_id: &str) -> RedisResult<Option<Room>> {
        use redis::AsyncCommands;
        let mut conn = self.get_connection().await?;
        let room_json: Option<String> = conn.get(&self.room_key(room_id)).await?;

        match room_json {
            Some(json) => {
                let room: Room = serde_json::from_str(&json)
                    .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Deserialization error")))?;
                Ok(Some(room))
            }
            None => Ok(None),
        }
    }

    pub async fn update_playback_state(&self, room_id: &str, playback_state: PlaybackState) -> RedisResult<()> {
        use redis::AsyncCommands;
        let mut room = self.get_room(room_id).await?
            .ok_or_else(|| RedisError::from((redis::ErrorKind::TypeError, "Room not found")))?;

        room.playback_state = Some(playback_state.clone());
        
        let room_json = serde_json::to_string(&room)
            .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Serialization error")))?;

        let mut conn = self.get_connection().await?;
        let _: () = conn.set(&self.room_key(room_id), room_json).await?;
        
        // Publish update to Redis pub/sub
        let update_json = serde_json::to_string(&playback_state)
            .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Serialization error")))?;
        let _: () = conn.publish(&self.room_updates_key(room_id), update_json).await?;
        
        Ok(())
    }

    pub async fn add_client_to_room(&self, room_id: &str, client_id: &str) -> RedisResult<()> {
        use redis::AsyncCommands;
        let mut room = self.get_room(room_id).await?
            .ok_or_else(|| RedisError::from((redis::ErrorKind::TypeError, "Room not found")))?;

        room.clients.insert(client_id.to_string());
        
        let room_json = serde_json::to_string(&room)
            .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Serialization error")))?;

        let mut conn = self.get_connection().await?;
        let _: () = conn.set(&self.room_key(room_id), room_json).await?;
        Ok(())
    }

    pub async fn remove_client_from_room(&self, room_id: &str, client_id: &str) -> RedisResult<()> {
        use redis::AsyncCommands;
        let mut room = self.get_room(room_id).await?
            .ok_or_else(|| RedisError::from((redis::ErrorKind::TypeError, "Room not found")))?;

        room.clients.remove(client_id);
        
        let room_json = serde_json::to_string(&room)
            .map_err(|_e| RedisError::from((redis::ErrorKind::TypeError, "Serialization error")))?;

        let mut conn = self.get_connection().await?;
        let _: () = conn.set(&self.room_key(room_id), room_json).await?;
        Ok(())
    }

    pub async fn delete_room(&self, room_id: &str) -> RedisResult<()> {
        use redis::AsyncCommands;
        let mut conn = self.get_connection().await?;
        let _: () = conn.del(&self.room_key(room_id)).await?;
        Ok(())
    }
}

pub struct RoomManager {
    repository: Arc<RoomRepository>,
    room_tasks: Arc<RwLock<HashMap<String, RoomTask>>>,
    client_connections: Arc<RwLock<HashMap<String, ClientConnection>>>,
    redis_client: redis::Client,
}

impl RoomManager {
    pub fn new(redis_url: &str) -> RedisResult<Self> {
        let repository = Arc::new(RoomRepository::new(redis_url)?);
        let redis_client = redis::Client::open(redis_url)?;
        
        Ok(Self {
            repository,
            room_tasks: Arc::new(RwLock::new(HashMap::new())),
            client_connections: Arc::new(RwLock::new(HashMap::new())),
            redis_client,
        })
    }

    // Register a WebSocket client (Warp style)
    pub async fn register_client(
        &self, 
        client_id: String, 
        sender: mpsc::UnboundedSender<Result<Message, warp::Error>>
    ) {
        let connection = ClientConnection { 
            client_id: client_id.clone(), 
            room_id: None,
            sender 
        };
        self.client_connections.write().await.insert(client_id, connection);
    }

    // Unregister a WebSocket client
    pub async fn unregister_client(&self, client_id: &str) {
        if let Some(client) = self.client_connections.write().await.remove(client_id) {
            // Remove from room if they were in one
            if let Some(room_id) = &client.room_id {
                let _ = self.leave_room(room_id, client_id).await;
            }
        }
    }

    // Create room and start monitoring task
    pub async fn create_room(&self, room_id: &str, host_client_id: &str) -> RedisResult<Room> {
        // Create room in Redis
        let room = self.repository.create_room(room_id, host_client_id).await?;

        // Create client list for this room
        let room_clients = Arc::new(RwLock::new(HashSet::new()));
        room_clients.write().await.insert(host_client_id.to_string());

        // Start the Redis pub/sub monitoring task
        let task_handle = self.start_room_monitoring_task(
            room_id.to_string(), 
            room_clients.clone()
        ).await?;

        // Store the task
        let room_task = RoomTask {
            task_handle,
            clients: room_clients,
        };
        
        self.room_tasks.write().await.insert(room_id.to_string(), room_task);

        // Update client's room association
        if let Some(mut client) = self.client_connections.write().await.get_mut(host_client_id) {
            client.room_id = Some(room_id.to_string());
        }

        Ok(room)
    }

    // Start monitoring task for a room
    async fn start_room_monitoring_task(
        &self,
        room_id: String,
        room_clients: Arc<RwLock<HashSet<String>>>,
    ) -> RedisResult<JoinHandle<()>> {
        let pubsub_conn = self.redis_client.get_async_connection().await
            .map_err(|_e| RedisError::from((redis::ErrorKind::IoError, "Failed to get async connection")))?;
        
        let room_updates_channel = format!("room:{}:updates", room_id);
        let room_id_clone = room_id.clone();
        let client_connections = self.client_connections.clone();

        let task = tokio::spawn(async move {
            // Subscribe to the room's updates channel
            let mut pubsub = pubsub_conn.into_pubsub();
            
            if let Err(e) = pubsub.subscribe(&room_updates_channel).await {
                eprintln!("Failed to subscribe to {}: {}", room_updates_channel, e);
                return;
            }

            println!("Started monitoring room: {}", room_id_clone);

            // Listen for messages
            let mut stream = pubsub.on_message();
            while let Some(msg) = stream.next().await {
                if let Ok(payload) = msg.get_payload::<String>() {
                    // Parse the playback state update
                    if let Ok(playback_state) = serde_json::from_str::<PlaybackState>(&payload) {
                        let ws_message = WebSocketMessage::PlaybackUpdate {
                            room_id: room_id_clone.clone(),
                            playback_state,
                        };

                        // Get current room clients
                        let current_clients = room_clients.read().await.clone();
                        
                        // Send to all clients in this room
                        let connections = client_connections.read().await;
                        for client_id in current_clients {
                            if let Some(client) = connections.get(&client_id) {
                                let message_json = serde_json::to_string(&ws_message).unwrap_or_default();
                                let warp_message = Message::text(message_json);
                                
                                if let Err(_) = client.sender.send(Ok(warp_message)) {
                                    eprintln!("Failed to send message to client: {}", client_id);
                                }
                            }
                        }
                    }
                }
            }

            println!("Room monitoring task ended for: {}", room_id_clone);
        });

        Ok(task)
    }

    // Join a client to a room
    pub async fn join_room(&self, room_id: &str, client_id: &str) -> RedisResult<()> {
        // Add client to room in Redis
        self.repository.add_client_to_room(room_id, client_id).await?;

        // Update room task's client list
        if let Some(room_task) = self.room_tasks.read().await.get(room_id) {
            room_task.clients.write().await.insert(client_id.to_string());
        }

        // Update client's room association
        if let Some(mut client) = self.client_connections.write().await.get_mut(client_id) {
            client.room_id = Some(room_id.to_string());
            
            // Send join confirmation
            let join_message = WebSocketMessage::RoomJoined {
                room_id: room_id.to_string(),
            };
            let message_json = serde_json::to_string(&join_message).unwrap_or_default();
            let warp_message = Message::text(message_json);
            let _ = client.sender.send(Ok(warp_message));
        }

        Ok(())
    }

    // Remove client from room
    pub async fn leave_room(&self, room_id: &str, client_id: &str) -> RedisResult<()> {
        self.repository.remove_client_from_room(room_id, client_id).await?;

        // Update room task's client list
        if let Some(room_task) = self.room_tasks.read().await.get(room_id) {
            room_task.clients.write().await.remove(client_id);
        }

        // Update client's room association
        if let Some(mut client) = self.client_connections.write().await.get_mut(client_id) {
            client.room_id = None;
            
            // Send leave confirmation
            let leave_message = WebSocketMessage::RoomLeft {
                room_id: room_id.to_string(),
            };
            let message_json = serde_json::to_string(&leave_message).unwrap_or_default();
            let warp_message = Message::text(message_json);
            let _ = client.sender.send(Ok(warp_message));
        }

        Ok(())
    }

    // Delete room and stop its monitoring task
    pub async fn delete_room(&self, room_id: &str) -> RedisResult<()> {
        // Stop the monitoring task
        if let Some(room_task) = self.room_tasks.write().await.remove(room_id) {
            room_task.task_handle.abort();
            
            // Remove room association from all clients in the room
            let clients_in_room = room_task.clients.read().await.clone();
            let mut connections = self.client_connections.write().await;
            for client_id in clients_in_room {
                if let Some(client) = connections.get_mut(&client_id) {
                    client.room_id = None;
                }
            }
        }

        // Delete from Redis
        self.repository.delete_room(room_id).await?;
        Ok(())
    }

    // Update playback state (this will trigger the monitoring task)
    pub async fn update_playback_state(&self, room_id: &str, playback_state: PlaybackState) -> RedisResult<()> {
        self.repository.update_playback_state(room_id, playback_state).await
    }

    // Get room info
    pub async fn get_room(&self, room_id: &str) -> RedisResult<Option<Room>> {
        self.repository.get_room(room_id).await
    }

    // Get all client connections (for compatibility with existing code)
    pub async fn get_clients(&self) -> HashMap<String, ClientConnection> {
        self.client_connections.read().await.clone()
    }

    // Send message to specific client
    pub async fn send_to_client(&self, client_id: &str, message: WebSocketMessage) -> Result<(), String> {
        let connections = self.client_connections.read().await;
        if let Some(client) = connections.get(client_id) {
            let message_json = serde_json::to_string(&message)
                .map_err(|e| format!("Serialization error: {}", e))?;
            let warp_message = Message::text(message_json);
            
            client.sender.send(Ok(warp_message))
                .map_err(|_| "Failed to send message".to_string())?;
            Ok(())
        } else {
            Err("Client not found".to_string())
        }
    }

    // Broadcast message to all clients in a room
    pub async fn broadcast_to_room(&self, room_id: &str, message: WebSocketMessage) -> Result<(), String> {
        if let Some(room_task) = self.room_tasks.read().await.get(room_id) {
            let clients_in_room = room_task.clients.read().await.clone();
            let connections = self.client_connections.read().await;
            
            let message_json = serde_json::to_string(&message)
                .map_err(|e| format!("Serialization error: {}", e))?;
            let warp_message = Message::text(message_json);
            
            for client_id in clients_in_room {
                if let Some(client) = connections.get(&client_id) {
                    let _ = client.sender.send(Ok(warp_message.clone()));
                }
            }
            Ok(())
        } else {
            Err("Room not found".to_string())
        }
    }

    // Cleanup all tasks (call on shutdown)
    pub async fn shutdown(&self) {
        let mut tasks = self.room_tasks.write().await;
        for (room_id, room_task) in tasks.drain() {
            println!("Shutting down task for room: {}", room_id);
            room_task.task_handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, Duration};

    #[tokio::test]
    async fn test_room_manager_operations() {
        let manager = RoomManager::new("redis://127.0.0.1:6379").unwrap();

        // Create a room
        let room = manager.create_room("test_room", "client1").await.unwrap();
        assert_eq!(room.id, "test_room");

        // Simulate a playback update
        let playback = PlaybackState {
            track_uri: "spotify:track:123".to_string(),
            position_ms: 30000,
            queue: vec!["spotify:track:456".to_string()],
            timestamp: 1234567890,
        };

        manager.update_playback_state("test_room", playback).await.unwrap();

        // Give some time for the async operations
        sleep(Duration::from_millis(100)).await;

        // Cleanup
        manager.delete_room("test_room").await.unwrap();
        manager.shutdown().await;
    }
}