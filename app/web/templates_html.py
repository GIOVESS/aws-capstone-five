PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Resilient Shop</title>
<style>
:root{--bg:#0b1d26;--panel:#12303d;--ink:#e8f1f2;--mut:#8fb0b8;--acc:#f4b942;--ok:#4fd1a5}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:860px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 20px}
.chip{background:var(--panel);border-radius:999px;padding:4px 12px;color:var(--mut)}.chip b{color:var(--acc)}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:8px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #1d4352}
button{background:var(--acc);border:0;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer}
pre{background:var(--panel);padding:12px;border-radius:8px;overflow:auto;color:var(--ok)}
</style></head><body><main>
<h1>Resilient Shop</h1>
<div class="bar">
<span class="chip">version <b>{{ version }}</b></span>
<span class="chip">AZ <b>{{ az }}</b></span>
<span class="chip">task <b>{{ task }}</b></span>
<span class="chip">products cache <b id="cache">-</b></span>
</div>
<table><thead><tr><th>Product</th><th>Price (USD)</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<h3>Last response</h3><pre id="out">Place an order to push a message through SQS.</pre>
<script>
async function load(){const r=await fetch('/api/products');document.getElementById('cache').textContent=r.headers.get('X-Cache')||'-';
const d=await r.json();document.getElementById('rows').innerHTML=d.products.map(p=>
`<tr><td>${p.name}</td><td>${(p.price_cents/100).toFixed(2)}</td><td><button onclick="order(${p.id})">Order</button></td></tr>`).join('')}
async function order(id){const r=await fetch('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product_id:id,quantity:1})});
const j=await r.json();document.getElementById('out').textContent=JSON.stringify(j,null,2);
if(j.order_id){setTimeout(async()=>{const s=await fetch('/api/orders/'+j.order_id);document.getElementById('out').textContent=JSON.stringify(await s.json(),null,2)},5000)}}
load();
</script></main></body></html>"""
