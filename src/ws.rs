use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::{
    model::{ClientMessage, ServerMessage, UserInfo},
    state::AppState,
};

/// HTTP upgrade handler to establish WebSocket collaboration session.
pub async fn ws_handler(
    Path(room_id): Path<String>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, room_id, state))
}

/// Manage bidirectional WebSocket communication for a connected peer.
async fn handle_socket(socket: WebSocket, room_id: String, state: AppState) {
    let peer_id = format!("user_{}", Uuid::new_v4().simple());
    let (tx, mut rx) = state.get_or_create_room(&room_id).await;
    let (mut ws_sender, mut ws_receiver) = socket.split();

    info!(peer_id = %peer_id, room = %room_id, "WebSocket peer connected");

    // Default peer info until Join payload is received
    let mut current_user = UserInfo {
        id: peer_id.clone(),
        name: format!("Guest-{}", &peer_id[peer_id.len() - 4..]),
        color: "#3b82f6".to_string(),
        cursor: None,
    };

    // Forward broadcast messages from room channel to this client's WebSocket sink
    let peer_id_for_send = peer_id.clone();
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            // Avoid echoing local cursor moves back to self
            if let ServerMessage::CursorMoved { ref user_id, .. } = msg {
                if user_id == &peer_id_for_send {
                    continue;
                }
            }

            match serde_json::to_string(&msg) {
                Ok(json) => {
                    if let Err(e) = ws_sender.send(Message::Text(json)).await {
                        debug!(error = %e, "Failed to send WebSocket message to peer; connection closing");
                        break;
                    }
                }
                Err(e) => {
                    error!(error = %e, "Failed to serialize ServerMessage to JSON");
                }
            }
        }
    });

    // Process incoming messages from this client
    let state_for_recv = state.clone();
    let room_id_for_recv = room_id.clone();
    let tx_for_recv = tx.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(result) = ws_receiver.next().await {
            match result {
                Ok(Message::Text(text)) => {
                    match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(client_msg) => match client_msg {
                            ClientMessage::Join {
                                user_id,
                                user_name,
                                user_color,
                            } => {
                                if let Some(id) = user_id {
                                    if !id.trim().is_empty() {
                                        current_user.id = id;
                                    }
                                }
                                current_user.name = user_name;
                                current_user.color = user_color;

                                let (elements, users) = state_for_recv
                                    .join_peer(&room_id_for_recv, current_user.clone())
                                    .await;

                                // Send initial state snapshot specifically to this joining user
                                let init_msg = ServerMessage::Init {
                                    your_id: current_user.id.clone(),
                                    room_id: room_id_for_recv.clone(),
                                    elements,
                                    users,
                                };
                                let _ = tx_for_recv.send(init_msg);

                                // Broadcast join notice to all room participants
                                let _ = tx_for_recv.send(ServerMessage::UserJoined {
                                    user: current_user.clone(),
                                });
                            }

                            ClientMessage::AddElement { element } => {
                                state_for_recv
                                    .add_element(&room_id_for_recv, element.clone())
                                    .await;
                                let _ = tx_for_recv.send(ServerMessage::ElementAdded { element });
                            }

                            ClientMessage::UpdateElement { element } => {
                                state_for_recv
                                    .update_element(&room_id_for_recv, element.clone())
                                    .await;
                                let _ = tx_for_recv.send(ServerMessage::ElementUpdated { element });
                            }

                            ClientMessage::DeleteElement { id } => {
                                if state_for_recv.delete_element(&room_id_for_recv, &id).await.is_some() {
                                    let _ = tx_for_recv.send(ServerMessage::ElementDeleted { id });
                                }
                            }

                            ClientMessage::Clear => {
                                state_for_recv.clear_board(&room_id_for_recv).await;
                                let _ = tx_for_recv.send(ServerMessage::BoardCleared);
                            }

                            ClientMessage::CursorMove { x, y } => {
                                state_for_recv
                                    .update_cursor(&room_id_for_recv, &current_user.id, x, y)
                                    .await;
                                let _ = tx_for_recv.send(ServerMessage::CursorMoved {
                                    user_id: current_user.id.clone(),
                                    x,
                                    y,
                                });
                            }

                            ClientMessage::Undo => {
                                if let Some(popped) = state_for_recv.undo(&room_id_for_recv).await {
                                    let _ = tx_for_recv.send(ServerMessage::ElementDeleted {
                                        id: popped.id,
                                    });
                                }
                            }

                            ClientMessage::Redo => {
                                if let Some(restored) = state_for_recv.redo(&room_id_for_recv).await {
                                    let _ = tx_for_recv.send(ServerMessage::ElementAdded {
                                        element: restored,
                                    });
                                }
                            }

                            ClientMessage::Ping => {
                                let _ = tx_for_recv.send(ServerMessage::Pong);
                            }
                        },
                        Err(e) => {
                            warn!(error = %e, text = %text, "Failed to parse incoming WebSocket client message");
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    debug!("Received WebSocket close frame from peer");
                    break;
                }
                Ok(Message::Ping(_)) => {}
                Ok(Message::Pong(_)) => {}
                Ok(Message::Binary(_)) => {
                    warn!("Unexpected binary WebSocket frame received");
                }
                Err(e) => {
                    debug!(error = %e, "WebSocket receive error");
                    break;
                }
            }
        }

        // Cleanup on peer departure
        state_for_recv
            .leave_peer(&room_id_for_recv, &current_user.id)
            .await;
        let _ = tx_for_recv.send(ServerMessage::UserLeft {
            user_id: current_user.id.clone(),
        });
        info!(peer_id = %current_user.id, room = %room_id_for_recv, "WebSocket peer disconnected");
    });

    // Terminate tasks when either ends
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}
