import * as vscode from 'vscode';
import { GridRenderer, GridRenderResult } from './gridRenderer';

export class HandsontableRenderer implements GridRenderer {
    render(
        webview: vscode.Webview,
        extensionUri: vscode.Uri,
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): GridRenderResult {
        const base = vscode.Uri.joinPath(extensionUri, 'node_modules', 'handsontable', 'dist');
        let jsUri: vscode.Uri | null = null;
        let cssUri: vscode.Uri | null = null;
        try {
            jsUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'handsontable.full.min.js'));
            cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'handsontable.full.min.css'));
        } catch { /* package not installed — fallback to native table */ }

        const hasLib = jsUri && cssUri;

        return {
            resourceRoots: [vscode.Uri.joinPath(extensionUri, 'node_modules', 'handsontable')],
            headHtml: hasLib ? `<link rel="stylesheet" href="${cssUri}">` : '',
            themeStyles: HandsontableRenderer.themeStyles(hasLib),
            initScript: hasLib
                ? `<script src="${jsUri}"></script>\n<script>\n${HandsontableRenderer.initScriptHot(resultSets, isStacked)}\n</script>`
                : `<script>\n${HandsontableRenderer.initScriptFallback(resultSets, isStacked)}\n</script>`,
        };
    }

    private static themeStyles(hasLib: boolean): string {
        if (!hasLib) {
            return `
    /* ── Fallback native table styles ──────────────── */
    .native-grid table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .native-grid th {
        padding: 4px 8px; text-align: left; cursor: pointer;
        background: var(--vscode-editorWidget-background);
        border-bottom: 2px solid var(--vscode-editorWidget-border);
        border-right: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap; user-select: none; font-weight: normal;
        color: var(--vscode-foreground); position: sticky; top: 0; z-index: 1;
    }
    .native-grid td {
        padding: 2px 8px; border-right: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap; color: var(--vscode-foreground);
    }
    .native-grid tr { border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .native-grid tr:hover { background: var(--vscode-list-hoverBackground); }
    .native-grid tr.row-selected { background: var(--vscode-list-activeSelectionBackground) !important; }
    .native-grid .null-val { color: var(--vscode-descriptionForeground); font-style: italic; }`;
        }
        return `
    /* ── Handsontable VS Code theme overrides ─────── */
    .handsontable {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif) !important;
        font-size: 12px !important;
        color: var(--vscode-foreground) !important;
    }
    .handsontable .wtHolder {
        background: var(--vscode-editor-background) !important;
    }
    .handsontable th,
    .handsontable thead th {
        background: var(--vscode-editorWidget-background) !important;
        color: var(--vscode-foreground) !important;
        border-color: var(--vscode-editorWidget-border) !important;
        font-weight: normal !important;
    }
    .handsontable td {
        background: var(--vscode-editor-background) !important;
        color: var(--vscode-foreground) !important;
        border-color: var(--vscode-editorWidget-border) !important;
    }
    .handsontable td.null-val {
        color: var(--vscode-descriptionForeground) !important;
        font-style: italic;
    }
    .handsontable tr:hover td {
        background: var(--vscode-list-hoverBackground) !important;
    }
    .handsontable .htDimmed { color: var(--vscode-descriptionForeground) !important; }
    .handsontable .ht__highlight td,
    .handsontable .ht__active_highlight td {
        background: var(--vscode-list-activeSelectionBackground) !important;
        color: var(--vscode-list-activeSelectionForeground) !important;
    }
    .handsontable .htBorders div { display: none !important; }
    .handsontable .current.highlight td,
    .handsontable td.area {
        background: rgba(0, 120, 212, 0.15) !important;
    }
    /* Row/column header styling */
    .handsontable .ht_clone_left th,
    .handsontable .ht_clone_top_left_corner th,
    .handsontable .ht_clone_top th {
        background: var(--vscode-editorWidget-background) !important;
        color: var(--vscode-descriptionForeground) !important;
        border-color: var(--vscode-editorWidget-border) !important;
    }
    /* Column sorting indicators */
    .handsontable span.colHeader.columnSorting::after { opacity: 0.6; }`;
    }

    private static initScriptHot(
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): string {
        const resultSetsJson = JSON.stringify(resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })));
        return `
    const resultSets = ${resultSetsJson};
    const hots = [];
    const hotData = []; // keep original data refs

    resultSets.forEach((rs, i) => {
        if (rs.columns.length === 0) return;
        const el = document.getElementById('grid-' + i);
        if (!el) return;

        // Convert row objects to 2D array
        const data = rs.rows.map(row => rs.columns.map(col => row[col]));
        hotData.push({ columns: rs.columns, data: data, originalData: data, hiddenCols: new Set() });

        // Ensure container has explicit dimensions for Handsontable
        if (!isStacked) {
            el.style.height = '100%';
            el.style.overflow = 'hidden';
        } else {
            const calcH = Math.min(data.length * 25 + 50, 400);
            el.style.height = calcH + 'px';
            el.style.overflow = 'hidden';
        }

        const hot = new Handsontable(el, {
            data: data,
            colHeaders: rs.columns,
            rowHeaders: true,
            readOnly: true,
            width: '100%',
            height: '100%',
            stretchH: 'none',
            autoColumnSize: true,
            columnSorting: true,
            manualColumnResize: true,
            selectionMode: 'multiple',
            outsideClickDeselects: false,
            licenseKey: 'non-commercial-and-evaluation',
            renderer: function(instance, td, row, col, prop, value, cellProperties) {
                Handsontable.renderers.TextRenderer.apply(this, arguments);
                if (value === null || value === undefined) {
                    td.textContent = 'NULL';
                    td.classList.add('null-val');
                }
            },
        });

        hots.push(hot);
    });

    // ── Context menu via right-click ────────────────
    document.addEventListener('contextmenu', (e) => {
        const hotEl = e.target.closest('[id^="grid-"]');
        if (!hotEl) return;
        const idx = parseInt(hotEl.id.replace('grid-', ''));
        if (typeof showContextMenu === 'function') showContextMenu(e, idx);
    });

    // ── gridApi ────────────────────────────────────
    function getRowsData(idx) {
        const hot = hots[idx];
        const hd = hotData[idx];
        if (!hot || !hd) return [];
        // Check if there's a selection
        const selected = hot.getSelected();
        let rowIndices;
        if (selected && selected.length > 0) {
            const rowSet = new Set();
            selected.forEach(([r1, c1, r2, c2]) => {
                const startR = Math.min(r1, r2), endR = Math.max(r1, r2);
                for (let r = startR; r <= endR; r++) rowSet.add(r);
            });
            rowIndices = Array.from(rowSet).sort((a, b) => a - b);
        } else {
            rowIndices = [];
            for (let r = 0; r < hot.countRows(); r++) rowIndices.push(r);
        }
        return rowIndices.map(r => {
            const obj = {};
            hd.columns.forEach((col, c) => { obj[col] = hot.getDataAtCell(r, c); });
            return obj;
        });
    }

    window.gridApi = {
        getTableCount: () => hots.length,
        getSelectedOrAllRows: (idx) => getRowsData(idx),
        getVisibleColumns: (idx) => {
            const hd = hotData[idx]; if (!hd) return [];
            return hd.columns.filter(c => !hd.hiddenCols.has(c)).map(c => ({ field: c, title: c }));
        },
        getColumns: (idx) => {
            const hd = hotData[idx]; if (!hd) return [];
            return hd.columns.map(c => ({ field: c, title: c }));
        },
        selectAllRows: (idx) => {
            const hot = hots[idx]; if (!hot) return;
            hot.selectRows(0, hot.countRows() - 1);
        },
        clearFilter: (idx) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            hot.loadData(hd.originalData);
        },
        setQuickFilter: (idx, value) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            if (!value) { hot.loadData(hd.originalData); return; }
            const lv = value.toLowerCase();
            const filtered = hd.originalData.filter(row => row.some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(lv)));
            hot.loadData(filtered);
        },
        toggleColumnVisibility: (idx, field) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            const ci = hd.columns.indexOf(field);
            if (ci < 0) return;
            if (hd.hiddenCols.has(field)) {
                hd.hiddenCols.delete(field);
            } else {
                hd.hiddenCols.add(field);
            }
            // Use plugin to hide/show columns
            const plugin = hot.getPlugin('hiddenColumns');
            if (plugin) {
                if (hd.hiddenCols.has(field)) { plugin.hideColumn(ci); } else { plugin.showColumn(ci); }
                hot.render();
            }
        },
        isColumnVisible: (idx, field) => { const hd = hotData[idx]; return hd ? !hd.hiddenCols.has(field) : true; },
        showAllColumns: (idx) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            hd.hiddenCols.clear();
            const plugin = hot.getPlugin('hiddenColumns');
            if (plugin) { hd.columns.forEach((_, ci) => plugin.showColumn(ci)); hot.render(); }
        },
        hideAllColumns: (idx) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            hd.columns.forEach(c => hd.hiddenCols.add(c));
            const plugin = hot.getPlugin('hiddenColumns');
            if (plugin) { hd.columns.forEach((_, ci) => plugin.hideColumn(ci)); hot.render(); }
        },
        exportCsv: (idx, filename) => {
            const hd = hotData[idx]; const hot = hots[idx]; if (!hd || !hot) return;
            const visibleCols = hd.columns.filter(c => !hd.hiddenCols.has(c));
            const visibleIndices = visibleCols.map(c => hd.columns.indexOf(c));
            const lines = [visibleCols.join(',')];
            for (let r = 0; r < hot.countRows(); r++) {
                lines.push(visibleIndices.map(ci => {
                    const v = hot.getDataAtCell(r, ci);
                    if (v === null || v === undefined) return '';
                    const s = String(v);
                    if (s.includes(',') || s.includes('"') || s.includes('\\n')) return '"' + s.replace(/"/g, '""') + '"';
                    return s;
                }).join(','));
            }
            const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
        },
        redraw: (idx) => { const hot = hots[idx]; if (hot) hot.render(); },
        redrawAll: () => hots.forEach(h => h.render()),
        copy: (idx, withHeaders) => {
            const rows = getRowsData(idx);
            const hd = hotData[idx]; if (!hd) return;
            const cols = hd.columns.filter(c => !hd.hiddenCols.has(c));
            const lines = [];
            if (withHeaders) lines.push(cols.join('\\t'));
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c]; return v === null || v === undefined ? 'NULL' : v; }).join('\\t'));
            });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        scriptAsInsert: (idx) => {
            const rows = getRowsData(idx);
            const hd = hotData[idx]; if (!hd) return;
            const cols = hd.columns.filter(c => !hd.hiddenCols.has(c));
            const colNames = cols.map(c => '[' + c + ']').join(', ');
            const lines = rows.map(data => {
                const vals = cols.map(c => {
                    const v = data[c];
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
            const hd = hotData[idx]; if (!hd) return;
            const cols = hd.columns.filter(c => !hd.hiddenCols.has(c));
            const field = cols[0]; if (!field) return;
            const rows = getRowsData(idx);
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
            const rows = getRowsData(idx);
            const hd = hotData[idx]; if (!hd) return;
            const cols = hd.columns.filter(c => !hd.hiddenCols.has(c));
            const lines = [cols.join('\\t')];
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c]; return v === null || v === undefined ? '' : v; }).join('\\t'));
            });
            vscodeApi.postMessage({ type: 'openInExcel', data: lines.join('\\n') });
        },
    };
`;
    }

    /** Fallback — if handsontable package is not installed, render a native HTML table */
    private static initScriptFallback(
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): string {
        // Reuse the AG Grid native table approach
        const resultSetsJson = JSON.stringify(resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })));
        return `
    const resultSets = ${resultSetsJson};
    const grids = [];

    resultSets.forEach((rs, i) => {
        if (rs.columns.length === 0) return;
        const el = document.getElementById('grid-' + i);
        if (!el) return;
        el.classList.add('native-grid');
        const wrapper = document.createElement('div');
        wrapper.style.width = '100%';
        wrapper.style.height = isStacked ? 'auto' : '100%';
        wrapper.style.overflow = 'auto';
        el.appendChild(wrapper);

        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        rs.columns.forEach(col => {
            const th = document.createElement('th');
            th.textContent = col;
            th.dataset.field = col;
            th.dataset.sortDir = '';
            th.onclick = () => sortColumn(i, col, th);
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        rs.rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            tr.dataset.rowIdx = String(ri);
            rs.columns.forEach(col => {
                const td = document.createElement('td');
                const v = row[col];
                if (v === null || v === undefined) { td.textContent = 'NULL'; td.classList.add('null-val'); }
                else { td.textContent = String(v); }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        grids.push({ el, wrapper, table, thead, tbody, data: rs.rows, columns: rs.columns, filteredRows: null, hiddenCols: new Set(), sortField: null, sortDir: '' });
    });

    function sortColumn(gridIdx, field, th) {
        const g = grids[gridIdx]; if (!g) return;
        const dirs = ['asc', 'desc', ''];
        const curIdx = dirs.indexOf(th.dataset.sortDir || '');
        const newDir = dirs[(curIdx + 1) % 3];
        g.thead.querySelectorAll('th').forEach(h => { h.dataset.sortDir = ''; h.textContent = h.dataset.field; });
        th.dataset.sortDir = newDir;
        th.textContent = th.dataset.field + (newDir === 'asc' ? ' ▲' : newDir === 'desc' ? ' ▼' : '');
        g.sortField = newDir ? field : null;
        g.sortDir = newDir;
        rebuildRows(gridIdx);
    }

    function rebuildRows(gridIdx) {
        const g = grids[gridIdx]; if (!g) return;
        let rows = g.filteredRows || g.data;
        if (g.sortField && g.sortDir) {
            rows = [...rows].sort((a, b) => {
                const va = a[g.sortField], vb = b[g.sortField];
                if (va == null) return 1; if (vb == null) return -1;
                const na = Number(va), nb = Number(vb);
                if (!isNaN(na) && !isNaN(nb)) return g.sortDir === 'asc' ? na - nb : nb - na;
                return g.sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
            });
        }
        g.tbody.innerHTML = '';
        rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            tr.dataset.rowIdx = String(ri);
            g.columns.forEach(col => {
                const td = document.createElement('td');
                if (g.hiddenCols.has(col)) td.style.display = 'none';
                const v = row[col];
                if (v === null || v === undefined) { td.textContent = 'NULL'; td.classList.add('null-val'); }
                else { td.textContent = String(v); }
                tr.appendChild(td);
            });
            g.tbody.appendChild(tr);
        });
    }

    let selectedRows = new Set();
    document.addEventListener('click', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        if (!e.ctrlKey) { document.querySelectorAll('tbody tr.row-selected').forEach(r => r.classList.remove('row-selected')); selectedRows.clear(); }
        tr.classList.toggle('row-selected');
        if (tr.classList.contains('row-selected')) selectedRows.add(tr); else selectedRows.delete(tr);
    });

    document.addEventListener('contextmenu', (e) => {
        const el = e.target.closest('[id^="grid-"]');
        if (!el) return;
        const idx = parseInt(el.id.replace('grid-', ''));
        if (typeof showContextMenu === 'function') showContextMenu(e, idx);
    });

    function getRowsData(idx) {
        const g = grids[idx]; if (!g) return [];
        const selTrs = g.tbody.querySelectorAll('tr.row-selected');
        if (selTrs.length > 0) return Array.from(selTrs).map(tr => g.data[parseInt(tr.dataset.rowIdx)] || {});
        return g.filteredRows || g.data;
    }

    window.gridApi = {
        getTableCount: () => grids.length,
        getSelectedOrAllRows: (idx) => getRowsData(idx),
        getVisibleColumns: (idx) => { const g = grids[idx]; if (!g) return []; return g.columns.filter(c => !g.hiddenCols.has(c)).map(c => ({ field: c, title: c })); },
        getColumns: (idx) => { const g = grids[idx]; if (!g) return []; return g.columns.map(c => ({ field: c, title: c })); },
        selectAllRows: (idx) => { const g = grids[idx]; if (!g) return; g.tbody.querySelectorAll('tr').forEach(tr => { tr.classList.add('row-selected'); selectedRows.add(tr); }); },
        clearFilter: (idx) => { const g = grids[idx]; if (!g) return; g.filteredRows = null; rebuildRows(idx); },
        setQuickFilter: (idx, value) => {
            const g = grids[idx]; if (!g) return;
            if (!value) { g.filteredRows = null; rebuildRows(idx); return; }
            const lv = value.toLowerCase();
            g.filteredRows = g.data.filter(row => g.columns.some(col => { const v = row[col]; return v != null && String(v).toLowerCase().includes(lv); }));
            rebuildRows(idx);
        },
        toggleColumnVisibility: (idx, field) => {
            const g = grids[idx]; if (!g) return;
            if (g.hiddenCols.has(field)) g.hiddenCols.delete(field); else g.hiddenCols.add(field);
            const ci = g.columns.indexOf(field);
            if (ci >= 0) {
                g.thead.querySelectorAll('th')[ci].style.display = g.hiddenCols.has(field) ? 'none' : '';
                g.tbody.querySelectorAll('tr').forEach(tr => { if (tr.children[ci]) tr.children[ci].style.display = g.hiddenCols.has(field) ? 'none' : ''; });
            }
        },
        isColumnVisible: (idx, field) => { const g = grids[idx]; return g ? !g.hiddenCols.has(field) : true; },
        showAllColumns: (idx) => { const g = grids[idx]; if (!g) return; g.hiddenCols.clear(); g.thead.querySelectorAll('th').forEach(th => th.style.display = ''); g.tbody.querySelectorAll('tr').forEach(tr => Array.from(tr.children).forEach(td => td.style.display = '')); },
        hideAllColumns: (idx) => { const g = grids[idx]; if (!g) return; g.columns.forEach(c => g.hiddenCols.add(c)); g.thead.querySelectorAll('th').forEach(th => th.style.display = 'none'); g.tbody.querySelectorAll('tr').forEach(tr => Array.from(tr.children).forEach(td => td.style.display = 'none')); },
        exportCsv: (idx, filename) => {
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const rows = g.filteredRows || g.data;
            const lines = [cols.join(',')];
            rows.forEach(row => { lines.push(cols.map(c => { const v = row[c]; if (v == null) return ''; const s = String(v); if (s.includes(',') || s.includes('"') || s.includes('\\n')) return '"' + s.replace(/"/g, '""') + '"'; return s; }).join(',')); });
            const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
        },
        redraw: () => {},
        redrawAll: () => {},
        copy: (idx, withHeaders) => {
            const rows = getRowsData(idx); const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const lines = []; if (withHeaders) lines.push(cols.join('\\t'));
            rows.forEach(data => { lines.push(cols.map(c => { const v = data[c]; return v == null ? 'NULL' : v; }).join('\\t')); });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        scriptAsInsert: (idx) => {
            const rows = getRowsData(idx); const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const colNames = cols.map(c => '[' + c + ']').join(', ');
            const lines = rows.map(data => { const vals = cols.map(c => { const v = data[c]; if (v == null) return 'NULL'; const num = Number(v); if (!isNaN(num) && String(v).trim() !== '') return v; return "N'" + String(v).replace(/'/g, "''") + "'"; }); return 'INSERT INTO [TableName] (' + colNames + ') VALUES (' + vals.join(', ') + ');'; });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        copyAsInClause: (idx) => {
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const field = cols[0]; if (!field) return;
            const rows = getRowsData(idx);
            const values = rows.map(data => { const v = data[field]; if (v == null) return 'NULL'; const num = Number(v); if (!isNaN(num) && String(v).trim() !== '') return String(v); return "N'" + String(v).replace(/'/g, "''") + "'"; });
            navigator.clipboard.writeText('IN (' + values.join(', ') + ')');
        },
        openInExcel: (idx) => {
            const rows = getRowsData(idx); const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const lines = [cols.join('\\t')];
            rows.forEach(data => { lines.push(cols.map(c => { const v = data[c]; return v == null ? '' : v; }).join('\\t')); });
            vscodeApi.postMessage({ type: 'openInExcel', data: lines.join('\\n') });
        },
    };
`;
    }
}
