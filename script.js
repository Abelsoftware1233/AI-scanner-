const $ = (id) => document.getElementById(id);
const output = $('output');

// Server-adres: leeg = dezelfde server als deze pagina. Op GitHub Pages stel je het in via
// <meta name="api-base"> in index.html (bijv. https://aiscanner.abelsoftware123.com).
const metaBase = (document.querySelector('meta[name="api-base"]') || {}).content || '';
const API_BASE = metaBase.trim().replace(/\/+$/, '');
let rules = null;
let typeLabels = {};
let controller = null;   // lopende plak-scan (fetch)
let activeScan = null;   // id van lopende projectscan
let pollTimer = null;
let lastResult = '';
let selection = null;    // {mode:'items', items:[{file,path}]} of {mode:'zip', file}

/* ---------- Hulpfuncties ---------- */
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

// Kleine, veilige markdown-renderer: alles wordt eerst ge-escaped.
function renderMarkdown(src) {
    const blocks = [];
    const text = escapeHtml(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (m, code) => {
        blocks.push(`<pre class="code"><code>${code.replace(/\n$/, '')}</code></pre>`);
        return `\u0000${blocks.length - 1}\u0000`;
    });
    const inline = (s) => s
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    let html = '', inList = false;
    for (const line of text.split('\n')) {
        const ph = line.match(/^\u0000(\d+)\u0000$/);
        const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
        if (li) {
            if (!inList) { html += '<ul>'; inList = true; }
            html += `<li>${inline(li[1])}</li>`;
            continue;
        }
        if (inList) { html += '</ul>'; inList = false; }
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (ph) html += blocks[Number(ph[1])];
        else if (/^\s*---+\s*$/.test(line)) html += '<hr>';
        else if (h) html += `<${h[1].length === 1 ? 'h3' : 'h4'}>${inline(h[2])}</${h[1].length === 1 ? 'h3' : 'h4'}>`;
        else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
}

async function api(path, { method = 'GET', body, signal } = {}) {
    const opts = { method, headers: {}, signal, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    try {
        const r = await fetch(API_BASE + path, opts);
        let data = {};
        try { data = await r.json(); } catch (e) { /* geen JSON */ }
        return { ok: r.ok, status: r.status, data };
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        return { ok: false, status: 0, data: { error: `Verbindingsfout: kon geen contact maken met de server (${err.message}).` } };
    }
}

function showError(msg) {
    output.innerHTML = `<p class="error">Fout: ${escapeHtml(msg)}</p>`;
}

/* ---------- Instellingen laden ---------- */
async function loadOptions() {
    const types = await api('/api/scan-types');
    if (types.ok) {
        typeLabels = types.data;
        $('scanType').innerHTML = Object.entries(types.data)
            .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(v)}</option>`).join('');
    }
    const res = await api('/api/models');
    if (res.ok) {
        const { models, default: def } = res.data;
        const list = models.length ? models : [def];
        $('model').innerHTML = list.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
        const pick = list.find((m) => m === def || m.startsWith(def + ':'));
        if (pick) $('model').value = pick;
        $('status').className = 'status ' + (models.length ? 'ok' : 'down');
        $('status').title = models.length ? 'Ollama is bereikbaar' : 'Ollama niet bereikbaar of geen modellen geinstalleerd';
    } else {
        $('status').className = 'status down';
        $('status').title = 'Server niet bereikbaar';
        const where = API_BASE ? API_BASE : 'deze server';
        output.innerHTML = `<p class="error">Geen verbinding met de scanner-server (${escapeHtml(where)}). `
            + 'Controleer of de server draait. Een pagina op GitHub Pages kan zelf niet scannen: '
            + 'zet het serveradres in de meta-tag "api-base" in index.html.</p>';
    }
}

async function loadRules() {
    const res = await api('/api/project-rules');
    if (res.ok) rules = res.data;
}

/* ---------- Tabs en panelen ---------- */
function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    for (const n of ['paste', 'project']) $('tab-' + n).hidden = n !== name;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

function togglePanel(name) {
    const panel = $(name + 'Panel');
    const open = panel.hidden;
    for (const n of ['settings', 'history']) {
        $(n + 'Panel').hidden = true;
        $(n + 'Btn').classList.remove('active');
    }
    if (open) {
        panel.hidden = false;
        $(name + 'Btn').classList.add('active');
        if (name === 'history') loadHistory();
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}
$('settingsBtn').addEventListener('click', () => togglePanel('settings'));
$('historyBtn').addEventListener('click', () => togglePanel('history'));

/* ---------- Dashboard: kop, scanlijn en kaarten ---------- */
const STATES = {
    idle: ['KLAAR OM TE SCANNEN', 'WACHTEN...', ''],
    busy: ['BESTAND SCANNEN...', 'ANALYSEREN...', 'busy'],
    done: ['SCAN VOLTOOID', 'VOLTOOID', 'done'],
    error: ['SCAN MISLUKT', 'MISLUKT', 'error'],
    cancelled: ['SCAN GEANNULEERD', 'GEANNULEERD', 'error'],
};

function setState(key) {
    const [headline, status, cls] = STATES[key];
    $('headline').textContent = headline;
    $('stStatus').textContent = status;
    $('statusCard').className = 'card status-card ' + cls;
    $('viewport').classList.toggle('scanning', key === 'busy');
}

function setPercent(p) {
    $('stProgress').textContent = p == null ? '\u2014' : `${p}%`;
    $('progress').value = p == null ? 0 : p;
}

function fmtDate(value) {
    const d = value ? new Date(value) : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Telt de bevindingen in het rapport (op basis van de "Ernst:"-regels die de AI schrijft).
function countFindings(report) {
    const found = [...report.matchAll(/\*\*Ernst:\*\*\s*(Kritiek|Hoog|Middel|Laag)/gi)].map((m) => m[1].toLowerCase());
    if (!found.length) return '\u2014';
    const top = ['kritiek', 'hoog', 'middel', 'laag'].find((l) => found.includes(l));
    return `${found.length} (hoogste: ${top[0].toUpperCase() + top.slice(1)})`;
}

function setDetails({ date, input, model, report } = {}) {
    $('stDate').textContent = fmtDate(date);
    $('stInput').textContent = input || '\u2014';
    $('stModel').textContent = model || $('model').value || '\u2014';
    $('stFindings').textContent = report ? countFindings(report) : '\u2014';
}

$('newScanBtn').addEventListener('click', () => {
    clearTimeout(pollTimer);
    activeScan = null;
    selection = null;
    lastResult = '';
    codeInput.value = '';
    codeInput.dispatchEvent(new Event('input'));
    $('projectInfo').textContent = 'Nog niets geselecteerd.';
    $('projectBtn').disabled = true;
    $('progressText').textContent = '';
    $('copyBtn').hidden = true;
    $('saveBtn').disabled = true;
    output.innerHTML = '<span class="muted">Nog geen scan uitgevoerd. Vul code in en start de scan.</span>';
    setState('idle');
    setPercent(null);
    setDetails();
    switchTab('paste');
    codeInput.focus();
});

$('saveBtn').addEventListener('click', () => {
    if (!lastResult) return;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const url = URL.createObjectURL(new Blob([lastResult], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexus-scan-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------- Bezig-status ---------- */
function setBusy(busy, canCancel = true) {
    $('submitBtn').disabled = busy;
    $('projectBtn').disabled = busy || !selection;
    $('cancelBtn').hidden = !(busy && canCancel);
    $('newScanBtn').disabled = busy;
    $('saveBtn').disabled = busy || !lastResult;
}

/* ---------- Code plakken ---------- */
const codeInput = $('codeInput');
codeInput.addEventListener('input', () => {
    $('counter').textContent = `${codeInput.value.length} tekens`;
});

$('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    codeInput.value = await file.text();
    codeInput.dispatchEvent(new Event('input'));
    e.target.value = '';
});

$('scanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!codeInput.value.trim()) {
        alert('Voer alstublieft code of configuratie in om te scannen.');
        return;
    }
    controller = new AbortController();
    setBusy(true);
    setState('busy');
    setPercent(null);
    setDetails({ input: `${codeInput.value.length} tekens` });
    $('progressText').textContent = 'De AI analyseert de code...';
    $('copyBtn').hidden = true;
    output.innerHTML = '<p class="loading">De AI doorzoekt de code op kwetsbaarheden en misconfiguraties. Lokale modellen kunnen even duren...</p>';
    try {
        const res = await api('/api/scan', {
            method: 'POST',
            body: { code: codeInput.value, scan_type: $('scanType').value, model: $('model').value },
            signal: controller.signal,
        });
        if (res.ok) {
            lastResult = res.data.result;
            output.innerHTML = renderMarkdown(lastResult);
            $('copyBtn').hidden = false;
            setState('done');
            setPercent(100);
            setDetails({ input: `${codeInput.value.length} tekens`, model: res.data.model, report: lastResult });
            $('progressText').textContent = 'Scan voltooid.';
            loadHistory();
        } else {
            setState('error');
            $('progressText').textContent = '';
            showError(res.data.error || 'Onbekende fout');
        }
    } catch (err) {
        setState('cancelled');
        $('progressText').textContent = '';
        output.innerHTML = '<p class="error">Scan geannuleerd.</p>';
    } finally {
        controller = null;
        setBusy(false);
    }
});

$('cancelBtn').addEventListener('click', async () => {
    if (activeScan) {
        $('cancelBtn').disabled = true;
        $('progressText').textContent = 'Annuleren... (het bestand dat nu gescand wordt, wordt eerst afgerond)';
        await api(`/api/scans/${activeScan}/cancel`, { method: 'POST' });
    } else if (controller) {
        controller.abort();
    }
});

$('copyBtn').addEventListener('click', async () => {
    const btn = $('copyBtn');
    try {
        await navigator.clipboard.writeText(lastResult);
        btn.textContent = 'Gekopieerd!';
    } catch (e) {
        btn.textContent = 'Kopieren mislukt';
    }
    setTimeout(() => (btn.textContent = 'Kopieer'), 1500);
});

/* ---------- Map / zip kiezen ---------- */
function isScannable(path) {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) return false;
    if (parts.slice(0, -1).some((p) => rules.skip_dirs.includes(p))) return false;
    const name = parts[parts.length - 1].toLowerCase();
    if (rules.skip_suffixes.some((s) => name.endsWith(s)) || rules.skip_names.includes(name)) return false;
    const dot = name.lastIndexOf('.');
    return !rules.binary_extensions.includes(dot > 0 ? name.slice(dot) : '');
}

const fmtKB = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function setSelection(list) {
    if (!rules) { $('projectInfo').textContent = 'Instellingen nog niet geladen, probeer het opnieuw.'; return; }
    const items = list.filter((x) => isScannable(x.path) && x.file.size <= rules.max_file_chars * 4);
    const bytes = items.reduce((s, x) => s + x.file.size, 0);
    const ignored = list.length - items.length;
    selection = null;
    if (!items.length) {
        $('projectInfo').textContent = `Geen scanbare bestanden gevonden (${ignored} genegeerd).`;
    } else if (bytes > rules.max_upload_bytes) {
        $('projectInfo').textContent = `Te groot (${fmtKB(bytes)}, maximaal ${fmtKB(rules.max_upload_bytes)}). Kies een kleinere map of een zip.`;
    } else {
        selection = { mode: 'items', items };
        const over = items.length > rules.max_files
            ? ` Alleen de ${rules.max_files} meest risicovolle bestanden worden gescand.` : '';
        $('projectInfo').textContent = `${items.length} scanbare bestanden (${fmtKB(bytes)}), ${ignored} genegeerd.${over}`;
    }
    $('projectBtn').disabled = !selection;
}

$('folderInput').addEventListener('change', (e) => {
    setSelection([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    e.target.value = '';
});
$('filesInput').addEventListener('change', (e) => {
    setSelection([...e.target.files].map((f) => ({ file: f, path: f.name })));
    e.target.value = '';
});
$('zipInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (rules && f.size > rules.max_upload_bytes) {
        selection = null;
        $('projectBtn').disabled = true;
        $('projectInfo').textContent = `Zip te groot (${fmtKB(f.size)}, maximaal ${fmtKB(rules.max_upload_bytes)}).`;
        return;
    }
    selection = { mode: 'zip', file: f };
    $('projectInfo').textContent = `Zipbestand: ${f.name} (${fmtKB(f.size)}). De server kiest de scanbare bestanden.`;
    $('projectBtn').disabled = false;
});

$('projectBtn').addEventListener('click', async () => {
    if (!selection) return;
    setBusy(true, false);
    setState('busy');
    setPercent(0);
    setDetails({ input: selection.mode === 'zip' ? `zip: ${selection.file.name}` : `${selection.items.length} bestanden` });
    $('progressText').textContent = 'Bestanden worden verstuurd...';
    $('copyBtn').hidden = true;
    output.innerHTML = '<p class="loading">Bestanden worden verstuurd...</p>';
    let res;
    if (selection.mode === 'zip') {
        const fd = new FormData();
        fd.append('zip', selection.file);
        fd.append('scan_type', $('scanType').value);
        fd.append('model', $('model').value);
        res = await api('/api/scan-project', { method: 'POST', body: fd });
    } else {
        const files = [];
        for (const x of selection.items) files.push({ path: x.path, content: await x.file.text() });
        res = await api('/api/scan-project', {
            method: 'POST',
            body: { files, scan_type: $('scanType').value, model: $('model').value },
        });
    }
    if (!res.ok) {
        setState('error');
        $('progressText').textContent = '';
        showError(res.data.error || 'Onbekende fout');
        setBusy(false);
        return;
    }
    pollScan(res.data.id);
    loadHistory();
});

/* ---------- Resultaat tonen en volgen ---------- */
const ACTIVE = ['wachtend', 'bezig'];

function renderScan(s) {
    lastResult = s.report || '';
    const isProject = s.kind === 'project';
    const active = ACTIVE.includes(s.status);
    if (active) setState('busy');
    else if (s.status === 'klaar') setState('done');
    else if (s.status === 'geannuleerd') setState('cancelled');
    else setState('error');

    if (isProject) setPercent(Math.round((s.done / Math.max(s.total, 1)) * 100));
    else setPercent(s.status === 'klaar' ? 100 : null);
    setDetails({
        date: s.created_at, model: s.model, report: lastResult,
        input: isProject ? `${s.total} bestanden` : `${s.input_chars} tekens`,
    });

    if (isProject) {
        $('progressText').textContent = active
            ? `Bezig: ${s.done} van ${s.total} bestanden klaar${s.current_file ? ` (nu: ${s.current_file})` : ''}`
            : `Status: ${s.status} (${s.done} van ${s.total} bestanden)`;
    } else {
        $('progressText').textContent = `Status: ${s.status}`;
    }

    let html = lastResult ? renderMarkdown(lastResult) : '';
    if (!lastResult && active) {
        html = '<p class="loading">De eerste bestanden worden gescand. Lokale modellen kunnen even duren...</p>';
    }
    if (s.error) html += `<p class="error">Fout: ${escapeHtml(s.error)}</p>`;
    output.innerHTML = html || '<span class="muted">Geen resultaat.</span>';
    $('copyBtn').hidden = !lastResult;
    $('saveBtn').disabled = active || !lastResult;
}

async function pollScan(id) {
    clearTimeout(pollTimer);
    const res = await api(`/api/scans/${id}`);
    if (res.status === 0) {   // tijdelijk netwerkprobleem: opnieuw proberen
        pollTimer = setTimeout(() => pollScan(id), 4000);
        return;
    }
    if (!res.ok) {
        activeScan = null;
        setBusy(false);
        showError(res.data.error || 'Scan niet gevonden.');
        return;
    }
    const s = res.data;
    renderScan(s);
    if (ACTIVE.includes(s.status)) {
        activeScan = id;
        $('cancelBtn').disabled = false;
        setBusy(true, true);
        pollTimer = setTimeout(() => pollScan(id), 2000);
    } else {
        activeScan = null;
        setBusy(false);
        loadHistory();
    }
}

/* ---------- Geschiedenis ---------- */
async function loadHistory() {
    const res = await api('/api/scans');
    if (!res.ok) return;
    const list = $('historyList');
    if (!res.data.length) {
        list.innerHTML = '<li><span class="muted">Nog geen scans.</span></li>';
        return;
    }
    list.innerHTML = res.data.map((s) => {
        const date = new Date(s.created_at).toLocaleString('nl-NL');
        const type = typeLabels[s.scan_type] || s.scan_type;
        const prog = s.kind === 'project' ? ` &middot; ${s.done}/${s.total} bestanden` : '';
        return `<li data-id="${s.id}">
            <div class="info">
                <button type="button" data-action="open">${escapeHtml(s.label)}</button>
                <small>${escapeHtml(date)} &middot; ${escapeHtml(type)} &middot; ${escapeHtml(s.model)}${prog}</small>
            </div>
            <span class="badge ${escapeHtml(s.status)}">${escapeHtml(s.status)}</span>
            <button type="button" class="secondary small" data-action="delete">Verwijder</button>
        </li>`;
    }).join('');
}

$('historyList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;
    if (btn.dataset.action === 'open') {
        await pollScan(id);
        output.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (btn.dataset.action === 'delete') {
        const res = await api(`/api/scans/${id}`, { method: 'DELETE' });
        if (!res.ok) alert(res.data.error || 'Verwijderen mislukt.');
        loadHistory();
    }
});

$('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Alle afgeronde scans uit de geschiedenis wissen?')) return;
    await api('/api/scans', { method: 'DELETE' });
    loadHistory();
});

/* ---------- Start ---------- */
(async function init() {
    setState('idle');
    setPercent(null);
    await Promise.all([loadOptions(), loadRules()]);
    setDetails();
    loadHistory();
})();
