(function () {
  var btn = document.querySelector('.theme-toggle');
  if (!btn) return;

  var icon = btn.querySelector('i');

  function updateIcon() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (icon) {
      icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    }
  }

  updateIcon();

  btn.addEventListener('click', function () {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    }
    updateIcon();
  });
})();
