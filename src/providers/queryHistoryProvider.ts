import * as vscode from 'vscode';

/** A single query history entry */
export interface QueryHistoryEntry {
    /** Unique id */
    id: string;
    /** File name (e.g. SQLQuery25.sql) */
    fileName: string;
    /** Full file path */
    filePath: string;
    /** SQL text */
    sql: string;
    /** Connection profile name */
    connectionName: string;
    /** Database name */
    databaseName: string;
    /** Execution timestamp (ISO string) */
    timestamp: string;
}

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older';

type TreeNode = DateGroupItem | FileGroupItem | HistoryEntryItem;

/** Tree item: date group header (Today, Yesterday, ...) */
class DateGroupItem extends vscode.TreeItem {
    constructor(public readonly group: DateGroup, label: string, count: number) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${count}`;
        this.contextValue = 'dateGroup';
        this.iconPath = new vscode.ThemeIcon('calendar');
    }
}

/** Tree item: file name group (all entries with same fileName in same date group) */
class FileGroupItem extends vscode.TreeItem {
    public readonly entries: QueryHistoryEntry[];
    /** Most recent entry */
    public readonly entry: QueryHistoryEntry;
    public readonly dateGroup: DateGroup;

    constructor(fileName: string, entries: QueryHistoryEntry[], dateGroup: DateGroup) {
        const hasMultiple = entries.length > 1;
        super(
            fileName,
            hasMultiple
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.entries = entries;
        this.entry = entries[0]; // newest first
        this.dateGroup = dateGroup;

        // Sort desc by timestamp (newest first)
        entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const latest = entries[0];
        const times = entries.map(e => {
            const d = new Date(e.timestamp);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        });
        this.description = `${times.join(', ')}    ${latest.connectionName}  ${latest.databaseName}`;

        // Tooltip: SQL preview of the most recent entry
        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendCodeblock(latest.sql.substring(0, 2000), 'sql');

        this.iconPath = new vscode.ThemeIcon('file');
        this.contextValue = 'historyEntry';

        // Command for click handling (single/double detected in extension.ts)
        this.command = {
            command: 'tsql-intellisense.historyItemClicked',
            title: '',
            arguments: [latest],
        };
    }
}

/** Tree item: individual history entry (child of FileGroupItem when multiple exist) */
class HistoryEntryItem extends vscode.TreeItem {
    public readonly entry: QueryHistoryEntry;

    constructor(entry: QueryHistoryEntry) {
        const d = new Date(entry.timestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        super(timeStr, vscode.TreeItemCollapsibleState.None);

        this.entry = entry;
        this.description = `${entry.connectionName}  ${entry.databaseName}`;

        this.tooltip = new vscode.MarkdownString();
        this.tooltip.appendCodeblock(entry.sql.substring(0, 2000), 'sql');

        this.iconPath = new vscode.ThemeIcon('debug-stackframe-dot');
        this.contextValue = 'historyEntry';

        this.command = {
            command: 'tsql-intellisense.historyItemClicked',
            title: '',
            arguments: [entry],
        };
    }
}

export class QueryHistoryProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private entries: QueryHistoryEntry[] = [];
    private readonly STORAGE_KEY = 'tsql-intellisense.queryHistory';

    constructor(private globalState: vscode.Memento) {
        this.entries = globalState.get<QueryHistoryEntry[]>(this.STORAGE_KEY, []);
        this.cleanupOldEntries();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!this.isEnabled()) {
            return [];
        }

        if (!element) {
            return this.getDateGroups();
        }

        if (element instanceof DateGroupItem) {
            return this.getFileGroupsForDate(element.group);
        }

        if (element instanceof FileGroupItem && element.entries.length > 1) {
            return element.entries.map(e => new HistoryEntryItem(e));
        }

        return [];
    }

    /** Add a new history entry */
    addEntry(entry: Omit<QueryHistoryEntry, 'id' | 'timestamp'>): void {
        if (!this.isEnabled()) { return; }

        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const maxSize = config.get<number>('queryHistory.maxQuerySize', 1048576);

        if (entry.sql.length > maxSize) { return; }

        const newEntry: QueryHistoryEntry = {
            ...entry,
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toISOString(),
        };

        this.entries.unshift(newEntry);

        const maxEntries = config.get<number>('queryHistory.maxEntries', 100);
        if (this.entries.length > maxEntries) {
            this.entries = this.entries.slice(0, maxEntries);
        }

        this.save();
        this._onDidChangeTreeData.fire();
    }

    /** Delete a single entry by id */
    deleteEntry(id: string): void {
        this.entries = this.entries.filter(e => e.id !== id);
        this.save();
        this._onDidChangeTreeData.fire();
    }

    /** Clear all history */
    clearAll(): void {
        this.entries = [];
        this.save();
        this._onDidChangeTreeData.fire();
    }

    /** Refresh the tree view */
    refresh(): void {
        this.cleanupOldEntries();
        this._onDidChangeTreeData.fire();
    }

    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration('tsql-intellisense')
            .get<boolean>('queryHistory.enabled', true);
    }

    private save(): void {
        this.globalState.update(this.STORAGE_KEY, this.entries);
    }

    private cleanupOldEntries(): void {
        const config = vscode.workspace.getConfiguration('tsql-intellisense');
        const retentionDays = config.get<number>('queryHistory.retentionDays', 7);
        if (retentionDays <= 0) { return; }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const cutoffTime = cutoff.getTime();

        const before = this.entries.length;
        this.entries = this.entries.filter(e => new Date(e.timestamp).getTime() > cutoffTime);
        if (this.entries.length !== before) {
            this.save();
        }
    }

    private getDateGroup(timestamp: string): DateGroup {
        const date = new Date(timestamp);
        const now = new Date();

        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekStart = new Date(today);
        weekStart.setDate(weekStart.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));

        if (date >= today) { return 'today'; }
        if (date >= yesterday) { return 'yesterday'; }
        if (date >= weekStart) { return 'thisWeek'; }
        return 'older';
    }

    private getDateGroups(): DateGroupItem[] {
        const groupLabels: Record<DateGroup, string> = {
            today: 'Today',
            yesterday: 'Yesterday',
            thisWeek: 'This Week',
            older: 'Older',
        };

        const dateEntries = new Map<DateGroup, QueryHistoryEntry[]>();
        for (const entry of this.entries) {
            const dg = this.getDateGroup(entry.timestamp);
            if (!dateEntries.has(dg)) { dateEntries.set(dg, []); }
            dateEntries.get(dg)!.push(entry);
        }

        const order: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'older'];
        return order
            .filter(g => dateEntries.has(g))
            .map(g => {
                const fileGroups = this.groupByFileName(dateEntries.get(g)!);
                return new DateGroupItem(g, groupLabels[g], fileGroups.length);
            });
    }

    /** Group entries by fileName only */
    private groupByFileName(entries: QueryHistoryEntry[]): QueryHistoryEntry[][] {
        const map = new Map<string, QueryHistoryEntry[]>();
        for (const e of entries) {
            if (!map.has(e.fileName)) { map.set(e.fileName, []); }
            map.get(e.fileName)!.push(e);
        }
        return Array.from(map.values());
    }

    private getFileGroupsForDate(group: DateGroup): FileGroupItem[] {
        const dateEntries = this.entries.filter(e => this.getDateGroup(e.timestamp) === group);
        const fileGroups = this.groupByFileName(dateEntries);
        return fileGroups.map(g => new FileGroupItem(g[0].fileName, g, group));
    }
}
