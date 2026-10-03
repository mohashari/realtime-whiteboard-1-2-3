use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use realtime_whiteboard::{
    create_app,
    model::{ElementType, Point, WhiteboardElement},
    state::AppState,
};
use tower::ServiceExt;

fn sample_stroke_element(id: &str, user_id: &str) -> WhiteboardElement {
    WhiteboardElement {
        id: id.to_string(),
        created_by: user_id.to_string(),
        created_at: 1000,
        z_index: 0,
        element_type: ElementType::Stroke {
            points: vec![
                Point { x: 10.0, y: 10.0 },
                Point { x: 20.0, y: 25.0 },
                Point { x: 30.0, y: 40.0 },
            ],
            color: "#1e293b".to_string(),
            width: 4.0,
            is_highlighter: false,
        },
    }
}

fn sample_rectangle_element(id: &str, user_id: &str) -> WhiteboardElement {
    WhiteboardElement {
        id: id.to_string(),
        created_by: user_id.to_string(),
        created_at: 1001,
        z_index: 1,
        element_type: ElementType::Rectangle {
            x: 50.0,
            y: 50.0,
            width: 100.0,
            height: 80.0,
            stroke_color: "#ef4444".to_string(),
            stroke_width: 2.0,
            fill_color: Some("#fee2e2".to_string()),
        },
    }
}

#[tokio::test]
async fn test_state_element_lifecycle() {
    let state = AppState::new();
    let room = "test-room-lifecycle";

    // 1. Initial room is empty
    let elements = state.get_room_elements(room).await;
    assert!(elements.is_none());

    // 2. Add elements
    let elem1 = sample_stroke_element("stroke-1", "user-alice");
    let elem2 = sample_rectangle_element("rect-1", "user-bob");

    state.add_element(room, elem1.clone()).await;
    state.add_element(room, elem2.clone()).await;

    let elements = state.get_room_elements(room).await.expect("room should exist");
    assert_eq!(elements.len(), 2);
    assert_eq!(elements[0].id, "stroke-1");
    assert_eq!(elements[1].id, "rect-1");

    // 3. Undo
    let undone = state.undo(room).await;
    assert!(undone.is_some());
    assert_eq!(undone.unwrap().id, "rect-1");

    let elements = state.get_room_elements(room).await.unwrap();
    assert_eq!(elements.len(), 1);
    assert_eq!(elements[0].id, "stroke-1");

    // 4. Redo
    let redone = state.redo(room).await;
    assert!(redone.is_some());
    assert_eq!(redone.unwrap().id, "rect-1");

    let elements = state.get_room_elements(room).await.unwrap();
    assert_eq!(elements.len(), 2);

    // 5. Delete specific element
    let deleted = state.delete_element(room, "stroke-1").await;
    assert!(deleted.is_some());
    assert_eq!(deleted.unwrap().id, "stroke-1");

    let elements = state.get_room_elements(room).await.unwrap();
    assert_eq!(elements.len(), 1);
    assert_eq!(elements[0].id, "rect-1");

    // 6. Clear board
    state.clear_board(room).await;
    let elements = state.get_room_elements(room).await.unwrap();
    assert_eq!(elements.len(), 0);
}

#[tokio::test]
async fn test_room_export_and_import() {
    let state = AppState::new();
    let room = "export-import-room";

    let elem1 = sample_stroke_element("stroke-1", "user-1");
    let elem2 = sample_rectangle_element("rect-1", "user-1");
    state.add_element(room, elem1.clone()).await;
    state.add_element(room, elem2.clone()).await;

    // Export
    let export = state.export_room(room).await.expect("export should succeed");
    assert_eq!(export.room_id, room);
    assert_eq!(export.elements.len(), 2);

    // Import into a new room
    let new_room = "imported-room";
    state.import_room(new_room, export.elements).await;

    let elements = state.get_room_elements(new_room).await.unwrap();
    assert_eq!(elements.len(), 2);
    assert_eq!(elements[0].id, "stroke-1");
    assert_eq!(elements[1].id, "rect-1");
}

#[tokio::test]
async fn test_rest_api_health_endpoint() {
    let state = AppState::new();
    let app = create_app(state);

    let req = Request::builder()
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(health["status"], "healthy");
}

#[tokio::test]
async fn test_rest_api_rooms_and_elements() {
    let state = AppState::new();
    let room = "api-test-room";
    state.add_element(room, sample_stroke_element("s1", "u1")).await;

    let app = create_app(state);

    // Test GET /api/rooms
    let req = Request::builder()
        .uri("/api/rooms")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Test GET /api/rooms/:room_id/elements
    let req = Request::builder()
        .uri(format!("/api/rooms/{}/elements", room))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let elements: Vec<WhiteboardElement> = serde_json::from_slice(&body).unwrap();
    assert_eq!(elements.len(), 1);
    assert_eq!(elements[0].id, "s1");

    // Test POST /api/rooms/:room_id/clear
    let req = Request::builder()
        .method("POST")
        .uri(format!("/api/rooms/{}/clear", room))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Verify it is now empty
    let req = Request::builder()
        .uri(format!("/api/rooms/{}/elements", room))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let elements: Vec<WhiteboardElement> = serde_json::from_slice(&body).unwrap();
    assert_eq!(elements.len(), 0);
}

#[tokio::test]
async fn test_static_asset_serving() {
    let state = AppState::new();
    let app = create_app(state);

    // Test GET /
    let req = Request::builder().uri("/").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Test GET /static/style.css
    let req = Request::builder().uri("/static/style.css").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("content-type").unwrap(), "text/css; charset=utf-8");

    // Test GET /static/app.js
    let req = Request::builder().uri("/static/app.js").body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("content-type").unwrap(), "application/javascript; charset=utf-8");
}

#[tokio::test]
async fn test_multi_room_isolation() {
    let state = AppState::new();
    let room_a = "room-alpha";
    let room_b = "room-beta";

    let elem_a = sample_stroke_element("stroke-a", "user-1");
    let elem_b = sample_rectangle_element("rect-b", "user-2");

    state.add_element(room_a, elem_a).await;
    state.add_element(room_b, elem_b).await;

    let elems_a = state.get_room_elements(room_a).await.unwrap();
    let elems_b = state.get_room_elements(room_b).await.unwrap();

    assert_eq!(elems_a.len(), 1);
    assert_eq!(elems_a[0].id, "stroke-a");

    assert_eq!(elems_b.len(), 1);
    assert_eq!(elems_b[0].id, "rect-b");

    // Clearing room A should not affect room B
    state.clear_board(room_a).await;
    assert_eq!(state.get_room_elements(room_a).await.unwrap().len(), 0);
    assert_eq!(state.get_room_elements(room_b).await.unwrap().len(), 1);
}

#[tokio::test]
async fn test_peer_presence_and_cursor() {
    let state = AppState::new();
    let room = "presence-room";

    let user1 = realtime_whiteboard::model::UserInfo {
        id: "u1".to_string(),
        name: "Alice".to_string(),
        color: "#3b82f6".to_string(),
        cursor: None,
    };

    let user2 = realtime_whiteboard::model::UserInfo {
        id: "u2".to_string(),
        name: "Bob".to_string(),
        color: "#ef4444".to_string(),
        cursor: None,
    };

    // Users join
    state.join_peer(room, user1).await;
    let (_, users) = state.join_peer(room, user2).await;
    assert_eq!(users.len(), 2);

    // Update cursor
    state.update_cursor(room, "u1", 123.4, 567.8).await;

    // Check health report reflects users
    let health = state.get_health().await;
    assert_eq!(health.total_connected_users, 2);
    assert_eq!(health.active_rooms, 1);

    // User leaves
    let left = state.leave_peer(room, "u1").await;
    assert!(left);

    let health_after = state.get_health().await;
    assert_eq!(health_after.total_connected_users, 1);
}

#[test]
fn test_json_message_serialization() {
    use realtime_whiteboard::model::{ClientMessage, ServerMessage, UserInfo};

    // Client message serialization
    let client_msg = ClientMessage::CursorMove { x: 42.5, y: 84.0 };
    let json = serde_json::to_string(&client_msg).expect("serialization should work");
    assert!(json.contains("\"type\":\"CursorMove\""));
    assert!(json.contains("42.5"));

    // Server message serialization
    let server_msg = ServerMessage::UserJoined {
        user: UserInfo {
            id: "u123".to_string(),
            name: "Carol".to_string(),
            color: "#10b981".to_string(),
            cursor: Some(Point { x: 10.0, y: 20.0 }),
        },
    };
    let json = serde_json::to_string(&server_msg).expect("serialization should work");
    assert!(json.contains("\"type\":\"UserJoined\""));
    assert!(json.contains("Carol"));
    assert!(json.contains("#10b981"));
}
