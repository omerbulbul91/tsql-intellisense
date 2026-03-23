import * as vscode from 'vscode';
import { GridRenderer, GridRenderResult } from './gridRenderer';

export class TabulatorRenderer implements GridRenderer {
    render(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): GridRenderResult {
        const base = vscode.Uri.joinPath(extensionUri, 'node_modules', 'tabulator-tables', 'dist');
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'js', 'tabulator.min.js'));
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'css', 'tabulator_midnight.min.css'));

        return {
            resourceRoots: [vscode.Uri.joinPath(extensionUri, 'node_modules', 'tabulator-tables')],
            headHtml: `<link rel="stylesheet" href="${cssUri}">`,
            themeStyles: TabulatorRenderer.themeStyles(),
            initScript: `<script src="${jsUri}"></script>\n<script>\n${TabulatorRenderer.initScript(resultSets, isStacked)}\n</script>`,
        };
    }

    private static themeStyles(): string {
        return `
    /* ── Tabulator VS Code theme overrides ────────── */
    .tabulator {
        background: var(--vscode-editor-background) !important;
        border: none !important;
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif) !important;
        font-size: 12px !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator .tabulator-header {
        background: var(--vscode-editorWidget-background) !important;
        border-bottom: 2px solid var(--vscode-editorWidget-border) !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator .tabulator-header .tabulator-col {
        background: var(--vscode-editorWidget-background) !important;
        border-right: 1px solid var(--vscode-editorWidget-border) !important;
    }
    .tabulator .tabulator-header .tabulator-col:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-col-content {
        padding: 2px 6px !important;
    }
    .tabulator .tabulator-tableholder {
        background: var(--vscode-editor-background) !important;
    }
    .tabulator-row {
        border-bottom: 1px solid var(--vscode-editorWidget-border) !important;
        background: var(--vscode-editor-background) !important;
        color: var(--vscode-foreground) !important;
    }
    .tabulator-row:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .tabulator-row.tabulator-selected {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
    }
    .tabulator-row .tabulator-cell {
        border-right: 1px solid var(--vscode-editorWidget-border) !important;
        padding: 2px 8px !important;
    }
    .tabulator-row .tabulator-cell.cell-selected {
        background: rgba(0, 120, 212, 0.15) !important;
    }
    .tabulator-row .tabulator-cell.cell-active {
        outline: 2px solid var(--vscode-focusBorder) !important;
        outline-offset: -2px;
    }
    .tabulator-row .tabulator-cell.null-val {
        color: var(--vscode-descriptionForeground) !important;
        font-style: italic;
    }
    .tabulator .tabulator-footer {
        background: var(--vscode-editorWidget-background) !important;
        border-top: 1px solid var(--vscode-editorWidget-border) !important;
        color: var(--vscode-descriptionForeground) !important;
    }
    /* checkbox styling */
    .tabulator-row .tabulator-cell input[type="checkbox"] {
        accent-color: var(--vscode-focusBorder);
        cursor: pointer;
    }
    /* ── Header: title + sort + filter icon inline ── */
    .tabulator .tabulator-header .tabulator-col .tabulator-col-title-holder {
        display: flex !important;
        align-items: center !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-col-title {
        flex: 1 !important;
    }
    .tabulator-header-popup-button { display: none !important; }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter {
        margin-top: 2px !important;
        padding: 0 !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input {
        width: 100% !important;
        height: 18px !important;
        padding: 1px 5px !important;
        font-size: 10px !important;
        background: transparent !important;
        color: var(--vscode-input-foreground) !important;
        border: 1px solid transparent !important;
        border-bottom: 1px solid var(--vscode-editorWidget-border) !important;
        border-radius: 0 !important;
        outline: none !important;
        transition: border-color 0.15s, background 0.15s;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input:focus {
        background: var(--vscode-input-background) !important;
        border: 1px solid var(--vscode-focusBorder) !important;
        border-radius: 2px !important;
    }
    .tabulator .tabulator-header .tabulator-col .tabulator-header-filter input::placeholder {
        color: var(--vscode-descriptionForeground) !important;
        opacity: 0.4 !important;
    }
    /* ── Context menu (native look) ──────────────── */
    .tabulator-popup.tabulator-menu {
        background: rgba(43, 43, 43, 0.95) !important;
        backdrop-filter: blur(12px) !important;
        -webkit-backdrop-filter: blur(12px) !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        border-radius: 8px !important;
        padding: 4px !important;
        min-width: 220px !important;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3) !important;
    }
    .tabulator-popup.tabulator-menu .tabulator-menu-item {
        padding: 5px 12px !important;
        font-size: 12.5px !important;
        color: #e0e0e0 !important;
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        cursor: pointer !important;
        border-radius: 5px !important;
        margin: 1px 0 !important;
    }
    .tabulator-popup.tabulator-menu .tabulator-menu-item:hover {
        background: rgba(255, 255, 255, 0.1) !important;
        color: #fff !important;
    }
    .tabulator-popup.tabulator-menu .tabulator-menu-separator {
        height: 1px !important;
        background: rgba(255, 255, 255, 0.08) !important;
        margin: 4px 8px !important;
    }`;
    }

    private static initScript(
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): string {
        const resultSetsJson = JSON.stringify(resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })))
            .replace(/<\/script>/gi, '<\\/script>');
        return `
    const resultSets = ${resultSetsJson};
    const tables = [];
    const isStacked = ${isStacked};

    resultSets.forEach((rs, i) => {
      try {
        if (rs.columns.length === 0) return;
        const el = document.getElementById('grid-' + i);
        if (!el) { console.error('[TSQL] grid-' + i + ' element not found'); return; }

        const columns = [
            { formatter: "rowSelection", titleFormatter: "rowSelection", headerSort: false, resizable: false, width: 30, hozAlign: "center" },
            ...rs.columns.map(col => ({
                title: col,
                field: col,
                headerFilter: "input",
                headerFilterPlaceholder: "...",
                sorter: "string",
                resizable: true,
                formatter: function(cell) {
                    const v = cell.getValue();
                    if (v === null || v === undefined) {
                        cell.getElement().classList.add('null-val');
                        return 'NULL';
                    }
                    return v;
                },
            })),
        ];

        const table = new Tabulator(el, {
            data: rs.rows,
            columns: columns,
            layout: "fitData",
            height: isStacked ? undefined : "100%",
            selectable: "highlight",
            clipboard: true,
            clipboardCopyRowRange: "selected",
            clipboardCopyConfig: { columnHeaders: true },
            headerSortTristate: true,
            movableColumns: false,
            resizableColumnFit: true,
            rowHeight: 25,
            rowContextMenu: buildRowContextMenu,
        });

        tables.push(table);
      } catch (err) {
        console.error('[TSQL] Tabulator grid-' + i + ' init error:', err);
        const el = document.getElementById('grid-' + i);
        if (el) el.innerHTML = '<p style="padding:8px;color:var(--vscode-errorForeground)">Grid error: ' + err.message + '</p>';
      }
    });

    // ── Context Menu ─────────────────────────────────
    function buildRowContextMenu(e, component) {
        const table = component.getTable();
        return [
            { label: "<span>Copy<span style='float:right;opacity:0.6;margin-left:24px'>Ctrl+C</span></span>", action: () => gridApi.copy(tables.indexOf(table), false) },
            { label: "<span>Copy with Headers<span style='float:right;opacity:0.6;margin-left:24px'>Ctrl+Shift+C</span></span>", action: () => gridApi.copy(tables.indexOf(table), true) },
            { label: "<span>Select All<span style='float:right;opacity:0.6;margin-left:24px'>Ctrl+A</span></span>", action: () => gridApi.selectAllRows(tables.indexOf(table)) },
            { separator: true },
            { label: "Script as INSERT", action: () => gridApi.scriptAsInsert(tables.indexOf(table)) },
            { label: "Copy as IN clause", action: () => gridApi.copyAsInClause(tables.indexOf(table)) },
            { label: "Open in Excel", action: () => gridApi.openInExcel(tables.indexOf(table)) },
        ];
    }

    // ── Cell Selection (Click, Ctrl+Click, Shift+Click range) ──
    let selectedCells = new Set();
    let activeCell = null;
    let lastClickedCell = null;
    document.addEventListener('click', (e) => {
        const cell = e.target.closest('.tabulator-cell');
        if (!cell || cell.closest('.tabulator-header')) return;
        if (cell.querySelector('input[type="checkbox"]')) return;

        if (e.ctrlKey) {
            if (selectedCells.has(cell)) {
                selectedCells.delete(cell); cell.classList.remove('cell-selected');
            } else {
                selectedCells.add(cell); cell.classList.add('cell-selected');
            }
        } else if (e.shiftKey && lastClickedCell) {
            const lastColIdx = Array.from(lastClickedCell.parentElement.children).indexOf(lastClickedCell);
            const currColIdx = Array.from(cell.parentElement.children).indexOf(cell);
            if (lastColIdx !== currColIdx) {
                selectedCells.forEach(c => c.classList.remove('cell-selected', 'cell-active'));
                selectedCells.clear();
                selectedCells.add(cell); cell.classList.add('cell-selected');
            } else {
                const allRows = Array.from(document.querySelectorAll('.tabulator-row'));
                const lastRowIdx = allRows.indexOf(lastClickedCell.closest('.tabulator-row'));
                const currRowIdx = allRows.indexOf(cell.closest('.tabulator-row'));
                if (lastRowIdx >= 0 && currRowIdx >= 0) {
                    const [startRow, endRow] = lastRowIdx < currRowIdx ? [lastRowIdx, currRowIdx] : [currRowIdx, lastRowIdx];
                    selectedCells.forEach(c => c.classList.remove('cell-selected', 'cell-active'));
                    selectedCells.clear();
                    for (let r = startRow; r <= endRow; r++) {
                        const c = allRows[r].children[lastColIdx];
                        if (c) { selectedCells.add(c); c.classList.add('cell-selected'); }
                    }
                }
            }
        } else {
            selectedCells.forEach(c => c.classList.remove('cell-selected', 'cell-active'));
            selectedCells.clear();
            selectedCells.add(cell); cell.classList.add('cell-selected');
        }
        if (activeCell) activeCell.classList.remove('cell-active');
        activeCell = cell; cell.classList.add('cell-active');
        lastClickedCell = cell;
    });

    // ── gridApi implementation for Tabulator ─────────
    window.gridApi = {
        getTableCount: () => tables.length,
        getSelectedOrAllRows: (idx) => {
            const table = tables[idx];
            if (!table) return [];
            const selected = table.getSelectedRows();
            return (selected.length > 0 ? selected : table.getRows("active")).map(r => r.getData());
        },
        getVisibleColumns: (idx) => {
            const table = tables[idx];
            if (!table) return [];
            return table.getColumns().filter(c => c.getField() && c.isVisible()).map(c => ({ field: c.getField(), title: c.getDefinition().title || c.getField() }));
        },
        selectAllRows: (idx) => { const table = tables[idx]; if (table) table.selectRow(); },
        clearFilter: (idx) => { const table = tables[idx]; if (table) table.clearFilter(); },
        setQuickFilter: (idx, value) => {
            const table = tables[idx];
            if (!table) return;
            if (!value) { table.clearFilter(); return; }
            const rs = resultSets[idx];
            if (!rs) return;
            const filters = rs.columns.map(col => ({ field: col, type: "like", value: value }));
            table.setFilter([filters]);
        },
        getColumns: (idx) => {
            const table = tables[idx];
            if (!table) return [];
            return table.getColumns().filter(c => c.getField());
        },
        toggleColumnVisibility: (idx, field) => {
            const table = tables[idx];
            if (!table) return;
            const col = table.getColumns().find(c => c.getField() === field);
            if (col) { col.isVisible() ? col.hide() : col.show(); }
        },
        isColumnVisible: (idx, field) => {
            const table = tables[idx];
            if (!table) return true;
            const col = table.getColumns().find(c => c.getField() === field);
            return col ? col.isVisible() : true;
        },
        showAllColumns: (idx) => {
            const table = tables[idx];
            if (table) table.getColumns().filter(c => c.getField()).forEach(c => c.show());
        },
        hideAllColumns: (idx) => {
            const table = tables[idx];
            if (table) table.getColumns().filter(c => c.getField()).forEach(c => c.hide());
        },
        exportCsv: (idx, filename) => {
            const table = tables[idx];
            if (table) table.download("csv", filename);
        },
        redraw: (idx) => { const table = tables[idx]; if (table) table.redraw(true); },
        redrawAll: () => { tables.forEach(t => t.redraw(true)); },
        copy: (idx, withHeaders) => {
            const rows = gridApi.getSelectedOrAllRows(idx);
            const cols = gridApi.getVisibleColumns(idx);
            const lines = [];
            if (withHeaders) { lines.push(cols.map(c => c.field).join('\\t')); }
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c.field]; return v === null || v === undefined ? 'NULL' : v; }).join('\\t'));
            });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        scriptAsInsert: (idx) => {
            const rows = gridApi.getSelectedOrAllRows(idx);
            const cols = gridApi.getVisibleColumns(idx);
            const colNames = cols.map(c => '[' + c.field + ']').join(', ');
            const lines = rows.map(data => {
                const vals = cols.map(c => {
                    const v = data[c.field];
                    if (v === null || v === undefined) return 'NULL';
                    const num = Number(v);
                    if (!isNaN(num) && String(v).trim() !== '') return v;
                    return "N'" + String(v).replace(/'/g, "''") + "'";
                });
                return 'INSERT INTO [TableName] (' + colNames + ') VALUES (' + vals.join(', ') + ');';
            });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        copyAsInClause: (idx) => {
            let field = null;
            if (activeCell) {
                const cellIdx = Array.from(activeCell.parentElement.children).indexOf(activeCell);
                const table = tables[idx];
                if (table) {
                    const allCols = table.getColumns();
                    if (allCols[cellIdx]) field = allCols[cellIdx].getField();
                }
            }
            if (!field) {
                const cols = gridApi.getVisibleColumns(idx);
                if (cols.length > 0) field = cols[0].field;
            }
            if (!field) return;
            const rows = gridApi.getSelectedOrAllRows(idx);
            const values = rows.map(data => {
                const v = data[field];
                if (v === null || v === undefined) return 'NULL';
                const num = Number(v);
                if (!isNaN(num) && String(v).trim() !== '') return String(v);
                return "N'" + String(v).replace(/'/g, "''") + "'";
            });
            navigator.clipboard.writeText('IN (' + values.join(', ') + ')');
        },
        openInExcel: (idx) => {
            const rows = gridApi.getSelectedOrAllRows(idx);
            const cols = gridApi.getVisibleColumns(idx);
            const lines = [cols.map(c => c.field).join('\\t')];
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c.field]; return v === null || v === undefined ? '' : v; }).join('\\t'));
            });
            vscodeApi.postMessage({ type: 'openInExcel', data: lines.join('\\n') });
        },
    };
`;
    }
}
