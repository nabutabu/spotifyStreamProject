use crate::{ws, Client, Clients, Room, Rooms, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use warp::{http::StatusCode, reply::json, ws::Message, Reply};
use base64::{engine::general_purpose, Engine as _};
use warp::http::{Response, Uri, HeaderValue, header};
use cookie::Cookie;
use serde_json::Value;
use chrono::Utc;
use std::{time::Duration};
use crate::repository::PlaybackState;
use std::sync::Arc;
use crate::repository::{RoomManager, WebSocketMessage};

#[derive(Deserialize, Debug)]
pub struct RegisterRequest {
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
    spotify_id: String
}

#[derive(Deserialize, Debug)]
pub struct Event {
    topic: String,
    user_id: Option<String>,
    message: WebSocketMessage,
}

#[derive(Deserialize, Debug)]
pub struct MediaIncomingRequest {
    user_id: String,
    topic: Option<String>,
    timestamp: u64,
    array: Vec<u8>
}

#[derive(Serialize, Debug)]
pub struct MediaOutgoingRequest {
    user_id: String,
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

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
}

#[derive(Debug)]
struct HttpError;
impl warp::reject::Reject for HttpError {}


pub async fn callback(query: AuthCodeQuery) -> Result<impl Reply> {
    println!("Received code: {}", query.code);

    let token_data = 
    authenticate(&query.code, "https://127.0.0.1/api/callback")
        .await?;

    println!("Authentication successful, redirecting...");

    let redirect_uri = Uri::builder()
        .path_and_query("/Home")
        .build()
        .unwrap();
    
    let mut response = Response::builder()
        .status(303)
        .header(header::LOCATION, redirect_uri.to_string());

    let headers = response
        .headers_mut()
        .expect("Failed to get headers from builder");
    
    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "access_token={}; HttpOnly; Secure; SameSite=Strict; Path=/",
            token_data.access_token
        )).unwrap(),
    );

    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_static("isAuthenticated=true; Secure; SameSite=Strict; Path=/"),
    );

    Ok(response
        .body("")
        .unwrap())
}

async fn authenticate(code: &str, redirect_uri: &str) -> Result<TokenResponse> {
    let client_id = "33761d48be7b443485a146820010cfc7";
    let client_secret = "bd8f159bf0a1435ab4aa21ad09a52cdd";
    let credentials = general_purpose::STANDARD.encode(format!("{}:{}", client_id, client_secret));

    let http_client = reqwest::Client::new();

    println!("Sending POST request to Spotify API...");

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
        .map_err(|_| warp::reject::custom(HttpError))?;

    let token_data = res.json::<TokenResponse>().await
    .map_err(|_| warp::reject::custom(HttpError))?;

    Ok(token_data)
}


pub async fn publish_handler(body: Event, clients: Clients, room_manager: Arc<RoomManager>) -> Result<impl Reply> {
    println!("publish_handler: {}", body.topic);
    // clients
    //     .read()
    //     .await
    //     .iter()
    //     .filter(|(_, client)| match body.user_id.clone() {
    //         Some(v) => client.user_id == v, // if body.user_id is not None, filter by user_id
    //         None => true, // if body.user_id is None, do not filter by user_id and send to ALL clients
    //     })
    //     .filter(|(_, client)| client.topics.contains(&body.topic))
    //     .for_each(|(_, client)| {
    //         if let Some(sender) = &client.sender { // check if sender is not None and bind the value of client.sender to sender
    //             let _ = sender.send(Ok(Message::text(body.message.clone())));
    //         }
    //     });

    match room_manager.broadcast_to_room(&body.topic, body.message).await {
        Ok(()) => {
            // Broadcast was successful
            let response = ApiResponse {
                success: true,
                data: Some("Message broadcast successfully".to_string()),
                message: None,
            };
            return Ok(warp::reply::json(&response));
        }
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to broadcast to room: {}", e)),
            };
            return Ok(warp::reply::json(&response));
        }
    }

    let response = ApiResponse {
        success: true,
        data: Some("Message broadcast successfully".to_string()),
        message: None,
    };

    Ok(warp::reply::json(&response))
}

pub async fn register_handler(body: RegisterRequest, clients: Clients, room_manager: Arc<RoomManager>, headers: header::HeaderMap) -> Result<impl Reply> {
    println!("register_handler: {}", body.topic);

    let new_room_id = Uuid::new_v4().as_simple().to_string();
    // Client.user_id = body.user_id;

    let cookies = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let access_token = cookies
        .split(';')
        .find_map(|s| {
            let cookie = Cookie::parse(s.trim()).ok()?;
            if cookie.name() == "access_token" {
                Some(cookie.value().to_string())
            } else {
                None
            }
        });

    let access_token = match access_token {
        Some(token) => token,
        None => {
            println!("Access token not found in cookies");
            return Ok(json(&RegisterResponse {
                url: "Unauthorized".to_string(),
                spotify_id: "Unauthorized".to_string(),
            }));
        }
    };

    // Get Spotify user ID
    let http_client = reqwest::Client::new();

    println!("Sending GET request to Spotify API...");

    let spotify_res = http_client
        .get("https://api.spotify.com/v1/me")
        .bearer_auth(access_token.clone())
        .send()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    // TODO: Spotify will send "EMPTY_RESPONSE" when no music has been playing for a while, handle that case

    let json_body: Value = spotify_res
        .json()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    // Extract user ID from the Spotify response
    let user_id = json_body
        .get("id")
        .and_then(Value::as_str)
        .map(|s| s.to_string());

    println!("Spotify user ID: {:?}", user_id);

    if user_id.is_none() {
        println!("Spotify user ID not found in response");
        return Ok(json(&RegisterResponse {
                url: "Unauthorized".to_string(),
                spotify_id: "Unauthorized".to_string(),
            }));
    }

    let new_client = register_client(
        new_room_id.clone(), 
        user_id.clone().expect("Reason"),
        body.topic.clone(), 
        clients.clone()
    ).await;

    // check if topic name already exists in Rooms
    // if rooms.read().await.contains_key(&body.topic) {
    //     // host does not change, just return the existing room
    //     let mut existing_room = rooms.read().await.get(&body.topic).cloned();
    //     // Add the new client to the existing room
    //     if let Some(ref mut room) = existing_room {
    //         room.clients.push(new_client.clone());
    //         rooms.write().await.insert(body.topic.clone(), room.clone());
    //     } 

    //     return Ok(json(&RegisterResponse {
    //         url: format!("wss://127.0.0.1:443/ws/{}", existing_room.unwrap().id),
    //         spotify_id: user_id.clone().expect("REASON"),
    // }));
    // }
    
    let room = match room_manager.create_room(&new_room_id, &user_id.clone().expect("REASON")).await {
        Ok(room) => room,
        Err(e) => {
            let response = ApiResponse::<()> {
                success: false,
                data: None,
                message: Some(format!("Failed to create room: {}", e)),
            };
            return Ok(warp::reply::json(&response));
        }
    };


    // let new_room = Room {
    //     id: new_room_id.clone(),
    //     clients: vec![],
    //     host: new_client.clone(),
    //     name: body.topic.clone(), // Default room name, can be changed later
    //     host_access_token: access_token.clone(),
    //     last_playback_state: None,
    // };

    // spawn_room_polling(new_room_id.clone(), rooms.clone(), clients.clone());

    // rooms.write().await.insert(new_room_id.clone(), new_room);

    Ok(json(&RegisterResponse {
        url: format!("wss://127.0.0.1/ws/{}", new_room_id.clone()),
        spotify_id: user_id.clone().expect("REASON"),
    }))
}

/**
* Registers a new client with a unique ID, user ID, and topic.
* Inserts the client into the shared clients map.
* Returns the newly created client.
* # Arguments
* * `id` - A unique identifier for the client.
* * `user_id` - Spotify user ID of the client.
* * `topic` - The topic the client is interested in.
* * `clients` - A shared map of clients, protected by a read-write lock.
*/
async fn register_client(room_id: String, user_id: String, topic: String, clients: Clients) -> Client {
    let new_client = Client {
        user_id: user_id.clone(),
        topics: vec![topic],
        sender: None,
    };
    clients.write().await.insert(
        room_id.clone(),
        new_client.clone(),
    );

    return new_client.clone();
}

pub async fn unregister_handler(id: String, clients: Clients) -> Result<impl Reply> {
    println!("unregister_handler: {}", id);
    clients.write().await.remove(&id);
    Ok(StatusCode::OK)
}

pub async fn ws_handler(id: String, ws: warp::ws::Ws, clients: Clients, room_manager: Arc<RoomManager>) -> Result<impl Reply> {
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
        user_id: body.user_id.clone(), 
        timestamp: body.timestamp,
        array: body.array.clone(),
    };

    clients
        .read()
        .await
        .iter()
        .filter(|(_, client)| client.user_id != body.user_id.clone()) // filter out the sender
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


/******************* SPOTIFY FUNCTIONS **********************/
pub async fn get_user_profile(headers: header::HeaderMap) -> Result<Box<dyn Reply>> {
    println!("/get_user_profile");
    let cookies = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let access_token = cookies
        .split(';')
        .find_map(|s| {
            let cookie = Cookie::parse(s.trim()).ok()?;
            if cookie.name() == "access_token" {
                Some(cookie.value().to_string())
            } else {
                None
            }
        });

    let access_token = match access_token {
        Some(token) => token,
        None => {
            let res = warp::reply::with_status("Unauthorized", StatusCode::UNAUTHORIZED);
            return Ok(Box::new(res));
        }
    };

    let http_client = reqwest::Client::new();

    println!("Sending GET request to v1/me/...");

    let spotify_res = http_client
        .get("https://api.spotify.com/v1/me/")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    // TODO: Spotify will send "EMPTY_RESPONSE" when no music has been playing for a while, handle that case

    let json_body: Value = spotify_res
        .json()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    Ok(Box::new(json(&json_body)))
}

pub async fn current_song(headers: header::HeaderMap) -> Result<Box<dyn Reply>> {
    let cookies = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let access_token = cookies
        .split(';')
        .find_map(|s| {
            let cookie = Cookie::parse(s.trim()).ok()?;
            if cookie.name() == "access_token" {
                Some(cookie.value().to_string())
            } else {
                None
            }
        });

    let access_token = match access_token {
        Some(token) => token,
        None => {
            let res = warp::reply::with_status("Unauthorized", StatusCode::UNAUTHORIZED);
            return Ok(Box::new(res));
        }
    };

    let http_client = reqwest::Client::new();

    println!("Sending GET request to /v1/me/player/currently-playing...");

    let spotify_res = http_client
        .get("https://api.spotify.com/v1/me/player/currently-playing")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    // TODO: Spotify will send "EMPTY_RESPONSE" when no music has been playing for a while, handle that case

    let json_body: Value = spotify_res
        .json()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    Ok(Box::new(json(&json_body)))
}

pub async fn get_queue(headers: header::HeaderMap) -> Result<Box<dyn Reply>> {
    let cookies = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let access_token = cookies
        .split(';')
        .find_map(|s| {
            let cookie = Cookie::parse(s.trim()).ok()?;
            if cookie.name() == "access_token" {
                Some(cookie.value().to_string())
            } else {
                None
            }
        });

    let access_token = match access_token {
        Some(token) => token,
        None => {
            let res = warp::reply::with_status("Unauthorized", StatusCode::UNAUTHORIZED);
            return Ok(Box::new(res));
        }
    };

    let http_client = reqwest::Client::new();

    println!("Sending GET request to /v1/me/player/queue...");

    let spotify_res = http_client
        .get("https://api.spotify.com/v1/me/player/queue")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    // TODO: Spotify will send "EMPTY_RESPONSE" when no music has been playing for a while, handle that case

    let json_body: Value = spotify_res
        .json()
        .await
        .map_err(|_| warp::reject::custom(HttpError))?;

    Ok(Box::new(json(&json_body)))
}

pub fn spawn_room_polling(room_id: String, rooms: Rooms, clients: Clients) {
    println!("/spawn_room_polling");
    tokio::spawn(async move {
        let client = reqwest::Client::new();

        loop {
            {
                let mut rooms_guard = rooms.write().await;

                if let Some(room) = rooms_guard.get_mut(&room_id) {
                    if let Some(new_state) = poll_host_state(&client, &room.host_access_token).await {
                        let changed = room
                            .last_playback_state
                            .as_ref()
                            .map(|old| old.track_uri != new_state.track_uri
                                || old.position_ms / 5000 != new_state.position_ms / 5000 // bucket to 5s chunks
                                || old.queue != new_state.queue)
                            .unwrap_or(true);

                        if changed {
                            room.last_playback_state = Some(new_state.clone());
                            broadcast_state(&room.id, new_state, &clients).await;
                        }
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn poll_host_state(http: &reqwest::Client, token: &str) -> Option<PlaybackState> {
    println!("/poll_host_state");
    let playback = http
        .get("https://api.spotify.com/v1/me/player")
        .bearer_auth(token)
        .send()
        .await.ok()?
        .json::<serde_json::Value>()
        .await.ok()?;

    let queue_resp = http
        .get("https://api.spotify.com/v1/me/player/queue")
        .bearer_auth(token)
        .send()
        .await.ok()?
        .json::<serde_json::Value>()
        .await.ok()?;

    let track_uri = playback["item"]["uri"].as_str()?.to_string();
    let progress_ms = playback["progress_ms"].as_u64().unwrap_or(0);

    let queue: Vec<String> = queue_resp["queue"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|t| t["uri"].as_str().map(|s| s.to_string()))
        .collect();

    Some(PlaybackState {
        track_uri,
        position_ms: progress_ms,
        queue,
        timestamp: Utc::now().timestamp_millis() as u128,
    })
}

async fn broadcast_state(room_id: &str, state: PlaybackState, clients: &Clients) -> Result<impl Reply> {
    println!("broadcast_state {}", room_id.clone());
    let msg = serde_json::to_string(&state).unwrap();

    clients
        .read()
        .await
        .iter()
        .for_each(|(_, client)| {
            if let Some(sender) = &client.sender { // check if sender is not None and bind the value of client.sender to sender
                let _ = sender.send(Ok(Message::text(msg.clone())));
            }   
        });

    Ok(StatusCode::OK)
}

