import * as vscode from "vscode";
import { NodeType, DatabaseTreeItem } from "../models/DatabaseNode";

export class IconManager {
    private iconsUri: vscode.Uri;

    constructor(extensionUri: vscode.Uri) {
        this.iconsUri = vscode.Uri.joinPath(extensionUri, "resources", "icons");
    }

    public getIcon(item: DatabaseTreeItem): vscode.ThemeIcon | { light: vscode.Uri; dark: vscode.Uri } | undefined {
        if (item.contextValue === "ProjectFolder") {
            return new vscode.ThemeIcon("folder-library", new vscode.ThemeColor("charts.green"));
        }

        const iconName = this.getIconName(item);
        if (!iconName) {
            return undefined;
        }
        const iconUri = vscode.Uri.joinPath(this.iconsUri, `${iconName}.svg`);
        return {
            light: iconUri,
            dark: iconUri
        };
    }

    private getIconName(item: DatabaseTreeItem): string | undefined {
        switch (item.nodeType) {
            case NodeType.Connection:
                return item.contextValue === "ConnectionConnected"
                    ? "SqlServerConnected"
                    : "icons8-sql-server";
            case NodeType.ServerFolder:
                return "icons8-folder";
            case NodeType.Database:
                return item.contextValue === "DatabaseOffline"
                    ? "DatabaseOffline"
                    : "Database";
            case NodeType.Schema:
                return "Schema";
            case NodeType.Table:
                return "Table";
            case NodeType.View:
                return "View";
            case NodeType.Column:
                return item.columnMetadata?.isPrimaryKey ? "ColumnKey" : "Column";
            case NodeType.Index:
                return "Index";
            case NodeType.Function:
                return "Function";
            case NodeType.Procedure:
                return "Procedure";
            case NodeType.Trigger:
                return "Trigger";
            case NodeType.Folder:
                return "icons8-folder";
            default:
                return undefined;
        }
    }
}
