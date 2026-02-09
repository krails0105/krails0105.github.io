(function () {
  var modal = document.getElementById('search-modal');
  if (!modal) return;

  var input = modal.querySelector('.search-modal__input');
  var resultsContainer = modal.querySelector('.search-modal__results');
  var trigger = document.getElementById('search-modal-trigger');
  var backdrop = modal.querySelector('.search-modal__backdrop');
  var closeBtn = modal.querySelector('.search-modal__close');

  var lunrIndex = null;
  var activeIndex = -1;
  var debounceTimer = null;

  function buildIndex() {
    if (lunrIndex) return;
    if (!window.store) return;
    lunrIndex = lunr(function () {
      this.field('title', { boost: 10 });
      this.field('category');
      this.field('tags');
      this.ref('id');
      for (var i = 0; i < window.store.length; i++) {
        var item = window.store[i];
        this.add({
          id: i,
          title: item.title,
          category: item.category || '',
          tags: (item.tags || []).join(' ')
        });
      }
    });
  }

  function openModal() {
    buildIndex();
    modal.classList.add('search-modal--open');
    document.body.style.overflow = 'hidden';
    input.value = '';
    resultsContainer.innerHTML = '';
    activeIndex = -1;
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeModal() {
    modal.classList.remove('search-modal--open');
    document.body.style.overflow = '';
    activeIndex = -1;
  }

  function renderResults(query) {
    if (!lunrIndex || !query.trim()) {
      resultsContainer.innerHTML = '';
      activeIndex = -1;
      return;
    }

    var results;
    try {
      results = lunrIndex.search(query + '*');
    } catch (e) {
      results = lunrIndex.search(query);
    }
    results = results.slice(0, 8);
    activeIndex = -1;

    if (results.length === 0) {
      resultsContainer.innerHTML = '<div class="search-modal__empty">No results found</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < results.length; i++) {
      var item = window.store[results[i].ref];
      if (!item) continue;
      var date = item.date ? new Date(item.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      var category = item.category || '';
      html += '<a href="' + item.url + '" class="search-modal__result" data-index="' + i + '">';
      html += '<div class="search-modal__result-title">' + escapeHtml(item.title) + '</div>';
      html += '<div class="search-modal__result-meta">';
      if (date) html += '<span>' + date + '</span>';
      if (category) html += '<span>' + escapeHtml(category) + '</span>';
      html += '</div></a>';
    }
    resultsContainer.innerHTML = html;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function updateActive() {
    var items = resultsContainer.querySelectorAll('.search-modal__result');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('search-modal__result--active', i === activeIndex);
    }
    if (items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  // Trigger
  if (trigger) {
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openModal();
    });
  }

  // Close
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);

  // Input
  input.addEventListener('input', function () {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      renderResults(input.value);
    }, 200);
  });

  // Keyboard
  input.addEventListener('keydown', function (e) {
    var items = resultsContainer.querySelectorAll('.search-modal__result');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive();
    } else if (e.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
      e.preventDefault();
      items[activeIndex].click();
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', function (e) {
    // Open with / or Cmd/Ctrl+K
    if ((e.key === '/' && !isInputFocused()) ||
        ((e.metaKey || e.ctrlKey) && e.key === 'k')) {
      e.preventDefault();
      openModal();
    }
    // Close with Esc
    if (e.key === 'Escape' && modal.classList.contains('search-modal--open')) {
      e.preventDefault();
      closeModal();
    }
  });

  function isInputFocused() {
    var el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
})();
