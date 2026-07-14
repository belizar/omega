/**
 * El cliente web: una SPA vanilla, cero-build, servida como string por el
 * ServeMode. Consume el stream SSE (`/events`) y postea input (`/input`).
 * Renderiza el chat con el lenguaje visual de Omega — glyphs por tool, la
 * semántica de color de la terminal, monospace. Dark-only a propósito.
 */
export const WEB_CLIENT_HTML = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ω omega</title>
<style>
  :root {
    --mono: ui-monospace,"SF Mono",Menlo,"Cascadia Code","JetBrains Mono",Consolas,monospace;
    --sans: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --bg:#0b0e13; --surface:#12171f; --surface2:#171d27; --border:#232b38;
    --ink:#e7ecf3; --dim:#9aa8ba; --faint:#616e7f;
    --tool:#34cdd8; --human:#6ea8ff; --output:#8b96a5; --ok:#4ec98a; --err:#f0706f; --warn:#e3b256;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; margin:0; }
  body { background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:15px; line-height:1.6;
         display:flex; }
  .col { flex:1; display:flex; flex-direction:column; min-width:0; height:100%; }

  /* Sidebar de sesiones (multi-sesión) — ancho arrastrable (var --sbw, persistido) */
  .sidebar { width:var(--sbw,236px); flex-shrink:0; background:var(--surface); border-right:1px solid var(--border);
             display:flex; flex-direction:column; height:100%; min-width:0; }
  /* Divisor de resize: barra fina entre sidebar y chat. */
  .resizer { flex:0 0 5px; cursor:col-resize; background:transparent; position:relative; z-index:5; }
  .resizer::after { content:""; position:absolute; inset:0 2px; background:var(--border); opacity:0; transition:opacity .12s; }
  .resizer:hover::after, .resizer.drag::after { opacity:1; background:var(--tool); }
  body.resizing { cursor:col-resize; user-select:none; }
  .sb-hd { display:flex; align-items:center; gap:8px; padding:13px 13px 11px; border-bottom:1px solid var(--border); }
  /* Buscador de workspaces (filtra la lista por título/proyecto/branch) */
  .sb-search { padding:8px 10px 0; }
  .sb-search input { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:8px;
                     padding:6px 9px; color:var(--ink); font-family:var(--mono); font-size:11.5px; }
  .sb-search input:focus { outline:none; border-color:var(--tool); box-shadow:0 0 0 3px rgba(52,205,216,.12); }
  .sb-search input::placeholder { color:var(--faint); }
  .sb-hd .t { font-family:var(--mono); letter-spacing:0.2em; text-transform:uppercase; font-size:10.5px; color:var(--dim); }
  .sb-new { margin-left:auto; background:var(--surface2); color:var(--tool); border:1px solid var(--border);
            border-radius:7px; height:26px; padding:0 9px; font-family:var(--mono); font-size:12px; font-weight:700; cursor:pointer; }
  .sb-new:hover { border-color:var(--tool); }
  .sb-list { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:4px; }
  .sb-grp { font-family:var(--mono); font-size:9.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); display:flex; align-items:center; gap:8px; padding:12px 8px 4px; }
  .sb-grp:first-child { padding-top:2px; }
  .sb-grp .ln { flex:1; height:1px; background:var(--border); }
  .sb-item { position:relative; border:1px solid transparent; border-radius:9px; padding:8px 10px; cursor:pointer;
             display:flex; flex-direction:column; gap:2px; }
  .sb-item:hover { background:var(--surface2); }
  .sb-item.active { background:var(--surface2); border-color:var(--border); }
  .sb-item.active::before { content:""; position:absolute; left:0; top:8px; bottom:8px; width:2px; border-radius:2px; background:var(--tool); }
  .sb-item .nm { font-family:var(--mono); font-size:13px; color:var(--ink); display:flex; align-items:center; gap:7px; padding-right:14px; }
  .sb-item .nm .tt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sb-item .pdot { width:7px; height:7px; border-radius:50%; background:var(--tool); box-shadow:0 0 6px var(--tool); flex:none; }
  .sb-item.dormant { opacity:.62; }
  .sb-item.dormant .nm { color:var(--dim); }
  .sb-item.dormant .pdot { background:var(--faint); box-shadow:none; }
  .sb-item.st-running .pdot { background:var(--ok); box-shadow:0 0 7px var(--ok); }
  .sb-item.st-waiting .pdot { background:var(--warn); box-shadow:none; }
  .sb-item.st-running .meta .s { color:var(--ok); }
  .sb-item.st-waiting .meta .s { color:var(--warn); }
  .sb-item .meta { font-family:var(--mono); font-size:10px; color:var(--faint); padding-left:14px; }
  .sb-item .meta .iso { color:var(--warn); }
  .sb-item .meta .s { color:var(--dim); }
  .sb-foot { padding:10px 13px; border-top:1px solid var(--border); }
  .sb-foot label { display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:11px; color:var(--dim); cursor:pointer; }
  .sb-foot input { accent-color:var(--tool); }
  .sb-foot .sb-rescan { font-family:var(--mono); font-size:10.5px; color:var(--dim); background:none; border:1px solid var(--border); border-radius:6px; padding:4px 9px; cursor:pointer; }
  .sb-foot .sb-rescan:hover { border-color:var(--tool); color:var(--tool); }
  .sb-foot .hint2 { margin-top:7px; font-family:var(--mono); font-size:9.5px; color:var(--faint); line-height:1.4; }
  @media (max-width:640px) { .sidebar { display:none; } }
  header { display:flex; align-items:center; gap:11px; padding:12px 18px; border-bottom:1px solid var(--border);
           background:var(--surface); position:sticky; top:0; z-index:2; }
  header .om { font-family:var(--mono); font-weight:700; font-size:22px; color:var(--tool); line-height:1; }
  header .nm { font-family:var(--mono); letter-spacing:0.3em; text-transform:uppercase; font-size:12px; color:var(--ink); }
  header .st { margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--faint); display:flex; gap:8px; align-items:center; }
  header .hbtn { font-family:var(--mono); font-size:11px; color:var(--dim); background:var(--surface2); border:1px solid var(--border); border-radius:7px; padding:3px 9px; cursor:pointer; }
  header .hbtn:hover { border-color:var(--tool); color:var(--tool); }
  header .dotc { width:7px; height:7px; border-radius:50%; background:var(--faint); }
  header .dotc.on { background:var(--ok); box-shadow:0 0 8px var(--ok); }

  main { flex:1; overflow-y:auto; }
  .thread { max-width:820px; margin:0 auto; padding:22px 18px 28px; display:flex; flex-direction:column; gap:14px; }

  .msg { display:flex; flex-direction:column; gap:5px; }
  .msg .who { font-family:var(--mono); font-size:10.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--faint); }
  .msg.user .who { color:var(--human); }
  .msg.user .body { border-left:2px solid var(--human); padding-left:12px; color:var(--ink); white-space:pre-wrap; }
  .msg.asst .body { color:var(--ink); }
  .body p { margin:0 0 9px; } .body p:last-child { margin:0; }
  .body code { font-family:var(--mono); font-size:0.88em; background:var(--surface2); padding:1px 5px; border-radius:4px; color:var(--tool); }
  .body pre { font-family:var(--mono); font-size:12.5px; background:var(--surface); border:1px solid var(--border);
              border-radius:8px; padding:11px 13px; overflow-x:auto; margin:9px 0; }
  .body pre code { background:none; padding:0; color:var(--ink); }
  /* syntax highlight (highlight.js) con la paleta de Omega, sin theme externo */
  .hljs-comment,.hljs-quote { color:var(--faint); font-style:italic; }
  .hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-built_in,.hljs-type,.hljs-name,.hljs-tag { color:var(--tool); }
  .hljs-string,.hljs-regexp,.hljs-attribute,.hljs-symbol { color:var(--ok); }
  .hljs-number,.hljs-bullet,.hljs-link { color:var(--warn); }
  .hljs-title,.hljs-title.function_,.hljs-section { color:var(--human); }
  .hljs-title.class_ { color:var(--tool); }
  .hljs-attr,.hljs-property,.hljs-variable,.hljs-template-variable,.hljs-params { color:var(--dim); }
  .hljs-meta { color:var(--faint); }
  .hljs-emphasis { font-style:italic; } .hljs-strong { font-weight:650; }
  .hljs-deletion { color:var(--err); } .hljs-addition { color:var(--ok); }
  .body strong { color:#fff; font-weight:650; }
  .mermaid-block { margin:10px 0; }
  .mermaid-block svg { max-width:100%; height:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; }
  .mermaid-block pre.mmsrc { opacity:.7; }
  .mermaid-block[data-done] pre.mmsrc { display:none; }
  .body table { border-collapse:collapse; margin:10px 0; display:block; overflow-x:auto; font-size:13.5px; }
  .body th, .body td { border:1px solid var(--border); padding:7px 11px; text-align:left; vertical-align:top; }
  .body thead th { background:var(--surface2); font-family:var(--mono); font-size:11.5px; text-transform:uppercase;
                   letter-spacing:0.06em; color:var(--dim); font-weight:600; }
  .body tbody tr:nth-child(even) td { background:rgba(255,255,255,.02); }
  .body h1,.body h2,.body h3,.body h4,.body h5,.body h6 { font-family:var(--mono); font-weight:650; line-height:1.3; margin:16px 0 8px; color:#fff; }
  .body h1 { font-size:1.42em; } .body h2 { font-size:1.24em; } .body h3 { font-size:1.09em; color:var(--ink); }
  .body h4,.body h5,.body h6 { font-size:1em; color:var(--dim); }
  .body a { color:var(--tool); text-decoration:underline; text-underline-offset:2px; }
  .body em { font-style:italic; }
  .body del { color:var(--faint); }
  .body blockquote { margin:9px 0; padding:3px 0 3px 13px; border-left:2px solid var(--tool); color:var(--dim); }
  .body ul,.body ol { margin:8px 0; padding-left:22px; } .body li { margin:2px 0; }
  .body li.task { list-style:none; margin-left:-18px; } .body li.task input { margin-right:6px; accent-color:var(--tool); vertical-align:middle; }
  .body hr { border:none; border-top:1px solid var(--border); margin:16px 0; }

  .tool { font-family:var(--mono); font-size:13px; display:flex; flex-direction:column; gap:2px; }
  .tool .call { color:var(--gl,var(--tool)); }
  .tool .call .gl { font-weight:700; }
  .tool .call .arg { color:var(--dim); }
  .tool .res { color:var(--output); font-size:12px; padding-left:16px; white-space:pre-wrap; }
  .tool .res.err { color:var(--err); }

  .sys { font-family:var(--mono); font-size:12px; color:var(--faint); }
  .metrics { font-family:var(--mono); font-size:11.5px; color:var(--faint); }

  .thinking { display:none; align-items:center; gap:9px; font-family:var(--mono); font-size:12.5px; color:var(--tool);
              max-width:820px; margin:0 auto; padding:2px 18px 8px; }
  .thinking.on { display:flex; }
  .sp { width:9px; height:9px; border-radius:50%; background:var(--tool); animation:pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.25;transform:scale(.8)} 50%{opacity:1;transform:scale(1)} }
  .stopbtn { margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--err); background:none;
             border:1px solid color-mix(in srgb,var(--err) 40%,transparent); border-radius:7px; padding:3px 10px;
             cursor:pointer; }
  .stopbtn:hover { background:color-mix(in srgb,var(--err) 14%,transparent); }
  @media (prefers-reduced-motion: reduce) { .sp { animation:none; } }

  form { border-top:1px solid var(--border); background:var(--surface); padding:12px 18px 16px; }
  .inbar { max-width:820px; margin:0 auto; display:flex; gap:10px; align-items:flex-end; }
  textarea { flex:1; resize:none; background:var(--bg); color:var(--ink); border:1px solid var(--border);
             border-radius:10px; padding:11px 13px; font-family:var(--sans); font-size:15px; line-height:1.5;
             max-height:180px; }
  textarea:focus { outline:none; border-color:var(--tool); box-shadow:0 0 0 3px rgba(52,205,216,.12); }
  textarea::placeholder { color:var(--faint); }
  button { background:var(--tool); color:#05171a; border:none; border-radius:10px; padding:0 18px; height:44px;
           font-family:var(--mono); font-weight:700; font-size:14px; cursor:pointer; }
  button:disabled { opacity:.4; cursor:default; }
  .hint { max-width:820px; margin:7px auto 0; font-family:var(--mono); font-size:11px; color:var(--faint); }

  /* Modal de nueva sesión */
  .modal-bg { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; z-index:20; }
  .modal-bg.on { display:flex; }
  .modal { background:var(--surface); border:1px solid var(--border2); border-radius:14px; width:min(430px,92vw); padding:20px 20px 18px; box-shadow:0 24px 60px -20px rgba(0,0,0,.7); }
  .modal h3 { font-family:var(--mono); font-size:12px; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); margin:0 0 14px; }
  .modes { display:flex; flex-direction:column; gap:7px; margin-bottom:13px; }
  .mode { border:1px solid var(--border); border-radius:10px; padding:10px 12px; cursor:pointer; }
  .mode:hover { border-color:var(--border2); }
  .mode.sel { border-color:var(--tool); background:var(--surface2); }
  .mode .mt { font-family:var(--mono); font-size:13px; color:var(--ink); }
  .mode.sel .mt { color:var(--tool); }
  .mode .md { font-size:11px; color:var(--faint); margin-top:2px; }
  .fields { display:flex; flex-direction:column; gap:9px; margin-bottom:14px; }
  .fields label { font-family:var(--mono); font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); display:block; margin-bottom:4px; }
  .fields input { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:9px 11px; color:var(--ink); font-family:var(--mono); font-size:13px; }
  .fields input:focus { outline:none; border-color:var(--tool); box-shadow:0 0 0 3px rgba(52,205,216,.12); }
  .modal .acts { display:flex; gap:8px; justify-content:flex-end; }
  .modal .btn { font-family:var(--mono); font-size:12px; border-radius:8px; padding:8px 16px; cursor:pointer; border:1px solid var(--border2); background:var(--surface2); color:var(--dim); }
  .modal .btn:hover { border-color:var(--tool); }
  .modal .btn.primary { background:var(--tool); color:var(--bg); border-color:var(--tool); font-weight:700; }

  /* Rename inline: el título del item se vuelve un input al doble-click */
  .sb-item .nm input { flex:1; min-width:0; background:var(--bg); border:1px solid var(--tool); border-radius:5px;
                       color:var(--ink); font-family:var(--mono); font-size:13px; padding:1px 5px; }
  .sb-item .nm input:focus { outline:none; }
  /* Acción del item: un kebab (⋯) que abre el menú contextual. Aparece al hover. */
  .sb-item .acts { position:absolute; top:5px; right:6px; display:flex; gap:4px; opacity:0; }
  .sb-item:hover .acts, .sb-item.active .acts { opacity:1; }
  .sb-item .acts button { width:24px; height:24px; line-height:22px; text-align:center; background:var(--surface);
                          border:1px solid var(--border); color:var(--dim); font-size:15px; cursor:pointer; border-radius:6px; padding:0; }
  .sb-item .acts .kebab:hover { color:var(--tool); border-color:var(--tool); background:color-mix(in srgb,var(--tool) 14%,transparent); }
  .sb-item.archived { opacity:.5; }
  /* Necesita atención (terminó o te preguntó): se comunica por COLOR, no por posición */
  .sb-item.att { background:color-mix(in srgb,var(--warn) 11%,transparent); border-color:color-mix(in srgb,var(--warn) 45%,transparent); }
  .sb-item.att .pdot { background:var(--warn); box-shadow:0 0 7px var(--warn); }
  .sb-item.att .nm { color:var(--ink); }
  /* Drag-and-drop para reordenar */
  .sb-item.dragging { opacity:.4; }
  .sb-item.dragover { box-shadow:inset 0 2px 0 var(--tool); }

  /* Menú contextual (click derecho o kebab) — acciones del workspace, estilo cmux */
  .ctxmenu { position:fixed; z-index:50; min-width:212px; background:var(--surface); border:1px solid var(--border);
             border-radius:11px; padding:5px; box-shadow:0 18px 48px -14px rgba(0,0,0,.72); font-family:var(--sans); }
  .ctxmenu .ci { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:7px 11px; border-radius:7px;
                 font-size:13px; color:var(--ink); cursor:pointer; white-space:nowrap; }
  .ctxmenu .ci:hover { background:var(--surface2); }
  .ctxmenu .ci.danger { color:var(--err); }
  .ctxmenu .ci.danger:hover { background:color-mix(in srgb,var(--err) 15%,transparent); }
  .ctxmenu .ci .k { font-family:var(--mono); font-size:10.5px; color:var(--faint); letter-spacing:.04em; }
  .ctxmenu .cihd { font-family:var(--mono); font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--faint);
                   padding:6px 11px 4px; overflow:hidden; text-overflow:ellipsis; }
  .ctxmenu .cisep { height:1px; background:var(--border); margin:5px 7px; }
  .sb-foot .arch-tgl { display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:10.5px; color:var(--dim); cursor:pointer; margin-bottom:8px; }
  .sb-foot .arch-tgl input { accent-color:var(--tool); }
  .sb-foot .arch-tgl .n { color:var(--faint); }

  /* Toasts de atención (in-app, cero permisos) — arriba a la derecha */
  .toasts { position:fixed; top:14px; right:14px; z-index:60; display:flex; flex-direction:column; gap:8px; width:min(320px,80vw); }
  .toast { background:var(--surface); border:1px solid var(--border); border-left:3px solid var(--warn); border-radius:10px;
           padding:9px 11px; box-shadow:0 12px 34px -12px rgba(0,0,0,.6); cursor:pointer; animation:toastin .18s ease; }
  .toast.done { border-left-color:var(--ok); }
  .toast .tt { font-family:var(--mono); font-size:12px; color:var(--ink); display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
  .toast .tt .xx { color:var(--faint); font-size:13px; } .toast .tt .xx:hover { color:var(--err); }
  .toast .tb { font-size:12px; color:var(--dim); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  @keyframes toastin { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:none} }
  @media (prefers-reduced-motion: reduce){ .toast{ animation:none; } }

  /* Buscar dentro de la conversación (Ctrl-F): barra flotante sobre el hilo */
  .findbar { display:none; position:sticky; top:0; z-index:3; align-items:center; gap:9px;
             background:var(--surface2); border-bottom:1px solid var(--border); padding:8px 18px; }
  .findbar.on { display:flex; }
  .findbar input { flex:1; max-width:340px; background:var(--bg); border:1px solid var(--border); border-radius:8px;
                   padding:6px 10px; color:var(--ink); font-family:var(--mono); font-size:13px; }
  .findbar input:focus { outline:none; border-color:var(--tool); box-shadow:0 0 0 3px rgba(52,205,216,.12); }
  .findbar .fcount { font-family:var(--mono); font-size:11.5px; color:var(--dim); min-width:56px; }
  .findbar .fbtn { font-family:var(--mono); font-size:12px; color:var(--dim); background:var(--surface); border:1px solid var(--border);
                   border-radius:6px; width:28px; height:26px; cursor:pointer; }
  .findbar .fbtn:hover { border-color:var(--tool); color:var(--tool); }
  mark.find { background:color-mix(in srgb,var(--warn) 32%,transparent); color:inherit; border-radius:2px; }
  mark.find.cur { background:var(--warn); color:#1a1300; }

  /* Tabs de la sesión (Activity / Diff …) — modelo Linear */
  .tabs { display:flex; gap:2px; padding:0 14px; background:var(--surface); border-bottom:1px solid var(--border); }
  /* reset explícito del estilo global de <button> (radius/height/weight/bg) */
  .tab { font-family:var(--mono); font-size:12px; color:var(--dim); background:none; border:none; border-radius:0;
         border-bottom:2px solid transparent; height:auto; padding:10px 14px; margin-bottom:-1px; font-weight:400; cursor:pointer; }
  .tab:hover { color:var(--ink); }
  .tab.active { color:var(--tool); border-bottom-color:var(--tool); }

  /* Panel de Diff — two-pane: lista de archivos (izq) + diff del elegido (der) */
  .diffpanel { display:none; flex-direction:column; height:calc(100vh - 96px); padding:14px 16px; }
  .diffpanel.on { display:flex; }
  .diffbar { display:flex; align-items:center; gap:10px; margin-bottom:12px; font-family:var(--mono); font-size:12px; color:var(--dim); flex:none; }
  .diffbar input { flex:0 1 300px; background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:7px 10px;
                   color:var(--ink); font-family:var(--mono); font-size:12px; }
  .diffbar input:focus { outline:none; border-color:var(--tool); box-shadow:0 0 0 3px rgba(52,205,216,.12); }
  .diffbar .rf { background:var(--surface2); border:1px solid var(--border); color:var(--dim); border-radius:8px; padding:7px 11px; cursor:pointer; font-family:var(--mono); font-size:12px; }
  .diffbar .rf:hover { border-color:var(--tool); color:var(--tool); }
  .difftot { margin-left:auto; } .difftot .ad { color:var(--ok); } .difftot .de { color:var(--err); }

  .difflayout { flex:1; min-height:0; display:flex; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  .difffiles { width:300px; flex:none; overflow-y:auto; border-right:1px solid var(--border); background:var(--surface); }
  .diffview { flex:1; min-width:0; overflow:auto; background:var(--bg); }

  .dfrow { display:flex; align-items:center; gap:8px; padding:6px 11px; cursor:pointer; font-family:var(--mono); font-size:12px;
           border-left:2px solid transparent; }
  .dfrow:hover { background:var(--surface2); }
  .dfrow.sel { background:var(--surface2); border-left-color:var(--tool); }
  .dfrow .st { font-size:11px; font-weight:700; width:14px; text-align:center; flex:none; }
  .dfrow .st.added { color:var(--ok); } .dfrow .st.modified { color:var(--warn); }
  .dfrow .st.deleted { color:var(--err); } .dfrow .st.renamed { color:var(--human); }
  .dfrow .pth { flex:1; min-width:0; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dfrow.sel .pth { color:var(--ink); }
  .dfrow .cnt { flex:none; font-size:10.5px; } .dfrow .cnt .ad{color:var(--ok);} .dfrow .cnt .de{color:var(--err);}

  .diffview .vhd { position:sticky; top:0; z-index:1; padding:9px 13px; background:var(--surface); border-bottom:1px solid var(--border);
                   font-family:var(--mono); font-size:12px; color:var(--ink); }
  .diffview pre { margin:0; font-family:var(--mono); font-size:12px; line-height:1.5; }
  .diffview .ln { display:block; padding:0 13px; white-space:pre; min-height:1.5em; }
  .diffview .ln.add { background:color-mix(in srgb,var(--ok) 13%,transparent); }
  .diffview .ln.del { background:color-mix(in srgb,var(--err) 13%,transparent); }
  .diffview .ln.hnk { color:var(--faint); background:var(--surface); }
  .diffview .ln.ctx { color:var(--dim); }
  .diffempty { color:var(--faint); font-family:var(--mono); font-size:12px; padding:26px; text-align:center; }

  /* File explorer (reusa .diffpanel/.difflayout/.difffiles/.diffview) */
  .fscrumb { flex:1; min-width:0; font-family:var(--mono); font-size:12px; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .fscrumb .seg { color:var(--tool); cursor:pointer; } .fscrumb .seg:hover { text-decoration:underline; }
  .fsrow { display:flex; align-items:center; gap:8px; padding:5px 11px; cursor:pointer; font-family:var(--mono); font-size:12px; color:var(--ink); border-left:2px solid transparent; }
  .fsrow:hover { background:var(--surface2); }
  .fsrow.sel { background:var(--surface2); border-left-color:var(--tool); }
  .fsrow .ic { width:13px; text-align:center; flex:none; color:var(--faint); }
  .fsrow.dir .ic { color:var(--tool); }
  .fsrow .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .fsrow .sz { flex:none; font-size:10px; color:var(--faint); }
  #fileview .vhd { position:sticky; top:0; z-index:1; padding:9px 13px; background:var(--surface); border-bottom:1px solid var(--border); font-family:var(--mono); font-size:12px; color:var(--ink); }
  #fileview pre { margin:0; padding:10px 13px; font-family:var(--mono); font-size:12px; line-height:1.5; white-space:pre; color:var(--ink); }
</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
  // mermaid + highlight.js como assets del browser (CDN); si no cargan, los
  // bloques quedan como código plano. Node/Omega sigue zero-dep. Los tokens de
  // hljs los pinto con la paleta de Omega (abajo), sin theme externo.
  if (window.mermaid) mermaid.initialize({ startOnLoad:false, theme:"dark", securityLevel:"strict", fontFamily:"ui-monospace, monospace" });
</script>
</head>
<body>
  <aside class="sidebar">
    <div class="sb-hd"><span class="t">sesiones</span><button class="sb-new" id="sbnew" title="nueva sesión">+ nueva</button></div>
    <div class="sb-search"><input type="text" id="sbfilter" placeholder="buscar workspace…  (título · proyecto · branch)" autocomplete="off"></div>
    <div class="sb-list" id="sblist"></div>
    <div class="sb-foot">
      <label class="arch-tgl" title="mostrar las sesiones archivadas"><input type="checkbox" id="archtgl"><span>ver archivadas</span><span class="n" id="archn"></span></label>
      <button class="sb-rescan" id="rescan" title="re-importar sesiones del disco al índice">⟳ rescan</button>
      <div class="hint2">click derecho (o ⋯) para acciones · doble-click en un título para renombrar</div>
    </div>
  </aside>
  <div class="resizer" id="resizer" title="arrastrá para redimensionar"></div>
  <div class="col">
  <header>
    <span class="om">Ω</span><span class="nm">omega</span>
    <span class="st"><button class="hbtn" id="bell" title="activar notificaciones">🔕</button><button class="hbtn" id="reveal" title="abrir la carpeta de la sesión en el explorador">carpeta ↗</button><span class="dotc" id="dot"></span><span id="stat">conectando…</span></span>
  </header>
  <div class="tabs" id="tabs">
    <button class="tab active" data-tab="activity">Activity</button>
    <button class="tab" data-tab="diff">Diff</button>
    <button class="tab" data-tab="files">Files</button>
  </div>
  <main id="main">
    <div class="findbar" id="findbar">
      <input type="text" id="findq" placeholder="buscar en la conversación…" autocomplete="off">
      <span class="fcount" id="fcount">0 / 0</span>
      <button class="fbtn" id="fprev" type="button" title="anterior (⇧⏎)">↑</button>
      <button class="fbtn" id="fnext" type="button" title="siguiente (⏎)">↓</button>
      <button class="fbtn" id="fclose" type="button" title="cerrar (Esc)">✕</button>
    </div>
    <div class="thread" id="thread"></div>
    <div class="thinking" id="thinking"><span class="sp"></span><span id="thinkLbl">Pensando…</span><button type="button" class="stopbtn" id="stop">■ detener · Esc</button></div>
    <div class="diffpanel" id="diffpanel">
      <div class="diffbar">
        <input type="text" id="diffbase" placeholder="cambios sin commitear · o una rama/PR: main" autocomplete="off">
        <button class="rf" id="diffrefresh" type="button">↻ refrescar</button>
        <span class="difftot" id="difftot"></span>
      </div>
      <div class="difflayout">
        <div class="difffiles" id="difffiles"></div>
        <div class="diffview" id="diffview"></div>
      </div>
    </div>
    <div class="diffpanel" id="filespanel">
      <div class="diffbar">
        <span class="fscrumb">árbol del workspace</span>
        <button class="rf" id="filesrefresh" type="button">↻ refrescar</button>
      </div>
      <div class="difflayout">
        <div class="difffiles" id="filestree"></div>
        <div class="diffview" id="fileview"></div>
      </div>
    </div>
  </main>
  <form id="form">
    <div class="inbar">
      <textarea id="input" rows="1" placeholder="Escribí una tarea…  (Enter para enviar, Shift+Enter salto de línea)"></textarea>
      <button id="send" type="submit">enviar</button>
    </div>
    <div class="hint" id="hint">Ω omega · frontend web · localhost</div>
  </form>
  </div>

  <div class="toasts" id="toasts"></div>

  <div class="modal-bg" id="modalbg">
    <div class="modal">
      <h3>nueva sesión</h3>
      <div class="modes" id="modes">
        <div class="mode sel" data-mode="shared"><div class="mt">Compartida</div><div class="md">sobre el cwd del server</div></div>
        <div class="mode" data-mode="create"><div class="mt">Worktree nuevo</div><div class="md">Omega crea una branch aislada</div></div>
        <div class="mode" data-mode="attach"><div class="mt">Attach</div><div class="md">a un worktree/dir que ya existe (tree.sh)</div></div>
      </div>
      <div class="fields" id="f-create" style="display:none">
        <div><label>branch (opcional)</label><input type="text" id="i-branch" placeholder="feat/mi-tarea"></div>
        <div><label>base (opcional)</label><input type="text" id="i-base" placeholder="main"></div>
      </div>
      <div class="fields" id="f-attach" style="display:none">
        <div><label>ruta del worktree</label><input type="text" id="i-cwd" list="wtlist" placeholder="/Users/vos/Workspace/…/MED-2050" autocomplete="off"><datalist id="wtlist"></datalist></div>
      </div>
      <div class="acts">
        <button class="btn" id="m-cancel" type="button">cancelar</button>
        <button class="btn primary" id="m-create" type="button">crear</button>
      </div>
    </div>
  </div>

<script>
const GLYPH = { read:"»", outline:"≡", write:"+", edit:"✎", bash:"$", grep:"⌕", tool_search:"⌕", web_fetch:"↗", vision_ask:"◧", ask_user:"?", skill:"◆" };
const CAT = { read:"--tool", outline:"--tool", grep:"--tool", write:"--ok", edit:"--ok", bash:"--warn", web_fetch:"--err", vision_ask:"--err", tool_search:"--human", skill:"--human", ask_user:"--human" };
const $ = (id) => document.getElementById(id);
const thread = $("thread"), main = $("main");
let curAsst = null; // el <div.body> del bubble de asistente en curso

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function atBottom(){ return main.scrollHeight - main.scrollTop - main.clientHeight < 80; }
function scroll(){ main.scrollTop = main.scrollHeight; }

// inline: escapa, luego links, code, bold, italic, tachado. El orden importa
// (links y code antes que bold/italic para no romper su contenido).
function inlineMd(s){
  s = esc(s);
  s = s.replace(/\x60([^\x60]+)\x60/g, (_,c)=>'\x01'+c+'\x02');                 // code (protegido)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_,t,u)=>'<a href="'+u+'" target="_blank" rel="noopener">'+t+'</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, (_,c)=>'<strong>'+c+'</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, (_,p,c)=>p+'<em>'+c+'</em>');    // *itálica*
  s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, (_,p,c)=>p+'<em>'+c+'</em>'); // _énfasis_
  s = s.replace(/~~([^~]+)~~/g, (_,c)=>'<del>'+c+'</del>');
  s = s.replace(/\x01([^\x02]*)\x02/g, (_,c)=>'<code>'+c+'</code>');            // code restaurado
  return s;
}
function splitRow(line){ return line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()); }
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

// Lista (anidada por indentación) desde lines[start]. Devuelve [html, next].
function parseList(lines, start){
  const base = lines[start].match(LIST_RE)[1].length;
  const ordered = /\d/.test(lines[start].match(LIST_RE)[2]);
  let html = ordered ? '<ol>' : '<ul>'; let i = start;
  while(i < lines.length){
    const m = lines[i].match(LIST_RE); if(!m) break;
    const ind = m[1].length;
    if(ind < base) break;
    if(ind === base && /\d/.test(m[2]) !== ordered) break; // cambió ol↔ul → lista nueva
    if(ind > base){ const [sub, ni] = parseList(lines, i); html = html.replace(/<\/li>$/, sub + '</li>'); i = ni; continue; }
    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
    if(task){ const on = task[1].toLowerCase()==='x';
      html += '<li class="task"><input type="checkbox" disabled'+(on?' checked':'')+'> '+inlineMd(task[2])+'</li>'; }
    else html += '<li>'+inlineMd(m[3])+'</li>';
    i++;
  }
  return [html + (ordered ? '</ol>' : '</ul>'), i];
}

// Renderer markdown por bloques (line-based). Cubre headings, hr, blockquote,
// tablas, listas anidadas, code blocks y párrafos; inline vía inlineMd.
function md(t){
  const code = [];
  t = t.replace(/\x60\x60\x60(\w*)\n?([\s\S]*?)\x60\x60\x60/g, (_,lang,c) => {
    const src = c.replace(/\n$/,'');
    if(lang === 'mermaid'){
      code.push('<div class="mermaid-block" data-src="'+encodeURIComponent(src)+'"><pre class="mmsrc"><code>'+esc(src)+'</code></pre></div>');
    } else {
      const cls = lang ? ' class="language-'+lang+'"' : '';
      code.push('<pre><code'+cls+'>'+esc(src)+'</code></pre>');
    }
    return '\x00C'+(code.length-1)+'\x00';
  });
  const lines = t.split('\n');
  const html = []; let para = []; let i = 0;
  const flush = ()=>{ if(para.length){ html.push('<p>'+para.map(inlineMd).join('<br>')+'</p>'); para=[]; } };
  while(i < lines.length){
    const line = lines[i];
    if(/^\x00C\d+\x00$/.test(line.trim())){ flush(); html.push(line.trim()); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ flush(); const n=h[1].length; html.push('<h'+n+'>'+inlineMd(h[2])+'</h'+n+'>'); i++; continue; }
    if(/^\s*([-*_])\1{2,}\s*$/.test(line)){ flush(); html.push('<hr>'); i++; continue; }
    if(/^\s*>\s?/.test(line)){ flush(); const bq=[]; while(i<lines.length && /^\s*>\s?/.test(lines[i])){ bq.push(lines[i].replace(/^\s*>\s?/,'')); i++; } html.push('<blockquote>'+bq.map(inlineMd).join('<br>')+'</blockquote>'); continue; }
    if(line.includes('|') && i+1<lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i+1])){
      flush(); const head=splitRow(line); i+=2; const rows=[];
      while(i<lines.length && lines[i].includes('|') && lines[i].trim()!==''){ rows.push(splitRow(lines[i])); i++; }
      let tb='<table><thead><tr>'+head.map(x=>'<th>'+inlineMd(x)+'</th>').join('')+'</tr></thead><tbody>';
      tb+=rows.map(r=>'<tr>'+r.map(c=>'<td>'+inlineMd(c)+'</td>').join('')+'</tr>').join('');
      html.push(tb+'</tbody></table>'); continue;
    }
    if(LIST_RE.test(line)){ flush(); const [lh, ni]=parseList(lines, i); html.push(lh); i=ni; continue; }
    if(line.trim()===''){ flush(); i++; continue; }
    para.push(line); i++;
  }
  flush();
  return html.join('').replace(/\x00C(\d+)\x00/g, (_,n)=>code[+n]);
}

function addMsg(who, cls){
  const stick = atBottom();
  const m = document.createElement('div'); m.className='msg '+cls;
  const w = document.createElement('div'); w.className='who'; w.textContent=who;
  const b = document.createElement('div'); b.className='body';
  m.appendChild(w); m.appendChild(b); thread.appendChild(m);
  if(stick) scroll();
  return b;
}

function toolArg(name, input){
  input = input || {};
  const short = (s,n=48)=>{ s=String(s); return s.length>n ? s.slice(0,n-1)+'…' : s; };
  if(input.path){ const segs=String(input.path).split('/'); return short(segs.length>3?segs.slice(-2).join('/'):input.path); }
  if(name==='bash') return short(String(input.command||'').replace(/\s+/g,' ').trim(),64);
  if(name==='grep') return short(String(input.pattern||''),24);
  if(name==='web_fetch'){ try{ return new URL(input.url).hostname; }catch{ return short(input.url); } }
  const keys=Object.keys(input).filter(k=>k!=='type'); return keys.length? short(String(input[keys[0]])) : '';
}

function addTool(name, input){
  const stick = atBottom();
  const wrap = document.createElement('div'); wrap.className='tool';
  wrap.style.setProperty('--gl', 'var('+(CAT[name]||'--tool')+')');
  const call = document.createElement('div'); call.className='call';
  call.innerHTML = '<span class="gl">'+(GLYPH[name]||'›')+'</span> '+esc(name)+' <span class="arg">'+esc(toolArg(name,input))+'</span>';
  wrap.appendChild(call); thread.appendChild(wrap);
  if(stick) scroll();
  return wrap;
}

function addToolResult(wrap, output, isError){
  const stick = atBottom();
  const r = document.createElement('div'); r.className='res'+(isError?' err':'');
  const firstLines = String(output||'').split('\n').slice(0,3).join('\n');
  r.textContent = (isError?'✗ ':'= ') + short2(firstLines);
  (wrap||thread).appendChild(r);
  if(stick) scroll();
}
function short2(s){ s=String(s).trim(); return s.length>240? s.slice(0,239)+'…' : s; }

// Renderiza los bloques mermaid pendientes (al finalizar el mensaje, no en
// streaming: un grafo a medias no compila). Si mermaid no cargó, quedan como código.
async function hydrateMermaid(){
  if(!window.mermaid) return;
  for(const el of document.querySelectorAll('.mermaid-block:not([data-done])')){
    const src = decodeURIComponent(el.getAttribute('data-src')||'');
    try {
      const { svg } = await mermaid.render('mm'+Math.random().toString(36).slice(2), src);
      el.innerHTML = svg; el.setAttribute('data-done','1');
    } catch { el.setAttribute('data-done','err'); }
  }
}

// Syntax highlight con highlight.js (si cargó). Al finalizar, no en streaming.
function hydrateCode(){
  if(!window.hljs) return;
  for(const el of document.querySelectorAll('pre:not(.mmsrc) code:not([data-hl])')){
    try { hljs.highlightElement(el); } catch {}
    el.setAttribute('data-hl','1');
  }
}
function hydrate(){ hydrateMermaid(); hydrateCode(); }

// ── SSE + sesiones ────────────────────────────────────────────────
let lastTool = null;
let current = null;   // id de la sesión activa
let es = null;        // EventSource de la sesión activa
let findMatches = [], findIdx = -1; // estado del buscador in-convo (declarado acá para evitar TDZ desde resetThread)
let ges = null;       // EventSource GLOBAL (/events/all): atención de todas las sesiones
let notifsEnabled = localStorage.getItem('omega.notifs') === '1';
const attention = new Set(); // ids de sesiones que te reclaman (badge + resalte)

// Agrega ?session=<id> a una ruta (cada request va contra la sesión activa).
function q(p){ return p + (p.indexOf('?')>=0?'&':'?') + 'session=' + encodeURIComponent(current); }

function openES(){
  if(es) es.close();
  es = new EventSource(q('/events'));
  es.onopen = ()=>{ $("dot").classList.add('on'); $("stat").textContent='conectado'; };
  es.onerror = ()=>{ $("dot").classList.remove('on'); $("stat").textContent='reconectando…'; };
  es.onmessage = (e)=>{
  let ev; try { ev = JSON.parse(e.data); } catch { return; }
  switch(ev.type){
    case 'ready': $("stat").textContent = ev.model; loadSessions(); break;
    case 'status': loadSessions(); break;
    case 'history': {
      // Replay del transcript al conectar/cambiar de sesión: pinta cada ítem con
      // las mismas funciones que los eventos vivos.
      for(const it of (ev.items || [])){
        if(it.kind==='user'){ addMsg('vos','user').textContent = it.text; }
        else if(it.kind==='assistant'){ const b=addMsg('omega','asst'); b.dataset.raw=it.text; b.innerHTML=md(it.text); }
        else if(it.kind==='tool_use'){ lastTool = addTool(it.name, it.input); }
        else if(it.kind==='tool_result'){ addToolResult(lastTool, it.output, it.isError); lastTool=null; }
      }
      hydrate(); scroll();
      break;
    }
    case 'turn_start': $("thinking").classList.add('on'); curAsst=null; scroll(); break;
    case 'delta':
      if(!curAsst) curAsst = addMsg('omega','asst');
      curAsst.dataset.raw = (curAsst.dataset.raw||'') + ev.text;
      curAsst.innerHTML = md(curAsst.dataset.raw);
      if(atBottom()) scroll();
      break;
    case 'assistant_end': curAsst=null; hydrate(); break;
    case 'assistant': { const b=addMsg('omega','asst'); b.dataset.raw=ev.text; b.innerHTML=md(ev.text); hydrate(); break; }
    case 'tool_use': lastTool = addTool(ev.name, ev.input); break;
    case 'tool_result': addToolResult(lastTool, ev.output, ev.isError); lastTool=null; break;
    case 'turn_end': $("thinking").classList.remove('on'); curAsst=null; hydrate(); break;
    case 'metrics': {
      const c = ev.turnCost<0.01?'<$0.01':'$'+ev.turnCost.toFixed(2);
      const m=document.createElement('div'); m.className='metrics';
      m.textContent = '~ '+(ev.durationMs/1000).toFixed(1)+'s · '+ev.toolCalls+' tools · '+c+' (total $'+ev.totalCost.toFixed(2)+')';
      thread.appendChild(m); if(atBottom()) scroll(); break;
    }
    case 'ask_user': {
      $("thinking").classList.remove('on');
      const b=addMsg('omega · pregunta','asst'); b.innerHTML=md(ev.question);
      $("input").focus(); $("hint").textContent='↑ el agente te está preguntando — respondé abajo'; break;
    }
    case 'notify': { const n=document.createElement('div'); n.className='sys'; n.textContent=ev.text; thread.appendChild(n); if(atBottom()) scroll(); break; }
  }
  };
}

// Limpia el hilo al cambiar de sesión (los eventos pasados no se re-emiten: el
// hub no bufferea historial; ves la sesión desde el próximo evento).
function resetThread(){ thread.innerHTML=''; curAsst=null; lastTool=null; $("thinking").classList.remove('on'); findMatches=[]; findIdx=-1; if($("findbar").classList.contains('on')) $("fcount").textContent='0 / 0'; }

function selectSession(id, force){
  if(!force && id===current && es) return;
  current = id;
  clearAttention(id); // entrar a una sesión = ya la viste, sacala del badge
  resetThread();
  setTab('activity'); // al entrar a una sesión, arrancás en el chat
  openES();
  loadSessions(true); // fuerza el render para mover el highlight a la nueva
}

// ── Tabs de la sesión (Activity / Diff / Files) ──
let activeTab = 'activity';
function setTab(name){
  activeTab = name;
  const isActivity = name === 'activity';
  // El chat (thread + input) solo en Activity; los otros paneles son full.
  $("thread").style.display = isActivity ? '' : 'none';
  $("form").style.display = isActivity ? '' : 'none';
  if(!isActivity) $("thinking").classList.remove('on');
  $("diffpanel").classList.toggle('on', name === 'diff');
  $("filespanel").classList.toggle('on', name === 'files');
  document.querySelectorAll('#tabs .tab').forEach(function(t){ t.classList.toggle('active', t.getAttribute('data-tab')===name); });
  if(name === 'diff') loadDiff();
  if(name === 'files') loadFiles();
}

async function loadDiff(){
  $("difffiles").innerHTML = '<div class="diffempty">cargando…</div>';
  $("diffview").innerHTML = '';
  const base = $("diffbase").value.trim();
  try {
    const r = await fetch(q('/diff') + (base ? '&base=' + encodeURIComponent(base) : ''));
    if(!r.ok){ $("difffiles").innerHTML = '<div class="diffempty">no se pudo cargar (HTTP ' + r.status + ')</div>'; return; }
    renderDiff(await r.json());
  } catch(_){ $("difffiles").innerHTML = '<div class="diffempty">error de red cargando el diff</div>'; }
}

let diffData = null;
const STSYM = { added:'A', modified:'M', deleted:'D', renamed:'R' };
function renderDiff(d){
  diffData = d;
  const files = $("difffiles"), view = $("diffview");
  files.innerHTML = ''; view.innerHTML = '';
  $("difftot").innerHTML = d.files.length
    ? d.files.length + ' archivo' + (d.files.length>1?'s':'') + ' · <span class="ad">+' + d.totals.additions + '</span> <span class="de">−' + d.totals.deletions + '</span>'
    : '';
  if(!d.files.length){
    files.innerHTML = '<div class="diffempty">' + (d.base ? 'sin cambios vs ' + esc(d.base) : 'sin cambios sin commitear') + '</div>';
    return;
  }
  d.files.forEach(function(f, i){
    const path = f.oldPath ? (f.oldPath + ' → ' + f.path) : f.path;
    const row = document.createElement('div'); row.className = 'dfrow'; row.dataset.i = i; row.title = path;
    row.innerHTML = '<span class="st ' + f.status + '">' + (STSYM[f.status]||'?') + '</span>'
      + '<span class="pth">' + esc(path) + '</span>'
      + '<span class="cnt"><span class="ad">+' + f.additions + '</span> <span class="de">−' + f.deletions + '</span></span>';
    row.onclick = function(){ selectFile(i); };
    files.appendChild(row);
  });
  selectFile(0); // el primer archivo abierto por default
}

function selectFile(i){
  const f = diffData && diffData.files[i];
  if(!f) return;
  document.querySelectorAll('#difffiles .dfrow').forEach(function(r){ r.classList.toggle('sel', Number(r.dataset.i) === i); });
  const view = $("diffview"); view.innerHTML = '';
  const hd = document.createElement('div'); hd.className = 'vhd';
  hd.textContent = (f.oldPath ? f.oldPath + ' → ' + f.path : f.path) + '  (+' + f.additions + ' −' + f.deletions + ')';
  view.appendChild(hd);
  const pre = document.createElement('pre');
  if(f.binary){ const l=document.createElement('span'); l.className='ln ctx'; l.textContent='  (archivo binario)'; pre.appendChild(l); }
  else pre.appendChild(renderPatch(f.patch));
  view.appendChild(pre);
  view.scrollTop = 0;
}

// Pinta un parche unificado línea por línea. Salta el header del archivo (diff
// --git / index / --- / +++) hasta el primer hunk (@@).
function renderPatch(patch){
  const frag = document.createDocumentFragment();
  let started = false;
  for(const line of String(patch).split('\n')){
    if(!started){ if(line.startsWith('@@')) started = true; else continue; }
    const span = document.createElement('span');
    let cls = 'ln ';
    if(line.startsWith('@@')) cls += 'hnk';
    else if(line.startsWith('+')) cls += 'add';
    else if(line.startsWith('-')) cls += 'del';
    else cls += 'ctx';
    span.className = cls;
    span.textContent = line.length ? line : ' ';
    frag.appendChild(span);
  }
  return frag;
}

// ── File explorer (árbol lazy expandible, tipo VSCode) ──
let fsTree = [];        // nodos raíz: {name, type, path, size, expanded, children}
let fsSelected = null;  // path del archivo abierto (para el highlight)

// Trae las entradas de un dir y las envuelve en nodos del árbol (children lazy).
async function fetchDir(path){
  const r = await fetch(q('/files') + '&path=' + encodeURIComponent(path || ''));
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return d.entries.map(function(e){
    return { name: e.name, type: e.type, path: (path ? path + '/' : '') + e.name, size: e.size, expanded: false, children: null };
  });
}

async function loadFiles(){
  $("filestree").innerHTML = '<div class="diffempty">cargando…</div>';
  try { fsTree = await fetchDir(''); renderTree(); }
  catch(_){ $("filestree").innerHTML = '<div class="diffempty">no se pudo listar</div>'; }
}

// Expande/colapsa un dir IN-PLACE (carga sus hijos la primera vez). No pierde
// el resto del árbol — es lo que lo hace un árbol y no navegación por columnas.
async function toggleDir(node){
  if(!node.expanded && node.children === null){
    try { node.children = await fetchDir(node.path); } catch(_){ node.children = []; }
  }
  node.expanded = !node.expanded;
  renderTree();
}

function renderTree(){
  const tree = $("filestree"); tree.innerHTML = '';
  if(!fsTree.length){ tree.innerHTML = '<div class="diffempty">(vacío)</div>'; return; }
  const walk = function(nodes, depth){
    nodes.forEach(function(n){
      const row = document.createElement('div');
      row.className = 'fsrow ' + n.type + (n.path === fsSelected ? ' sel' : '');
      row.style.paddingLeft = (10 + depth * 15) + 'px'; // indentación por profundidad
      const chev = n.type === 'dir' ? (n.expanded ? '▾' : '▸') : '·';
      row.innerHTML = '<span class="ic">' + chev + '</span><span class="nm">' + esc(n.name) + '</span>'
        + (n.type === 'file' ? '<span class="sz">' + fmtSize(n.size) + '</span>' : '');
      row.onclick = function(){
        if(n.type === 'dir'){ toggleDir(n); }
        else { fsSelected = n.path; renderTree(); loadFile(n.path); }
      };
      tree.appendChild(row);
      if(n.type === 'dir' && n.expanded && n.children){ walk(n.children, depth + 1); } // recursivo
    });
  };
  walk(fsTree, 0);
}
function fmtSize(n){ return n < 1024 ? n + 'b' : n < 1048576 ? (n/1024).toFixed(0) + 'k' : (n/1048576).toFixed(1) + 'M'; }
async function loadFile(path){
  const view = $("fileview"); view.innerHTML = '<div class="diffempty">cargando…</div>';
  try {
    const r = await fetch(q('/file') + '&path=' + encodeURIComponent(path));
    if(!r.ok){ view.innerHTML = '<div class="diffempty">no se pudo abrir (HTTP ' + r.status + ')</div>'; return; }
    const f = await r.json();
    view.innerHTML = '';
    const hd = document.createElement('div'); hd.className = 'vhd'; hd.textContent = f.path + (f.truncated ? '  (truncado)' : '');
    view.appendChild(hd);
    const pre = document.createElement('pre'); const code = document.createElement('code');
    code.textContent = f.binary ? '(archivo binario)' : f.content;
    pre.appendChild(code); view.appendChild(pre);
    if(!f.binary && window.hljs){ try { hljs.highlightElement(code); } catch(_){} }
    view.scrollTop = 0;
  } catch(_){ view.innerHTML = '<div class="diffempty">error de red</div>'; }
}

// ── Notificaciones globales (SSE /events/all: atención de TODAS las sesiones) ──
function updateBadge(){ document.title = (attention.size ? '(' + attention.size + ') ' : '') + 'Ω omega'; }
function clearAttention(id){ if(attention.delete(id)){ updateBadge(); renderSessions(lastList); } }
function updateBellUi(){
  $("bell").textContent = notifsEnabled ? '🔔' : '🔕';
  $("bell").title = notifsEnabled ? 'notificaciones activadas (click para silenciar)' : 'activar notificaciones del browser';
}
function onAttention(ev){
  // No molestar si estás mirando ESA sesión con la pestaña enfocada: ya la ves.
  if(ev.sessionId === current && document.hasFocus()) return;
  attention.add(ev.sessionId); updateBadge();
  loadSessions(true); // refresca el dot del sidebar (waiting/idle)
  showToast(ev);      // toast in-app: SIEMPRE (cero permisos, la base confiable)
  // Notificación de escritorio: bonus, solo si activaste 🔔 y el permiso está dado.
  if(notifsEnabled && window.Notification && Notification.permission === 'granted'){
    const needsInput = ev.kind === 'ask_user';
    const title = (ev.title || 'omega') + ' — ' + (needsInput ? 'necesita input' : 'listo');
    const body = needsInput ? (ev.question || 'El agente te hizo una pregunta') : 'Terminó el turno';
    try {
      const n = new Notification(title, { body: String(body).slice(0,160), tag: ev.sessionId });
      n.onclick = function(){ window.focus(); selectSession(ev.sessionId, true); n.close(); };
    } catch(_){}
  }
}

// Toast in-app: cartelito arriba a la derecha. No necesita permiso del browser ni
// del SO — funciona siempre que tengas la pestaña abierta. Click → salta a la sesión.
function showToast(ev){
  const needsInput = ev.kind === 'ask_user';
  const t = document.createElement('div'); t.className = 'toast' + (needsInput ? '' : ' done');
  const head = document.createElement('div'); head.className = 'tt';
  const label = document.createElement('span');
  label.textContent = (ev.title || 'omega') + ' · ' + (needsInput ? 'necesita input' : 'listo');
  const close = document.createElement('span'); close.className = 'xx'; close.textContent = '✕';
  head.appendChild(label); head.appendChild(close);
  const body = document.createElement('div'); body.className = 'tb';
  body.textContent = needsInput ? (ev.question || 'te hizo una pregunta') : 'terminó el turno';
  t.appendChild(head); t.appendChild(body);
  const dismiss = function(){ t.remove(); };
  t.onclick = function(){ selectSession(ev.sessionId, true); window.focus(); dismiss(); };
  close.onclick = function(e){ e.stopPropagation(); dismiss(); };
  $("toasts").appendChild(t);
  setTimeout(dismiss, 6000); // auto-dismiss
}
function openGlobalES(){
  if(ges) ges.close();
  ges = new EventSource('/events/all');
  ges.onmessage = function(e){
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if(ev.type === 'attention') onAttention(ev);
  };
  // EventSource reconecta solo; nada que hacer en onerror.
}
// Si volvés a la pestaña mirando una sesión que reclamaba, limpiá su marca.
window.addEventListener('focus', function(){ if(current) clearAttention(current); });

function projName(p){ const a = String(p||'').split('/'); return a[a.length-1] || p || '(sin proyecto)'; }

function renderRow(s){
  const it = document.createElement('div');
  const stCls = (s.live && s.status) ? (' st-' + s.status) : '';
  // .att = necesita tu atención (terminó o preguntó) — color, no posición.
  const att = attention.has(s.id) ? ' att' : '';
  it.className = 'sb-item' + (s.id===current ? ' active' : '') + (s.live ? '' : ' dormant') + (s.archived ? ' archived' : '') + att + stCls;
  it.dataset.sid = s.id;
  it.onclick = function(){ selectSession(s.id); };
  // Click derecho → menú contextual de acciones del workspace (estilo cmux).
  it.oncontextmenu = function(e){ e.preventDefault(); e.stopPropagation(); openCtxMenu(e.clientX, e.clientY, s); };

  // Drag-and-drop para reordenar (click and hold).
  it.draggable = true;
  it.ondragstart = function(e){ dragId = s.id; it.classList.add('dragging'); if(e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; };
  it.ondragend = function(){ it.classList.remove('dragging'); document.querySelectorAll('.sb-item.dragover').forEach(function(x){ x.classList.remove('dragover'); }); };
  it.ondragover = function(e){ if(dragId && dragId!==s.id){ e.preventDefault(); it.classList.add('dragover'); } };
  it.ondragleave = function(){ it.classList.remove('dragover'); };
  it.ondrop = function(e){ e.preventDefault(); it.classList.remove('dragover'); if(dragId && dragId!==s.id) reorderSessions(dragId, s.id); dragId = null; };

  const nm = document.createElement('div'); nm.className='nm';
  const dot = document.createElement('span'); dot.className='pdot';
  const tt = document.createElement('span'); tt.className='tt'; tt.textContent = s.title;
  tt.title = 'doble-click para renombrar · click derecho para más';
  tt.ondblclick = function(e){ e.stopPropagation(); startRename(it, nm, tt, s); };
  nm.appendChild(dot); nm.appendChild(tt);

  const meta = document.createElement('div'); meta.className='meta';
  // La branch es la identidad del workspace; el ESTADO (corriendo/esperás/dormida)
  // lo comunica el color del dot, no texto. Compartida (sin worktree) no tiene branch.
  const where = s.branch ? '⎇ ' + esc(s.branch) : (s.isolated ? '⎇ aislada' : '· compartida');
  meta.innerHTML = '<span class="s">' + where + '</span>';
  if(s.live && s.clients) meta.innerHTML += ' · ' + s.clients + ' ◉';
  it.appendChild(nm); it.appendChild(meta);

  // Kebab (⋯): mismo menú que el click derecho, para quien no piensa en click-derecho.
  const acts = document.createElement('div'); acts.className='acts';
  const kb = document.createElement('button'); kb.className='kebab'; kb.textContent='⋯'; kb.title='acciones';
  kb.onclick = function(e){ e.stopPropagation(); const r = kb.getBoundingClientRect(); openCtxMenu(r.right, r.bottom + 4, s, true); };
  acts.appendChild(kb);
  it.appendChild(acts);
  return it;
}

// Rename inline: el <span.tt> se reemplaza por un input; Enter confirma (PATCH),
// Esc/blur cancela. Local e instantáneo, sin recargar toda la lista.
function startRename(it, nm, tt, s){
  const inp = document.createElement('input'); inp.type='text'; inp.value = s.title;
  tt.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const cancel = function(){ if(done) return; done=true; inp.replaceWith(tt); };
  const commit = async function(){
    if(done) return; const val = inp.value.trim();
    if(!val || val===s.title){ cancel(); return; }
    done = true;
    try {
      const r = await fetch('/sessions?session=' + encodeURIComponent(s.id), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title:val}) });
      if(r.ok){ const d = await r.json(); tt.textContent = d.title; s.title = d.title; }
    } catch(_){}
    inp.replaceWith(tt); loadSessions(true);
  };
  inp.onclick = function(e){ e.stopPropagation(); };
  inp.onkeydown = function(e){ e.stopPropagation();
    if(e.key==='Enter'){ e.preventDefault(); commit(); }
    else if(e.key==='Escape'){ e.preventDefault(); cancel(); } };
  inp.onblur = commit;
}

async function archiveSession(id, archived){
  try { await fetch('/archive?session=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({archived}) }); } catch(_){}
  loadSessions(true);
}

// Reordena: mueve la sesión arrastrada a la posición del target. Optimista
// (re-render ya) + persiste el orden nuevo en el server; el poll ya lo trae.
async function reorderSessions(fromId, toId){
  const ids = lastList.map(function(s){ return s.id; });
  const fi = ids.indexOf(fromId), ti = ids.indexOf(toId);
  if(fi < 0 || ti < 0) return;
  ids.splice(ti, 0, ids.splice(fi, 1)[0]);      // mover from → antes de to
  const byId = {}; lastList.forEach(function(s){ byId[s.id] = s; });
  lastList = ids.map(function(id){ return byId[id]; });
  renderSessions(lastList);                       // optimista
  try { await fetch('/reorder', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ids }) }); } catch(_){}
}

// ── Menú contextual del workspace (click derecho o kebab ⋯) ──
function closeCtxMenu(){ const m = $("ctxmenu"); if(m) m.remove(); }
function openCtxMenu(x, y, s, alignRight){
  closeCtxMenu();
  const menu = document.createElement('div'); menu.className='ctxmenu'; menu.id='ctxmenu';
  const hd = document.createElement('div'); hd.className='cihd'; hd.textContent = s.title; menu.appendChild(hd);
  const item = function(label, hint, fn, danger){
    const el = document.createElement('div'); el.className = 'ci' + (danger?' danger':'');
    el.innerHTML = '<span>' + esc(label) + '</span>' + (hint ? '<span class="k">'+hint+'</span>' : '');
    el.onclick = function(e){ e.stopPropagation(); closeCtxMenu(); fn(); };
    menu.appendChild(el);
  };
  const sep = function(){ const d = document.createElement('div'); d.className='cisep'; menu.appendChild(d); };

  item('Renombrar…', '', function(){ renameFromMenu(s); });
  item(s.archived ? 'Desarchivar' : 'Archivar', '', function(){ archiveSession(s.id, !s.archived); });
  if(s.live) item('Dormir', '', function(){ closeSession(s.id); });
  else       item('Revivir', '', function(){ selectSession(s.id); });
  sep();
  item('Abrir carpeta', '', function(){ fetch('/reveal?session=' + encodeURIComponent(s.id), { method:'POST' }).catch(function(){}); });
  item('Copiar ID', '', function(){ if(navigator.clipboard) navigator.clipboard.writeText(s.id).catch(function(){}); });

  document.body.appendChild(menu);
  // Clamp al viewport. Desde el kebab (alignRight) anclamos por la derecha del botón.
  const r = menu.getBoundingClientRect();
  let px = alignRight ? x - r.width : x;
  px = Math.max(8, Math.min(px, window.innerWidth - r.width - 8));
  let py = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  menu.style.left = px + 'px'; menu.style.top = py + 'px';
}
// El rename inline necesita el <span.tt> de la fila: lo ubicamos por data-sid.
function renameFromMenu(s){
  const it = document.querySelector('.sb-item[data-sid="' + s.id + '"]');
  if(!it) return;
  const nm = it.querySelector('.nm'), tt = nm && nm.querySelector('.tt');
  if(nm && tt) startRename(it, nm, tt, s);
}
// Cerrar el menú: click en cualquier lado, scroll de la lista, resize.
window.addEventListener('click', closeCtxMenu);
window.addEventListener('resize', closeCtxMenu);
$("sblist").addEventListener('scroll', closeCtxMenu);

let sbFilter = '';       // texto del buscador de workspaces
let showArchived = false; // toggle "ver archivadas"
let lastList = [];        // última lista del server (para re-filtrar sin fetch)
let dragId = null;        // id de la sesión que estás arrastrando (reorder)

// ¿La sesión matchea el buscador? (título · proyecto · branch, case-insensitive)
function matchFilter(s){
  if(!sbFilter) return true;
  const hay = (s.title + ' ' + projName(s.project) + ' ' + (s.branch||'')).toLowerCase();
  return sbFilter.split(/\s+/).every(function(t){ return hay.indexOf(t) >= 0; });
}

function renderSessions(list){
  lastList = list;
  const archivedCount = list.filter(function(s){ return s.archived; }).length;
  $("archn").textContent = archivedCount ? '(' + archivedCount + ')' : '';

  // Filtro: archivadas fuera salvo toggle; después el texto del buscador.
  const shown = list.filter(function(s){ return (showArchived || !s.archived) && matchFilter(s); });

  const box = $("sblist"); box.innerHTML='';
  if(!shown.length){
    const empty = document.createElement('div'); empty.className='hint2'; empty.style.padding='14px 10px';
    empty.textContent = sbFilter ? 'sin workspaces que matcheen «' + sbFilter + '»' : 'no hay sesiones';
    box.appendChild(empty); return;
  }
  // Agrupar por proyecto preservando el orden (vivas primero ya viene del server).
  const order = []; const byProj = {};
  shown.forEach(function(s){
    const key = s.project || '(sin proyecto)';
    if(!byProj[key]){ byProj[key] = []; order.push(key); }
    byProj[key].push(s);
  });
  order.forEach(function(key){
    const hd = document.createElement('div'); hd.className='sb-grp';
    const nm = document.createElement('span'); nm.textContent = projName(key);
    const ln = document.createElement('span'); ln.className='ln';
    hd.appendChild(nm); hd.appendChild(ln);
    box.appendChild(hd);
    byProj[key].forEach(function(s){ box.appendChild(renderRow(s)); });
  });
}

let lastSig = '';
async function loadSessions(force){
  try {
    const r = await fetch('/sessions'); const d = await r.json();
    if(!current) current = d.default;
    // Solo re-renderizamos si algo cambió (o si se fuerza) — así el poll no
    // rompe el hover ni parpadea el sidebar cuando no pasó nada.
    const sig = current + '|' + showArchived + '|' + sbFilter + '|' + d.sessions.map(function(s){ return [s.id,s.live,s.status,s.clients,s.title,s.archived].join(','); }).join(';');
    if(force || sig!==lastSig){ lastSig = sig; renderSessions(d.sessions); }
  } catch(_){}
}
// Poll liviano: refresca estados de TODAS las sesiones (las que no estás mirando).
setInterval(function(){ loadSessions(); }, 4000);

// ── Modal de nueva sesión (compartida / worktree nuevo / attach) ──
let modalMode = 'shared';
function syncModal(){
  const modes = document.querySelectorAll('#modes .mode');
  for(const el of modes) el.classList.toggle('sel', el.getAttribute('data-mode')===modalMode);
  $("f-create").style.display = modalMode==='create' ? 'flex' : 'none';
  $("f-attach").style.display = modalMode==='attach' ? 'flex' : 'none';
}
function openModal(){ modalMode='shared'; syncModal(); loadWorktrees(); $("modalbg").classList.add('on'); }
function closeModal(){ $("modalbg").classList.remove('on'); }

// Sugerencias para el modo attach: tus worktrees reales del repo.
async function loadWorktrees(){
  try {
    const r = await fetch('/worktrees'); const d = await r.json();
    const dl = $("wtlist"); dl.innerHTML='';
    (d.worktrees||[]).forEach(function(w){
      const o = document.createElement('option'); o.value = w.path;
      if(w.branch) o.label = w.branch;
      dl.appendChild(o);
    });
  } catch(_){}
}

for(const el of document.querySelectorAll('#modes .mode')){
  el.onclick = function(){ modalMode = el.getAttribute('data-mode'); syncModal(); };
}
$("m-cancel").addEventListener('click', closeModal);
$("modalbg").addEventListener('click', function(e){ if(e.target===$("modalbg")) closeModal(); });
$("m-create").addEventListener('click', doCreateSession);

async function doCreateSession(){
  const payload = { mode: modalMode };
  if(modalMode==='create'){
    payload.branch = $("i-branch").value.trim() || undefined;
    payload.base = $("i-base").value.trim() || undefined;
  }
  if(modalMode==='attach'){
    const cwd = $("i-cwd").value.trim();
    if(!cwd){ $("i-cwd").focus(); return; }
    payload.cwd = cwd;
  }
  try {
    const r = await fetch('/sessions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if(!r.ok){ const e = await r.json().catch(function(){return{};}); alert('No se pudo crear: ' + (e.error||('HTTP '+r.status))); return; }
    const s = await r.json();
    closeModal();
    await loadSessions();
    selectSession(s.id, true);
  } catch(_){ alert('Error de red creando la sesión'); }
}

async function closeSession(id){
  const wasCurrent = (id === current);
  try { await fetch('/sessions?session=' + encodeURIComponent(id), { method:'DELETE' }); } catch(_){}
  if(wasCurrent){ current = null; await loadSessions(); selectSession(current, true); }
  else { loadSessions(); }
}

// Buscar workspaces: filtra la lista en vivo (client-side, ya la tenemos).
$("sbfilter").addEventListener('input', function(){ sbFilter = $("sbfilter").value.trim().toLowerCase(); renderSessions(lastList); });
$("sbfilter").addEventListener('keydown', function(e){ e.stopPropagation();
  if(e.key==='Escape'){ $("sbfilter").value=''; sbFilter=''; renderSessions(lastList); $("sbfilter").blur(); } });
$("archtgl").addEventListener('change', function(){ showArchived = $("archtgl").checked; renderSessions(lastList); });

$("sbnew").addEventListener('click', openModal);
$("reveal").addEventListener('click', function(){ if(current) fetch(q('/reveal'), { method:'POST' }).catch(function(){}); });
$("rescan").addEventListener('click', async function(){ try{ await fetch('/rescan', { method:'POST' }); await loadSessions(true); } catch(_){} });

// Toggle de notificaciones. El prompt del browser SOLO aparece si el permiso está
// en "default"; si ya está "denied" no muestra nada → damos instrucciones claras.
$("bell").addEventListener('click', async function(){
  if(notifsEnabled){ // ya activas → silenciar
    notifsEnabled = false; localStorage.setItem('omega.notifs','0'); updateBellUi(); return;
  }
  if(!window.Notification){ alert('Este browser no soporta la Notification API.'); return; }
  let perm = Notification.permission;
  if(perm === 'default') perm = await Notification.requestPermission(); // acá aparece el prompt
  if(perm !== 'granted'){
    alert(
      'Notificaciones bloqueadas (permiso actual: "' + perm + '").\n\n' +
      'No aparece prompt porque el browser ya lo tiene decidido. Para habilitarlas:\n\n' +
      '• Arc: clic en el escudo/candado a la izquierda de la URL → Notificaciones → Permitir.\n' +
      '• macOS: Ajustes del Sistema → Notificaciones → Arc → activado.\n\n' +
      'Después reintentá el 🔔.'
    );
    return;
  }
  notifsEnabled = true; localStorage.setItem('omega.notifs','1'); updateBellUi();
  // Confirmación VISIBLE: si ves esta notificación, todo el pipeline anda.
  try { new Notification('Ω omega', { body: 'Notificaciones activadas ✓', tag: 'omega-test' }); }
  catch(_){ alert('Permiso concedido, pero el SO no mostró la notificación de prueba. Revisá Ajustes → Notificaciones → Arc en macOS.'); }
});
updateBellUi();

// Tabs + diff.
document.querySelectorAll('#tabs .tab').forEach(function(t){ t.addEventListener('click', function(){ setTab(t.getAttribute('data-tab')); }); });
$("diffrefresh").addEventListener('click', loadDiff);
$("diffbase").addEventListener('keydown', function(e){ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); loadDiff(); } });
$("filesrefresh").addEventListener('click', function(){ loadFiles(); });

// Boot: descubrí las sesiones, elegí la default, abrí su stream + el SSE global.
(async function(){ await loadSessions(); openES(); openGlobalES(); })();

// ── Input ────────────────────────────────────────────────────────
const input = $("input");
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,180)+'px'; });
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); $("form").requestSubmit(); }});
$("form").addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = input.value.trim(); if(!text) return;
  addMsg('vos','user').textContent = text;
  input.value=''; input.style.height='auto'; $("hint").textContent='Ω omega · frontend web · localhost'; scroll();
  await fetch(q('/input'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) });
});
input.focus();

// ── Interrupción: Esc o el botón "detener" cortan el turno en curso ──
async function interrupt(){
  if(!$("thinking").classList.contains('on')) return;
  $("thinking").classList.remove('on');
  try { await fetch(q('/interrupt'), { method:'POST' }); } catch {}
}
$("stop").addEventListener('click', interrupt);

// ── Resize del sidebar (arrastrable · persistido en localStorage) ──
(function(){
  const KEY='omega.sbw';
  const saved = parseInt(localStorage.getItem(KEY)||'', 10);
  if(saved>=160 && saved<=560) document.documentElement.style.setProperty('--sbw', saved+'px');
  const rz = $("resizer"); let dragging=false;
  rz.addEventListener('pointerdown', function(e){ dragging=true; rz.classList.add('drag'); document.body.classList.add('resizing'); rz.setPointerCapture(e.pointerId); });
  rz.addEventListener('pointermove', function(e){
    if(!dragging) return;
    const w = Math.max(160, Math.min(560, e.clientX)); // clientX = ancho deseado (sidebar arranca en x=0)
    document.documentElement.style.setProperty('--sbw', w+'px');
  });
  const end = function(){ if(!dragging) return; dragging=false; rz.classList.remove('drag'); document.body.classList.remove('resizing');
    const w = parseInt(getComputedStyle(document.querySelector('.sidebar')).width, 10); if(w) localStorage.setItem(KEY, String(w)); };
  rz.addEventListener('pointerup', end); rz.addEventListener('pointercancel', end);
})();

// ── Buscar dentro de la conversación (Ctrl-F / ⌘-F) ──
// Client-side: el hilo ya está en el DOM. Envuelve los matches en <mark>, navega
// con ⏎/⇧⏎, resalta el actual. Al cerrar, desenvuelve y restaura el texto.
// (findMatches/findIdx se declaran arriba, con el resto del estado.)
function clearFind(){
  for(const m of thread.querySelectorAll('mark.find')) m.replaceWith(document.createTextNode(m.textContent));
  thread.normalize();
  findMatches = []; findIdx = -1; $("fcount").textContent='0 / 0';
}
function focusMatch(){
  findMatches.forEach(function(m,i){ m.classList.toggle('cur', i===findIdx); });
  const m = findMatches[findIdx];
  if(m){ m.scrollIntoView({block:'center', behavior:'smooth'}); $("fcount").textContent=(findIdx+1)+' / '+findMatches.length; }
}
function runFind(q){
  clearFind();
  if(!q){ return; }
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n; while((n = walker.nextNode())) nodes.push(n);
  for(const node of nodes){
    const text = node.nodeValue, low = text.toLowerCase();
    let idx = low.indexOf(needle); if(idx<0) continue;
    const frag = document.createDocumentFragment(); let pos = 0;
    while(idx>=0){
      if(idx>pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mk = document.createElement('mark'); mk.className='find'; mk.textContent = text.slice(idx, idx+q.length);
      frag.appendChild(mk); findMatches.push(mk);
      pos = idx + q.length; idx = low.indexOf(needle, pos);
    }
    if(pos<text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
  if(findMatches.length){ findIdx=0; focusMatch(); } else $("fcount").textContent='0 / 0';
}
function stepFind(d){ if(!findMatches.length) return; findIdx=(findIdx+d+findMatches.length)%findMatches.length; focusMatch(); }
function openFind(){ $("findbar").classList.add('on'); const q=$("findq"); q.focus(); q.select(); if(q.value) runFind(q.value); }
function closeFind(){ $("findbar").classList.remove('on'); clearFind(); $("findq").blur(); }
$("findq").addEventListener('input', function(){ runFind($("findq").value); });
$("findq").addEventListener('keydown', function(e){ e.stopPropagation();
  if(e.key==='Enter'){ e.preventDefault(); stepFind(e.shiftKey?-1:1); }
  else if(e.key==='Escape'){ e.preventDefault(); closeFind(); } });
$("fnext").addEventListener('click', function(){ stepFind(1); });
$("fprev").addEventListener('click', function(){ stepFind(-1); });
$("fclose").addEventListener('click', closeFind);

// Esc/Ctrl-F globales. Prioridad de Esc: find → modal → interrumpir.
window.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && (e.key==='f'||e.key==='F')){ e.preventDefault(); openFind(); return; }
  if(e.key==='Escape'){
    if($("ctxmenu")){ closeCtxMenu(); return; }
    if($("findbar").classList.contains('on')){ closeFind(); return; }
    if($("modalbg").classList.contains('on')){ closeModal(); return; }
    interrupt();
  }
});
</script>
</body>
</html>`;
