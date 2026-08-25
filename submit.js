// Submission: triggers the catalog repo's workflow_dispatch, which opens the PR.
import { html } from './schema-form.js';
const CATALOG = 'CGIAR-Climate-Data-Hub/cdh-catalog';
const WORKFLOW = 'submit-record.yml';

const $ = id => document.getElementById(id);

export function initSubmit({ form, setStatus, act }) {
  let yaml = '', id = '';

  // The consequence, at the moment of the choice — a paragraph above the checkbox goes
  // unread, and this is the one decision in the app with a security cost.
  const REMEMBER_OFF = 'Kept for this tab only and forgotten when you close it, so you paste it again next time.';
  const REMEMBER_ON = 'Stored in this browser until you remove it. Anyone using this device — or any script '
    + 'that gets onto this page — can then read it, so prefer a fine-grained token with a short expiry.';
  function showTokenState() {
    const remembered = !!localStorage.getItem('gh_token');
    $('gh-remember-note').textContent = $('gh-remember').checked ? REMEMBER_ON : REMEMBER_OFF;
    $('gh-forget-row').style.display = remembered ? 'block' : 'none';
  }
  $('gh-remember').addEventListener('change', showTokenState);
  act('forgetToken', () => {
    localStorage.removeItem('gh_token');
    sessionStorage.removeItem('gh_token');
    $('gh-token').value = '';
    $('gh-remember').checked = false;
    showTokenState();
    setStatus('Token removed from this browser. Revoke it in GitHub settings to be sure.');
  });

  function setStep(step, state, detail = '') {
    const el = $(step);
    el.classList.remove('active', 'done', 'err');
    el.classList.add(state);
    if (detail) el.querySelector('small').textContent = detail;
  }

  // Filled in when the YAML modal hands over, so the submitted bytes are the previewed ones.
  act('openSubmitModal', () => {
    yaml = $('yaml-out').textContent;
    id = form.record().id || 'unnamed-record';
    $('step-record-id').textContent = id;
    // sessionStorage by default: a token that outlives the tab is a token an XSS can
    // still reach tomorrow. Persisting it is an explicit opt-in.
    const remembered = localStorage.getItem('gh_token');
    $('gh-token').value = remembered || sessionStorage.getItem('gh_token') || '';
    $('gh-remember').checked = !!remembered;
    showTokenState();
    $('submit-result').style.display = 'none';
    $('do-submit-btn').disabled = false;
    ['step-dispatch', 'step-run'].forEach(s => $(s).classList.remove('active', 'done', 'err'));
    $('submit-modal').showModal();
  });

  act('doSubmit', async () => {
    const token = $('gh-token').value.trim();
    if (!token) return alert('Please enter your GitHub Personal Access Token.');
    if ($('gh-remember').checked) localStorage.setItem('gh_token', token);
    else { localStorage.removeItem('gh_token'); sessionStorage.setItem('gh_token', token); }
    showTokenState();

    const btn = $('do-submit-btn'), result = $('submit-result');
    btn.disabled = true;
    result.style.display = 'none';

    const gh = async (method, path, body) => {
      const r = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 204) return {};
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.message || `GitHub API error ${r.status}`);
      return json;
    };

    try {
      setStep('step-dispatch', 'active', `Calling workflow_dispatch on ${CATALOG}…`);
      // TEMPORARY: submit-record.yml only exists on the `submit` branch so far — revert
      // to 'main' once that branch is merged, or workflow_dispatch will 404 (the workflow
      // file has to already exist on whatever ref is dispatched to).
      await gh('POST', `/repos/${CATALOG}/actions/workflows/${WORKFLOW}/dispatches`, {
        ref: 'submit',
        inputs: { record_id: id, yaml_content: yaml },
      });
      setStep('step-dispatch', 'done', 'Workflow triggered successfully');

      setStep('step-run', 'active', 'Waiting for GitHub Actions to start…');
      await new Promise(r => setTimeout(r, 5000));
      let runUrl = `https://github.com/${CATALOG}/actions/workflows/${WORKFLOW}`;
      try {
        const runs = await gh('GET', `/repos/${CATALOG}/actions/workflows/${WORKFLOW}/runs?per_page=1&event=workflow_dispatch`);
        if (runs.workflow_runs?.[0]?.html_url) runUrl = runs.workflow_runs[0].html_url;
      } catch { /* the fallback link still points at the workflow */ }
      setStep('step-run', 'done', 'Workflow run started — PR will appear shortly');

      result.style.display = 'block';
      result.replaceChildren(html`
        <a class="pr-link" href="${runUrl}" target="_blank" rel="noopener">View workflow run on GitHub</a>
        <a class="pr-link" href="https://github.com/${CATALOG}/pulls" target="_blank" rel="noopener"
           style="margin-top:6px">View pull requests</a>
        <div class="tip" style="margin:8px 0 0">
          The workflow writes <code>records/${id}/${id}.yaml</code>, formats it with Prettier and opens a
          PR. The <strong>Validate records</strong> check runs full CDH schema validation.
        </div>`);
      setStatus('Workflow triggered — PR will appear in GitHub shortly.');
    } catch (err) {
      ['step-dispatch', 'step-run'].forEach(s => {
        if ($(s).classList.contains('active')) setStep(s, 'err', err.message);
      });
      result.style.display = 'block';
      // err.message comes from the GitHub API, so it is interpolated, not trusted.
      result.replaceChildren(html`<div class="val-row fail" style="margin:0">${err.message}</div>`);
      btn.disabled = false;
    }
  });
}
