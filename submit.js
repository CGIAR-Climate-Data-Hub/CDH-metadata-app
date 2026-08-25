// Submission: opens a pre-filled GitHub Issue Form on the catalog repo. The submitter
// clicks "Submit new issue" on github.com itself, using their own GitHub login — no
// personal access token, no GitHub API call from this app at all. A bot workflow in the
// catalog repo (submit-issue.yml) parses the issue, validates the record, and opens the
// PR using a token the CDH team controls, not the submitter's own.
const CATALOG = 'CGIAR-Climate-Data-Hub/cdh-catalog';
const ISSUE_TEMPLATE = 'submit-record.yml';
// Conservative threshold, well under every mainstream browser's real URL cap (Chrome
// ~32k, Firefox ~65k) — proxies, link shorteners, and older browsers some contributors
// might still be behind can choke well before that, so staying comfortably under is
// cheaper than debugging a "the button did nothing" report later.
const URL_SAFE_LIMIT = 6000;

const $ = id => document.getElementById(id);

export function initSubmit({ form, setStatus, act }) {
  let yaml = '', id = '';

  function issueUrl(includeYaml) {
    const params = new URLSearchParams({ template: ISSUE_TEMPLATE, record_id: id });
    if (includeYaml) params.set('yaml_content', yaml);
    return `https://github.com/${CATALOG}/issues/new?${params}`;
  }

  // Filled in when the YAML modal hands over, so the submitted bytes are the previewed ones.
  act('openSubmitModal', () => {
    yaml = $('yaml-out').textContent;
    id = form.record().id || 'unnamed-record';
    $('step-record-id').textContent = id;
    const oversize = issueUrl(true).length > URL_SAFE_LIMIT;
    $('submit-oversize').style.display = oversize ? 'block' : 'none';
    $('submit-result').style.display = 'none';
    $('submit-modal').showModal();
  });

  act('doSubmit', async () => {
    const oversize = issueUrl(true).length > URL_SAFE_LIMIT;
    if (oversize) {
      try {
        await navigator.clipboard.writeText(yaml);
        setStatus('YAML copied to clipboard — paste it into the "Full YAML record" field.');
      } catch {
        setStatus('Could not copy automatically — copy the YAML from the preview, then paste it in.');
      }
    }
    window.open(issueUrl(!oversize), '_blank', 'noopener');
    $('submit-modal').close();
  });
}
