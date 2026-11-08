'use strict';
const { html, raw, ticketCode, fmtDuration } = require('../util');

const STATUS_LABEL = { open: 'Waiting', queued: 'Queued', sending: 'Sending', notified: 'Notified', failed: 'Failed', cancelled: 'Cancelled' };
const FILTERS = [
  ['', 'All'],
  ['open', 'Waiting'],
  ['queued', 'Queued'],
  ['notified', 'Notified'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
];

function layout({ title, css, js, bodyClass = '', body, config, robots = 'noindex' }) {
  const v = config.assetVersion;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="${robots}">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2317140f'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23e5412d'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/${css}?v=${v}">
</head>
<body class="${bodyClass}">
${body}
<script src="/assets/${js}?v=${v}" defer></script>
</body>
</html>`;
}

/* ============================ EMBED ============================ */
function embedPage(config) {
  return layout({
    config,
    title: 'Back-in-stock alerts',
    css: 'embed.css',
    js: 'embed.js',
    robots: 'noindex',
    bodyClass: 'embed',
    body: html`
<main class="stage" id="stage">
  <div class="ticket" id="ticket">
    <form class="ticket__main" id="form" novalidate>
      <header class="ticket__top">
        <span class="mark"><i></i>Encore</span>
        <span class="kicker">Back-in-stock alerts</span>
      </header>
      <h1 class="title">Be first in line<br>when it&rsquo;s back.</h1>

      <div class="field" id="skuField">
        <label for="sku">Item</label>
        <div class="combo">
          <input id="sku" name="sku" type="text" role="combobox" aria-expanded="false" aria-controls="skuList"
                 aria-autocomplete="list" aria-describedby="skuErr" autocomplete="off" autocapitalize="off"
                 spellcheck="false" placeholder="Search by name or SKU" maxlength="64" required>
          <ul id="skuList" class="combo__list" role="listbox" hidden></ul>
        </div>
        <div class="product" id="product" hidden>
          <img id="productImg" alt="" width="44" height="44" hidden>
          <div class="product__meta">
            <strong id="productName"></strong>
            <span id="productState"></span>
          </div>
        </div>
        <p class="err" id="skuErr" role="alert"></p>
      </div>

      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" inputmode="email" autocomplete="email"
               placeholder="you@example.com" maxlength="254" aria-describedby="emailErr" required>
        <p class="err" id="emailErr" role="alert"></p>
      </div>

      <button class="cta" id="submit" type="submit">
        <span class="cta__label">Get my ticket</span>
        <span class="cta__arrow" aria-hidden="true">&rarr;</span>
        <span class="cta__spin" aria-hidden="true"></span>
      </button>
      <p class="fine">One email, the moment it&rsquo;s back. Nothing else, ever.</p>
      <p class="err err--form" id="formErr" role="alert"></p>
      <noscript><p class="err">This form needs JavaScript.</p></noscript>
    </form>

    <aside class="ticket__stub" id="stub" aria-hidden="true">
      <div class="stub__label">Admit one</div>
      <div class="stub__sub">Restock</div>
      <svg class="barcode" id="barcode" viewBox="0 0 120 56" preserveAspectRatio="none" focusable="false"></svg>
      <div class="stub__no" id="stubNo">No. &ndash;&ndash;&ndash;&ndash;&ndash;&ndash;</div>
    </aside>
  </div>

  <section class="issued" id="issued" hidden>
    <div class="issued__main">
      <span class="stamp" id="stamp">On the list</span>
      <p class="kicker" id="issuedKicker">You&rsquo;re in line</p>
      <h2 class="issued__title" id="issuedTitle" tabindex="-1"></h2>
      <p class="issued__lede" id="issuedLede"></p>
      <ol class="dots" id="dots" aria-hidden="true"></ol>
      <p class="issued__next" id="issuedNext"></p>
      <div class="issued__actions">
        <a class="link" id="issuedLink" target="_blank" rel="noopener noreferrer" hidden>Open product &rarr;</a>
        <button class="ghost" id="again" type="button">Alert me about another item</button>
      </div>
    </div>
    <aside class="ticket__stub issued__stub" aria-hidden="true">
      <div class="stub__label">Your ticket</div>
      <div class="stub__sub">Restock</div>
      <svg class="barcode" id="barcode2" viewBox="0 0 120 56" preserveAspectRatio="none" focusable="false"></svg>
      <div class="stub__no" id="issuedNo"></div>
    </aside>
  </section>
</main>`,
  });
}

/* ============================ ADMIN ============================ */
function loginPage({ config, error }) {
  return layout({
    config,
    title: 'Box Office · Sign in',
    css: 'admin.css',
    js: 'admin.js',
    bodyClass: 'admin login',
    body: html`
<main class="gate">
  <form class="gate__ticket" method="post" action="/admin/login" autocomplete="off">
    <div class="gate__top"><span class="mark"><i></i>Encore</span><span class="kicker">Box Office</span></div>
    <h1>Staff entrance</h1>
    <p class="muted">Enter the admin password to see who is waiting.</p>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus ${error ? raw('aria-invalid="true" aria-describedby="e"') : ''}>
    ${error ? html`<p class="err" id="e" role="alert">${error}</p>` : ''}
    <button class="btn" type="submit">Enter <span aria-hidden="true">&rarr;</span></button>
  </form>
</main>`,
  });
}

const fmtTs = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
const timeEl = (d) => (d ? html`<time datetime="${new Date(d).toISOString()}">${fmtTs(d)}</time>` : html`<span class="dash">&mdash;</span>`);
const bucket = (n, max) => `w-${Math.max(n > 0 ? 5 : 0, Math.min(100, Math.round(((n / (max || 1)) * 100) / 5) * 5))}`;
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== undefined && v !== null && !(k === 'page' && v === 1) && !(k === 'view' && v === 'list')) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** 24h activity as an inline SVG (attributes only, so it passes the strict CSP). Amber = asked, green = emailed. */
function activityChart(rows) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.requested, r.notified]));
  const base = 104;
  const maxH = 92;
  const bars = rows.map((r, i) => {
    const x = i * 19 + 4;
    const h1 = r.requested ? Math.max(2, Math.round((r.requested / max) * maxH)) : 0;
    const h2 = r.notified ? Math.max(2, Math.round((r.notified / max) * maxH)) : 0;
    const label = `${String(new Date(r.hour).getUTCHours()).padStart(2, '0')}:00 UTC · ${r.requested} asked, ${r.notified} emailed`;
    return html`<g><title>${label}</title><rect class="hit" x="${x - 2}" y="0" width="19" height="${base}"/>${
      h1 ? html`<rect class="bar-req" x="${x}" y="${base - h1}" width="7" height="${h1}" rx="2"/>` : ''
    }${h2 ? html`<rect class="bar-ok" x="${x + 8}" y="${base - h2}" width="7" height="${h2}" rx="2"/>` : ''}</g>`;
  });
  const total = rows.reduce((a, r) => a + r.requested, 0);
  const sent = rows.reduce((a, r) => a + r.notified, 0);
  return html`<svg class="activity" viewBox="0 0 460 128" role="img" aria-label="Requests and emails per hour, last 24 hours: ${total} asked, ${sent} emailed">
<line class="axis" x1="0" y1="${base}" x2="460" y2="${base}"/>${bars}
<text class="tick" x="4" y="122">-24h</text><text class="tick" x="222" y="122" text-anchor="middle">-12h</text><text class="tick" x="456" y="122" text-anchor="end">now</text></svg>
<p class="legend"><span class="sw sw--req"></span>${total} asked <span class="sw sw--ok"></span>${sent} emailed</p>`;
}

function liveFragment({ config, csrf, stats, top, releases, list, activity = [], query, pages }) {
  const maxTop = Math.max(1, ...top.map((t) => t.waiting));
  const median = stats.median_wait_s != null ? fmtDuration(stats.median_wait_s * 1000) : '—';
  const back = qs(query);
  const kpis = [
    ['Waiting', stats.waiting, 'tickets holding', 'amber'],
    ['In flight', stats.sending, 'queued or sending', 'info'],
    ['Notified', stats.notified, `${stats.notified_24h} in last 24h`, 'ok'],
    ['Failed', stats.failed, stats.failed ? 'needs a look' : 'all clear', stats.failed ? 'bad' : 'muted'],
    ['Median wait', median, 'request → email', 'muted'],
  ];

  const marquee = releases.length
    ? releases.map((r) => html`<span class="mq"><b>${r.name || r.sku}</b> back in stock <i>→</i> ${r.n} ${r.n === 1 ? 'ticket' : 'tickets'} punched <em>${fmtTs(r.at)}</em></span>`)
    : html`<span class="mq">Waiting for the next restock&hellip;</span>`;

  const rows = list.rows.map((x) => {
    const code = ticketCode(config.sessionSecret, x.email, x.sku);
    const canCancel = x.status === 'open' || x.status === 'queued';
    const canRetry = x.status === 'failed';
    return html`
<li class="tk tk--${x.status}">
  <div class="tk__code"><span class="code">${code}</span><span class="chip chip--${x.status}">${STATUS_LABEL[x.status]}</span></div>
  <div class="tk__who">
    <span class="email">${x.email}</span>
    <span class="item">${x.product_name || x.sku} <code>${x.sku}</code></span>
  </div>
  <div class="tk__time"><span class="lbl">Requested</span>${timeEl(x.created_at)}</div>
  <div class="tk__time tk__time--n"><span class="lbl">Notified</span>${timeEl(x.notified_at)}${
    x.status === 'notified' ? html`<span class="punch" aria-label="Punched"></span>` : ''
  }</div>
  <div class="tk__meta">${
    x.last_error ? html`<span class="errtxt" title="${x.last_error}">${x.last_error}</span>` : x.attempts > 1 ? html`<span class="muted">${x.attempts} attempts</span>` : ''
  }</div>
  <div class="tk__act">${
    csrf && (canCancel || canRetry)
      ? html`<form method="post" action="/admin/requests/${x.id}/${canCancel ? 'cancel' : 'retry'}"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="back" value="${back}"><button class="mini" type="submit">${canCancel ? 'Cancel' : 'Retry'}</button></form>`
      : ''
  }</div>
</li>`;
  });

  const link = (p) => `/admin${qs({ ...query, page: p })}`;
  return html`
<div class="marquee" role="marquee" aria-label="Recent restocks"><div class="marquee__track">${marquee}${marquee}</div></div>
<section class="kpis">${kpis.map(
    ([k, v, sub, tone]) => html`<article class="kpi kpi--${tone}"><span class="kpi__k">${k}</span><strong class="kpi__v">${v}</strong><span class="kpi__s">${sub}</span></article>`
  )}</section>
<section class="grid2">
  <div class="panel">
    <h2>Most wanted <small>sold-out demand</small></h2>
    ${
      top.length
        ? html`<ol class="demand">${top.map(
            (t) => html`<li><span class="d__name">${t.name || t.sku}<code>${t.sku}</code></span><span class="d__bar"><i class="${bucket(t.waiting, maxTop)}"></i></span><b>${t.waiting}</b></li>`
          )}</ol>`
        : html`<p class="muted empty-s">No one is waiting on anything. Quiet night at the box office.</p>`
    }
  </div>
  <div class="panel">
    <h2>Last 24 hours <small>${stats.total} tickets in total</small></h2>
    ${activityChart(activity)}
  </div>
</section>
<ol class="rows">${
    rows.length
      ? rows
      : html`<li class="empty"><div class="empty__ticket"><strong>No tickets${query.q || query.status ? ' match' : ' yet'}</strong><span>${
          query.q || query.status ? 'Try clearing the filters.' : 'Requests will appear here the moment a customer asks.'
        }</span></div></li>`
  }</ol>
<nav class="pager" aria-label="Pages">
  ${query.page > 1 ? html`<a href="${link(query.page - 1)}">&larr; Newer</a>` : html`<span></span>`}
  <span class="muted">Page ${query.page} of ${pages} &middot; ${list.total} ${list.total === 1 ? 'ticket' : 'tickets'}</span>
  ${query.page < pages ? html`<a href="${link(query.page + 1)}">Older &rarr;</a>` : html`<span></span>`}
</nav>`;
}

function dashboardPage(ctx) {
  if (ctx.fragment) return liveFragment(ctx);
  const { config, csrf, query } = ctx;
  return layout({
    config,
    title: 'Box Office · Encore',
    css: 'admin.css',
    js: 'admin.js',
    bodyClass: `admin view-${query.view}`,
    body: html`
<header class="bar">
  <div class="bar__l"><span class="mark"><i></i>Encore</span><span class="kicker">Box Office &middot; ${config.brand.storeName}</span></div>
  <div class="bar__r">
    <span class="live" id="live" title="Auto-refreshing"><i></i>Live</span>
    <a class="ghost" href="/admin/export.csv">Export CSV</a>
    ${
      csrf
        ? html`<form method="post" action="/admin/logout"><button class="ghost" type="submit">Sign out</button></form>`
        : ''
    }
  </div>
</header>
<main class="wrap">
  <div id="refresh" data-url="/admin${qs({ ...query, fragment: '1' })}">
  <form class="tools" method="get" action="/admin" role="search">
    <input type="hidden" name="status" value="${query.status}">
    <input type="hidden" name="view" value="${query.view}">
    <input class="search" type="search" name="q" value="${query.q}" placeholder="Search email, SKU or product" maxlength="100" aria-label="Search requests">
    <nav class="chips" aria-label="Filter by status">${FILTERS.map(
      ([v, l]) => html`<a class="fchip${query.status === v ? ' is-on' : ''}" href="/admin${qs({ status: v, q: query.q, view: query.view })}">${l}</a>`
    )}</nav>
    <nav class="seg" aria-label="Layout"><a class="${query.view === 'list' ? 'is-on' : ''}" href="/admin${qs({ ...query, view: 'list', page: 1 })}">List</a><a class="${
      query.view === 'wall' ? 'is-on' : ''
    }" href="/admin${qs({ ...query, view: 'wall', page: 1 })}">Wall</a></nav>
  </form>
  <div id="liveBody">${liveFragment(ctx)}</div>
  </div>
</main>`,
  });
}

function errorPage(status, message) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${status}</title>
<link rel="stylesheet" href="/assets/admin.css"></head><body class="admin login"><main class="gate"><div class="gate__ticket"><h1>${status}</h1><p class="muted">${message}</p></div></main></body></html>`;
}

module.exports = { embedPage, loginPage, dashboardPage, errorPage };
