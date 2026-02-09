(function () {
  var toggle = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar-drawer');
  var backdrop = document.getElementById('sidebar-backdrop');
  var closeBtn = sidebar ? sidebar.querySelector('.sidebar-drawer__close') : null;

  if (!toggle || !sidebar) return;

  function open() {
    sidebar.classList.add('sidebar--open');
    if (backdrop) backdrop.classList.add('sidebar-drawer__backdrop--open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    sidebar.classList.remove('sidebar--open');
    if (backdrop) backdrop.classList.remove('sidebar-drawer__backdrop--open');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
})();
