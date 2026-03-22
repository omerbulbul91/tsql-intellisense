import * as vscode from "vscode";
import { TreeQueryService, escapeSql } from "../services/TreeQueryService";
import {
    DatabaseTreeItem,
    NodeType,
    FolderType,
    ServerFolderType,
    ColumnMetadata,
    IndexMetadata,
    ErrorItem,
} from "../models/DatabaseNode";
import { IconManager } from "../utils/IconManager";

export class ConnectionTreeProvider implements vscode.TreeDataProvider<DatabaseTreeItem | ErrorItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<DatabaseTreeItem | ErrorItem | undefined>();
    public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    private treeQueryService: TreeQueryService;
    private iconManager: IconManager;
    private databaseFilter: string = "";
    private folderFilters = new Map<string, string>();
    private parentMap = new WeakMap<DatabaseTreeItem | ErrorItem, DatabaseTreeItem | undefined>();

    constructor(
        treeQueryService: TreeQueryService,
        extensionUri: vscode.Uri
    ) {
        this.treeQueryService = treeQueryService;
        this.iconManager = new IconManager(extensionUri);
    }

    // ── Core ────────────────────────────────────────────────────────────────

    public getTreeItem(element: DatabaseTreeItem | ErrorItem): vscode.TreeItem {
        if (element instanceof DatabaseTreeItem) {
            element.iconPath = this.iconManager.getIcon(element);
        }
        return element;
    }

    /** Ensure the profile's connection pool is open before querying */
    private async ensureConnection(element: DatabaseTreeItem): Promise<void> {
        if (element.profileName && !this.treeQueryService.isConnected(element.profileName)) {
            await this.treeQueryService.connect(element.profileName);
        }
    }

    public async getChildren(element?: DatabaseTreeItem): Promise<(DatabaseTreeItem | ErrorItem)[]> {
        if (!element) {
            return this.getConnectionNodes();
        }
        try {
            switch (element.nodeType) {
                case NodeType.Connection:
                    await this.ensureConnection(element);
                    element.contextValue = "ConnectionConnected";
                    return this.getServerFolders(element);
                case NodeType.ServerFolder:
                    await this.ensureConnection(element);
                    return this.getServerFolderChildren(element);
                case NodeType.Database:
                    await this.ensureConnection(element);
                    return this.getDatabaseChildren(element);
                case NodeType.Schema:
                    await this.ensureConnection(element);
                    return this.getSchemaFolders(element);
                case NodeType.Folder:
                    await this.ensureConnection(element);
                    return this.getFolderChildren(element);
                case NodeType.Table:
                    await this.ensureConnection(element);
                    return this.getTableChildren(element);
                case NodeType.View:
                    await this.ensureConnection(element);
                    return this.getViewChildren(element);
                case NodeType.Procedure:
                case NodeType.Function:
                    await this.ensureConnection(element);
                    return this.getRoutineChildren(element);
                default:
                    return [];
            }
        } catch (err: any) {
            return [new ErrorItem(err.message)];
        }
    }

    public getParent(element: DatabaseTreeItem | ErrorItem): vscode.ProviderResult<DatabaseTreeItem | undefined> {
        return this.parentMap.get(element);
    }

    public refresh(node?: DatabaseTreeItem): void {
        this.onDidChangeTreeDataEmitter.fire(node);
    }

    public fullRefresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    public dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    // ── Filtering ───────────────────────────────────────────────────────────

    public setDatabaseFilter(filter: string): void {
        this.databaseFilter = filter;
    }

    public getDatabaseFilter(): string {
        return this.databaseFilter;
    }

    private getFolderFilterKey(element: DatabaseTreeItem): string {
        return `${element.connectionId}|${element.databaseName}|${element.schemaName}|${element.folderType}`;
    }

    public setFolderFilter(element: DatabaseTreeItem, filter: string): void {
        const key = this.getFolderFilterKey(element);
        if (filter) {
            this.folderFilters.set(key, filter);
        } else {
            this.folderFilters.delete(key);
        }
    }

    public getFolderFilter(element: DatabaseTreeItem): string {
        return this.folderFilters.get(this.getFolderFilterKey(element)) || "";
    }

    private applyFolderFilter(rows: any[], nameField: string, element: DatabaseTreeItem): any[] {
        const filter = this.folderFilters.get(this.getFolderFilterKey(element));
        if (!filter) { return rows; }
        const filterLower = filter.toLowerCase();
        return rows.filter((row) => (row[nameField] as string).toLowerCase().includes(filterLower));
    }

    // ── Helper: track parent ────────────────────────────────────────────────

    private trackParent<T extends DatabaseTreeItem | ErrorItem>(children: T[], parent: DatabaseTreeItem | undefined): T[] {
        for (const child of children) {
            this.parentMap.set(child, parent);
        }
        return children;
    }

    // ── Connection level ────────────────────────────────────────────────────

    private getConnectionNodes(): (DatabaseTreeItem | ErrorItem)[] {
        const profiles = this.treeQueryService.getProfiles();
        return profiles.map((p) => {
            const isConnected = this.treeQueryService.currentProfileName === p.name;
            const node = new DatabaseTreeItem(
                p.name,
                NodeType.Connection,
                p.name,
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                p.name
            );
            node.description = p.server;
            node.contextValue = isConnected ? "ConnectionConnected" : "ConnectionDisconnected";
            this.parentMap.set(node, undefined);
            return node;
        });
    }

    private getServerFolders(parent: DatabaseTreeItem): DatabaseTreeItem[] {
        const connectionId = parent.connectionId;
        const profileName = parent.profileName;
        const nodes = [ServerFolderType.Databases, ServerFolderType.Security, ServerFolderType.ServerObjects].map((type) => {
            const node = new DatabaseTreeItem(
                type,
                NodeType.ServerFolder,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                profileName
            );
            node.contextValue = type === ServerFolderType.Databases ? "ServerFolderDatabases" : "ServerFolder";
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getServerFolderChildren(element: DatabaseTreeItem): Promise<(DatabaseTreeItem | ErrorItem)[]> {
        switch (element.label) {
            case ServerFolderType.Databases:
                return this.getDatabaseNodes(element);
            case ServerFolderType.Security:
                return this.getSecurityChildren(element);
            case ServerFolderType.ServerObjects:
                return this.getServerObjectsChildren(element);
            default:
                return [];
        }
    }

    // ── Security / Server Objects ───────────────────────────────────────────

    private async getSecurityChildren(parent: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = parent.connectionId;
        const profileName = parent.profileName;

        // Logins
        const loginResults = await this.treeQueryService.execute(
            "SELECT [name], [type_desc], [is_disabled] FROM sys.server_principals WHERE [type] IN ('S','U','G') ORDER BY [name]",
            undefined, profileName
        );
        const loginFolder = new DatabaseTreeItem(
            "Logins",
            NodeType.Folder,
            connectionId,
            loginResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        loginFolder.contextValue = "SecurityLogins";

        // Server Roles
        const roleResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.server_principals WHERE [type] = 'R' ORDER BY [name]",
            undefined, profileName
        );
        const roleFolder = new DatabaseTreeItem(
            "Server Roles",
            NodeType.Folder,
            connectionId,
            roleResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        roleFolder.contextValue = "SecurityServerRoles";

        // Credentials
        const credResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.credentials ORDER BY [name]",
            undefined, profileName
        );
        const credFolder = new DatabaseTreeItem(
            "Credentials",
            NodeType.Folder,
            connectionId,
            credResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        credFolder.contextValue = "SecurityCredentials";

        // Audits
        const auditResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.server_audits ORDER BY [name]",
            undefined, profileName
        );
        const auditFolder = new DatabaseTreeItem(
            "Audits",
            NodeType.Folder,
            connectionId,
            auditResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        auditFolder.contextValue = "SecurityAudits";

        // Server Audit Specifications
        const auditSpecResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.server_audit_specifications ORDER BY [name]",
            undefined, profileName
        );
        const auditSpecFolder = new DatabaseTreeItem(
            "Server Audit Specifications",
            NodeType.Folder,
            connectionId,
            auditSpecResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        auditSpecFolder.contextValue = "SecurityAuditSpecs";

        const folders = [loginFolder, roleFolder, credFolder, auditFolder, auditSpecFolder];
        return this.trackParent(folders, parent);
    }

    private async getServerObjectsChildren(parent: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = parent.connectionId;
        const profileName = parent.profileName;

        // Endpoints
        const endpointResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.endpoints ORDER BY [name]",
            undefined, profileName
        );
        const endpointFolder = new DatabaseTreeItem(
            "Endpoints",
            NodeType.Folder,
            connectionId,
            endpointResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        endpointFolder.contextValue = "ServerEndpoints";

        // Linked Servers
        const linkedResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.servers WHERE is_linked = 1 ORDER BY [name]",
            undefined, profileName
        );
        const linkedFolder = new DatabaseTreeItem(
            "Linked Servers",
            NodeType.Folder,
            connectionId,
            linkedResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        linkedFolder.contextValue = "ServerLinkedServers";

        // Server Triggers
        const triggerResults = await this.treeQueryService.execute(
            "SELECT [name] FROM sys.server_triggers ORDER BY [name]",
            undefined, profileName
        );
        const triggerFolder = new DatabaseTreeItem(
            "Triggers",
            NodeType.Folder,
            connectionId,
            triggerResults.rows.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None,
            undefined, undefined, undefined, undefined, undefined, undefined, profileName
        );
        triggerFolder.contextValue = "ServerTriggers";

        const folders = [endpointFolder, linkedFolder, triggerFolder];
        return this.trackParent(folders, parent);
    }

    private async getServerSubFolderItems(parent: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = parent.connectionId;
        const profileName = parent.profileName;
        const contextValue = parent.contextValue || "";
        let sql = "";
        switch (contextValue) {
            case "SecurityLogins":
                sql = "SELECT [name], [type_desc], [is_disabled] FROM sys.server_principals WHERE [type] IN ('S','U','G') ORDER BY [name]";
                break;
            case "SecurityServerRoles":
                sql = "SELECT [name] FROM sys.server_principals WHERE [type] = 'R' ORDER BY [name]";
                break;
            case "SecurityCredentials":
                sql = "SELECT [name] FROM sys.credentials ORDER BY [name]";
                break;
            case "SecurityAudits":
                sql = "SELECT [name] FROM sys.server_audits ORDER BY [name]";
                break;
            case "SecurityAuditSpecs":
                sql = "SELECT [name] FROM sys.server_audit_specifications ORDER BY [name]";
                break;
            case "ServerEndpoints":
                sql = "SELECT [name] FROM sys.endpoints ORDER BY [name]";
                break;
            case "ServerLinkedServers":
                sql = "SELECT [name] FROM sys.servers WHERE is_linked = 1 ORDER BY [name]";
                break;
            case "ServerTriggers":
                sql = "SELECT [name] FROM sys.server_triggers ORDER BY [name]";
                break;
            default:
                return [];
        }

        const results = await this.treeQueryService.execute(sql, undefined, profileName);
        const nodes = results.rows.map((row) => {
            const label = contextValue === "SecurityLogins" && row.is_disabled
                ? `${row.name} (disabled)`
                : row.name;
            return new DatabaseTreeItem(
                label,
                NodeType.Folder,
                connectionId,
                vscode.TreeItemCollapsibleState.None,
                undefined, undefined, undefined, undefined, undefined, undefined, profileName
            );
        });
        return this.trackParent(nodes, parent);
    }

    // ── Database level ──────────────────────────────────────────────────────

    private async getDatabaseNodes(parent: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = parent.connectionId;
        const profileName = parent.profileName;
        const results = await this.treeQueryService.execute(
            "SELECT [name], [state], [state_desc] FROM sys.databases ORDER BY [name]",
            undefined, profileName
        );
        let rows = results.rows;
        if (this.databaseFilter) {
            const filterLower = this.databaseFilter.toLowerCase();
            rows = rows.filter((row) => (row.name as string).toLowerCase().includes(filterLower));
        }
        const nodes = rows.map((row) => {
            const isOnline = row.state === 0;
            const node = new DatabaseTreeItem(
                row.name,
                NodeType.Database,
                connectionId,
                isOnline
                    ? vscode.TreeItemCollapsibleState.Collapsed
                    : vscode.TreeItemCollapsibleState.None,
                row.name,
                undefined, undefined, undefined, undefined, undefined, profileName
            );
            if (!isOnline) {
                node.contextValue = "DatabaseOffline";
                node.description = `(${row.state_desc})`;
            }
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getDatabaseChildren(element: DatabaseTreeItem): Promise<(DatabaseTreeItem | ErrorItem)[]> {
        const connectionId = element.connectionId;
        const databaseName = element.databaseName!;
        const profileName = element.profileName;
        const children: (DatabaseTreeItem | ErrorItem)[] = [];

        // Add ProjectFolderItem if project path exists for this DB
        const projectPath = this.getProjectPath(profileName!, databaseName);
        if (projectPath) {
            const projectNode = new DatabaseTreeItem(
                `Project: ${projectPath}`,
                NodeType.Folder,
                connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName,
                undefined, undefined, undefined, undefined, undefined,
                profileName, projectPath
            );
            projectNode.contextValue = "ProjectFolder";
            this.parentMap.set(projectNode, element);
            children.push(projectNode);
        }

        // Add schema nodes
        const schemas = await this.getSchemaNodes(element);
        children.push(...schemas);

        return children;
    }

    private getProjectPath(profileName: string, dbName: string): string | null {
        const profile = this.treeQueryService.getProfiles().find(p => p.name === profileName);
        if (!profile) { return null; }
        if (profile.databaseProjects) {
            const path = profile.databaseProjects[dbName] || profile.databaseProjects[dbName.toLowerCase()];
            if (path) { return path; }
        }
        if (profile.projectPath && profile.database.toLowerCase() === dbName.toLowerCase()) {
            return profile.projectPath;
        }
        return null;
    }

    private async getSchemaNodes(parent: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = parent.connectionId;
        const databaseName = parent.databaseName!;
        const profileName = parent.profileName;
        const sql = `
            SELECT s.[name] AS SchemaName,
                   COUNT(*) AS ObjectCount
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE o.[type] IN ('U','V','P','FN','IF','TF','TR')
              AND o.is_ms_shipped = 0
            GROUP BY s.[name]
            ORDER BY s.[name]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const node = new DatabaseTreeItem(
                row.SchemaName,
                NodeType.Schema,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                row.SchemaName,
                undefined, undefined, undefined, undefined, profileName
            );
            node.description = `(${row.ObjectCount})`;
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getSchemaFolders(element: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = element.connectionId;
        const databaseName = element.databaseName!;
        const schemaName = element.schemaName!;
        const profileName = element.profileName;

        const countSql = `
            SELECT
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[TABLES]
                 WHERE [TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND [TABLE_TYPE] = 'BASE TABLE') AS TableCount,
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[TABLES]
                 WHERE [TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND [TABLE_TYPE] = 'VIEW') AS ViewCount,
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[ROUTINES]
                 WHERE [ROUTINE_SCHEMA] = '${escapeSql(schemaName)}' AND [ROUTINE_TYPE] = 'FUNCTION') AS FunctionCount,
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[ROUTINES]
                 WHERE [ROUTINE_SCHEMA] = '${escapeSql(schemaName)}' AND [ROUTINE_TYPE] = 'PROCEDURE') AS ProcedureCount,
                (SELECT COUNT(*) FROM sys.triggers t
                 INNER JOIN sys.objects o ON t.parent_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND t.parent_class = 1) AS TriggerCount
        `;
        const results = await this.treeQueryService.execute(countSql, databaseName, profileName);
        const counts = results.rows[0];
        const folders: DatabaseTreeItem[] = [];

        const addFolder = (type: FolderType, count: number) => {
            if (count === 0) { return; }
            const node = new DatabaseTreeItem(
                type,
                NodeType.Folder,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                schemaName,
                type,
                undefined, undefined, undefined, profileName
            );
            node.description = `(${count})`;
            node.contextValue = `SchemaFolder${type}`;
            folders.push(node);
        };

        addFolder(FolderType.Tables, counts.TableCount);
        addFolder(FolderType.Views, counts.ViewCount);
        addFolder(FolderType.Functions, counts.FunctionCount);
        addFolder(FolderType.Procedures, counts.ProcedureCount);
        addFolder(FolderType.Triggers, counts.TriggerCount);

        return this.trackParent(folders, element);
    }

    // ── Object level ────────────────────────────────────────────────────────

    private async getFolderChildren(element: DatabaseTreeItem): Promise<(DatabaseTreeItem | ErrorItem)[]> {
        const connectionId = element.connectionId;

        // Security / Server Objects sub-folders
        const ctx = element.contextValue || "";
        if (ctx.startsWith("Security") || ctx.startsWith("Server")) {
            return this.getServerSubFolderItems(element);
        }

        const databaseName = element.databaseName!;
        const schemaName = element.schemaName;

        switch (element.folderType) {
            case FolderType.Tables:
                return this.getTableNodes(connectionId, databaseName, schemaName!, element);
            case FolderType.Views:
                return this.getViewNodes(connectionId, databaseName, schemaName!, element);
            case FolderType.Functions:
                return this.getFunctionNodes(connectionId, databaseName, schemaName!, element);
            case FolderType.Procedures:
                return this.getProcedureNodes(connectionId, databaseName, schemaName!, element);
            case FolderType.Triggers:
                return this.getDmlTriggerNodes(connectionId, databaseName, schemaName!, element);
            case FolderType.TableValuedFunctions:
            case FolderType.ScalarFunctions:
            case FolderType.AggregateFunctions:
            case FolderType.SystemFunctions:
                return this.getFunctionSubNodes(connectionId, databaseName, schemaName!, element.folderType!, element);
            case FolderType.Columns:
                return this.getColumnNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            case FolderType.Keys:
                return this.getKeyNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            case FolderType.Constraints:
                return this.getConstraintNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            case FolderType.Indexes:
                return this.getIndexNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            case FolderType.Statistics:
                return this.getStatisticsNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            case FolderType.Parameters:
                return this.getParameterNodes(connectionId, databaseName, schemaName!, element.objectName!, element);
            default:
                return [];
        }
    }

    private async getTableNodes(
        connectionId: string, databaseName: string, schemaName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT t.[TABLE_NAME],
                   (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[COLUMNS] c
                    WHERE c.[TABLE_SCHEMA] = t.[TABLE_SCHEMA] AND c.[TABLE_NAME] = t.[TABLE_NAME]) AS ColumnCount
            FROM [INFORMATION_SCHEMA].[TABLES] t
            WHERE t.[TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND t.[TABLE_TYPE] = 'BASE TABLE'
            ORDER BY t.[TABLE_NAME]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = this.applyFolderFilter(results.rows, "TABLE_NAME", parent).map((row) => {
            const node = new DatabaseTreeItem(
                row.TABLE_NAME,
                NodeType.Table,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                schemaName,
                undefined,
                row.TABLE_NAME,
                undefined, undefined, profileName
            );
            node.description = `(${row.ColumnCount})`;
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getViewNodes(
        connectionId: string, databaseName: string, schemaName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT [TABLE_NAME] FROM [INFORMATION_SCHEMA].[TABLES]
            WHERE [TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND [TABLE_TYPE] = 'VIEW'
            ORDER BY [TABLE_NAME]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = this.applyFolderFilter(results.rows, "TABLE_NAME", parent).map((row) =>
            new DatabaseTreeItem(
                row.TABLE_NAME,
                NodeType.View,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                schemaName,
                undefined,
                row.TABLE_NAME,
                undefined, undefined, profileName
            )
        );
        return this.trackParent(nodes, parent);
    }

    private async getFunctionNodes(
        connectionId: string, databaseName: string, schemaName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const countSql = `
            SELECT
                (SELECT COUNT(*) FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[type] = 'IF' AND o.is_ms_shipped = 0) +
                (SELECT COUNT(*) FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[type] = 'TF' AND o.is_ms_shipped = 0) AS TableValuedCount,
                (SELECT COUNT(*) FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[type] = 'FN' AND o.is_ms_shipped = 0) AS ScalarCount,
                (SELECT COUNT(*) FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[type] = 'AF' AND o.is_ms_shipped = 0) AS AggregateCount,
                (SELECT COUNT(*) FROM sys.objects o
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[type] IN ('FN','IF','TF') AND o.is_ms_shipped = 1) AS SystemCount
        `;
        const results = await this.treeQueryService.execute(countSql, databaseName, profileName);
        const c = results.rows[0];
        const folders: DatabaseTreeItem[] = [];

        const addFolder = (type: FolderType, count: number) => {
            const node = new DatabaseTreeItem(
                type, NodeType.Folder, connectionId,
                count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, type,
                undefined, undefined, undefined, profileName
            );
            node.description = `(${count})`;
            node.contextValue = `FuncFolder${type === FolderType.TableValuedFunctions ? "TV" : type === FolderType.ScalarFunctions ? "SC" : type === FolderType.AggregateFunctions ? "AG" : "SY"}`;
            folders.push(node);
        };

        addFolder(FolderType.TableValuedFunctions, c.TableValuedCount);
        addFolder(FolderType.ScalarFunctions, c.ScalarCount);
        addFolder(FolderType.AggregateFunctions, c.AggregateCount);
        addFolder(FolderType.SystemFunctions, c.SystemCount);

        return this.trackParent(folders, parent);
    }

    private async getFunctionSubNodes(
        connectionId: string, databaseName: string, schemaName: string, subType: FolderType, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        let typeFilter: string;
        let isSystem = false;
        switch (subType) {
            case FolderType.TableValuedFunctions:
                typeFilter = "o.[type] IN ('IF','TF') AND o.is_ms_shipped = 0";
                break;
            case FolderType.ScalarFunctions:
                typeFilter = "o.[type] = 'FN' AND o.is_ms_shipped = 0";
                break;
            case FolderType.AggregateFunctions:
                typeFilter = "o.[type] = 'AF' AND o.is_ms_shipped = 0";
                break;
            case FolderType.SystemFunctions:
                typeFilter = "o.[type] IN ('FN','IF','TF') AND o.is_ms_shipped = 1";
                isSystem = true;
                break;
            default:
                return [];
        }
        const sql = `
            SELECT o.[name] AS ROUTINE_NAME
            FROM sys.objects o
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND ${typeFilter}
            ORDER BY o.[name]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = this.applyFolderFilter(results.rows, "ROUTINE_NAME", parent).map((row) =>
            new DatabaseTreeItem(
                row.ROUTINE_NAME,
                NodeType.Function,
                connectionId,
                isSystem ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                schemaName,
                undefined,
                row.ROUTINE_NAME,
                undefined, undefined, profileName
            )
        );
        return this.trackParent(nodes, parent);
    }

    private async getProcedureNodes(
        connectionId: string, databaseName: string, schemaName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT [ROUTINE_NAME] FROM [INFORMATION_SCHEMA].[ROUTINES]
            WHERE [ROUTINE_SCHEMA] = '${escapeSql(schemaName)}' AND [ROUTINE_TYPE] = 'PROCEDURE'
            ORDER BY [ROUTINE_NAME]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = this.applyFolderFilter(results.rows, "ROUTINE_NAME", parent).map((row) =>
            new DatabaseTreeItem(
                row.ROUTINE_NAME,
                NodeType.Procedure,
                connectionId,
                vscode.TreeItemCollapsibleState.Collapsed,
                databaseName,
                schemaName,
                undefined,
                row.ROUTINE_NAME,
                undefined, undefined, profileName
            )
        );
        return this.trackParent(nodes, parent);
    }

    private async getDmlTriggerNodes(
        connectionId: string, databaseName: string, schemaName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT t.[name] AS TriggerName
            FROM sys.triggers t
            INNER JOIN sys.objects o ON t.parent_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND t.parent_class = 1
            ORDER BY t.[name]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = this.applyFolderFilter(results.rows, "TriggerName", parent).map((row) =>
            new DatabaseTreeItem(
                row.TriggerName,
                NodeType.Trigger,
                connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName,
                schemaName,
                undefined, undefined, undefined, undefined, profileName
            )
        );
        return this.trackParent(nodes, parent);
    }

    // ── Leaf level ──────────────────────────────────────────────────────────

    private async getTableChildren(element: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = element.connectionId;
        const databaseName = element.databaseName!;
        const schemaName = element.schemaName!;
        const tableName = element.objectName!;
        const profileName = element.profileName;

        const countSql = `
            SELECT
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[COLUMNS]
                 WHERE [TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND [TABLE_NAME] = '${escapeSql(tableName)}') AS ColumnCount,
                (SELECT COUNT(*) FROM sys.key_constraints kc
                 INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}') +
                (SELECT COUNT(*) FROM sys.foreign_keys fk
                 INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}') AS KeyCount,
                (SELECT COUNT(*) FROM sys.check_constraints cc
                 INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}') +
                (SELECT COUNT(*) FROM sys.default_constraints dc
                 INNER JOIN sys.objects o ON dc.parent_object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}') AS ConstraintCount,
                (SELECT COUNT(*) FROM sys.triggers t
                 INNER JOIN sys.objects o ON t.parent_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}' AND t.parent_class = 1) AS TriggerCount,
                (SELECT COUNT(*) FROM sys.indexes i
                 INNER JOIN sys.objects o ON i.object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}' AND i.[name] IS NOT NULL) AS IndexCount,
                (SELECT COUNT(*) FROM sys.stats st
                 INNER JOIN sys.objects o ON st.object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}') AS StatCount
        `;
        const results = await this.treeQueryService.execute(countSql, databaseName, profileName);
        const c = results.rows[0];
        const folders: DatabaseTreeItem[] = [];

        const addFolder = (type: FolderType, count: number) => {
            const node = new DatabaseTreeItem(
                type, NodeType.Folder, connectionId,
                count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, type, tableName,
                undefined, undefined, profileName
            );
            node.description = `(${count})`;
            folders.push(node);
        };

        addFolder(FolderType.Columns, c.ColumnCount);
        addFolder(FolderType.Keys, c.KeyCount);
        addFolder(FolderType.Constraints, c.ConstraintCount);
        addFolder(FolderType.Triggers, c.TriggerCount);
        addFolder(FolderType.Indexes, c.IndexCount);
        addFolder(FolderType.Statistics, c.StatCount);

        return this.trackParent(folders, element);
    }

    private async getViewChildren(element: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = element.connectionId;
        const databaseName = element.databaseName!;
        const schemaName = element.schemaName!;
        const viewName = element.objectName!;
        const profileName = element.profileName;

        const countSql = `
            SELECT
                (SELECT COUNT(*) FROM [INFORMATION_SCHEMA].[COLUMNS]
                 WHERE [TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND [TABLE_NAME] = '${escapeSql(viewName)}') AS ColumnCount,
                (SELECT COUNT(*) FROM sys.triggers t
                 INNER JOIN sys.objects o ON t.parent_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(viewName)}' AND t.parent_class = 1) AS TriggerCount,
                (SELECT COUNT(*) FROM sys.indexes i
                 INNER JOIN sys.objects o ON i.object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(viewName)}' AND i.[name] IS NOT NULL) AS IndexCount,
                (SELECT COUNT(*) FROM sys.stats st
                 INNER JOIN sys.objects o ON st.object_id = o.object_id
                 INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
                 WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(viewName)}') AS StatCount
        `;
        const results = await this.treeQueryService.execute(countSql, databaseName, profileName);
        const c = results.rows[0];
        const folders: DatabaseTreeItem[] = [];

        const addFolder = (type: FolderType, count: number) => {
            const node = new DatabaseTreeItem(
                type, NodeType.Folder, connectionId,
                count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, type, viewName,
                undefined, undefined, profileName
            );
            node.description = `(${count})`;
            folders.push(node);
        };

        addFolder(FolderType.Columns, c.ColumnCount);
        addFolder(FolderType.Triggers, c.TriggerCount);
        addFolder(FolderType.Indexes, c.IndexCount);
        addFolder(FolderType.Statistics, c.StatCount);

        return this.trackParent(folders, element);
    }

    private async getColumnNodes(
        connectionId: string, databaseName: string, schemaName: string, tableName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT
                c.[COLUMN_NAME],
                c.[DATA_TYPE],
                c.[CHARACTER_MAXIMUM_LENGTH],
                c.[IS_NULLABLE],
                CASE WHEN pk.[COLUMN_NAME] IS NOT NULL THEN 1 ELSE 0 END AS IsPrimaryKey
            FROM [INFORMATION_SCHEMA].[COLUMNS] c
            LEFT JOIN (
                SELECT ku.[COLUMN_NAME]
                FROM [INFORMATION_SCHEMA].[TABLE_CONSTRAINTS] tc
                INNER JOIN [INFORMATION_SCHEMA].[KEY_COLUMN_USAGE] ku
                    ON tc.[CONSTRAINT_NAME] = ku.[CONSTRAINT_NAME]
                WHERE tc.[TABLE_SCHEMA] = '${escapeSql(schemaName)}'
                    AND tc.[TABLE_NAME] = '${escapeSql(tableName)}'
                    AND tc.[CONSTRAINT_TYPE] = 'PRIMARY KEY'
            ) pk ON c.[COLUMN_NAME] = pk.[COLUMN_NAME]
            WHERE c.[TABLE_SCHEMA] = '${escapeSql(schemaName)}' AND c.[TABLE_NAME] = '${escapeSql(tableName)}'
            ORDER BY c.[ORDINAL_POSITION]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const dataType = row.CHARACTER_MAXIMUM_LENGTH
                ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH})`
                : row.DATA_TYPE;
            const pkPrefix = row.IsPrimaryKey ? "\u{1F511} " : "";
            const metadata: ColumnMetadata = {
                name: row.COLUMN_NAME,
                dataType: dataType,
                maxLength: row.CHARACTER_MAXIMUM_LENGTH,
                isNullable: row.IS_NULLABLE === "YES",
                isPrimaryKey: row.IsPrimaryKey === 1,
            };
            return new DatabaseTreeItem(
                `${pkPrefix}${row.COLUMN_NAME} (${dataType})`,
                NodeType.Column,
                connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName,
                schemaName,
                undefined,
                tableName,
                metadata,
                undefined, profileName
            );
        });
        return this.trackParent(nodes, parent);
    }

    private async getIndexNodes(
        connectionId: string, databaseName: string, schemaName: string, tableName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT
                i.[name] AS IndexName,
                i.[type_desc] AS IndexType,
                i.[is_unique] AS IsUnique,
                i.[is_primary_key] AS IsPrimaryKey
            FROM sys.indexes i
            INNER JOIN sys.objects o ON i.[object_id] = o.[object_id]
            INNER JOIN sys.schemas s ON o.[schema_id] = s.[schema_id]
            WHERE s.[name] = '${escapeSql(schemaName)}'
                AND o.[name] = '${escapeSql(tableName)}'
                AND i.[name] IS NOT NULL
            ORDER BY i.[name]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const suffix = row.IsPrimaryKey ? " (PRIMARY)" : row.IsUnique ? " (UNIQUE)" : "";
            const metadata: IndexMetadata = {
                name: row.IndexName,
                type: row.IndexType,
                isUnique: row.IsUnique,
                isPrimaryKey: row.IsPrimaryKey,
            };
            return new DatabaseTreeItem(
                `${row.IndexName}${suffix}`,
                NodeType.Index,
                connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName,
                schemaName,
                undefined,
                tableName,
                undefined,
                metadata, profileName
            );
        });
        return this.trackParent(nodes, parent);
    }

    private async getKeyNodes(
        connectionId: string, databaseName: string, schemaName: string, tableName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT kc.[name] AS KeyName, kc.[type_desc] AS KeyType
            FROM sys.key_constraints kc
            INNER JOIN sys.objects o ON kc.parent_object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}'
            UNION ALL
            SELECT fk.[name] AS KeyName, 'FOREIGN_KEY_CONSTRAINT' AS KeyType
            FROM sys.foreign_keys fk
            INNER JOIN sys.objects o ON fk.parent_object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}'
            ORDER BY KeyName
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const typeLabel = row.KeyType === "PRIMARY_KEY_CONSTRAINT" ? "PK"
                : row.KeyType === "UNIQUE_CONSTRAINT" ? "UQ" : "FK";
            return new DatabaseTreeItem(
                `${row.KeyName} (${typeLabel})`,
                NodeType.Folder, connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, undefined, tableName,
                undefined, undefined, profileName
            );
        });
        return this.trackParent(nodes, parent);
    }

    private async getConstraintNodes(
        connectionId: string, databaseName: string, schemaName: string, tableName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT cc.[name] AS ConstraintName, 'CHECK' AS ConstraintType, cc.[definition] AS Detail
            FROM sys.check_constraints cc
            INNER JOIN sys.objects o ON cc.parent_object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}'
            UNION ALL
            SELECT dc.[name] AS ConstraintName, 'DEFAULT' AS ConstraintType, dc.[definition] AS Detail
            FROM sys.default_constraints dc
            INNER JOIN sys.objects o ON dc.parent_object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(tableName)}'
            ORDER BY ConstraintName
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const typeLabel = row.ConstraintType === "CHECK" ? "CK" : "DF";
            const node = new DatabaseTreeItem(
                `${row.ConstraintName} (${typeLabel})`,
                NodeType.Folder, connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, undefined, tableName,
                undefined, undefined, profileName
            );
            node.tooltip = row.Detail;
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getStatisticsNodes(
        connectionId: string, databaseName: string, schemaName: string, objectName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT st.[name] AS StatName, st.auto_created AS AutoCreated
            FROM sys.stats st
            INNER JOIN sys.objects o ON st.object_id = o.object_id
            INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
            WHERE s.[name] = '${escapeSql(schemaName)}' AND o.[name] = '${escapeSql(objectName)}'
            ORDER BY st.[name]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const node = new DatabaseTreeItem(
                row.StatName,
                NodeType.Folder, connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, undefined, objectName,
                undefined, undefined, profileName
            );
            if (row.AutoCreated) { node.description = "(Auto)"; }
            return node;
        });
        return this.trackParent(nodes, parent);
    }

    private async getRoutineChildren(element: DatabaseTreeItem): Promise<DatabaseTreeItem[]> {
        const connectionId = element.connectionId;
        const databaseName = element.databaseName!;
        const schemaName = element.schemaName!;
        const routineName = element.objectName!;
        const profileName = element.profileName;

        const sql = `
            SELECT COUNT(*) AS ParamCount
            FROM [INFORMATION_SCHEMA].[PARAMETERS]
            WHERE [SPECIFIC_SCHEMA] = '${escapeSql(schemaName)}' AND [SPECIFIC_NAME] = '${escapeSql(routineName)}'
                AND [PARAMETER_MODE] IS NOT NULL
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const paramCount = results.rows[0]?.ParamCount || 0;

        const paramFolder = new DatabaseTreeItem(
            FolderType.Parameters, NodeType.Folder, connectionId,
            paramCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            databaseName, schemaName, FolderType.Parameters, routineName,
            undefined, undefined, profileName
        );
        paramFolder.description = `(${paramCount})`;
        this.parentMap.set(paramFolder, element);

        // For functions, also show return type
        if (element.nodeType === NodeType.Function) {
            const retSql = `
                SELECT [DATA_TYPE] FROM [INFORMATION_SCHEMA].[PARAMETERS]
                WHERE [SPECIFIC_SCHEMA] = '${escapeSql(schemaName)}' AND [SPECIFIC_NAME] = '${escapeSql(routineName)}'
                    AND [PARAMETER_MODE] IS NULL AND [IS_RESULT] = 'YES'
            `;
            try {
                const retResults = await this.treeQueryService.execute(retSql, databaseName, profileName);
                if (retResults.rows.length > 0) {
                    const retNode = new DatabaseTreeItem(
                        `Returns ${retResults.rows[0].DATA_TYPE}`,
                        NodeType.Folder, connectionId,
                        vscode.TreeItemCollapsibleState.None,
                        databaseName, schemaName,
                        undefined, undefined, undefined, undefined, profileName
                    );
                    this.parentMap.set(retNode, element);
                    return [paramFolder, retNode];
                }
            } catch { /* ignore */ }
        }

        return [paramFolder];
    }

    private async getParameterNodes(
        connectionId: string, databaseName: string, schemaName: string, routineName: string, parent: DatabaseTreeItem
    ): Promise<DatabaseTreeItem[]> {
        const profileName = parent.profileName;
        const sql = `
            SELECT
                [PARAMETER_NAME],
                [DATA_TYPE],
                [CHARACTER_MAXIMUM_LENGTH],
                [PARAMETER_MODE]
            FROM [INFORMATION_SCHEMA].[PARAMETERS]
            WHERE [SPECIFIC_SCHEMA] = '${escapeSql(schemaName)}' AND [SPECIFIC_NAME] = '${escapeSql(routineName)}'
                AND [PARAMETER_MODE] IS NOT NULL
            ORDER BY [ORDINAL_POSITION]
        `;
        const results = await this.treeQueryService.execute(sql, databaseName, profileName);
        const nodes = results.rows.map((row) => {
            const dataType = row.CHARACTER_MAXIMUM_LENGTH
                ? `${row.DATA_TYPE}(${row.CHARACTER_MAXIMUM_LENGTH})`
                : row.DATA_TYPE;
            const mode = row.PARAMETER_MODE === "INOUT" ? "OUTPUT" : "";
            const label = mode
                ? `${row.PARAMETER_NAME} (${dataType}, ${mode})`
                : `${row.PARAMETER_NAME} (${dataType})`;
            return new DatabaseTreeItem(
                label,
                NodeType.Folder, connectionId,
                vscode.TreeItemCollapsibleState.None,
                databaseName, schemaName, undefined, routineName,
                undefined, undefined, profileName
            );
        });
        return this.trackParent(nodes, parent);
    }
}
