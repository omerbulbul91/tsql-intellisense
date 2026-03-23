import * as vscode from 'vscode';
import { GridRenderer, GridRenderResult } from './gridRenderer';

export class AgGridRenderer implements GridRenderer {
    render(
        _webview: vscode.Webview,
        _extensionUri: vscode.Uri,
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): GridRenderResult {
        // AG Grid Community doesn't ship a UMD bundle for webview use.
        // This renderer builds a native HTML table with AG-Grid-like styling.
        return {
            resourceRoots: [],
            headHtml: '',
            themeStyles: AgGridRenderer.themeStyles(),
            initScript: `<script>\n${AgGridRenderer.initScript(resultSets, isStacked)}\n</script>`,
        };
    }

    private static themeStyles(): string {
        return `
    /* ── AG Grid native table styles ─────────────── */
    .ag-native-grid { width: 100%; overflow: auto; }
    .ag-native-grid table { width: 100%; border-collapse: collapse; font-size: 12px; font-family: var(--vscode-font-family, 'Segoe UI', sans-serif); }
    .ag-native-grid th {
        padding: 4px 8px; text-align: left; cursor: pointer;
        background: var(--vscode-editorWidget-background);
        border-bottom: 2px solid var(--vscode-editorWidget-border);
        border-right: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap; user-select: none; position: relative;
        font-weight: normal; color: var(--vscode-foreground);
        position: sticky; top: 0; z-index: 1;
    }
    .ag-native-grid td {
        padding: 2px 8px; border-right: 1px solid var(--vscode-editorWidget-border);
        white-space: nowrap; color: var(--vscode-foreground);
    }
    .ag-native-grid tr { border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .ag-native-grid tr:hover td { background: var(--vscode-list-hoverBackground); }
    .ag-native-grid tr.row-selected td { background: var(--vscode-list-activeSelectionBackground) !important; color: var(--vscode-list-activeSelectionForeground); }
    .ag-native-grid .null-val { color: var(--vscode-descriptionForeground) !important; font-style: italic; }`;
    }

    private static initScript(
        resultSets: { columns: string[]; rows: any[] }[],
        isStacked: boolean,
    ): string {
        const resultSetsJson = JSON.stringify(resultSets.map(rs => ({ columns: rs.columns, rows: rs.rows })))
            .replace(/<\/script>/gi, '<\\/script>');
        return `
    const resultSets = ${resultSetsJson};
    const grids = [];
    const isStacked = ${isStacked};

    resultSets.forEach((rs, i) => {
      try {
        if (rs.columns.length === 0) return;
        const el = document.getElementById('grid-' + i);
        if (!el) { console.error('[TSQL] grid-' + i + ' element not found'); return; }

        el.classList.add('ag-native-grid');
        if (!isStacked) { el.style.height = '100%'; }

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
        el.appendChild(table);

        grids.push({ el, table, thead, tbody, data: rs.rows, columns: rs.columns, filteredRows: null, hiddenCols: new Set(), sortField: null, sortDir: '' });
      } catch (err) {
        console.error('[TSQL] AG-Grid grid-' + i + ' init error:', err);
        const el = document.getElementById('grid-' + i);
        if (el) el.innerHTML = '<p style="padding:8px;color:var(--vscode-errorForeground)">Grid error: ' + err.message + '</p>';
      }
    });

    // ── Sorting ────────────────────────────────────
    function sortColumn(gridIdx, field, th) {
        const g = grids[gridIdx]; if (!g) return;
        // Toggle sort direction
        const dirs = ['asc', 'desc', ''];
        const curIdx = dirs.indexOf(th.dataset.sortDir || '');
        const newDir = dirs[(curIdx + 1) % 3];
        // Clear other headers' sort indicators
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
                if (va === null || va === undefined) return 1;
                if (vb === null || vb === undefined) return -1;
                const na = Number(va), nb = Number(vb);
                if (!isNaN(na) && !isNaN(nb)) return g.sortDir === 'asc' ? na - nb : nb - na;
                return g.sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
            });
        }
        g.tbody.innerHTML = '';
        rows.forEach((row, ri) => {
            const tr = document.createElement('tr');
            tr.dataset.rowIdx = String(ri);
            g.columns.forEach((col, ci) => {
                const td = document.createElement('td');
                if (g.hiddenCols.has(col)) { td.style.display = 'none'; }
                const v = row[col];
                if (v === null || v === undefined) { td.textContent = 'NULL'; td.classList.add('null-val'); }
                else { td.textContent = String(v); }
                tr.appendChild(td);
            });
            g.tbody.appendChild(tr);
        });
    }

    // ── Row selection ──────────────────────────────
    let selectedRows = new Set();
    document.addEventListener('click', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        if (!e.ctrlKey) {
            document.querySelectorAll('tbody tr.row-selected').forEach(r => r.classList.remove('row-selected'));
            selectedRows.clear();
        }
        tr.classList.toggle('row-selected');
        if (tr.classList.contains('row-selected')) selectedRows.add(tr);
        else selectedRows.delete(tr);
    });

    // ── Context menu via right-click ────────────────
    document.addEventListener('contextmenu', (e) => {
        const tr = e.target.closest('tbody tr');
        if (!tr) return;
        // Find which grid
        let gridIdx = 0;
        for (let i = 0; i < grids.length; i++) {
            if (grids[i].el.contains(tr)) { gridIdx = i; break; }
        }
        if (typeof showContextMenu === 'function') showContextMenu(e, gridIdx);
    });

    // ── gridApi ────────────────────────────────────
    function getRowsData(gridIdx) {
        const g = grids[gridIdx]; if (!g) return [];
        const selTrs = g.tbody.querySelectorAll('tr.row-selected');
        let rows;
        if (selTrs.length > 0) {
            rows = Array.from(selTrs).map(tr => {
                const obj = {};
                g.columns.forEach((col, ci) => { obj[col] = g.data[parseInt(tr.dataset.rowIdx)]?.[col]; });
                return obj;
            });
        } else {
            rows = g.filteredRows || g.data;
        }
        return rows;
    }

    window.gridApi = {
        getTableCount: () => grids.length,
        getSelectedOrAllRows: (idx) => getRowsData(idx),
        getVisibleColumns: (idx) => {
            const g = grids[idx]; if (!g) return [];
            return g.columns.filter(c => !g.hiddenCols.has(c)).map(c => ({ field: c, title: c }));
        },
        getColumns: (idx) => {
            const g = grids[idx]; if (!g) return [];
            return g.columns.map(c => ({ field: c, title: c }));
        },
        selectAllRows: (idx) => {
            const g = grids[idx]; if (!g) return;
            g.tbody.querySelectorAll('tr').forEach(tr => { tr.classList.add('row-selected'); selectedRows.add(tr); });
        },
        clearFilter: (idx) => {
            const g = grids[idx]; if (!g) return;
            g.filteredRows = null; rebuildRows(idx);
        },
        setQuickFilter: (idx, value) => {
            const g = grids[idx]; if (!g) return;
            if (!value) { g.filteredRows = null; rebuildRows(idx); return; }
            const lv = value.toLowerCase();
            g.filteredRows = g.data.filter(row => g.columns.some(col => { const v = row[col]; return v !== null && v !== undefined && String(v).toLowerCase().includes(lv); }));
            rebuildRows(idx);
        },
        toggleColumnVisibility: (idx, field) => {
            const g = grids[idx]; if (!g) return;
            if (g.hiddenCols.has(field)) g.hiddenCols.delete(field); else g.hiddenCols.add(field);
            // Toggle header
            const ci = g.columns.indexOf(field);
            if (ci >= 0) {
                const th = g.thead.querySelectorAll('th')[ci];
                if (th) th.style.display = g.hiddenCols.has(field) ? 'none' : '';
                g.tbody.querySelectorAll('tr').forEach(tr => { const td = tr.children[ci]; if (td) td.style.display = g.hiddenCols.has(field) ? 'none' : ''; });
            }
        },
        isColumnVisible: (idx, field) => { const g = grids[idx]; return g ? !g.hiddenCols.has(field) : true; },
        showAllColumns: (idx) => {
            const g = grids[idx]; if (!g) return;
            g.hiddenCols.clear();
            g.thead.querySelectorAll('th').forEach(th => th.style.display = '');
            g.tbody.querySelectorAll('tr').forEach(tr => Array.from(tr.children).forEach(td => td.style.display = ''));
        },
        hideAllColumns: (idx) => {
            const g = grids[idx]; if (!g) return;
            g.columns.forEach(c => g.hiddenCols.add(c));
            g.thead.querySelectorAll('th').forEach(th => th.style.display = 'none');
            g.tbody.querySelectorAll('tr').forEach(tr => Array.from(tr.children).forEach(td => td.style.display = 'none'));
        },
        exportCsv: (idx, filename) => {
            const g = grids[idx]; if (!g) return;
            const visibleCols = g.columns.filter(c => !g.hiddenCols.has(c));
            const rows = g.filteredRows || g.data;
            const lines = [visibleCols.join(',')];
            rows.forEach(row => {
                lines.push(visibleCols.map(c => {
                    const v = row[c];
                    if (v === null || v === undefined) return '';
                    const s = String(v);
                    if (s.includes(',') || s.includes('"') || s.includes('\\n')) return '"' + s.replace(/"/g, '""') + '"';
                    return s;
                }).join(','));
            });
            const blob = new Blob([lines.join('\\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
        },
        redraw: (idx) => {},
        redrawAll: () => {},
        copy: (idx, withHeaders) => {
            const rows = getRowsData(idx);
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const lines = [];
            if (withHeaders) lines.push(cols.join('\\t'));
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c]; return v === null || v === undefined ? 'NULL' : v; }).join('\\t'));
            });
            navigator.clipboard.writeText(lines.join('\\n'));
        },
        scriptAsInsert: (idx) => {
            const rows = getRowsData(idx);
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
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
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const field = cols[0];
            if (!field) return;
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
            const g = grids[idx]; if (!g) return;
            const cols = g.columns.filter(c => !g.hiddenCols.has(c));
            const lines = [cols.join('\\t')];
            rows.forEach(data => {
                lines.push(cols.map(c => { const v = data[c]; return v === null || v === undefined ? '' : v; }).join('\\t'));
            });
            vscodeApi.postMessage({ type: 'openInExcel', data: lines.join('\\n') });
        },
    };
`;
    }
}
