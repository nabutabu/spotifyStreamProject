use std::sync::Arc;
use warp::{Reply, Rejection};
use serde::{Deserialize, Serialize};
use crate::repository::room_repository::{RoomManager, PlaybackState, WebSocketMessage};
use tokio::sync::broadcast;

type SharedRoomManager = Arc<RoomManager>;

// Request/Response structs
#[derive(Deserialize)]
pub struct CreateRoomRequest {
    pub room_id: String,
    pub host_client_id: String,
}

#[derive(Deserialize)]
pub struct JoinRoomRequest {
    pub client_id: String,
}

#[derive(Deserialize)]
pub struct LeaveRoomRequest {
    pub client_id: String,
}

#[derive(Deserialize)]
pub struct RegisterClientRequest {
    pub client_id: String,
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
}

// Room management handlers
pub async fn create_room_handler(
    request: CreateRoomRequest,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    match room_manager.create_room(&request.room_id, &request.host_client_id).await {
        Ok(room) => {
            let response = ApiResponse {
                success: true,
                data: Some(room),
                message: Some("Room created successfully".to_string()),
            };
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to create room: {}", e)),
            };
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn join_room_handler(
    room_id: String,
    request: JoinRoomRequest,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    match room_manager.join_room(&room_id, &request.client_id).await {
        Ok(_) => {
            let response = ApiResponse {
                success: true,
                data: Some(format!("Joined room {}", room_id)),
                message: None,
            };
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to join room: {}", e)),
            };
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn leave_room_handler(
    room_id: String,
    request: LeaveRoomRequest,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    match room_manager.leave_room(&room_id, &request.client_id).await {
        Ok(_) => {
            let response = ApiResponse {
                success: true,
                data: Some(format!("Left room {}", room_id)),
                message: None,
            };
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to leave room: {}", e)),
            };
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn update_playback_handler(
    room_id: String,
    playback_state: PlaybackState,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    match room_manager.update_playback_state(&room_id, playback_state).await {
        Ok(_) => {
            let response = ApiResponse {
                success: true,
                data: Some("Playback updated successfully".to_string()),
                message: None,
            };
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to update playback: {}", e)),
            };
            Ok(warp::reply::json(&response))
        }
    }
}

pub async fn get_room_handler(
    room_id: String,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    match room_manager.get_room(&room_id).await {
        Ok(Some(room)) => {
            let response = ApiResponse {
                success: true,
                data: Some(room),
                message: None,
            };
            Ok(warp::reply::json(&response))
        }
        Ok(None) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some("Room not found".to_string()),
            };
            Ok(warp::reply::json(&response))
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to get room: {}", e)),
            };
            Ok(warp::reply::json(&response))
        }
    }
}

// WebSocket handler (updated to work with RoomManager)
pub async fn ws_handler(
    ws: warp::ws::Ws,
    client_id: String,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    Ok(ws.on_upgrade(move |socket| handle_websocket(socket, client_id, room_manager)))
}

async fn handle_websocket(
    ws: warp::ws::WebSocket,
    client_id: String,
    room_manager: SharedRoomManager,
) {
    let (ws_sender, mut ws_receiver) = ws.split();
    let (tx, mut rx) = broadcast::channel::<WebSocketMessage>(100);

    // Register client with RoomManager
    room_manager.register_client(client_id.clone(), tx.clone()).await;

    // Handle incoming WebSocket messages
    let room_manager_clone = room_manager.clone();
    let client_id_clone = client_id.clone();
    let incoming_task = tokio::spawn(async move {
        while let Some(result) = ws_receiver.next().await {
            match result {
                Ok(msg) => {
                    // Handle incoming WebSocket messages here
                    // You can parse room join/leave requests, etc.
                    println!("Received message from {}: {:?}", client_id_clone, msg);
                }
                Err(e) => {
                    eprintln!("WebSocket error for {}: {}", client_id_clone, e);
                    break;
                }
            }
        }
    });

    // Handle outgoing messages to WebSocket
    let outgoing_task = tokio::spawn(async move {
        use futures_util::SinkExt;
        use warp::ws::Message;

        while let Ok(message) = rx.recv().await {
            let json = serde_json::to_string(&message).unwrap();
            let ws_message = Message::text(json);
            
            if ws_sender.send(ws_message).await.is_err() {
                break;
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = incoming_task => {},
        _ = outgoing_task => {},
    }

    // Cleanup: unregister client
    room_manager.unregister_client(&client_id).await;
    println!("Client {} disconnected", client_id);
}

// Updated register handler to work with RoomManager
pub async fn register_handler(
    request: RegisterClientRequest,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    // For HTTP registration, you might want to create a placeholder broadcast channel
    let (tx, _rx) = broadcast::channel::<WebSocketMessage>(100);
    
    room_manager.register_client(request.client_id.clone(), tx).await;
    
    let response = ApiResponse {
        success: true,
        data: Some(format!("Client {} registered", request.client_id)),
        message: None,
    };
    Ok(warp::reply::json(&response))
}

pub async fn unregister_handler(
    client_id: String,
    room_manager: SharedRoomManager,
) -> Result<impl Reply, Rejection> {
    room_manager.unregister_client(&client_id).await;
    
    let response = ApiResponse {
        success: true,
        data: Some(format!("Client {} unregistered", client_id)),
        message: None,
    };
    Ok(warp::reply::json(&response))
}

// Health check (unchanged)
pub async fn health_handler() -> Result<impl Reply, Rejection> {
    Ok(warp::reply::with_status("OK", warp::http::StatusCode::OK))
}