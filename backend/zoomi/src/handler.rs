use crate::{ws, Client, Clients, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use warp::{http::StatusCode, reply::json, ws::Message, Reply};
#[derive(Deserialize, Debug)]
pub struct RegisterRequest {
    user_id: usize,
    topic: String,
}

#[derive(Deserialize)]
pub struct TopicActionRequest {
    topic: String,
    client_id: String,
}


#[derive(Serialize, Debug)]
pub struct RegisterResponse {
    url: String,
}

#[derive(Deserialize, Debug)]
pub struct Event {
    topic: String,
    user_id: Option<usize>,
    message: String,
}

#[derive(Deserialize, Debug)]
pub struct MediaIncomingRequest {
    user_id: usize,
    topic: Option<String>,
    timestamp: u64,
    array: Vec<u8>
}

#[derive(Serialize, Debug)]
pub struct MediaOutgoingRequest {
    user_id: usize,
    timestamp: u64,
    array: Vec<u8>
}

pub async fn publish_handler(body: Event, clients: Clients) -> Result<impl Reply> {
    println!("publish_handler: {}", body.topic);
    clients
        .read()
        .await
        .iter()
        .filter(|(_, client)| match body.user_id {
            Some(v) => client.user_id == v, // if body.user_id is not None, filter by user_id
            None => true, // if body.user_id is None, do not filter by user_id and send to ALL clients
        })
        .filter(|(_, client)| client.topics.contains(&body.topic))
        .for_each(|(_, client)| {
            if let Some(sender) = &client.sender { // check if sender is not None and bind the value of client.sender to sender
                let _ = sender.send(Ok(Message::text(body.message.clone())));
            }
        });

    Ok(StatusCode::OK)
}

pub async fn register_handler(body: RegisterRequest, clients: Clients) -> Result<impl Reply> {
    println!("register_handler: {}", body.user_id);
    let user_id = body.user_id;
    let topic = body.topic; // Capture the entry topic
    let uuid = Uuid::new_v4().as_simple().to_string();

    register_client(uuid.clone(), user_id, topic, clients).await; // Pass the entry topic
    Ok(json(&RegisterResponse {
        url: format!("ws://127.0.0.1:8000/ws/{}", uuid),
    }))
}

async fn register_client(id: String, user_id: usize, topic: String, clients: Clients) {
    clients.write().await.insert(
        id,
        Client {
            user_id,
            topics: vec![topic],
            sender: None,
        },
    );
}

pub async fn unregister_handler(id: String, clients: Clients) -> Result<impl Reply> {
    println!("unregister_handler: {}", id);
    clients.write().await.remove(&id);
    Ok(StatusCode::OK)
}

pub async fn ws_handler(ws: warp::ws::Ws, id: String, clients: Clients) -> Result<impl Reply> {
    println!("ws_handler: {}", id);
    let client = clients.read().await.get(&id).cloned();
    match client {
        Some(c) => Ok(ws.on_upgrade(move |socket| ws::client_connection(socket, id, clients, c))),
        None => Err(warp::reject::not_found()),
    }
}

pub async fn health_handler() -> Result<impl Reply> {
    println!("health_handler called");
    Ok(StatusCode::OK)
}

pub async fn add_topic(body: TopicActionRequest, clients: Clients) -> Result<impl Reply> {
    println!("add_topic: {}", body.topic);
    let mut clients_write = clients.write().await;
    if let Some(client) = clients_write.get_mut(&body.client_id) {
        client.topics.push(body.topic);
    }
    Ok(warp::reply::with_status("Added topic successfully", StatusCode::OK))
}

pub async fn remove_topic(body: TopicActionRequest, clients: Clients) -> Result<impl Reply> {
    println!("remove_topic: {}", body.topic);
    let mut clients_write = clients.write().await;
    if let Some(client) = clients_write.get_mut(&body.client_id) {
        client.topics.retain(|t| t != &body.topic);
    }
    Ok(warp::reply::with_status("Removed topic successfully", StatusCode::OK))
}

pub async fn broadcast(body: MediaIncomingRequest, clients: Clients) -> Result<impl Reply> {
    println!("publish_handler: {:?}", body.topic);

    let response = MediaOutgoingRequest {
        user_id: body.user_id, 
        timestamp: body.timestamp,
        array: body.array.clone(),
    };

    clients
        .read()
        .await
        .iter()
        .filter(|(_, client)| client.user_id != body.user_id)
        .filter(|(_, client)| match &body.topic {
            Some(t) => client.topics.contains(t) , // if body.user_id is not None, filter by user_id
            None => true, // if body.user_id is None, do not filter by user_id and send to ALL clients
        })
        .for_each(|(_, client)| {
            if let Some(sender) = &client.sender { // check if sender is not None and bind the value of client.sender to sender

                if let Ok(json_payload) = serde_json::to_string(&response) {
                    let _ = sender.send(Ok(Message::text(json_payload)));
                }
            }
        });

    Ok(StatusCode::OK)
}