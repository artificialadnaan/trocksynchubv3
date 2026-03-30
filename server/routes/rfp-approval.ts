import type { Express } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { parseProjectTypeFromNumber, replaceProjectTypeInNumber } from "../constants";

// ── HTML helpers ──────────────────────────────────────────────────────────────

const RFP_LOGO_HTML = `<img src="https://trockgc.com/wp-content/uploads/2024/10/T-Rock-Logo-Main-2.png" alt="T-Rock GC" referrerpolicy="no-referrer" onerror="this.style.display='none';var s=this.nextElementSibling;s.style.display='inline';" style="max-width:140px;height:auto;vertical-align:middle;"><span style="display:none;color:#fff;font-size:22px;font-weight:700;letter-spacing:0.5px;vertical-align:middle;">T-Rock GC</span>`;

function renderRfpPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>${title} | T-Rock RFP Review</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { max-width: 600px; width: 100%; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 30px 40px; text-align: center; }
    .header img { max-width: 180px; height: auto; }
    .accent { background: linear-gradient(90deg, #d11921, #e53935); height: 4px; }
    .body { padding: 40px; text-align: center; }
    .body h1 { color: #1a1a2e; font-size: 24px; margin-bottom: 16px; }
    .body p { color: #64748b; font-size: 16px; line-height: 1.6; }
    .body strong { color: #1a1a2e; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${RFP_LOGO_HTML}</div>
    <div class="accent"></div>
    <div class="body"><h1>${title}</h1>${content}</div>
  </div>
</body>
</html>`;
}

function renderRfpReviewPage(token: string, d: Record<string, any>): string {
  const esc = (s: any) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const formatDateForInput = (val: any): string => {
    if (val == null || val === '') return '';
    const n = typeof val === 'string' && /^\d+$/.test(val) ? parseInt(val, 10) : val;
    const date = new Date(n);
    if (isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const proposalDueDateRaw = d.proposal_due_date || d.bid_due_date || d.due_date;
  const proposalDueDateFormatted = formatDateForInput(proposalDueDateRaw);

  const projectDescription = (d.project_description__briefly_describe_the_project_ || d.description || '').trim();

  const currentTypeDigit = parseProjectTypeFromNumber(d.project_number || '') ?? d.project_types ?? '2';

  const field = (label: string, name: string, value: any, type = 'text') => {
    if (name === 'project_types') {
      const val = String(value || '').trim();
      const options = [
        { id: '1', name: 'Exterior Renovation' },
        { id: '2', name: 'Interior Renovation' },
        { id: '3', name: 'Roofing' },
        { id: '4', name: 'Service' },
        { id: '5', name: 'Commercial' },
        { id: '6', name: 'Hospitality' },
        { id: '7', name: 'Emergency' },
        { id: '8', name: 'Development' },
        { id: '9', name: 'Residential' },
      ];
      const opts = options.map(o => `<option value="${o.id}"${val === o.id ? ' selected' : ''}>${o.id} - ${o.name}</option>`).join('');
      return `<div class="field">
        <label>${label}</label>
        <select name="${name}">
          <option value="">-- Select --</option>
          ${opts}
        </select>
      </div>`;
    }
    if (type === 'textarea') {
      return `<div class="field"><label>${label}</label><textarea name="${name}" rows="3">${esc(value)}</textarea></div>`;
    }
    return `<div class="field"><label>${label}</label><input type="${type}" name="${name}" value="${esc(value)}"></div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>RFP Review: ${esc(d.dealname)} | T-Rock GC</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f5; min-height: 100vh; padding: 20px; }
    .container { max-width: 700px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 24px 40px; text-align: center; }
    .header img { max-width: 160px; height: auto; }
    .accent { background: linear-gradient(90deg, #d11921, #e53935); height: 4px; }
    .body { padding: 32px 40px; }
    h1 { color: #1a1a2e; font-size: 22px; text-align: center; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 14px; text-align: center; margin-bottom: 24px; }
    .info-banner { background: #fff7ed; border-left: 4px solid #f97316; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px; }
    .info-banner p { color: #9a3412; font-size: 13px; }
    .section-title { color: #1a1a2e; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; margin: 24px 0 16px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; color: #64748b; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .field input, .field select, .field textarea { width: 100%; padding: 10px 14px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px; font-family: inherit; color: #1a1a2e; transition: border-color 0.2s; background: #fff; }
    .field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: #d11921; }
    .field textarea { resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
    .highlight-field select { border-color: #d11921; background: #fef2f2; }
    .email-field { margin: 24px 0 16px; }
    .email-field label { display: block; color: #1a1a2e; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .email-field input { width: 100%; padding: 10px 14px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 14px; font-family: inherit; }
    .email-field input:focus { outline: none; border-color: #d11921; }
    .actions { display: flex; gap: 16px; margin-top: 32px; }
    .btn { flex: 1; padding: 14px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; text-align: center; transition: transform 0.1s, opacity 0.2s; }
    .btn:hover { transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .btn-approve { background: linear-gradient(135deg, #d11921, #b71c1c); color: #fff; box-shadow: 0 4px 14px rgba(209,25,33,0.3); }
    .btn-decline { background: #f1f5f9; color: #64748b; border: 2px solid #e2e8f0; }
    .btn-decline:hover { background: #e2e8f0; }
    .hubspot-link { text-align: center; margin: 16px 0 0; }
    .hubspot-link a { color: #d11921; font-size: 14px; text-decoration: underline; }
    .result { margin-top: 24px; padding: 16px; border-radius: 8px; text-align: center; display: none; }
    .result.success { display: block; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
    .result.error { display: block; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .result.declined { display: block; background: #f8fafc; border: 1px solid #e2e8f0; color: #64748b; }
    .attachments-intro { color: #64748b; font-size: 13px; margin-bottom: 12px; }
    .attachments-list { margin-bottom: 12px; }
    .att-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f8fafc; border-radius: 8px; margin-bottom: 8px; border: 1px solid #e2e8f0; }
    .att-row span { flex: 1; font-size: 14px; color: #1a1a2e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .att-row a { color: #d11921; font-size: 12px; text-decoration: none; }
    .att-row a:hover { text-decoration: underline; }
    .att-row .remove-att { color: #dc2626; cursor: pointer; font-size: 14px; }
    .add-attachments-label { cursor: pointer; display: inline-block; }
    .btn-outline { display: inline-block; padding: 8px 16px; border: 2px solid #d11921; color: #d11921; border-radius: 8px; font-size: 14px; font-weight: 600; transition: background 0.2s, color 0.2s; }
    .btn-outline:hover { background: #d11921; color: #fff; }
    .spinner { display: inline-block; width: 18px; height: 18px; border: 3px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .footer { background: #1a1a2e; padding: 20px 40px; text-align: center; }
    .footer p { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    .footer a { color: #d11921; text-decoration: none; }
    @media (max-width: 600px) {
      .body { padding: 24px 20px; }
      .row, .row-3 { grid-template-columns: 1fr; }
      .actions { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${RFP_LOGO_HTML}</div>
    <div class="accent"></div>
    <div class="body">
      <h1>RFP Review &amp; Approval</h1>
      <p class="subtitle">Review the deal details below. Edit any fields as needed, then approve or decline.</p>

      <div class="info-banner">
        <p>Fields you edit here will be updated in HubSpot upon approval. If project type is <strong>4 (Service)</strong>, the deal moves to <strong>Service - Estimating</strong>; otherwise it moves to <strong>Estimating</strong>.</p>
      </div>

      <form id="rfpForm">
        <div class="section-title">Deal Information</div>
        ${field('Deal Name', 'dealname', d.dealname)}
        <div class="row">
          ${field('Project Number', 'project_number', d.project_number)}
          ${field('Amount', 'amount', d.amount)}
        </div>
        <div class="highlight-field">
          ${field('Project Type', 'project_types', currentTypeDigit)}
          <small style="display:block;color:#64748b;font-size:12px;margin-top:6px;">Changing the project type will update the project number in HubSpot.</small>
        </div>
        <div class="row">
          ${field('Estimator', 'estimator', d.estimator)}
          ${field('Project Due Date', 'bid_due_date', proposalDueDateFormatted, 'date')}
        </div>

        <div class="section-title">Company &amp; Contact</div>
        ${field('Company Name', 'company_name', d.company_name)}
        <div class="row">
          ${field('Client Email', 'client_email', d.client_email, 'email')}
          ${field('Client Phone', 'client_phone', d.client_phone, 'tel')}
        </div>

        <div class="section-title">Location</div>
        ${field('Address', 'address', d.address)}
        <div class="row-3">
          ${field('City', 'city', d.city)}
          ${field('State', 'state', d.state)}
          ${field('Zip', 'zip', d.zip)}
        </div>
        ${field('Country', 'country', d.country)}

        <div class="section-title">Details</div>
        ${field('Project Description', 'description', projectDescription, 'textarea')}
        ${field('Notes', 'notes', d.notes, 'textarea')}

        <div class="section-title">Attachments</div>
        <p class="attachments-intro">Attachments from the HubSpot deal. Remove any you don't need and add additional files before approval.</p>
        <div id="attachmentsList" class="attachments-list"></div>
        <div class="add-attachments">
          <label class="add-attachments-label">
            <input type="file" id="newFiles" multiple accept="*/*" style="display:none">
            <span class="btn btn-outline">+ Add Attachment</span>
          </label>
        </div>
        <input type="hidden" name="attachmentsOverride" id="attachmentsOverride">

        <div class="email-field">
          <label>Your Email (required for approval tracking)</label>
          <input type="email" id="approverEmail" required placeholder="your.email@trockgc.com">
        </div>

        <div class="actions">
          <button type="button" class="btn btn-approve" id="approveBtn" onclick="submitApproval()">Approve &amp; Create BidBoard Project</button>
          <button type="button" class="btn btn-decline" id="declineBtn" onclick="submitDecline()">Decline</button>
        </div>
      </form>

      ${d.hubspotDealUrl ? `<div class="hubspot-link"><a href="${esc(d.hubspotDealUrl)}" target="_blank">View Deal in HubSpot</a></div>` : ''}

      <div id="result" class="result"></div>
    </div>
    <div class="footer">
      <p>T-Rock Construction, LLC | 3001 Long Prairie Rd. Ste. 200, Flower Mound, TX 75022</p>
      <p><a href="tel:2145484733">(214) 548-4733</a> | <a href="https://trockgc.com">trockgc.com</a></p>
    </div>
  </div>

  <script>
    const TOKEN = '${token}';
    const INITIAL_ATTACHMENTS = ${JSON.stringify((d.attachments || []).map((a: any) => ({ name: a.name, url: a.url, type: a.type, size: a.size })))};
    const newFilesStore = [];

    function renderAttachments() {
      const list = document.getElementById('attachmentsList');
      const kept = INITIAL_ATTACHMENTS.filter((_, i) => !removedIndices.has(i));
      let rows = kept.map((a) => {
        const origIdx = INITIAL_ATTACHMENTS.indexOf(a);
        return '<div class="att-row" data-idx="' + origIdx + '"><span title="' + (a.name || '').replace(/"/g, '&quot;') + '">' + (a.name || 'attachment') + '</span>' +
          '<a href="' + (a.url || '#') + '" target="_blank">View</a>' +
          '<span class="remove-att" onclick="removeAttachment(' + origIdx + ')">Remove</span></div>';
      }).join('');
      newFilesStore.forEach((f, i) => {
        rows += '<div class="att-row att-new" data-new="' + i + '"><span>' + (f.name || '').replace(/</g, '&lt;') + '</span><span class="remove-att" onclick="removeNewFile(' + i + ')">Remove</span></div>';
      });
      list.innerHTML = rows || '<p class="attachments-empty" style="color:#94a3b8;font-size:13px;">No attachments</p>';
      updateAttachmentsOverride();
    }

    const removedIndices = new Set();
    function removeAttachment(idx) { removedIndices.add(idx); renderAttachments(); }
    function removeNewFile(idx) { newFilesStore.splice(idx, 1); renderAttachments(); }

    function updateAttachmentsOverride() {
      const kept = INITIAL_ATTACHMENTS.filter((_, i) => !removedIndices.has(i)).map(a => ({ name: a.name, url: a.url }));
      const newInfos = newFilesStore.map(f => ({ name: f.name, _new: true }));
      document.getElementById('attachmentsOverride').value = JSON.stringify([...kept, ...newInfos]);
    }

    document.getElementById('newFiles').addEventListener('change', function() {
      for (let i = 0; i < this.files.length; i++) {
        newFilesStore.push({ file: this.files[i], name: this.files[i].name });
      }
      this.value = '';
      renderAttachments();
    });

    renderAttachments();

    // When project type changes, update project number to reflect new type digit (DFW-X-06426-ah)
    document.querySelector('select[name="project_types"]').addEventListener('change', function() {
      const projNumInput = document.querySelector('input[name="project_number"]');
      const val = (projNumInput && projNumInput.value) || '';
      const m = val.match(/^(DFW-)\d+(-)/i);
      if (m && this.value) {
        projNumInput.value = m[1] + this.value + m[2] + val.slice(m[0].length);
      }
    });

    function getFormData() {
      const form = document.getElementById('rfpForm');
      const data = {};
      form.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.name && el.name !== 'attachmentsOverride') data[el.name] = el.value;
      });
      return data;
    }

    function showResult(msg, type) {
      const el = document.getElementById('result');
      el.className = 'result ' + type;
      el.innerHTML = msg;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function setLoading(btn, loading) {
      if (loading) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.innerHTML = '<span class="spinner"></span> Processing...';
      } else {
        btn.disabled = false;
        btn.textContent = btn.dataset.originalText;
      }
    }

    async function submitApproval() {
      const email = document.getElementById('approverEmail').value.trim();
      if (!email) { alert('Please enter your email address.'); return; }

      const btn = document.getElementById('approveBtn');
      const decBtn = document.getElementById('declineBtn');
      setLoading(btn, true);
      decBtn.disabled = true;

      try {
        const fd = new FormData();
        fd.append('editedFields', JSON.stringify(getFormData()));
        fd.append('approverEmail', email);
        fd.append('attachmentsOverride', document.getElementById('attachmentsOverride').value);
        newFilesStore.forEach((f, i) => fd.append('newFiles', f.file));
        const resp = await fetch('/api/rfp-approval/' + TOKEN + '/approve', {
          method: 'POST',
          body: fd,
        });
        const data = await resp.json();
        if (data.success) {
          showResult('<strong>Approved!</strong> The deal has been updated in HubSpot and a BidBoard project is being created.' + (data.bidboardProjectId ? ' BidBoard Project ID: ' + data.bidboardProjectId : ''), 'success');
          document.getElementById('rfpForm').style.display = 'none';
        } else {
          showResult('<strong>Error:</strong> ' + (data.error || 'Unknown error'), 'error');
          setLoading(btn, false);
          decBtn.disabled = false;
        }
      } catch (e) {
        showResult('<strong>Error:</strong> ' + e.message, 'error');
        setLoading(btn, false);
        decBtn.disabled = false;
      }
    }

    async function submitDecline() {
      const email = document.getElementById('approverEmail').value.trim();
      if (!email) { alert('Please enter your email address.'); return; }
      if (!confirm('Are you sure you want to decline this RFP?')) return;

      const btn = document.getElementById('declineBtn');
      const appBtn = document.getElementById('approveBtn');
      setLoading(btn, true);
      appBtn.disabled = true;

      try {
        const resp = await fetch('/api/rfp-approval/' + TOKEN + '/decline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ declinerEmail: email }),
        });
        const data = await resp.json();
        if (data.success) {
          showResult('This RFP has been <strong>declined</strong>. No BidBoard project will be created. The deal remains at RFP stage in HubSpot.', 'declined');
          document.getElementById('rfpForm').style.display = 'none';
        } else {
          showResult('<strong>Error:</strong> ' + (data.error || 'Unknown error'), 'error');
          setLoading(btn, false);
          appBtn.disabled = false;
        }
      } catch (e) {
        showResult('<strong>Error:</strong> ' + e.message, 'error');
        setLoading(btn, false);
        appBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRfpApprovalRoutes(app: Express) {
  // PUBLIC — no auth required

  app.get("/rfp-review/:token", asyncHandler(async (req, res) => {
    const { token } = req.params;
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return res.status(404).send(renderRfpPage('Not Found', '<p>This review link is invalid or has expired.</p>'));
    if (request.status !== 'pending') {
      const statusMsg = request.status === 'approved'
        ? `<p>This RFP was already <strong>approved</strong> by ${request.approvedBy || 'a reviewer'}.</p>`
        : `<p>This RFP was <strong>declined</strong> by ${request.declinedBy || 'a reviewer'}.</p>`;
      return res.send(renderRfpPage('Already Processed', statusMsg));
    }

    let d = request.dealData as Record<string, any>;
    const hasDesc = !!(d.description || d.notes);
    const attCount = (d.attachments || []).length;
    const needsRefresh = !hasDesc || !attCount;
    if (needsRefresh) {
      try {
        const { fetchFullDealFromHubSpot } = await import("../rfp-approval");
        const fresh = await fetchFullDealFromHubSpot(request.hubspotDealId);
        d = { ...d, ...fresh };
        if (!(d.description || d.notes)) {
          d.description = fresh.description || d.description;
          d.notes = fresh.notes || d.notes;
        }
        if (!((d.attachments || []).length) && (fresh.attachments || []).length > 0) {
          d.attachments = fresh.attachments;
        }
        await storage.updateRfpApprovalRequest(request.id, { dealData: d });
      } catch (refreshErr: any) {
        console.warn(`[rfp-review] Could not refresh deal data for ${request.hubspotDealId}:`, refreshErr.message);
      }
    }
    const needsEnrichment = !(d.proposal_due_date || d.project_description__briefly_describe_the_project_);
    if (needsEnrichment) {
      try {
        const cached = await storage.getHubspotDealByHubspotId(request.hubspotDealId);
        const cp = (cached?.properties || {}) as Record<string, any>;
        if (cp) {
          if (!d.proposal_due_date && cp.proposal_due_date) d = { ...d, proposal_due_date: cp.proposal_due_date };
          if (!d.project_description__briefly_describe_the_project_ && cp.project_description__briefly_describe_the_project_) {
            d = { ...d, project_description__briefly_describe_the_project_: cp.project_description__briefly_describe_the_project_ };
          }
        }
      } catch { /* ignore */ }
    }
    res.send(renderRfpReviewPage(token, d));
  }));

  app.post("/api/rfp-approval/:token/approve", async (req, res, next) => {
    const multer = (await import("multer")).default;
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
    upload.fields([
      { name: 'editedFields', maxCount: 1 },
      { name: 'approverEmail', maxCount: 1 },
      { name: 'attachmentsOverride', maxCount: 1 },
      { name: 'newFiles', maxCount: 20 },
    ])(req as any, res, async (err: any) => {
      if (err) return res.status(400).json({ success: false, error: err.message || 'Upload error' });
      try {
        const { token } = req.params;
        const body = (req as any).body || {};
        const files = (req as any).files || {};
        let editedFields: Record<string, string> = {};
        try {
          const ef = body.editedFields;
          editedFields = typeof ef === 'string' ? JSON.parse(ef) : ef || {};
        } catch { /* fallback to empty */ }
        const approverEmail = (body.approverEmail || '').trim();
        if (!approverEmail) return res.status(400).json({ success: false, error: 'Approver email is required' });
        let attachmentsOverride: Array<{ name: string; url?: string; _new?: boolean }> = [];
        try {
          const ao = body.attachmentsOverride;
          attachmentsOverride = typeof ao === 'string' ? JSON.parse(ao || '[]') : ao || [];
        } catch { /* fallback to empty */ }
        const newFiles = files.newFiles ? (Array.isArray(files.newFiles) ? files.newFiles : [files.newFiles]) : [];
        const { processRfpApproval } = await import('../rfp-approval');
        const result = await processRfpApproval(token, editedFields, approverEmail, { attachmentsOverride, newFiles });
        if (!result.success) {
          return res.status(500).json({
            success: false,
            error: result.error || 'Approval failed',
            details: result.error,
          });
        }
        res.json(result);
      } catch (e: any) {
        console.error('[rfp-approval] Approve error:', e.message);
        res.status(500).json({ success: false, error: e.message });
      }
    });
  });

  app.post("/api/rfp-approval/:token/decline", asyncHandler(async (req, res) => {
    const { token } = req.params;
    const { declinerEmail } = req.body;
    if (!declinerEmail) return res.status(400).json({ success: false, error: 'Email is required' });

    const { processRfpDecline } = await import('../rfp-approval');
    const result = await processRfpDecline(token, declinerEmail);
    res.json(result);
  }));

  // Reset an approval request back to pending (admin endpoint for retrying failed BidBoard creation)
  app.post("/api/rfp-approval/:token/reset", asyncHandler(async (req, res) => {
    const { token } = req.params as { token: string };
    const request = await storage.getRfpApprovalRequestByToken(token);
    if (!request) return res.status(404).json({ success: false, error: 'Approval request not found' });
    await storage.updateRfpApprovalRequest(request.id, {
      status: 'pending',
      approvedBy: null,
      approvedAt: null,
      declinedBy: null,
      declinedAt: null,
      bidboardProjectId: null,
    });
    res.json({ success: true, message: `Request ${request.id} reset to pending. Token: ${token}` });
  }));
}
