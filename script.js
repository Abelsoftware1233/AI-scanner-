document.getElementById('scanForm').addEventListener('submit', async function(e) {
    e.preventDefault();

    const code = document.getElementById('codeInput').value;
    const scanType = document.getElementById('scanType').value;
    const outputDiv = document.getElementById('output');
    const submitBtn = document.getElementById('submitBtn');

    if (!code.trim()) {
        alert('Voer alstublieft code of configuratie in om te scannen.');
        return;
    }

    // UI op "laden" zetten
    submitBtn.disabled = true;
    submitBtn.textContent = 'Bezig met analyseren door Dolphin...';
    outputDiv.innerHTML = '<p class="loading">AI doorzoekt de code op kwetsbaarheden en misconfiguraties...</p>';

    try {
        const response = await fetch('http://localhost:5000/api/scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                code: code, 
                scan_type: scanType 
            })
        });

        const data = await response.json();

        if (response.ok) {
            outputDiv.innerHTML = `<pre>${escapeHtml(data.result)}</pre>`;
        } else {
            outputDiv.innerHTML = `<p style="color: #f87171;">Fout: ${escapeHtml(data.error)}</p>`;
        }
    } catch (error) {
        outputDiv.innerHTML = `<p style="color: #f87171;">Verbindingsfout: Kon geen contact maken met de Flask backend (${escapeHtml(error.message)}).</p>`;
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Start AI Scan';
    }
});

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}
