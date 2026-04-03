// ── DOM ───────────────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const tableBody = $('tableBody');
    const countEl = $('count');
    const emptyStateEl = $('emptyState');
    const searchInput = $('searchInput');
    const runtimeFilter = $('runtimeFilter');
    const clearBtn = $('clearBtn');
    const resultInfo = $('resultInfo');
    const runtimePills = $('runtimePills');

    let allPorts = [];
    let previousPorts = [];
    let healthMap = {};
    let sortColumn = 'port';
    let sortDirection = 'asc';
    let runtimeDefs = {};
    let currentSettings = {};
    let ws = null;
    let groupByProject = false;
    let groupingDepth = 1;
    let openMenuId = null;

    // ── Theme ────────────────────────────────────────────────────────
    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      const icon = $('themeIcon');
      if (theme === 'light') {
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
      } else {
        icon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
      }
    }

    $('themeToggle').addEventListener('click', async () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    });

    // ── Toast ─────────────────────────────────────────────────────────
    function showToast(msg, type = 'success') {
      const t = document.createElement('div');
      t.className = `toast toast-${type}`;
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    // ── Kill / Restart ───────────────────────────────────────────────
    async function killProcess(pid) {
      closeAllMenus();
      if (!confirm(`Kill process ${pid}?`)) return;
      try {
        const res = await fetch(`/api/kill/${pid}`, { method: 'POST' });
        if (res.ok) { showToast(`Process ${pid} killed`); setTimeout(() => loadPorts(true), 800); }
        else { const d = await res.json(); showToast(d.error, 'warn'); }
      } catch { showToast('Failed to kill process', 'warn'); }
    }

    async function restartProcess(pid) {
      closeAllMenus();
      try {
        const res = await fetch(`/api/restart/${pid}`, { method: 'POST' });
        if (res.ok) { showToast(`SIGHUP sent to ${pid}`); setTimeout(() => loadPorts(true), 1500); }
        else { showToast('Failed to restart', 'warn'); }
      } catch { showToast('Failed to restart', 'warn'); }
    }

    // ── Open terminal ─────────────────────────────────────────────────
    async function openTerminal(dir) {
      try {
        const res = await fetch('/api/open-terminal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        if (res.ok) showToast(`Terminal opened at ${dir.split('/').pop()}`);
        else showToast('Failed to open terminal', 'warn');
      } catch { showToast('Failed to open terminal', 'warn'); }
    }

    // ── Favorites ────────────────────────────────────────────────────
    async function toggleFavorite(port, isFav) {
      const method = isFav ? 'DELETE' : 'POST';
      await fetch(`/api/favorites/${port}`, { method });
      // Update local state
      allPorts.forEach(p => {
        if (p.port === port) p.favorite = !isFav;
      });
      renderTable();
      showToast(isFav ? `Port ${port} unpinned` : `Port ${port} pinned`);
    }

    // ── Health checks ────────────────────────────────────────────────
    async function loadHealth() {
      try {
        const res = await fetch('/api/health');
        healthMap = await res.json();
        // Update dots in DOM without full re-render
        document.querySelectorAll('.health-dot[data-port]').forEach(dot => {
          const port = dot.dataset.port;
          const status = healthMap[port] || 'unknown';
          dot.className = `health-dot ${status}`;
          dot.title = status;
        });
      } catch { /* silent */ }
    }

    // ── Notifications ────────────────────────────────────────────────
    let notifiedPorts = new Set();  // track what we already notified about
    let notifyReady = false;        // skip until first stable load

    function checkNotifications() {
      if (!currentSettings.notifications) return;
      if (!notifyReady) return;

      const currSet = new Set(allPorts.map(p => p.port));

      // New ports we haven't notified about
      allPorts.forEach(p => {
        if (!notifiedPorts.has(p.port)) {
          notify(`Port ${p.port} is up`, `${p.runtimeName} process started (${p.command})`);
        }
      });

      // Ports that disappeared
      notifiedPorts.forEach(port => {
        if (!currSet.has(port)) {
          const prev = previousPorts.find(p => p.port === port);
          notify(`Port ${port} is down`, prev ? `${prev.runtimeName} process stopped` : 'Process stopped');
        }
      });

      // Update tracked set to current state
      notifiedPorts = new Set(currSet);
    }

    function notify(title, body) {
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
      }
      showToast(`${title}: ${body}`, 'info');
    }

    async function requestNotificationPermission() {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
    }

    // ── Export ────────────────────────────────────────────────────────
    function updateExportVisibility(show) {
      const wrapper = $('exportBtn')?.closest('.export-wrapper');
      if (wrapper) wrapper.style.display = show ? '' : 'none';
    }

    function exportAs(format) {
      const data = getFilteredAndSortedPorts();
      let output = '';

      if (format === 'json') {
        output = JSON.stringify(data.map(p => ({
          port: p.port, pid: p.pid, user: p.user,
          process: p.command, runtime: p.runtimeName, path: p.scriptPath,
        })), null, 2);
      } else if (format === 'markdown') {
        output = '| Port | PID | User | Process | Runtime | Path |\n';
        output += '|------|-----|------|---------|---------|------|\n';
        data.forEach(p => {
          output += `| ${p.port || '-'} | ${p.pid} | ${p.user || '-'} | ${p.command} | ${p.runtimeName} | ${p.scriptPath || '-'} |\n`;
        });
      } else if (format === 'csv') {
        output = 'Port,PID,User,Process,Runtime,Path\n';
        data.forEach(p => {
          output += `${p.port || ''},${p.pid},${p.user || ''},${p.command},${p.runtimeName},"${p.scriptPath || ''}"\n`;
        });
      }

      navigator.clipboard.writeText(output).then(() => {
        showToast(`Copied as ${format.toUpperCase()}`);
      });

      $('exportMenu').classList.remove('open');
    }

    $('exportBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('exportMenu').classList.toggle('open');
    });

    // ── Actions menu ─────────────────────────────────────────────────
    let activeMenuId = null;

    const menuBackdrop = $('menuBackdrop');
    const floatingMenu = $('floatingMenu');

    function closeAllMenus() {
      floatingMenu.classList.remove('open');
      floatingMenu.innerHTML = '';
      document.querySelectorAll('.export-menu').forEach(m => m.classList.remove('open'));
      menuBackdrop.classList.remove('open');
      activeMenuId = null;
    }

    function toggleActionsMenu(id, triggerEl) {
      const sourceMenu = document.getElementById(`menu-${id}`);
      if (!sourceMenu) return;

      const wasOpen = activeMenuId === id;
      closeAllMenus();
      if (wasOpen) return;

      floatingMenu.innerHTML = sourceMenu.innerHTML;

      const rect = triggerEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;

      if (spaceBelow < 120) {
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
      activeMenuId = id;
    }

    function isAnyMenuOpen() {
      return activeMenuId !== null;
    }

    menuBackdrop.addEventListener('click', closeAllMenus);
    floatingMenu.addEventListener('click', (e) => {
      if (e.target.closest('button')) {
        setTimeout(closeAllMenus, 50);
      }
    });

    // ── Filter & sort ────────────────────────────────────────────────
    function getFilteredAndSortedPorts() {
      const term = searchInput.value.toLowerCase();
      const rtFilter = runtimeFilter.value;

      let filtered = allPorts.filter(p => {
        const matchesSearch = !term ||
          String(p.port || '').includes(term) ||
          String(p.pid || '').toLowerCase().includes(term) ||
          String(p.user || '').toLowerCase().includes(term) ||
          String(p.command || '').toLowerCase().includes(term) ||
          String(p.runtimeName || '').toLowerCase().includes(term) ||
          String(p.scriptPath || '').toLowerCase().includes(term);

        const matchesRuntime = rtFilter === 'all' || p.runtime === rtFilter;
        return matchesSearch && matchesRuntime;
      });

      // Favorites first, then sort
      filtered.sort((a, b) => {
        if (a.favorite && !b.favorite) return -1;
        if (!a.favorite && b.favorite) return 1;

        let aVal = a[sortColumn];
        let bVal = b[sortColumn];
        if (sortColumn === 'port' || sortColumn === 'pid') {
          aVal = parseInt(aVal) || 0;
          bVal = parseInt(bVal) || 0;
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });

      return filtered;
    }

    let lastFiltersKey = '';
    function updateFilters() {
      const runtimes = new Set();
      allPorts.forEach(p => runtimes.add(p.runtime));
      const key = Array.from(runtimes).sort().join(',');
      if (key === lastFiltersKey) return;
      lastFiltersKey = key;

      const cur = runtimeFilter.value;
      runtimeFilter.innerHTML = '<option value="all">All Runtimes</option>';
      Array.from(runtimes).sort().forEach(rt => {
        const opt = document.createElement('option');
        opt.value = rt;
        opt.textContent = runtimeDefs[rt]?.name || rt;
        runtimeFilter.appendChild(opt);
      });
      if (cur !== 'all' && runtimes.has(cur)) runtimeFilter.value = cur;
    }

    let lastPillsKey = '';
    function updateRuntimePills() {
      const counts = {};
      allPorts.forEach(p => { counts[p.runtime] = (counts[p.runtime] || 0) + 1; });
      const key = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}:${c}`).join(',');
      if (key === lastPillsKey) return; // no change
      lastPillsKey = key;
      runtimePills.innerHTML = '';
      Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([rt, count]) => {
        const color = runtimeDefs[rt]?.color || '#6b7280';
        const name = runtimeDefs[rt]?.name || rt;
        const pill = document.createElement('span');
        pill.className = 'runtime-pill';
        pill.style.cssText = `background:${color}18;color:${color};border:1px solid ${color}40;`;
        pill.innerHTML = `<span class="pill-count">${count}</span> ${name}`;
        runtimePills.appendChild(pill);
      });
    }

    // ── Render (reconciliation — only patch what changed) ─────────────
    let renderedKeys = []; // track what's currently in DOM

    function rowKey(p) { return `${p.pid}:${p.port}`; }

    function formatMem(mb) {
      if (!mb || mb === 0) return '0 MB';
      if (mb < 1024) return mb.toFixed(1) + ' MB';
      return (mb / 1024).toFixed(1) + ' GB';
    }

    function usageColor(val, max) {
      if (val < max * 0.3) return 'var(--green)';
      if (val < max * 0.7) return 'var(--yellow)';
      return 'var(--red)';
    }

    function rowHTML(p) {
      const health = healthMap[p.port] || 'checking';
      const uid = `${p.pid}-${p.port}`;
      return `
        <td><button class="fav-btn ${p.favorite ? 'is-fav' : ''}" onclick="toggleFavorite(${p.port}, ${p.favorite})" title="${p.favorite ? 'Unpin' : 'Pin to top'}">${p.favorite ? '\u2605' : '\u2606'}</button></td>
        <td>${p.port
          ? `<a href="http://localhost:${p.port}" target="_blank" class="code" style="color:var(--accent);text-decoration:none;">${p.port}</a>`
          : '<span class="code">&mdash;</span>'
        }</td>
        <td><span class="health-dot ${health}" data-port="${p.port}" title="${health}"></span></td>
        <td><span class="pid-copy" onclick="navigator.clipboard.writeText('${p.pid}');showToast('PID ${p.pid} copied')" title="Click to copy PID">${p.pid}</span></td>
        <td class="col-user">${p.user || '\u2014'}</td>
        <td class="col-cmd"><span class="code">${p.command}</span></td>
        <td>
          <span class="runtime-tag" style="background:${p.runtimeColor}18;color:${p.runtimeColor};border:1px solid ${p.runtimeColor}40;">
            <span class="runtime-icon" style="background:${p.runtimeColor}">${p.runtimeIcon || '?'}</span>
            ${p.runtimeName}
          </span>
        </td>
        <td class="col-path">${p.scriptPath
          ? `<span class="path-link" onclick="openTerminal('${p.scriptPath.replace(/'/g, "\\'")}')" title="Click to open terminal here">${p.scriptPath}</span>`
          : '<span class="code">\u2014</span>'
        }</td>
        <td class="usage-cell" title="CPU: ${p.cpu || 0}%">
          <span class="usage-bar" style="width:${Math.min(p.cpu || 0, 100) * 0.4}px;background:${usageColor(p.cpu || 0, 100)};"></span>${(p.cpu || 0).toFixed(1)}%
        </td>
        <td class="usage-cell" title="Memory: ${formatMem(p.memMB || 0)}">
          <span class="usage-bar" style="width:${Math.min((p.memMB || 0) * 0.08, 40)}px;background:${usageColor(p.memMB || 0, 500)};"></span>${formatMem(p.memMB || 0)}
        </td>
        <td class="actions-cell" style="text-align:right;">
          <button class="actions-trigger" onclick="event.stopPropagation();toggleActionsMenu('${uid}',this)">
            \u22EF
          </button>
          <div class="actions-menu" id="menu-${uid}">
            <button onclick="restartProcess('${p.pid}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Restart (SIGHUP)
            </button>
            <div class="actions-divider"></div>
            <button class="danger" onclick="killProcess('${p.pid}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              Kill process
            </button>
          </div>
        </td>`;
    }

    function getGroupKey(scriptPath, depth) {
      if (!scriptPath || scriptPath === '/') return 'Unknown';
      const parts = scriptPath.replace(/\/$/, '').split('/');
      if (parts.length > depth) {
        return parts.slice(0, parts.length - depth).join('/');
      }
      return scriptPath;
    }

    // Fingerprint a port entry for change detection
    function portFingerprint(p) {
      return `${p.pid}|${p.port}|${p.user}|${p.command}|${p.runtime}|${p.scriptPath}|${p.favorite}|${(p.cpu||0).toFixed(1)}|${p.memMB||0}`;
    }

    let lastFingerprints = {};
    let lastFilteredKeys = '';

    function renderTable() {
      const filtered = getFilteredAndSortedPorts();

      // Update counters
      if (allPorts.length === 0) {
        resultInfo.textContent = '';
      } else if (filtered.length !== allPorts.length) {
        resultInfo.textContent = `Showing ${filtered.length} of ${allPorts.length}`;
      } else {
        resultInfo.textContent = '';
      }

      if (filtered.length === 0) {
        emptyStateEl.style.display = 'block';
        emptyStateEl.textContent = (searchInput.value || runtimeFilter.value !== 'all')
          ? 'No processes match your filters.'
          : 'No dev processes currently listening. Start a dev server and it will appear here.';
        if (tableBody.children.length > 0) {
          tableBody.innerHTML = '';
          renderedKeys = [];
          lastFingerprints = {};
          lastFilteredKeys = '';
        }
        return;
      }

      emptyStateEl.style.display = 'none';

      // Build the desired row list (flat, no grouping for reconciliation)
      let rows;
      if (groupByProject) {
        rows = [];
        const groups = {};
        filtered.forEach(p => {
          const key = getGroupKey(p.scriptPath, groupingDepth);
          if (!groups[key]) groups[key] = [];
          groups[key].push(p);
        });
        Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).forEach(([groupPath, ports]) => {
          rows.push({ _groupHeader: true, groupPath, count: ports.length });
          ports.forEach(p => rows.push(p));
        });
      } else {
        rows = filtered;
      }

      // Build a key for the full list to detect structural changes (add/remove/reorder)
      const newKeys = rows.map(r => r._groupHeader ? `g:${r.groupPath}` : rowKey(r)).join(',');

      // If structure changed, do full rebuild
      if (newKeys !== lastFilteredKeys) {
        tableBody.innerHTML = '';
        lastFingerprints = {};

        rows.forEach(r => {
          const tr = document.createElement('tr');
          if (r._groupHeader) {
            tr.dataset.key = `g:${r.groupPath}`;
            tr.innerHTML = `<td colspan="11" style="padding:0;">
              <div class="group-header" onclick="this.classList.toggle('collapsed');toggleGroupRows(this)">
                <span class="group-chevron">\u25BC</span>
                <span class="group-name">${r.groupPath}</span>
                <span class="group-count">${r.count}</span>
              </div></td>`;
          } else {
            const key = rowKey(r);
            tr.dataset.key = key;
            if (r.favorite) tr.classList.add('is-favorite');
            tr.innerHTML = rowHTML(r);
            lastFingerprints[key] = portFingerprint(r);
          }
          tableBody.appendChild(tr);
        });

        lastFilteredKeys = newKeys;
        renderedKeys = newKeys.split(',');
        return;
      }

      // Structure same — only patch cells that changed (reconciliation)
      const existingRows = tableBody.querySelectorAll('tr[data-key]');
      let idx = 0;
      rows.forEach(r => {
        if (r._groupHeader) { idx++; return; }
        const key = rowKey(r);
        const fp = portFingerprint(r);
        const tr = existingRows[idx];
        idx++;

        if (!tr || lastFingerprints[key] === fp) return;

        // Something changed — patch this row
        if (r.favorite) tr.classList.add('is-favorite');
        else tr.classList.remove('is-favorite');
        tr.innerHTML = rowHTML(r);
        lastFingerprints[key] = fp;
      });
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

    // ── Load ports ───────────────────────────────────────────────────
    function handlePortsData(data, fromWS) {
      if (isAnyMenuOpen()) return;

      previousPorts = [...allPorts];
      allPorts = data.ports || [];

      countEl.textContent = allPorts.length;

      // Only check notifications on WebSocket updates (not initial HTTP load)
      if (fromWS) checkNotifications();

      updateFilters();
      updateRuntimePills();
      renderTable();
      loadHealth();
    }

    async function loadPorts(force) {
      try {
        const res = await fetch('/api/ports');
        const data = await res.json();
        handlePortsData(data, false);
        // After first successful load, seed the notified set and enable notifications
        if (!notifyReady) {
          notifiedPorts = new Set(allPorts.map(p => p.port));
          notifyReady = true;
        }
      } catch (err) {
        console.error('Failed to load ports', err);
      }
    }

    function connectWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ports') handlePortsData(data, true);
        } catch {}
      };

      ws.onclose = () => {
        // Reconnect after 2s
        setTimeout(connectWebSocket, 2000);
      };

      ws.onerror = () => ws.close();
    }

    // ── Settings modal ───────────────────────────────────────────────
    async function openSettings() {
      const [sRes, rRes] = await Promise.all([fetch('/api/settings'), fetch('/api/runtimes')]);
      currentSettings = await sRes.json();
      runtimeDefs = await rRes.json();

      $('showOther').checked = currentSettings.showOtherProcesses || false;
      $('notificationsToggle').checked = currentSettings.notifications !== false;
      $('groupingDepth').value = String(currentSettings.groupingDepth ?? 1);
      $('showHistoryToggle').checked = currentSettings.showHistory !== false;
      $('showExportToggle').checked = currentSettings.showExport || false;

      const container = $('runtimeToggles');
      container.innerHTML = '';
      Object.entries(runtimeDefs).sort((a, b) => a[1].name.localeCompare(b[1].name)).forEach(([key, rt]) => {
        const enabled = currentSettings.runtimes?.[key]?.enabled ?? true;
        const div = document.createElement('div');
        div.className = 'runtime-toggle';
        div.innerHTML = `
          <div class="runtime-toggle-left">
            <span class="runtime-icon" style="background:${rt.color}">${rt.icon}</span>
            <div class="runtime-toggle-info">
              <h4>${rt.name}</h4>
              <p>${rt.commands.join(', ') || 'unrecognized processes'}</p>
            </div>
          </div>
          <label class="toggle">
            <input type="checkbox" data-runtime="${key}" ${enabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        `;
        container.appendChild(div);
      });

      $('settingsModal').style.display = 'block';
    }

    function closeSettings() { $('settingsModal').style.display = 'none'; }

    async function saveSettings() {
      const runtimes = {};
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => {
        runtimes[i.dataset.runtime] = { enabled: i.checked };
      });

      const notifs = $('notificationsToggle').checked;
      if (notifs) requestNotificationPermission();

      const newDepth = parseInt($('groupingDepth').value);
      groupingDepth = newDepth;

      const body = {
        runtimes,
        showOtherProcesses: $('showOther').checked,
        notifications: notifs,
        groupingDepth: newDepth,
        showHistory: $('showHistoryToggle').checked,
        showExport: $('showExportToggle').checked,
      };

      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      currentSettings = { ...currentSettings, ...body };
      updateExportVisibility(body.showExport);
      closeSettings();
      showToast('Settings saved');
      loadPorts(true);
    }

    // ── Group toggle ─────────────────────────────────────────────────
    $('groupToggle').addEventListener('click', () => {
      groupByProject = !groupByProject;
      $('groupToggle').style.background = groupByProject ? 'rgba(96,165,250,0.2)' : '';
      $('groupToggle').style.borderColor = groupByProject ? 'rgba(96,165,250,0.5)' : '';
      renderTable();
    });

    // ── Event listeners ──────────────────────────────────────────────
    function updateClearBtn() {
      clearBtn.style.display = (searchInput.value || runtimeFilter.value !== 'all') ? '' : 'none';
    }
    updateClearBtn();

    searchInput.addEventListener('input', () => { renderTable(); updateClearBtn(); });
    runtimeFilter.addEventListener('change', () => { renderTable(); updateClearBtn(); });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      runtimeFilter.value = 'all';
      renderTable();
      updateClearBtn();
    });

$('settingsBtn').addEventListener('click', openSettings);
    $('modalClose').addEventListener('click', closeSettings);
    $('settingsCancel').addEventListener('click', closeSettings);
    $('settingsSave').addEventListener('click', saveSettings);
    $('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeSettings(); });

    $('runtimeSectionToggle').addEventListener('click', () => {
      const body = $('runtimeSectionBody');
      const chevron = $('runtimeSectionToggle').querySelector('.section-chevron');
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      chevron.classList.toggle('open', !isOpen);
    });

    $('clearHistory').addEventListener('click', async () => {
      if (!confirm('Clear all port history?')) return;
      await fetch('/api/history', { method: 'DELETE' });
      showToast('History cleared');
    });

    $('enableAll').addEventListener('click', () => {
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => i.checked = true);
    });
    $('disableAll').addEventListener('click', () => {
      $('runtimeToggles').querySelectorAll('input[data-runtime]').forEach(i => i.checked = false);
    });

    // Sortable columns
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.column;
        if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        else { sortColumn = col; sortDirection = 'asc'; }
        document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sorted', 'asc', 'desc'));
        th.classList.add('sorted', sortDirection);
        renderTable();
      });
    });
    document.querySelector(`th.sortable[data-column="${sortColumn}"]`)?.classList.add('sorted', sortDirection);

    // ── Keyboard shortcuts ───────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') { e.target.blur(); closeSettings(); }
        return;
      }
      switch (e.key) {
        case '/': e.preventDefault(); searchInput.focus(); break;
        case 's': openSettings(); break;
        case 'g': $('groupToggle').click(); break;
        case 'h': window.location.href = '/history'; break;
        case 'e': $('exportBtn').click(); break;
        case 't': $('themeToggle').click(); break;
        case 'Escape': closeSettings(); $('exportMenu').classList.remove('open'); break;
      }
    });

    // ── Init ─────────────────────────────────────────────────────────
    (async function init() {
      const [rtRes, stRes] = await Promise.all([fetch('/api/runtimes'), fetch('/api/settings')]);
      runtimeDefs = await rtRes.json();
      currentSettings = await stRes.json();

      setTheme(currentSettings.theme || 'dark');
      groupingDepth = currentSettings.groupingDepth ?? 1;
      if (currentSettings.notifications) requestNotificationPermission();
      updateExportVisibility(currentSettings.showExport);

      loadPorts();
      connectWebSocket();
    })();