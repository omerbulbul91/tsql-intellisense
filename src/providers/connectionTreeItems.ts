import * as vscode from 'vscode';

/** Root-level connection profile node */
export class ConnectionItem extends vscode.TreeItem {
    constructor(
        public readonly profileName: string,
        public readonly server: string,
        public readonly database: string,
        public readonly isActive: boolean,
        public readonly projectPath?: string
    ) {
        super(profileName, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = `${server} / ${database}`;
        this.contextValue = isActive ? 'connection.connected' : 'connection.disconnected';
        this.iconPath = new vscode.ThemeIcon(isActive ? 'database' : 'plug');

        if (isActive) {
            this.tooltip = `Connected: ${server} / ${database}`;
        } else {
            this.tooltip = `${server} / ${database} (disconnected)`;
            this.command = {
                command: 'tsql-intellisense.treeConnect',
                title: 'Connect',
                arguments: [profileName]
            };
        }
    }
}

/** Project folder node (shown when projectPath is set) */
export class ProjectFolderItem extends vscode.TreeItem {
    constructor(public readonly projectPath: string) {
        super(`Project: ${projectPath}`, vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'projectFolder';
        this.iconPath = new vscode.ThemeIcon('folder-library');
        this.tooltip = projectPath;
    }
}

export type ObjectFolderType = 'tables' | 'views' | 'sps' | 'functions';

/** Folder node for Tables, Views, SPs, Functions */
export class ObjectFolderItem extends vscode.TreeItem {
    constructor(
        public readonly folderType: ObjectFolderType,
        public readonly count: number
    ) {
        const labels: Record<ObjectFolderType, string> = {
            tables: 'Tables',
            views: 'Views',
            sps: 'Stored Procedures',
            functions: 'Functions',
        };
        const icons: Record<ObjectFolderType, string> = {
            tables: 'symbol-class',
            views: 'symbol-interface',
            sps: 'symbol-method',
            functions: 'symbol-function',
        };

        super(labels[folderType], vscode.TreeItemCollapsibleState.Collapsed);
        this.description = `(${count})`;
        this.contextValue = `folder.${folderType}`;
        this.iconPath = new vscode.ThemeIcon(icons[folderType]);
    }
}

export type ObjectType = 'table' | 'view' | 'sp' | 'func';

/** Individual database object node */
export class ObjectItem extends vscode.TreeItem {
    constructor(
        public readonly objectName: string,
        public readonly objectType: ObjectType,
        public readonly hasTrigger: boolean = false
    ) {
        const isExpandable = objectType === 'table' || objectType === 'view';
        super(
            objectName,
            isExpandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        this.contextValue = objectType;
        const icons: Record<ObjectType, string> = {
            table: 'symbol-class',
            view: 'symbol-interface',
            sp: 'symbol-method',
            func: 'symbol-function',
        };
        this.iconPath = new vscode.ThemeIcon(icons[objectType]);
        this.tooltip = hasTrigger ? `${objectName} ⚡ (has triggers)` : objectName;
    }
}

/** Column node under a table/view */
export class ColumnItem extends vscode.TreeItem {
    constructor(
        public readonly columnName: string,
        public readonly dataType: string,
        public readonly isNullable: boolean,
        public readonly isPK: boolean,
        public readonly isFK: boolean
    ) {
        super(columnName, vscode.TreeItemCollapsibleState.None);

        const nullStr = isNullable ? 'null' : 'not null';
        this.description = `${dataType} ${nullStr}`;

        if (isPK) {
            this.contextValue = 'column.pk';
            this.iconPath = new vscode.ThemeIcon('key');
        } else if (isFK) {
            this.contextValue = 'column.fk';
            this.iconPath = new vscode.ThemeIcon('link');
        } else {
            this.contextValue = 'column';
            this.iconPath = new vscode.ThemeIcon('symbol-field');
        }
    }
}

/** Error/info node shown when loading fails */
export class ErrorItem extends vscode.TreeItem {
    constructor(message: string, isError: boolean = true) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(isError ? 'error' : 'warning');
        this.contextValue = 'errorItem';
    }
}
