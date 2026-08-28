(() => {
  const meta = document.getElementById('meta');
  const content = document.getElementById('content');
  const daysSelect = document.getElementById('days');
  const refreshButton = document.getElementById('refresh');

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const prLine = (pr, state) => {
    const tickets = (pr.tickets || [])
      .map((url) => ` <a class="ticket" href="${esc(url)}">${esc(url.split('/c/')[1] || 'card')}</a>`)
      .join('');
    return `<div><a href="${esc(pr.url)}">${esc(pr.repo)}#${esc(pr.number)}</a> ` +
      `${esc(pr.title)}${state ? ` <span class="pr-state">${esc(state)}</span>` : ''}${tickets}</div>`;
  };

  const render = (data) => {
    meta.textContent = `Last ${data.windowDays} day(s) from ${data.since}, generated ${new Date(data.generatedAt).toLocaleString()}`;

    if (!data.members.length) {
      content.innerHTML = '<div class="empty">No team members configured. Add them to ' +
        '<code>user-settings.json</code> under <code>global.team.members</code> as ' +
        '<code>[{"name": "Ganga", "githubUsername": "gamesganga79-dot"}]</code> ' +
        '(optionally scope repos with <code>global.team.repos</code>), then refresh.</div>';
      return;
    }

    const rows = [];
    const dates = [...new Set(data.members.flatMap((m) => m.days.map((d) => d.date)))].sort().reverse();
    dates.forEach((date) => {
      let firstOfDay = true;
      data.members.forEach((member) => {
        const day = member.days.find((d) => d.date === date);
        if (!day) return;
        const tickets = day.tickets
          .map((url) => `<a class="ticket" href="${esc(url)}">${esc(url.split('/c/')[1] || 'card')}</a>`)
          .join(' ');
        rows.push(`<tr class="${firstOfDay ? 'day-first' : ''}">
          <td>${esc(date)}</td>
          <td>${esc(member.name)}${member.incomplete ? ' <span class="incomplete" title="Search hit the page cap; counts may be low">⚠ partial</span>' : ''}</td>
          <td>${day.prsOpened.map((pr) => prLine(pr)).join('') || ''}</td>
          <td>${day.prsMerged.map((pr) => prLine(pr, 'merged')).join('') || ''}</td>
          <td class="num">${day.commitCount || ''}</td>
          <td>${day.commitRepos.map(esc).join('<br>')}</td>
          <td>${tickets}</td>
        </tr>`);
        firstOfDay = false;
      });
    });

    const totals = data.members.map((member) =>
      `<tr><td></td><td>${esc(member.name)}${member.error ? ` <span class="member-error" title="${esc(member.error)}">⚠ lookup failed</span>` : ''}</td>` +
      `<td class="num">${member.totals.prsOpened}</td><td class="num">${member.totals.prsMerged}</td>` +
      `<td class="num">${member.totals.commits}</td><td></td><td class="num">${member.totals.tickets}</td></tr>`).join('');

    const failed = data.members.filter((member) => member.error);
    const failureBanner = failed.length
      ? `<div class="banner">Could not fetch activity for ${failed.map((m) => esc(m.name)).join(', ')} ` +
        `(${esc(failed[0].error)}). Their rows below read as zero, not as actually zero activity. Try Refresh again.</div>`
      : '';

    // Every day in the window, not just days with data — a chart that only
    // plots active days silently hides the quiet ones. Format from local
    // date parts, not toISOString(): that converts to UTC first, which
    // shifts the date by a day in any timezone ahead of UTC.
    const windowDates = Array.from({ length: data.windowDays }, (_, i) => {
      const d = new Date(`${data.since}T00:00:00`);
      d.setDate(d.getDate() + i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    });

    const charts = window.TeamActivityCharts;
    content.innerHTML = `
      ${failureBanner}
      ${charts.renderLegend(data.members)}
      <section class="block">
        <h2>Snapshot</h2>
        ${charts.renderStatCards(data.members)}
      </section>
      <section class="block">
        <h2>Commits per day</h2>
        <div class="chart-wrap">${charts.renderBarChart(data.members, windowDates)}</div>
      </section>
      <section class="block">
        <h2>PR timeline — opened to merged, dashed bars are still open</h2>
        <div class="chart-wrap">${charts.renderGantt(data.members, data.since, data.generatedAt)}</div>
      </section>
      <section class="block">
        <h2>Detail</h2>
        <table>
          <thead><tr>
            <th class="date-col">Date</th><th class="member-col">Member</th>
            <th>PRs opened</th><th>PRs merged</th>
            <th class="num">Commits</th><th>Repos touched</th><th>Tickets</th>
          </tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="7">No activity in this window.</td></tr>'}</tbody>
          <thead><tr><th colspan="7">Window totals</th></tr></thead>
          <tbody>${totals}</tbody>
        </table>
      </section>`;
  };

  const load = async (refresh) => {
    meta.textContent = 'Loading…';
    try {
      const params = new URLSearchParams({ days: daysSelect.value });
      if (refresh) params.set('refresh', '1');
      const response = await fetch(`/api/team/activity?${params}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      render(data);
    } catch (error) {
      meta.textContent = '';
      content.innerHTML = `<div class="error">Could not load team activity: ${esc(error.message)}</div>`;
    }
  };

  daysSelect.addEventListener('change', () => load(false));
  refreshButton.addEventListener('click', () => load(true));
  load(false);
})();
