use crate::{Client, Clients};
use futures::{FutureExt, StreamExt};
use serde::Deserialize;
use serde_json::from_str;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use warp::ws::{WebSocket};
use crate::repository::{RoomManager, WebSocketMessage, PlaybackState};
use serde_json::Value;
use std::sync::Arc;


#[derive(Deserialize, Debug)]
pub struct TopicsRequest {
    topics: Vec<String>,
}

pub async fn client_connection(ws: WebSocket, user_id: String, room_id: String, clients: Clients, mut client: Client, room_manager: Arc<RoomManager>) {
    println!("{} connecting", user_id);
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();

    println!("{} here", user_id);

    let client_rcv = UnboundedReceiverStream::new(client_rcv);
    tokio::task::spawn(client_rcv.forward(client_ws_sender).map(|result| {
        if let Err(e) = result {
            eprintln!("error sending websocket msg: {}", e);
        }
    }));

    println!("made new Unboundedreceiverstream and added it to tokio task");

    client.sender = Some(client_sender.clone());
    clients.write().await.insert(user_id.clone(), client.clone());

    room_manager.register_client(client.user_id.clone(), room_id.clone(), client_sender).await;

    println!("{} connected", user_id);

    // this is the main loop which receives messages from the client
    while let Some(result) = client_ws_rcv.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("error receiving ws message for id: {}): {}", user_id.clone(), e);
                break;
            }
        };
        if let Ok(text) = msg.to_str() {
            handle_websocket_message(&user_id, text, &clients, room_manager.clone()).await;
        }
    }

    clients.write().await.remove(&user_id);
    println!("{} disconnected", user_id);
}


/// Handles incoming WebSocket messages, dispatching based on message type.
pub async fn handle_websocket_message(user_id: &str, msg: &str, clients: &Clients, room_manager: Arc<RoomManager>) -> Option<WebSocketMessage> {
    println!("handle_websocket_message: {}", msg);
    // Parse the incoming message as JSON
    let parsed: Value = match serde_json::from_str(msg) {
        Ok(val) => val,
        Err(e) => {
            eprintln!("Failed to parse message as JSON: {}", e);
            return None;
        }
    };

    // Extract the "type" field to determine the message kind
    let msg_type = parsed.get("action")?.as_str()?;

    println!("Message type: {}", msg_type);

    match msg_type {
        "PING" => {
            // Handle PING message
            Some(WebSocketMessage::Pong)
        }
        "MEDIA_INCOMING" => {
            // Handle Media Incoming message
            println!("MEDIA_INCOMING received");
            Some(WebSocketMessage::Ping)
        }
        "MEDIA_OUTGOING" => {
            // Handle Media Outgoing message
            println!("MEDIA_OUTGOING received");
            Some(WebSocketMessage::Ping)
        },
        "UPDATE_PLAYBACK" => {
            // Handle Update Playback
            // we received a PlayBackUpdate message, extract room_id and playback_state
            let playback_update: Value = match parsed.get("playback_update") {
                Some(val) => val.clone(),
                None => {
                    println!("No playback_update field in UPDATE_PLAYBACK message");
                    return Some(WebSocketMessage::Error {
                        message: "No playback_update field".to_string()
                    });
                }
            };
            let room_id = match playback_update.get("room_id") {
                Some(val) => val.as_str().unwrap_or("").to_string(),
                None => {
                    println!("No room_id field in playback_update");
                    return Some(WebSocketMessage::Error {
                        message: "No room_id field".to_string()
                    });
                }
            };
            let playback_state_value = match playback_update.get("playback_state") {
                Some(val) => val.clone(),
                None => {
                    println!("No playback_state field in playback_update");
                    return Some(WebSocketMessage::Error {
                        message: "No playback_state field".to_string()
                    });
                }
            };

            // Deserialize the playback_state Value into PlaybackState struct
            let playback_state: PlaybackState = match serde_json::from_value(playback_state_value) {
                Ok(state) => state,
                Err(e) => {
                    println!("Failed to deserialize playback_state: {}", e);
                    return Some(WebSocketMessage::Error {
                        message: format!("Failed to deserialize playback_state: {}", e)
                    });
                }
            };

            println!("UPDATE_PLAYBACK received for room_id: {}, playback_state: {:?}", room_id, playback_state);
            // call room_manager.update_playback_state
            match room_manager.update_playback_state(&room_id, playback_state).await {
                Ok(_) => {
                    println!("Successfully updated playback state for room: {}", room_id);
                    return Some(WebSocketMessage::Pong);
                }
                Err(e) => {
                    println!("Failed to update playback state: {}", e);
                    return Some(WebSocketMessage::Error {
                        message: format!("Failed to update playback state: {}", e)
                    });
                }
            }

            Some(WebSocketMessage::Ping)
        },
        "TOPIC_REQUEST" => {
            // Handle Topic Request message
            let topics_req: TopicsRequest = match from_str(&msg) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("error while parsing message to topics request: {}", e);
                    return None;
                }
            };

            println!("TOPIC_REQUEST received: {:?}", topics_req);
            Some(WebSocketMessage::Ping)
        },



        // Add more message types as needed
        _ => {
            // Unknown message type
            None
        }
    }
}