import * as vscode from 'vscode';
import { StyleLoader } from '../formatter/styleLoader';
import { CasingMode } from '../formatter/casingRule';

export class StyleFormProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    static show(
        context: vscode.ExtensionContext,
        styleLoader: StyleLoader
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (StyleFormProvider.currentPanel) {
            StyleFormProvider.currentPanel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlStyleForm',
            'Formatting Styles',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        StyleFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('symbol-color');

        const casingOpts = styleLoader.getCasingOptions();
        const layoutOpts = styleLoader.getLayoutOptions();
        const styleName = styleLoader.getStyleName();
        const styleFile = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('styleFile', '');

        panel.webview.html = StyleFormProvider.getHtml(casingOpts, layoutOpts, styleName, styleFile);

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {
                case 'save': {
                    const config = vscode.workspace.getConfiguration('tsql-intellisense');
                    const overrides = { ...msg.casing, lists: msg.lists };
                    await config.update('styleOverrides', overrides, vscode.ConfigurationTarget.Global);
                    if (msg.maxLineLength !== undefined) {
                        await config.update('maxLineLength', msg.maxLineLength, vscode.ConfigurationTarget.Global);
                        styleLoader.setMaxLineLength(msg.maxLineLength);
                    }
                    styleLoader.applyOverrides(overrides);
                    panel.webview.postMessage({ cmd: 'saved' });
                    vscode.window.showInformationMessage(`Stil ayarları kaydedildi`);
                    break;
                }
                case 'loadFile': {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Stil Dosyası Seç',
                        filters: { 'JSON Style': ['json'] },
                        defaultUri: styleFile ? vscode.Uri.file(styleFile) : undefined
                    });
                    if (result && result[0]) {
                        const filePath = result[0].fsPath;
                        await vscode.workspace.getConfiguration('tsql-intellisense').update('styleFile', filePath, vscode.ConfigurationTarget.Global);
                        await styleLoader.loadFromFile(filePath);
                        const newCasing = styleLoader.getCasingOptions();
                        const newLayout = styleLoader.getLayoutOptions();
                        const newName = styleLoader.getStyleName();
                        panel.webview.postMessage({
                            cmd: 'styleLoaded',
                            casing: newCasing,
                            layout: newLayout,
                            styleName: newName,
                            styleFile: filePath
                        });
                    }
                    break;
                }
                case 'reset': {
                    const config = vscode.workspace.getConfiguration('tsql-intellisense');
                    await config.update('styleOverrides', undefined, vscode.ConfigurationTarget.Global);
                    await config.update('styleFile', '', vscode.ConfigurationTarget.Global);
                    await config.update('maxLineLength', 120, vscode.ConfigurationTarget.Global);
                    styleLoader.setMaxLineLength(120);
                    await styleLoader.loadFromFile('');
                    panel.webview.postMessage({
                        cmd: 'styleLoaded',
                        casing: styleLoader.getCasingOptions(),
                        layout: styleLoader.getLayoutOptions(),
                        styleName: 'RENIUMSTYLE (default)',
                        styleFile: ''
                    });
                    break;
                }
            }
        });

        panel.onDidDispose(() => {
            StyleFormProvider.currentPanel = undefined;
        }, null, context.subscriptions);
    }

    private static getHtml(
        options: { reservedKeywords: CasingMode; builtInFunctions: CasingMode; builtInDataTypes: CasingMode },
        layout: { maxLineLength: number; placeCommasBeforeItems: boolean; alignItemsToTabStops: boolean },
        styleName: string,
        styleFile: string
    ): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <title>Formatting Styles</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        /* Header */
        .header {
            padding: 16px 24px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
        }
        .header .style-name {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
        }

        /* Main layout */
        .main {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        /* Sidebar */
        .sidebar {
            width: 180px;
            border-right: 1px solid var(--vscode-panel-border);
            padding: 12px 0;
            overflow-y: auto;
        }
        .sidebar .section-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            padding: 8px 16px 4px;
            letter-spacing: 0.5px;
        }
        .sidebar .menu-item {
            padding: 6px 16px;
            cursor: pointer;
            font-size: 13px;
            border-left: 3px solid transparent;
        }
        .sidebar .menu-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .sidebar .menu-item.active {
            border-left-color: var(--vscode-focusBorder);
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .sidebar .menu-item.disabled {
            color: var(--vscode-disabledForeground);
            cursor: default;
        }

        /* Content */
        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .content-body {
            flex: 1;
            padding: 24px 32px;
            overflow-y: auto;
        }
        .content-body h2 {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 20px;
        }
        .content-body h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 20px 0 12px;
        }

        /* Form */
        .form-row {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            gap: 16px;
        }
        .form-row label {
            width: 180px;
            font-size: 13px;
            text-align: right;
            flex-shrink: 0;
        }
        .form-row select {
            width: 220px;
            padding: 5px 8px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
        }
        .form-row select:focus {
            border-color: var(--vscode-focusBorder);
        }

        .info-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            margin: 16px 0;
            background: var(--vscode-editorWidget-background);
            border-left: 3px solid var(--vscode-focusBorder);
            border-radius: 2px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .info-bar .icon { font-size: 14px; }

        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 12px 0 12px 196px;
        }
        .checkbox-row input[type="checkbox"] {
            accent-color: var(--vscode-focusBorder);
        }
        .checkbox-row label {
            font-size: 13px;
            cursor: pointer;
        }

        /* Preview */
        .preview {
            border-top: 1px solid var(--vscode-panel-border);
            max-height: 200px;
            overflow-y: auto;
        }
        .preview pre {
            padding: 12px 16px;
            font-family: var(--vscode-editor-fontFamily, 'Consolas', monospace);
            font-size: var(--vscode-editor-fontSize, 13px);
            line-height: 1.5;
            white-space: pre;
            margin: 0;
        }
        .preview .kw { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
        .preview .fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
        .preview .dt { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); }
        .preview .sv { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }
        .preview .cm { color: var(--vscode-editorLineNumber-foreground, #6a9955); }

        /* Footer */
        .footer {
            padding: 12px 24px;
            border-top: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .footer .spacer { flex: 1; }
        .btn {
            padding: 6px 16px;
            font-size: 13px;
            font-family: var(--vscode-font-family);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            outline: none;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .btn-link {
            background: none;
            color: var(--vscode-textLink-foreground);
            text-decoration: underline;
            padding: 6px 8px;
        }
        .btn-link:hover {
            color: var(--vscode-textLink-activeForeground);
        }

        .file-info {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 4px 0;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Formatting Styles</h1>
        <span class="style-name" id="styleName">${StyleFormProvider.escapeHtml(styleName)}</span>
    </div>

    <div class="main">
        <div class="sidebar">
            <div class="section-title">Global</div>
            <div class="menu-item disabled">Whitespace</div>
            <div class="menu-item" onclick="showSection('lists')">Lists</div>
            <div class="menu-item disabled">Parentheses</div>
            <div class="menu-item active" onclick="showSection('casing')">Casing</div>

            <div class="section-title">Statements</div>
            <div class="menu-item disabled">Data (DML)</div>
            <div class="menu-item disabled">Schema (DDL)</div>
            <div class="menu-item disabled">Control flow</div>
            <div class="menu-item disabled">CTE</div>
            <div class="menu-item disabled">Variables</div>

            <div class="section-title">Clauses</div>
            <div class="menu-item disabled">JOIN</div>
            <div class="menu-item disabled">INSERT</div>

            <div class="section-title">Expressions</div>
            <div class="menu-item disabled">Function calls</div>
            <div class="menu-item disabled">CASE</div>
            <div class="menu-item disabled">IN</div>
            <div class="menu-item disabled">Operators</div>
        </div>

        <div class="content">
            <div class="content-body">
                <!-- Casing Section -->
                <div id="section-casing">
                    <h2>Casing</h2>

                    <h3>Built-in keywords, functions and types</h3>

                    <div class="form-row">
                        <label>Reserved keywords:</label>
                        <select id="reservedKeywords" onchange="updatePreview()">
                            <option value="upperCamelCase" ${options.reservedKeywords === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="uppercase" ${options.reservedKeywords === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="lowercase" ${options.reservedKeywords === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.reservedKeywords === 'leaveAsIs' ? 'selected' : ''}>Leave as is</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label>Built-in functions:</label>
                        <select id="builtInFunctions" onchange="updatePreview()">
                            <option value="uppercase" ${options.builtInFunctions === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="upperCamelCase" ${options.builtInFunctions === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="lowercase" ${options.builtInFunctions === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.builtInFunctions === 'leaveAsIs' ? 'selected' : ''}>Leave as is</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label>Built-in data types:</label>
                        <select id="builtInDataTypes" onchange="updatePreview()">
                            <option value="upperCamelCase" ${options.builtInDataTypes === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="uppercase" ${options.builtInDataTypes === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="lowercase" ${options.builtInDataTypes === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.builtInDataTypes === 'leaveAsIs' ? 'selected' : ''}>Leave as is</option>
                        </select>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        These options will also format your code when you use Format SQL (Ctrl+K Y).
                    </div>

                    <h3>User-defined objects</h3>
                    <div class="checkbox-row">
                        <input type="checkbox" id="useObjectDefinitionCase" checked disabled>
                        <label for="useObjectDefinitionCase">Use object definition case</label>
                    </div>
                </div>

                <!-- Lists Section -->
                <div id="section-lists" style="display:none">
                    <h2>Lists</h2>

                    <div class="form-row">
                        <label>Max line length:</label>
                        <input type="number" id="maxLineLength" value="${layout.maxLineLength}" min="0" max="500"
                            style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;"
                            onchange="updatePreview()" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)">0 = no wrap</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="placeCommasBeforeItems" ${layout.placeCommasBeforeItems ? 'checked' : ''} onchange="updatePreview()">
                        <label for="placeCommasBeforeItems">Place commas before items</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="alignItemsToTabStops" ${layout.alignItemsToTabStops ? 'checked' : ''} onchange="updatePreview()">
                        <label for="alignItemsToTabStops">Align items to tab stops (clause padding)</label>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        These options affect SELECT column list formatting.
                    </div>
                </div>
            </div>

            <div class="preview">
                <pre id="previewCode"></pre>
            </div>
        </div>
    </div>

    <div class="footer">
        <button class="btn btn-link" onclick="loadFile()">Load from file...</button>
        <span class="file-info" id="fileInfo">${styleFile ? StyleFormProvider.escapeHtml(styleFile) : 'No file — using defaults'}</span>
        <span class="spacer"></span>
        <button class="btn btn-primary" onclick="save()">Save</button>
        <button class="btn btn-secondary" onclick="reset()">Reset</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const sampleCode = [
            { type: 'kw', text: 'Declare' }, { type: '', text: ' @dateOnly ' }, { type: 'dt', text: 'DateTime' },
            { type: '', text: '\\n\\n' },
            { type: 'kw', text: 'Set' }, { type: '', text: ' @dateOnly = ' },
            { type: 'fn', text: 'CAST' }, { type: '', text: '(' },
            { type: 'fn', text: 'FLOOR' }, { type: '', text: '(' },
            { type: 'fn', text: 'CAST' }, { type: '', text: '(' },
            { type: 'fn', text: 'GETDATE' }, { type: '', text: '() ' },
            { type: 'kw', text: 'As' }, { type: '', text: ' ' }, { type: 'dt', text: 'Float' },
            { type: '', text: ')) ' },
            { type: 'kw', text: 'As' }, { type: '', text: ' ' }, { type: 'dt', text: 'DateTime' },
            { type: '', text: ')' },
            { type: '', text: '\\n\\n' },
            { type: 'kw', text: 'Select' }, { type: '', text: '  ' },
            { type: 'sv', text: '@@ROWCOUNT' },
        ];

        function applyCasing(text, mode) {
            switch (mode) {
                case 'uppercase': return text.toUpperCase();
                case 'lowercase': return text.toLowerCase();
                case 'upperCamelCase': return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
                case 'leaveAsIs': return text;
                default: return text;
            }
        }

        function updatePreview() {
            const kwMode = document.getElementById('reservedKeywords').value;
            const fnMode = document.getElementById('builtInFunctions').value;
            const dtMode = document.getElementById('builtInDataTypes').value;

            let html = '';
            for (const part of sampleCode) {
                let text = part.text.replace(/\\\\n/g, '\\n');
                if (part.type === 'kw') {
                    text = applyCasing(text, kwMode);
                    html += '<span class="kw">' + escapeHtml(text) + '</span>';
                } else if (part.type === 'fn') {
                    text = applyCasing(text, fnMode);
                    html += '<span class="fn">' + escapeHtml(text) + '</span>';
                } else if (part.type === 'dt') {
                    text = applyCasing(text, dtMode);
                    html += '<span class="dt">' + escapeHtml(text) + '</span>';
                } else if (part.type === 'sv') {
                    text = applyCasing(text, fnMode);
                    html += '<span class="sv">' + escapeHtml(text) + '</span>';
                } else {
                    html += escapeHtml(text);
                }
            }
            document.getElementById('previewCode').innerHTML = html;
        }

        function escapeHtml(str) {
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function save() {
            vscode.postMessage({
                cmd: 'save',
                casing: {
                    reservedKeywords: document.getElementById('reservedKeywords').value,
                    builtInFunctions: document.getElementById('builtInFunctions').value,
                    builtInDataTypes: document.getElementById('builtInDataTypes').value,
                },
                lists: {
                    placeCommasBeforeItems: document.getElementById('placeCommasBeforeItems').checked,
                    alignItemsToTabStops: document.getElementById('alignItemsToTabStops').checked,
                },
                maxLineLength: parseInt(document.getElementById('maxLineLength').value) || 0,
            });
        }

        function loadFile() {
            vscode.postMessage({ cmd: 'loadFile' });
        }

        function reset() {
            vscode.postMessage({ cmd: 'reset' });
        }

        function showSection(name) {
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            event.target.classList.add('active');
            document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
            const sec = document.getElementById('section-' + name);
            if (sec) sec.style.display = '';
        }

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.cmd === 'saved') {
                // Visual feedback handled by VS Code notification
            } else if (msg.cmd === 'styleLoaded') {
                document.getElementById('reservedKeywords').value = msg.casing.reservedKeywords;
                document.getElementById('builtInFunctions').value = msg.casing.builtInFunctions;
                document.getElementById('builtInDataTypes').value = msg.casing.builtInDataTypes;
                if (msg.layout) {
                    document.getElementById('maxLineLength').value = msg.layout.maxLineLength;
                    document.getElementById('placeCommasBeforeItems').checked = msg.layout.placeCommasBeforeItems;
                    document.getElementById('alignItemsToTabStops').checked = msg.layout.alignItemsToTabStops;
                }
                document.getElementById('styleName').textContent = msg.styleName;
                document.getElementById('fileInfo').textContent = msg.styleFile || 'No file — using defaults';
                updatePreview();
            }
        });

        // Initial preview
        updatePreview();
    </script>
</body>
</html>`;
    }

    private static escapeHtml(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
