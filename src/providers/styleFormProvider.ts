import * as vscode from 'vscode';
import { StyleLoader } from '../formatter/styleLoader';
import { CasingMode } from '../formatter/casingRule';
import { styleFormTranslations } from './styleFormTranslations';

export class StyleFormProvider {
    private static currentPanel: vscode.WebviewPanel | undefined;

    static postMessage(msg: any): void {
        if (StyleFormProvider.currentPanel) {
            StyleFormProvider.currentPanel.webview.postMessage(msg);
        }
    }

    static show(
        context: vscode.ExtensionContext,
        styleLoader: StyleLoader,
        initialSection?: string,
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        if (StyleFormProvider.currentPanel) {
            StyleFormProvider.currentPanel.reveal(column);
            if (initialSection) {
                StyleFormProvider.currentPanel.webview.postMessage({ cmd: 'navigateSection', section: initialSection });
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tsqlStyleForm',
            'Settings',
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'monaco-editor', 'min'), vscode.Uri.joinPath(context.extensionUri, 'resources')] }
        );

        StyleFormProvider.currentPanel = panel;
        panel.iconPath = new vscode.ThemeIcon('settings-gear');

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
        const queryShortcuts = config.get<{ key: string; query: string }[]>('queryShortcuts', []);
        const lang = context.globalState.get<string>('tsql.uiLang', 'en');
        const customTranslations = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
        const fmtConfig = {
            whitespace: styleLoader.getWhitespaceOptions(),
            controlFlow: styleLoader.getControlFlowOptions(),
            variables: styleLoader.getVariablesOptions(),
            dataDml: styleLoader.getDataDmlOptions(),
            schemaDdl: styleLoader.getSchemaDdlOptions(),
        };

        panel.webview.html = StyleFormProvider.getHtml(panel.webview, context.extensionUri, casingOpts, layoutOpts, aliasOpts, insertionKeys, styleName, styleFile, snippetFolder, connections.length, queryShortcuts, lang, customTranslations, fmtConfig);

        // Navigate to initial section after webview is ready
        if (initialSection) {
            setTimeout(() => {
                panel.webview.postMessage({ cmd: 'navigateSection', section: initialSection });
            }, 500);
        }

        panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.cmd) {
                case 'save': {
                    const config = vscode.workspace.getConfiguration('tsql-intellisense');
                    const overrides: any = { ...msg.casing, lists: msg.lists, caseExpressions: msg.caseExpressions };
                    if (msg.whitespace) overrides.whitespace = msg.whitespace;
                    if (msg.controlFlow) overrides.controlFlow = msg.controlFlow;
                    if (msg.variables) overrides.variables = msg.variables;
                    if (msg.dataDml) overrides.dataDml = msg.dataDml;
                    if (msg.schemaDdl) overrides.schemaDdl = msg.schemaDdl;
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
                    // VS Code word suggestions for SQL
                    if (msg.disableWordSuggestions !== undefined) {
                        const langConfig = vscode.workspace.getConfiguration('', { languageId: 'sql' });
                        if (msg.disableWordSuggestions) {
                            await langConfig.update('editor.wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global, true);
                            await langConfig.update('editor.suggest.showWords', false, vscode.ConfigurationTarget.Global, true);
                        } else {
                            await langConfig.update('editor.wordBasedSuggestions', undefined, vscode.ConfigurationTarget.Global, true);
                            await langConfig.update('editor.suggest.showWords', undefined, vscode.ConfigurationTarget.Global, true);
                        }
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
                    // Query shortcuts
                    if (msg.queryShortcuts) {
                        await config.update('queryShortcuts', msg.queryShortcuts, vscode.ConfigurationTarget.Global);
                    }
                    panel.webview.postMessage({ cmd: 'saved' });
                    const uiLang = context.globalState.get<string>('tsql.uiLang', 'en');
                    vscode.window.showInformationMessage(uiLang === 'tr' ? 'Ayarlar kaydedildi' : 'Settings saved');
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
                case 'createSnippet': {
                    const fs2 = await import('fs');
                    const path2 = await import('path');
                    const folder2 = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
                    if (!folder2) {
                        panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Snippet klasörü ayarlanmamış.' });
                        break;
                    }
                    const filePath2 = path2.join(folder2, msg.prefix + '.json');
                    try { await fs2.promises.access(filePath2); panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Bu prefix zaten mevcut.' }); break; } catch { /* OK */ }
                    try {
                        await fs2.promises.writeFile(filePath2, JSON.stringify({ prefix: msg.prefix, description: msg.description || undefined, body: msg.body }, null, 2), 'utf-8');
                        // Reload snippets
                        const snippets2: { prefix: string; description: string; body: string }[] = [];
                        const files2 = await fs2.promises.readdir(folder2);
                        for (const file of files2.filter(f => f.endsWith('.json')).sort()) {
                            try { const c = await fs2.promises.readFile(path2.join(folder2, file), 'utf-8'); const sn = JSON.parse(c); snippets2.push({ prefix: sn.prefix || file.replace('.json',''), description: sn.description || '', body: sn.body || '' }); } catch {}
                        }
                        panel.webview.postMessage({ cmd: 'snippetsLoaded', snippets: snippets2 });
                        panel.webview.postMessage({ cmd: 'snippetSaved', success: true });
                    } catch (err: any) {
                        panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: err.message });
                    }
                    break;
                }
                case 'updateSnippet': {
                    const fs3 = await import('fs');
                    const path3 = await import('path');
                    const folder3 = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
                    if (!folder3) { panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Snippet klasörü ayarlanmamış.' }); break; }
                    if (msg.originalPrefix !== msg.prefix) {
                        const np = path3.join(folder3, msg.prefix + '.json');
                        try { await fs3.promises.access(np); panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: 'Bu prefix zaten mevcut.' }); break; } catch { /* OK */ }
                    }
                    try {
                        await fs3.promises.unlink(path3.join(folder3, msg.originalPrefix + '.json'));
                        await fs3.promises.writeFile(path3.join(folder3, msg.prefix + '.json'), JSON.stringify({ prefix: msg.prefix, description: msg.description || undefined, body: msg.body }, null, 2), 'utf-8');
                        const snippets3: { prefix: string; description: string; body: string }[] = [];
                        const files3 = await fs3.promises.readdir(folder3);
                        for (const file of files3.filter(f => f.endsWith('.json')).sort()) {
                            try { const c = await fs3.promises.readFile(path3.join(folder3, file), 'utf-8'); const sn = JSON.parse(c); snippets3.push({ prefix: sn.prefix || file.replace('.json',''), description: sn.description || '', body: sn.body || '' }); } catch {}
                        }
                        panel.webview.postMessage({ cmd: 'snippetsLoaded', snippets: snippets3 });
                        panel.webview.postMessage({ cmd: 'snippetSaved', success: true });
                    } catch (err: any) {
                        panel.webview.postMessage({ cmd: 'snippetSaved', success: false, error: err.message });
                    }
                    break;
                }
                case 'deleteSnippet': {
                    const fs4 = await import('fs');
                    const path4 = await import('path');
                    const folder4 = vscode.workspace.getConfiguration('tsql-intellisense').get<string>('snippetFolder', '');
                    if (!folder4) break;
                    const answer = await vscode.window.showWarningMessage(
                        "'" + msg.prefix + "' snippet'ini silmek istediğinize emin misiniz?",
                        { modal: true }, 'Sil');
                    if (answer !== 'Sil') { panel.webview.postMessage({ cmd: 'snippetDeleted', success: false }); break; }
                    try {
                        await fs4.promises.unlink(path4.join(folder4, msg.prefix + '.json'));
                        const snippets4: { prefix: string; description: string; body: string }[] = [];
                        const files4 = await fs4.promises.readdir(folder4);
                        for (const file of files4.filter(f => f.endsWith('.json')).sort()) {
                            try { const c = await fs4.promises.readFile(path4.join(folder4, file), 'utf-8'); const sn = JSON.parse(c); snippets4.push({ prefix: sn.prefix || file.replace('.json',''), description: sn.description || '', body: sn.body || '' }); } catch {}
                        }
                        panel.webview.postMessage({ cmd: 'snippetsLoaded', snippets: snippets4 });
                        panel.webview.postMessage({ cmd: 'snippetDeleted', success: true });
                    } catch (err: any) {
                        panel.webview.postMessage({ cmd: 'snippetDeleted', success: false, error: err.message });
                    }
                    break;
                }
                case 'setLang': {
                    await context.globalState.update('tsql.uiLang', msg.lang);
                    break;
                }
                case 'openTranslationEditor': {
                    const { TranslationEditor } = await import('./translationEditor');
                    TranslationEditor.show(context);
                    break;
                }
                case 'saveCustomLang': {
                    const all = context.globalState.get<Record<string, Record<string, string>>>('tsql.customTranslations', {});
                    all[msg.langCode] = msg.translations;
                    await context.globalState.update('tsql.customTranslations', all);
                    const uiLang = context.globalState.get<string>('tsql.uiLang', 'en');
                    vscode.window.showInformationMessage(
                        uiLang === 'tr'
                            ? `"${msg.langCode}" dili kaydedildi (${Object.keys(msg.translations).length} çeviri).`
                            : `Language "${msg.langCode}" saved (${Object.keys(msg.translations).length} translations).`
                    );
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
                case 'webviewReady':
                case 'refreshSqlFiles': {
                    const pathMod = await import('path');
                    const sqlFiles: { path: string; fileName: string; content: string }[] = [];
                    const seen = new Set<string>();
                    // Collect all open SQL-related editor tabs
                    for (const doc of vscode.workspace.textDocuments) {
                        const isSqlLang = doc.languageId === 'sql' || doc.languageId === 'mssql' || doc.languageId === 'tsql';
                        const isSqlFile = doc.uri.fsPath?.toLowerCase().endsWith('.sql');
                        if (doc.isClosed) continue;
                        if (isSqlLang || isSqlFile) {
                            const key = doc.uri.toString();
                            if (seen.has(key)) continue;
                            seen.add(key);
                            if (doc.isUntitled) {
                                const name = doc.uri.path.split('/').pop() || 'Untitled';
                                sqlFiles.push({
                                    path: '__untitled__' + key,
                                    fileName: name,
                                    content: doc.getText()
                                });
                            } else if (doc.uri.scheme === 'file') {
                                sqlFiles.push({
                                    path: doc.uri.fsPath,
                                    fileName: pathMod.basename(doc.uri.fsPath),
                                    content: doc.getText()
                                });
                            }
                        }
                    }
                    // Also check visible editors (tabs) that might not be in textDocuments
                    for (const editor of vscode.window.visibleTextEditors) {
                        const doc = editor.document;
                        const key = doc.uri.toString();
                        if (seen.has(key)) continue;
                        const isSqlLang = doc.languageId === 'sql' || doc.languageId === 'mssql' || doc.languageId === 'tsql';
                        const isSqlFile = doc.uri.fsPath?.toLowerCase().endsWith('.sql');
                        if (isSqlLang || isSqlFile) {
                            seen.add(key);
                            if (doc.isUntitled) {
                                sqlFiles.push({
                                    path: '__untitled__' + key,
                                    fileName: doc.uri.path.split('/').pop() || 'Untitled',
                                    content: doc.getText()
                                });
                            } else if (doc.uri.scheme === 'file') {
                                sqlFiles.push({
                                    path: doc.uri.fsPath,
                                    fileName: pathMod.basename(doc.uri.fsPath),
                                    content: doc.getText()
                                });
                            }
                        }
                    }
                    panel.webview.postMessage({ cmd: 'sqlFilesRefreshed', files: sqlFiles });
                    break;
                }
                case 'readSqlFile': {
                    const pathMod2 = await import('path');
                    let content = '';
                    let fileName = msg.path;
                    if (msg.path.startsWith('__untitled__')) {
                        // Find untitled document by URI
                        const uriStr = msg.path.replace('__untitled__', '');
                        // Search ALL text documents by URI or by partial match
                        for (const doc of vscode.workspace.textDocuments) {
                            if (doc.uri.toString() === uriStr || doc.uri.toString() === decodeURIComponent(uriStr)) {
                                content = doc.getText();
                                fileName = doc.uri.path.split('/').pop() || 'Untitled';
                                break;
                            }
                        }
                        // Fallback: search by filename suffix (e.g. "Untitled-4")
                        if (!content) {
                            const namePart = uriStr.split('/').pop()?.split(':').pop() || '';
                            if (namePart) {
                                for (const doc of vscode.workspace.textDocuments) {
                                    const docName = doc.uri.path.split('/').pop() || '';
                                    if (doc.isUntitled && docName === namePart) {
                                        content = doc.getText();
                                        fileName = docName;
                                        break;
                                    }
                                }
                            }
                        }
                        // Also check visible editors
                        if (!content) {
                            for (const editor of vscode.window.visibleTextEditors) {
                                const d = editor.document;
                                if (d.uri.toString() === uriStr || d.uri.toString() === decodeURIComponent(uriStr)) {
                                    content = d.getText();
                                    fileName = d.uri.path.split('/').pop() || 'Untitled';
                                    break;
                                }
                            }
                        }
                    } else {
                        // Read from filesystem
                        try {
                            const fs = await import('fs');
                            content = await fs.promises.readFile(msg.path, 'utf-8');
                            fileName = pathMod2.basename(msg.path);
                        } catch { /* file not accessible */ }
                    }
                    panel.webview.postMessage({
                        cmd: 'sqlFileLoaded',
                        path: msg.path,
                        fileName,
                        content: content || '-- File could not be read',
                        select: true
                    });
                    break;
                }
                case 'browseSqlFile': {
                    const result = await vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        openLabel: 'SQL Dosyası Seç',
                        filters: { 'SQL Files': ['sql'] }
                    });
                    if (result && result[0]) {
                        try {
                            const fs = await import('fs');
                            const path = await import('path');
                            const content = await fs.promises.readFile(result[0].fsPath, 'utf-8');
                            panel.webview.postMessage({
                                cmd: 'sqlFileLoaded',
                                path: result[0].fsPath,
                                fileName: path.basename(result[0].fsPath),
                                content: content,
                                select: true
                            });
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Dosya okunamadı: ${err.message}`);
                        }
                    }
                    break;
                }
                case 'formatPreview': {
                    try {
                        // Create a temporary StyleLoader clone with the preview settings
                        const tempLoader = styleLoader.cloneWithOverrides({
                            reservedKeywords: msg.settings.casing.reservedKeywords,
                            builtInFunctions: msg.settings.casing.builtInFunctions,
                            builtInDataTypes: msg.settings.casing.builtInDataTypes,
                            lists: msg.settings.lists,
                            caseExpressions: msg.settings.caseExpressions,
                            whitespace: msg.settings.whitespace,
                            controlFlow: msg.settings.controlFlow,
                            variables: msg.settings.variables,
                            dataDml: msg.settings.dataDml,
                            schemaDdl: msg.settings.schemaDdl,
                        });
                        // Sync maxLineLength from both Lists and Whitespace
                        const effectiveMaxLine = msg.settings.whitespace?.wrapLinesLongerThan ?? msg.settings.maxLineLength;
                        tempLoader.setMaxLineLength(effectiveMaxLine);
                        const { SqlFormatter } = await import('../formatter/sqlFormatter');
                        const formatter = new SqlFormatter(tempLoader);
                        const formatted = formatter.format(msg.sql);
                        panel.webview.postMessage({ cmd: 'previewFormatted', formatted });
                    } catch (err: any) {
                        // If formatting fails, show original SQL
                        panel.webview.postMessage({ cmd: 'previewFormatted', formatted: msg.sql });
                    }
                    break;
                }
            }
        });

        // Watch for document open/close to update preview file list
        const sendFileList = async () => {
            const pathMod = await import('path');
            const sqlFiles: { path: string; fileName: string; content: string }[] = [];
            const seen = new Set<string>();
            for (const doc of vscode.workspace.textDocuments) {
                const isSqlLang = doc.languageId === 'sql' || doc.languageId === 'mssql' || doc.languageId === 'tsql';
                const isSqlFile = doc.uri.fsPath?.toLowerCase().endsWith('.sql');
                if (doc.isClosed) continue;
                if (isSqlLang || isSqlFile) {
                    const key = doc.uri.toString();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    if (doc.isUntitled) {
                        sqlFiles.push({ path: '__untitled__' + key, fileName: doc.uri.path.split('/').pop() || 'Untitled', content: doc.getText() });
                    } else if (doc.uri.scheme === 'file') {
                        sqlFiles.push({ path: doc.uri.fsPath, fileName: pathMod.basename(doc.uri.fsPath), content: doc.getText() });
                    }
                }
            }
            panel.webview.postMessage({ cmd: 'sqlFilesRefreshed', files: sqlFiles });
        };

        const docOpenSub = vscode.workspace.onDidOpenTextDocument(() => sendFileList());
        const docCloseSub = vscode.workspace.onDidCloseTextDocument(() => sendFileList());
        const editorChangeSub = vscode.window.onDidChangeActiveTextEditor(() => sendFileList());

        panel.onDidDispose(() => {
            StyleFormProvider.currentPanel = undefined;
            docOpenSub.dispose();
            docCloseSub.dispose();
            editorChangeSub.dispose();
        }, null, context.subscriptions);
    }

    private static getHtml(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        options: { reservedKeywords: CasingMode; builtInFunctions: CasingMode; builtInDataTypes: CasingMode },
        layout: { maxLineLength: number; placeCommasBeforeItems: boolean; alignItemsToTabStops: boolean },
        aliases: { assignAliases: boolean; includeAS: boolean; capitaliseAliases: boolean; prefixesToIgnore: string[] },
        insertionKeys: { space: boolean; dot: boolean; parentheses: boolean; comma: boolean; bracket: boolean; semicolon: boolean },
        styleName: string,
        styleFile: string,
        snippetFolder: string,
        connectionCount: number,
        queryShortcuts: { key: string; query: string }[],
        lang: string,
        customTranslations: Record<string, Record<string, string>>,
        fmtConfig: { whitespace: any; controlFlow: any; variables: any; dataDml: any; schemaDdl: any }
    ): string {
        const monacoBase = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'monaco-editor', 'min'));
        const monacoVs = monacoBase.toString();
        const cspSource = webview.cspSource;
        // Merge built-in + custom translations for the webview
        const allTranslations: Record<string, Record<string, string>> = { ...styleFormTranslations };
        for (const [code, dict] of Object.entries(customTranslations)) {
            if (!allTranslations[code]) { allTranslations[code] = dict; }
            else { allTranslations[code] = { ...allTranslations[code], ...dict }; }
        }
        const allLangCodes = Object.keys(allTranslations);
        const builtInLangs = Object.keys(styleFormTranslations);
        // Flag image files (SVG) for languages that have them
        const langFlagFiles: Record<string, string> = {
            en: 'Flag_of_the_United_Kingdom_(3-5).svg',
            tr: 'Flag_of_Turkey.svg',
        };
        const langFlagUris: Record<string, string> = {};
        for (const [code, file] of Object.entries(langFlagFiles)) {
            langFlagUris[code] = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icons', file)).toString();
        }
        // Country codes as fallback labels
        const langFlags: Record<string, string> = {
            en: 'GB', tr: 'TR', de: 'DE', fr: 'FR',
            es: 'ES', it: 'IT', pt: 'PT', ru: 'RU',
            ja: 'JP', ko: 'KR', zh: 'CN', ar: 'SA',
            nl: 'NL', pl: 'PL', sv: 'SE', da: 'DK',
            fi: 'FI', no: 'NO', cs: 'CZ', hu: 'HU',
            ro: 'RO', bg: 'BG', uk: 'UA', az: 'AZ',
        };
        const langNames: Record<string, string> = {
            en: 'English', tr: 'T\u00FCrk\u00E7e', de: 'Deutsch', fr: 'Fran\u00E7ais',
            es: 'Espa\u00F1ol', it: 'Italiano', pt: 'Portugu\u00EAs', ru: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439',
            ja: '\u65E5\u672C\u8A9E', ko: '\uD55C\uAD6D\uC5B4', zh: '\u4E2D\u6587', ar: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629',
            nl: 'Nederlands', pl: 'Polski', sv: 'Svenska', da: 'Dansk',
            fi: 'Suomi', no: 'Norsk', cs: '\u010Ce\u0161tina', hu: 'Magyar',
            ro: 'Rom\u00E2n\u0103', bg: '\u0411\u044A\u043B\u0433\u0430\u0440\u0441\u043A\u0438', uk: '\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430', az: 'Az\u0259rbaycanca',
        };
        // Build custom dropdown items with flag images
        const langDropdownItems = allLangCodes.map(c => {
            const flagUri = langFlagUris[c] || '';
            const flagCode = langFlags[c] || c.toUpperCase();
            const name = langNames[c] || c;
            const suffix = builtInLangs.includes(c) ? '' : ' *';
            const flagHtml = flagUri
                ? `<img src="${flagUri}" style="width:20px;height:14px;border-radius:2px;object-fit:cover;vertical-align:middle;margin-right:6px;">`
                : `<span style="display:inline-block;width:20px;height:14px;background:var(--vscode-input-border);border-radius:2px;text-align:center;font-size:9px;line-height:14px;margin-right:6px;vertical-align:middle;">${flagCode}</span>`;
            return { code: c, flagHtml, flagUri, flagCode, name, suffix, selected: c === lang };
        });
        const selectedLang = langDropdownItems.find(l => l.selected) || langDropdownItems[0];
        const langDropdownItemsHtml = langDropdownItems.map(l =>
            `<div class="lang-option" onclick="selectLangOption('${l.code}')" data-lang="${l.code}">${l.flagHtml}${l.name}${l.suffix}</div>`
        ).join('');
        // Query Shortcuts rows (SSMS-style: Alt+F1, Ctrl+F1, Ctrl+1..Ctrl+9)
        const qsKeyLabels = ['Alt+F1', 'Ctrl+F1', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9'];
        const qsRowsHtml = qsKeyLabels.map((label, i) => {
            const match = queryShortcuts.find(s => s.key === label);
            const val = (match?.query || '').replace(/"/g, '&quot;');
            return `<tr>
                <td style="padding:4px 10px; border-bottom:1px solid var(--vscode-panel-border); font-size:13px; white-space:nowrap; color:var(--vscode-foreground);">${label}</td>
                <td style="padding:4px 6px; border-bottom:1px solid var(--vscode-panel-border);"><input type="text" id="qs_${i}" value="${val}" style="width:100%; padding:4px 6px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; box-sizing:border-box;" /></td>
            </tr>`;
        }).join('\n');

        // Keep hidden select for compatibility
        const langOptionsHtml = allLangCodes.map(c => {
            const flag = langFlags[c] || c.toUpperCase();
            const name = langNames[c] || c;
            const suffix = builtInLangs.includes(c) ? '' : ' *';
            return `<option value="${c}" ${c === lang ? 'selected' : ''}>${flag} ${name}${suffix}</option>`;
        }).join('');
        return /*html*/`<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource}; font-src ${cspSource}; img-src ${cspSource}; worker-src blob:;">
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

        /* Main layout */
        .main {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        /* Sidebar — VS Code Settings style */
        .sidebar {
            width: 200px;
            min-width: 200px;
            border-right: 1px solid var(--vscode-panel-border);
            padding: 8px 0;
            overflow-y: auto;
            font-size: 13px;
        }
        .sidebar .section-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
            padding: 4px 8px 4px 8px;
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .sidebar .section-title::before {
            content: '\\276F';
            font-size: 13px;
            font-weight: 400;
            transition: transform 0.15s ease;
            display: inline-block;
            color: var(--vscode-foreground);
            width: 16px;
            text-align: center;
            flex-shrink: 0;
        }
        .sidebar .section-title.expanded::before {
            transform: rotate(90deg);
        }
        .sidebar .section-title:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .sidebar .section-group {
            overflow: hidden;
            max-height: 0;
            transition: max-height 0.2s ease-out;
        }
        .sidebar .section-group.expanded {
            max-height: 600px;
        }
        .sidebar .sub-title {
            font-size: 13px;
            font-weight: 400;
            color: var(--vscode-foreground);
            padding: 4px 8px 4px 36px;
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .sidebar .sub-title::before {
            content: '\\276F';
            font-size: 13px;
            font-weight: 400;
            transition: transform 0.15s ease;
            display: inline-block;
            width: 16px;
            text-align: center;
            flex-shrink: 0;
        }
        .sidebar .sub-title.expanded::before {
            transform: rotate(90deg);
        }
        .sidebar .sub-title:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .sidebar .sub-group {
            overflow: hidden;
            max-height: 0;
            transition: max-height 0.15s ease-out;
        }
        .sidebar .sub-group.expanded {
            max-height: 400px;
        }
        .sidebar .menu-item {
            padding: 3px 8px 3px 28px;
            cursor: pointer;
            font-size: 13px;
            border-left: 2px solid transparent;
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
            padding-left: 56px;
            font-size: 13px;
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
            padding: 20px 24px;
            overflow-y: auto;
        }
        .content-body h2 {
            font-size: 20px;
            font-weight: 600;
            margin-bottom: 16px;
            padding-bottom: 0;
        }
        .content-body h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 24px 0 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-foreground);
        }

        /* Form — VS Code Settings style */
        .form-row {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
            gap: 12px;
        }
        .form-row label {
            min-width: 140px;
            font-size: 13px;
            text-align: left;
            flex-shrink: 0;
            color: var(--vscode-foreground);
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
            margin: 8px 0;
        }
        .checkbox-row input[type="checkbox"] {
            accent-color: var(--vscode-focusBorder);
        }
        .checkbox-row label {
            font-size: 13px;
            cursor: pointer;
        }

        /* Tooltip icon */
        .tip {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: var(--vscode-badge-background, #4d4d4d);
            color: var(--vscode-badge-foreground, #ccc);
            font-size: 10px;
            font-weight: 700;
            font-style: normal;
            cursor: help;
            margin-left: 4px;
            flex-shrink: 0;
            vertical-align: middle;
            line-height: 1;
        }
        .tip:hover { background: var(--vscode-focusBorder); color: #fff; }
        /* Tooltip popup (positioned by JS) */
        .tip-popup {
            position: fixed;
            background: var(--vscode-editorHoverWidget-background, #2d2d30);
            color: var(--vscode-editorHoverWidget-foreground, #ccc);
            border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
            border-radius: 3px;
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 400;
            white-space: pre-wrap;
            max-width: 360px;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5);
            line-height: 1.5;
            text-align: left;
            pointer-events: none;
        }

        /* Preview panel with splitter */
        .preview-panel {
            display: none;
            flex-direction: column;
            border-top: none;
            min-height: 80px;
        }
        .preview-panel.visible {
            display: flex;
        }
        .preview-splitter {
            height: 5px;
            background: var(--vscode-panel-border);
            cursor: ns-resize;
            flex-shrink: 0;
            position: relative;
            z-index: 10;
        }
        .preview-splitter:hover,
        .preview-splitter.dragging {
            background: var(--vscode-focusBorder);
        }
        .preview-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            flex-shrink: 0;
        }
        .preview-header .preview-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        .preview-header select {
            padding: 3px 6px;
            font-size: 12px;
            font-family: var(--vscode-font-family);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 2px;
            outline: none;
            max-width: 300px;
        }
        .preview-header select:focus {
            border-color: var(--vscode-focusBorder);
        }
        .preview-header .spacer { flex: 1; }
        .preview-editor-container {
            flex: 1;
            overflow: hidden;
            min-height: 60px;
        }

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
        .snippet-toolbar {
            display: flex; align-items: center; justify-content: space-between;
            margin: 8px 0;
        }
        .snippet-toolbar-buttons { display: flex; gap: 6px; }
        .snippet-search {
            display: flex; align-items: center; background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; padding: 0 8px; width: 200px;
        }
        .snippet-search input {
            flex: 1; background: transparent; border: none; outline: none;
            color: var(--vscode-input-foreground); font-size: 12px; padding: 4px 0; font-family: inherit;
        }
        .snippet-search-icon { color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: 4px; }
        .snippet-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        .snippet-table th {
            text-align: left;
            padding: 6px 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-weight: 600;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .snippet-table td {
            padding: 5px 8px;
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
            max-height: 280px;
            overflow-y: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
        }
        .snippet-code-header {
            display: flex; align-items: center; justify-content: space-between;
            margin-top: 12px;
        }
        .snippet-code-header h3 { margin: 0; }
        .snippet-copy-btn {
            background: transparent; border: 1px solid var(--vscode-input-border, #555);
            color: var(--vscode-foreground); width: 26px; height: 26px; border-radius: 3px;
            cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0;
        }
        .snippet-copy-btn:hover { background: var(--vscode-toolbar-hoverBackground, #3d3d3d); }
        /* Monaco handles code preview styling */
        /* Snippet Modal */
        .snippet-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 200;
        }
        .snippet-modal {
            background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #555);
            border-radius: 6px; padding: 20px; width: 550px; max-width: 90vw; max-height: 80vh;
            display: flex; flex-direction: column; gap: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        .snippet-modal h3 { font-size: 15px; font-weight: 600; margin: 0; }
        .snippet-modal label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
        .snippet-modal input[type="text"] {
            background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #444);
            border-radius: 3px; padding: 6px 8px; color: var(--vscode-input-foreground);
            font-size: 13px; width: 100%; font-family: inherit;
        }
        /* Monaco editor container in modal - no textarea needed */
        .snippet-modal-error { color: var(--vscode-errorForeground, #f48771); font-size: 12px; min-height: 16px; }
        .snippet-modal-buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
        /* Custom language dropdown */
        .lang-dropdown { position: relative; margin-left: auto; }
        .lang-dropdown-btn {
            display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 12px;
            background: var(--vscode-input-background); color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 3px; cursor: pointer; font-family: inherit;
        }
        .lang-dropdown-btn:hover { background: var(--vscode-list-hoverBackground); }
        .lang-dropdown-btn svg { margin-left: 4px; }
        .lang-dropdown-list {
            display: none; position: absolute; top: 100%; right: 0; margin-top: 2px;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
            border-radius: 3px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 50;
            min-width: 160px; max-height: 250px; overflow-y: auto;
        }
        .lang-dropdown-list.open { display: block; }
        .lang-option {
            display: flex; align-items: center; padding: 6px 10px; cursor: pointer;
            font-size: 12px; white-space: nowrap;
        }
        .lang-option:hover { background: var(--vscode-list-hoverBackground); }
        .lang-option.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    </style>
</head>
<body>
    <div class="header">
        <h1 data-i18n="pageTitle">Settings</h1>
        <select id="langSelect" onchange="setLang(this.value)" style="display:none;">
            ${langOptionsHtml}
        </select>
        <div class="lang-dropdown">
            <button class="lang-dropdown-btn" onclick="toggleLangDropdown()" id="langDropdownBtn">
                ${selectedLang.flagHtml}${selectedLang.name}
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <div class="lang-dropdown-list" id="langDropdownList">
                ${langDropdownItemsHtml}
            </div>
        </div>
    </div>

    <div class="main">
        <div class="sidebar">
            <div class="section-title expanded" onclick="toggleGroup(this)" data-i18n="nav.suggestions">Suggestions</div>
            <div class="section-group expanded">
                <div class="menu-item" onclick="showSection('behavior')" data-i18n="nav.behavior">Behavior</div>
                <div class="menu-item" onclick="showSection('joinConditions')" data-i18n="nav.joinConditions">Join conditions</div>
                <div class="menu-item" onclick="showSection('snippets')" data-i18n="nav.snippets">Snippets</div>
            </div>

            <div class="section-title expanded" onclick="toggleGroup(this)" data-i18n="nav.insertedCode">Inserted code</div>
            <div class="section-group expanded">
                <div class="menu-item" onclick="showSection('objectsStatements')" data-i18n="nav.objectsStatements">Objects & statements</div>
                <div class="menu-item" onclick="showSection('qualification')" data-i18n="nav.qualification">Qualification</div>
                <div class="menu-item" onclick="showSection('aliases')" data-i18n="nav.aliases">Aliases</div>
                <div class="menu-item" onclick="showSection('specialChars')" data-i18n="nav.specialChars">Special characters</div>
            </div>

            <div class="section-title expanded" onclick="toggleGroup(this); showSection('styles');" data-i18n="nav.format">Format</div>
            <div class="section-group expanded">
                <div class="menu-item active" onclick="showSection('styles')" data-i18n="nav.styles">Styles</div>
                <div class="menu-item" onclick="showSection('whitespace')" data-i18n="nav.whitespace">Whitespace</div>
                <div class="menu-item" onclick="showSection('casing')" data-i18n="nav.casing">Casing</div>
                <div class="menu-item" onclick="showSection('lists')" data-i18n="nav.lists">Lists</div>

                <div class="sub-title expanded" onclick="toggleSubGroup(this)" data-i18n="nav.statements">Statements</div>
                <div class="sub-group expanded">
                    <div class="menu-item sub" onclick="showSection('dataDml')" data-i18n="nav.dataDml">Data (DML)</div>
                    <div class="menu-item sub" onclick="showSection('schemaDdl')" data-i18n="nav.schemaDdl">Schema (DDL)</div>
                    <div class="menu-item sub" onclick="showSection('controlFlow')" data-i18n="nav.controlFlow">Control flow</div>
                    <div class="menu-item sub disabled">CTE</div>
                    <div class="menu-item sub" onclick="showSection('variables')" data-i18n="nav.variables">Variables</div>
                </div>

                <div class="sub-title" onclick="toggleSubGroup(this)" data-i18n="nav.clauses">Clauses</div>
                <div class="sub-group">
                    <div class="menu-item sub disabled">JOIN</div>
                    <div class="menu-item sub disabled">INSERT</div>
                </div>

                <div class="sub-title expanded" onclick="toggleSubGroup(this)" data-i18n="nav.expressions">Expressions</div>
                <div class="sub-group expanded">
                    <div class="menu-item sub disabled" data-i18n="nav.functionCalls">Function calls</div>
                    <div class="menu-item sub" onclick="showSection('caseExpr')">CASE</div>
                    <div class="menu-item sub disabled">IN</div>
                    <div class="menu-item sub disabled" data-i18n="nav.operators">Operators</div>
                </div>
            </div>

            <div class="section-title expanded" onclick="toggleGroup(this)" data-i18n="nav.queries">Queries</div>
            <div class="section-group expanded">
                <div class="menu-item" onclick="showSection('history')" data-i18n="nav.history">History</div>
            </div>

            <div class="section-title expanded" onclick="toggleGroup(this)" data-i18n="nav.settings">Settings</div>
            <div class="section-group expanded">
                <div class="menu-item" onclick="showSection('connections')" data-i18n="nav.connections">Connections</div>
                <div class="menu-item" onclick="showSection('language')" data-i18n="nav.language">Language</div>
                <div class="menu-item" onclick="showSection('queryShortcuts')" data-i18n="nav.queryShortcuts">Query Shortcuts</div>
            </div>
        </div>

        <div class="content">
            <div class="content-body">
                <!-- Casing Section -->
                <!-- Behavior Section -->
                <div id="section-behavior" style="display:none">
                    <h2 data-i18n="behavior.title">Suggestions &gt; Behavior</h2>

                    <h3 data-i18n="behavior.suggestionsBox">Suggestions box and other popups</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="showCodeSuggestions" checked>
                        <label for="showCodeSuggestions" data-i18n="behavior.showCodeSuggestions">Show code suggestions</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showObjectDefinitions" checked>
                        <label for="showObjectDefinitions" data-i18n="behavior.showObjectDefinitions">Show object definitions</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showTooltipsObjects" checked>
                        <label for="showTooltipsObjects" data-i18n="behavior.showTooltipsObjects">Show tooltips for: Objects</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showTooltipsParameters" checked>
                        <label for="showTooltipsParameters" data-i18n="behavior.showTooltipsParameters">Show tooltips for: Parameters</label>
                    </div>

                    <h3 data-i18n="behavior.insertionKeys">Insertion keys</h3>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:8px;" data-i18n="behavior.insertionKeysDesc">
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

                    <h3 data-i18n="behavior.typesOfSuggestions">Types of suggestions</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="listColumnsAfterSelect">
                        <label for="listColumnsAfterSelect" data-i18n="behavior.listColumnsAfterSelect">List all database columns after a SELECT statement</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="listSystemObjects">
                        <label for="listSystemObjects" data-i18n="behavior.listSystemObjects">List system objects</label>
                    </div>

                    <h3 data-i18n="behavior.vscodeIntegration">VS Code integration</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="disableWordSuggestions">
                        <label for="disableWordSuggestions" data-i18n="behavior.disableWordSuggestions">Disable VS Code word-based suggestions for SQL files</label>
                    </div>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:24px;" data-i18n="behavior.disableWordSuggestionsDesc">
                        Prevents duplicate suggestions from VS Code's built-in word completion in SQL files.
                    </p>
                </div>

                <!-- Join Conditions Section -->
                <div id="section-joinConditions" style="display:none">
                    <h2 data-i18n="join.title">Suggestions &gt; Join conditions</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:16px;" data-i18n="join.desc">
                        By default, SQL Prompt suggests joins based on foreign key relationships.
                    </p>

                    <p style="font-size:13px; margin-bottom:8px;" data-i18n="join.alsoSuggest">Also suggest join conditions based on:</p>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMatchingNames" checked>
                        <label for="joinMatchingNames" data-i18n="join.matchingNames">Columns with matching names (not case-sensitive)</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMatchingTypes">
                        <label for="joinMatchingTypes" data-i18n="join.matchingTypes">Columns with matching data types</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="joinMultiColumnFK">
                        <label for="joinMultiColumnFK" data-i18n="join.multiColumnFK">Individual columns in multiple-column foreign keys</label>
                    </div>

                    <h3 data-i18n="join.columnOrder">Column order</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="swapJoinColumnOrder">
                        <label for="swapJoinColumnOrder" data-i18n="join.swapOrder">Swap order of columns in join clauses</label>
                    </div>
                </div>

                <!-- Objects & Statements Section -->
                <div id="section-objectsStatements" style="display:none">
                    <h2 data-i18n="objects.title">Inserted code &gt; Objects &amp; statements</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:16px;" data-i18n="objects.desc">
                        SQL Prompt can automatically complete the syntax of some statements.
                    </p>

                    <h3 data-i18n="objects.alterStatements">ALTER statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertFullAlter" checked>
                        <label for="insertFullAlter" data-i18n="objects.insertFullAlter">Insert full ALTER statement</label>
                    </div>

                    <h3 data-i18n="objects.insertStatements">INSERT statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertFullInsert" checked>
                        <label for="insertFullInsert" data-i18n="objects.insertFullInsert">Insert full INSERT statement</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="includeValuesClause" checked>
                        <label for="includeValuesClause" data-i18n="objects.includeValues">Include VALUES clause</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="showColumnNames" checked>
                        <label for="showColumnNames" data-i18n="objects.showColumnNames">Show column names</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="showColumnDataTypes" checked>
                        <label for="showColumnDataTypes" data-i18n="objects.showColumnDataTypes">Show column data types</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:48px">
                        <input type="checkbox" id="insertDefaultValue" checked>
                        <label for="insertDefaultValue" data-i18n="objects.insertDefaultValue">Insert default value for each column</label>
                    </div>

                    <h3 data-i18n="objects.execStatements">EXEC statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertParameters" checked>
                        <label for="insertParameters" data-i18n="objects.insertParameters">Insert parameters for functions and stored procedures</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="insertDeclareOutput" checked>
                        <label for="insertDeclareOutput" data-i18n="objects.insertDeclareOutput">Insert DECLARE statement for OUTPUT parameters</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="insertDefaultParamValue" checked>
                        <label for="insertDefaultParamValue" data-i18n="objects.insertDefaultParamValue">Insert default value for each parameter</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="showParameterDataTypes" checked>
                        <label for="showParameterDataTypes" data-i18n="objects.showParameterDataTypes">Show parameter data types</label>
                    </div>

                    <h3 data-i18n="objects.outputClauses">OUTPUT clauses</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="insertOutputInto">
                        <label for="insertOutputInto" data-i18n="objects.insertOutputInto">Insert column list for INTO clause</label>
                    </div>
                </div>

                <!-- CASE Expressions Section -->
                <div id="section-caseExpr" style="display:none">
                    <h2>CASE</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="casePlaceExprOnNewLine">
                        <label for="casePlaceExprOnNewLine" data-i18n="case.placeExprOnNewLine">Place expressions on new line<i class="tip" data-tip-i18n="tip.casePlaceExprOnNewLine">i</i></label>
                    </div>

                    <h3>WHEN</h3>
                    <div class="form-row">
                        <label data-i18n="case.placeFirstWhen">Place first WHEN on new line:<i class="tip" data-tip-i18n="tip.caseFirstWhenNewLine">i</i></label>
                        <select id="caseFirstWhenNewLine" style="width:160px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" selected data-i18n="opt.never">Never</option>
                            <option value="always" data-i18n="opt.always">Always</option>
                            <option value="ifLong" data-i18n="opt.ifLongerMax">If longer than max line length</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label data-i18n="case.whenAlignment">WHEN alignment:<i class="tip" data-tip-i18n="tip.caseWhenAlignment">i</i></label>
                        <select id="caseWhenAlignment" style="width:160px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="toFirstItem" selected data-i18n="opt.toFirstItem">To first item</option>
                            <option value="toCase" data-i18n="opt.toCase">To CASE</option>
                            <option value="indented" data-i18n="opt.indented">Indented</option>
                        </select>
                    </div>

                    <h3 data-i18n="case.thenExpressions">THEN expressions</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="casePlaceThenOnNewLine">
                        <label for="casePlaceThenOnNewLine" data-i18n="case.placeThenOnNewLine">Place THEN on new line<i class="tip" data-tip-i18n="tip.casePlaceThenOnNewLine">i</i></label>
                    </div>

                    <div class="form-row">
                        <label data-i18n="case.exprAlignment">Expression alignment:<i class="tip" data-tip-i18n="tip.caseThenAlignment">i</i></label>
                        <select id="caseThenAlignment" style="width:160px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="indentedFromWhen" selected data-i18n="opt.indentedFromWhen">Indented from WHEN</option>
                            <option value="toCase" data-i18n="opt.toCase">To CASE</option>
                            <option value="toFirstItem" data-i18n="opt.toFirstItem">To first item</option>
                        </select>
                    </div>

                    <h3>ELSE</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="casePlaceElseOnNewLine" checked>
                        <label for="casePlaceElseOnNewLine" data-i18n="case.placeElseOnNewLine">Place ELSE on new line<i class="tip" data-tip-i18n="tip.casePlaceElseOnNewLine">i</i></label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="caseAlignElseToWhen" checked>
                        <label for="caseAlignElseToWhen" data-i18n="case.alignElseToWhen">Align ELSE to WHEN<i class="tip" data-tip-i18n="tip.caseAlignElseToWhen">i</i></label>
                    </div>
                </div>

                <!-- Qualification Section -->
                <div id="section-qualification" style="display:none">
                    <h2 data-i18n="qual.title">Inserted code &gt; Qualification</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithOwner" checked>
                        <label for="qualifyWithOwner" data-i18n="qual.qualifyWithOwner">Qualify object names with owner name</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. dbo.Address</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithAlias" checked>
                        <label for="qualifyWithAlias" data-i18n="qual.qualifyWithAlias">Qualify column names with aliases</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. a.AddressLine1</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="qualifyWithTableName">
                        <label for="qualifyWithTableName" data-i18n="qual.qualifyWithTableName">Qualify column names with table name</label>
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:12px;">e.g. Address.AddressLine1</span>
                    </div>

                    <div class="info-bar" style="margin-top:16px">
                        <span class="icon">ℹ</span>
                        <div data-i18n-html="qual.note">Note: In some situations, inserted object names will always be qualified, regardless of these settings:
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
                    <h2 data-i18n="nav.snippets">Snippets</h2>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="snippets.desc">
                        You can use snippets to insert frequently used chunks of code into your query.
                    </p>

                    <div class="form-row">
                        <label data-i18n="snippets.folder">Snippet folder:</label>
                        <div style="display:flex; gap:8px; align-items:center; flex:1;">
                            <input type="text" id="snippetFolderSnippets" value="${StyleFormProvider.escapeHtml(snippetFolder)}" readonly
                                style="flex:1; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;" />
                            <button class="btn btn-secondary" onclick="browseSnippetFolder()">...</button>
                        </div>
                    </div>

                    <div class="snippet-toolbar">
                        <div class="snippet-toolbar-buttons">
                            <button class="btn btn-secondary" onclick="openSnippetNewModal()">New...</button>
                            <button class="btn btn-secondary" onclick="openSnippetEditModal()">Edit...</button>
                            <button class="btn btn-secondary" onclick="deleteSelectedSnippet()">Delete</button>
                        </div>
                        <div class="snippet-search">
                            <input type="text" id="snippetSearchInput" placeholder="Search..." oninput="filterSnippets()">
                            <svg class="snippet-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/>
                                <line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.5"/>
                            </svg>
                        </div>
                    </div>

                    <div class="snippet-list-container">
                        <table class="snippet-table">
                            <thead><tr><th>Snippet</th><th data-i18n="snippets.description">Description</th></tr></thead>
                            <tbody id="snippetListBody">
                                <tr><td colspan="2" style="color:var(--vscode-descriptionForeground); text-align:center; padding:16px;">Loading snippets...</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div style="margin-top:4px; font-size:11px; color:var(--vscode-descriptionForeground);" id="snippetCountLabel"></div>

                    <div class="snippet-code-header">
                        <h3>Code</h3>
                        <button class="snippet-copy-btn" onclick="copySnippetCode()" title="Kopyala">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
                                <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" fill="none"/>
                            </svg>
                        </button>
                    </div>
                    <div id="snippetCodePreview" style="height:200px; border:1px solid var(--vscode-panel-border); border-radius:2px; margin-top:6px;"></div>
                </div>

                <!-- Snippet Modal -->
                <div class="snippet-modal-overlay" id="snippetModalOverlay">
                    <div class="snippet-modal">
                        <h3 id="snippetModalTitle">Yeni Snippet</h3>
                        <label>Prefix</label>
                        <input type="text" id="snippetModalPrefix">
                        <div class="snippet-modal-error" id="snippetPrefixError"></div>
                        <label>Description</label>
                        <input type="text" id="snippetModalDesc">
                        <div style="display:flex; align-items:center; justify-content:space-between;">
                            <label>Body</label>
                            <button class="snippet-copy-btn" onclick="copyModalCode()" title="Kopyala">
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                    <rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/>
                                    <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" fill="none"/>
                                </svg>
                            </button>
                        </div>
                        <div id="snippetModalBody" style="height:220px; border:1px solid var(--vscode-input-border, #444); border-radius:3px;"></div>
                        <div class="snippet-modal-error" id="snippetModalError"></div>
                        <div class="snippet-modal-buttons">
                            <button class="btn" onclick="saveSnippetModal()" data-i18n="snippets.save" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 18px;">Save</button>
                            <button class="btn btn-secondary" onclick="closeSnippetModal()" data-i18n="snippets.cancel">Cancel</button>
                        </div>
                    </div>
                </div>

                <!-- Whitespace Section -->
                <div id="section-whitespace" style="display:none">
                    <h2 data-i18n="ws.title">Whitespace</h2>

                    <h3 data-i18n="ws.tabBehavior">Tab behavior</h3>
                    <div class="form-row">
                        <label data-i18n="ws.spacesOrTabs">Spaces or tabs:<i class="tip" data-tip-i18n="tip.spacesOrTabs">i</i></label>
                        <select id="ws_spacesOrTabs" style="width:160px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="spaces" ${fmtConfig.whitespace.spacesOrTabs === 'spaces' ? 'selected' : ''} data-i18n="ws.optSpaces">Spaces</option>
                            <option value="tabs" ${fmtConfig.whitespace.spacesOrTabs === 'tabs' ? 'selected' : ''} data-i18n="ws.optTabs">Tabs</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label data-i18n="ws.numberOfSpaces">Number of spaces in tabs:<i class="tip" data-tip-i18n="tip.numberOfSpaces">i</i></label>
                        <input type="number" id="ws_numberOfSpaces" value="${fmtConfig.whitespace.numberOfSpacesInTabs}" min="1" max="8"
                            style="width:60px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                    </div>

                    <h3 data-i18n="ws.wrapping">Wrapping</h3>
                    <div class="form-row">
                        <label data-i18n="ws.wrapLines">Wrap lines longer than:<i class="tip" data-tip-i18n="tip.wrapLines">i</i></label>
                        <input type="number" id="ws_wrapLines" value="${fmtConfig.whitespace.wrapLinesLongerThan}" min="0" max="500"
                            style="width:80px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)" data-i18n="ws.characters">characters</span>
                    </div>

                    <h3 data-i18n="ws.newLines">New lines</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ws_preserveEmptyBetween" ${fmtConfig.whitespace.preserveExistingEmptyLinesBetweenStatements ? 'checked' : ''} onchange="toggleEmptyLinesControls(); updatePreview()">
                        <label for="ws_preserveEmptyBetween" data-i18n="ws.preserveEmptyBetween">Preserve existing empty lines between statements<i class="tip" data-tip-i18n="tip.preserveEmptyBetween">i</i></label>
                    </div>
                    <div class="form-row" id="ws_emptyLinesBetweenRow">
                        <label data-i18n="ws.emptyLinesBetween">Empty lines between statements:<i class="tip" data-tip-i18n="tip.emptyLinesBetween">i</i></label>
                        <select id="ws_emptyLinesBetween" style="width:60px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="0" ${fmtConfig.whitespace.emptyLinesBetweenStatements === 0 ? 'selected' : ''}>0</option>
                            <option value="1" ${fmtConfig.whitespace.emptyLinesBetweenStatements === 1 ? 'selected' : ''}>1</option>
                            <option value="2" ${fmtConfig.whitespace.emptyLinesBetweenStatements === 2 ? 'selected' : ''}>2</option>
                        </select>
                    </div>
                    <div class="form-row" id="ws_emptyLinesAfterBatchRow">
                        <label data-i18n="ws.emptyLinesAfterBatch">Empty lines after batch separator:<i class="tip" data-tip-i18n="tip.emptyLinesAfterBatch">i</i></label>
                        <select id="ws_emptyLinesAfterBatch" style="width:60px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="0" ${fmtConfig.whitespace.emptyLinesAfterBatchSeparator === 0 ? 'selected' : ''}>0</option>
                            <option value="1" ${fmtConfig.whitespace.emptyLinesAfterBatchSeparator === 1 ? 'selected' : ''}>1</option>
                            <option value="2" ${fmtConfig.whitespace.emptyLinesAfterBatchSeparator === 2 ? 'selected' : ''}>2</option>
                        </select>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ws_preserveEmptyWithin" ${fmtConfig.whitespace.preserveExistingEmptyLinesWithinStatements ? 'checked' : ''}>
                        <label for="ws_preserveEmptyWithin" data-i18n="ws.preserveEmptyWithin">Preserve existing empty lines within statements<i class="tip" data-tip-i18n="tip.preserveEmptyWithin">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ws_alignSingleLineComments" ${fmtConfig.whitespace.alignGroupsOfSingleLineComments ? 'checked' : ''}>
                        <label for="ws_alignSingleLineComments" data-i18n="ws.alignSingleLineComments">Align groups of single-line comments<i class="tip" data-tip-i18n="tip.alignSingleLineComments">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ws_alignMultilineComments" ${fmtConfig.whitespace.alignMultilineCommentsMatchingCommonPatterns ? 'checked' : ''}>
                        <label for="ws_alignMultilineComments" data-i18n="ws.alignMultilineComments">Align multiline comments matching common patterns<i class="tip" data-tip-i18n="tip.alignMultilineComments">i</i></label>
                    </div>
                </div>

                <!-- Data DML Section -->
                <div id="section-dataDml" style="display:none">
                    <h2 data-i18n="nav.dataDml">Data (DML)</h2>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="dml.desc">These options apply to SELECT, INSERT, UPDATE and DELETE statements</p>

                    <h3 data-i18n="dml.clauses">Clauses</h3>
                    <div class="form-row">
                        <label data-i18n="dml.clauseAlignment">Clause alignment:<i class="tip" data-tip-i18n="tip.clauseAlignment">i</i></label>
                        <select id="dml_clauseAlignment" style="width:160px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="toStatement" ${fmtConfig.dataDml.clauseAlignment === 'toStatement' ? 'selected' : ''} data-i18n="opt.toStatement">To statement</option>
                            <option value="toKeyword" ${fmtConfig.dataDml.clauseAlignment === 'toKeyword' ? 'selected' : ''} data-i18n="opt.toKeyword">To keyword</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label data-i18n="dml.clauseIndentation">Clause indentation:<i class="tip" data-tip-i18n="tip.clauseIndentation">i</i></label>
                        <select id="dml_clauseIndentation" style="width:60px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="0" ${fmtConfig.dataDml.clauseIndentation === 0 ? 'selected' : ''}>0</option>
                            <option value="1" ${fmtConfig.dataDml.clauseIndentation === 1 ? 'selected' : ''}>1</option>
                            <option value="2" ${fmtConfig.dataDml.clauseIndentation === 2 ? 'selected' : ''}>2</option>
                        </select>
                    </div>

                    <h3 data-i18n="dml.listItems">List items</h3>
                    <div class="form-row">
                        <label data-i18n="dml.placeFromOnNewLine">Place FROM table on new line:<i class="tip" data-tip-i18n="tip.placeFromOnNewLine">i</i></label>
                        <select id="dml_placeFromOnNewLine" style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" ${fmtConfig.dataDml.placeFromTableOnNewLine === 'never' ? 'selected' : ''} data-i18n="opt.never">Never</option>
                            <option value="always" ${fmtConfig.dataDml.placeFromTableOnNewLine === 'always' ? 'selected' : ''} data-i18n="opt.always">Always</option>
                            <option value="ifLong" ${fmtConfig.dataDml.placeFromTableOnNewLine === 'ifLong' ? 'selected' : ''} data-i18n="opt.ifLong">If long</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label data-i18n="dml.placeWhereOnNewLine">Place WHERE condition on new line:<i class="tip" data-tip-i18n="tip.placeWhereOnNewLine">i</i></label>
                        <select id="dml_placeWhereOnNewLine" style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" ${fmtConfig.dataDml.placeWhereConditionOnNewLine === 'never' ? 'selected' : ''} data-i18n="opt.never">Never</option>
                            <option value="always" ${fmtConfig.dataDml.placeWhereConditionOnNewLine === 'always' ? 'selected' : ''} data-i18n="opt.always">Always</option>
                            <option value="ifLong" ${fmtConfig.dataDml.placeWhereConditionOnNewLine === 'ifLong' ? 'selected' : ''} data-i18n="opt.ifLong">If long</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label data-i18n="dml.placeGroupByOnNewLine">Place GROUP BY / ORDER BY expression on new line:<i class="tip" data-tip-i18n="tip.placeGroupByOnNewLine">i</i></label>
                        <select id="dml_placeGroupByOnNewLine" style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" ${fmtConfig.dataDml.placeGroupByOrderByExpressionOnNewLine === 'never' ? 'selected' : ''} data-i18n="opt.never">Never</option>
                            <option value="always" ${fmtConfig.dataDml.placeGroupByOrderByExpressionOnNewLine === 'always' ? 'selected' : ''} data-i18n="opt.always">Always</option>
                            <option value="ifLong" ${fmtConfig.dataDml.placeGroupByOrderByExpressionOnNewLine === 'ifLong' ? 'selected' : ''} data-i18n="opt.ifLong">If long</option>
                        </select>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="dml_placeInsertTableOnNewLine" ${fmtConfig.dataDml.placeInsertTableOnNewLine ? 'checked' : ''}>
                        <label for="dml_placeInsertTableOnNewLine" data-i18n="dml.placeInsertTableOnNewLine">Place INSERT table on new line<i class="tip" data-tip-i18n="tip.placeInsertTableOnNewLine">i</i></label>
                    </div>

                    <h3 data-i18n="dml.distinctTop">DISTINCT / TOP clause</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="dml_placeDistinctTopOnNewLine" ${fmtConfig.dataDml.placeDistinctTopOnNewLine ? 'checked' : ''}>
                        <label for="dml_placeDistinctTopOnNewLine" data-i18n="dml.placeDistinctTopOnNewLine">Place DISTINCT / TOP clause on new line<i class="tip" data-tip-i18n="tip.placeDistinctTopOnNewLine">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="dml_addNewLineAfterDistinctTop" ${fmtConfig.dataDml.addNewLineAfterDistinctTop ? 'checked' : ''}>
                        <label for="dml_addNewLineAfterDistinctTop" data-i18n="dml.addNewLineAfterDistinctTop">Add new line after DISTINCT / TOP clause<i class="tip" data-tip-i18n="tip.addNewLineAfterDistinctTop">i</i></label>
                    </div>

                    <h3 data-i18n="dml.shortDml">Short DML statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="dml_collapseShort" ${fmtConfig.dataDml.collapseShortDmlStatements ? 'checked' : ''}>
                        <label for="dml_collapseShort" data-i18n="dml.collapseShort">Collapse statements shorter than<i class="tip" data-tip-i18n="tip.collapseShortDml">i</i></label>
                        <input type="number" id="dml_collapseShortLen" value="${fmtConfig.dataDml.collapseShortDmlShorterThan}" min="0" max="500"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)" data-i18n="ws.characters">characters</span>
                    </div>

                    <h3 data-i18n="dml.subqueries">Subqueries</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="dml_collapseSubqueries" checked>
                        <label for="dml_collapseSubqueries" data-i18n="dml.collapseSubqueries">Collapse subqueries shorter than<i class="tip" data-tip-i18n="tip.collapseSubqueries">i</i></label>
                        <input type="number" id="dml_collapseSubqueriesLen" value="${fmtConfig.dataDml.collapseSubqueriesShorterThan}" min="0" max="500"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)" data-i18n="ws.characters">characters</span>
                    </div>
                </div>

                <!-- Schema DDL Section -->
                <div id="section-schemaDdl" style="display:none">
                    <h2 data-i18n="nav.schemaDdl">Schema (DDL)</h2>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="ddl.desc">These options apply to CREATE and ALTER statements</p>

                    <h3 data-i18n="ddl.dataTypes">Data types and constraints</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ddl_alignDataTypes" ${fmtConfig.schemaDdl.alignDataTypesAndConstraints ? 'checked' : ''}>
                        <label for="ddl_alignDataTypes" data-i18n="ddl.alignDataTypes">Align data types and constraints<i class="tip" data-tip-i18n="tip.alignDataTypesDdl">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ddl_placeConstraintsOnNewLines" ${fmtConfig.schemaDdl.placeConstraintsOnNewLines ? 'checked' : ''}>
                        <label for="ddl_placeConstraintsOnNewLines" data-i18n="ddl.placeConstraintsOnNewLines">Place constraints on new lines<i class="tip" data-tip-i18n="tip.placeConstraintsOnNewLines">i</i></label>
                    </div>
                    <div class="form-row" style="margin-left:24px">
                        <label data-i18n="ddl.placeConstraintCols">Place constraint columns on new lines:<i class="tip" data-tip-i18n="tip.placeConstraintCols">i</i></label>
                        <select id="ddl_placeConstraintCols" style="width:200px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" ${fmtConfig.schemaDdl.placeConstraintColumnsOnNewLines === 'never' ? 'selected' : ''} data-i18n="opt.never">Never</option>
                            <option value="always" ${fmtConfig.schemaDdl.placeConstraintColumnsOnNewLines === 'always' ? 'selected' : ''} data-i18n="opt.always">Always</option>
                            <option value="ifLongerOrMultiple" ${fmtConfig.schemaDdl.placeConstraintColumnsOnNewLines === 'ifLongerOrMultiple' ? 'selected' : ''} data-i18n="opt.ifLongerOrMultiple">If longer or multiple columns</option>
                        </select>
                    </div>

                    <h3 data-i18n="ddl.procedures">Procedures</h3>
                    <div class="form-row">
                        <label data-i18n="ddl.placeFirstParam">Place first procedure parameter on new line:<i class="tip" data-tip-i18n="tip.placeFirstParam">i</i></label>
                        <select id="ddl_placeFirstParam" style="width:120px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="never" ${fmtConfig.schemaDdl.placeFirstProcedureParameterOnNewLine === 'never' ? 'selected' : ''} data-i18n="opt.never">Never</option>
                            <option value="always" ${fmtConfig.schemaDdl.placeFirstProcedureParameterOnNewLine === 'always' ? 'selected' : ''} data-i18n="opt.always">Always</option>
                            <option value="ifMultiple" ${fmtConfig.schemaDdl.placeFirstProcedureParameterOnNewLine === 'ifMultiple' ? 'selected' : ''} data-i18n="opt.ifMultiple">If multiple</option>
                        </select>
                    </div>

                    <h3 data-i18n="ddl.shortDdl">Short DDL statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="ddl_collapseShort" ${fmtConfig.schemaDdl.collapseShortDdlStatements ? 'checked' : ''}>
                        <label for="ddl_collapseShort" data-i18n="ddl.collapseShort">Collapse statements shorter than<i class="tip" data-tip-i18n="tip.collapseShortDdl">i</i></label>
                        <input type="number" id="ddl_collapseShortLen" value="${fmtConfig.schemaDdl.collapseShortDdlShorterThan}" min="0" max="500"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)" data-i18n="ws.characters">characters</span>
                    </div>
                </div>

                <!-- Control Flow Section -->
                <div id="section-controlFlow" style="display:none">
                    <h2 data-i18n="nav.controlFlow">Control flow</h2>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="cf.desc">These options apply to BEGIN...END, IF...ELSE and TRY...CATCH blocks</p>

                    <h3>BEGIN...END</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="cf_placeBeginOnNewLine" ${fmtConfig.controlFlow.placeBeginOnNewLine ? 'checked' : ''}>
                        <label for="cf_placeBeginOnNewLine" data-i18n="cf.placeBeginOnNewLine">Place BEGIN keyword on new line<i class="tip" data-tip-i18n="tip.placeBeginOnNewLine">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="cf_indentBeginEnd" ${fmtConfig.controlFlow.indentBeginEndKeywords ? 'checked' : ''}>
                        <label for="cf_indentBeginEnd" data-i18n="cf.indentBeginEnd">Indent BEGIN END keywords<i class="tip" data-tip-i18n="tip.indentBeginEnd">i</i></label>
                    </div>

                    <h3 data-i18n="cf.controlFlowStatements">Control flow statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="cf_indentContents" ${fmtConfig.controlFlow.indentContentsOfStatements ? 'checked' : ''}>
                        <label for="cf_indentContents" data-i18n="cf.indentContents">Indent contents of statements<i class="tip" data-tip-i18n="tip.indentContents">i</i></label>
                    </div>

                    <h3 data-i18n="cf.shortControlFlow">Short control flow statements</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="cf_collapseShort" ${fmtConfig.controlFlow.collapseShortStatements ? 'checked' : ''}>
                        <label for="cf_collapseShort" data-i18n="cf.collapseShort">Collapse statements shorter than<i class="tip" data-tip-i18n="tip.collapseShortCf">i</i></label>
                        <input type="number" id="cf_collapseShortLen" value="${fmtConfig.controlFlow.collapseShortStatementsShorterThan}" min="0" max="500"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)" data-i18n="ws.characters">characters</span>
                    </div>
                </div>

                <!-- Variables Section -->
                <div id="section-variables" style="display:none">
                    <h2 data-i18n="nav.variables">Variables</h2>

                    <h3>DECLARE</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="var_alignDataTypes" ${fmtConfig.variables.declareAlignDataTypesAndValues ? 'checked' : ''}>
                        <label for="var_alignDataTypes" data-i18n="var.alignDataTypes">Align data types and values<i class="tip" data-tip-i18n="tip.varAlignDataTypes">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="var_addSpaceBetween" ${fmtConfig.variables.declareAddSpaceBetweenTypeAndPrecision ? 'checked' : ''}>
                        <label for="var_addSpaceBetween" data-i18n="var.addSpaceBetween">Add a space between data type and precision<i class="tip" data-tip-i18n="tip.varAddSpace">i</i></label>
                    </div>

                    <h3>SET</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="var_setPlaceValueOnNewLine" ${fmtConfig.variables.setPlaceAssignedValueOnNewLine ? 'checked' : ''}>
                        <label for="var_setPlaceValueOnNewLine" data-i18n="var.setPlaceValueOnNewLine">Place assigned value on new line if longer than wrap column<i class="tip" data-tip-i18n="tip.varPlaceValueOnNewLine">i</i></label>
                    </div>
                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="var_setPlaceEqualsOnNewLine" ${fmtConfig.variables.setPlaceEqualsSignOnNewLine ? 'checked' : ''}>
                        <label for="var_setPlaceEqualsOnNewLine" data-i18n="var.setPlaceEqualsOnNewLine">Place equals sign on new line<i class="tip" data-tip-i18n="tip.varPlaceEqualsOnNewLine">i</i></label>
                    </div>
                </div>

                <!-- Styles Section -->
                <div id="section-styles">
                    <h2 data-i18n="nav.styles">Styles</h2>

                    <div class="form-row">
                        <label data-i18n="styles.styleFile">Style file:</label>
                        <div style="display:flex; gap:8px; align-items:center; flex:1;">
                            <input type="text" id="styleFilePath" value="${StyleFormProvider.escapeHtml(styleFile)}" readonly
                                style="flex:1; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;" />
                            <button class="btn btn-secondary" onclick="loadFile()">...</button>
                        </div>
                    </div>

                    <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
                        <span style="font-size:13px; color:var(--vscode-descriptionForeground);" id="styleName">${StyleFormProvider.escapeHtml(styleName)}</span>
                        <span style="flex:1"></span>
                        <button class="btn btn-link" onclick="reset()" style="font-size:12px;" data-i18n="footer.reset">Reset</button>
                    </div>

                    <div class="info-bar" style="margin-top:16px">
                        <span class="icon">ℹ</span>
                        <span data-i18n="styles.note">Load a Redgate SQL Prompt style file (.json) to apply formatting rules. Reset restores defaults.</span>
                    </div>
                </div>

                <!-- Casing Section -->
                <div id="section-casing" style="display:none">
                    <h2 data-i18n="nav.casing">Casing</h2>

                    <h3 data-i18n="casing.builtInTitle">Built-in keywords, functions and types</h3>

                    <div class="form-row">
                        <label data-i18n="casing.reservedKeywords">Reserved keywords:<i class="tip" data-tip-i18n="tip.reservedKeywords">i</i></label>
                        <select id="reservedKeywords" onchange="updatePreview()">
                            <option value="upperCamelCase" ${options.reservedKeywords === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="uppercase" ${options.reservedKeywords === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="lowercase" ${options.reservedKeywords === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.reservedKeywords === 'leaveAsIs' ? 'selected' : ''} data-i18n="opt.leaveAsIs">Leave as is</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label data-i18n="casing.builtInFunctions">Built-in functions:<i class="tip" data-tip-i18n="tip.builtInFunctions">i</i></label>
                        <select id="builtInFunctions" onchange="updatePreview()">
                            <option value="uppercase" ${options.builtInFunctions === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="upperCamelCase" ${options.builtInFunctions === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="lowercase" ${options.builtInFunctions === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.builtInFunctions === 'leaveAsIs' ? 'selected' : ''} data-i18n="opt.leaveAsIs">Leave as is</option>
                        </select>
                    </div>

                    <div class="form-row">
                        <label data-i18n="casing.builtInDataTypes">Built-in data types:<i class="tip" data-tip-i18n="tip.builtInDataTypes">i</i></label>
                        <select id="builtInDataTypes" onchange="updatePreview()">
                            <option value="upperCamelCase" ${options.builtInDataTypes === 'upperCamelCase' ? 'selected' : ''}>UpperCamelCase</option>
                            <option value="uppercase" ${options.builtInDataTypes === 'uppercase' ? 'selected' : ''}>UPPERCASE</option>
                            <option value="lowercase" ${options.builtInDataTypes === 'lowercase' ? 'selected' : ''}>lowercase</option>
                            <option value="leaveAsIs" ${options.builtInDataTypes === 'leaveAsIs' ? 'selected' : ''} data-i18n="opt.leaveAsIs">Leave as is</option>
                        </select>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span data-i18n="casing.formatNote">These options will also format your code when you use Format SQL (Ctrl+K Y).</span>
                    </div>

                    <h3 data-i18n="casing.userDefinedObjects">User-defined objects</h3>
                    <div class="checkbox-row">
                        <input type="checkbox" id="useObjectDefinitionCase" checked disabled>
                        <label for="useObjectDefinitionCase" data-i18n="casing.useObjectDefinitionCase">Use object definition case<i class="tip" data-tip-i18n="tip.useObjectDefinitionCase">i</i></label>
                    </div>
                </div>

                <!-- Lists Section -->
                <div id="section-lists" style="display:none">
                    <h2 data-i18n="nav.lists">Lists</h2>

                    <div class="form-row">
                        <label data-i18n="lists.maxLineLength">Max line length:<i class="tip" data-tip-i18n="tip.maxLineLength">i</i></label>
                        <input type="number" id="maxLineLength" value="${layout.maxLineLength}" min="0" max="500"
                            style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; outline:none;"
                            onchange="updatePreview()" />
                        <span style="font-size:12px; color:var(--vscode-descriptionForeground)">0 = no wrap</span>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="placeCommasBeforeItems" ${layout.placeCommasBeforeItems ? 'checked' : ''} onchange="updatePreview()">
                        <label for="placeCommasBeforeItems" data-i18n="lists.placeCommasBefore">Place commas before items<i class="tip" data-tip-i18n="tip.placeCommasBefore">i</i></label>
                    </div>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="alignItemsToTabStops" ${layout.alignItemsToTabStops ? 'checked' : ''} onchange="updatePreview()">
                        <label for="alignItemsToTabStops" data-i18n="lists.alignToTabStops">Align items to tab stops (clause padding)<i class="tip" data-tip-i18n="tip.alignToTabStops">i</i></label>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span data-i18n="lists.note">These options affect SELECT column list formatting.</span>
                    </div>
                </div>

                <!-- Aliases Section -->
                <div id="section-aliases" style="display:none">
                    <h2 data-i18n="nav.aliases">Aliases</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="assignAliases" ${aliases.assignAliases ? 'checked' : ''}>
                        <label for="assignAliases" data-i18n="aliases.assignAliases">Assign aliases</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="includeAS" ${aliases.includeAS ? 'checked' : ''}>
                        <label for="includeAS" data-i18n="aliases.includeAS">Include AS in alias definition</label>
                    </div>

                    <div class="checkbox-row" style="margin-left:24px">
                        <input type="checkbox" id="capitaliseAliases" ${aliases.capitaliseAliases ? 'checked' : ''}>
                        <label for="capitaliseAliases" data-i18n="aliases.capitaliseAliases">Capitalise aliases</label>
                    </div>

                    <h3 data-i18n="aliases.prefixesToIgnore">Prefixes to ignore</h3>
                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span data-i18n="aliases.prefixesNote">When generating an alias from a table name, ignore these prefixes.</span>
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
                    <h2 data-i18n="nav.specialChars">Special characters</h2>

                    <h3 data-i18n="special.brackets">Brackets</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="encloseInBrackets">
                        <label for="encloseInBrackets" data-i18n="special.encloseInBrackets">Enclose identifiers within square brackets [ ]</label>
                    </div>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="addParentheses" checked>
                        <label for="addParentheses" data-i18n="special.addParentheses">Add parentheses ( ) when inserting a function or data type</label>
                    </div>

                    <h3 data-i18n="special.closingChars">Closing characters</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="removeDuplicateClosing" checked>
                        <label for="removeDuplicateClosing" data-i18n="special.removeDuplicate">Remove duplicate closing characters as you type</label>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span data-i18n="special.note">Auto-closing for quotes, parentheses and brackets is handled by VS Code's built-in settings (editor.autoClosingBrackets, editor.autoClosingQuotes).</span>
                    </div>
                </div>

                <!-- History Section -->
                <div id="section-history" style="display:none">
                    <h2 data-i18n="history.title">Queries &gt; History</h2>

                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="enableSqlHistory" checked>
                        <label for="enableSqlHistory" data-i18n="history.enableSqlHistory">Enable SQL History</label>
                    </div>

                    <h3 data-i18n="history.querySize">Query size</h3>
                    <div class="form-row">
                        <label data-i18n="history.maxQuerySize">Maximum query size:</label>
                        <select id="maxQuerySize" style="width:100px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            <option value="256">256 KB</option>
                            <option value="512">512 KB</option>
                            <option value="1024" selected>1 MB</option>
                            <option value="2048">2 MB</option>
                            <option value="5120">5 MB</option>
                        </select>
                    </div>
                    <p style="font-size:12px; color:var(--vscode-descriptionForeground); margin-left:196px;" data-i18n="history.maxQuerySizeNote">
                        Queries larger than the maximum size won't be stored in the history
                    </p>

                    <h3 data-i18n="history.openQueries">Open queries</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="restoreOpenQueries" checked>
                        <label for="restoreOpenQueries" data-i18n="history.restoreOpenQueries">Restore open queries when VS Code starts</label>
                    </div>
                    <div class="form-row" style="margin-left:24px">
                        <label data-i18n="history.maxQueriesToRestore">Maximum number of queries to restore:</label>
                        <input type="number" id="maxQueriesToRestore" value="20" min="1" max="100"
                            style="width:70px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                    </div>

                    <h3 data-i18n="history.clearHistory">Clear SQL History</h3>
                    <div class="checkbox-row" style="margin-left:0">
                        <input type="checkbox" id="autoRemoveOldQueries" checked>
                        <label for="autoRemoveOldQueries" data-i18n="history.autoRemoveOldQueries">Automatically remove queries older than</label>
                        <input type="number" id="historyRetentionDays" value="7" min="1" max="365"
                            style="width:60px; margin:0 6px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <span style="font-size:13px;" data-i18n="history.days">days</span>
                    </div>
                </div>

                <!-- Connections Section -->
                <div id="section-connections" style="display:none">
                    <h2 data-i18n="nav.connections">Connections</h2>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span id="connectionCountInfo">${connectionCount}</span> <span data-i18n="conn.profilesSaved">connection profiles saved.</span>
                    </div>

                    <h3 data-i18n="conn.importConnections">Import connections</h3>
                    <p style="font-size:13px; margin-bottom:12px; color:var(--vscode-descriptionForeground);" data-i18n="conn.importDesc">
                        Import connection settings from a JSON file from another machine.
                    </p>

                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-secondary" onclick="importConnections()" data-i18n="conn.importFromJson">Import from JSON...</button>
                        <button class="btn btn-secondary" onclick="exportConnections()" data-i18n="conn.exportToJson">Export to JSON...</button>
                    </div>
                </div>

                <!-- Language Section -->
                <div id="section-language" style="display:none">
                    <h2 data-i18n="nav.language">Language</h2>

                    <div class="form-row">
                        <label data-i18n="lang.displayLanguage">Display language:</label>
                        <select id="langSelectInline" onchange="setLang(this.value); document.getElementById('langSelect').value=this.value;" style="padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;">
                            ${langOptionsHtml}
                        </select>
                    </div>

                    <div class="info-bar">
                        <span class="icon">ℹ</span>
                        <span data-i18n="lang.note">Changes apply immediately. Custom languages can be added via the Translation Editor.</span>
                    </div>

                    <h3 data-i18n="lang.translationEditor">Translation Editor</h3>
                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="lang.translationEditorDesc">
                        Create or edit translations for custom languages. Built-in languages (en, tr) are read-only.
                    </p>

                    <div style="display:flex; gap:8px; align-items:center; margin-bottom:16px;">
                        <select id="editLangSelect" style="padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; width:160px;">
                            <option value="">— select —</option>
                            ${langOptionsHtml}
                        </select>
                        <input type="text" id="newLangInput" placeholder="new: de, fr, es..." maxlength="5" style="width:120px; padding:5px 8px; font-size:13px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px;" />
                        <button class="btn btn-secondary" onclick="createNewLang()">Create</button>
                        <button class="btn btn-secondary" onclick="openTranslationEditor()" data-i18n="lang.openFullEditor">Open full editor</button>
                    </div>

                    <div id="langEditArea" style="display:none;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <span id="langEditTitle" style="font-weight:600;"></span>
                            <div style="display:flex; gap:8px;">
                                <input type="text" id="langFilterBox" placeholder="Filter..." oninput="filterLangRows()" style="padding:4px 8px; font-size:12px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; width:140px;" />
                                <button class="btn btn-primary" onclick="saveLangEdits()" id="saveLangBtn">Save</button>
                            </div>
                        </div>
                        <div style="max-height:400px; overflow-y:auto; border:1px solid var(--vscode-panel-border); border-radius:2px;">
                            <table style="width:100%; border-collapse:collapse;">
                                <thead>
                                    <tr>
                                        <th style="position:sticky; top:0; background:var(--vscode-editorWidget-background); padding:6px 8px; text-align:left; font-size:11px; border-bottom:1px solid var(--vscode-panel-border);">Key</th>
                                        <th style="position:sticky; top:0; background:var(--vscode-editorWidget-background); padding:6px 8px; text-align:left; font-size:11px; border-bottom:1px solid var(--vscode-panel-border);">English</th>
                                        <th style="position:sticky; top:0; background:var(--vscode-editorWidget-background); padding:6px 8px; text-align:left; font-size:11px; border-bottom:1px solid var(--vscode-panel-border);" data-i18n="lang.translation">Translation</th>
                                    </tr>
                                </thead>
                                <tbody id="langEditBody"></tbody>
                            </table>
                        </div>
                        <div style="margin-top:4px; font-size:11px; color:var(--vscode-descriptionForeground);" id="langEditProgress"></div>
                    </div>
                </div>

                <!-- Query Shortcuts Section -->
                <div id="section-queryShortcuts" style="display:none">
                    <h2 data-i18n="qs.title">Settings &gt; Query Shortcuts</h2>

                    <p style="font-size:13px; color:var(--vscode-descriptionForeground); margin-bottom:12px;" data-i18n="qs.desc">
                        Query shortcuts execute the specified query when the shortcut key is pressed. Use @WORD to insert the word under the cursor.
                    </p>

                    <table style="width:100%; border-collapse:collapse; border:1px solid var(--vscode-panel-border); border-radius:2px;">
                        <thead>
                            <tr>
                                <th style="padding:6px 10px; text-align:left; font-size:12px; font-weight:600; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background); width:100px;" data-i18n="qs.shortcuts">Shortcuts</th>
                                <th style="padding:6px 10px; text-align:left; font-size:12px; font-weight:600; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background);" data-i18n="qs.storedProcedure">Stored Procedure</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${qsRowsHtml}
                        </tbody>
                    </table>

                    <div style="display:flex; justify-content:flex-end; margin-top:12px;">
                        <button class="btn btn-secondary" onclick="resetQueryShortcuts()" data-i18n="qs.resetToDefault">Reset to Default</button>
                    </div>
                </div>
            </div>

            <div class="preview-panel" id="formatPreviewPanel">
                <div class="preview-splitter" id="previewSplitter"></div>
                <div class="preview-header">
                    <span class="preview-label" data-i18n="preview.title">preview</span>
                    <span class="spacer"></span>
                    <select id="previewFileSelect" onchange="onPreviewFileChange()">
                        <option value="__builtin__" data-i18n="preview.builtinSample">Built-in sample</option>
                    </select>
                    <button class="btn btn-secondary" onclick="browseSqlFile()" style="padding:3px 8px; font-size:12px;" title="*.sql dosya seçimi">...</button>
                </div>
                <div class="preview-editor-container" id="formatPreviewEditorContainer"></div>
            </div>
        </div>
    </div>

    <div class="footer">
        <span class="spacer"></span>
        <button class="btn btn-primary" onclick="save()" data-i18n="footer.save">Save</button>
        <button class="btn btn-secondary" onclick="reset()" data-i18n="footer.reset">Reset</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentLang = '${lang}';

        const T = JSON.parse('${JSON.stringify(allTranslations).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');

        function applyLang(lang) {
            currentLang = lang;
            const dict = T[lang] || T.en;
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (dict[key] === undefined) return;
                // Preserve child tooltip icons when updating text
                const tipEl = el.querySelector('.tip');
                if (tipEl) {
                    // Set only the text node, keep the icon
                    const textNode = el.firstChild;
                    if (textNode && textNode.nodeType === 3) {
                        textNode.textContent = dict[key];
                    } else {
                        el.insertBefore(document.createTextNode(dict[key]), tipEl);
                    }
                } else {
                    el.textContent = dict[key];
                }
            });
            document.querySelectorAll('[data-i18n-html]').forEach(el => {
                const key = el.getAttribute('data-i18n-html');
                if (dict[key] !== undefined) el.innerHTML = dict[key];
            });
            // Update tooltip texts
            document.querySelectorAll('[data-tip-i18n]').forEach(el => {
                const key = el.getAttribute('data-tip-i18n');
                const text = (dict[key] || (T.en && T.en[key]) || '');
                el.setAttribute('data-tip', text);
            });
        }

        function setLang(lang) {
            applyLang(lang);
            vscode.postMessage({ cmd: 'setLang', lang: lang });
            // Sync all language dropdowns
            ['langSelect', 'langSelectInline'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = lang;
            });
        }

        function toggleLangDropdown() {
            var list = document.getElementById('langDropdownList');
            list.classList.toggle('open');
        }
        function selectLangOption(code) {
            document.getElementById('langDropdownList').classList.remove('open');
            // Update button content
            var opt = document.querySelector('.lang-option[data-lang="' + code + '"]');
            if (opt) {
                document.getElementById('langDropdownBtn').innerHTML = opt.innerHTML +
                    '<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
            }
            // Mark active
            document.querySelectorAll('.lang-option').forEach(function(el) { el.classList.remove('active'); });
            if (opt) opt.classList.add('active');
            setLang(code);
        }
        // Close dropdown on outside click
        document.addEventListener('click', function(e) {
            var dd = document.querySelector('.lang-dropdown');
            if (dd && !dd.contains(e.target)) {
                document.getElementById('langDropdownList').classList.remove('open');
            }
        });

        function openTranslationEditor() {
            vscode.postMessage({ cmd: 'openTranslationEditor' });
        }

        // Inline translation editor
        const enKeys = Object.keys(T.en || {});
        let editLangCode = '';
        let editLangData = {};
        let editIsBuiltIn = false;

        document.getElementById('editLangSelect').addEventListener('change', function() {
            editLangCode = this.value;
            if (!editLangCode) { document.getElementById('langEditArea').style.display = 'none'; return; }
            editLangData = T[editLangCode] ? {...T[editLangCode]} : {};
            editIsBuiltIn = ${JSON.stringify(builtInLangs)}.includes(editLangCode);
            renderLangEditTable();
        });

        function createNewLang() {
            const code = document.getElementById('newLangInput').value.trim().toLowerCase();
            if (!code) return;
            editLangCode = code;
            editLangData = {};
            editIsBuiltIn = false;
            // Add to all dropdowns
            [document.getElementById('editLangSelect'), document.getElementById('langSelect'), document.getElementById('langSelectInline')].forEach(sel => {
                if (!sel) return;
                let found = false;
                for (const o of sel.options) { if (o.value === code) { found = true; break; } }
                if (!found) {
                    const opt = document.createElement('option');
                    opt.value = code;
                    opt.textContent = code + ' *';
                    sel.appendChild(opt);
                }
            });
            document.getElementById('editLangSelect').value = code;
            document.getElementById('newLangInput').value = '';
            renderLangEditTable();
        }

        function renderLangEditTable() {
            const area = document.getElementById('langEditArea');
            area.style.display = '';
            document.getElementById('langEditTitle').textContent = editLangCode.toUpperCase() + (editIsBuiltIn ? ' (read-only)' : '');
            document.getElementById('saveLangBtn').style.display = editIsBuiltIn ? 'none' : '';
            const tbody = document.getElementById('langEditBody');
            let html = '';
            for (const key of enKeys) {
                const enVal = (T.en[key] || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const trVal = (editLangData[key] || '').replace(/"/g,'&quot;');
                const shortEn = enVal.length > 80 ? enVal.substring(0,80) + '...' : enVal;
                html += '<tr class="lerow" data-lkey="' + key + '">'
                    + '<td style="padding:3px 6px; font-size:11px; font-family:monospace; color:var(--vscode-descriptionForeground); white-space:nowrap; border-bottom:1px solid var(--vscode-panel-border);">' + key + '</td>'
                    + '<td style="padding:3px 6px; font-size:12px; color:var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-panel-border);" title="' + enVal.replace(/"/g,'&quot;') + '">' + shortEn + '</td>'
                    + '<td style="padding:2px 4px; border-bottom:1px solid var(--vscode-panel-border);"><input type="text" value="' + trVal + '" data-lkey="' + key + '" ' + (editIsBuiltIn ? 'disabled' : '') + ' style="width:100%; padding:3px 5px; font-size:12px; font-family:var(--vscode-font-family); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:2px; box-sizing:border-box;" /></td>'
                    + '</tr>';
            }
            tbody.innerHTML = html;
            updateLangEditProgress();
        }

        function updateLangEditProgress() {
            const filled = document.querySelectorAll('#langEditBody input[data-lkey]');
            let count = 0;
            filled.forEach(el => { if (el.value.trim()) count++; });
            document.getElementById('langEditProgress').textContent = count + ' / ' + enKeys.length + ' (' + Math.round(count/enKeys.length*100) + '%)';
        }

        function filterLangRows() {
            const q = document.getElementById('langFilterBox').value.toLowerCase();
            document.querySelectorAll('.lerow').forEach(row => {
                const key = row.getAttribute('data-lkey').toLowerCase();
                const en = (T.en[row.getAttribute('data-lkey')] || '').toLowerCase();
                row.style.display = (!q || key.includes(q) || en.includes(q)) ? '' : 'none';
            });
        }

        function saveLangEdits() {
            if (!editLangCode || editIsBuiltIn) return;
            const translations = {};
            document.querySelectorAll('#langEditBody input[data-lkey]').forEach(el => {
                if (el.value.trim()) translations[el.getAttribute('data-lkey')] = el.value.trim();
            });
            // Update local T
            T[editLangCode] = translations;
            vscode.postMessage({ cmd: 'saveCustomLang', langCode: editLangCode, translations: translations });
            updateLangEditProgress();
        }

        // Apply translations on load (always — needed for tooltips even in English)
        setTimeout(() => applyLang(currentLang), 0);

        const builtinSamples = {
            styles: 'Declare @dateOnly Datetime\\nSet @dateOnly = CAST(FLOOR(CAST(GETDATE() As Float)) As Datetime)\\n\\nSelect  @@ROWCOUNT',

            casing: 'Declare @dateOnly Datetime\\n\\nSet @dateOnly = CAST(FLOOR(CAST(GETDATE() As Float)) As Datetime)\\n\\nSelect  @@ROWCOUNT',

            lists: 'Select p.ProductId, p.ProductName, p.UnitPrice, p.UnitsInStock, p.ReorderLevel, c.CategoryName, s.CompanyName As SupplierName\\nFrom dbo.Products p\\nJoin dbo.Categories c On c.CategoryId = p.CategoryId\\nJoin dbo.Suppliers s On s.SupplierId = p.SupplierId\\nWhere p.UnitPrice > 10 And p.UnitsInStock > 0 And p.Discontinued = 0\\nOrder By c.CategoryName, p.ProductName',

            whitespace: 'Use AdventureWorks\\nGo\\n-- Siparis ozeti raporu\\nSelect o.OrderId, o.OrderDate, c.CompanyName, c.ContactName, c.City, c.Country, Sum(od.UnitPrice * od.Quantity * (1 - od.Discount)) As TotalAmount\\nFrom dbo.Orders o\\nJoin dbo.Customers c On c.CustomerId = o.CustomerId\\nJoin dbo.OrderDetails od On od.OrderId = o.OrderId\\nWhere o.OrderDate >= \\'2024-01-01\\' And o.ShippedDate Is Not Null And c.Country In (\\'Germany\\', \\'France\\', \\'UK\\', \\'USA\\', \\'Brazil\\')\\nGroup By o.OrderId, o.OrderDate, c.CompanyName, c.ContactName, c.City, c.Country\\nHaving Sum(od.UnitPrice * od.Quantity * (1 - od.Discount)) > 500\\nOrder By TotalAmount Desc\\nGo\\nPrint \\'Batch 1 tamamlandi\\'\\nSelect c.CategoryName, Count(*) As ProductCount, Avg(p.UnitPrice) As AvgPrice, Sum(p.UnitsInStock) As TotalStock\\nFrom dbo.Products p Join dbo.Categories c On c.CategoryId = p.CategoryId\\nWhere p.Discontinued = 0\\nGroup By c.CategoryName',

            dataDml: 'Select p.ProductId, p.ProductName, c.CategoryName, s.CompanyName As SupplierName, p.UnitPrice, p.UnitsInStock, p.UnitsOnOrder\\nFrom dbo.Products p\\nJoin dbo.Categories c On c.CategoryId = p.CategoryId\\nJoin dbo.Suppliers s On s.SupplierId = p.SupplierId\\nWhere p.UnitPrice > 20 And p.Discontinued = 0 And p.UnitsInStock > 0\\nGroup By c.CategoryName, s.CompanyName, p.ProductId, p.ProductName, p.UnitPrice, p.UnitsInStock, p.UnitsOnOrder\\nOrder By c.CategoryName, p.ProductName\\n\\nSelect Distinct Top 10 p.ProductName, p.UnitPrice\\nFrom dbo.Products p\\nWhere p.CategoryId = 1\\nOrder By p.UnitPrice Desc\\n\\nInsert Into dbo.OrderDetails (OrderId, ProductId, UnitPrice, Quantity, Discount)\\nValues (10248, 11, 14.00, 12, 0)\\n\\nUpdate dbo.Products Set UnitPrice = UnitPrice * 1.10, UnitsOnOrder = UnitsOnOrder + 5 Where CategoryId = 1 And Discontinued = 0\\n\\nDelete From dbo.OrderDetails Where Quantity = 0 And Discount = 0',

            schemaDdl: 'Create Table dbo.Employees (\\n    EmployeeId Int Not Null Identity(1,1),\\n    FirstName NVarchar(50) Not Null,\\n    LastName NVarchar(50) Not Null,\\n    Email NVarchar(100) Null,\\n    HireDate Date Not Null Default GetDate(),\\n    Salary Decimal(10,2) Null,\\n    DepartmentId Int Not Null,\\n    Constraint PK_Employees Primary Key Clustered (EmployeeId),\\n    Constraint FK_Employees_Dept Foreign Key (DepartmentId) References dbo.Departments(DepartmentId)\\n)\\n\\nCreate Or Alter Procedure dbo.GetEmployeesByDept\\n    @DepartmentId Int,\\n    @MinSalary Decimal(10,2) = 0\\nAs\\nBegin\\n    Select EmployeeId, FirstName, LastName, Salary\\n    From dbo.Employees\\n    Where DepartmentId = @DepartmentId And Salary >= @MinSalary\\n    Order By LastName\\nEnd',

            controlFlow: 'Declare @Status Int = 0\\nDeclare @Message NVarchar(200)\\n\\nIf @Status = 1\\nBegin\\n    Set @Message = \\'Active\\'\\n    Print @Message\\nEnd\\nElse If @Status = 0\\nBegin\\n    Set @Message = \\'Inactive\\'\\n    Print @Message\\nEnd\\nElse\\nBegin\\n    Set @Message = \\'Unknown\\'\\nEnd\\n\\nBegin Try\\n    Insert Into dbo.AuditLog (Message) Values (@Message)\\nEnd Try\\nBegin Catch\\n    Print ERROR_MESSAGE()\\nEnd Catch',

            variables: 'Declare @StartDate Datetime = \\'2024-01-01\\'\\nDeclare @EndDate Datetime = GetDate()\\nDeclare @CategoryId Int\\nDeclare @TotalAmount Decimal(18,2)\\nDeclare @CustomerName NVarchar(100) = \\'ACME Corp\\'\\n\\nSet @CategoryId = 5\\nSet @TotalAmount = (Select Sum(UnitPrice * Quantity) From dbo.OrderDetails Where OrderId = 10248)\\n\\nDeclare @Counter Int = 0, @MaxRetries Int = 3, @Success Bit = 0',

            caseExpr: 'Select\\n    ProductName,\\n    UnitPrice,\\n    Case\\n        When UnitPrice < 10 Then \\'Budget\\'\\n        When UnitPrice < 50 Then \\'Standard\\'\\n        When UnitPrice < 100 Then \\'Premium\\'\\n        Else \\'Luxury\\'\\n    End As PriceCategory,\\n    Case CategoryId\\n        When 1 Then \\'Beverages\\'\\n        When 2 Then \\'Condiments\\'\\n        When 3 Then \\'Confections\\'\\n        Else \\'Other\\'\\n    End As CategoryLabel\\nFrom dbo.Products\\nWhere Discontinued = 0\\nOrder By Case When UnitPrice < 10 Then 0 Else 1 End, ProductName',
        };

        let currentActiveSection = 'styles';
        let previewSqlSource = '__builtin__';
        let previewSqlFiles = {}; // path -> content
        let formatPreviewEditor = null;
        let previewPanelHeight = 220;

        function getPreviewSql() {
            if (previewSqlSource !== '__builtin__') {
                return previewSqlFiles[previewSqlSource] || builtinSamples[currentActiveSection] || builtinSamples.styles;
            }
            return builtinSamples[currentActiveSection] || builtinSamples.styles;
        }

        function collectCurrentSettings() {
            return {
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
                whitespace: {
                    spacesOrTabs: document.getElementById('ws_spacesOrTabs').value,
                    numberOfSpacesInTabs: parseInt(document.getElementById('ws_numberOfSpaces').value) || 4,
                    wrapLinesLongerThan: parseInt(document.getElementById('ws_wrapLines').value) || 120,
                    emptyLinesBetweenStatements: parseInt(document.getElementById('ws_emptyLinesBetween').value) || 0,
                    emptyLinesAfterBatchSeparator: parseInt(document.getElementById('ws_emptyLinesAfterBatch').value) || 1,
                    preserveExistingEmptyLinesBetweenStatements: document.getElementById('ws_preserveEmptyBetween').checked,
                    preserveExistingEmptyLinesWithinStatements: document.getElementById('ws_preserveEmptyWithin').checked,
                    alignGroupsOfSingleLineComments: document.getElementById('ws_alignSingleLineComments').checked,
                    alignMultilineCommentsMatchingCommonPatterns: document.getElementById('ws_alignMultilineComments').checked,
                },
                controlFlow: {
                    placeBeginOnNewLine: document.getElementById('cf_placeBeginOnNewLine').checked,
                    indentBeginEndKeywords: document.getElementById('cf_indentBeginEnd').checked,
                    indentContentsOfStatements: document.getElementById('cf_indentContents').checked,
                    collapseShortStatements: document.getElementById('cf_collapseShort').checked,
                    collapseShortStatementsShorterThan: parseInt(document.getElementById('cf_collapseShortLen').value) || 78,
                },
                variables: {
                    declareAlignDataTypesAndValues: document.getElementById('var_alignDataTypes').checked,
                    declareAddSpaceBetweenTypeAndPrecision: document.getElementById('var_addSpaceBetween').checked,
                    setPlaceAssignedValueOnNewLine: document.getElementById('var_setPlaceValueOnNewLine').checked,
                    setPlaceEqualsSignOnNewLine: document.getElementById('var_setPlaceEqualsOnNewLine').checked,
                },
                dataDml: {
                    clauseAlignment: document.getElementById('dml_clauseAlignment').value,
                    clauseIndentation: parseInt(document.getElementById('dml_clauseIndentation').value) || 0,
                    placeFromTableOnNewLine: document.getElementById('dml_placeFromOnNewLine').value,
                    placeWhereConditionOnNewLine: document.getElementById('dml_placeWhereOnNewLine').value,
                    placeGroupByOrderByExpressionOnNewLine: document.getElementById('dml_placeGroupByOnNewLine').value,
                    placeInsertTableOnNewLine: document.getElementById('dml_placeInsertTableOnNewLine').checked,
                    placeDistinctTopOnNewLine: document.getElementById('dml_placeDistinctTopOnNewLine').checked,
                    addNewLineAfterDistinctTop: document.getElementById('dml_addNewLineAfterDistinctTop').checked,
                    collapseShortDmlStatements: document.getElementById('dml_collapseShort').checked,
                    collapseShortDmlShorterThan: parseInt(document.getElementById('dml_collapseShortLen').value) || 120,
                    collapseSubqueriesShorterThan: parseInt(document.getElementById('dml_collapseSubqueriesLen').value) || 120,
                },
                schemaDdl: {
                    alignDataTypesAndConstraints: document.getElementById('ddl_alignDataTypes').checked,
                    placeConstraintsOnNewLines: document.getElementById('ddl_placeConstraintsOnNewLines').checked,
                    placeConstraintColumnsOnNewLines: document.getElementById('ddl_placeConstraintCols').value,
                    placeFirstProcedureParameterOnNewLine: document.getElementById('ddl_placeFirstParam').value,
                    collapseShortDdlStatements: document.getElementById('ddl_collapseShort').checked,
                    collapseShortDdlShorterThan: parseInt(document.getElementById('ddl_collapseShortLen').value) || 120,
                },
                caseExpressions: {
                    placeExpressionOnNewLine: document.getElementById('casePlaceExprOnNewLine').checked,
                    placeFirstWhenOnNewLine: document.getElementById('caseFirstWhenNewLine').value,
                    whenAlignment: document.getElementById('caseWhenAlignment').value,
                    placeThenOnNewLine: document.getElementById('casePlaceThenOnNewLine').checked,
                    thenAlignment: document.getElementById('caseThenAlignment').value,
                    placeElseOnNewLine: document.getElementById('casePlaceElseOnNewLine').checked,
                    alignElseToWhen: document.getElementById('caseAlignElseToWhen').checked,
                },
            };
        }

        let previewDebounceTimer = null;
        function updatePreview() {
            if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
            previewDebounceTimer = setTimeout(function() {
                const sql = getPreviewSql();
                const settings = collectCurrentSettings();
                vscode.postMessage({ cmd: 'formatPreview', sql: sql, settings: settings });
            }, 150);
        }

        // Tooltip popup logic
        (function initTooltips() {
            const popup = document.createElement('div');
            popup.className = 'tip-popup';
            popup.style.display = 'none';
            document.body.appendChild(popup);

            document.addEventListener('mouseover', function(e) {
                const tip = e.target.closest('.tip');
                if (!tip) return;
                const text = tip.getAttribute('data-tip');
                if (!text) return;
                popup.textContent = text;
                popup.style.display = 'block';

                const rect = tip.getBoundingClientRect();
                const popRect = popup.getBoundingClientRect();
                // Try above first
                let top = rect.top - popRect.height - 6;
                if (top < 4) {
                    // Not enough space above — show below
                    top = rect.bottom + 6;
                }
                let left = rect.left + rect.width / 2 - popRect.width / 2;
                // Keep within viewport
                if (left < 4) left = 4;
                if (left + popRect.width > window.innerWidth - 4) left = window.innerWidth - popRect.width - 4;

                popup.style.top = top + 'px';
                popup.style.left = left + 'px';
            });

            document.addEventListener('mouseout', function(e) {
                const tip = e.target.closest('.tip');
                if (tip) popup.style.display = 'none';
            });
        })();

        function toggleEmptyLinesControls() {
            const checked = document.getElementById('ws_preserveEmptyBetween').checked;
            const row1 = document.getElementById('ws_emptyLinesBetweenRow');
            const row2 = document.getElementById('ws_emptyLinesAfterBatchRow');
            const opacity = checked ? '0.4' : '1';
            row1.style.opacity = opacity;
            row1.style.pointerEvents = checked ? 'none' : '';
            row2.style.opacity = opacity;
            row2.style.pointerEvents = checked ? 'none' : '';
        }
        // Initialize on load
        toggleEmptyLinesControls();

        function browseSqlFile() {
            vscode.postMessage({ cmd: 'browseSqlFile' });
        }

        function onPreviewFileChange() {
            const sel = document.getElementById('previewFileSelect');
            previewSqlSource = sel.value;
            if (previewSqlSource !== '__builtin__') {
                // Always request fresh content from extension
                vscode.postMessage({ cmd: 'readSqlFile', path: previewSqlSource });
            } else {
                updatePreview();
            }
        }

        // refreshSqlFiles removed — files loaded via webviewReady and readSqlFile on demand

        // Splitter drag logic
        (function initSplitter() {
            const splitter = document.getElementById('previewSplitter');
            const panel = document.getElementById('formatPreviewPanel');
            const contentBody = document.querySelector('.content-body');
            let dragging = false;
            let startY = 0;
            let startHeight = 0;

            splitter.addEventListener('mousedown', function(e) {
                dragging = true;
                startY = e.clientY;
                startHeight = panel.offsetHeight;
                splitter.classList.add('dragging');
                document.body.style.cursor = 'ns-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (!dragging) return;
                const delta = startY - e.clientY;
                const newHeight = Math.max(80, Math.min(window.innerHeight - 200, startHeight + delta));
                panel.style.height = newHeight + 'px';
                previewPanelHeight = newHeight;
                if (formatPreviewEditor) formatPreviewEditor.layout();
            });

            document.addEventListener('mouseup', function() {
                if (!dragging) return;
                dragging = false;
                splitter.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            });
        })();

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
                caseExpressions: {
                    placeExpressionOnNewLine: document.getElementById('casePlaceExprOnNewLine').checked,
                    placeFirstWhenOnNewLine: document.getElementById('caseFirstWhenNewLine').value,
                    whenAlignment: document.getElementById('caseWhenAlignment').value,
                    placeThenOnNewLine: document.getElementById('casePlaceThenOnNewLine').checked,
                    thenAlignment: document.getElementById('caseThenAlignment').value,
                    placeElseOnNewLine: document.getElementById('casePlaceElseOnNewLine').checked,
                    alignElseToWhen: document.getElementById('caseAlignElseToWhen').checked,
                },
                disableWordSuggestions: document.getElementById('disableWordSuggestions').checked,
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
                whitespace: {
                    spacesOrTabs: document.getElementById('ws_spacesOrTabs').value,
                    numberOfSpacesInTabs: parseInt(document.getElementById('ws_numberOfSpaces').value) || 4,
                    wrapLinesLongerThan: parseInt(document.getElementById('ws_wrapLines').value) || 120,
                    emptyLinesBetweenStatements: parseInt(document.getElementById('ws_emptyLinesBetween').value) || 0,
                    emptyLinesAfterBatchSeparator: parseInt(document.getElementById('ws_emptyLinesAfterBatch').value) || 1,
                    preserveExistingEmptyLinesBetweenStatements: document.getElementById('ws_preserveEmptyBetween').checked,
                    preserveExistingEmptyLinesWithinStatements: document.getElementById('ws_preserveEmptyWithin').checked,
                    alignGroupsOfSingleLineComments: document.getElementById('ws_alignSingleLineComments').checked,
                    alignMultilineCommentsMatchingCommonPatterns: document.getElementById('ws_alignMultilineComments').checked,
                },
                controlFlow: {
                    placeBeginOnNewLine: document.getElementById('cf_placeBeginOnNewLine').checked,
                    indentBeginEndKeywords: document.getElementById('cf_indentBeginEnd').checked,
                    indentContentsOfStatements: document.getElementById('cf_indentContents').checked,
                    collapseShortStatements: document.getElementById('cf_collapseShort').checked,
                    collapseShortStatementsShorterThan: parseInt(document.getElementById('cf_collapseShortLen').value) || 78,
                },
                variables: {
                    declareAlignDataTypesAndValues: document.getElementById('var_alignDataTypes').checked,
                    declareAddSpaceBetweenTypeAndPrecision: document.getElementById('var_addSpaceBetween').checked,
                    setPlaceAssignedValueOnNewLine: document.getElementById('var_setPlaceValueOnNewLine').checked,
                    setPlaceEqualsSignOnNewLine: document.getElementById('var_setPlaceEqualsOnNewLine').checked,
                },
                dataDml: {
                    clauseAlignment: document.getElementById('dml_clauseAlignment').value,
                    clauseIndentation: parseInt(document.getElementById('dml_clauseIndentation').value) || 0,
                    placeFromTableOnNewLine: document.getElementById('dml_placeFromOnNewLine').value,
                    placeWhereConditionOnNewLine: document.getElementById('dml_placeWhereOnNewLine').value,
                    placeGroupByOrderByExpressionOnNewLine: document.getElementById('dml_placeGroupByOnNewLine').value,
                    placeInsertTableOnNewLine: document.getElementById('dml_placeInsertTableOnNewLine').checked,
                    placeDistinctTopOnNewLine: document.getElementById('dml_placeDistinctTopOnNewLine').checked,
                    addNewLineAfterDistinctTop: document.getElementById('dml_addNewLineAfterDistinctTop').checked,
                    collapseShortDmlStatements: document.getElementById('dml_collapseShort').checked,
                    collapseShortDmlShorterThan: parseInt(document.getElementById('dml_collapseShortLen').value) || 120,
                    collapseSubqueriesShorterThan: parseInt(document.getElementById('dml_collapseSubqueriesLen').value) || 120,
                },
                schemaDdl: {
                    alignDataTypesAndConstraints: document.getElementById('ddl_alignDataTypes').checked,
                    placeConstraintsOnNewLines: document.getElementById('ddl_placeConstraintsOnNewLines').checked,
                    placeConstraintColumnsOnNewLines: document.getElementById('ddl_placeConstraintCols').value,
                    placeFirstProcedureParameterOnNewLine: document.getElementById('ddl_placeFirstParam').value,
                    collapseShortDdlStatements: document.getElementById('ddl_collapseShort').checked,
                    collapseShortDdlShorterThan: parseInt(document.getElementById('ddl_collapseShortLen').value) || 120,
                },
                queryShortcuts: getQueryShortcuts(),
            });
        }

        const qsKeyLabels = ['Alt+F1', 'Ctrl+F1', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9'];
        const qsDefaults = [
            { key: 'Alt+F1', query: "EXEC sp_help '@WORD'" },
            { key: 'Ctrl+1', query: 'EXEC sp_who' },
            { key: 'Ctrl+2', query: 'EXEC sp_lock' },
            { key: 'Ctrl+3', query: 'SELECT TOP 100 * FROM @WORD' },
        ];

        function getQueryShortcuts() {
            const shortcuts = [];
            for (let i = 0; i < qsKeyLabels.length; i++) {
                const el = document.getElementById('qs_' + i);
                const val = el ? el.value.trim() : '';
                if (val) {
                    shortcuts.push({ key: qsKeyLabels[i], query: val });
                }
            }
            return shortcuts;
        }

        function resetQueryShortcuts() {
            for (let i = 0; i < qsKeyLabels.length; i++) {
                const el = document.getElementById('qs_' + i);
                if (el) {
                    const def = qsDefaults.find(d => d.key === qsKeyLabels[i]);
                    el.value = def ? def.query : '';
                }
            }
        }

        function loadFile() {
            vscode.postMessage({ cmd: 'loadFile' });
        }

        let snippetSelectedIndex = -1;
        let snippetEditMode = false;
        let snippetOriginalPrefix = '';
        let snippetFilteredList = [];

        function selectSnippet(index) {
            snippetSelectedIndex = index;
            document.querySelectorAll('.snippet-table tr.selected').forEach(el => el.classList.remove('selected'));
            const row = document.getElementById('snip-' + index);
            if (row) row.classList.add('selected');
            const s = snippetFilteredList[index];
            if (s && s.body && previewEditor) {
                previewEditor.setValue(s.body.replace(/\\\\n/g, '\\n'));
            } else if (previewEditor) {
                previewEditor.setValue('');
            }
        }

        function filterSnippets() {
            const q = document.getElementById('snippetSearchInput').value.toLowerCase();
            const all = window._snippets || [];
            snippetFilteredList = q
                ? all.filter(s => s.prefix.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || s.body.toLowerCase().includes(q))
                : [...all];
            snippetSelectedIndex = -1;
            renderSnippetList();
        }

        function renderSnippetList() {
            const tbody = document.getElementById('snippetListBody');
            if (snippetFilteredList.length === 0) {
                tbody.innerHTML = '<tr><td colspan="2" style="color:var(--vscode-descriptionForeground); text-align:center; padding:16px;">No snippets found.</td></tr>';
            } else {
                tbody.innerHTML = snippetFilteredList.map((s, i) =>
                    '<tr onclick="selectSnippet(' + i + ')" ondblclick="openSnippetEditModalAt(' + i + ')" id="snip-' + i + '"' +
                    (i === snippetSelectedIndex ? ' class="selected"' : '') +
                    '><td>' + escapeHtml(s.prefix) + '</td><td>' + escapeHtml(s.description || '') + '</td></tr>'
                ).join('');
            }
            const all = window._snippets || [];
            const total = all.length;
            const shown = snippetFilteredList.length;
            document.getElementById('snippetCountLabel').textContent =
                shown === total ? total + ' snippets' : shown + ' / ' + total + ' snippets';
        }

        function copySnippetCode() {
            const code = previewEditor ? previewEditor.getValue() : '';
            if (code) navigator.clipboard.writeText(code);
        }
        function copyModalCode() {
            const code = modalEditor ? modalEditor.getValue() : '';
            if (code) navigator.clipboard.writeText(code);
        }

        // Prefix validation
        const SNIPPET_INVALID_CHARS = /[\\/\\\\:?"<>|*]/;
        const SNIPPET_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
        function validateSnippetPrefix(prefix) {
            if (!prefix.trim()) return 'Prefix boş olamaz.';
            if (SNIPPET_INVALID_CHARS.test(prefix)) return 'Prefix geçersiz karakter içeriyor.';
            if (prefix.includes('..')) return 'Prefix ".." içeremez.';
            if (SNIPPET_RESERVED.test(prefix.trim())) return 'Bu isim Windows tarafından ayrılmıştır.';
            return '';
        }

        function openSnippetNewModal() {
            snippetEditMode = false;
            var dict = T[currentLang] || T.en;
            document.getElementById('snippetModalTitle').textContent = dict['snippets.newSnippet'] || 'New Snippet';
            document.getElementById('snippetModalPrefix').value = '';
            document.getElementById('snippetModalDesc').value = '';
            if (modalEditor) modalEditor.setValue('');
            document.getElementById('snippetPrefixError').textContent = '';
            document.getElementById('snippetModalError').textContent = '';
            document.getElementById('snippetModalOverlay').style.display = 'flex';
            document.getElementById('snippetModalPrefix').focus();
            setTimeout(function() { if (modalEditor) modalEditor.layout(); }, 100);
        }
        function openSnippetEditModal() {
            if (snippetSelectedIndex >= 0) openSnippetEditModalAt(snippetSelectedIndex);
        }
        function openSnippetEditModalAt(i) {
            const s = snippetFilteredList[i];
            if (!s) return;
            snippetEditMode = true;
            snippetOriginalPrefix = s.prefix;
            var dict2 = T[currentLang] || T.en;
            document.getElementById('snippetModalTitle').textContent = dict2['snippets.editSnippet'] || 'Edit Snippet';
            document.getElementById('snippetModalPrefix').value = s.prefix;
            document.getElementById('snippetModalDesc').value = s.description || '';
            if (modalEditor) modalEditor.setValue(s.body.replace(/\\\\n/g, '\\n'));
            document.getElementById('snippetPrefixError').textContent = '';
            document.getElementById('snippetModalError').textContent = '';
            document.getElementById('snippetModalOverlay').style.display = 'flex';
            setTimeout(function() { if (modalEditor) modalEditor.layout(); }, 100);
        }
        function closeSnippetModal() {
            document.getElementById('snippetModalOverlay').style.display = 'none';
        }
        function saveSnippetModal() {
            const prefix = document.getElementById('snippetModalPrefix').value.trim();
            const desc = document.getElementById('snippetModalDesc').value.trim();
            const body = modalEditor ? modalEditor.getValue() : '';
            const err = validateSnippetPrefix(prefix);
            if (err) { document.getElementById('snippetPrefixError').textContent = err; return; }
            document.getElementById('snippetPrefixError').textContent = '';
            const bodyStored = body.replace(/\\n/g, '\\\\n');
            if (snippetEditMode) {
                vscode.postMessage({ cmd: 'updateSnippet', originalPrefix: snippetOriginalPrefix, prefix, description: desc, body: bodyStored });
            } else {
                vscode.postMessage({ cmd: 'createSnippet', prefix, description: desc, body: bodyStored });
            }
        }
        function deleteSelectedSnippet() {
            const s = snippetFilteredList[snippetSelectedIndex];
            if (!s) return;
            vscode.postMessage({ cmd: 'deleteSnippet', prefix: s.prefix });
        }

        document.addEventListener('keydown', function(e) {
            if (document.getElementById('snippetModalOverlay').style.display === 'flex') {
                if (e.key === 'Escape') closeSnippetModal();
                if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveSnippetModal(); }
            }
        });

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

        function navigateToSection(name) {
            // Find the menu item for this section and click it programmatically
            const menuItem = document.querySelector('.menu-item[onclick*="showSection(\\'' + name + '\\')"]');
            if (menuItem) {
                menuItem.click();
            } else {
                // Fallback: directly show the section
                document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
                document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
                const sec = document.getElementById('section-' + name);
                if (sec) sec.style.display = '';
            }
        }

        function showSection(name) {
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            event.target.classList.add('active');
            document.querySelectorAll('[id^="section-"]').forEach(el => el.style.display = 'none');
            const sec = document.getElementById('section-' + name);
            if (sec) sec.style.display = '';
            // Show format preview for all Format sub-sections
            const formatSections = ['styles', 'whitespace', 'casing', 'lists', 'dataDml', 'schemaDdl', 'controlFlow', 'variables', 'caseExpr'];
            const previewPanel = document.getElementById('formatPreviewPanel');
            if (formatSections.includes(name)) {
                currentActiveSection = name;
                previewPanel.classList.add('visible');
                previewPanel.style.height = previewPanelHeight + 'px';
                if (formatPreviewEditor) formatPreviewEditor.layout();
                updatePreview();
            } else {
                previewPanel.classList.remove('visible');
            }
            if (name === 'snippets' && !snippetsLoaded) {
                vscode.postMessage({ cmd: 'loadSnippets' });
                snippetsLoaded = true;
            }
        }

        function toggleStyleSubs() {
            // Legacy — no longer used, kept for safety
        }

        function toggleGroup(titleEl) {
            const group = titleEl.nextElementSibling;
            if (!group || !group.classList.contains('section-group')) return;
            const isExpanded = group.classList.contains('expanded');
            if (isExpanded) {
                group.classList.remove('expanded');
                titleEl.classList.remove('expanded');
            } else {
                group.classList.add('expanded');
                titleEl.classList.add('expanded');
            }
        }

        function toggleSubGroup(titleEl) {
            const group = titleEl.nextElementSibling;
            if (!group || !group.classList.contains('sub-group')) return;
            const isExpanded = group.classList.contains('expanded');
            if (isExpanded) {
                group.classList.remove('expanded');
                titleEl.classList.remove('expanded');
            } else {
                group.classList.add('expanded');
                titleEl.classList.add('expanded');
            }
        }

        window.addEventListener('message', (e) => {
            const msg = e.data;
            if (msg.cmd === 'openSnippetNewWithBody') {
                navigateToSection('snippets');
                setTimeout(function() {
                    openSnippetNewModal();
                    if (msg.body && modalEditor) { modalEditor.setValue(msg.body); }
                }, 300);
            } else if (msg.cmd === 'navigateSection') {
                navigateToSection(msg.section);
            } else if (msg.cmd === 'saved') {
                // Visual feedback handled by VS Code notification
            } else if (msg.cmd === 'snippetsLoaded') {
                window._snippets = (msg.snippets || []).sort(function(a, b) {
                    return a.prefix.localeCompare(b.prefix, undefined, { sensitivity: 'base' });
                });
                snippetSelectedIndex = -1;
                if (previewEditor) previewEditor.setValue('');
                filterSnippets();
            } else if (msg.cmd === 'snippetSaved') {
                if (msg.success) { closeSnippetModal(); }
                else { document.getElementById('snippetModalError').textContent = msg.error || 'Hata oluştu.'; }
            } else if (msg.cmd === 'snippetDeleted') {
                // list refreshed via snippetsLoaded
            } else if (msg.cmd === 'snippetFolderSet') {
                document.getElementById('snippetFolderSnippets').value = msg.path;
                snippetsLoaded = false;
                vscode.postMessage({ cmd: 'loadSnippets' });
                snippetsLoaded = true;
            } else if (msg.cmd === 'connectionsUpdated') {
                const dict3 = T[currentLang] || T.en;
                document.querySelector('#section-connections .info-bar').innerHTML =
                    '<span class="icon">ℹ</span> ' + msg.count + ' ' + (dict3['conn.profilesSaved'] || 'connection profiles saved.');
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
                const sfp = document.getElementById('styleFilePath');
                if (sfp) sfp.value = msg.styleFile || '';
                updatePreview();
            } else if (msg.cmd === 'previewFormatted') {
                if (formatPreviewEditor) {
                    const pos = formatPreviewEditor.getPosition();
                    formatPreviewEditor.setValue(msg.formatted || '');
                    if (pos) formatPreviewEditor.setPosition(pos);
                }
            } else if (msg.cmd === 'sqlFileLoaded') {
                // Add file to dropdown and preview files map
                previewSqlFiles[msg.path] = msg.content;
                const sel = document.getElementById('previewFileSelect');
                let exists = false;
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === msg.path) { exists = true; break; }
                }
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = msg.path;
                    opt.textContent = msg.fileName;
                    sel.appendChild(opt);
                }
                // Only switch selection if this file was explicitly requested (user action)
                if (msg.select || previewSqlSource === msg.path) {
                    sel.value = msg.path;
                    previewSqlSource = msg.path;
                    updatePreview();
                }
            } else if (msg.cmd === 'sqlFilesRefreshed') {
                // Update dropdown: add new files, update content of existing, remove closed files
                const sel = document.getElementById('previewFileSelect');
                const newPaths = new Set((msg.files || []).map(function(f) { return f.path; }));
                // Update content map and add new options
                (msg.files || []).forEach(function(f) {
                    previewSqlFiles[f.path] = f.content;
                    let exists = false;
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === f.path) { exists = true; break; }
                    }
                    if (!exists) {
                        const opt = document.createElement('option');
                        opt.value = f.path;
                        opt.textContent = f.fileName;
                        sel.appendChild(opt);
                    }
                });
                // Remove options for files that are no longer open (skip built-in)
                for (let i = sel.options.length - 1; i >= 1; i--) {
                    if (!newPaths.has(sel.options[i].value)) {
                        delete previewSqlFiles[sel.options[i].value];
                        sel.remove(i);
                    }
                }
                // If selected file was removed, fall back to built-in and refresh
                if (previewSqlSource !== '__builtin__' && !previewSqlFiles[previewSqlSource]) {
                    sel.value = '__builtin__';
                    previewSqlSource = '__builtin__';
                    updatePreview();
                }
            }
        });

        // Auto-trigger preview on any change in format sections
        ['section-whitespace', 'section-dataDml', 'section-schemaDdl', 'section-controlFlow', 'section-variables', 'section-caseExpr', 'section-styles'].forEach(function(id) {
            const sec = document.getElementById(id);
            if (!sec) return;
            sec.addEventListener('change', function() { updatePreview(); });
            sec.addEventListener('input', function() { updatePreview(); });
        });

        // Initial preview
        updatePreview();

        // Signal extension that webview is ready to receive data
        vscode.postMessage({ cmd: 'webviewReady' });
    </script>

    <!-- Monaco Editor -->
    <script src="${monacoVs}/vs/loader.js"></script>
    <script>
        let previewEditor = null;
        let modalEditor = null;

        require.config({ paths: { vs: '${monacoVs}/vs' } });
        require(['vs/editor/editor.main'], function () {
            // Format preview editor (readonly)
            formatPreviewEditor = monaco.editor.create(document.getElementById('formatPreviewEditorContainer'), {
                value: '',
                language: 'sql',
                theme: 'vs-dark',
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: 'on',
                fontSize: 13,
                automaticLayout: true,
                wordWrap: 'on',
                scrollbar: { vertical: 'auto', horizontal: 'auto' }
            });
            // Trigger initial preview
            updatePreview();

            // Snippet preview editor (readonly)
            previewEditor = monaco.editor.create(document.getElementById('snippetCodePreview'), {
                value: '',
                language: 'sql',
                theme: 'vs-dark',
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: 'on',
                fontSize: 13,
                automaticLayout: true,
                wordWrap: 'on',
                scrollbar: { vertical: 'auto', horizontal: 'auto' }
            });

            // Modal editor (editable)
            modalEditor = monaco.editor.create(document.getElementById('snippetModalBody'), {
                value: '',
                language: 'sql',
                theme: 'vs-dark',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: 'on',
                fontSize: 13,
                automaticLayout: true,
                wordWrap: 'on',
                scrollbar: { vertical: 'auto', horizontal: 'auto' }
            });
        });
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
