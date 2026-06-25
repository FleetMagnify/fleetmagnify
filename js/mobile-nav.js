(function () {
  'use strict';

  var MOBILE_BP = 768;

  function isMobile() {
    return window.innerWidth <= MOBILE_BP;
  }

  function createBackdrop(className) {
    var el = document.createElement('div');
    el.className = className;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    return el;
  }

  function createMenuBtn() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-menu-btn';
    btn.setAttribute('aria-label', 'Open menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '&#9776;';
    return btn;
  }

  function initAppSidebar() {
    var sidebar = document.querySelector('aside.sidebar');
    if (!sidebar) return false;
    if (!document.querySelector('.main, .main-area, .app-layout, .app-shell')) return false;
    if (!sidebar.querySelector('.sidebar-nav, .sidebar-footer, .btn-signout')) return false;

    var backdrop = createBackdrop('sidebar-backdrop');
    var btn = createMenuBtn();
    var topbar = document.querySelector('.topbar');
    if (topbar) {
      topbar.insertBefore(btn, topbar.firstChild);
    }

    function setOpen(open) {
      document.body.classList.toggle('sidebar-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      btn.innerHTML = open ? '&times;' : '&#9776;';
    }

    function closeMenu() {
      setOpen(false);
    }

    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('sidebar-open'));
    });
    backdrop.addEventListener('click', closeMenu);

    sidebar.querySelectorAll('a, button').forEach(function (el) {
      el.addEventListener('click', function () {
        if (isMobile()) closeMenu();
      });
    });

    window.addEventListener('resize', function () {
      if (!isMobile()) closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    return true;
  }

  function initLandingNav() {
    var navInner = document.querySelector('nav .nav-inner');
    if (!navInner) return;
    if (document.querySelector('aside.sidebar')) return;

    var links = navInner.querySelector('.nav-links');
    var actions = navInner.querySelector('.nav-actions');
    if (!links || navInner.querySelector('.mobile-menu-btn')) return;

    var panel = document.createElement('div');
    panel.className = 'landing-nav-panel';
    panel.appendChild(links.cloneNode(true));
    if (actions) panel.appendChild(actions.cloneNode(true));
    document.body.appendChild(panel);

    var backdrop = createBackdrop('landing-nav-backdrop');
    var btn = createMenuBtn();
    navInner.appendChild(btn);

    function setOpen(open) {
      document.body.classList.toggle('nav-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      btn.innerHTML = open ? '&times;' : '&#9776;';
    }

    function closeMenu() {
      setOpen(false);
    }

    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('nav-open'));
    });
    backdrop.addEventListener('click', closeMenu);

    panel.querySelectorAll('a').forEach(function (el) {
      el.addEventListener('click', closeMenu);
    });

    window.addEventListener('resize', function () {
      if (!isMobile()) closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!initAppSidebar()) initLandingNav();
    });
  } else {
    if (!initAppSidebar()) initLandingNav();
  }
})();
