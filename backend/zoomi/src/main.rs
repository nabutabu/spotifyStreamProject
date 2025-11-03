use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use handler::TopicActionRequest;
use tokio::sync::{mpsc, RwLock};
use warp::{ws::Message, Filter, Rejection};
use crate::handler::{add_topic, remove_topic};
use crate::repository::PlaybackState;
use crate::repository::RoomManager;

mod handler;
mod ws;
mod repository;

type Result<T> = std::result::Result<T, Rejection>; // declaring the type of a sent Result
type Clients = Arc<RwLock<HashMap<String, Client>>>; // declaring the type of a Client Map
type Rooms = Arc<RwLock<HashMap<String, Room>>>; // declaring the type of a Room Map
type SharedRoomManager = Arc<RoomManager>;


#[derive(Debug, Clone)]
pub struct Client {
    pub user_id: String,
    pub topics: Vec<String>,
    pub sender: Option<mpsc::UnboundedSender<std::result::Result<Message, warp::Error>>>,
}

#[derive(Debug, Clone)]
pub struct Room {
    pub id: String,
    pub clients: Vec<Client>,
    pub host: Client,

    // Spotify host info
    pub host_access_token: String,
    pub last_playback_state: Option<PlaybackState>,

    // UI properties
    pub name: String,
}

#[tokio::main]
async fn main() {
    let clients: Clients = Arc::new(RwLock::new(HashMap::new())); // initialize using the created type
    let rooms: Rooms = Arc::new(RwLock::new(HashMap::new())); // initialize the rooms

    // Create the RoomManager instead of clients HashMap
    let room_manager = match RoomManager::new("redis://redis:6379") {
        Ok(manager) => Arc::new(manager),
        Err(e) => {
            eprintln!("Failed to create RoomManager: {}", e);
            return;
        }
    };

    let health_route = warp::path!("health").and_then(handler::health_handler); // add the health route which just returns 200 OK everytime, checks if the server is running

    // the register route adds a new client to this server room
    let register = warp::path("register");
    let register_routes = register
        .and(warp::post())
        .and(warp::body::json())
        .and(with_clients(clients.clone())) // inject the shared state of Clients into the handler
        .and(with_room_manager(room_manager.clone())) // inject the shared state of Rooms into the handler
        .and(warp::header::headers_cloned())
        .and_then(handler::register_handler)
        .or(register
            .and(warp::delete())
            .and(warp::path::param())
            .and(with_clients(clients.clone()))
            .and_then(handler::unregister_handler));

    let publish = warp::path!("publish")
        .and(warp::body::json())
        .and(with_clients(clients.clone()))
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::publish_handler);

    let ws_route = warp::path!("ws" / String / String)
        .and(warp::ws())
        .and(with_clients(clients.clone()))
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::ws_handler);

    let clients_for_add = clients.clone();
    let add_topic_route = warp::post()
        .and(warp::path("add_topic"))
        .and(warp::body::json::<TopicActionRequest>())
        .and(warp::any().map(move || clients_for_add.clone()))
        .and_then(add_topic);

    let clients_for_remove = clients.clone();
    let remove_topic_route = warp::delete()
        .and(warp::path("remove_topic"))
        .and(warp::body::json::<TopicActionRequest>())
        .and(warp::any().map(move || clients_for_remove.clone()))
        .and_then(remove_topic);

    let broadcast_route = warp::post()
        .and(warp::path("broadcast"))
        .and(warp::body::json())
        .and(with_clients(clients.clone()))
        .and_then(handler::broadcast);

    let callback_route = warp::path("callback")
        .and(warp::get())
        .and(warp::query::<handler::AuthCodeQuery>())
        .and_then(handler::callback);

    // SPOTIFY ROUTES
    let get_user_profile = warp::path("get_user_profile")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and_then(handler::get_user_profile);

    let current_song_route = warp::path("current_song")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and_then(handler::current_song);

    let get_queue_route = warp::path("get_queue")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and_then(handler::get_queue);

    let start_playback_route = warp::path("start_playback")
        .and(warp::body::json::<PlaybackState>())
        .and(warp::post())
        .and(warp::header::headers_cloned())
        .and_then(handler::start_playback);

    let routes = health_route
        .or(register_routes)
        .or(ws_route)
        .or(publish)
        .or(add_topic_route)
        .or(remove_topic_route)
        .or(broadcast_route)
        .or(callback_route)
        .or(current_song_route)
        .or(get_queue_route)
        .with(warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET", "POST", "OPTIONS"])
            .allow_headers(vec!["Content-Type"])
    );

    // Setup graceful shutdown
    let room_manager_shutdown = room_manager.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.expect("Failed to listen for ctrl+c");
        println!("Shutting down gracefully...");
        room_manager_shutdown.shutdown().await;
    });

    println!("Listening on 127.0.0.1:8000");
    warp::serve(routes).run(([0, 0, 0, 0], 8000)).await;
}

fn with_clients(clients: Clients) -> impl Filter<Extract = (Clients,), Error = Infallible> + Clone {
    warp::any().map(move || clients.clone())
}

fn with_rooms(rooms: Rooms) -> impl Filter<Extract = (Rooms,), Error = Infallible> + Clone {
    warp::any().map(move || rooms.clone())
}

// Helper function to inject RoomManager into handlers
fn with_room_manager(room_manager: SharedRoomManager) -> impl Filter<Extract = (SharedRoomManager,), Error = Infallible> + Clone {
    warp::any().map(move || room_manager.clone())
}