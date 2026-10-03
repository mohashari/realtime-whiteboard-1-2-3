use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::{
    model::{HealthStatus, RoomExport, RoomSummary, ServerMessage, WhiteboardElement},
    state::AppState,
};

/// Health status check.
pub async fn health_handler(State(state): State<AppState>) -> Json<HealthStatus> {
    Json(state.get_health().await)
}

/// List summaries of all active whiteboard rooms.
pub async fn list_rooms_handler(State(state): State<AppState>) -> Json<Vec<RoomSummary>> {
    Json(state.get_room_summaries().await)
}

/// Get all whiteboard elements for a given room.
pub async fn get_room_elements_handler(
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<WhiteboardElement>>, StatusCode> {
    match state.get_room_elements(&room_id).await {
        Some(elements) => Ok(Json(elements)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// Export room snapshot as JSON.
pub async fn export_room_handler(
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<RoomExport>, StatusCode> {
    match state.export_room(&room_id).await {
        Some(export) => Ok(Json(export)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

/// Import an array of elements into a room, updating the board for all active users.
pub async fn import_room_handler(
    Path(room_id): Path<String>,
    State(state): State<AppState>,
    Json(elements): Json<Vec<WhiteboardElement>>,
) -> impl IntoResponse {
    let count = elements.len();
    state.import_room(&room_id, elements.clone()).await;

    // Notify room participants of the new state
    let (tx, _) = state.get_or_create_room(&room_id).await;
    let _ = tx.send(ServerMessage::Init {
        your_id: "system".to_string(),
        room_id: room_id.clone(),
        elements,
        users: Vec::new(),
    });

    (
        StatusCode::OK,
        Json(json!({
            "status": "success",
            "room_id": room_id,
            "imported_elements": count
        })),
    )
}

/// Erase all whiteboard elements in a room.
pub async fn clear_room_handler(
    Path(room_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    state.clear_board(&room_id).await;
    let (tx, _) = state.get_or_create_room(&room_id).await;
    let _ = tx.send(ServerMessage::BoardCleared);

    (
        StatusCode::OK,
        Json(json!({
            "status": "cleared",
            "room_id": room_id
        })),
    )
}
