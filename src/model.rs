use serde::{Deserialize, Serialize};

/// 2D Cartesian coordinate point.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Geometric and stylistic representation of whiteboard elements.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ElementType {
    Stroke {
        points: Vec<Point>,
        color: String,
        width: f64,
        #[serde(default)]
        is_highlighter: bool,
    },
    Line {
        start: Point,
        end: Point,
        stroke_color: String,
        stroke_width: f64,
    },
    Arrow {
        start: Point,
        end: Point,
        stroke_color: String,
        stroke_width: f64,
    },
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        stroke_color: String,
        stroke_width: f64,
        fill_color: Option<String>,
    },
    Circle {
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
        stroke_color: String,
        stroke_width: f64,
        fill_color: Option<String>,
    },
    Text {
        x: f64,
        y: f64,
        text: String,
        font_size: f64,
        color: String,
    },
}

/// Single canvas element with ownership and layer metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WhiteboardElement {
    pub id: String,
    pub created_by: String,
    pub created_at: i64,
    pub z_index: usize,
    pub element_type: ElementType,
}

/// Participant presence details.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub cursor: Option<Point>,
}

/// Incoming client message payload over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    Join {
        user_id: Option<String>,
        user_name: String,
        user_color: String,
    },
    AddElement {
        element: WhiteboardElement,
    },
    UpdateElement {
        element: WhiteboardElement,
    },
    DeleteElement {
        id: String,
    },
    Clear,
    CursorMove {
        x: f64,
        y: f64,
    },
    Undo,
    Redo,
    Ping,
}

/// Outgoing broadcast message to clients over WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    Init {
        your_id: String,
        room_id: String,
        elements: Vec<WhiteboardElement>,
        users: Vec<UserInfo>,
    },
    ElementAdded {
        element: WhiteboardElement,
    },
    ElementUpdated {
        element: WhiteboardElement,
    },
    ElementDeleted {
        id: String,
    },
    BoardCleared,
    UserJoined {
        user: UserInfo,
    },
    UserLeft {
        user_id: String,
    },
    CursorMoved {
        user_id: String,
        x: f64,
        y: f64,
    },
    Pong,
    Error {
        message: String,
    },
}

/// Summary metadata for active rooms in REST API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomSummary {
    pub id: String,
    pub active_users: usize,
    pub element_count: usize,
    pub created_at: i64,
    pub last_activity: i64,
}

/// Complete exported snapshot of a whiteboard room.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomExport {
    pub version: String,
    pub room_id: String,
    pub exported_at: i64,
    pub elements: Vec<WhiteboardElement>,
}

/// System health and status response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthStatus {
    pub status: String,
    pub uptime_seconds: u64,
    pub active_rooms: usize,
    pub total_connected_users: usize,
    pub version: String,
}
