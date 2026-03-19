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
    ObjectType,
    ColumnItem,
    ErrorItem,
} from './connectionTreeItems';

type TreeNode = ConnectionItem | DatabasesFolderItem | DatabaseItem | ProjectFolderItem | ObjectFolderItem | ObjectItem | ColumnItem | ErrorItem;

export type FilterTarget = 'databases' | 'tables' | 'views' | 'sps' | 'functions';

interface CachedConnectionData {
    databases: string[];
    tables: string[];
    views: string[];
    sps: string[];
    funcs: string[];
}

interface PerDbData {
    tables: string[];
    views: string[];
    sps: string[];
    funcs: string[];
}

export class ConnectionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private databaseList: string[] = [];
    private filters = new Map<FilterTarget, string>();
    private perConnectionCache = new Map<string, CachedConnectionData>();
    /** key: "profileName::dbName" */
    private perDbCache = new Map<string, PerDbData>();
    /** Single registry: one instance per node id */
    private registry = new Map<string, TreeNode>();

    constructor(
        private connectionManager: ConnectionManager,
        private schemaCache: SchemaCache,
        private loadDbDataFn: (profileName: string, dbName: string) => Promise<void>
    ) {}

    /** Get-or-create a node from the registry */
    private reg<T extends TreeNode>(id: string, factory: () => T): T {
        if (!this.registry.has(id)) { this.registry.set(id, factory()); }
        return this.registry.get(id) as T;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    setFilter(target: FilterTarget, value: string): void {
        if (value) { this.filters.set(target, value.toLowerCase()); }
        else { this.filters.delete(target); }
        this._onDidChangeTreeData.fire();
    }

    clearFilter(target: FilterTarget): void {
        this.filters.delete(target);
        this._onDidChangeTreeData.fire();
    }

    getFilter(target: FilterTarget): string | undefined {
        return this.filters.get(target);
    }

    setDatabaseList(databases: string[]): void {
        this.databaseList = databases;
    }

    setCachedData(profileName: string, data: CachedConnectionData): void {
        this.perConnectionCache.set(profileName, data);
    }

    getCachedConnectionData(profileName: string): CachedConnectionData | undefined {
        return this.perConnectionCache.get(profileName);
    }

    setDbCache(profileName: string, dbName: string, data: PerDbData): void {
        this.perDbCache.set(`${profileName}::${dbName}`, data);
    }

    hasDbCache(profileName: string, dbName: string): boolean {
        return this.perDbCache.has(`${profileName}::${dbName}`);
    }

    getCachedDatabases(profileName: string): string[] {
        return this.perConnectionCache.get(profileName)?.databases ?? [];
    }

    getActiveDatabaseList(): string[] {
        return this.databaseList;
    }

    clearDbCache(profileName: string): void {
        for (const key of [...this.perDbCache.keys()]) {
            if (key.startsWith(`${profileName}::`)) { this.perDbCache.delete(key); }
        }
        // Also clear registry entries for this profile's DB nodes
        for (const key of [...this.registry.keys()]) {
            if (key.startsWith(`db:${profileName}::`) || key.startsWith(`folder:${profileName}::`)) {
                this.registry.delete(key);
            }
        }
    }

    // ── Fire methods — never fire(undefined) except fullRefresh ─────────────

    /** Update all connection icons after connect/disconnect */
    fireAllConnections(): void {
        const profiles = this.connectionManager.getSavedProfiles();
        const active = this.connectionManager.currentProfile;
        for (const p of profiles) {
            const node = this.registry.get(`conn:${p.name}`) as ConnectionItem | undefined;
            if (node) {
                node.update(!!active && active.name === p.name);
                this._onDidChangeTreeData.fire(node);
            }
        }
    }

    /** Refresh a profile's Databases folder (DB list changed) */
    fireDbFolderChange(profileName: string): void {
        const node = this.registry.get(`dbfolder:${profileName}`);
        if (node) { this._onDidChangeTreeData.fire(node); }
        // If node not in registry, tree hasn't been expanded yet — getChildren will load on expand
    }

    /** Refresh a single DB node (object counts changed) */
    fireDbChange(profileName: string, dbName: string): void {
        const node = this.registry.get(`db:${profileName}::${dbName}`);
        if (node) { this._onDidChangeTreeData.fire(node); }
    }

    /** Full reset — only for explicit "Refresh All" user action */
    fullRefresh(): void {
        this.registry.clear();
        this._onDidChangeTreeData.fire();
    }

    /** @deprecated Use fullRefresh() for explicit refresh, fireAllConnections() for connect/disconnect */
    refresh(): void {
        this.fullRefresh();
    }

    /** Create an ObjectItem for use with treeView.reveal() */
    createObjectItem(name: string, type: ObjectType, profileName: string, dbName: string): ObjectItem {
        const hasTrig = type === 'table' ? this.schemaCache.hasTriggers(name) : false;
        return new ObjectItem(name, type, hasTrig, false, profileName, dbName);
    }

    // ── TreeDataProvider ────────────────────────────────────────────────────

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
        if (element instanceof ConnectionItem) { return undefined; }
        if (element instanceof DatabasesFolderItem) {
            const profiles = this.connectionManager.getSavedProfiles();
            const p = profiles.find(x => x.name === element.parentProfileName);
            if (!p) { return undefined; }
            const active = this.connectionManager.currentProfile;
            return this.reg(`conn:${p.name}`, () => new ConnectionItem(p.name, p.server, p.database, !!active && active.name === p.name));
        }
        if (element instanceof DatabaseItem) {
            return this.reg(`dbfolder:${element.parentProfileName}`, () => new DatabasesFolderItem(element.parentProfileName));
        }
        if (element instanceof ObjectFolderItem) {
            const profileKey = element.profileName;
            const profileName = profileKey.includes('::') ? profileKey.split('::')[0] : profileKey;
            const dbName = element.dbName ?? (profileKey.includes('::') ? profileKey.split('::')[1] : '');
            return this.reg(`db:${profileName}::${dbName}`, () => new DatabaseItem(dbName, false, profileName));
        }
        if (element instanceof ObjectItem) {
            if (!element.profileName || !element.dbName) { return undefined; }
            const folderTypeMap: Record<string, ObjectFolderType> = {
                table: 'tables', view: 'views', sp: 'sps', func: 'functions'
            };
            const folderType = folderTypeMap[element.objectType] ?? 'tables';
            const dbKey = `${element.profileName}::${element.dbName}`;
            return this.reg(`folder:${dbKey}::${folderType}`, () => new ObjectFolderItem(folderType, 0, dbKey, element.dbName));
        }
        return undefined;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) { return this.getRootChildren(); }
        if (element instanceof ConnectionItem) { return this.getConnectionChildren(element); }
        if (element instanceof DatabasesFolderItem) { return this.getDatabasesFolderChildren(element); }
        if (element instanceof DatabaseItem) { return this.getDatabaseChildren(element); }
        if (element instanceof ObjectFolderItem) { return this.getObjectFolderChildren(element); }
        if (element instanceof ObjectItem) { return this.getObjectChildren(element); }
        return [];
    }

    private getRootChildren(): TreeNode[] {
        const profiles = this.connectionManager.getSavedProfiles();
        const active = this.connectionManager.currentProfile;
        return profiles.map(p => {
            const isActive = !!active && p.name === active.name;
            const node = this.reg(`conn:${p.name}`, () => new ConnectionItem(p.name, p.server, p.database, isActive));
            node.update(isActive);
            return node;
        });
    }

    private getConnectionChildren(item: ConnectionItem): TreeNode[] {
        const active = this.connectionManager.currentProfile;
        const isActive = !!active && active.name === item.profileName;
        const cached = this.perConnectionCache.get(item.profileName);

        // No connection, no cache — show "Click to connect"
        if (!isActive && !cached) {
            const profiles = this.connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === item.profileName);
            const dbProjects = profile?.databaseProjects;
            if (dbProjects && Object.keys(dbProjects).length > 0) {
                const folder = this.reg(`dbfolder:${item.profileName}`, () => new DatabasesFolderItem(item.profileName));
                folder.updateDescription(Object.keys(dbProjects).length, 'projects');
                return [folder];
            }
            return [new ErrorItem('Click to connect', false)];
        }

        const folder = this.reg(`dbfolder:${item.profileName}`, () => new DatabasesFolderItem(item.profileName));
        if (isActive) {
            folder.updateDescription(this.databaseList.length);
        } else if (cached) {
            folder.updateDescription(cached.databases.length, 'cached');
        }
        return [folder];
    }

    private getDatabasesFolderChildren(folder: DatabasesFolderItem): TreeNode[] {
        const active = this.connectionManager.currentProfile;
        const isActive = !!active && active.name === folder.parentProfileName;

        if (isActive) {
            const connectedDb = active.database;
            const dbFilter = this.filters.get('databases');
            const dbProjects = active.databaseProjects || {};
            const getProjectPath = (dbName: string): string | undefined =>
                dbProjects[dbName] || dbProjects[dbName.toLowerCase()] || undefined;

            // Update folder description with filter info
            folder.description = dbFilter
                ? `(${this.databaseList.length}) 🔍 ${this.filters.get('databases')}`
                : `(${this.databaseList.length})`;

            let dbs = this.databaseList.length > 0 ? this.databaseList : [connectedDb];
            if (dbFilter) { dbs = dbs.filter(name => name.toLowerCase().includes(dbFilter)); }

            return dbs.map(dbName => {
                const id = `db:${folder.parentProfileName}::${dbName}`;
                return this.reg(id, () => new DatabaseItem(dbName, false, folder.parentProfileName, getProjectPath(dbName)));
            });
        }

        // Offline — use cache or databaseProjects
        const cached = this.perConnectionCache.get(folder.parentProfileName);
        if (cached && cached.databases.length > 0) {
            const profiles = this.connectionManager.getSavedProfiles();
            const profile = profiles.find(p => p.name === folder.parentProfileName);
            const dbProjects = profile?.databaseProjects || {};
            return cached.databases.map(dbName => {
                const id = `db:${folder.parentProfileName}::${dbName}`;
                return this.reg(id, () => new DatabaseItem(dbName, false, folder.parentProfileName,
                    dbProjects[dbName] || dbProjects[dbName.toLowerCase()], true));
            });
        }

        const profiles = this.connectionManager.getSavedProfiles();
        const profile = profiles.find(p => p.name === folder.parentProfileName);
        const dbProjects = profile?.databaseProjects;
        if (dbProjects && Object.keys(dbProjects).length > 0) {
            return Object.keys(dbProjects).map(dbName => {
                const id = `db:${folder.parentProfileName}::${dbName}`;
                return this.reg(id, () => new DatabaseItem(dbName, false, folder.parentProfileName, dbProjects[dbName], true));
            });
        }
        return [];
    }

    private async getDatabaseChildren(item: DatabaseItem): Promise<TreeNode[]> {
        const dbKey = `${item.parentProfileName}::${item.dbName}`;
        const active = this.connectionManager.currentProfile;

        if (!this.perDbCache.has(dbKey)) {
            if (active?.name !== item.parentProfileName) {
                // No cache + inactive server → connect first, then load
                const profiles = this.connectionManager.getSavedProfiles();
                const profile = profiles.find(p => p.name === item.parentProfileName);
                if (!profile) { return [new ErrorItem('Profile not found', true)]; }
                try {
                    await this.connectionManager.connect(profile);
                } catch (err: any) {
                    return [new ErrorItem(`Connection failed: ${err.message}`, true)];
                }
            }
            // VS Code shows spinner automatically for async getChildren
            await this.loadDbDataFn(item.parentProfileName, item.dbName);
        }

        const dbData = this.perDbCache.get(dbKey);
        if (!dbData) { return []; }

        const children: TreeNode[] = [];
        if (item.projectPath) { children.push(new ProjectFolderItem(item.projectPath)); }

        const folderDefs: [ObjectFolderType, string[]][] = [
            ['tables', dbData.tables],
            ['views',  dbData.views],
            ['sps',    dbData.sps],
            ['functions', dbData.funcs],
        ];
        for (const [type, names] of folderDefs) {
            const fid = `folder:${dbKey}::${type}`;
            const f = this.reg(fid, () => new ObjectFolderItem(type, names.length, dbKey, item.dbName));
            f.updateCount(names.length);
            children.push(f);
        }
        return children;
    }

    private getObjectFolderChildren(folder: ObjectFolderItem): TreeNode[] {
        const active = this.connectionManager.currentProfile;

        if (folder.profileName && folder.profileName.includes('::')) {
            const [profileName] = folder.profileName.split('::');
            const isActiveServer = !!active && active.name === profileName;
            const dbData = this.perDbCache.get(folder.profileName);
            if (!dbData) { return [new ErrorItem('No data', false)]; }

            const filterText = this.filters.get(folder.folderType);
            const typeMap: Record<ObjectFolderType, { names: string[]; type: ObjectType }> = {
                tables:    { names: dbData.tables, type: 'table' },
                views:     { names: dbData.views,  type: 'view'  },
                sps:       { names: dbData.sps,    type: 'sp'    },
                functions: { names: dbData.funcs,  type: 'func'  },
            };
            const { names, type } = typeMap[folder.folderType];
            const filtered = filterText ? names.filter(n => n.toLowerCase().includes(filterText)) : names;
            folder.updateDescription(names.length, filtered.length, filterText);
            const dbName = folder.dbName ?? '';
            const schemaDbMatch = this.schemaCache.loadedDbName?.toLowerCase() === dbName.toLowerCase();
            const forceNonExpandable = !isActiveServer || !schemaDbMatch;
            return filtered.sort((a, b) => a.localeCompare(b)).map(name => {
                const hasTrig = (type === 'table' && isActiveServer) ? this.schemaCache.hasTriggers(name) : false;
                return new ObjectItem(name, type, hasTrig, forceNonExpandable, profileName, dbName);
            });
        }

        // Fallback: schemaCache path (should not normally be reached with new design)
        if (!this.schemaCache.isLoaded) {
            return [new ErrorItem('Schema loading...', false)];
        }
        const filterText = this.filters.get(folder.folderType);
        const applyFilter = (items: { name: string }[]) =>
            filterText ? items.filter(o => o.name.toLowerCase().includes(filterText)) : items;
        const pName = folder.profileName;
        const dbName = folder.dbName ?? active?.database ?? '';
        const typeMap: Record<ObjectFolderType, () => TreeNode[]> = {
            tables: () => {
                const all = this.schemaCache.getTablesAndViews().filter(o => o.type === 'TABLE');
                const items = applyFilter(all);
                folder.updateDescription(all.length, items.length, filterText);
                return items.sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'table', this.schemaCache.hasTriggers(o.name), false, pName, dbName));
            },
            views: () => {
                const all = this.schemaCache.getTablesAndViews().filter(o => o.type === 'VIEW');
                const items = applyFilter(all);
                folder.updateDescription(all.length, items.length, filterText);
                return items.sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'view', false, false, pName, dbName));
            },
            sps: () => {
                const all = this.schemaCache.getProcedures();
                const items = applyFilter(all);
                folder.updateDescription(all.length, items.length, filterText);
                return items.sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'sp', false, false, pName, dbName));
            },
            functions: () => {
                const all = this.schemaCache.getFunctions();
                const items = applyFilter(all);
                folder.updateDescription(all.length, items.length, filterText);
                return items.sort((a, b) => a.name.localeCompare(b.name))
                    .map(o => new ObjectItem(o.name, 'func', false, false, pName, dbName));
            },
        };
        const builder = typeMap[folder.folderType];
        return builder ? builder() : [];
    }

    private async getObjectChildren(item: ObjectItem): Promise<TreeNode[]> {
        if (item.objectType !== 'table' && item.objectType !== 'view') { return []; }
        try {
            const columns = await this.schemaCache.getColumns(item.objectName);
            if (columns.length === 0) { return [new ErrorItem('No columns found', false)]; }
            const indexes = this.schemaCache.getIndexes(item.objectName);
            const pk = indexes.find(idx => idx.isPrimaryKey);
            const pkCols = new Set(pk ? pk.columns.split(',').map(c => c.trim().replace(/\[|\]/g, '')) : []);
            const fks = this.schemaCache.getForeignKeysForTable(item.objectName);
            const fkCols = new Set(fks.map(fk => fk.parentColumn));
            return columns.map(col => {
                let typeStr = col.dataType;
                if (col.maxLength && col.maxLength > 0) { typeStr += `(${col.maxLength})`; }
                return new ColumnItem(col.name, typeStr, col.isNullable, pkCols.has(col.name), fkCols.has(col.name));
            });
        } catch (err: any) {
            return [new ErrorItem(`Failed to load columns: ${err.message}`)];
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
