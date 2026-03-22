import * as vscode from 'vscode';
import { styleFormTranslations } from './styleFormTranslations';

export class TranslationEditor {
    private static currentPanel: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext): void {
        if (TranslationEditor.currentPanel) {
            TranslationEditor.currentPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlTranslationEditor',
            'T-SQL IntelliSense — Translation Editor',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        TranslationEditor.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('globe');

        const customTranslations = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
        const builtInLangs = Object.keys(styleFormTranslations);

        panel.webview.html = TranslationEditor.getHtml(builtInLangs, customTranslations);

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.cmd === 'save') {
                const all = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
                all[msg.langCode] = msg.translations;
                await context.globalState.update('tsql.customTranslations', all);
                const uiLang = context.globalState.get<string>('tsql.uiLang', 'en');
                vscode.window.showInformationMessage(
                    uiLang === 'tr'
                        ? `"${msg.langCode}" dili kaydedildi (${Object.keys(msg.translations).length} çeviri).`
                        : `Language "${msg.langCode}" saved (${Object.keys(msg.translations).length} translations).`
                );
            } else if (msg.cmd === 'delete') {
                const all = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
                delete all[msg.langCode];
                await context.globalState.update('tsql.customTranslations', all);
                vscode.window.showInformationMessage(`Language "${msg.langCode}" deleted.`);
            } else if (msg.cmd === 'loadLang') {
                // Send built-in or custom translations for the requested language
                const builtIn = (styleFormTranslations as any)[msg.langCode];
                const custom = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
                const data = builtIn || custom[msg.langCode] || {};
                panel.webview.postMessage({ cmd: 'langData', langCode: msg.langCode, data, isBuiltIn: !!builtIn });
            } else if (msg.cmd === 'exportJson') {
                const uri = await vscode.window.showSaveDialog({
                    filters: { 'JSON': ['json'] },
                    defaultUri: vscode.Uri.file(`tsql-translations-${msg.langCode}.json`)
                });
                if (uri) {
                    const fs = await import('fs');
                    await fs.promises.writeFile(uri.fsPath, JSON.stringify(msg.translations, null, 2), 'utf-8');
                    vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
                }
            } else if (msg.cmd === 'importJson') {
                const result = await vscode.window.showOpenDialog({
                    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                    filters: { 'JSON': ['json'] }
                });
                if (result && result[0]) {
                    try {
                        const fs = await import('fs');
                        const content = await fs.promises.readFile(result[0].fsPath, 'utf-8');
                        const data = JSON.parse(content);
                        if (typeof data === 'object' && !Array.isArray(data)) {
                            panel.webview.postMessage({ cmd: 'importedData', data });
                        } else {
                            vscode.window.showErrorMessage('Invalid format — expected a JSON object with key-value pairs.');
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Import error: ${err.message}`);
                    }
                }
            }
        });

        panel.onDidDispose(() => {
            TranslationEditor.currentPanel = undefined;
        }, null, context.subscriptions);
    }

    private static getHtml(
        builtInLangs: string[],
        customTranslations: Record<string, Record<string, string>>
    ): string {
        const enKeys = Object.keys(styleFormTranslations.en);
        const customLangs = Object.keys(customTranslations);
        const allLangs = [...builtInLangs, ...customLangs.filter(l => !builtInLangs.includes(l))];

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Translation Editor</title>
    <style>
        body { margin:0; padding:0; font-family:var(--vscode-font-family); font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; }
        .toolbar { padding:12px 24px; background:var(--vscode-editorWidget-background); border-bottom:1px solid var(--vscode-panel-border); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
        .toolbar label { font-weight:600; }
        .toolbar select, .toolbar input[type=text] { padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; }
        .toolbar input[type=text] { width:80px; }
        .btn { padding:5px 14px; font-size:12px; border:none; border-radius:3px; cursor:pointer; font-family:var(--vscode-font-family); }
        .btn-primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
        .btn-primary:hover { background:var(--vscode-button-hoverBackground); }
        .btn-secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
        .btn-secondary:hover { background:var(--vscode-button-secondaryHoverBackground); }
        .btn-danger { background:#c44; color:#fff; }
        .btn-danger:hover { background:#a33; }
        .table-container { flex:1; overflow:auto; padding:0 24px 24px; }
        table { width:100%; border-collapse:collapse; margin-top:12px; }
        th { position:sticky; top:0; background:var(--vscode-editorWidget-background); padding:8px 12px; text-align:left; font-size:12px; border-bottom:2px solid var(--vscode-panel-border); z-index:1; }
        td { padding:4px 12px; border-bottom:1px solid var(--vscode-panel-border); vertical-align:top; }
        td:first-child { font-family:var(--vscode-editor-fontFamily, monospace); font-size:11px; color:var(--vscode-descriptionForeground); width:220px; white-space:nowrap; }
        td:nth-child(2) { color:var(--vscode-descriptionForeground); width:40%; font-size:12px; }
        td input[type=text] { width:100%; padding:4px 6px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; box-sizing:border-box; }
        td input[type=text]:focus { outline:1px solid var(--vscode-focusBorder); }
        td input.filled { border-color: var(--vscode-charts-green, #4ec); }
        td input.empty { }
        .stats { padding:8px 24px; font-size:12px; color:var(--vscode-descriptionForeground); border-top:1px solid var(--vscode-panel-border); display:flex; gap:16px; align-items:center; }
        .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; }
        .badge-builtin { background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
        .badge-custom { background:var(--vscode-charts-green, #4ec9); color:#000; }
        .search-box { padding:4px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; width:200px; }
    </style>
</head>
<body>
    <div class="toolbar">
        <label>Language:</label>
        <select id="langSelect" onchange="onLangChange()">
            <option value="">— select or create —</option>
            ${allLangs.map(l => `<option value="${l}">${l}${builtInLangs.includes(l) ? ' (built-in)' : ' (custom)'}</option>`).join('')}
        </select>

        <label>New:</label>
        <input type="text" id="newLangCode" placeholder="e.g. de" maxlength="5" />
        <button class="btn btn-secondary" onclick="createLang()">Create</button>

        <span style="flex:1"></span>

        <input type="text" class="search-box" id="searchBox" placeholder="Filter keys..." oninput="filterRows()" />

        <button class="btn btn-secondary" onclick="importJson()">Import JSON</button>
        <button class="btn btn-secondary" onclick="exportJson()">Export JSON</button>
        <button class="btn btn-primary" onclick="save()">Save</button>
        <button class="btn btn-danger" onclick="deleteLang()" id="deleteBtn" style="display:none">Delete</button>
    </div>

    <div class="table-container">
        <table>
            <thead>
                <tr>
                    <th>Key</th>
                    <th>English (reference)</th>
                    <th>Translation</th>
                </tr>
            </thead>
            <tbody id="tbody">
                <tr><td colspan="3" style="text-align:center; padding:32px; color:var(--vscode-descriptionForeground);">Select a language or create a new one to start translating.</td></tr>
            </tbody>
        </table>
    </div>

    <div class="stats" id="stats" style="display:none">
        <span id="progressText"></span>
        <span id="langBadge"></span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const enStrings = ${JSON.stringify(styleFormTranslations.en)};
        const enKeys = Object.keys(enStrings);
        const builtInLangs = ${JSON.stringify(builtInLangs)};
        let currentLang = '';
        let currentData = {};
        let isBuiltIn = false;

        function onLangChange() {
            const sel = document.getElementById('langSelect');
            currentLang = sel.value;
            if (!currentLang) {
                document.getElementById('tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:32px; color:var(--vscode-descriptionForeground);">Select a language or create a new one to start translating.</td></tr>';
                document.getElementById('stats').style.display = 'none';
                document.getElementById('deleteBtn').style.display = 'none';
                return;
            }
            vscode.postMessage({ cmd: 'loadLang', langCode: currentLang });
        }

        function createLang() {
            const code = document.getElementById('newLangCode').value.trim().toLowerCase();
            if (!code) return;
            if (builtInLangs.includes(code)) {
                // Just select it
                document.getElementById('langSelect').value = code;
                onLangChange();
                return;
            }
            // Add to dropdown if not exists
            const sel = document.getElementById('langSelect');
            let found = false;
            for (const opt of sel.options) { if (opt.value === code) { found = true; break; } }
            if (!found) {
                const opt = document.createElement('option');
                opt.value = code;
                opt.textContent = code + ' (custom)';
                sel.appendChild(opt);
            }
            sel.value = code;
            document.getElementById('newLangCode').value = '';
            currentLang = code;
            currentData = {};
            isBuiltIn = false;
            renderTable();
        }

        function renderTable() {
            const tbody = document.getElementById('tbody');
            let html = '';
            for (const key of enKeys) {
                const enVal = enStrings[key] || '';
                const trVal = currentData[key] || '';
                const shortEn = enVal.length > 120 ? enVal.substring(0, 120) + '...' : enVal;
                const inputClass = trVal ? 'filled' : 'empty';
                html += '<tr class="trow" data-key="' + key + '">'
                    + '<td>' + escapeHtml(key) + '</td>'
                    + '<td title="' + escapeHtml(enVal) + '">' + escapeHtml(shortEn) + '</td>'
                    + '<td><input type="text" class="' + inputClass + '" value="' + escapeHtml(trVal) + '" data-key="' + key + '" oninput="onInput(this)" ' + (isBuiltIn ? 'disabled' : '') + ' /></td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
            updateStats();
            document.getElementById('stats').style.display = '';
            document.getElementById('deleteBtn').style.display = isBuiltIn ? 'none' : '';
        }

        function onInput(el) {
            currentData[el.getAttribute('data-key')] = el.value;
            el.className = el.value ? 'filled' : 'empty';
            updateStats();
        }

        function updateStats() {
            const filled = enKeys.filter(k => currentData[k]).length;
            const total = enKeys.length;
            const pct = Math.round(filled / total * 100);
            document.getElementById('progressText').textContent = filled + ' / ' + total + ' (' + pct + '%)';
            document.getElementById('langBadge').innerHTML = isBuiltIn
                ? '<span class="badge badge-builtin">Built-in (read-only)</span>'
                : '<span class="badge badge-custom">Custom</span>';
        }

        function filterRows() {
            const q = document.getElementById('searchBox').value.toLowerCase();
            document.querySelectorAll('.trow').forEach(row => {
                const key = row.getAttribute('data-key').toLowerCase();
                const en = (enStrings[row.getAttribute('data-key')] || '').toLowerCase();
                row.style.display = (!q || key.includes(q) || en.includes(q)) ? '' : 'none';
            });
        }

        function save() {
            if (!currentLang || isBuiltIn) return;
            // Collect from inputs
            const translations = {};
            document.querySelectorAll('input[data-key]').forEach(el => {
                if (el.value.trim()) translations[el.getAttribute('data-key')] = el.value.trim();
            });
            currentData = translations;
            vscode.postMessage({ cmd: 'save', langCode: currentLang, translations });
        }

        function deleteLang() {
            if (!currentLang || isBuiltIn) return;
            vscode.postMessage({ cmd: 'delete', langCode: currentLang });
            // Remove from dropdown
            const sel = document.getElementById('langSelect');
            for (const opt of Array.from(sel.options)) {
                if (opt.value === currentLang) { sel.removeChild(opt); break; }
            }
            sel.value = '';
            currentLang = '';
            currentData = {};
            document.getElementById('tbody').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:32px; color:var(--vscode-descriptionForeground);">Language deleted.</td></tr>';
            document.getElementById('stats').style.display = 'none';
            document.getElementById('deleteBtn').style.display = 'none';
        }

        function importJson() {
            vscode.postMessage({ cmd: 'importJson' });
        }

        function exportJson() {
            if (!currentLang) return;
            const translations = {};
            document.querySelectorAll('input[data-key]').forEach(el => {
                if (el.value.trim()) translations[el.getAttribute('data-key')] = el.value.trim();
            });
            vscode.postMessage({ cmd: 'exportJson', langCode: currentLang, translations });
        }

        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.cmd === 'langData') {
                currentData = msg.data || {};
                isBuiltIn = msg.isBuiltIn;
                renderTable();
            } else if (msg.cmd === 'importedData') {
                // Merge imported data into inputs
                for (const [key, val] of Object.entries(msg.data)) {
                    const input = document.querySelector('input[data-key="' + key + '"]');
                    if (input && !isBuiltIn) {
                        input.value = val;
                        input.className = val ? 'filled' : 'empty';
                        currentData[key] = val;
                    }
                }
                updateStats();
            }
        });
    </script>
</body>
</html>`;
    }
}
