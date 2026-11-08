/* Encore embed behaviour. No inline code anywhere: the page ships a strict CSP. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);

  /* ---- host-store theming via query string (validated, applied through CSSOM so CSP stays strict) ---- */
  var root = document.documentElement;
  var accent = params.get('accent');
  if (accent && /^#?[0-9a-fA-F]{3,8}$/.test(accent)) root.style.setProperty('--accent', accent.charAt(0) === '#' ? accent : '#' + accent);
  var radius = parseInt(params.get('radius'), 10);
  if (radius >= 0 && radius <= 32) root.style.setProperty('--radius', radius + 'px');
  var theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  if (params.get('compact') === '1') document.body.classList.add('compact');

  var form = $('form'), ticket = $('ticket'), issued = $('issued');
  var skuIn = $('sku'), emailIn = $('email'), list = $('skuList');
  var catalogue = [], active = -1, current = null, lookupTimer = null;

  /* ---- iframe auto-resize: tell the host page how tall we are ---- */
  var lastH = 0;
  function postHeight() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h && h !== lastH && window.parent !== window) {
      lastH = h;
      window.parent.postMessage({ type: 'encore:resize', height: h }, '*');
    }
  }
  if ('ResizeObserver' in window) new ResizeObserver(postHeight).observe($('stage'));
  window.addEventListener('load', postHeight);

  /* ---- barcode: your ticket is "printed" from what you type ---- */
  function fnv(str) { var h = 2166136261; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function drawBars(svg, seed, idle) {
    var NS = 'http://www.w3.org/2000/svg', x = 2, s = fnv(seed || 'encore') || 1;
    svg.textContent = '';
    svg.classList.toggle('barcode--idle', !!idle);
    while (x < 118) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      var w = 1 + (s % 4), h = 26 + ((s >>> 8) % 30), gap = 1 + ((s >>> 16) % 3);
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', (56 - h) / 2); r.setAttribute('width', w); r.setAttribute('height', h);
      svg.appendChild(r);
      x += w + gap;
    }
  }
  function updateBars() {
    var seed = (skuIn.value + '|' + emailIn.value).trim();
    drawBars($('barcode'), seed, seed.length < 3);
  }

  /* ---- error helpers ---- */
  function setErr(input, el, msg) {
    el.textContent = msg || '';
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
    postHeight();
  }

  /* ---- catalogue combobox ---- */
  function esc(s) { return String(s); } // we only ever assign via textContent
  fetch('/api/catalogue').then(function (r) { return r.ok ? r.json() : { products: [] }; })
    .then(function (d) { catalogue = d.products || []; if (skuIn.value) resolveTyped(); })
    .catch(function () { /* free-text entry still works */ });

  function renderList() {
    var q = skuIn.value.trim().toLowerCase();
    var hits = catalogue.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) > -1 || p.sku.toLowerCase().indexOf(q) > -1; }).slice(0, 30);
    list.textContent = '';
    active = -1;
    if (!hits.length) {
      if (!q || !catalogue.length) { closeList(); return; }
      var li0 = document.createElement('li'); li0.className = 'combo__empty'; li0.textContent = 'No match. You can still type an exact SKU.'; list.appendChild(li0);
    }
    hits.forEach(function (p, i) {
      var li = document.createElement('li'); li.setAttribute('role', 'option'); li.id = 'opt' + i; li.dataset.sku = p.sku;
      var left = document.createElement('span'); left.textContent = p.name;
      var code = document.createElement('code'); code.textContent = p.sku; left.appendChild(code);
      var b = document.createElement('span'); b.className = 'badge ' + (p.inStock ? 'badge--in' : 'badge--out'); b.textContent = p.inStock ? 'In stock' : 'Sold out';
      li.appendChild(left); li.appendChild(b);
      li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(p.sku); });
      list.appendChild(li);
    });
    list.hidden = false; skuIn.setAttribute('aria-expanded', 'true'); postHeight();
  }
  function closeList() { list.hidden = true; skuIn.setAttribute('aria-expanded', 'false'); skuIn.removeAttribute('aria-activedescendant'); }
  function move(d) {
    var items = list.querySelectorAll('li[role=option]'); if (!items.length) return;
    active = (active + d + items.length) % items.length;
    items.forEach(function (li, i) { li.setAttribute('aria-selected', i === active ? 'true' : 'false'); });
    skuIn.setAttribute('aria-activedescendant', items[active].id); items[active].scrollIntoView({ block: 'nearest' });
  }
  function choose(sku) { skuIn.value = sku; closeList(); setErr(skuIn, $('skuErr'), ''); showProduct(sku); updateBars(); emailIn.focus(); }

  skuIn.addEventListener('input', function () { setErr(skuIn, $('skuErr'), ''); renderList(); updateBars(); clearTimeout(lookupTimer); lookupTimer = setTimeout(resolveTyped, 350); });
  skuIn.addEventListener('focus', function () { if (catalogue.length) renderList(); });
  skuIn.addEventListener('blur', function () { setTimeout(closeList, 120); resolveTyped(); });
  skuIn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) renderList(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter' && !list.hidden && active > -1) { e.preventDefault(); var li = list.querySelectorAll('li[role=option]')[active]; if (li) choose(li.dataset.sku); }
    else if (e.key === 'Escape') closeList();
  });
  emailIn.addEventListener('input', function () { setErr(emailIn, $('emailErr'), ''); updateBars(); });

  function resolveTyped() {
    var v = skuIn.value.trim();
    if (!v) { hideProduct(); return; }
    var m = catalogue.filter(function (p) { return p.sku.toLowerCase() === v.toLowerCase(); })[0];
    if (m) showProduct(m.sku);
    else if (!catalogue.length && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) showProduct(v); // catalogue unavailable: ask the server
    else hideProduct(); // partial text: never probe the API with half-typed SKUs
  }
  function hideProduct() { $('product').hidden = true; current = null; postHeight(); }
  function showProduct(sku) {
    if (current === sku) return;
    current = sku;
    fetch('/api/products/' + encodeURIComponent(sku)).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
      if (!p || current !== sku) { if (!p) hideProduct(); return; }
      $('productName').textContent = p.name;
      var st = $('productState'); st.textContent = '';
      var s = document.createElement('span'); s.className = p.inStock ? 'in' : 'out';
      s.textContent = p.inStock ? 'IN STOCK NOW' : 'SOLD OUT';
      st.appendChild(s);
      if (p.waiting > 0) st.appendChild(document.createTextNode(' · ' + p.waiting + ' waiting'));
      var img = $('productImg');
      if (p.image) { img.src = p.image; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
      $('product').hidden = false; postHeight();
    }).catch(function () { /* decorative */ });
  }

  /* ---- submit ---- */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var sku = skuIn.value.trim(), email = emailIn.value.trim(), bad = false;
    setErr(null, $('formErr'), '');
    if (!sku) { setErr(skuIn, $('skuErr'), 'Tell us which item you are waiting for.'); bad = true; } else setErr(skuIn, $('skuErr'), '');
    if (!EMAIL_RE.test(email)) { setErr(emailIn, $('emailErr'), 'Enter a valid email so we can reach you.'); bad = true; } else setErr(emailIn, $('emailErr'), '');
    if (bad) { (sku ? emailIn : skuIn).focus(); return; }

    var btn = $('submit'); btn.classList.add('is-busy'); btn.setAttribute('aria-busy', 'true');
    var ctl = new AbortController(); var to = setTimeout(function () { ctl.abort(); }, 15000);
    fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, sku: sku }), signal: ctl.signal })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          var er = (res.d && res.d.error) || {};
          if (er.code === 'unknown_sku' || er.code === 'invalid_sku') setErr(skuIn, $('skuErr'), er.message || 'We could not find that item.');
          else if (er.code === 'invalid_email') setErr(emailIn, $('emailErr'), er.message);
          else setErr(null, $('formErr'), er.message || 'Something went wrong. Please try again.');
          return;
        }
        tearAndIssue(res.d, email);
      })
      .catch(function (err) { setErr(null, $('formErr'), err && err.name === 'AbortError' ? 'That took too long. Please try again.' : 'You seem to be offline. Check your connection and try again.'); })
      .then(function () { clearTimeout(to); btn.classList.remove('is-busy'); btn.removeAttribute('aria-busy'); });
  });

  function maskEmail(e) { var i = e.indexOf('@'); return i > 1 ? e.charAt(0) + '•••' + e.slice(i) : e; }

  function tearAndIssue(d, email) {
    $('stubNo').textContent = d.ticket;
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    ticket.classList.add('is-tearing');
    setTimeout(function () { showIssued(d, email); }, reduce ? 0 : 780);
    if (window.parent !== window) window.parent.postMessage({ type: 'encore:submitted', sku: d.product && d.product.sku, ticket: d.ticket }, '*');
  }

  function showIssued(d, email) {
    ticket.hidden = true; issued.hidden = false;
    var name = (d.product && d.product.name) || 'your item';
    var title = $('issuedTitle'); title.textContent = '';
    if (d.inStockNow) {
      title.appendChild(document.createTextNode('It’s in stock '));
      var em = document.createElement('em'); em.textContent = 'right now.'; title.appendChild(em);
      $('stamp').textContent = 'Sending now';
      $('issuedKicker').textContent = 'Good timing';
      $('issuedLede').textContent = 'We’re emailing ' + maskEmail(email) + ' about ' + name + ' this very second.';
    } else {
      title.appendChild(document.createTextNode(d.position === 1 ? 'You’re ' : 'You’re '));
      var n = document.createElement('em'); n.textContent = d.position === 1 ? 'first' : '#' + d.position; title.appendChild(n);
      title.appendChild(document.createTextNode(d.position === 1 ? ' in line.' : ' in line.'));
      $('stamp').textContent = 'On the list';
      $('issuedKicker').textContent = 'Ticket held';
      $('issuedLede').textContent = 'We’ll email ' + maskEmail(email) + ' the moment ' + name + ' is back in stock.';
    }
    $('issuedNext').textContent = d.inStockNow ? 'Check your inbox.' : 'No need to keep this page open. We’ll do the watching.';
    var dots = $('dots'); dots.textContent = '';
    var shown = Math.min(d.position, 26);
    for (var i = 1; i <= shown; i++) {
      var li = document.createElement('li'); li.style.animationDelay = (i * 28) + 'ms'; if (i === shown && d.position <= 26) li.className = 'me'; dots.appendChild(li);
    }
    if (d.position > 26) { var m = document.createElement('li'); m.className = 'more'; m.textContent = '+' + (d.position - 26) + ' more · you'; dots.appendChild(m); }
    var link = $('issuedLink');
    if (d.product && d.product.url && /^https:\/\//.test(d.product.url)) { link.href = d.product.url; link.hidden = false; } else link.hidden = true;
    $('issuedNo').textContent = d.ticket;
    drawBars($('barcode2'), d.ticket + email, false);
    title.focus({ preventScroll: true });
    postHeight();
  }

  $('again').addEventListener('click', function () {
    issued.hidden = true; ticket.hidden = false; ticket.classList.remove('is-tearing');
    skuIn.value = ''; hideProduct(); $('stubNo').textContent = 'No. ——————'; updateBars(); skuIn.focus(); postHeight();
  });

  /* ---- prefill from the host page: ?sku=...&email=... ---- */
  var pre = params.get('sku'), preEmail = params.get('email');
  if (pre && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pre)) { skuIn.value = pre; showProduct(pre); }
  if (preEmail && preEmail.length < 255) emailIn.value = preEmail;
  updateBars();
  postHeight();
})();
