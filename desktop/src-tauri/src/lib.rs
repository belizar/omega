use std::process::Command;
use tauri::Manager;

const PORT: u16 = 4477;

/// ¿Hay algo escuchando en 127.0.0.1:PORT? (chequeo barato, sin CORS: es Rust).
fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Auto-spawn del daemon: si NO hay uno escuchando ya, arrancamos el
            // `omega` global. Persistente a propósito (no lo matamos al cerrar la
            // ventana): `omega serve stop` lo baja. Si ya hay uno (lo levantaste
            // vos), nos enganchamos a ese.
            if !port_open(PORT) {
                if let Err(e) = Command::new("omega")
                    .args(["serve", "--port", &PORT.to_string()])
                    .spawn()
                {
                    eprintln!("omega desktop: no se pudo spawnear el daemon: {e}");
                }
            }

            // La ventana ya intentó cargar la URL al abrir; si el daemon todavía no
            // estaba up, quedó en blanco. Esperamos a que responda y (re)navegamos.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..80 {
                    if port_open(PORT) {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.navigate(
                                format!("http://localhost:{PORT}").parse().unwrap(),
                            );
                        }
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
