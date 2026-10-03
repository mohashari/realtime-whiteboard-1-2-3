pub mod model;
pub mod routes;
pub mod state;
pub mod static_files;
pub mod ws;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

use crate::state::AppState;

/// Construct the complete Axum web router configured with REST, WebSocket, and static asset routes.
pub fn create_app(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Web application & Static assets
        .route("/", get(static_files::index_handler))
        .route("/index.html", get(static_files::index_handler))
        .route("/room/:room_id", get(static_files::index_handler))
        .route("/static/style.css", get(static_files::css_handler))
        .route("/static/app.js", get(static_files::js_handler))
        // Realtime WebSocket endpoint
        .route("/ws/:room_id", get(ws::ws_handler))
        // REST API
        .route("/api/health", get(routes::health_handler))
        .route("/api/rooms", get(routes::list_rooms_handler))
        .route("/api/rooms/:room_id/elements", get(routes::get_room_elements_handler))
        .route("/api/rooms/:room_id/export", get(routes::export_room_handler))
        .route("/api/rooms/:room_id/import", post(routes::import_room_handler))
        .route("/api/rooms/:room_id/clear", post(routes::clear_room_handler))
        .layer(cors)
        .fallback(static_files::fallback_handler)
        .with_state(state)
}
