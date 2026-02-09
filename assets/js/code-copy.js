(function () {
  var blocks = document.querySelectorAll('div.highlighter-rouge, figure.highlight');
  if (!blocks.length) return;

  blocks.forEach(function (block) {
    var btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.type = 'button';

    btn.addEventListener('click', function () {
      var code = block.querySelector('code');
      if (!code) return;
      var text = code.innerText;

      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied!';
        btn.classList.add('code-copy-btn--copied');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('code-copy-btn--copied');
        }, 1500);
      }).catch(function () {
        btn.textContent = 'Failed';
        setTimeout(function () {
          btn.textContent = 'Copy';
        }, 1500);
      });
    });

    block.appendChild(btn);
  });
})();
