import {
  completeGoogleRedirect,
  getCurrentVoter,
  getVoterIdToken,
  signInWithGoogle,
  signOutVoter
} from './firebase-client.js';

const main = document.getElementById('main-content');
const statusPill = document.getElementById('public-status');
const toast = document.getElementById('toast');
const dialog = document.getElementById('confirm-dialog');
let csrfToken = '';
let adminUsername = '';
let pendingVote = null;
let toastTimer;
let pollTimer;
let closeTimer;
let countdownTimer;

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const formatDate = value => value ? new Date(value).toLocaleString(undefined, {
  dateStyle: 'medium', timeStyle: 'short'
}) : 'Not set';
const localInputValue = value => {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
const inputToIso = value => value ? new Date(value).toISOString() : '';
const formatCountdown = endAt => {
  const seconds = Math.max(0, Math.ceil((new Date(endAt).getTime() - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

function countdownMarkup(status, endAt) {
  if (status !== 'open' || !endAt || !Number.isFinite(new Date(endAt).getTime())) return '';
  return `<div id="election-countdown" class="countdown-banner" role="timer" aria-label="Voting time remaining">
    <span>Time remaining</span><strong>${formatCountdown(endAt)}</strong>
  </div>`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

function googleAuthErrorMessage(error) {
  if (error.code === 'auth/operation-not-allowed') {
    return 'Google sign-in is not enabled in Firebase Authentication.';
  }
  if (error.code === 'auth/unauthorized-domain') {
    return 'This site domain is not authorized for Firebase Authentication.';
  }
  if (error.code === 'auth/popup-blocked') {
    return 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.';
  }
  return error.message || 'Google sign-in could not be completed.';
}

async function api(url, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (url === '/api/vote' || url === '/api/voter/status') {
    const token = await getVoterIdToken();
    if (!token) throw new Error('Sign in with Google before voting.');
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(result && result.error ? result.error : `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function setStatus(status, endAt = null) {
  window.clearInterval(countdownTimer);
  countdownTimer = null;
  statusPill.className = `status-pill ${status === 'open' ? 'open' : 'closed'}`;
  statusPill.title = '';
  if (status !== 'open') {
    statusPill.textContent = 'Voting is closed';
    return;
  }
  if (!endAt || !Number.isFinite(new Date(endAt).getTime())) {
    statusPill.textContent = 'Voting is open';
    return;
  }
  const updateCountdown = () => {
    const remaining = Math.max(0, new Date(endAt).getTime() - Date.now());
    const countdown = formatCountdown(endAt);
    statusPill.textContent = remaining > 0 ? `Open · ${countdown}` : 'Closing…';
    statusPill.title = `Voting closes in ${countdown}`;
    const banner = document.querySelector('#election-countdown strong');
    if (banner) banner.textContent = countdown;
    if (remaining === 0) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };
  updateCountdown();
  countdownTimer = window.setInterval(updateCountdown, 1000);
}

function clearPoll() {
  window.clearInterval(pollTimer);
  pollTimer = null;
  window.clearInterval(countdownTimer);
  countdownTimer = null;
  window.clearTimeout(closeTimer);
  closeTimer = null;
}

function setViewClass(name) {
  main.className = name;
}

async function renderPublic(errorMessage = '') {
  clearPoll();
  setViewClass('main-content');
  main.innerHTML = '<div class="loading-panel">Loading voting status…</div>';
  try {
    const [data, voter] = await Promise.all([api('/api/public'), getCurrentVoter()]);
    setStatus(data.status, data.endAt);
    const awards = Array.isArray(data.awards) ? data.awards : [];
    const votingReady = awards.length === 6 && awards.every(award => award.candidates.length === 3);
    const voterStatus = voter ? await api('/api/voter/status') : { hasVoted: false };
    if (voterStatus.hasVoted) {
      main.innerHTML = `
        <section class="hero"><span class="eyebrow">YOUR SIX-AWARD BALLOT</span><h1>Thank you for voting.</h1></section>
        <section class="panel success-panel">
          <div class="success-icon" aria-hidden="true">✓</div>
          <h2>Your ballot is complete.</h2>
          <p class="muted">Your choices for all six awards have been recorded. Each Google account may submit one ballot.</p>
          <button id="voter-signout" class="button button-secondary" type="button">Sign out</button>
        </section>`;
      const signOutButton = document.getElementById('voter-signout');
      signOutButton.addEventListener('click', async () => {
        signOutButton.disabled = true;
        try {
          await signOutVoter();
          await renderPublic();
        } catch (error) {
          signOutButton.disabled = false;
          showToast(error.message);
        }
      });
      return;
    }

    const winnerMarkup = data.status === 'closed' && awards.some(award => award.winner)
      ? `<section class="award-outcomes" aria-label="Award winners">${awards.map(award => {
          if (!award.winner) {
            return `<article class="panel award-outcome"><span class="eyebrow">NO VOTES</span><h2>${escapeHtml(award.title)}</h2><p class="muted">No winner was determined.</p></article>`;
          }
          const winner = award.winner;
          return `<article class="panel award-outcome">
            <span class="eyebrow">${winner.tie ? 'FINAL RESULT · TIE' : 'WINNER ANNOUNCEMENT'}</span>
            <h2>${escapeHtml(award.title)}</h2>
            <p class="award-winner-name">${winner.candidates.map(escapeHtml).join(' &amp; ')}</p>
            <p class="muted">${winner.votes} ${winner.votes === 1 ? 'vote' : 'votes'}${winner.tie ? ' each' : ''} · ${winner.percentage.toFixed(1)}%${winner.tie ? ' each' : ''}</p>
          </article>`;
        }).join('')}</section>`
      : data.status === 'closed'
        ? '<section class="vote-note"><span>Voting has closed. Results will be announced after ballots have been recorded.</span></section>'
        : '';
    const ballot = awards.map((award, index) => `
      <fieldset class="ballot-award">
        <legend><span class="candidate-slot">${String(index + 1).padStart(2, '0')}</span> ${escapeHtml(award.title)}</legend>
        <div class="ballot-options">
          ${award.candidates.map(candidate => `
            <label class="ballot-option">
              <input type="radio" name="award-${escapeHtml(award.id)}" value="${escapeHtml(candidate.id)}" required ${!voter || data.status !== 'open' || !votingReady ? 'disabled' : ''}>
              <span>${escapeHtml(candidate.name)}</span>
            </label>`).join('')}
        </div>
      </fieldset>`).join('');
    main.innerHTML = `
      <section class="hero">
        <span class="eyebrow">SIX AWARDS · ONE BALLOT</span>
        <h1>Award Voting</h1>
        <p>${data.status === 'open' ? 'Choose one nominee for each award, then submit your ballot.' : 'Voting is not currently accepting ballots.'}</p>
      </section>
      ${countdownMarkup(data.status, data.endAt)}
      ${winnerMarkup}
      ${errorMessage ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
      ${!votingReady ? '<div class="alert" role="alert">The administrator is completing the six awards and three nominees. Voting will open when the ballot is ready.</div>' : ''}
      ${data.status === 'open' && votingReady ? `
        <div class="panel center-panel">
          ${voter
            ? `<p class="muted" style="margin-bottom:14px">Signed in as <strong>${escapeHtml(voter.email || 'Google account')}</strong></p><button id="voter-signout" class="button button-secondary button-sm" type="button">Sign out</button>`
            : `<p class="muted">Sign in with Google to vote. Each verified Google email can submit one ballot. On phones, choose a Google account offered by your browser.</p>
              <div class="sign-in-options">
                <button id="google-signin" class="button button-primary" type="button">Continue with Google</button>
              </div>`}
        </div>` : ''}
      ${awards.length ? `<form id="ballot-form" class="ballot-form">${ballot}<div class="ballot-submit"><p id="ballot-validation" class="field-help" role="status">Sign in and choose one name for every award.</p><button id="submit-ballot" class="button button-primary" type="submit" disabled>Submit all six choices (0/6)</button></div></form>` : ''}
      <div class="vote-note"><span><strong>One verified Google account, one ballot.</strong> Your account email is stored only as a secure hash; individual choices are never displayed publicly.</span></div>
      <div class="inline-actions" style="justify-content:center;margin-top:18px"><a class="muted" href="#login" style="font-size:12px">Administrator sign in</a></div>`;

    const signInButton = document.getElementById('google-signin');
    if (signInButton) signInButton.addEventListener('click', async () => {
      signInButton.disabled = true;
      try {
        const signedInUser = await signInWithGoogle();
        if (signedInUser) await renderPublic();
      } catch (error) {
        signInButton.disabled = false;
        showToast(googleAuthErrorMessage(error));
      }
    });
    const signOutButton = document.getElementById('voter-signout');
    if (signOutButton) signOutButton.addEventListener('click', async () => {
      try {
        await signOutVoter();
        renderPublic();
      } catch (error) {
        showToast(error.message);
      }
    });

    const ballotForm = document.getElementById('ballot-form');
    if (ballotForm) {
      const submitButton = document.getElementById('submit-ballot');
      const validationMessage = document.getElementById('ballot-validation');
      const updateBallotButton = () => {
        const missingAwards = awards.filter(award =>
          !ballotForm.querySelector(`input[name="award-${award.id}"]:checked`)
        );
        const selectedCount = awards.length - missingAwards.length;
        submitButton.disabled = missingAwards.length > 0 || !voter || data.status !== 'open';
        submitButton.textContent = `Submit all six choices (${selectedCount}/${awards.length})`;
        validationMessage.textContent = data.status !== 'open'
          ? 'Voting is closed.'
          : !voter
            ? 'Sign in with Google to choose one nominee for every award.'
            : missingAwards.length
              ? `Choose one name for each remaining award: ${missingAwards.map(award => award.title).join(', ')}.`
              : 'All six awards are selected. Review your choices before submitting.';
      };
      ballotForm.addEventListener('change', updateBallotButton);
      ballotForm.addEventListener('submit', event => {
        event.preventDefault();
        const selections = Object.fromEntries(awards.map(award => {
          const input = ballotForm.querySelector(`input[name="award-${award.id}"]:checked`);
          return [award.id, input ? input.value : ''];
        }));
        if (Object.values(selections).some(candidateId => !candidateId)) return;
        pendingVote = selections;
        const chosenNames = awards.map(award => {
          const candidate = award.candidates.find(item => item.id === selections[award.id]);
          return `${award.title}: ${candidate ? candidate.name : ''}`;
        });
        document.getElementById('confirm-title').textContent = 'Submit your six-award ballot?';
        document.getElementById('confirm-copy').textContent = chosenNames.join(' · ');
        document.getElementById('confirm-submit').textContent = 'Confirm all six choices';
        dialog.returnValue = 'cancel';
        dialog.showModal();
      });
      updateBallotButton();
    }
    if (data.status === 'open' && data.endAt) {
      const remaining = new Date(data.endAt).getTime() - Date.now();
      closeTimer = window.setTimeout(() => renderPublic(), Math.max(0, remaining + 50));
    }
  } catch (error) {
    main.innerHTML = `<section class="panel center-panel"><h2>Voting system unavailable</h2><p class="muted">${escapeHtml(error.message)}</p><button class="button button-secondary" id="retry-public">Try again</button></section>`;
    document.getElementById('retry-public').addEventListener('click', () => renderPublic());
  }
}

async function submitVote() {
  if (!pendingVote) return;
  const vote = pendingVote;
  pendingVote = null;
  try {
    await api('/api/vote', { method: 'POST', body: { selections: vote } });
    await renderPublic();
  } catch (error) {
    await renderPublic(error.message);
  }
}

dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'confirm' && pendingVote) submitVote();
});

function adminShell(view, content) {
  const links = [
    ['dashboard', 'Overview'],
    ['awards', 'Awards'],
    ['candidates', 'Candidates'],
    ['voting', 'Voting management'],
    ['results', 'Voting results'],
    ['winner', 'Winner announcement']
  ];
  return `
    <aside class="sidebar">
      <p class="sidebar-title">ADMINISTRATION</p>
      <nav class="nav-list" aria-label="Administrator navigation">
        ${links.map(([key, label]) => `<button class="nav-item ${key === view ? 'active' : ''}" data-view="${key}">${label}</button>`).join('')}
      </nav>
      <div class="sidebar-footer"><button id="logout-button" class="button button-secondary button-sm">Sign out</button></div>
    </aside>
    <section class="admin-content">${content}</section>`;
}

function pageHeading(title, subtitle, action = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
}

function resultRows(results) {
  return `<div class="results-list">${results.map(result => `
    <div class="result-row">
      <div><div class="result-name">${escapeHtml(result.name)}</div><div class="result-meta">${result.votes} ${result.votes === 1 ? 'vote' : 'votes'}</div></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(result.name)}" aria-valuenow="${result.percentage.toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, result.percentage))}%"></div></div>
      <div class="result-percent">${result.percentage.toFixed(1)}%</div>
    </div>`).join('')}</div>`;
}

function chartSvg(results) {
  if (!results.length) return '<p class="muted">No candidates have been configured.</p>';
  const width = 540;
  const labelWidth = 135;
  const barWidth = 300;
  const rowHeight = 58;
  const height = results.length * rowHeight + 10;
  const maxVotes = Math.max(1, ...results.map(result => result.votes));
  const bars = results.map((result, index) => {
    const y = index * rowHeight + 18;
    const bar = Math.max(result.votes ? 4 : 0, barWidth * result.votes / maxVotes);
    return `<text class="chart-label" x="0" y="${y + 14}">${escapeHtml(result.name)}</text>
      <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="22" rx="6" fill="#edf0f4"></rect>
      <rect x="${labelWidth}" y="${y}" width="${bar}" height="22" rx="6" fill="#c99a3d"></rect>
      <text class="chart-value" x="${labelWidth + barWidth + 12}" y="${y + 15}">${result.votes} · ${result.percentage.toFixed(1)}%</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Live results chart">${bars}</svg>`;
}

function scheduleLine(summary) {
  return `<div class="schedule-line"><span>Starts <strong>${escapeHtml(formatDate(summary.startAt))}</strong></span><span>Ends <strong>${escapeHtml(formatDate(summary.endAt))}</strong></span></div>`;
}

function awardOutcomeCards(awards, status) {
  return `<div class="award-outcomes">${awards.map(award => {
    if (status === 'open') {
      return `<article class="panel award-outcome">
        <span class="eyebrow">CURRENT LEADER</span>
        <h2>${escapeHtml(award.title)}</h2>
        <p class="award-winner-name">${escapeHtml(award.currentLeader)}</p>
        <p class="muted">A final winner will be announced after voting closes.</p>
      </article>`;
    }
    if (!award.winner) {
      return `<article class="panel award-outcome">
        <span class="eyebrow">NO VOTES</span>
        <h2>${escapeHtml(award.title)}</h2>
        <p class="muted">No winner was determined.</p>
      </article>`;
    }
    return `<article class="panel award-outcome">
      <span class="eyebrow">${award.winner.tie ? 'FINAL RESULT · TIE' : 'WINNER ANNOUNCEMENT'}</span>
      <h2>${escapeHtml(award.title)}</h2>
      <p class="award-winner-name">${award.winner.candidates.map(escapeHtml).join(' &amp; ')}</p>
      <p class="muted">${award.winner.votes} ${award.winner.tie ? 'votes each' : award.winner.votes === 1 ? 'vote' : 'votes'} · ${award.winner.percentage.toFixed(1)}%${award.winner.tie ? ' each' : ''}</p>
    </article>`;
  }).join('')}</div>`;
}

function awardResultPanels(awards) {
  return `<div class="award-results-grid">${awards.map(award => `
    <section class="panel award-result-panel">
      <h2>${escapeHtml(award.title)}</h2>
      ${resultRows(award.results)}
      <div class="chart-wrap"><h3 class="chart-heading">Results chart</h3>${chartSvg(award.results)}</div>
    </section>`).join('')}</div>`;
}

async function renderAdmin(view = 'dashboard') {
  clearPoll();
  setViewClass('admin-shell');
  main.innerHTML = '<div class="loading-panel">Loading administrator dashboard…</div>';
  try {
    const summary = await api('/api/admin/summary');
    setStatus(summary.status, summary.endAt);
    let content = '';
    if (view === 'awards') {
      content = `${pageHeading('Award management', 'Rename the six award categories before voting starts.', '<span class="status-pill">6 awards</span>')}
        <section class="panel">
          <div class="management-list">${summary.awards.map((award, index) => `
            <form class="candidate-manage-row award-form" data-id="${award.id}">
              <span class="candidate-slot">${String(index + 1).padStart(2, '0')}</span>
              <input aria-label="Award name" maxlength="120" value="${escapeHtml(award.title)}" required ${summary.hasStarted ? 'disabled' : ''}>
              <button class="button button-secondary button-sm" type="submit" ${summary.hasStarted ? 'disabled' : ''}>Save</button>
            </form>`).join('')}</div>
          ${summary.hasStarted ? '<p class="field-help" style="margin-top:16px">Award names are locked after voting starts. Reset the election to edit them again.</p>' : ''}
        </section>`;
    } else if (view === 'candidates') {
      const { candidates } = await api('/api/admin/candidates');
      content = `${pageHeading('Candidate management', 'Manage the nominees shared by all six awards.', '<span class="status-pill">Names only</span>')}
        <section class="panel">
          <h2>Current candidates <span class="muted">(${candidates.length}/3)</span></h2>
          <div class="management-list">${candidates.map((candidate, index) => `
            <form class="candidate-manage-row candidate-form" data-id="${candidate.id}">
              <span class="candidate-slot">${String(index + 1).padStart(2, '0')}</span>
              <input aria-label="Candidate name" maxlength="120" value="${escapeHtml(candidate.name)}" required ${summary.hasStarted ? 'disabled' : ''}>
              <div class="inline-actions">
                <button class="button button-secondary button-sm" type="submit" ${summary.hasStarted ? 'disabled' : ''}>Save</button>
                <button class="button button-danger button-sm remove-candidate" type="button" data-id="${candidate.id}" ${summary.hasStarted ? 'disabled' : ''}>Remove</button>
              </div>
            </form>`).join('') || '<p class="muted">No candidates added.</p>'}</div>
          ${!summary.hasStarted && candidates.length < 3 ? `<form id="add-candidate-form" class="form-row" style="align-items:end;margin-top:18px"><div class="field" style="margin-bottom:0"><label for="new-candidate-name">Add candidate name</label><input id="new-candidate-name" maxlength="120" minlength="2" required></div><button class="button button-primary" type="submit">Add candidate</button></form>` : ''}
          ${summary.hasStarted ? '<p class="field-help" style="margin-top:16px">Candidate names are locked after voting has started. Resetting the election unlocks candidate management.</p>' : ''}
        </section>
        <section class="vote-note"><span>Exactly three candidates are required. The same three names appear under each of the six awards.</span></section>`;
    } else if (view === 'voting') {
      const ballotReady = summary.candidateCount === 3 && summary.awardCount === 6;
      const actionButton = summary.status === 'open'
        ? '<button id="close-voting" class="button button-danger">Finish voting</button>'
        : `<button id="start-voting" class="button button-primary" ${!ballotReady ? 'disabled' : ''}>${summary.hasStarted ? 'Reopen for 10 minutes' : 'Start 10-minute voting'}</button>`;
      content = `${pageHeading('Voting management', 'Each start or reopen opens the ballot for exactly 10 minutes.')}
        <div class="stats-grid">
          <article class="stat-card"><div class="stat-label">STATUS</div><div class="stat-value small">${summary.status === 'open' ? 'Open' : 'Closed'}</div></article>
          <article class="stat-card"><div class="stat-label">AWARDS</div><div class="stat-value">${summary.awardCount} / 6</div></article>
          <article class="stat-card"><div class="stat-label">BALLOTS SUBMITTED</div><div class="stat-value">${summary.totalVotes}</div></article>
          <article class="stat-card"><div class="stat-label">NOMINEES PER AWARD</div><div class="stat-value">${summary.candidateCount} / 3</div></article>
        </div>
        ${!ballotReady ? '<div class="alert" role="alert">The ballot needs exactly six awards and three candidates before voting can open.</div>' : ''}
        <section class="panel">
          <h2>Voting start and duration</h2>
          <p class="muted">Times use your browser's local time zone. Set an optional start time; voting automatically closes 10 minutes after it opens.</p>
          <form id="schedule-form">
            <div class="form-row">
              <div class="field"><label for="start-at">Voting starts</label><input id="start-at" type="datetime-local" value="${localInputValue(summary.startAt)}" ${summary.status === 'open' ? 'disabled' : ''}></div>
              <div class="field"><label>Voting duration</label><div class="field-value">10 minutes after opening</div></div>
            </div>
            <div class="inline-actions"><button class="button button-secondary" type="submit" ${summary.status === 'open' ? 'disabled' : ''}>Save dates</button>${actionButton}</div>
          </form>
          ${scheduleLine(summary)}
        </section>
        <section class="panel" style="margin-top:16px">
          <h2>Reset election</h2>
          <p class="muted">Permanently remove every six-award ballot and voter identifier. Voting will be closed and award and candidate names unlocked.</p>
          <button id="reset-election" class="button button-danger">Reset all votes</button>
        </section>`;
    } else if (view === 'results') {
      content = `${pageHeading('Voting results', 'Live results for each award. Individual voter choices are not displayed.', '<button id="export-results" class="button button-secondary">Export CSV</button>')}
        <div class="stats-grid">
          <article class="stat-card"><div class="stat-label">BALLOTS SUBMITTED</div><div class="stat-value">${summary.totalVotes}</div></article>
          <article class="stat-card"><div class="stat-label">AWARDS</div><div class="stat-value">${summary.awardCount}</div></article>
          <article class="stat-card"><div class="stat-label">NOMINEES PER AWARD</div><div class="stat-value">${summary.candidateCount}</div></article>
          <article class="stat-card"><div class="stat-label">VOTING STATUS</div><div class="stat-value small">${summary.status === 'open' ? 'Open' : 'Closed'}</div></article>
        </div>
        ${awardResultPanels(summary.awards)}
        <section class="vote-note">${scheduleLine(summary)}</section>`;
    } else if (view === 'winner') {
      content = `${pageHeading('Winner announcement', summary.status === 'open' ? 'Current leaders only; final winners appear after voting closes.' : 'Final winner or tie for each award.')}
        ${awardOutcomeCards(summary.awards, summary.status)}`;
    } else {
      const overviewActions = summary.status === 'open'
        ? '<div class="inline-actions"><button id="finish-voting" class="button button-danger button-sm">Finish voting</button><button id="refresh-dashboard" class="button button-secondary button-sm">Refresh</button></div>'
        : '<button id="refresh-dashboard" class="button button-secondary button-sm">Refresh</button>';
      content = `${pageHeading('Election overview', 'Monitor the award voting process at a glance.', overviewActions)}
        <div class="stats-grid">
          <article class="stat-card"><div class="stat-label">BALLOTS SUBMITTED</div><div class="stat-value">${summary.totalVotes}</div></article>
          <article class="stat-card"><div class="stat-label">AWARDS</div><div class="stat-value">${summary.awardCount} / 6</div></article>
          <article class="stat-card"><div class="stat-label">NOMINEES PER AWARD</div><div class="stat-value">${summary.candidateCount} / 3</div></article>
          <article class="stat-card"><div class="stat-label">VOTING STATUS</div><div class="stat-value small">${summary.status === 'open' ? 'Open' : 'Closed'}</div></article>
        </div>
        <h2 class="section-title">${summary.status === 'open' ? 'Current leaders' : 'Award winners'}</h2>
        ${awardOutcomeCards(summary.awards, summary.status)}
        <section class="vote-note">${scheduleLine(summary)}</section>`;
    }
    content = `${countdownMarkup(summary.status, summary.endAt)}${content}`;
    main.innerHTML = adminShell(view, content);
    main.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
      location.hash = `admin/${button.dataset.view}`;
    }));
    document.getElementById('logout-button').addEventListener('click', logout);
    bindAdminActions(view);
    if (['dashboard', 'results', 'winner'].includes(view) || view === 'voting' && summary.status === 'open') {
      pollTimer = window.setInterval(() => renderAdmin(view), 10000);
    }
  } catch (error) {
    if (error.status === 401) {
      location.hash = 'login';
      return;
    }
    main.innerHTML = `<section class="panel center-panel"><h2>Dashboard unavailable</h2><p class="muted">${escapeHtml(error.message)}</p><button id="retry-admin" class="button button-secondary">Try again</button></section>`;
    document.getElementById('retry-admin').addEventListener('click', () => renderAdmin(view));
  }
}

function bindAdminActions(view) {
  main.querySelectorAll('.award-form').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const title = form.querySelector('input').value;
    try {
      await api(`/api/admin/awards/${form.dataset.id}`, { method: 'PUT', body: { title } });
      showToast('Award name saved.');
      renderAdmin('awards');
    } catch (error) { showToast(error.message); }
  }));
  main.querySelectorAll('.candidate-form').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = form.querySelector('input').value;
    try {
      await api(`/api/admin/candidates/${form.dataset.id}`, { method: 'PUT', body: { name } });
      showToast('Candidate name saved.');
      renderAdmin('candidates');
    } catch (error) { showToast(error.message); }
  }));
  main.querySelectorAll('.remove-candidate').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('Remove this candidate? You can add a replacement before starting voting.')) return;
    try {
      await api(`/api/admin/candidates/${button.dataset.id}`, { method: 'DELETE' });
      renderAdmin('candidates');
    } catch (error) { showToast(error.message); }
  }));
  const addForm = document.getElementById('add-candidate-form');
  if (addForm) addForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/admin/candidates', { method: 'POST', body: { name: document.getElementById('new-candidate-name').value } });
      renderAdmin('candidates');
    } catch (error) { showToast(error.message); }
  });
  const scheduleForm = document.getElementById('schedule-form');
  if (scheduleForm) scheduleForm.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api('/api/admin/schedule', {
        method: 'PUT',
        body: {
          startAt: inputToIso(document.getElementById('start-at').value)
        }
      });
      showToast('Voting dates saved.');
      renderAdmin('voting');
    } catch (error) { showToast(error.message); }
  });
  const start = document.getElementById('start-voting');
  if (start) start.addEventListener('click', () => changeVoting('start', 'Start voting now?'));
  const close = document.getElementById('close-voting');
  if (close) close.addEventListener('click', () => changeVoting('close', 'Finish voting now? New ballots will no longer be accepted.'));
  const finish = document.getElementById('finish-voting');
  if (finish) finish.addEventListener('click', () => changeVoting('close', 'Finish voting now? New ballots will no longer be accepted.'));
  const reset = document.getElementById('reset-election');
  if (reset) reset.addEventListener('click', async () => {
    if (!window.confirm('Reset all votes and voter records? This cannot be undone.')) return;
    try {
      await api('/api/admin/reset', { method: 'POST', body: {} });
      showToast('Election reset. All votes have been removed.');
      renderAdmin('voting');
    } catch (error) { showToast(error.message); }
  });
  const exportButton = document.getElementById('export-results');
  if (exportButton) exportButton.addEventListener('click', () => { window.location.href = '/api/admin/export.csv'; });
  const refresh = document.getElementById('refresh-dashboard');
  if (refresh) refresh.addEventListener('click', () => renderAdmin(view));
}

async function changeVoting(action, prompt) {
  if (!window.confirm(prompt)) return;
  try {
    await api(`/api/admin/voting/${action}`, { method: 'POST', body: {} });
    showToast(action === 'close' ? 'Voting closed.' : 'Voting is open.');
    renderAdmin(action === 'close' ? 'dashboard' : 'voting');
  } catch (error) { showToast(error.message); }
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
    adminUsername = '';
    csrfToken = (await api('/api/csrf')).csrfToken;
    location.hash = 'login';
  } catch (error) { showToast(error.message); }
}

async function renderLogin(errorMessage = '') {
  clearPoll();
  setViewClass('main-content');
  setStatus('closed');
  main.innerHTML = `
    <section class="hero"><span class="eyebrow">ADMINISTRATION</span><h1>Welcome back.</h1><p>Sign in to manage the award voting system.</p></section>
    <section class="panel center-panel">
      <h2>Administrator sign in</h2>
      <p class="muted">This area is restricted to authorized administrators.</p>
      ${errorMessage ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
      <form id="login-form">
        <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" maxlength="80" required></div>
        <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="200" required></div>
        <button class="button button-primary" type="submit" style="width:100%">Sign in</button>
      </form>
      <p style="margin:18px 0 0"><a class="muted" href="#" style="font-size:12px">Return to public voting</a></p>
    </section>`;
  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await api('/api/login', {
        method: 'POST',
        body: {
          username: document.getElementById('username').value,
          password: document.getElementById('password').value
        }
      });
      csrfToken = result.csrfToken;
      adminUsername = result.username;
      location.hash = 'admin/dashboard';
    } catch (error) {
      button.disabled = false;
      renderLogin(error.message);
    }
  });
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const segments = hash.split('/').filter(Boolean);
  if (segments[0] === 'login' || segments[0] === 'admin' && segments[1] === 'login') {
    const session = await api('/api/admin/session');
    csrfToken = session.csrfToken || csrfToken;
    if (session.authenticated) {
      adminUsername = session.username;
      location.hash = 'admin/dashboard';
      return;
    }
    renderLogin();
    return;
  }
  if (segments[0] === 'admin') {
    const session = await api('/api/admin/session');
    csrfToken = session.csrfToken || csrfToken;
    if (!session.authenticated) {
      location.hash = 'login';
      return;
    }
    adminUsername = session.username;
    const allowedViews = ['dashboard', 'awards', 'candidates', 'voting', 'results', 'winner'];
    const view = allowedViews.includes(segments[1]) ? segments[1] : 'dashboard';
    renderAdmin(view);
    return;
  }
  renderPublic();
}

async function boot() {
  try {
    const csrf = await api('/api/csrf');
    csrfToken = csrf.csrfToken;
    try {
      await completeGoogleRedirect();
    } catch (error) {
      showToast(googleAuthErrorMessage(error));
    }
    await route();
  } catch (error) {
    setViewClass('main-content');
    main.innerHTML = `<section class="panel center-panel"><h2>Unable to connect</h2><p class="muted">${escapeHtml(error.message)}</p><p class="field-help">Start the web server and confirm its Firestore connection, then refresh this page.</p></section>`;
  }
}

window.addEventListener('hashchange', route);
boot();
