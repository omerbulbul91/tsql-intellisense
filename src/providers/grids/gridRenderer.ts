import * as vscode from 'vscode';

export interface GridRenderResult {
    /** Folders under node_modules that webview needs access to */
    resourceRoots: vscode.Uri[];
    /** <link> / <script src> tags for the grid library */
    headHtml: string;
    /** VS Code theme override CSS (inside <style>) */
    themeStyles: string;
    /**
     * JavaScript that:
     *  1. Initialises grids into the containers (#grid-0, #grid-1 …)
     *  2. Exposes `window.gridApi` so common toolbar / copy / shortcut code works
     */
    initScript: string;
}

export interface GridRenderer {
    render(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): GridRenderResult;
}

/** Factory — returns the renderer selected by the user setting */
export function createGridRenderer(gridLibrary: string): GridRenderer {
    switch (gridLibrary) {
        case 'ag-grid':
            return new (require('./agGridRenderer').AgGridRenderer)();
        case 'handsontable':
            return new (require('./handsontableRenderer').HandsontableRenderer)();
        case 'tabulator':
        default:
            return new (require('./tabulatorRenderer').TabulatorRenderer)();
    }
}
