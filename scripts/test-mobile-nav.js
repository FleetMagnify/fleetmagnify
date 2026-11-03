/**
 * Phone menu button: the sidebar is often mounted after mobile-nav.js runs.
 * Invented page structure only. No customer data.
 *
 *   node scripts/test-mobile-nav.js
 */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var assert = require('assert');

var pass = true;
function check(label, fn) {
  try {
    fn();
    console.log('[PASS] ' + label);
  } catch (err) {
    pass = false;
    console.log('[FAIL] ' + label + ' — ' + err.message);
  }
}

var root = path.join(__dirname, '..');
var mobileNavSource = fs.readFileSync(path.join(root, 'js', 'mobile-nav.js'), 'utf8');
var sidebarSource = fs.readFileSync(path.join(root, 'js', 'sidebar-nav.js'), 'utf8');

function classTokens(el) {
  return String(el.className || '').split(/\s+/).filter(Boolean);
}

function matches(el, selector) {
  var sel = String(selector || '').trim();
  if (!sel) return false;
  if (sel.indexOf(',') !== -1) {
    return sel.split(',').some(function (part) { return matches(el, part); });
  }
  if (/\s/.test(sel)) {
    var bits = sel.split(/\s+/);
    if (!matches(el, bits[bits.length - 1])) return false;
    var rest = bits.slice(0, -1).join(' ');
    var ancestor = el.parentNode;
    while (ancestor) {
      if (ancestor.tagName && matches(ancestor, rest)) return true;
      ancestor = ancestor.parentNode;
    }
    return false;
  }
  if (sel.charAt(0) === '.') return classTokens(el).indexOf(sel.slice(1)) !== -1;
  if (sel.charAt(0) === '#') return el.id === sel.slice(1);
  var dot = sel.indexOf('.');
  if (dot !== -1) {
    return el.tagName === sel.slice(0, dot).toUpperCase() && classTokens(el).indexOf(sel.slice(dot + 1)) !== -1;
  }
  return el.tagName === sel.toUpperCase();
}

function walk(node, fn) {
  (node.children || []).forEach(function (child) {
    fn(child);
    walk(child, fn);
  });
}

function queryAll(rootNode, selector) {
  var found = [];
  walk(rootNode, function (el) {
    if (matches(el, selector)) found.push(el);
  });
  return found;
}

function createElement(tag) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    className: '',
    type: '',
    innerHTML: '',
    textContent: '',
    parentNode: null,
    children: [],
    attributes: {},
    style: {},
    _listeners: {}
  };
  el.classList = {
    contains: function (name) { return classTokens(el).indexOf(name) !== -1; },
    toggle: function (name, force) {
      var has = classTokens(el).indexOf(name) !== -1;
      var on = force === undefined ? !has : !!force;
      var tokens = classTokens(el).filter(function (token) { return token !== name; });
      if (on) tokens.push(name);
      el.className = tokens.join(' ');
      return on;
    },
    add: function (name) { el.classList.toggle(name, true); },
    remove: function (name) { el.classList.toggle(name, false); }
  };
  el.setAttribute = function (name, value) { el.attributes[name] = String(value); };
  el.getAttribute = function (name) { return el.attributes[name]; };
  el.appendChild = function (child) {
    if (child.parentNode) {
      var index = child.parentNode.children.indexOf(child);
      if (index !== -1) child.parentNode.children.splice(index, 1);
    }
    child.parentNode = el;
    el.children.push(child);
    return child;
  };
  el.insertBefore = function (child, ref) {
    if (child.parentNode) {
      var index = child.parentNode.children.indexOf(child);
      if (index !== -1) child.parentNode.children.splice(index, 1);
    }
    child.parentNode = el;
    var at = el.children.indexOf(ref);
    if (at === -1) el.children.push(child);
    else el.children.splice(at, 0, child);
    return child;
  };
  el.cloneNode = function () {
    var copy = createElement(el.tagName.toLowerCase());
    copy.id = el.id;
    copy.className = el.className;
    copy.type = el.type;
    copy.innerHTML = el.innerHTML;
    copy.textContent = el.textContent;
    el.children.forEach(function (child) { copy.appendChild(child.cloneNode()); });
    return copy;
  };
  el.addEventListener = function (type, fn, opts) {
    el._listeners[type] = el._listeners[type] || [];
    el._listeners[type].push({ fn: fn, once: !!(opts && opts.once) });
  };
  el.dispatchEvent = function (event) {
    var list = (el._listeners[event.type] || []).slice();
    list.forEach(function (item) { item.fn(event); });
    el._listeners[event.type] = (el._listeners[event.type] || []).filter(function (item) {
      return !item.once;
    });
    return true;
  };
  el.querySelector = function (selector) { return queryAll(el, selector)[0] || null; };
  el.querySelectorAll = function (selector) { return queryAll(el, selector); };
  Object.defineProperty(el, 'firstChild', {
    get: function () { return el.children[0] || null; }
  });
  return el;
}

function makeDocument(body) {
  var doc = {
    readyState: 'complete',
    body: body,
    _listeners: {}
  };
  doc.children = [body];
  body.parentNode = doc;
  doc.createElement = createElement;
  doc.getElementById = function (id) {
    var found = null;
    walk(doc, function (el) { if (el.id === id) found = el; });
    return found;
  };
  doc.querySelector = function (selector) { return queryAll(doc, selector)[0] || null; };
  doc.querySelectorAll = function (selector) { return queryAll(doc, selector); };
  doc.addEventListener = function (type, fn, opts) {
    doc._listeners[type] = doc._listeners[type] || [];
    doc._listeners[type].push({ fn: fn, once: !!(opts && opts.once) });
  };
  doc.dispatchEvent = function (event) {
    var list = (doc._listeners[event.type] || []).slice();
    list.forEach(function (item) { item.fn(event); });
    doc._listeners[event.type] = (doc._listeners[event.type] || []).filter(function (item) {
      return !item.once;
    });
    return true;
  };
  return doc;
}

function makeWindow(width) {
  return {
    innerWidth: width == null ? 390 : width,
    _listeners: {},
    addEventListener: function (type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push({ fn: fn });
    },
    dispatchEvent: function (event) {
      (this._listeners[event.type] || []).forEach(function (item) { item.fn(event); });
    }
  };
}

function appShell(withTopbar) {
  var body = createElement('body');
  var main = createElement('div');
  main.className = 'main';
  if (withTopbar !== false) {
    var topbar = createElement('div');
    topbar.className = 'topbar';
    main.appendChild(topbar);
  }
  body.appendChild(main);
  return body;
}

function addSidebar(body) {
  var sidebar = createElement('aside');
  sidebar.className = 'sidebar';
  var nav = createElement('nav');
  nav.className = 'sidebar-nav';
  var link = createElement('a');
  link.textContent = 'Overview';
  nav.appendChild(link);
  var footer = createElement('div');
  footer.className = 'sidebar-footer';
  var signout = createElement('button');
  signout.className = 'btn-signout';
  footer.appendChild(signout);
  sidebar.appendChild(nav);
  sidebar.appendChild(footer);
  body.insertBefore(sidebar, body.firstChild);
  return sidebar;
}

function count(doc, selector) {
  return doc.querySelectorAll(selector).length;
}

function load(doc, win) {
  var records = [];
  function MutationObserver(callback) {
    this.callback = callback;
    this.disconnected = false;
    this.observing = false;
    records.push(this);
  }
  MutationObserver.prototype.observe = function () { this.observing = true; };
  MutationObserver.prototype.disconnect = function () { this.disconnected = true; };
  var sandbox = {
    document: doc,
    window: win,
    MutationObserver: MutationObserver,
    console: console
  };
  vm.createContext(sandbox);
  vm.runInContext(mobileNavSource, sandbox);
  return records;
}

check('the app-sidebar setup runs once when the sidebar already exists', function () {
  var body = appShell();
  addSidebar(body);
  var doc = makeDocument(body);
  var win = makeWindow(390);
  load(doc, win);
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 1);
  var btn = doc.querySelector('.mobile-menu-btn');
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Open menu');
  assert.strictEqual(btn.parentNode.className, 'topbar');
  btn.dispatchEvent({ type: 'click' });
  assert.ok(body.classList.contains('sidebar-open'));
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Close menu');
  doc.querySelector('.sidebar-backdrop').dispatchEvent({ type: 'click' });
  assert.ok(!body.classList.contains('sidebar-open'));
  doc.querySelector('aside.sidebar a').dispatchEvent({ type: 'click' });
  btn.dispatchEvent({ type: 'click' });
  assert.ok(body.classList.contains('sidebar-open'));
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.ok(!body.classList.contains('sidebar-open'));
  btn.dispatchEvent({ type: 'click' });
  win.innerWidth = 1024;
  win.dispatchEvent({ type: 'resize' });
  assert.ok(!body.classList.contains('sidebar-open'));
  load(doc, win);
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 1);
});

check('a placeholder page waits for the sidebar event, then creates one button', function () {
  var body = appShell();
  var placeholder = createElement('div');
  placeholder.id = 'sidebar-placeholder';
  body.insertBefore(placeholder, body.firstChild);
  var doc = makeDocument(body);
  var records = load(doc, makeWindow(390));
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 0);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 0);
  assert.strictEqual(count(doc, '.landing-nav-panel'), 0);
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].observing, true);

  addSidebar(body);
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 0);

  doc.dispatchEvent({ type: 'fleetmagnify:sidebar-mounted' });
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 1);
  doc.dispatchEvent({ type: 'fleetmagnify:sidebar-mounted' });
  records[0].callback();
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 1);
});

check('the sidebar observer is a safety net and still creates only one button', function () {
  var body = appShell();
  var placeholder = createElement('div');
  placeholder.id = 'sidebar-placeholder';
  body.insertBefore(placeholder, body.firstChild);
  var doc = makeDocument(body);
  var records = load(doc, makeWindow(390));
  addSidebar(body);
  records[0].callback();
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(records[0].disconnected, true);
  records[0].callback();
  doc.dispatchEvent({ type: 'fleetmagnify:sidebar-mounted' });
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
});

check('a page with no sidebar and no placeholder takes the landing-nav path', function () {
  var body = createElement('body');
  var nav = createElement('nav');
  var inner = createElement('div');
  inner.className = 'nav-inner';
  var links = createElement('div');
  links.className = 'nav-links';
  var home = createElement('a');
  home.textContent = 'Home';
  links.appendChild(home);
  var actions = createElement('div');
  actions.className = 'nav-actions';
  inner.appendChild(links);
  inner.appendChild(actions);
  nav.appendChild(inner);
  body.appendChild(nav);
  var doc = makeDocument(body);
  var records = load(doc, makeWindow(390));
  assert.strictEqual(count(doc, '.landing-nav-panel'), 1);
  assert.strictEqual(count(doc, '.landing-nav-backdrop'), 1);
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 1);
  assert.strictEqual(count(doc, '.sidebar-backdrop'), 0);
  assert.strictEqual(records.length, 0);
  var btn = doc.querySelector('.mobile-menu-btn');
  btn.dispatchEvent({ type: 'click' });
  assert.ok(body.classList.contains('nav-open'));
  assert.strictEqual(btn.getAttribute('aria-label'), 'Close menu');
});

check('a mounted sidebar with no topbar does not throw and adds no button', function () {
  var body = appShell(false);
  addSidebar(body);
  var doc = makeDocument(body);
  load(doc, makeWindow(390));
  assert.strictEqual(count(doc, '.mobile-menu-btn'), 0);
});

check('sidebar mount dispatches fleetmagnify:sidebar-mounted after the aside is inserted', function () {
  var mountAt = sidebarSource.indexOf('function mount(activePage)');
  var warnAt = sidebarSource.indexOf('no #sidebar-placeholder element found on this page');
  var dispatchAt = sidebarSource.indexOf("document.dispatchEvent(new CustomEvent('fleetmagnify:sidebar-mounted'))");
  assert.ok(mountAt !== -1 && warnAt > mountAt && dispatchAt > warnAt);
  var between = sidebarSource.slice(warnAt, dispatchAt);
  assert.ok(between.indexOf('return;') !== -1);
  assert.ok(mobileNavSource.indexOf("document.addEventListener('fleetmagnify:sidebar-mounted'") !== -1);
  assert.ok(mobileNavSource.indexOf('{ once: true }') !== -1);
  assert.ok(mobileNavSource.indexOf("document.querySelector('.mobile-menu-btn')") !== -1);
  assert.ok(mobileNavSource.indexOf('sidebar.querySelectorAll(\'a, button\')') !== -1);
  assert.ok(mobileNavSource.indexOf('closeMenu') !== -1);
});

check('every page with a sidebar placeholder loads the phone menu script and stylesheet', function () {
  var pages = fs.readdirSync(root).filter(function (name) { return name.slice(-5) === '.html'; }).sort();
  var withPlaceholder = [];
  pages.forEach(function (name) {
    var text = fs.readFileSync(path.join(root, name), 'utf8');
    if (text.indexOf('id="sidebar-placeholder"') === -1) return;
    withPlaceholder.push(name);
    assert.ok(text.indexOf('js/mobile-nav.js') !== -1, name + ' loads js/mobile-nav.js');
    assert.ok(text.indexOf('css/mobile-responsive.css') !== -1, name + ' links css/mobile-responsive.css');
  });
  assert.ok(withPlaceholder.indexOf('divisions.html') !== -1);
  assert.ok(withPlaceholder.indexOf('home.html') !== -1);
  console.log('       pages: ' + withPlaceholder.join(', '));
});

if (!pass) process.exit(1);
console.log('All mobile nav checks passed.');
