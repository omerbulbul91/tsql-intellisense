import * as vscode from 'vscode';

const WEB_NOT_SUPPORTED =
    'T-SQL IntelliSense: SQL Server bağlantısı web VS Code\'da desteklenmez. Masaüstü VS Code kullanın.';

interface ConnectionProfile {
    name?: string;
    server: string;
    database?: string;
}

class WebConnectionItem extends vscode.TreeItem {
    constructor(name: string, server: string) {
        super(name, vscode.TreeItemCollapsibleState.None);
        this.description = server;
        this.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('disabledForeground'));
        this.tooltip = `${server} — Web modunda bağlantı desteklenmiyor`;
        this.contextValue = 'connection.web';
    }
}

class WebConnectionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    getTreeItem(el: vscode.TreeItem): vscode.TreeItem {
        return el;
    }

    getChildren(): vscode.TreeItem[] {
        const cfg = vscode.workspace.getConfiguration('tsql-intellisense');
        const conns: ConnectionProfile[] = cfg.get('connections') || [];

        if (conns.length === 0) {
            const empty = new vscode.TreeItem('Kayıtlı bağlantı yok');
            empty.iconPath = new vscode.ThemeIcon('info');
            return [empty];
        }

        return conns.map(c => new WebConnectionItem(c.name || c.server, c.server));
    }
}

export function activate(context: vscode.ExtensionContext): void {
    // Register read-only connection tree
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
            'tsqlConnections',
            new WebConnectionTreeProvider()
        )
    );

    // All commands are stubs — show web limitation message
    const stub = (): void => {
        void vscode.window.showWarningMessage(WEB_NOT_SUPPORTED);
    };

    const commands = [
        'connect', 'disconnect', 'refreshSchema', 'alterProc', 'runQuery',
        'copyTableScript', 'openTableScript', 'setProjectPath',
        'queryShortcut0', 'queryShortcut1', 'queryShortcut2', 'queryShortcut3',
        'newSqlFile', 'setSnippetFolder',
        'addConnection', 'editConnection', 'deleteConnection',
        'treeConnect', 'selectTop100', 'openInExplorer', 'insertSpParams',
        'newQueryFromTree',
        // Script As commands
        'Script.Create', 'Script.Alter', 'Script.CreateOrAlter',
        'Script.Drop', 'Script.DropAndCreate',
        'Script.Select', 'Script.Insert', 'Script.Update',
        'Script.Delete', 'Script.Execute',
        // Tree management commands
        'RefreshDatabases', 'FilterDatabases', 'NewDatabase',
        'RefreshDatabase', 'NewSchema', 'RefreshFolder', 'FilterFolder',
        'NewTable', 'NewView', 'NewScalarFunction', 'NewTableValuedFunction',
        'NewProcedure', 'NewTrigger',
    ];

    for (const cmd of commands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`tsql-intellisense.${cmd}`, stub)
        );
    }
}

export function deactivate(): void { /* no-op */ }
