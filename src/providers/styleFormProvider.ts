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
            'SQL Prompt Options',
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        StyleFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('symbol-color');

        const casingOpts = styleLoader.getCasingOptions();
        const layoutOpts = styleLoader.getLayoutOptions();
        const styleName = styleLoader.getStyleName();
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const styleFile = config.get<string>('styleFile', '');
        const aliasOpts = {
            assignAliases: config.get<boolean>('aliases.assignAliases', true),
            includeAS: config.get<boolean>('aliases.includeAS', false),
            capitaliseAliases: config.get<boolean>('aliases.capitaliseAliases', false),
            prefixesToIgnore: config.get<string[]>('aliases.prefixesToIgnore', []),
        };
        const insertionKeys = config.get<any>('insertionKeys', { space: true, dot: false, parentheses: false, comma: false, bracket: false, semicolon: false });
        const snippetFolder = config.get<string>('snippetFolder', '');
        // Read connections to show count
        const connections = config.get<any[]>('connections', []);

        panel.webview.html = StyleFormProvider.getHtml(casingOpts, layoutOpts, aliasOpts, insertionKeys, styleName, styleFile, snippetFolder, connections.length);

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
                    // Alias settings
                    if (msg.aliases) {
                        await config.update('aliases.assignAliases', msg.aliases.assignAliases, vscode.ConfigurationTarget.Global);
                        await config.update('aliases.includeAS', msg.aliases.includeAS, vscode.ConfigurationTarget.Global);
                        await config.update('aliases.capitaliseAliases', msg.aliases.capitaliseAliases, vscode.ConfigurationTarget.Global);
                        await config.update('aliases.prefixesToIgnore', msg.aliases.prefixesToIgnore, vscode.ConfigurationTarget.Global);
                    }
                    // Join conditions
                    if (msg.joinConditions) {
                        await config.update('joinMatchingNames', msg.joinConditions.matchingNames, vscode.ConfigurationTarget.Global);
                        await config.update('joinSwapColumnOrder', msg.joinConditions.swapOrder, vscode.ConfigurationTarget.Global);
                    }
                    // Insertion keys
                    if (msg.insertionKeys) {
                        await config.update('insertionKeys', msg.insertionKeys, vscode.ConfigurationTarget.Global);
                    }
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
                case 'loadSnippets': {
                    const snippetDir = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
                    const snippets: { prefix: string; description: string; body: string }[] = [];
                    if (snippetDir) {
                        try {
                            const fs = await import('fs');
                            const path = await import('path');
                            const files = await fs.promises.readdir(snippetDir);
                            for (const file of files.filter(f => f.endsWith('.json')).sort()) {
                                try {
                                    const content = await fs.promises.readFile(path.join(snippetDir, file), 'utf-8');
                                    const snip = JSON.parse(content);
                                    snippets.push({
                                        prefix: snip.prefix || file.replace('.json', ''),
                                        description: snip.description || '',
                                        body: snip.body || '',
                                    });
                                } catch { /* skip invalid */ }
                            }
                        } catch { /* folder not accessible */ }
                    }
                    panel.webview.postMessage({ cmd: 'snippetsLoaded', snippets });
                    break;
                }
                case 'browseSnippetFolder': {
                    const current = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Snippet Dizini Seç',
                        defaultUri: current ? vscode.Uri.file(current) : undefined
                    });
                    if (result && result[0]) {
                        await vscode.workspace.getConfiguration('tsql-intellisense').update('snippetFolder', result[0].fsPath, vscode.ConfigurationTarget.Global);
                        panel.webview.postMessage({ cmd: 'snippetFolderSet', path: result[0].fsPath });
                        vscode.window.showInformationMessage(`Snippet dizini ayarlandı: ${result[0].fsPath}`);
                    }
                    break;
                }
                case 'exportConnections': {
                    const conns = vscode.workspace.getConfiguration('tsql-intellisense').get<any[]>('connections', []);
                    const uri = await vscode.window.showSaveDialog({
                        filters: { 'JSON': ['json'] },
                        defaultUri: vscode.Uri.file('tsql-connections.json')
                    });
                    if (uri) {
                        const fs = await import('fs');
                        await fs.promises.writeFile(uri.fsPath, JSON.stringify(conns, null, 2), 'utf-8');
                        vscode.window.showInformationMessage(`${conns.length} connection exported: ${uri.fsPath}`);
                    }
                    break;
                }
                case 'importConnections': {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'Connection JSON Seç',
                        filters: { 'JSON': ['json'] }
                    });
                    if (result && result[0]) {
                        try {
                            const fs = await import('fs');
                            const content = await fs.promises.readFile(result[0].fsPath, 'utf-8');
                            const imported = JSON.parse(content);
                            if (!Array.isArray(imported)) {
                                vscode.window.showErrorMessage('Geçersiz dosya formatı — JSON array bekleniyor.');
                                break;
                            }
                            const config = vscode.workspace.getConfiguration('tsql-intellisense');
                            const existing = config.get<any[]>('connections', []);
                            const existingNames = new Set(existing.map((c: any) => c.name));
                            const newConns = imported.filter((c: any) => !existingNames.has(c.name));
                            const merged = [...existing, ...newConns];
                            await config.update('connections', merged, vscode.ConfigurationTarget.Global);
                            vscode.window.showInformationMessage(`${newConns.length} yeni connection import edildi (${imported.length - newConns.length} duplicate atlandı).`);
                            panel.webview.postMessage({ cmd: 'connectionsUpdated', count: merged.length });
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Import hatası: ${err.message}`);
                        }
                    }
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
        aliases: { assignAliases: boolean; includeAS: boolean; capitaliseAliases: boolean; prefixesToIgnore: string[] },
        insertionKeys: { space: boolean; dot: boolean; parentheses: boolean; comma: boolean; bracket: boolean; semicolon: boolean },
        styleName: string,
        styleFile: string,
        snippetFolder: string,
        connectionCount: number
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
        .sidebar .menu-item.sub {
            padding-left: 28px;
            font-size: 12px;
        }
        .sidebar .style-subs {
            overflow: hidden;
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

        /* Snippet list */
        .snippet-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
            margin-top: 8px;
        }
        .snippet-table th {
            text-align: left;
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .snippet-table td {
            padding: 4px 8px;
            border-bottom: 1px solid var(--vscode-panel-border, transparent);
            cursor: pointer;
        }
        .snippet-table tr:hover td {
            background: var(--vscode-list-hoverBackground);
        }
        .snippet-table tr.selected td {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .snippet-list-container {
            max-height: 250px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
        }
        .snippet-code {
            margin-top: 12px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
            font-family: var(--vscode-editor-fontFamily, monospace);
            font-size: var(--vscode-editor-fontSize, 13px);
            line-height: 1.5;
            white-space: pre-wrap;
            min-height: 60px;
            max-height: 150px;
            overflow-y: auto;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>SQL Prompt Options</h1>
        <span class="style-name" id="styleName">${StyleFormProvider.escapeHtml(styleName)}</span>
    </div>

    <div class="main">
        <div class="sidebar">
            <div class="section-title">Suggestions</div>
            <div class="menu-item" onclick="showSection('behavior')">Behavior</div>
            <div class="menu-item" onclick="showSection('joinConditions')">Join conditions</div>
            <div class="menu-item" onclick="showSection('snippets')">Snippets</div>

            <div class="section-title">Inserted code</div>
            <div class="menu-item" onclick="showSection('objectsStatements')">Objects & statements</div>
            <div class="menu-item" onclick="showSection('qualification')">Qualification</div>
            <div class="menu-item" onclick="showSection('aliases')">Aliases</div>
            <div class="menu-item" onclick="showSection('specialChars')">Special characters</div>

            <div class="section-title">Format</div>
            <div class="menu-item" onclick="toggleStyleSubs()" style="font-weight:600;">Styles</div>
            <div class="style-subs">
                <div class="menu-item sub active" onclick="showSection('casing')">Casing</div>
                <div class="menu-item sub" onclick="showSection('lists')">Lists</div>
                <div class="menu-item sub disabled">Whitespace</div>
                <div class="menu-item sub disabled">Parentheses</div>
            </div>

            <div class="section-title" style="margin-top:8px">Statements</div>
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

            <div class="section-title">Queries</div>
            <div class="menu-item" onclick="showSection('history')">History</div>

            <div class="section-title">Settings</div>
            <div class="menu-item" onclick="showSection('paths')">Paths</div>
            <div class="menu-item" onclick="showSection('connections')">Connections</div>
        </div>

        <div class="content">
            <div class="content-body">
                <!-- Casing Section -->
                <!-- Behavior Section -->
                <div id="section-behavior" style="display:none">
                    <h2>Suggestions &gt; Behavior</h2>

                    <h3>Suggestions box and other popups</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="showCodeSuggestions" checked>
                        <label for="showCodeSuggestions">Show code suggestions</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showObjectDefinitions" checked>
                        <label for="showObjectDefinitions">Show object definitions</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showTooltipsObjects" checked>
                        <label for="showTooltipsObjects">Show tooltips for: Objects</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showTooltipsParameters" checked>
                        <label for="showTooltipsParameters">Show tooltips for: Parameters</label>
                    </div>

                    <h3>Insertion keys</h3>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:8px;">
                        Insert selected suggestions into your code when any of the following keys are pressed:
                    </p>
                    <div style="display:flex; flex-wrap:wrap; gap:4px 16px; margin-bottom:16px;">
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_enter" checked disabled><label for="ik_enter">Enter</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_tab" checked disabled><label for="ik_tab">Tab</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_space" ${insertionKeys.space ? 'checked' : ''}><label for="ik_space">Space bar</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_dot" ${insertionKeys.dot ? 'checked' : ''}><label for="ik_dot">Dot</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_paren" ${insertionKeys.parentheses ? 'checked' : ''}><label for="ik_paren">Parentheses</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_comma" ${insertionKeys.comma ? 'checked' : ''}><label for="ik_comma">Comma</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_bracket" ${insertionKeys.bracket ? 'checked' : ''}><label for="ik_bracket">Closing square bracket</label></div>
                        <div class="checkbox-row" style="margin:0"><input type="checkbox" id="ik_semicolon" ${insertionKeys.semicolon ? 'checked' : ''}><label for="ik_semicolon">Semicolon</label></div>
                    </div>

                    <h3>Types of suggestions</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="listColumnsAfterSelect">
                        <label for="listColumnsAfterSelect">List all database columns after a SELECT statement</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="listSystemObjects">
                        <label for="listSystemObjects">List system objects</label>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        Most suggestion behavior is controlled by VS Code's editor.suggest.* settings. These options are SQL-specific overrides.
                    </div>
                </div>

                <!-- Join Conditions Section -->
                <div id="section-joinConditions" style="display:none">
                    <h2>Suggestions &gt; Join conditions</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:16px;">
                        By default, SQL Prompt suggests joins based on foreign key relationships.
                    </p>

                    <p style="font-size:13px; margin-bottom:8px;">Also suggest join conditions based on:</p>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMatchingNames" checked>
                        <label for="joinMatchingNames">Columns with matching names (not case-sensitive)</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMatchingTypes">
                        <label for="joinMatchingTypes">Columns with matching data types</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMultiColumnFK">
                        <label for="joinMultiColumnFK">Individual columns in multiple-column foreign keys</label>
                    </div>

                    <h3>Column order</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="swapJoinColumnOrder">
                        <label for="swapJoinColumnOrder">Swap order of columns in join clauses</label>
                    </div>
                </div>

                <!-- Objects & Statements Section -->
                <div id="section-objectsStatements" style="display:none">
                    <h2>Inserted code &gt; Objects &amp; statements</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:16px;">
                        SQL Prompt can automatically complete the syntax of some statements.
                    </p>

                    <h3>ALTER statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertFullAlter" checked>
                        <label for="insertFullAlter">Insert full ALTER statement</label>
                    </div>

                    <h3>INSERT statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertFullInsert" checked>
                        <label for="insertFullInsert">Insert full INSERT statement</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="includeValuesClause" checked>
                        <label for="includeValuesClause">Include VALUES clause</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="showColumnNames" checked>
                        <label for="showColumnNames">Show column names</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="showColumnDataTypes" checked>
                        <label for="showColumnDataTypes">Show column data types</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="insertDefaultValue" checked>
                        <label for="insertDefaultValue">Insert default value for each column</label>
                    </div>

                    <h3>EXEC statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertParameters" checked>
                        <label for="insertParameters">Insert parameters for functions and stored procedures</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="insertDeclareOutput" checked>
                        <label for="insertDeclareOutput">Insert DECLARE statement for OUTPUT parameters</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="insertDefaultParamValue" checked>
                        <label for="insertDefaultParamValue">Insert default value for each parameter</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showParameterDataTypes" checked>
                        <label for="showParameterDataTypes">Show parameter data types</label>
                    </div>

                    <h3>OUTPUT clauses</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertOutputInto">
                        <label for="insertOutputInto">Insert column list for INTO clause</label>
                    </div>
                </div>

                <!-- Qualification Section -->
                <div id="section-qualification" style="display:none">
                    <h2>Inserted code &gt; Qualification</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithOwner" checked>
                        <label for="qualifyWithOwner">Qualify object names with owner name</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. dbo.Address</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithAlias" checked>
                        <label for="qualifyWithAlias">Qualify column names with aliases</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. a.AddressLine1</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithTableName">
                        <label for="qualifyWithTableName">Qualify column names with table name</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. Address.AddressLine1</span>
                    </div>

                    <div class="info-bar" style="margin-top:16px">
                        <span class="icon">ℹ</span>
                        <div>Note: In some situations, inserted object names will always be qualified, regardless of these settings:
                            <ul style="margin:8px 0 0 16px; font-size:12px;">
                                <li>When inserting an object in a non-default schema</li>
                                <li>When column names would be ambiguous without also specifying the table</li>
                                <li>When you type table.* and press TAB to expand all columns</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <!-- Snippets Section -->
                <div id="section-snippets" style="display:none">
                    <h2>Snippets</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:12px;">
                        You can use snippets to insert frequently used chunks of code into your query.
                    </p>

                    <div class="form-row">
                        <label>Snippet folder:</label>
                        <div style="display:flex; gap:8px; align-items:center; flex:1;">
                            <input type="text" id="snippetFolderSnippets" value="${StyleFormProvider.escapeHtml(snippetFolder)}" readonly
                                style="flex:1; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;" />
                            <button class="btn btn-secondary" onclick="browseSnippetFolder()">...</button>
                        </div>
                    </div>

                    <div class="snippet-list-container">
                        <table class="snippet-table">
                            <thead><tr><th>Snippet</th><th>Description</th></tr></thead>
                            <tbody id="snippetListBody">
                                <tr><td colspan="2" style="color:var(--vscode-descriptionForeground); text-align:center; padding:16px;">Loading snippets...</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div style="margin-top:4px; font-size:11px; color:var(--vscode-descriptionForeground);" id="snippetCountLabel"></div>

                    <h3>Code</h3>
                    <div class="snippet-code" id="snippetCodePreview" style="color:var(--vscode-descriptionForeground);">Select a snippet to preview</div>
                </div>

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

                <!-- Aliases Section -->
                <div id="section-aliases" style="display:none">
                    <h2>Aliases</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="assignAliases" ${aliases.assignAliases ? 'checked' : ''}>
                        <label for="assignAliases">Assign aliases</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="includeAS" ${aliases.includeAS ? 'checked' : ''}>
                        <label for="includeAS">Include AS in alias definition</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="capitaliseAliases" ${aliases.capitaliseAliases ? 'checked' : ''}>
                        <label for="capitaliseAliases">Capitalise aliases</label>
                    </div>

                    <h3>Prefixes to ignore</h3>
                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        When generating an alias from a table name, ignore these prefixes.
                    </div>

                    <div style="margin:8px 0; display:flex; gap:8px; align-items:flex-start;">
                        <textarea id="prefixesToIgnore" rows="6"
                            style="width:300px; padding:8px; font-size:13px; font-family:var(--vscode-editor-fontFamily, monospace); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none; resize:vertical;"
                            placeholder="One prefix per line, e.g.&#10;Cv_Rn&#10;Tb_Rn&#10;Tmp_Rn">${aliases.prefixesToIgnore.join('\n')}</textarea>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); padding-top:8px;">One prefix per line</span>
                    </div>
                </div>

                <!-- Special Characters Section -->
                <div id="section-specialChars" style="display:none">
                    <h2>Special characters</h2>

                    <h3>Brackets</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="encloseInBrackets">
                        <label for="encloseInBrackets">Enclose identifiers within square brackets [ ]</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="addParentheses" checked>
                        <label for="addParentheses">Add parentheses ( ) when inserting a function or data type</label>
                    </div>

                    <h3>Closing characters</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="removeDuplicateClosing" checked>
                        <label for="removeDuplicateClosing">Remove duplicate closing characters as you type</label>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        Auto-closing for quotes, parentheses and brackets is handled by VS Code's built-in settings (editor.autoClosingBrackets, editor.autoClosingQuotes).
                    </div>
                </div>

                <!-- History Section -->
                <div id="section-history" style="display:none">
                    <h2>Queries &gt; History</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="enableSqlHistory" checked>
                        <label for="enableSqlHistory">Enable SQL History</label>
                    </div>

                    <h3>Query size</h3>
                    <div class="form-row">
                        <label>Maximum query size:</label>
                        <select id="maxQuerySize" style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="256">256 KB</option>
                            <option value="512">512 KB</option>
                            <option value="1024" selected>1 MB</option>
                            <option value="2048">2 MB</option>
                            <option value="5120">5 MB</option>
                        </select>
                    </div>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:196px;">
                        Queries larger than the maximum size won't be stored in the history
                    </p>

                    <h3>Open queries</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="restoreOpenQueries" checked>
                        <label for="restoreOpenQueries">Restore open queries when VS Code starts</label>
                    </div>
                    <div class="form-row" style="margin-left:24px">
                        <label>Maximum number of queries to restore:</label>
                        <input type="number" id="maxQueriesToRestore" value="20" min="1" max="100"
                            style="width:70px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                    </div>

                    <h3>Clear SQL History</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="autoRemoveOldQueries" checked>
                        <label for="autoRemoveOldQueries">Automatically remove queries older than</label>
                        <input type="number" id="historyRetentionDays" value="7" min="1" max="365"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:13px;">days</span>
                    </div>
                </div>

                <!-- Paths Section -->
                <div id="section-paths" style="display:none">
                    <h2>Paths</h2>

                    <div class="form-row">
                        <label>Snippet folder:</label>
                        <div style="display:flex; gap:8px; align-items:center; flex:1;">
                            <input type="text" id="snippetFolder" value="${StyleFormProvider.escapeHtml(snippetFolder)}" readonly
                                style="flex:1; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;" />
                            <button class="btn btn-secondary" onclick="browseSnippetFolder()">Browse...</button>
                        </div>
                    </div>

                    <div class="form-row">
                        <label>Style file:</label>
                        <div style="display:flex; gap:8px; align-items:center; flex:1;">
                            <input type="text" id="styleFilePath" value="${StyleFormProvider.escapeHtml(styleFile)}" readonly
                                style="flex:1; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;" />
                            <button class="btn btn-secondary" onclick="loadFile()">Browse...</button>
                        </div>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        Snippet folder: Redgate SQL Prompt snippet JSON dosyaları. Style file: Redgate formatlama stili (.json).
                    </div>
                </div>

                <!-- Connections Section -->
                <div id="section-connections" style="display:none">
                    <h2>Connections</h2>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        ${connectionCount} connection profile kayıtlı.
                    </div>

                    <h3>Import connections</h3>
                    <p style="font-size:13px; margin-bottom:12px; color:var(--vscode-descriptionForeground);">
                        Başka bir makinedeki bağlantı ayarlarını JSON dosyasından içe aktarın.
                    </p>

                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-secondary" onclick="importConnections()">Import from JSON...</button>
                        <button class="btn btn-secondary" onclick="exportConnections()">Export to JSON...</button>
                    </div>
                </div>
            </div>

            <div class="preview" id="formatPreview">
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
            const prefixText = document.getElementById('prefixesToIgnore').value.trim();
            const prefixes = prefixText ? prefixText.split('\\n').map(s => s.trim()).filter(s => s) : [];
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
                aliases: {
                    assignAliases: document.getElementById('assignAliases').checked,
                    includeAS: document.getElementById('includeAS').checked,
                    capitaliseAliases: document.getElementById('capitaliseAliases').checked,
                    prefixesToIgnore: prefixes,
                },
                joinConditions: {
                    matchingNames: document.getElementById('joinMatchingNames').checked,
                    swapOrder: document.getElementById('swapJoinColumnOrder').checked,
                },
                insertionKeys: {
                    space: document.getElementById('ik_space').checked,
                    dot: document.getElementById('ik_dot').checked,
                    parentheses: document.getElementById('ik_paren').checked,
                    comma: document.getElementById('ik_comma').checked,
                    bracket: document.getElementById('ik_bracket').checked,
                    semicolon: document.getElementById('ik_semicolon').checked,
                },
            });
        }

        function loadFile() {
            vscode.postMessage({ cmd: 'loadFile' });
        }

        function selectSnippet(index) {
            document.querySelectorAll('.snippet-table tr.selected').forEach(el => el.classList.remove('selected'));
            const row = document.getElementById('snip-' + index);
            if (row) row.classList.add('selected');
            const s = window._snippets && window._snippets[index];
            const preview = document.getElementById('snippetCodePreview');
            if (s && s.body) {
                preview.textContent = s.body;
                preview.style.color = '';
            } else {
                preview.textContent = 'No code';
                preview.style.color = 'var(--vscode-descriptionForeground)';
            }
        }

        function browseSnippetFolder() {
            vscode.postMessage({ cmd: 'browseSnippetFolder' });
        }

        function importConnections() {
            vscode.postMessage({ cmd: 'importConnections' });
        }

        function exportConnections() {
            vscode.postMessage({ cmd: 'exportConnections' });
        }

        function reset() {
            vscode.postMessage({ cmd: 'reset' });
        }

        let snippetsLoaded = false;

        function showSection(name) {
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            event.target.classList.add('active');
            document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
            const sec = document.getElementById('section-' + name);
            if (sec) sec.style.display = '';
            // Show format preview only for style sections
            const formatPreview = document.getElementById('formatPreview');
            formatPreview.style.display = (name === 'casing' || name === 'lists') ? '' : 'none';
            updatePreview();
            if (name === 'snippets' && !snippetsLoaded) {
                vscode.postMessage({ cmd: 'loadSnippets' });
                snippetsLoaded = true;
            }
        }

        function toggleStyleSubs() {
            const subs = document.querySelector('.style-subs');
            if (subs.style.display === 'none') {
                subs.style.display = '';
            } else {
                subs.style.display = 'none';
            }
        }

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.cmd === 'saved') {
                // Visual feedback handled by VS Code notification
            } else if (msg.cmd === 'snippetsLoaded') {
                const tbody = document.getElementById('snippetListBody');
                if (msg.snippets.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="2" style="color:var(--vscode-descriptionForeground); text-align:center; padding:16px;">No snippets found. Set a snippet folder first.</td></tr>';
                } else {
                    tbody.innerHTML = msg.snippets.map((s, i) =>
                        '<tr onclick="selectSnippet(' + i + ')" id="snip-' + i + '"><td>' + escapeHtml(s.prefix) + '</td><td>' + escapeHtml(s.description || '') + '</td></tr>'
                    ).join('');
                }
                document.getElementById('snippetCountLabel').textContent = msg.snippets.length + ' snippets';
                window._snippets = msg.snippets;
            } else if (msg.cmd === 'snippetFolderSet') {
                document.getElementById('snippetFolder').value = msg.path;
                document.getElementById('snippetFolderSnippets').value = msg.path;
                snippetsLoaded = false;
                vscode.postMessage({ cmd: 'loadSnippets' });
                snippetsLoaded = true;
            } else if (msg.cmd === 'connectionsUpdated') {
                document.querySelector('#section-connections .info-bar').innerHTML =
                    '<span class="icon">ℹ</span> ' + msg.count + ' connection profile kayıtlı.';
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
