import * as vscode from "vscode";

export enum NodeType {
    Connection = "Connection",
    ServerFolder = "ServerFolder",
    Database = "Database",
    Schema = "Schema",
    Folder = "Folder",
    Table = "Table",
    View = "View",
    Column = "Column",
    Index = "Index",
    Function = "Function",
    Procedure = "Procedure",
    Trigger = "Trigger"
}

export enum ServerFolderType {
    Databases = "Databases",
    Security = "Security",
    ServerObjects = "Server Objects"
}

export enum FolderType {
    Tables = "Tables",
    Views = "Views",
    Functions = "Functions",
    ScalarFunctions = "Scalar-valued Functions",
    TableValuedFunctions = "Table-valued Functions",
    AggregateFunctions = "Aggregate Functions",
    SystemFunctions = "System Functions",
    Procedures = "Procedures",
    Triggers = "Triggers",
    Columns = "Columns",
    Keys = "Keys",
    Constraints = "Constraints",
    Indexes = "Indexes",
    Statistics = "Statistics",
    Parameters = "Parameters"
}

export interface ColumnMetadata {
    name: string;
    dataType: string;
    maxLength: number | null;
    isNullable: boolean;
    isPrimaryKey: boolean;
}

export interface IndexMetadata {
    name: string;
    type: string;
    isUnique: boolean;
    isPrimaryKey: boolean;
}

export class DatabaseTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly nodeType: NodeType,
        public readonly connectionId: string,
        public readonly collapsible: vscode.TreeItemCollapsibleState,
        public readonly databaseName?: string,
        public readonly schemaName?: string,
        public readonly folderType?: FolderType,
        public readonly objectName?: string,
        public readonly columnMetadata?: ColumnMetadata,
        public readonly indexMetadata?: IndexMetadata,
        public readonly profileName?: string,
        public readonly projectPath?: string
    ) {
        super(label, collapsible);
        this.contextValue = this.getContextValue();
        this.tooltip = this.getTooltip();
    }

    private getContextValue(): string {
        if (this.nodeType === NodeType.Connection) {
            return "ConnectionDisconnected";
        }
        return this.nodeType;
    }

    private getTooltip(): string {
        if (this.nodeType === NodeType.Column && this.columnMetadata) {
            const nullable = this.columnMetadata.isNullable ? "NULL" : "NOT NULL";
            const pk = this.columnMetadata.isPrimaryKey ? " (PK)" : "";
            return `${this.columnMetadata.name} ${this.columnMetadata.dataType} ${nullable}${pk}`;
        }
        if (this.nodeType === NodeType.Index && this.indexMetadata) {
            const unique = this.indexMetadata.isUnique ? "UNIQUE " : "";
            const pk = this.indexMetadata.isPrimaryKey ? " (PRIMARY)" : "";
            return `${unique}${this.indexMetadata.type}${pk}`;
        }
        return this.label;
    }
}

export class ErrorItem extends vscode.TreeItem {
    constructor(message: string, isError: boolean = true) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(isError ? "error" : "warning");
        this.contextValue = "errorItem";
    }
}
