/* Box Office: local-time rendering and quiet live refresh. Server-rendered HTML is the source of truth;
   this script only swaps in the next server-rendered fragment (same origin, already escaped). */
(function () {
  'use strict';

  function localize(scope) {
    var fmt;
    try { fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return; }
    (scope || document).querySelectorAll('time[datetime]').forEach(function (t) {
      var d = new Date(t.getAttribute('datetime'));
      if (!isNaN(d)) { t.title = d.toISOString(); t.textContent = fmt.format(d); }
    });
  }
  localize();

  var holder = document.getElementById('refresh');
  var body = document.getElementById('liveBody');
  var badge = document.getElementById('live');
  if (!holder || !body) return;

  var failures = 0, busy = false;
  function tick() {
    if (busy || document.hidden) return;
    var active = document.activeElement;
    if (active && active.closest && active.closest('#liveBody') && /^(INPUT|BUTTON)$/.test(active.tagName)) return; // never yank a control from under the user
    busy = true;
    fetch(holder.getAttribute('data-url'), { credentials: 'same-origin', headers: { Accept: 'text/html' }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) { throw new Error('expired'); }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.text();
      })
      .then(function (htmlText) {
        failures = 0; badge.classList.remove('is-off'); badge.lastChild.textContent = 'Live';
        if (htmlText !== body.__last) {
          body.innerHTML = htmlText; body.__last = htmlText; localize(body);
        }
      })
      .catch(function (e) {
        failures++;
        if (e.message === 'expired') { badge.classList.add('is-off'); badge.lastChild.textContent = 'Session expired. Reload'; failures = 99; }
        else if (failures > 2) { badge.classList.add('is-off'); badge.lastChild.textContent = 'Offline'; }
      })
      .then(function () { busy = false; });
  }
  var timer = setInterval(function () { if (failures < 99) tick(); else clearInterval(timer); }, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
