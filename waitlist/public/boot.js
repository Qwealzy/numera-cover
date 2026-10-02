// Runs before first paint (external file: the CSP forbids inline scripts). Marks JS as running and sets the
// motion state: the OS reduced-motion setting turns motion off; otherwise the viewer's saved nav toggle wins.
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  var saved = null;
  var reduce = false;
  try { saved = window.localStorage.getItem('numera-motion'); } catch (e) { saved = null; }
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { reduce = false; }
  d.setAttribute('data-motion', reduce ? 'off' : saved === 'off' ? 'off' : 'on');
  // Fail open. Section blocks are hidden for their reveal only after the page module has attached its
  // observers (html.reveals). If that module never gets there (blocked, failed, very slow), show everything;
  // if even the shared nav module never booted, drop the JS-only styling altogether.
  window.setTimeout(function () {
    if (!d.classList.contains('booted')) d.classList.remove('js');
    if (!d.classList.contains('reveals')) d.classList.add('reveal-fail');
  }, 3500);
})();
