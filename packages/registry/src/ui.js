// Single-page catalog served at "/". Reads the JSON API, no build step.
export function catalogPage({ name, oidc, version }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · Bevara filters</title>
<style>
:root{--bg:#f7f8fa;--fg:#1c2430;--muted:#66707d;--card:#fff;--line:#e2e6eb;--accent:#0b5fff;--warn:#b45309}
@media(prefers-color-scheme:dark){:root{--bg:#0f1319;--fg:#e6e9ee;--muted:#98a2ae;--card:#161c25;--line:#273040;--accent:#5b8cff;--warn:#f59e0b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{padding:20px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header h1{margin:0;font-size:20px}header p{margin:4px 0 0;color:var(--muted);font-size:13px}
main{max-width:1000px;margin:0 auto;padding:16px}
input[type=search]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font-size:15px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;cursor:pointer}
.card:hover{border-color:var(--accent)}.card h3{margin:0 0 4px;font-size:16px}.card h3 small{color:var(--muted);font-weight:normal;margin-left:6px}
.card p{margin:0 0 8px;color:var(--muted);font-size:13px}.tags span{display:inline-block;font-size:11px;padding:1px 7px;border:1px solid var(--line);border-radius:999px;margin:0 4px 4px 0;color:var(--muted)}
.dep{color:var(--warn);font-size:12px}
pre{background:var(--bg);border:1px solid var(--line);padding:10px;border-radius:8px;overflow:auto;font-size:13px}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);max-width:720px;width:95%;padding:20px}
dialog::backdrop{background:rgba(0,0,0,.4)}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
a{color:var(--accent)}.muted{color:var(--muted)}.empty{color:var(--muted);padding:40px;text-align:center}
</style></head><body>
<header><h1>${esc(name)}</h1><p>Bevara filter registry · <span id="count"></span> · <code>bevara config set registry <span id="origin"></span></code></p></header>
<main>
<input id="q" type="search" placeholder="Search filters by name, format, codec…" autofocus>
<div id="grid" class="grid"></div>
<dialog id="dlg"></dialog>
</main>
<script>
const grid=document.getElementById('grid'),q=document.getElementById('q'),dlg=document.getElementById('dlg');
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
document.getElementById('origin').textContent=location.origin;
async function load(){const r=await fetch('filters?q='+encodeURIComponent(q.value)+'&limit=500');const d=await r.json();
document.getElementById('count').textContent=d.total+' filter'+(d.total===1?'':'s');
if(!d.filters.length){grid.innerHTML='<div class="empty">No filters published yet. <code>bevara publish</code> from a filter directory to add one.</div>';return}
grid.innerHTML=d.filters.map(f=>'<div class="card" data-n="'+esc(f.name)+'"><h3>'+esc(f.name)+'<small>'+esc(f.latest)+'</small></h3><p>'+esc(f.description||'')+'</p>'+(f.deprecated?'<div class="dep">deprecated: '+esc(f.deprecated)+'</div>':'')+'<div class="tags">'+[...(f.support||[]),...(f.formats||[])].map(t=>'<span>'+esc(t)+'</span>').join('')+'</div><p class="muted">'+(f.license?esc(f.license)+' · ':'')+f.downloads+' downloads</p></div>').join('')}
grid.addEventListener('click',async e=>{const c=e.target.closest('.card');if(!c)return;const r=await fetch('filters/'+c.dataset.n);const p=await r.json();const v=p.versions[p['dist-tags'].latest];
dlg.innerHTML='<h2 style="margin-top:0">'+esc(p.name)+' <small class="muted">'+esc(v.version)+'</small></h2><p>'+esc(v.description||'')+'</p>'+(v.help?'<p class="muted">'+esc(v.help)+'</p>':'')+
'<pre>bevara install '+esc(p.name)+'</pre><pre>&lt;video is="universal-video_1" using="mm_solver_1.0.1" with="'+esc(v.dist.file.replace(/\\.wasm$/,''))+'" src="…"&gt;</pre>'+
'<table><tr><th>Signature</th><td>'+(v.signature?'Ed25519 '+esc(v.signature.keyId)+' · log entry #'+v.signature.logSeq+' <span class="muted">'+esc(v.signature.logHash.slice(0,16))+'…</span>':'<span class="dep">unsigned</span>')+'</td></tr><tr><th>GPAC filters</th><td>'+esc((v.filters||[]).join(', '))+'</td></tr><tr><th>Formats</th><td>'+esc((v.formats||[]).join(', '))+'</td></tr><tr><th>License</th><td>'+esc(v.license||'—')+'</td></tr><tr><th>Patents</th><td>'+(v.patents?'<span class="'+(v.patents.status==='licence-required'||v.patents.status==='under-review'?'dep':'')+'">'+esc(v.patents.status)+'</span>'+(v.patents.regions&&v.patents.regions.length?' in '+esc(v.patents.regions.join(', ')):'')+(v.patents.note?' <span class="muted">'+esc(v.patents.note)+'</span>':''):'<span class="dep">undeclared</span>')+'</td></tr><tr><th>Wasm</th><td><a href="'+esc(v.dist.wasm)+'">'+esc(v.dist.file)+'</a> · '+(v.dist.size/1024).toFixed(0)+' kB ('+(v.dist.brSize/1024).toFixed(0)+' kB brotli)</td></tr><tr><th>Sources</th><td>'+(v.sources?'<a href="'+esc(v.sources)+'">'+esc(v.sources)+'</a>':'—')+'</td></tr><tr><th>Owners</th><td>'+esc(p.owners.join(', '))+'</td></tr><tr><th>Versions</th><td>'+Object.keys(p.versions).map(esc).join(', ')+'</td></tr></table>'+
'<p style="text-align:right;margin-bottom:0"><button onclick="dlg.close()">Close</button></p>';dlg.showModal()});
q.addEventListener('input',()=>{clearTimeout(q.t);q.t=setTimeout(load,150)});load();
</script></body></html>`;
}

export function loginFormPage({ callback, error }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bevara registry login</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f8fa}form{background:#fff;border:1px solid #e2e6eb;padding:24px;border-radius:12px;min-width:320px}label{display:block;margin:10px 0 4px}input{width:100%;padding:8px;border:1px solid #ccd;border-radius:6px}button{margin-top:16px;width:100%;padding:10px;background:#0b5fff;color:#fff;border:0;border-radius:6px;font-size:15px}.err{color:#b91c1c}</style></head>
<body><form method="post" action="web"><h2>Sign in to the Bevara registry</h2>${error ? `<p class="err">${esc(error)}</p>` : ''}
<input type="hidden" name="callback" value="${esc(callback)}">
<label>Username</label><input name="name" autofocus required><label>Password</label><input name="password" type="password" required>
<button>Sign in</button></form></body></html>`;
}

export function tokenPage(token) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bevara registry token</title></head>
<body style="font:15px system-ui,sans-serif;padding:40px"><h2>Logged in</h2><p>Paste this token into the CLI (<code>bevara login --token</code>):</p><pre style="background:#eee;padding:12px">${esc(token)}</pre></body></html>`;
}

export function doneRedirectPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Logged in</title></head><body style="font:15px system-ui,sans-serif;padding:40px"><h2>You are logged in</h2><p>You can close this window and go back to the terminal.</p></body></html>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
