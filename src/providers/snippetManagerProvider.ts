import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SnippetProvider, RedgateSnippet } from './snippetProvider';

export class SnippetManagerProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;
    private static snippetProvider: SnippetProvider;

    static createOrShow(extensionUri: vscode.Uri, snippetProvider: SnippetProvider): void {
        SnippetManagerProvider.snippetProvider = snippetProvider;
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (SnippetManagerProvider.currentPanel) {
            SnippetManagerProvider.currentPanel.reveal(column);
            SnippetManagerProvider.sendSnippets();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlSnippetManager',
            'Snippet Manager',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SnippetManagerProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('symbol-snippet');
        panel.webview.html = SnippetManagerProvider.getHtml();

        panel.webview.onDidReceiveMessage(msg => SnippetManagerProvider.handleMessage(msg));
        panel.onDidDispose(() => { SnippetManagerProvider.currentPanel = undefined; });

        SnippetManagerProvider.sendSnippets();
    }

    static openNewWithBody(body: string): void {
        SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'openNewWithBody', body });
    }

    private static async sendSnippets(): Promise<void> {
        const folder = SnippetManagerProvider.snippetProvider.getSnippetFolder();
        let error: string | undefined;
        if (folder) {
            try {
                await fs.promises.access(folder, fs.constants.R_OK);
            } catch {
                error = 'inaccessible';
            }
        }
        const snippets = error ? [] : SnippetManagerProvider.snippetProvider.getSnippets();
        SnippetManagerProvider.currentPanel?.webview.postMessage({
            cmd: 'snippetsLoaded',
            snippets,
            folder,
            error
        });
    }

    private static async handleMessage(msg: any): Promise<void> {
        switch (msg.cmd) {
            case 'loadSnippets':
                await SnippetManagerProvider.sendSnippets();
                break;
            case 'openFolderPicker':
                await SnippetManagerProvider.pickFolder();
                break;
            case 'createSnippet':
                await SnippetManagerProvider.createSnippet(msg);
                break;
            case 'updateSnippet':
                await SnippetManagerProvider.updateSnippet(msg);
                break;
            case 'deleteSnippet':
                await SnippetManagerProvider.deleteSnippet(msg);
                break;
        }
    }

    private static async pickFolder(): Promise<void> {
        const current = SnippetManagerProvider.snippetProvider.getSnippetFolder();
        const result = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Snippet Dizini Seç',
            defaultUri: current ? vscode.Uri.file(current) : undefined,
        });
        if (result?.[0]) {
            await vscode.workspace.getConfiguration('tsql-intellisense').update('snippetFolder', result[0].fsPath, vscode.ConfigurationTarget.Global);
            await SnippetManagerProvider.snippetProvider.loadSnippets();
            await SnippetManagerProvider.sendSnippets();
        }
    }

    private static async createSnippet(msg: { prefix: string; description: string; body: string }): Promise<void> {
        const folder = SnippetManagerProvider.snippetProvider.getSnippetFolder();
        if (!folder) {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Snippet klasörü ayarlanmamış.' });
            return;
        }
        const filePath = path.join(folder, `${msg.prefix}.json`);
        try {
            await fs.promises.access(filePath);
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Bu prefix zaten mevcut.' });
            return;
        } catch { /* file does not exist — OK to create */ }
        try {
            const snippet: RedgateSnippet = { prefix: msg.prefix, description: msg.description || undefined, body: msg.body };
            await fs.promises.writeFile(filePath, JSON.stringify(snippet, null, 2), 'utf-8');
            await SnippetManagerProvider.snippetProvider.loadSnippets();
            await SnippetManagerProvider.sendSnippets();
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: true });
        } catch (err: any) {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: err.message });
        }
    }

    private static async updateSnippet(msg: { originalPrefix: string; prefix: string; description: string; body: string }): Promise<void> {
        const folder = SnippetManagerProvider.snippetProvider.getSnippetFolder();
        if (!folder) {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Snippet klasörü ayarlanmamış.' });
            return;
        }
        if (msg.originalPrefix !== msg.prefix) {
            const newPath = path.join(folder, `${msg.prefix}.json`);
            try {
                await fs.promises.access(newPath);
                SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Bu prefix zaten mevcut.' });
                return;
            } catch { /* OK */ }
        }
        try {
            const oldPath = path.join(folder, `${msg.originalPrefix}.json`);
            await fs.promises.unlink(oldPath);
            const snippet: RedgateSnippet = { prefix: msg.prefix, description: msg.description || undefined, body: msg.body };
            const newPath = path.join(folder, `${msg.prefix}.json`);
            await fs.promises.writeFile(newPath, JSON.stringify(snippet, null, 2), 'utf-8');
            await SnippetManagerProvider.snippetProvider.loadSnippets();
            await SnippetManagerProvider.sendSnippets();
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: true });
        } catch (err: any) {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetSaved', success: false, error: err.message });
        }
    }

    private static async deleteSnippet(msg: { prefix: string }): Promise<void> {
        const folder = SnippetManagerProvider.snippetProvider.getSnippetFolder();
        if (!folder) { return; }
        const answer = await vscode.window.showWarningMessage(
            `'${msg.prefix}' snippet'ini silmek istediğinize emin misiniz?`,
            { modal: true },
            'Sil'
        );
        if (answer !== 'Sil') {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetDeleted', success: false });
            return;
        }
        try {
            await fs.promises.unlink(path.join(folder, `${msg.prefix}.json`));
            await SnippetManagerProvider.snippetProvider.loadSnippets();
            await SnippetManagerProvider.sendSnippets();
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetDeleted', success: true });
        } catch (err: any) {
            SnippetManagerProvider.currentPanel?.webview.postMessage({ cmd: 'snippetDeleted', success: false, error: err.message });
        }
    }

    private static getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh;
}
#header { flex-shrink: 0; }
#title { padding: 12px 16px 4px 16px; font-size: 15px; font-weight: 600; }
#folder-bar { padding: 6px 16px; display: flex; align-items: center; gap: 6px; }
#folder-bar label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
#folder-input {
    flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #444);
    border-radius: 3px; padding: 4px 8px; color: var(--vscode-input-foreground); font-size: 12px;
}
.btn {
    background: var(--vscode-button-secondaryBackground, #2d2d2d);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 4px 14px; border-radius: 3px; cursor: pointer; font-size: 12px; font-family: inherit;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, #3d3d3d); }
.btn-primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 6px 18px;
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
#toolbar { padding: 6px 16px 10px 16px; display: flex; align-items: center; justify-content: space-between; }
#toolbar-buttons { display: flex; gap: 6px; }
#search-box {
    display: flex; align-items: center; background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, #444); border-radius: 3px; padding: 0 8px; width: 220px;
}
#search-input {
    flex: 1; background: transparent; border: none; outline: none;
    color: var(--vscode-input-foreground); font-size: 12px; padding: 4px 0; font-family: inherit;
}
#search-icon { color: var(--vscode-descriptionForeground); font-size: 13px; margin-left: 4px; }
#main { flex: 1; display: flex; overflow: hidden; border-top: 1px solid var(--vscode-panel-border, #333); }
#list-panel { width: 45%; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border, #333); }
.col-header {
    display: flex; padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
    border-bottom: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase;
    letter-spacing: 0.5px; height: 34px; align-items: center; flex-shrink: 0;
}
.col-header span:first-child { width: 40%; }
.col-header span:last-child { width: 60%; }
#snippet-list { flex: 1; overflow-y: auto; }
.snippet-row {
    display: flex; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); cursor: pointer;
}
.snippet-row:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.snippet-row.selected { background: var(--vscode-list-activeSelectionBackground, #094771); }
.snippet-row.selected .col-prefix { color: var(--vscode-list-activeSelectionForeground, #fff); }
.col-prefix { width: 40%; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-desc { width: 60%; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#list-footer {
    padding: 6px 12px; background: var(--vscode-sideBarSectionHeader-background, #252526);
    border-top: 1px solid var(--vscode-panel-border, #333);
    font-size: 11px; color: var(--vscode-descriptionForeground); flex-shrink: 0;
}
#code-panel { width: 55%; display: flex; flex-direction: column; }
#code-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
    border-bottom: 1px solid var(--vscode-panel-border, #333); height: 34px; flex-shrink: 0;
}
#code-header span {
    font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px;
}
.icon-btn {
    background: transparent; border: 1px solid var(--vscode-input-border, #555);
    color: var(--vscode-foreground); width: 28px; height: 28px; border-radius: 3px;
    cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
}
.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, #3d3d3d); }
#code-content {
    flex: 1; overflow: auto; padding: 12px;
    font-family: var(--vscode-editor-fontFamily, 'Cascadia Code', 'Consolas', monospace);
    font-size: var(--vscode-editor-fontSize, 13px); line-height: 1.6;
    white-space: pre-wrap; word-wrap: break-word; tab-size: 4;
}
#empty-state {
    display: none; flex: 1; align-items: center; justify-content: center;
    color: var(--vscode-descriptionForeground); font-size: 14px; padding: 40px; text-align: center;
}
#modal-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 100;
}
#modal {
    background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #555);
    border-radius: 6px; padding: 20px; width: 600px; max-width: 90vw; max-height: 80vh;
    display: flex; flex-direction: column; gap: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
#modal h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
#modal label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
#modal input[type="text"] {
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #444);
    border-radius: 3px; padding: 6px 8px; color: var(--vscode-input-foreground);
    font-size: 13px; width: 100%; font-family: inherit;
}
#modal-editor-area {
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #444);
    border-radius: 3px; padding: 8px; color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-fontFamily, 'Cascadia Code', 'Consolas', monospace);
    font-size: var(--vscode-editor-fontSize, 13px); line-height: 1.5;
    min-height: 200px; max-height: 40vh; overflow-y: auto; resize: vertical;
    width: 100%; white-space: pre-wrap; tab-size: 4;
}
.error-text { color: var(--vscode-errorForeground, #f48771); font-size: 12px; min-height: 16px; }
#modal-buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
</style>
</head>
<body>

<div id="header">
    <div id="title">Snippet'ler</div>
    <div id="folder-bar">
        <label>Snippet klasörü:</label>
        <input type="text" id="folder-input" readonly>
        <button class="btn" onclick="vscode.postMessage({cmd:'openFolderPicker'})" title="Klasör seç">...</button>
    </div>
    <div id="toolbar">
        <div id="toolbar-buttons">
            <button class="btn" onclick="openNewModal()">New...</button>
            <button class="btn" onclick="openEditModalSelected()">Edit...</button>
            <button class="btn" onclick="deleteSnippet()">Delete</button>
        </div>
        <div id="search-box">
            <input type="text" id="search-input" placeholder="Search..." oninput="applyFilter()">
            <span id="search-icon">&#128269;</span>
        </div>
    </div>
</div>

<div id="main">
    <div id="list-panel">
        <div class="col-header"><span>Snippet</span><span>Açıklama</span></div>
        <div id="snippet-list"></div>
        <div id="list-footer">0 snippets</div>
    </div>
    <div id="code-panel">
        <div id="code-header">
            <span>Code</span>
            <button class="icon-btn" onclick="copyCode()" title="Kopyala">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
                    <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" fill="none"/>
                </svg>
            </button>
        </div>
        <pre id="code-content"></pre>
    </div>
</div>

<div id="empty-state"></div>

<div id="modal-overlay">
    <div id="modal">
        <h3 id="modal-title">Yeni Snippet</h3>
        <label for="modal-prefix">Prefix</label>
        <input type="text" id="modal-prefix">
        <div class="error-text" id="prefix-error"></div>
        <label for="modal-desc">Description</label>
        <input type="text" id="modal-desc">
        <label>Body</label>
        <textarea id="modal-editor-area" spellcheck="false"></textarea>
        <div class="error-text" id="modal-error"></div>
        <div id="modal-buttons">
            <button class="btn" onclick="closeModal()">İptal</button>
            <button class="btn btn-primary" onclick="saveSnippet()">Kaydet</button>
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let allSnippets = [];
let filteredSnippets = [];
let selectedIndex = -1;
let editMode = false;
let originalPrefix = '';

window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.cmd) {
        case 'snippetsLoaded':
            allSnippets = (msg.snippets || []).sort((a, b) =>
                a.prefix.localeCompare(b.prefix, undefined, { sensitivity: 'base' }));
            document.getElementById('folder-input').value = msg.folder || '';
            selectedIndex = -1;
            document.getElementById('code-content').textContent = '';
            applyFilter();
            updateEmptyState(msg.folder, msg.error);
            break;
        case 'snippetSaved':
            if (msg.success) { closeModal(); }
            else { showModalError(msg.error); }
            break;
        case 'snippetDeleted':
            break;
    }
});

function applyFilter() {
    const q = document.getElementById('search-input').value.toLowerCase();
    filteredSnippets = q
        ? allSnippets.filter(s =>
            s.prefix.toLowerCase().includes(q) ||
            (s.description || '').toLowerCase().includes(q) ||
            s.body.toLowerCase().includes(q))
        : [...allSnippets];
    renderList();
}

function renderList() {
    const list = document.getElementById('snippet-list');
    list.innerHTML = filteredSnippets.map((s, i) =>
        '<div class="snippet-row' + (i === selectedIndex ? ' selected' : '') + '"' +
        ' onclick="selectSnippet(' + i + ')"' +
        ' ondblclick="openEditModal(' + i + ')">' +
        '<span class="col-prefix">' + escHtml(s.prefix) + '</span>' +
        '<span class="col-desc">' + escHtml(s.description || '') + '</span>' +
        '</div>'
    ).join('');
    const total = allSnippets.length;
    const shown = filteredSnippets.length;
    document.getElementById('list-footer').textContent =
        shown === total ? total + ' snippets' : shown + ' / ' + total + ' snippets';
}

function selectSnippet(i) {
    selectedIndex = i;
    renderList();
    const s = filteredSnippets[i];
    document.getElementById('code-content').textContent = s ? s.body.replace(/\\\\n/g, '\\n') : '';
}

const INVALID_CHARS = /[\\/\\\\:?"<>|*]/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function validatePrefix(prefix) {
    if (!prefix.trim()) return 'Prefix boş olamaz.';
    if (INVALID_CHARS.test(prefix)) return 'Prefix geçersiz karakter içeriyor.';
    if (prefix.includes('..')) return 'Prefix ".." içeremez.';
    if (RESERVED.test(prefix.trim())) return 'Bu isim Windows tarafından ayrılmıştır.';
    return '';
}

function openNewModal() {
    editMode = false;
    document.getElementById('modal-title').textContent = 'Yeni Snippet';
    document.getElementById('modal-prefix').value = '';
    document.getElementById('modal-desc').value = '';
    document.getElementById('modal-editor-area').value = '';
    document.getElementById('prefix-error').textContent = '';
    document.getElementById('modal-error').textContent = '';
    document.getElementById('modal-overlay').style.display = 'flex';
    document.getElementById('modal-prefix').focus();
}
function openEditModal(i) {
    const s = filteredSnippets[i];
    if (!s) return;
    editMode = true;
    originalPrefix = s.prefix;
    document.getElementById('modal-title').textContent = 'Snippet Düzenle';
    document.getElementById('modal-prefix').value = s.prefix;
    document.getElementById('modal-desc').value = s.description || '';
    document.getElementById('modal-editor-area').value = s.body.replace(/\\\\n/g, '\\n');
    document.getElementById('prefix-error').textContent = '';
    document.getElementById('modal-error').textContent = '';
    document.getElementById('modal-overlay').style.display = 'flex';
}
function openEditModalSelected() {
    if (selectedIndex >= 0) openEditModal(selectedIndex);
}
function closeModal() {
    document.getElementById('modal-overlay').style.display = 'none';
}

function saveSnippet() {
    const prefix = document.getElementById('modal-prefix').value.trim();
    const desc = document.getElementById('modal-desc').value.trim();
    const body = document.getElementById('modal-editor-area').value || '';
    const err = validatePrefix(prefix);
    if (err) { document.getElementById('prefix-error').textContent = err; return; }
    document.getElementById('prefix-error').textContent = '';
    const bodyStored = body.replace(/\\n/g, '\\\\n');
    if (editMode) {
        vscode.postMessage({ cmd: 'updateSnippet', originalPrefix, prefix, description: desc, body: bodyStored });
    } else {
        vscode.postMessage({ cmd: 'createSnippet', prefix, description: desc, body: bodyStored });
    }
}

function deleteSnippet() {
    const s = filteredSnippets[selectedIndex];
    if (!s) return;
    vscode.postMessage({ cmd: 'deleteSnippet', prefix: s.prefix });
}

function copyCode() {
    const code = document.getElementById('code-content').textContent;
    if (code) navigator.clipboard.writeText(code);
}

function updateEmptyState(folder, error) {
    const el = document.getElementById('empty-state');
    const main = document.getElementById('main');
    if (error) {
        el.textContent = 'Snippet klasörüne erişilemiyor: ' + folder + '. Klasör yolunu kontrol edin.';
        el.style.display = 'flex';
        main.style.display = 'none';
    } else if (!folder) {
        el.textContent = 'Snippet klasörü ayarlanmamış. [...] butonuna tıklayarak bir klasör seçin.';
        el.style.display = 'flex';
        main.style.display = 'none';
    } else if (allSnippets.length === 0) {
        el.textContent = 'Bu klasörde snippet bulunamadı. New butonuna tıklayarak yeni snippet oluşturun.';
        el.style.display = 'flex';
        main.style.display = 'none';
    } else {
        el.style.display = 'none';
        main.style.display = 'flex';
    }
}

document.addEventListener('keydown', e => {
    if (document.getElementById('modal-overlay').style.display === 'flex') {
        if (e.key === 'Escape') closeModal();
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveSnippet(); }
    }
});

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showModalError(msg) { document.getElementById('modal-error').textContent = msg || 'Bilinmeyen hata.'; }

window.addEventListener('message', e => {
    if (e.data.cmd === 'openNewWithBody') {
        editMode = false;
        document.getElementById('modal-title').textContent = 'Yeni Snippet';
        document.getElementById('modal-prefix').value = '';
        document.getElementById('modal-desc').value = '';
        document.getElementById('modal-editor-area').value = e.data.body || '';
        document.getElementById('prefix-error').textContent = '';
        document.getElementById('modal-error').textContent = '';
        document.getElementById('modal-overlay').style.display = 'flex';
        document.getElementById('modal-prefix').focus();
    }
});

vscode.postMessage({ cmd: 'loadSnippets' });
</script>
</body>
</html>`;
    }
}
