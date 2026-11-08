'use strict';
const { esc, fmtDuration, clampStr } = require('../util');

/**
 * "The redeemed ticket" email. Table layout + inline styles for client
 * compatibility; a small <style> block adds mobile and dark-mode refinements
 * where supported. All dynamic values are escaped.
 */
function renderEmail({ storeName, productName, imageUrl, price, quantity, ctaUrl, waitedMs, ticket }) {
  const name = clampStr(productName, 140) || 'Your item';
  const store = clampStr(storeName, 60) || 'the store';
  const subject = clampStr(`${name} is back in stock`, 150);
  const waited = waitedMs >= 60000 ? fmtDuration(waitedMs) : ''; // "0s in line" is noise, only show a real wait
  const low = Number.isInteger(quantity) && quantity > 0 && quantity <= 10;
  const pre = low ? `Only ${quantity} left. Your spot in line just came up.` : 'Your spot in line just came up.';
  const href = esc(ctaUrl);

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>
  body,table,td{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:inherit}
  @media only screen and (max-width:620px){
    .container{width:100%!important}
    .pad{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:30px!important;line-height:36px!important}
    .stack{display:block!important;width:100%!important;text-align:left!important}
    .stack-gap{padding-top:12px!important}
    .btn a{display:block!important}
    .hero{width:100%!important;height:auto!important}
  }
  @media (prefers-color-scheme:dark){
    .bg{background:#14110d!important}
    .card{background:#1e1a14!important;border-color:#3a3226!important}
    .ink{color:#f4eee2!important}
    .muted{color:#a89f8d!important}
    .rule{border-color:#4a402f!important}
    .notch{background:#14110d!important}
    .pill{background:#2b2418!important;color:#ffb36b!important}
    .btn-a{background:#f4eee2!important;color:#14110d!important}
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#efe9db;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(pre)}${'&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="bg" style="background:#efe9db;">
<tr><td align="center" style="padding:28px 12px 36px;">
  <table role="presentation" class="container" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;">
    <tr><td class="pad" style="padding:0 6px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#7a705d;" >
      <span class="muted" style="color:#7a705d;"><strong style="color:#e5412d;">&#9679;</strong>&nbsp; Encore &nbsp;/&nbsp; ${esc(store)}</span>
    </td></tr>
    <tr><td>
      <table role="presentation" class="card" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#fffdf7;border:1px solid #e3dac6;border-radius:20px;overflow:hidden;">
        ${
          imageUrl
            ? `<tr><td align="center" style="padding:0;background:#f3ecdb;"><img class="hero" src="${esc(imageUrl)}" alt="${esc(name)}" width="598" style="display:block;width:100%;max-width:598px;height:auto;"></td></tr>`
            : ''
        }
        <tr><td class="pad" style="padding:34px 40px 8px;">
          <span class="pill" style="display:inline-block;background:#fdeadf;color:#c2410c;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;padding:6px 12px;border-radius:999px;">Back in stock${low ? ` &middot; only ${quantity} left` : ''}</span>
        </td></tr>
        <tr><td class="pad" style="padding:10px 40px 6px;">
          <h1 class="h1 ink" style="margin:0;font-family:ui-serif,'Iowan Old Style','Palatino Linotype',Georgia,serif;font-weight:700;font-size:36px;line-height:42px;letter-spacing:-.02em;color:#16130f;">${esc(name)} is back.</h1>
        </td></tr>
        <tr><td class="pad" style="padding:8px 40px 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:25px;color:#4a4235;">
          <span class="muted" style="color:#4a4235;">You asked us to tell you the moment it returned. It has, and you're first to know.${price ? ` It's ${esc(price)}.` : ''} Popular items can sell out again quickly.</span>
        </td></tr>
        <tr><td class="pad btn" style="padding:22px 40px 34px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;"><tr><td align="center" style="border-radius:12px;background:#16130f;" class="btn-a">
            <a class="btn-a" href="${href}" target="_blank" style="display:inline-block;padding:16px 34px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#fffdf7;text-decoration:none;border-radius:12px;background:#16130f;white-space:nowrap;">Get it now &rarr;</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="padding:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="14" class="notch" style="width:14px;height:28px;background:#efe9db;border-radius:0 14px 14px 0;font-size:0;line-height:0;">&nbsp;</td>
            <td style="padding:0 6px;"><div class="rule" style="border-top:2px dashed #d8cfbd;height:0;font-size:0;line-height:0;">&nbsp;</div></td>
            <td width="14" class="notch" style="width:14px;height:28px;background:#efe9db;border-radius:14px 0 0 14px;font-size:0;line-height:0;">&nbsp;</td>
          </tr></table>
        </td></tr>
        <tr><td class="pad" style="padding:6px 40px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td class="stack" valign="top" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
              <div class="muted" style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#7a705d;">Your ticket</div>
              <div class="ink" style="font-size:20px;letter-spacing:.14em;font-weight:700;color:#16130f;padding-top:4px;">${esc(ticket)}</div>
            </td>
            ${
              waited
                ? `<td class="stack stack-gap" valign="top" align="right" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:right;">
              <div class="muted" style="font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#7a705d;">Time in line</div>
              <div class="ink" style="font-size:20px;letter-spacing:.06em;font-weight:700;color:#16130f;padding-top:4px;">${esc(waited)}</div>
            </td>`
                : ''
            }
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td class="pad" style="padding:22px 14px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;color:#7a705d;text-align:center;">
      <span class="muted" style="color:#7a705d;">You're getting this single email because you asked ${esc(store)} to notify you when ${esc(name)} was back. We won't add you to any list or send anything else about it.</span>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `${name} is back in stock.`,
    '',
    low ? `Only ${quantity} left.` : '',
    `You asked ${store} to tell you the moment it returned.${price ? ` Price: ${price}.` : ''}`,
    '',
    `Get it now: ${ctaUrl}`,
    '',
    `Your ticket: ${ticket}${waited ? `   Time in line: ${waited}` : ''}`,
    '',
    `You're getting this single email because you asked ${store} to notify you. We won't send anything else about it.`,
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');

  return { subject, html, text };
}

module.exports = { renderEmail };
