use std::process::Command;
use tauri::Manager;

const PORT: u16 = 4477;

/// ¿Hay algo escuchando en 127.0.0.1:PORT? (chequeo barato, sin CORS: es Rust).
fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Encuentra el binario `omega`. Lanzada desde Finder, la app hereda un PATH
/// mínimo (/usr/bin:/bin:…) SIN /opt/homebrew/bin → `Command::new("omega")`
/// fallaría. Buscamos en ubicaciones conocidas; si nada, caemos al PATH (que sí
/// tiene omega cuando la app se lanza desde una terminal).
fn find_omega() -> String {
    if let Ok(p) = std::env::var("OMEGA_BIN") {
        if !p.is_empty() {
            return p;
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/omega".to_string(),
        "/usr/local/bin/omega".to_string(),
        format!("{home}/.local/bin/omega"),
        format!("{home}/.npm-global/bin/omega"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    "omega".to_string()
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
                let bin = find_omega();
                let mut cmd = Command::new(&bin);
                cmd.args(["serve", "--port", &PORT.to_string()]);
                // El wrapper `omega` arranca con `#!/usr/bin/env node`. Lanzada
                // desde Finder, la app hereda un PATH mínimo (/usr/bin:/bin) SIN
                // node → `env node` falla y el daemon nunca arranca. `node` vive
                // junto al binario (npm/homebrew), así que prepend su dir + los
                // paths usuales al PATH del proceso hijo.
                let mut path = String::new();
                if let Some(dir) = std::path::Path::new(&bin).parent() {
                    if !dir.as_os_str().is_empty() {
                        path.push_str(&dir.to_string_lossy());
                        path.push(':');
                    }
                }
                path.push_str("/opt/homebrew/bin:/usr/local/bin:");
                path.push_str(&std::env::var("PATH").unwrap_or_default());
                cmd.env("PATH", path);
                if let Err(e) = cmd.spawn() {
                    eprintln!("omega desktop: no se pudo spawnear el daemon ({bin}): {e}");
                }
            }

            // La ventana ya intentó cargar la URL al abrir; si el daemon todavía no
            // estaba up, quedó en blanco. Esperamos a que responda y (re)navegamos.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..240 {
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
