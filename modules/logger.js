export function createLogger() {
    const logEntries = [];

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text ?? '');
        return div.innerHTML;
    }

    function log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const entry = { timestamp, message: String(message ?? ''), type };
        logEntries.push(entry);

        const logContent = document.getElementById('logContent');
        const logCount = document.getElementById('logCount');

        if (logContent) {
            const div = document.createElement('div');
            div.className = `log-entry ${type}`;
            div.innerHTML = `<span class="log-timestamp">[${timestamp}]</span>${escapeHtml(message)}`;
            logContent.appendChild(div);
            logContent.scrollTop = logContent.scrollHeight;
        }

        if (logCount) {
            logCount.textContent = `(${logEntries.length})`;
        }

        const consoleFn = type === 'error' ? console.error : type === 'warning' ? console.warn : console.log;
        consoleFn(`[TunesReloaded] ${message}`);
    }

    function toggleLogPanel() {
        const panel = document.getElementById('logPanel');
        const toggle = document.getElementById('logToggle');
        if (!panel || !toggle) return;
        panel.classList.toggle('collapsed');
        panel.classList.toggle('expanded');
        toggle.textContent = panel.classList.contains('expanded') ? '▼' : '▲';
    }

    return { log, toggleLogPanel, escapeHtml, logEntries };
}

