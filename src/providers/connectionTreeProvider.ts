import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connectionManager';
import { SchemaCache } from '../cache/schemaCache';
import {
    ConnectionItem,
    DatabasesFolderItem,
    DatabaseItem,
    ProjectFolderItem,
    ObjectFolderItem,
    ObjectFolderType,
    ObjectItem,
    ColumnItem,
    ErrorItem,
} from './connectionTreeItems';

type TreeNode = ConnectionItem | DatabasesFolderItem | DatabaseItem | ProjectFolderItem | ObjectFolderItem | ObjectItem | ColumnItem | ErrorItem;

export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionError: string | null = null;
    private databaseList: string[] = [];

    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache
    ) {}

    refresh(): void {
        this.connectionError = null;
        this._onDidChangeTreeData.fire();
    }

    setConnectionError(message: string): void {
        this.connectionError = message;
        this._onDidChangeTreeData.fire();
    }

    setDatabaseList(databases: string[]): void {
        this.databaseList = databases;
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            return this.getRootChildren();
        }
        if (element instanceof ConnectionItem) {
            return this.getConnectionChildren(element);
        }
        if (element instanceof DatabasesFolderItem) {
            return this.getDatabasesFolderChildren(element);
        }
        if (element instanceof DatabaseItem) {
            return this.getDatabaseChildren(element);
        }
        if (element instanceof ObjectFolderItem) {
            return this.getObjectFolderChildren(element);
        }
        if (element instanceof ObjectItem) {
            return this.getObjectChildren(element);
        }
        return [];
    }

    private getRootChildren(): TreeNode[] {
        const profiles = this.connectionManager.getSavedProfiles();
        const activeProfile = this.connectionManager.currentProfile;

        return profiles.map(p => {
            // Match by name + server (not database — DB can change via switchDatabase)
            const isActive = !!activeProfile
                && p.name === activeProfile.name
                && p.server === activeProfile.server;
            return new ConnectionItem(p.name, p.server, p.database, isActive, p.projectPath);
        });
    }

    private getConnectionChildren(item: ConnectionItem): TreeNode[] {
        if (!item.isActive) {
            return [new ErrorItem('Not connected — double-click to connect', false)];
        }

        if (this.connectionError) {
            return [new ErrorItem(`Connection failed: ${this.connectionError}`)];
        }

        return [new DatabasesFolderItem(item.profileName)];
    }

    private getDatabasesFolderChildren(folder: DatabasesFolderItem): TreeNode[] {
        const activeProfile = this.connectionManager.currentProfile;
        if (!activeProfile) { return []; }

        const connectedDb = activeProfile.database;

        const dbProjects = activeProfile.databaseProjects || {};
        // Backward compat: if old-style projectPath exists and no databaseProjects entry, use it for the profile's default DB
        const getProjectPath = (dbName: string): string | undefined => {
            return dbProjects[dbName] || dbProjects[dbName.toLowerCase()] || undefined;
        };

        // If we have a database list from sys.databases, show all
        if (this.databaseList.length > 0) {
            return this.databaseList.map(dbName => {
                const isCurrent = dbName.toLowerCase() === connectedDb.toLowerCase();
                return new DatabaseItem(
                    dbName,
                    isCurrent,
                    folder.parentProfileName,
                    getProjectPath(dbName)
                );
            });
        }

        // Fallback: only show the connected database
        return [new DatabaseItem(connectedDb, true, folder.parentProfileName, getProjectPath(connectedDb))];
    }

    private getDatabaseChildren(item: DatabaseItem): TreeNode[] {
        if (!item.isConnected) {
            return [];
        }

        const children: TreeNode[] = [];

        // Project folder inside the connected database
        if (item.projectPath) {
            children.push(new ProjectFolderItem(item.projectPath));
        }

        if (!this.schemaCache.isLoaded) {
            children.push(new ErrorItem('$(sync~spin) Loading schema...', false));
            return children;
        }

        const tablesAndViews = this.schemaCache.getTablesAndViews();
        const tables = tablesAndViews.filter(o => o.type === 'TABLE');
        const views = tablesAndViews.filter(o => o.type === 'VIEW');
        const sps = this.schemaCache.getProcedures();
        const funcs = this.schemaCache.getFunctions();

        children.push(new ObjectFolderItem('tables', tables.length));
        children.push(new ObjectFolderItem('views', views.length));
        children.push(new ObjectFolderItem('sps', sps.length));
        children.push(new ObjectFolderItem('functions', funcs.length));

        return children;
    }

    private getObjectFolderChildren(folder: ObjectFolderItem): TreeNode[] {
        if (!this.schemaCache.isLoaded) {
            return [new ErrorItem('Schema loading...', false)];
        }

        const typeMap: Record<ObjectFolderType, () => TreeNode[]> = {
            tables: () => {
                const items = this.schemaCache.getTablesAndViews().filter(o => o.type === 'TABLE');
                return items
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'table', this.schemaCache.hasTriggers(o.name)));
            },
            views: () => {
                const items = this.schemaCache.getTablesAndViews().filter(o => o.type === 'VIEW');
                return items
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'view'));
            },
            sps: () => {
                return this.schemaCache.getProcedures()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'sp'));
            },
            functions: () => {
                return this.schemaCache.getFunctions()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'func'));
            },
        };

        const builder = typeMap[folder.folderType];
        return builder ? builder() : [];
    }

    private async getObjectChildren(item: ObjectItem): Promise<TreeNode[]> {
        if (item.objectType !== 'table' && item.objectType !== 'view') {
            return [];
        }

        try {
            const columns = await this.schemaCache.getColumns(item.objectName);
            if (columns.length === 0) {
                return [new ErrorItem('No columns found', false)];
            }

            const indexes = this.schemaCache.getIndexes(item.objectName);
            const pk = indexes.find(idx => idx.isPrimaryKey);
            const pkCols = new Set(pk ? pk.columns.split(',').map(c => c.trim().replace(/\[|\]/g, '')) : []);

            const fks = this.schemaCache.getForeignKeysForTable(item.objectName);
            const fkCols = new Set(fks.map(fk => fk.parentColumn));

            return columns.map(col => {
                let typeStr = col.dataType;
                if (col.maxLength && col.maxLength > 0) {
                    typeStr += `(${col.maxLength})`;
                }
                return new ColumnItem(
                    col.name,
                    typeStr,
                    col.isNullable,
                    pkCols.has(col.name),
                    fkCols.has(col.name)
                );
            });
        } catch (err: any) {
            return [new ErrorItem(`Failed to load columns: ${err.message}`)];
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
