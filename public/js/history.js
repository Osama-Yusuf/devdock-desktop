const $ = id => document.getElementById(id);
    let allEntries = [];
    let groupByProject = false;
    let groupingDepth = 1;

    function showToast(msg, type = 'success') {
      const t = document.createElement('div');
      t.className = `toast toast-${type}`;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    function timeAgo(dateStr) {
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 7) return `${days}d ago`;
      return new Date(dateStr).toLocaleDateString();
    }

    async function openTerminal(dir) {
      try {
        const res = await fetch('/api/open-terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        if (res.ok) showToast(`Terminal opened`);
        else showToast('Failed to open terminal', 'warn');
      } catch { showToast('Failed to open terminal', 'warn'); }
    }

    const menuBackdrop = $('menuBackdrop');
    const floatingMenu = $('floatingMenu');

    function closeMenus() {
      floatingMenu.classList.remove('open');
      floatingMenu.innerHTML = '';
      menuBackdrop.classList.remove('open');
    }

    function toggleMenu(id, triggerEl) {
      const sourceMenu = document.getElementById(`hmenu-${id}`);
      if (!sourceMenu) return;

      const wasOpen = floatingMenu.classList.contains('open');
      closeMenus();
      if (wasOpen) return;

      // Clone menu content into the floating container on <body>
      floatingMenu.innerHTML = sourceMenu.innerHTML;

      const rect = triggerEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < 150) {
        floatingMenu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        floatingMenu.style.top = 'auto';
      } else {
        floatingMenu.style.top = (rect.bottom + 4) + 'px';
        floatingMenu.style.bottom = 'auto';
      }
      floatingMenu.style.right = (window.innerWidth - rect.right) + 'px';
      floatingMenu.style.left = 'auto';
      floatingMenu.classList.add('open');
      menuBackdrop.classList.add('open');
    }

    menuBackdrop.addEventListener('click', closeMenus);
    floatingMenu.addEventListener('click', (e) => {
      // Close menu after clicking any button inside it
      if (e.target.closest('button')) {
        setTimeout(closeMenus, 50);
      }
    });

    async function startServer(port, dir) {
      document.querySelectorAll('.actions-menu').forEach(m => m.classList.remove('open'));
      try {
        const res = await fetch('/api/start-server', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir, port }),
        });
        if (res.ok) {
          showToast(`Starting server in ${dir.split('/').pop()}...`);
          setTimeout(loadHistory, 2000);
        } else {
          const d = await res.json();
          showToast(d.error || 'Failed to start', 'warn');
        }
      } catch { showToast('Failed to start server', 'warn'); }
    }

    async function removeFromHistory(port) {
      if (!confirm(`Remove port ${port} from history?`)) return;
      await fetch(`/api/history/${port}`, { method: 'DELETE' });
      showToast(`Port ${port} removed`);
      loadHistory();
    }

    async function clearAll() {
      if (!confirm('Clear all port history?')) return;
      await fetch('/api/history', { method: 'DELETE' });
      showToast('History cleared');
      loadHistory();
    }

    function getGroupKey(scriptPath, depth) {
      if (!scriptPath || scriptPath === '/') return 'Unknown';
      const parts = scriptPath.replace(/\/$/, '').split('/');
      if (parts.length > depth) return parts.slice(0, parts.length - depth).join('/');
      return scriptPath;
    }

    function toggleGroupRows(headerEl) {
      const tr = headerEl.closest('tr');
      const collapsed = headerEl.classList.contains('collapsed');
      let next = tr.nextElementSibling;
      while (next && !next.querySelector('.group-header')) {
        next.style.display = collapsed ? 'none' : '';
        next = next.nextElementSibling;
      }
    }

    function updateFilters() {
      const runtimes = new Set();
      allEntries.forEach(e => { if (e.runtime) runtimes.add(e.runtime); });
      const cur = $('runtimeFilter').value;
      $('runtimeFilter').innerHTML = '<option value="all">All Runtimes</option>';
      Array.from(runtimes).sort().forEach(rt => {
        const opt = document.createElement('option');
        opt.value = rt;
        opt.textContent = allEntries.find(e => e.runtime === rt)?.runtimeName || rt;
        $('runtimeFilter').appendChild(opt);
      });
      if (cur !== 'all' && runtimes.has(cur)) $('runtimeFilter').value = cur;
    }

    function renderTable() {
      const term = $('searchInput').value.toLowerCase();
      const rtFilter = $('runtimeFilter').value;
      const statusFilter = $('statusFilter').value;
      const tbody = $('tableBody');
      tbody.innerHTML = '';

      const filtered = allEntries.filter(e => {
        const matchesSearch = !term ||
          String(e.port || '').includes(term) ||
          String(e.pid || '').toLowerCase().includes(term) ||
          String(e.command || '').toLowerCase().includes(term) ||
          String(e.runtimeName || '').toLowerCase().includes(term) ||
          String(e.scriptPath || '').toLowerCase().includes(term) ||
          String(e.user || '').toLowerCase().includes(term);

        const matchesRuntime = rtFilter === 'all' || e.runtime === rtFilter;
        const matchesStatus = statusFilter === 'all' ||
          (statusFilter === 'running' && !e.stopped) ||
          (statusFilter === 'stopped' && e.stopped);

        return matchesSearch && matchesRuntime && matchesStatus;
      });

      // Result info
      if (allEntries.length > 0 && filtered.length !== allEntries.length) {
        $('resultInfo').textContent = `Showing ${filtered.length} of ${allEntries.length}`;
      } else {
        $('resultInfo').textContent = '';
      }

      if (filtered.length === 0) {
        $('emptyState').style.display = 'block';
        $('emptyState').textContent = (term || rtFilter !== 'all' || statusFilter !== 'all')
          ? 'No entries match your filters.'
          : 'No port history yet. Ports will be recorded as you use the dashboard.';
        $('tableContainer').style.display = 'none';
        return;
      }

      $('emptyState').style.display = 'none';
      $('tableContainer').style.display = 'block';

      function buildRow(e) {
        const tr = document.createElement('tr');
        if (e.stopped) tr.classList.add('row-stopped');

        const pathClass = e.stopped && !e.pathExists ? 'path-gone' : 'path-ok';
        const canOpenTerminal = !e.stopped || e.pathExists;

        tr.innerHTML = `
          <td>
            <span class="status-badge ${e.stopped ? 'status-stopped' : 'status-running'}">
              <span style="width:6px;height:6px;border-radius:50%;background:${e.stopped ? 'var(--text-dim)' : 'var(--green)'};"></span>
              ${e.stopped ? 'Stopped' : 'Running'}
            </span>
          </td>
          <td>${e.port
            ? `<a href="http://localhost:${e.port}" target="_blank" class="code" style="color:var(--accent);text-decoration:none;">${e.port}</a>`
            : '<span class="code">&mdash;</span>'
          }</td>
          <td><span class="code" style="color:var(--text-muted);">${e.stopped ? '\u2014' : e.pid}</span></td>
          <td class="col-user">${e.user || '\u2014'}</td>
          <td class="col-cmd"><span class="code">${e.command || '\u2014'}</span></td>
          <td>
            <span class="runtime-tag" style="background:${e.runtimeColor}18;color:${e.runtimeColor};border:1px solid ${e.runtimeColor}40;">
              <span class="runtime-icon" style="background:${e.runtimeColor}">${e.runtimeIcon || '?'}</span>
              ${e.runtimeName}
            </span>
          </td>
          <td>${e.scriptPath
            ? (canOpenTerminal
              ? `<span class="path-link ${pathClass}" onclick="openTerminal('${e.scriptPath.replace(/'/g, "\\'")}')" title="${e.pathExists === false ? 'Path no longer exists' : 'Click to open terminal'}">${e.scriptPath}</span>`
              : `<span class="code ${pathClass}" title="Path no longer exists">${e.scriptPath}</span>`)
            : '<span class="code">\u2014</span>'
          }</td>
          <td class="col-lastseen"><span class="time-ago" title="${e.lastSeen || ''}">${e.lastSeen ? timeAgo(e.lastSeen) : '\u2014'}</span></td>
          <td class="actions-cell" style="text-align:right;">
            <button class="actions-trigger" onclick="event.stopPropagation();toggleMenu('${e.port}-${e.stopped?'s':'r'}',this)">
              \u22EF
            </button>
            <div class="actions-menu" id="hmenu-${e.port}-${e.stopped?'s':'r'}">
              ${e.stopped && e.scriptPath && e.pathExists !== false ? `<button onclick="startServer(${e.port},'${e.scriptPath.replace(/'/g, "\\'")}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Start server
              </button>` : ''}
              ${!e.stopped ? `<button disabled style="opacity:0.4;cursor:default;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Already running
              </button>` : ''}
              ${e.stopped ? `
                <div class="actions-divider"></div>
                <button class="danger" onclick="removeFromHistory(${e.port})">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  Remove
                </button>` : ''}
            </div>
          </td>
        `;
        return tr;
      }

      if (groupByProject) {
        const groups = {};
        filtered.forEach(e => {
          const key = getGroupKey(e.scriptPath, groupingDepth);
          if (!groups[key]) groups[key] = [];
          groups[key].push(e);
        });
        Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).forEach(([groupPath, entries]) => {
          const headerTr = document.createElement('tr');
          headerTr.innerHTML = `<td colspan="9" style="padding:0;">
            <div class="group-header" onclick="this.classList.toggle('collapsed');toggleGroupRows(this)">
              <span class="group-chevron">\u25BC</span>
              <span class="group-name">${groupPath}</span>
              <span class="group-count">${entries.length}</span>
            </div></td>`;
          tbody.appendChild(headerTr);
          entries.forEach(e => tbody.appendChild(buildRow(e)));
        });
      } else {
        filtered.forEach(e => tbody.appendChild(buildRow(e)));
      }
    }

    async function loadHistory() {
      try {
        const res = await fetch('/api/ports');
        const data = await res.json();

        const running = (data.ports || []).map(p => ({
          ...p,
          stopped: false,
          pathExists: true,
          lastSeen: data.timestamp,
        }));

        const stopped = (data.history || []);

        // Running first, then stopped sorted by lastSeen desc
        allEntries = [
          ...running.sort((a, b) => (a.port || 0) - (b.port || 0)),
          ...stopped.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '')),
        ];

        $('runningCount').textContent = running.length;
        $('stoppedCount').textContent = stopped.length;

        updateFilters();
        renderTable();
      } catch (err) {
        console.error('Failed to load history', err);
      }
    }

    // Events
    $('searchInput').addEventListener('input', renderTable);
    $('runtimeFilter').addEventListener('change', renderTable);
    $('statusFilter').addEventListener('change', renderTable);
    $('clearFilters').addEventListener('click', () => {
      $('searchInput').value = '';
      $('runtimeFilter').value = 'all';
      $('statusFilter').value = 'all';
      renderTable();
    });
    $('clearAllBtn').addEventListener('click', clearAll);
    $('groupToggle').addEventListener('click', () => {
      groupByProject = !groupByProject;
      $('groupToggle').style.background = groupByProject ? 'rgba(96,165,250,0.2)' : '';
      $('groupToggle').style.borderColor = groupByProject ? 'rgba(96,165,250,0.5)' : '';
      renderTable();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') { e.target.blur(); closeMenus(); }
        return;
      }
      switch (e.key) {
        case '/': e.preventDefault(); $('searchInput').focus(); break;
        case 'd': window.location.href = '/'; break;
        case 'g': $('groupToggle').click(); break;
        case 'Escape':
          closeMenus();
          $('searchInput').value = '';
          $('runtimeFilter').value = 'all';
          $('statusFilter').value = 'all';
          renderTable();
          break;
      }
    });

    // Init
    (async function init() {
      try {
        const stRes = await fetch('/api/settings');
        const settings = await stRes.json();
        if (settings.theme) {
          document.documentElement.setAttribute('data-theme', settings.theme);
        }
        if (settings.groupingDepth != null) groupingDepth = settings.groupingDepth;
      } catch {}
      loadHistory();
    })();