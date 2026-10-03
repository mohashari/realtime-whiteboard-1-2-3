use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use chrono::Utc;
use tokio::sync::{broadcast, RwLock};

use crate::model::{HealthStatus, Point, RoomExport, RoomSummary, ServerMessage, UserInfo, WhiteboardElement};

const BROADCAST_CAPACITY: usize = 512;

/// In-memory state of an active collaborative room.
pub struct Room {
    pub id: String,
    pub elements: Vec<WhiteboardElement>,
    pub undo_stack: Vec<WhiteboardElement>,
    pub redo_stack: Vec<WhiteboardElement>,
    pub users: HashMap<String, UserInfo>,
    pub tx: broadcast::Sender<ServerMessage>,
    pub created_at: i64,
    pub last_activity: i64,
}

impl Room {
    pub fn new(id: String) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let now = Utc::now().timestamp_millis();
        Self {
            id,
            elements: Vec::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            users: HashMap::new(),
            tx,
            created_at: now,
            last_activity: now,
        }
    }

    fn touch(&mut self) {
        self.last_activity = Utc::now().timestamp_millis();
    }
}

/// Global shared application state.
#[derive(Clone)]
pub struct AppState {
    rooms: Arc<RwLock<HashMap<String, Room>>>,
    start_time: Instant,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            start_time: Instant::now(),
        }
    }

    /// Obtain or create a broadcast channel for the specified room.
    pub async fn get_or_create_room(
        &self,
        room_id: &str,
    ) -> (broadcast::Sender<ServerMessage>, broadcast::Receiver<ServerMessage>) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));
        let tx = room.tx.clone();
        let rx = room.tx.subscribe();
        (tx, rx)
    }

    /// Register a peer in the room and retrieve the current snapshot of elements and active users.
    pub async fn join_peer(
        &self,
        room_id: &str,
        user: UserInfo,
    ) -> (Vec<WhiteboardElement>, Vec<UserInfo>) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));

        room.touch();
        room.users.insert(user.id.clone(), user);

        let elements = room.elements.clone();
        let users = room.users.values().cloned().collect();
        (elements, users)
    }

    /// Remove a peer from the room upon disconnect.
    pub async fn leave_peer(&self, room_id: &str, user_id: &str) -> bool {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.touch();
            room.users.remove(user_id);
            true
        } else {
            false
        }
    }

    /// Update participant's cursor position.
    pub async fn update_cursor(&self, room_id: &str, user_id: &str, x: f64, y: f64) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            if let Some(user) = room.users.get_mut(user_id) {
                user.cursor = Some(Point { x, y });
            }
        }
    }

    /// Append a new drawing element to the canvas.
    pub async fn add_element(&self, room_id: &str, element: WhiteboardElement) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));
        room.touch();
        // Clear redo stack on new addition
        room.redo_stack.clear();
        room.elements.push(element);
    }

    /// Update an existing drawing element (e.g. while dragging or resizing).
    pub async fn update_element(&self, room_id: &str, element: WhiteboardElement) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));
        room.touch();
        if let Some(existing) = room.elements.iter_mut().find(|e| e.id == element.id) {
            *existing = element;
        }
    }

    /// Delete an element by its ID.
    pub async fn delete_element(&self, room_id: &str, id: &str) -> Option<WhiteboardElement> {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.touch();
            if let Some(pos) = room.elements.iter().position(|e| e.id == id) {
                let removed = room.elements.remove(pos);
                room.undo_stack.push(removed.clone());
                return Some(removed);
            }
        }
        None
    }

    /// Clear all elements on the whiteboard for a room.
    pub async fn clear_board(&self, room_id: &str) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));
        room.touch();
        room.undo_stack.extend(room.elements.drain(..));
        room.redo_stack.clear();
    }

    /// Undo last added element: removes the last element and pushes to redo stack.
    pub async fn undo(&self, room_id: &str) -> Option<WhiteboardElement> {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.touch();
            if let Some(popped) = room.elements.pop() {
                room.redo_stack.push(popped.clone());
                return Some(popped);
            }
        }
        None
    }

    /// Redo last undone element: restores the last element from redo stack.
    pub async fn redo(&self, room_id: &str) -> Option<WhiteboardElement> {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.touch();
            if let Some(restored) = room.redo_stack.pop() {
                room.elements.push(restored.clone());
                return Some(restored);
            }
        }
        None
    }

    /// Get current elements of a room.
    pub async fn get_room_elements(&self, room_id: &str) -> Option<Vec<WhiteboardElement>> {
        let rooms = self.rooms.read().await;
        rooms.get(room_id).map(|r| r.elements.clone())
    }

    /// Export room state as a complete JSON-serializable snapshot.
    pub async fn export_room(&self, room_id: &str) -> Option<RoomExport> {
        let rooms = self.rooms.read().await;
        rooms.get(room_id).map(|r| RoomExport {
            version: "1.0".to_string(),
            room_id: r.id.clone(),
            exported_at: Utc::now().timestamp_millis(),
            elements: r.elements.clone(),
        })
    }

    /// Import an array of elements into the room.
    pub async fn import_room(&self, room_id: &str, elements: Vec<WhiteboardElement>) {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .entry(room_id.to_string())
            .or_insert_with(|| Room::new(room_id.to_string()));

        room.touch();
        room.elements = elements;
        room.undo_stack.clear();
        room.redo_stack.clear();
    }

    /// Summary list of all active rooms.
    pub async fn get_room_summaries(&self) -> Vec<RoomSummary> {
        let rooms = self.rooms.read().await;
        rooms
            .values()
            .map(|r| RoomSummary {
                id: r.id.clone(),
                active_users: r.users.len(),
                element_count: r.elements.len(),
                created_at: r.created_at,
                last_activity: r.last_activity,
            })
            .collect()
    }

    /// Health and operational metrics.
    pub async fn get_health(&self) -> HealthStatus {
        let rooms = self.rooms.read().await;
        let total_users: usize = rooms.values().map(|r| r.users.len()).sum();
        HealthStatus {
            status: "healthy".to_string(),
            uptime_seconds: self.start_time.elapsed().as_secs(),
            active_rooms: rooms.len(),
            total_connected_users: total_users,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}
