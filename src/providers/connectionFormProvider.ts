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

        // Get saved and recent connections for sidebar
        const saved = connectionManager.getSavedProfiles();
        const recent = context.globalState.get<ConnectionProfile[]>('recentConnections', []);

        if (ConnectionFormProvider.currentPanel) {
            ConnectionFormProvider.currentPanel.reveal(column);
            ConnectionFormProvider.currentPanel.webview.postMessage({
                cmd: 'loadProfile',
                profile: editProfile || null,
                saved,
                recent,
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlConnectionForm',
            editProfile ? `Edit: ${editProfile.name}` : 'Connect to Database',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ConnectionFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('database');
        panel.webview.html = ConnectionFormProvider.getHtml(editProfile, saved, recent);

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
                    const updatedSaved = connectionManager.getSavedProfiles();
                    panel.webview.postMessage({ cmd: 'saved', saved: updatedSaved });
                    break;
                }
                case 'saveAndConnect': {
                    await ConnectionFormProvider.saveProfile(msg.profile, msg.originalName);
                    ConnectionFormProvider.addRecent(context, msg.profile);
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
                case 'connect': {
                    // Connect without saving (from recent/sidebar click)
                    ConnectionFormProvider.addRecent(context, msg.profile);
                    try {
                        await connectionManager.connect(msg.profile);
                        treeProvider.refresh();
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
                case 'parseConnectionString': {
                    const parsed = ConnectionFormProvider.parseConnectionString(msg.connectionString);
                    panel.webview.postMessage({ cmd: 'parsedConnectionString', profile: parsed });
                    break;
                }
                case 'removeRecent': {
                    const recents = context.globalState.get<ConnectionProfile[]>('recentConnections', []);
                    const filtered = recents.filter(r =>
                        !(r.server === msg.server && r.database === msg.database && r.name === msg.name)
                    );
                    context.globalState.update('recentConnections', filtered);
                    panel.webview.postMessage({ cmd: 'updatedRecent', recent: filtered });
                    break;
                }
            }
        }, undefined, context.subscriptions);

        panel.onDidDispose(() => {
            ConnectionFormProvider.currentPanel = undefined;
        }, null, context.subscriptions);
    }

    /** Add a profile to recent connections (max 10, no duplicates) */
    private static addRecent(context: vscode.ExtensionContext, profile: ConnectionProfile): void {
        const recents = context.globalState.get<ConnectionProfile[]>('recentConnections', []);
        // Remove duplicate
        const filtered = recents.filter(r =>
            !(r.server === profile.server && r.database === profile.database && r.user === profile.user)
        );
        filtered.unshift(profile);
        if (filtered.length > 10) { filtered.length = 10; }
        context.globalState.update('recentConnections', filtered);
    }

    /** Parse a connection string into a ConnectionProfile */
    static parseConnectionString(connStr: string): Partial<ConnectionProfile> {
        const result: any = {};
        const parts = connStr.split(';').filter(Boolean);
        for (const part of parts) {
            const eqIdx = part.indexOf('=');
            if (eqIdx < 0) continue;
            const key = part.substring(0, eqIdx).trim().toLowerCase();
            const val = part.substring(eqIdx + 1).trim();
            switch (key) {
                case 'server': case 'data source': case 'host':
                    // Handle server,port format
                    if (val.includes(',')) {
                        const [srv, port] = val.split(',');
                        result.server = srv.trim();
                        result.port = parseInt(port.trim()) || 1433;
                    } else {
                        result.server = val;
                    }
                    break;
                case 'database': case 'initial catalog':
                    result.database = val;
                    break;
                case 'user id': case 'uid': case 'user':
                    result.user = val;
                    break;
                case 'password': case 'pwd':
                    result.password = val;
                    break;
                case 'trustservercertificate':
                    result.trustServerCertificate = val.toLowerCase() === 'true';
                    break;
                case 'encrypt':
                    break; // ignore for now
            }
        }
        if (result.server && !result.name) {
            result.name = result.database ? `${result.server}/${result.database}` : result.server;
        }
        return result;
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

    private static getHtml(
        editProfile?: ConnectionProfile,
        saved: ConnectionProfile[] = [],
        recent: ConnectionProfile[] = []
    ): string {
        const p = editProfile;
        const e = ConnectionFormProvider.escapeHtml;
        const isWindows = p && !p.user;

        const savedJson = JSON.stringify(saved.map(s => ({
            name: s.name, server: s.server, database: s.database,
            user: s.user, password: s.password, port: s.port,
            trustServerCertificate: s.trustServerCertificate, projectPath: s.projectPath,
        })));
        const recentJson = JSON.stringify(recent.map(r => ({
            name: r.name, server: r.server, database: r.database,
            user: r.user, password: r.password, port: r.port,
            trustServerCertificate: r.trustServerCertificate, projectPath: r.projectPath,
        })));

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Connect to Database</title>
<style>
    * { box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0; padding: 0;
        display: flex; height: 100vh;
    }
    /* --- Layout --- */
    .main { flex: 1; padding: 20px 30px; overflow-y: auto; }
    .sidebar {
        width: 280px; border-left: 1px solid var(--vscode-panel-border);
        padding: 12px; overflow-y: auto;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    /* --- Tabs --- */
    .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tab {
        padding: 8px 16px; cursor: pointer; font-size: 13px;
        border-bottom: 2px solid transparent;
        color: var(--vscode-descriptionForeground);
    }
    .tab:hover { color: var(--vscode-foreground); }
    .tab.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-focusBorder);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    /* --- Form --- */
    h2 { margin: 0 0 4px 0; font-size: 16px; }
    .subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
    .form-group { margin-bottom: 14px; }
    label {
        display: block; margin-bottom: 3px;
        font-weight: 600; font-size: 11px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase; letter-spacing: 0.5px;
    }
    input, select, textarea {
        width: 100%; padding: 6px 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px; font-size: 13px;
        font-family: var(--vscode-font-family);
    }
    textarea { min-height: 80px; resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .checkbox-group { display: flex; align-items: center; gap: 8px; }
    .checkbox-group input { width: auto; }
    .browse-group { display: flex; gap: 6px; }
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
    .button-row { display: flex; gap: 8px; margin-top: 20px; }
    .sql-fields { display: ${!p || p.user ? 'block' : 'none'}; }
    .status {
        margin-top: 10px; padding: 8px 12px; border-radius: 4px;
        display: none; font-size: 12px;
    }
    .status.success { display: block; background: var(--vscode-testing-iconPassed); color: #fff; }
    .status.error { display: block; background: var(--vscode-testing-iconFailed); color: #fff; }
    .status.info { display: block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    /* --- Sidebar --- */
    .sidebar h3 {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin: 12px 0 6px 0; display: flex; align-items: center; gap: 6px;
    }
    .sidebar h3:first-child { margin-top: 0; }
    .conn-item {
        padding: 6px 8px; border-radius: 3px; cursor: pointer;
        font-size: 12px; display: flex; align-items: center; gap: 6px;
        position: relative;
    }
    .conn-item:hover { background: var(--vscode-list-hoverBackground); }
    .conn-item .conn-name { font-weight: 600; }
    .conn-item .conn-detail { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .conn-item .conn-remove {
        position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
        opacity: 0; background: none; border: none; color: var(--vscode-foreground);
        cursor: pointer; padding: 2px 4px; font-size: 14px;
    }
    .conn-item:hover .conn-remove { opacity: 0.6; }
    .conn-item .conn-remove:hover { opacity: 1; }
    .conn-str-hint {
        color: var(--vscode-descriptionForeground); font-size: 12px;
        margin-bottom: 12px; line-height: 1.5;
    }
</style>
</head>
<body>

<div class="main">
    <h2>Connect to Database</h2>
    <div class="subtitle">Enter connection details or paste a connection string</div>

    <div class="tabs">
        <div class="tab active" onclick="switchTab('props')">Connection Properties</div>
        <div class="tab" onclick="switchTab('connstr')">Connection String</div>
    </div>

    <!-- Tab 1: Connection Properties -->
    <div class="tab-content active" id="tab-props">
        <div class="form-group">
            <label>Profile Name *</label>
            <input id="name" value="${p ? e(p.name) : ''}" placeholder="My Server" />
        </div>
        <div class="form-group">
            <label>Server *</label>
            <input id="server" value="${p ? e(p.server) : ''}" placeholder="localhost or 192.168.1.100,1433" />
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
            <label>Database</label>
            <input id="database" value="${p ? e(p.database) : ''}" placeholder="MyDatabase or &lt;default&gt;" />
        </div>
        <div class="form-group">
            <div class="checkbox-group">
                <input id="trustCert" type="checkbox" ${(!p || p.trustServerCertificate !== false) ? 'checked' : ''} />
                <label for="trustCert" style="margin:0;font-weight:normal;text-transform:none;letter-spacing:0">Trust Server Certificate</label>
            </div>
        </div>
        <div class="form-group">
            <label>Project Path</label>
            <div class="browse-group">
                <input id="projectPath" value="${p?.projectPath ? e(p.projectPath) : ''}" placeholder="Optional: SQL project folder" />
                <button class="btn-secondary" onclick="browse()">Browse</button>
            </div>
        </div>
    </div>

    <!-- Tab 2: Connection String -->
    <div class="tab-content" id="tab-connstr">
        <div class="conn-str-hint">
            Paste a connection string below. Fields will be parsed and filled automatically.<br>
            You can then edit individual fields in the Connection Properties tab.
        </div>
        <div class="form-group">
            <label>Connection String</label>
            <textarea id="connString" placeholder="Server=myserver,1433;Database=mydb;User Id=sa;Password=***;TrustServerCertificate=True"></textarea>
        </div>
        <div class="button-row">
            <button class="btn-secondary" onclick="parseConnStr()">Parse & Fill Form</button>
        </div>
    </div>

    <div class="button-row">
        <button class="btn-secondary" onclick="testConnection()">Test Connection</button>
        <button class="btn-secondary" onclick="save()">Save</button>
        <button onclick="saveAndConnect()">Save & Connect</button>
    </div>

    <div class="status" id="status"></div>
</div>

<!-- Sidebar: Saved + Recent -->
<div class="sidebar">
    <h3>Saved Connections</h3>
    <div id="savedList"></div>

    <h3>Recent Connections</h3>
    <div id="recentList"></div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    let originalName = ${p ? `'${e(p.name).replace(/'/g, "\\'")}'` : 'null'};
    let savedConns = ${savedJson};
    let recentConns = ${recentJson};

    renderSidebar();

    function switchTab(tab) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        if (tab === 'connstr') {
            document.querySelectorAll('.tab')[1].classList.add('active');
            document.getElementById('tab-connstr').classList.add('active');
        } else {
            document.querySelectorAll('.tab')[0].classList.add('active');
            document.getElementById('tab-props').classList.add('active');
        }
    }

    function toggleAuth() {
        const isSql = document.getElementById('authType').value === 'sql';
        document.getElementById('sqlFields').style.display = isSql ? 'block' : 'none';
    }

    function fillForm(profile) {
        document.getElementById('name').value = profile.name || '';
        document.getElementById('server').value = profile.server || '';
        document.getElementById('port').value = profile.port || 1433;
        document.getElementById('database').value = profile.database || '';
        document.getElementById('user').value = profile.user || '';
        document.getElementById('password').value = profile.password || '';
        document.getElementById('trustCert').checked = profile.trustServerCertificate !== false;
        document.getElementById('projectPath').value = profile.projectPath || '';
        document.getElementById('authType').value = profile.user ? 'sql' : 'windows';
        originalName = profile.name || null;
        toggleAuth();
        switchTab('props');
    }

    function clearForm() {
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
        if (!p.name || !p.server) {
            showStatus('Please fill in Profile Name and Server.', 'error');
            return null;
        }
        const isSql = document.getElementById('authType').value === 'sql';
        if (isSql && (!p.user || !p.password)) {
            showStatus('Please fill in User Name and Password.', 'error');
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

    function connectDirect(profile) {
        showStatus('Connecting...', 'info');
        vscode.postMessage({ cmd: 'connect', profile });
    }

    function browse() {
        vscode.postMessage({ cmd: 'browse' });
    }

    function parseConnStr() {
        const cs = document.getElementById('connString').value.trim();
        if (!cs) { showStatus('Please paste a connection string.', 'error'); return; }
        vscode.postMessage({ cmd: 'parseConnectionString', connectionString: cs });
    }

    function removeRecent(name, server, database) {
        vscode.postMessage({ cmd: 'removeRecent', name, server, database });
    }

    function renderSidebar() {
        const savedEl = document.getElementById('savedList');
        const recentEl = document.getElementById('recentList');

        if (savedConns.length === 0) {
            savedEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:12px;padding:4px 8px;">No saved connections</div>';
        } else {
            savedEl.innerHTML = savedConns.map((c, i) =>
                '<div class="conn-item" onclick="fillForm(savedConns[' + i + '])" title="' + esc(c.server) + '/' + esc(c.database || '') + '">' +
                '<span class="conn-name">' + esc(c.name) + '</span>' +
                '<span class="conn-detail">' + esc(c.database || '') + '</span>' +
                '</div>'
            ).join('');
        }

        if (recentConns.length === 0) {
            recentEl.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:12px;padding:4px 8px;">No recent connections</div>';
        } else {
            recentEl.innerHTML = recentConns.map((c, i) =>
                '<div class="conn-item" onclick="fillForm(recentConns[' + i + '])" title="' + esc(c.server) + '/' + esc(c.database || '') + '">' +
                '<span class="conn-name">' + esc(c.name) + '</span>' +
                '<span class="conn-detail">' + esc(c.server) + '/' + esc(c.database || '') + '</span>' +
                '<span class="conn-remove" onclick="event.stopPropagation();removeRecent(\\''+esc(c.name)+'\\',\\''+esc(c.server)+'\\',\\''+esc(c.database||'')+'\\')">×</span>' +
                '</div>'
            ).join('');
        }
    }

    function esc(s) {
        if (!s) return '';
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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
            if (msg.saved) { savedConns = msg.saved; renderSidebar(); }
        } else if (msg.cmd === 'browsed') {
            document.getElementById('projectPath').value = msg.path;
        } else if (msg.cmd === 'parsedConnectionString') {
            if (msg.profile) {
                fillForm(msg.profile);
                showStatus('Connection string parsed. Review fields and click Save or Connect.', 'success');
            }
        } else if (msg.cmd === 'updatedRecent') {
            recentConns = msg.recent || [];
            renderSidebar();
        } else if (msg.cmd === 'loadProfile') {
            if (msg.profile) {
                fillForm(msg.profile);
            } else {
                clearForm();
            }
            if (msg.saved) { savedConns = msg.saved; }
            if (msg.recent) { recentConns = msg.recent; }
            renderSidebar();
        }
    });
</script>
</body>
</html>`;
    }
}
