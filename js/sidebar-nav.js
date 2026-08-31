window.FleetMagnifySidebar = (function() {

  var ON_ROAD_TYPES = ['Light Vehicle', 'Rigid Truck', 'Semi Trailer', 'Truck & Trailer'];

  var NAV_ITEMS = [
    { type: 'link', href: 'home.html', icon: '🏠', text: 'Overview' },
    { type: 'label', text: 'Machinery Modules' },
    { type: 'link', href: 'fuel-analyst.html', icon: '⛽', text: 'Fuel Analyst' },
    { type: 'link', href: 'idle-cost-analyst.html', icon: '⏱', text: 'Idle Cost Analyst' },
    { type: 'link', href: 'emissions-intelligence.html', icon: '🌍', text: 'Emissions Intelligence' },
    { type: 'link', href: 'utilisation-analyst.html', icon: '📊', text: 'True Utilisation Analyst' },
    { type: 'link', href: 'job-cost-analyst.html', icon: '🏗', text: 'Job Cost Analyst' },
    { type: 'label', text: 'Truck Modules' },
    { type: 'link', href: 'truck-fuel-analyst.html', icon: '🚛', text: 'Fuel Cost Analyst' },
    { type: 'link', href: 'truck-idle-monitor.html', icon: '⏸', text: 'Idle Monitor' },
    { type: 'link', href: 'cost-per-km-analyst.html', icon: '📏', text: 'Cost Per KM Analyst' },
    { type: 'link', href: 'truck-emissions-analyst.html', icon: '🌿', text: 'Emissions Analyst' },
    { type: 'link', href: 'trip-report.html', icon: '🗺️', text: 'Trip Report' },
    { type: 'link', href: 'orion-fuel-report.html', icon: '🧾', text: 'Orion Fuel Report', requiresWorkOrderReport: true },
    { type: 'label', text: 'Fleet Management' },
    { type: 'link', href: 'reports.html', icon: '📋', text: 'Reports' },
    { type: 'link', href: 'assets.html', icon: '🚧', text: 'Assets' },
    { type: 'link', href: 'upload.html', icon: '📤', text: 'Upload Data' },
    { type: 'link', href: 'integrations.html', icon: '🔌', text: 'Integrations' },
    { type: 'link', href: 'settings.html', icon: '⚙️', text: 'Settings' }
  ];

  function renderNavItems(activePage) {
    return NAV_ITEMS.map(function(item) {
      if (item.type === 'label') {
        return '<div class="nav-label">' + item.text + '</div>';
      }
      var cls = (item.href === activePage) ? 'nav-item active' : 'nav-item';
      var attrs = item.requiresWorkOrderReport
        ? ' data-work-order-report="true" style="display:none"'
        : '';
      return '<a class="' + cls + '" href="' + item.href + '"' + attrs + '><span class="nav-icon">' + item.icon + '</span> ' + item.text + '</a>';
    }).join('\n    ');
  }

  function render(activePage) {
    return '' +
      '<aside class="sidebar">\n' +
      '  <a class="sidebar-logo" href="home.html">\n' +
      '    <div class="logo-mark">FM</div>\n' +
      '    <span class="logo-name">Fleet<span>Magnify</span></span>\n' +
      '  </a>\n' +
      '  <nav class="sidebar-nav">\n' +
      '    ' + renderNavItems(activePage) + '\n' +
      '  </nav>\n' +
      '  <div class="sidebar-footer">\n' +
      '    <button class="btn-signout" id="signout-btn">↩ Sign Out</button>\n' +
      '  </div>\n' +
      '</aside>';
  }

  async function detectFleetComposition(supabase, effectiveAccountId) {
    try {
      var result = await supabase
        .from('assets')
        .select('asset_type')
        .eq('user_id', effectiveAccountId)
        .eq('is_ignored', false);

      if (result.error) {
        console.warn('FleetMagnifySidebar: failed to detect fleet composition', result.error);
        return { hasTrucks: true, hasMachinery: true };
      }

      var hasTrucks = false;
      var hasMachinery = false;
      (result.data || []).forEach(function(row) {
        if (!row.asset_type) return;
        if (ON_ROAD_TYPES.indexOf(row.asset_type) !== -1) {
          hasTrucks = true;
        } else {
          hasMachinery = true;
        }
      });

      return { hasTrucks: hasTrucks, hasMachinery: hasMachinery };
    } catch (err) {
      console.warn('FleetMagnifySidebar: failed to detect fleet composition', err);
      return { hasTrucks: true, hasMachinery: true };
    }
  }

  function setSectionVisibility(nav, labelText, visible) {
    var labels = nav.querySelectorAll('.nav-label');
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent !== labelText) continue;
      labels[i].style.display = visible ? '' : 'none';
      var node = labels[i].nextElementSibling;
      while (node && !node.classList.contains('nav-label')) {
        node.style.display = visible ? '' : 'none';
        node = node.nextElementSibling;
      }
      break;
    }
  }

  function mount(activePage) {
    var html = render(activePage);
    var placeholder = document.getElementById('sidebar-placeholder');
    var existing = document.querySelector('aside.sidebar');
    if (placeholder) {
      placeholder.outerHTML = html;
    } else if (existing) {
      existing.outerHTML = html;
    } else {
      console.warn('FleetMagnifySidebar: no #sidebar-placeholder element found on this page');
    }
  }

  async function inject(activePage, supabase, effectiveAccountId) {
    mount(activePage);

    if (!supabase || !effectiveAccountId) return;

    // Show Orion / work-order report nav when the *resolved account owner*
    // has profiles.has_work_order_report — not auth.uid(). Account members
    // (e.g. Riki/Peter on ILS) resolve to the owner and inherit the flag.
    var hasWorkOrderReport = false;
    try {
      var flagResult = await supabase
        .from('profiles')
        .select('has_work_order_report')
        .eq('id', effectiveAccountId)
        .maybeSingle();
      hasWorkOrderReport = !!(flagResult.data && flagResult.data.has_work_order_report);
    } catch (err) {
      console.warn('FleetMagnifySidebar: failed to read has_work_order_report', err);
    }

    var composition = await detectFleetComposition(supabase, effectiveAccountId);
    var nav = document.querySelector('.sidebar-nav');
    if (nav && (composition.hasTrucks || composition.hasMachinery)) {
      if (!composition.hasMachinery) setSectionVisibility(nav, 'Machinery Modules', false);
      if (!composition.hasTrucks) setSectionVisibility(nav, 'Truck Modules', false);
    }

    // Apply after fleet composition so a section hide does not wipe the flag link.
    if (hasWorkOrderReport) {
      var woItems = document.querySelectorAll('[data-work-order-report="true"]');
      for (var i = 0; i < woItems.length; i++) { woItems[i].style.display = ''; }
      if (nav && !composition.hasTrucks) {
        var labels = nav.querySelectorAll('.nav-label');
        for (var j = 0; j < labels.length; j++) {
          if (labels[j].textContent === 'Truck Modules') {
            labels[j].style.display = '';
            break;
          }
        }
      }
    }
  }

  async function setAccountChip(supabase, accountId, fallbackUser) {
    var name = '';
    if (supabase && accountId) {
      try {
        var result = await supabase.from('profiles').select('company_name').eq('id', accountId).maybeSingle();
        name = result.data && result.data.company_name ? String(result.data.company_name).trim() : '';
      } catch (e) { /* fall through */ }
    }
    if (!name && fallbackUser && fallbackUser.user_metadata && fallbackUser.user_metadata.company_name) {
      name = String(fallbackUser.user_metadata.company_name).trim();
    }
    if (!name) name = 'FleetMagnify';
    var nameEl = document.getElementById('user-name');
    var avatarEl = document.getElementById('user-avatar');
    if (nameEl) nameEl.textContent = name;
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
    var companyEl = document.getElementById('company-name');
    if (companyEl) companyEl.textContent = name;
    return name;
  }

  return { render: render, inject: inject, mount: mount, setAccountChip: setAccountChip };

})();
