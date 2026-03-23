(function () {
  "use strict";

  var tocContainer = document.getElementById("toc-sidebar");
  var tocToggle = document.getElementById("toc-toggle");

  if (!tocContainer) return;

  // Collect h2 and h3 headings from post content
  var content = document.querySelector(".page__content");
  if (!content) return;

  var headings = content.querySelectorAll("h2[id], h3[id]");
  if (headings.length === 0) {
    // Hide TOC elements if no headings found
    tocContainer.style.display = "none";
    if (tocToggle) tocToggle.style.display = "none";
    return;
  }

  // Build TOC HTML
  var html = '<h4 class="toc-sidebar__title">On this page</h4><ul>';
  for (var i = 0; i < headings.length; i++) {
    var h = headings[i];
    var level = h.tagName.toLowerCase();
    var className = level === "h3" ? "toc-h3" : "";
    html +=
      '<li class="' +
      className +
      '"><a href="#' +
      h.id +
      '">' +
      h.textContent +
      "</a></li>";
  }
  html += "</ul>";
  tocContainer.innerHTML = html;

  // Scroll spy: highlight current section
  var tocLinks = tocContainer.querySelectorAll("a");
  var headingOffsets = [];

  function updateOffsets() {
    headingOffsets = [];
    for (var i = 0; i < headings.length; i++) {
      headingOffsets.push({
        id: headings[i].id,
        top: headings[i].getBoundingClientRect().top + window.pageYOffset,
      });
    }
  }

  function onScroll() {
    var scrollPos = window.pageYOffset + 80;
    var current = "";

    for (var i = 0; i < headingOffsets.length; i++) {
      if (headingOffsets[i].top <= scrollPos) {
        current = headingOffsets[i].id;
      }
    }

    for (var j = 0; j < tocLinks.length; j++) {
      var href = tocLinks[j].getAttribute("href");
      if (href === "#" + current) {
        tocLinks[j].classList.add("toc--active");
      } else {
        tocLinks[j].classList.remove("toc--active");
      }
    }
  }

  updateOffsets();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () {
    updateOffsets();
    onScroll();
  });
  onScroll();

  // Mobile toggle
  if (tocToggle) {
    tocToggle.addEventListener("click", function () {
      var isOpen = tocContainer.classList.toggle("toc-sidebar--open");
      tocToggle.classList.toggle("toc-toggle--open", isOpen);
    });
  }
})();
