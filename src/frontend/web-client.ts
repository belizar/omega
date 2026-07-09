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
         display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:11px; padding:12px 18px; border-bottom:1px solid var(--border);
           background:var(--surface); position:sticky; top:0; z-index:2; }
  header .om { font-family:var(--mono); font-weight:700; font-size:22px; color:var(--tool); line-height:1; }
  header .nm { font-family:var(--mono); letter-spacing:0.3em; text-transform:uppercase; font-size:12px; color:var(--ink); }
  header .st { margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--faint); display:flex; gap:8px; align-items:center; }
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
  .body strong { color:#fff; font-weight:650; }
  .body table { border-collapse:collapse; margin:10px 0; display:block; overflow-x:auto; font-size:13.5px; }
  .body th, .body td { border:1px solid var(--border); padding:7px 11px; text-align:left; vertical-align:top; }
  .body thead th { background:var(--surface2); font-family:var(--mono); font-size:11.5px; text-transform:uppercase;
                   letter-spacing:0.06em; color:var(--dim); font-weight:600; }
  .body tbody tr:nth-child(even) td { background:rgba(255,255,255,.02); }

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
</style>
</head>
<body>
  <header>
    <span class="om">Ω</span><span class="nm">omega</span>
    <span class="st"><span class="dotc" id="dot"></span><span id="stat">conectando…</span></span>
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

<script>
const GLYPH = { read:"»", outline:"≡", write:"+", edit:"✎", bash:"$", grep:"⌕", tool_search:"⌕", web_fetch:"↗", vision_ask:"◧", ask_user:"?", skill:"◆" };
const CAT = { read:"--tool", outline:"--tool", grep:"--tool", write:"--ok", edit:"--ok", bash:"--warn", web_fetch:"--err", vision_ask:"--err", tool_search:"--human", skill:"--human", ask_user:"--human" };
const $ = (id) => document.getElementById(id);
const thread = $("thread"), main = $("main");
let curAsst = null; // el <div.body> del bubble de asistente en curso

function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function atBottom(){ return main.scrollHeight - main.scrollTop - main.clientHeight < 80; }
function scroll(){ main.scrollTop = main.scrollHeight; }

// inline: escapa y aplica \x60code\x60 + **bold** (para prosa y celdas de tabla)
function inlineMd(s){
  s = esc(s);
  s = s.replace(/\x60([^\x60]+)\x60/g, (_,c)=>'<code>'+c+'</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, (_,c)=>'<strong>'+c+'</strong>');
  return s;
}
function splitRow(line){ return line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()); }

// markdown-lite: code blocks, TABLAS, párrafos con inline. Line-based para que
// las tablas (varias líneas contiguas) se detecten bien.
function md(t){
  const code = [];
  t = t.replace(/\x60\x60\x60(\w*)\n?([\s\S]*?)\x60\x60\x60/g, (_,lang,c) => {
    code.push('<pre><code>'+esc(c.replace(/\n$/,''))+'</code></pre>'); return '\x00C'+(code.length-1)+'\x00';
  });
  const lines = t.split('\n');
  const html = []; let para = []; let i = 0;
  const flush = ()=>{ if(para.length){ html.push('<p>'+para.map(inlineMd).join('<br>')+'</p>'); para=[]; } };
  while(i < lines.length){
    const line = lines[i];
    const isTable = line.includes('|') && i+1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i+1]);
    if(isTable){
      flush();
      const head = splitRow(line); i += 2; const rows = [];
      while(i < lines.length && lines[i].includes('|') && lines[i].trim() !== ''){ rows.push(splitRow(lines[i])); i++; }
      let tb = '<table><thead><tr>'+head.map(h=>'<th>'+inlineMd(h)+'</th>').join('')+'</tr></thead><tbody>';
      tb += rows.map(r=>'<tr>'+r.map(c=>'<td>'+inlineMd(c)+'</td>').join('')+'</tr>').join('');
      html.push(tb + '</tbody></table>');
    } else if(line.trim() === ''){ flush(); i++; }
    else { para.push(line); i++; }
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

// ── SSE ──────────────────────────────────────────────────────────
let lastTool = null;
const es = new EventSource('/events');
es.onopen = ()=>{ $("dot").classList.add('on'); $("stat").textContent='conectado'; };
es.onerror = ()=>{ $("dot").classList.remove('on'); $("stat").textContent='reconectando…'; };
es.onmessage = (e)=>{
  let ev; try { ev = JSON.parse(e.data); } catch { return; }
  switch(ev.type){
    case 'ready': $("stat").textContent = ev.model; break;
    case 'turn_start': $("thinking").classList.add('on'); curAsst=null; scroll(); break;
    case 'delta':
      if(!curAsst) curAsst = addMsg('omega','asst');
      curAsst.dataset.raw = (curAsst.dataset.raw||'') + ev.text;
      curAsst.innerHTML = md(curAsst.dataset.raw);
      if(atBottom()) scroll();
      break;
    case 'assistant_end': curAsst=null; break;
    case 'assistant': { const b=addMsg('omega','asst'); b.dataset.raw=ev.text; b.innerHTML=md(ev.text); break; }
    case 'tool_use': lastTool = addTool(ev.name, ev.input); break;
    case 'tool_result': addToolResult(lastTool, ev.output, ev.isError); lastTool=null; break;
    case 'turn_end': $("thinking").classList.remove('on'); curAsst=null; break;
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

// ── Input ────────────────────────────────────────────────────────
const input = $("input");
input.addEventListener('input', ()=>{ input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,180)+'px'; });
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); $("form").requestSubmit(); }});
$("form").addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = input.value.trim(); if(!text) return;
  addMsg('vos','user').textContent = text;
  input.value=''; input.style.height='auto'; $("hint").textContent='Ω omega · frontend web · localhost'; scroll();
  await fetch('/input', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) });
});
input.focus();

// ── Interrupción: Esc o el botón "detener" cortan el turno en curso ──
async function interrupt(){
  if(!$("thinking").classList.contains('on')) return;
  $("thinking").classList.remove('on');
  try { await fetch('/interrupt', { method:'POST' }); } catch {}
}
$("stop").addEventListener('click', interrupt);
window.addEventListener('keydown', (e)=>{ if(e.key==='Escape') interrupt(); });
</script>
</body>
</html>`;
