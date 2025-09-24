use std::convert::Infallible;
use std::sync::Arc;
use warp::{Filter, Rejection};
use crate::repository::room_repository::RoomManager;

mod handler;
mod ws;
mod repository;

type Result<T> = std::result::Result<T, Rejection>;
type SharedRoomManager = Arc<RoomManager>;

#[tokio::main]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    // Create the RoomManager instead of clients HashMap
    let room_manager = Arc::new(RoomManager::new("redis://localhost:6379")?);

    let health_route = warp::path!("health").and_then(handler::health_handler);

    // Register routes - now use RoomManager instead of clients
    let register = warp::path("register");
    let register_routes = register
        .and(warp::post())
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::register_handler)
        .or(register
            .and(warp::delete())
            .and(warp::path::param())
            .and(with_room_manager(room_manager.clone()))
            .and_then(handler::unregister_handler));

    let publish = warp::path!("publish")
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::publish_handler);

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(warp::path::param())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::ws_handler);

    let add_topic_route = warp::post()
        .and(warp::path("add_topic"))
        .and(with_room_manager(room_manager.clone()))
        .and_then(add_topic);
    
    let remove_topic_route = warp::delete()
        .and(warp::path("remove_topic"))
        .and(with_room_manager(room_manager.clone()))
        .and_then(remove_topic);

    let broadcast_route = warp::post()
        .and(warp::path("broadcast"))
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::broadcast);

    // Room management routes (NEW!)
    let create_room_route = warp::post()
        .and(warp::path("rooms"))
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::create_room_handler);

    let join_room_route = warp::post()
        .and(warp::path!("rooms" / String / "join"))
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::join_room_handler);

    let leave_room_route = warp::post()
        .and(warp::path!("rooms" / String / "leave"))
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::leave_room_handler);

    let update_playback_route = warp::post()
        .and(warp::path!("rooms" / String / "playback"))
        .and(warp::body::json())
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::update_playback_handler);

    let get_room_route = warp::get()
        .and(warp::path!("rooms" / String))
        .and(with_room_manager(room_manager.clone()))
        .and_then(handler::get_room_handler);

    // Spotify routes (unchanged)
    let callback_route = warp::path("callback")
        .and(warp::get())
        .and(warp::query::<handler::AuthCodeQuery>())
        .and_then(handler::callback);
    
    let current_song_route = warp::path("current_song")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and_then(handler::current_song);
    
    let get_queue_route = warp::path("get_queue")
        .and(warp::get())
        .and(warp::header::headers_cloned())
        .and_then(handler::get_queue);

    let routes = health_route
        .or(register_routes)
        .or(ws_route)
        .or(publish)
        .or(add_topic_route)
        .or(remove_topic_route)
        .or(broadcast_route)
        .or(create_room_route)      
        .or(join_room_route)        
        .or(leave_room_route)       
        .or(update_playback_route)  
        .or(get_room_route)         
        .or(callback_route)
        .or(current_song_route)
        .or(get_queue_route)
        .with(warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET", "POST", "DELETE", "OPTIONS"])
            .allow_headers(vec!["Content-Type", "Authorization"])
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
    
    Ok(())
}

// Helper function to inject RoomManager into handlers
fn with_room_manager(room_manager: SharedRoomManager) -> impl Filter<Extract = (SharedRoomManager,), Error = Infallible> + Clone {
    warp::any().map(move || room_manager.clone())
}