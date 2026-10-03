use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
};
use std::path::Path;

const EMBEDDED_INDEX_HTML: &str = include_str!("../static/index.html");
const EMBEDDED_STYLE_CSS: &str = include_str!("../static/style.css");
const EMBEDDED_APP_JS: &str = include_str!("../static/app.js");

/// Serve the main HTML application, checking disk first or falling back to embedded asset.
pub async fn index_handler() -> impl IntoResponse {
    let content = if Path::new("static/index.html").exists() {
        std::fs::read_to_string("static/index.html").unwrap_or_else(|_| EMBEDDED_INDEX_HTML.to_string())
    } else {
        EMBEDDED_INDEX_HTML.to_string()
    };
    Html(content)
}

/// Serve CSS stylesheet.
pub async fn css_handler() -> Response {
    let content = if Path::new("static/style.css").exists() {
        std::fs::read_to_string("static/style.css").unwrap_or_else(|_| EMBEDDED_STYLE_CSS.to_string())
    } else {
        EMBEDDED_STYLE_CSS.to_string()
    };

    let mut response = content.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/css; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    response
}

/// Serve JavaScript client code.
pub async fn js_handler() -> Response {
    let content = if Path::new("static/app.js").exists() {
        std::fs::read_to_string("static/app.js").unwrap_or_else(|_| EMBEDDED_APP_JS.to_string())
    } else {
        EMBEDDED_APP_JS.to_string()
    };

    let mut response = content.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    response
}

/// Fallback 404 handler for unrecognized paths.
pub async fn fallback_handler() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, "404 Not Found")
}
