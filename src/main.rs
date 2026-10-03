use clap::Parser;
use realtime_whiteboard::{create_app, state::AppState};
use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// CLI configuration options for RustBoard.
#[derive(Parser, Debug)]
#[command(
    name = "RustBoard",
    version,
    about = "Realtime Collaborative Whiteboard Fullstack Application written in Rust"
)]
struct Args {
    /// Host interface to bind to
    #[arg(short = 'H', long, default_value = "0.0.0.0")]
    host: String,

    /// Port number to listen on
    #[arg(short, long, default_value_t = 3000)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging / tracing with environment filter fallback
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "realtime_whiteboard=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let args = Args::parse();
    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;

    let state = AppState::new();
    let app = create_app(state);

    let listener = tokio::net::TcpListener::bind(&addr).await?;

    println!("\n🎨 ========================================================");
    println!("   RustBoard — Realtime Collaborative Whiteboard");
    println!("   Listening on: http://{}", addr);
    println!("   Local URL:    http://localhost:{}", args.port);
    println!("   Health Check: http://localhost:{}/api/health", args.port);
    println!("========================================================\n");

    info!("Server listening on http://{}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Server shut down gracefully");
    Ok(())
}

/// Graceful shutdown listener for SIGINT (Ctrl+C) and SIGTERM.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C signal handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            println!("\nReceived Ctrl+C, shutting down server...");
        },
        _ = terminate => {
            println!("\nReceived SIGTERM, shutting down server...");
        },
    }
}
