use crate::{Client, Clients};
use futures::{FutureExt, StreamExt};
use serde::Deserialize;
use serde_json::from_str;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use warp::ws::{Message, WebSocket};
use crate::repository::{RoomManager, WebSocketMessage};
use serde_json::Value;

#[derive(Deserialize, Debug)]
pub struct TopicsRequest {
    topics: Vec<String>,
}

pub async fn client_connection(ws: WebSocket, id: String, clients: Clients, mut client: Client) {
    println!("{} connecting", id);
    let (client_ws_sender, mut client_ws_rcv) = ws.split();
    let (client_sender, client_rcv) = mpsc::unbounded_channel();

    println!("{} here", id);

    let client_rcv = UnboundedReceiverStream::new(client_rcv);
    tokio::task::spawn(client_rcv.forward(client_ws_sender).map(|result| {
        if let Err(e) = result {
            eprintln!("error sending websocket msg: {}", e);
        }
    }));

    println!("made new Unboundedreceiverstream and added it to tokio task");

    client.sender = Some(client_sender);
    clients.write().await.insert(id.clone(), client);

    println!("{} connected", id); 

    while let Some(result) = client_ws_rcv.next().await {
        let msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("error receiving ws message for id: {}): {}", id.clone(), e);
                break;
            }
        };
        client_msg(&id, msg, &clients).await;
    }

    clients.write().await.remove(&id);
    println!("{} disconnected", id);
}

async fn client_msg(id: &str, msg: Message, clients: &Clients) {
    println!("received message from {}: {:?}", id, msg);
    let message = match msg.to_str() {
        Ok(v) => v,
        Err(_) => return,
    };

    handle_websocket_message(message).await;
}

/// Handles incoming WebSocket messages, dispatching based on message type.
pub async fn handle_websocket_message(msg: &str) -> Option<WebSocketMessage> {
    println!("handle_websocket_message: {}", msg);
    // Parse the incoming message as JSON
    let parsed: Value = match serde_json::from_str(msg) {
        Ok(val) => val,
        Err(_) => return None,
    };

    // Extract the "type" field to determine the message kind
    let msg_type = parsed.get("type")?.as_str()?;

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
            // Handle Update Playback message
            println!("UPDATE_PLAYBACK received");
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