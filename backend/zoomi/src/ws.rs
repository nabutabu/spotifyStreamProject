use futures::{FutureExt, StreamExt};
use crate::repository::room_repository::{RoomManager, WebSocketMessage};
use serde::Deserialize;
use serde_json::from_str;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use warp::ws::{Message, WebSocket};

#[derive(Deserialize, Debug)]
pub struct TopicsRequest {
    topics: Vec<String>,
}

type SharedRoomManager = Arc<RoomManager>;

pub async fn client_connection(
    ws: WebSocket, 
    client_id: String, 
    room_manager: SharedRoomManager
) {
    let (mut client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();

    // Register client with RoomManager
    room_manager.register_client(client_id.clone(), client_sender).await;

    // Forward messages from room manager to WebSocket
    let client_rcv = UnboundedReceiverStream::new(client_rcv);
    tokio::task::spawn(client_rcv.forward(client_ws_sender).map(|result| {
        if let Err(e) = result {
            eprintln!("error sending websocket msg: {}", e);
        }
    }));

    println!("{} connected", client_id);

    // Handle incoming WebSocket messages
    while let Some(result) = client_ws_rcv.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("error receiving ws message for id: {}): {}", client_id, e);
                break;
            }
        };
        
        // Process the message
        if let Err(e) = handle_client_message(&client_id, msg, &room_manager).await {
            eprintln!("Error handling message from {}: {}", client_id, e);
        }
    }

    // Cleanup when client disconnects
    room_manager.unregister_client(&client_id).await;
    println!("{} disconnected", client_id);
}

// Handle incoming WebSocket messages
async fn handle_client_message(
    client_id: &str,
    msg: Message,
    room_manager: &RoomManager,
) -> Result<(), String> {
    if msg.is_text() {
        let text = msg.to_str().map_err(|_| "Invalid UTF-8")?;
        
        // Try to parse as JSON command
        match serde_json::from_str::<IncomingMessage>(text) {
            Ok(incoming_msg) => {
                match incoming_msg {
                    IncomingMessage::JoinRoom { room_id } => {
                        if let Err(e) = room_manager.join_room(&room_id, client_id).await {
                            let error_msg = WebSocketMessage::Error {
                                message: format!("Failed to join room {}: {}", room_id, e),
                            };
                            room_manager.send_to_client(client_id, error_msg).await?;
                        }
                    }
                    IncomingMessage::LeaveRoom { room_id } => {
                        if let Err(e) = room_manager.leave_room(&room_id, client_id).await {
                            let error_msg = WebSocketMessage::Error {
                                message: format!("Failed to leave room {}: {}", room_id, e),
                            };
                            room_manager.send_to_client(client_id, error_msg).await?;
                        }
                    }
                    IncomingMessage::UpdatePlayback { 
                        room_id, 
                        track_uri, 
                        position_ms, 
                        queue 
                    } => {
                        let playback_state = crate::repository::PlaybackState {
                            track_uri,
                            position_ms,
                            queue,
                            timestamp: chrono::Utc::now().timestamp_millis() as u128,
                        };
                        
                        if let Err(e) = room_manager.update_playback_state(&room_id, playback_state).await {
                            let error_msg = WebSocketMessage::Error {
                                message: format!("Failed to update playback: {}", e),
                            };
                            room_manager.send_to_client(client_id, error_msg).await?;
                        }
                    }
                }
            }
            Err(_) => {
                // If it's not a structured command, you can handle it as a general message
                println!("Received text message from {}: {}", client_id, text);
            }
        }
    } else if msg.is_binary() {
        println!("Received binary message from {}", client_id);
    }
    
    Ok(())
}

async fn client_msg(id: &str, msg: Message, clients: &Clients) {
    println!("received message from {}: {:?}", id, msg);
    let message = match msg.to_str() {
        Ok(v) => v,
        Err(_) => return,
    };

    if message == "ping" || message == "ping\n" {
        return;
    }

    let topics_req: TopicsRequest = match from_str(&message) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error while parsing message to topics request: {}", e);
            return;
        }
    };

    let mut locked = clients.write().await;
    if let Some(v) = locked.get_mut(id) {
        v.topics = topics_req.topics;
    }
}