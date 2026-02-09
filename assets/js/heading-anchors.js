(function () {
  var headings = document.querySelectorAll('.page__content h2[id], .page__content h3[id], .page__content h4[id]');
  if (!headings.length) return;

  headings.forEach(function (heading) {
    var anchor = document.createElement('a');
    anchor.className = 'heading-anchor';
    anchor.href = '#' + heading.id;
    anchor.textContent = '#';
    anchor.setAttribute('aria-label', 'Link to ' + heading.textContent);
    heading.insertBefore(anchor, heading.firstChild);
  });
})();
