(function () {
  var bar = document.getElementById('reading-progress');
  if (!bar) return;

  function update() {
    var scrollTop = window.scrollY || document.documentElement.scrollTop;
    var docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    if (docHeight <= 0) {
      bar.style.width = '0';
      return;
    }
    var progress = (scrollTop / docHeight) * 100;
    bar.style.width = Math.min(progress, 100) + '%';
  }

  window.addEventListener('scroll', update, { passive: true });
  update();
})();
