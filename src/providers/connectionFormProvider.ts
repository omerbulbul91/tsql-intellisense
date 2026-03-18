import * as vscode from 'vscode';
import { ConnectionManager, ConnectionProfile } from '../connection/connectionManager';
import { ConnectionTreeProvider } from './connectionTreeProvider';

export class ConnectionFormProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    static show(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        treeProvider: ConnectionTreeProvider,
        editProfile?: ConnectionProfile
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (ConnectionFormProvider.currentPanel) {
            ConnectionFormProvider.currentPanel.reveal(column);
            ConnectionFormProvider.currentPanel.webview.postMessage({
                cmd: 'loadProfile',
                profile: editProfile || null,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlConnectionForm',
            editProfile ? `Edit: ${editProfile.name}` : 'New Connection',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ConnectionFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('database');
        panel.webview.html = ConnectionFormProvider.getHtml(editProfile);

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {
                case 'test': {
                    const result = await connectionManager.testConnection(msg.profile);
                    panel.webview.postMessage({ cmd: 'testResult', ...result });
                    break;
                }
                case 'save': {
                    await ConnectionFormProvider.saveProfile(msg.profile, msg.originalName);
                    treeProvider.refresh();
                    panel.webview.postMessage({ cmd: 'saved' });
                    break;
                }
                case 'saveAndConnect': {
                    await ConnectionFormProvider.saveProfile(msg.profile, msg.originalName);
                    treeProvider.refresh();
                    try {
                        await connectionManager.connect(msg.profile);
                        panel.webview.postMessage({ cmd: 'saved' });
                        panel.dispose();
                    } catch (err: any) {
                        panel.webview.postMessage({ cmd: 'testResult', success: false, error: err.message });
                    }
                    break;
                }
                case 'browse': {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Select Project Folder',
                    });
                    if (result && result[0]) {
                        panel.webview.postMessage({ cmd: 'browsed', path: result[0].fsPath });
                    }
                    break;
                }
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
            ConnectionFormProvider.currentPanel = undefined;
        }, null, context.subscriptions);
    }

    private static async saveProfile(profile: ConnectionProfile, originalName?: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const connections = config.get<any[]>('connections', []);
        const target = vscode.workspace.workspaceFolders
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        if (originalName) {
            const idx = connections.findIndex(c => c.name === originalName);
            if (idx >= 0) {
                connections[idx] = profile;
            } else {
                connections.push(profile);
            }
        } else {
            connections.push(profile);
        }

        await config.update('connections', connections, target);
    }

    static escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private static getHtml(editProfile?: ConnectionProfile): string {
        const p = editProfile;
        const e = ConnectionFormProvider.escapeHtml;
        const isWindows = p && !p.user;
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Connection</title>
<style>
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px 40px;
        max-width: 600px;
    }
    h2 { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; }
    label {
        display: block; margin-bottom: 4px;
        font-weight: 600; font-size: 12px;
        color: var(--vscode-descriptionForeground);
    }
    input, select {
        width: 100%; padding: 6px 8px; box-sizing: border-box;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; font-size: 13px;
    }
    input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
    .checkbox-group { display: flex; align-items: center; gap: 8px; }
    .checkbox-group input { width: auto; }
    .browse-group { display: flex; gap: 8px; }
    .browse-group input { flex: 1; }
    button {
        padding: 6px 14px; border: none; border-radius: 2px;
        font-size: 13px; cursor: pointer;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .button-row { display: flex; gap: 10px; margin-top: 24px; }
    .sql-fields { display: ${!p || p.user ? 'block' : 'none'}; }
    .status {
        margin-top: 12px; padding: 8px 12px; border-radius: 4px;
        display: none; font-size: 12px;
    }
    .status.success { display: block; background: var(--vscode-testing-iconPassed); color: #fff; }
    .status.error { display: block; background: var(--vscode-testing-iconFailed); color: #fff; }
    .status.info { display: block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
</style>
</head>
<body>
<h2>${p ? 'Edit Connection' : 'New Connection'}</h2>

<div class="form-group">
    <label>Profile Name *</label>
    <input id="name" value="${p ? e(p.name) : ''}" placeholder="My Server" />
</div>
<div class="form-group">
    <label>Server *</label>
    <input id="server" value="${p ? e(p.server) : ''}" placeholder="localhost or 192.168.1.100" />
</div>
<div class="form-group">
    <label>Port</label>
    <input id="port" type="number" value="${p?.port || 1433}" />
</div>
<div class="form-group">
    <label>Authentication</label>
    <select id="authType" onchange="toggleAuth()">
        <option value="sql" ${!isWindows ? 'selected' : ''}>SQL Login</option>
        <option value="windows" ${isWindows ? 'selected' : ''}>Windows Authentication</option>
    </select>
</div>
<div class="sql-fields" id="sqlFields">
    <div class="form-group">
        <label>User Name *</label>
        <input id="user" value="${p?.user ? e(p.user) : ''}" placeholder="sa" />
    </div>
    <div class="form-group">
        <label>Password *</label>
        <input id="password" type="password" value="${p?.password ? e(p.password) : ''}" />
    </div>
</div>
<div class="form-group">
    <label>Database *</label>
    <input id="database" value="${p ? e(p.database) : ''}" placeholder="MyDatabase" />
</div>
<div class="form-group">
    <div class="checkbox-group">
        <input id="trustCert" type="checkbox" ${(!p || p.trustServerCertificate !== false) ? 'checked' : ''} />
        <label for="trustCert" style="margin:0;font-weight:normal">Trust Server Certificate</label>
    </div>
</div>
<div class="form-group">
    <label>Project Path</label>
    <div class="browse-group">
        <input id="projectPath" value="${p?.projectPath ? e(p.projectPath) : ''}" placeholder="Optional: SQL project folder" />
        <button class="btn-secondary" onclick="browse()">Browse...</button>
    </div>
</div>

<div class="button-row">
    <button class="btn-secondary" onclick="testConnection()">Test Connection</button>
    <button class="btn-secondary" onclick="save()">Save</button>
    <button onclick="saveAndConnect()">Save & Connect</button>
</div>

<div class="status" id="status"></div>

<script>
    const vscode = acquireVsCodeApi();
    let originalName = ${p ? `'${e(p.name).replace(/'/g, "\\'")}'` : 'null'};

    function toggleAuth() {
        const isSql = document.getElementById('authType').value === 'sql';
        document.getElementById('sqlFields').style.display = isSql ? 'block' : 'none';
    }

    function getProfile() {
        const isSql = document.getElementById('authType').value === 'sql';
        const profile = {
            name: document.getElementById('name').value.trim(),
            server: document.getElementById('server').value.trim(),
            port: parseInt(document.getElementById('port').value) || 1433,
            database: document.getElementById('database').value.trim(),
            trustServerCertificate: document.getElementById('trustCert').checked,
            projectPath: document.getElementById('projectPath').value.trim() || undefined,
        };
        if (isSql) {
            profile.user = document.getElementById('user').value.trim();
            profile.password = document.getElementById('password').value;
        }
        return profile;
    }

    function showStatus(msg, type) {
        const el = document.getElementById('status');
        el.textContent = msg;
        el.className = 'status ' + type;
    }

    function validate() {
        const p = getProfile();
        if (!p.name || !p.server || !p.database) {
            showStatus('Please fill in Profile Name, Server, and Database.', 'error');
            return null;
        }
        const isSql = document.getElementById('authType').value === 'sql';
        if (isSql && (!p.user || !p.password)) {
            showStatus('Please fill in User Name and Password for SQL Login.', 'error');
            return null;
        }
        return p;
    }

    function testConnection() {
        const profile = validate();
        if (!profile) return;
        showStatus('Testing connection...', 'info');
        vscode.postMessage({ cmd: 'test', profile });
    }

    function save() {
        const profile = validate();
        if (!profile) return;
        showStatus('Saving...', 'info');
        vscode.postMessage({ cmd: 'save', profile, originalName });
    }

    function saveAndConnect() {
        const profile = validate();
        if (!profile) return;
        showStatus('Saving and connecting...', 'info');
        vscode.postMessage({ cmd: 'saveAndConnect', profile, originalName });
    }

    function browse() {
        vscode.postMessage({ cmd: 'browse' });
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.cmd === 'testResult') {
            showStatus(
                msg.success ? 'Connection successful!' : (msg.error || 'Connection failed'),
                msg.success ? 'success' : 'error'
            );
        } else if (msg.cmd === 'saved') {
            showStatus('Saved successfully!', 'success');
        } else if (msg.cmd === 'browsed') {
            document.getElementById('projectPath').value = msg.path;
        } else if (msg.cmd === 'loadProfile') {
            if (msg.profile) {
                document.getElementById('name').value = msg.profile.name || '';
                document.getElementById('server').value = msg.profile.server || '';
                document.getElementById('port').value = msg.profile.port || 1433;
                document.getElementById('database').value = msg.profile.database || '';
                document.getElementById('user').value = msg.profile.user || '';
                document.getElementById('password').value = msg.profile.password || '';
                document.getElementById('trustCert').checked = msg.profile.trustServerCertificate !== false;
                document.getElementById('projectPath').value = msg.profile.projectPath || '';
                document.getElementById('authType').value = msg.profile.user ? 'sql' : 'windows';
                originalName = msg.profile.name || null;
                toggleAuth();
            } else {
                document.getElementById('name').value = '';
                document.getElementById('server').value = '';
                document.getElementById('port').value = '1433';
                document.getElementById('database').value = '';
                document.getElementById('user').value = '';
                document.getElementById('password').value = '';
                document.getElementById('trustCert').checked = true;
                document.getElementById('projectPath').value = '';
                document.getElementById('authType').value = 'sql';
                originalName = null;
                toggleAuth();
            }
        }
    });
</script>
</body>
</html>`;
    }
}
