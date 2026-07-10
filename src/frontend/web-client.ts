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

  /* Sidebar de sesiones (multi-sesión) */
  .sidebar { width:236px; flex-shrink:0; background:var(--surface); border-right:1px solid var(--border);
             display:flex; flex-direction:column; height:100%; }
  .sb-hd { display:flex; align-items:center; gap:8px; padding:13px 13px 11px; border-bottom:1px solid var(--border); }
  .sb-hd .t { font-family:var(--mono); letter-spacing:0.2em; text-transform:uppercase; font-size:10.5px; color:var(--dim); }
  .sb-new { margin-left:auto; background:var(--surface2); color:var(--tool); border:1px solid var(--border);
            border-radius:7px; height:26px; padding:0 9px; font-family:var(--mono); font-size:12px; font-weight:700; cursor:pointer; }
  .sb-new:hover { border-color:var(--tool); }
  .sb-list { flex:1; overflow-y:auto; padding:8px; display:flex; flex-direction:column; gap:4px; }
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
  .sb-item .x { position:absolute; top:6px; right:6px; width:17px; height:17px; line-height:15px; text-align:center;
                background:none; border:none; color:var(--faint); font-size:14px; cursor:pointer; border-radius:5px; opacity:0; }
  .sb-item:hover .x { opacity:1; } .sb-item .x:hover { color:var(--err); background:color-mix(in srgb,var(--err) 14%,transparent); }
  .sb-foot { padding:10px 13px; border-top:1px solid var(--border); }
  .sb-foot label { display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:11px; color:var(--dim); cursor:pointer; }
  .sb-foot input { accent-color:var(--tool); }
  .sb-foot .hint2 { margin-top:5px; font-family:var(--mono); font-size:9.5px; color:var(--faint); line-height:1.4; }
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
  .thread { max-width:820px; margin:0 auto; padding:22px 18px 8px; display:flex; flex-direction:column; gap:14px; }

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
    <div class="sb-list" id="sblist"></div>
    <div class="sb-foot">
      <div class="hint2">las dormidas se reviven al clickearlas · cerrar (×) no borra nada</div>
    </div>
  </aside>
  <div class="col">
  <header>
    <span class="om">Ω</span><span class="nm">omega</span>
    <span class="st"><button class="hbtn" id="reveal" title="abrir la carpeta de la sesión en el explorador">carpeta ↗</button><span class="dotc" id="dot"></span><span id="stat">conectando…</span></span>
  </header>
  <main id="main">
    <div class="thread" id="thread"></div>
    <div class="thinking" id="thinking"><span class="sp"></span><span id="thinkLbl">Pensando…</span><button type="button" class="stopbtn" id="stop">■ detener · Esc</button></div>
  </main>
  <form id="form">
    <div class="inbar">
      <textarea id="input" rows="1" placeholder="Escribí una tarea…  (Enter para enviar, Shift+Enter salto de línea)"></textarea>
      <button id="send" type="submit">enviar</button>
    </div>
    <div class="hint" id="hint">Ω omega · frontend web · localhost</div>
  </form>
  </div>

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
function resetThread(){ thread.innerHTML=''; curAsst=null; lastTool=null; $("thinking").classList.remove('on'); }

function selectSession(id, force){
  if(!force && id===current && es) return;
  current = id;
  resetThread();
  openES();
  loadSessions(true); // fuerza el render para mover el highlight a la nueva
}

function renderSessions(list){
  const box = $("sblist"); box.innerHTML='';
  list.forEach(function(s){
    const it = document.createElement('div');
    const stCls = (s.live && s.status) ? (' st-' + s.status) : '';
    it.className = 'sb-item' + (s.id===current ? ' active' : '') + (s.live ? '' : ' dormant') + stCls;
    it.onclick = function(){ selectSession(s.id); };

    const nm = document.createElement('div'); nm.className='nm';
    const dot = document.createElement('span'); dot.className='pdot';
    const tt = document.createElement('span'); tt.className='tt'; tt.textContent = s.title;
    nm.appendChild(dot); nm.appendChild(tt);

    const meta = document.createElement('div'); meta.className='meta';
    if(s.live){
      const word = s.status==='running' ? 'corriendo…'
                 : s.status==='waiting' ? 'esperás vos'
                 : (s.isolated ? '⎇ aislada' : '· compartida');
      meta.innerHTML = '<span class="s">' + word + '</span>';
      if(s.clients) meta.innerHTML += ' · ' + s.clients + ' ◉';
    } else {
      meta.textContent = '⦿ dormida' + (s.branch ? ' · ' + s.branch : '');
    }
    it.appendChild(nm); it.appendChild(meta);

    // × duerme la sesión (no la borra). El default siempre queda.
    const x = document.createElement('button'); x.className='x'; x.textContent='×'; x.title='dormir sesión';
    x.onclick = function(e){ e.stopPropagation(); closeSession(s.id); };
    it.appendChild(x);

    box.appendChild(it);
  });
}

let lastSig = '';
async function loadSessions(force){
  try {
    const r = await fetch('/sessions'); const d = await r.json();
    if(!current) current = d.default;
    // Solo re-renderizamos si algo cambió (o si se fuerza) — así el poll no
    // rompe el hover ni parpadea el sidebar cuando no pasó nada.
    const sig = current + '|' + d.sessions.map(function(s){ return [s.id,s.live,s.status,s.clients,s.title].join(','); }).join(';');
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

$("sbnew").addEventListener('click', openModal);
$("reveal").addEventListener('click', function(){ if(current) fetch(q('/reveal'), { method:'POST' }).catch(function(){}); });

// Boot: descubrí las sesiones, elegí la default, abrí su stream.
(async function(){ await loadSessions(); openES(); })();

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
window.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ if($("modalbg").classList.contains('on')) closeModal(); else interrupt(); } });
</script>
</body>
</html>`;
