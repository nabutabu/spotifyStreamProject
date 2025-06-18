use crate::{ws, Client, Clients, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use warp::{http::StatusCode, reply::json, ws::Message, Reply};
use base64::{engine::general_purpose, Engine as _};
use warp::http::{Response, Uri, header};

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

#[derive(Debug, Deserialize)]
pub struct AuthCodeQuery {
    code: String,
    state: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: String,
    scope: String,
}

#[derive(Debug)]
enum MyCustomError {
    HttpError,
    BadRequest,
    SpotifyTokenError,
    // ...
}
impl warp::reject::Reject for MyCustomError {}

pub async fn callback(query: AuthCodeQuery) -> Result<impl Reply> {
    println!("Received code: {}", query.code);

    authenticate(&query.code, "https://127.0.0.1:443/callback")
        .await?;

    println!("Authentication successful, redirecting...");

    Ok(StatusCode::OK)
}

async fn authenticate(code: &str, redirect_uri: &str) -> Result<impl warp::Reply> {
    let client_id = std::env::var("33761d48be7b443485a146820010cfc7").unwrap();
    let client_secret = std::env::var("bd8f159bf0a1435ab4aa21ad09a52cdd").unwrap();
    let credentials = general_purpose::STANDARD.encode(format!("{}:{}", client_id, client_secret));

    let http_client = reqwest::Client::new();

    let res = http_client
        .post("https://accounts.spotify.com/api/token")
        .header("Authorization", format!("Basic {}", credentials))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|_| warp::reject::custom(MyCustomError::HttpError))?;

    let token_data = res.json::<TokenResponse>().await
        .map_err(|_| warp::reject::custom(MyCustomError::HttpError))?;

    // Build redirect response with Set-Cookie header
    let redirect_uri = Uri::builder()
        .scheme("https")
        .path_and_query("/room")
        .build()
        .unwrap();

    let redirect_response = Response::builder()
        .status(303) // See Other
        .header(header::LOCATION, redirect_uri.to_string())
        .header(
            header::SET_COOKIE,
            format!(
                "access_token={}; HttpOnly; Secure; SameSite=Strict; Path=/",
                token_data.access_token
            )
        )
        .body("")
        .unwrap();

    Ok(redirect_response)
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