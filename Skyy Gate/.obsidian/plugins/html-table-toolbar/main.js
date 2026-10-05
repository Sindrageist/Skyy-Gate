'use strict';

const {
    Plugin, PluginSettingTab, Setting, Modal, Menu, Notice, MarkdownView, FuzzySuggestModal,
    setIcon, debounce,
} = require('obsidian');

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

// Everything this plugin emits is namespaced `tt-` so it cannot collide with
// the sibling font toolbar's `hft-`/inline styles when both are installed.
const TABLE_CLASS = 'tt-table';
const MARKER_ATTR = 'data-tt';
const MARKER_VALUE = '1';

// Resting distance from the bottom of the window, matching where the sibling
// font toolbar sits when it is alone, and the gap left between the two.
const BASE_BOTTOM = 44;
const STACK_GAP = 6;

const CELL_ALIGN = { left: 'tt-l', center: 'tt-c', right: 'tt-r' };
const CELL_ALIGN_GROUP = Object.values(CELL_ALIGN);
const TABLE_ALIGN = { left: 'tt-left', center: 'tt-center', right: 'tt-right' };
const TABLE_ALIGN_GROUP = Object.values(TABLE_ALIGN);

// Border patterns. "grid" is the stylesheet's default, so it carries no class
// of its own — which also keeps every table written before this existed
// looking exactly as it did.
const TABLE_BORDER = { grid: null, rules: 'tt-rules', box: 'tt-box', none: 'tt-bare' };
const TABLE_BORDER_GROUP = Object.values(TABLE_BORDER).filter(Boolean);
// Individual row and column edges, on top of whichever pattern the table
// carries. Rows mark the <tr>; columns have no element spanning them, so they
// mark the cells that sit on the edge in question.
// Set when any column carries an explicit width, so the stylesheet can put the
// table into the fixed layout those widths need in order to bind.
const SIZED_CLASS = 'tt-sized';
// No longer written. Percentage column widths required giving the table a
// width of its own, which changed how the whole table sat on the page and made
// centring meaningless — more surprise than the feature was worth. Kept only
// so the class can be cleared from tables that already carry it.
const SIZED_PCT_CLASS = 'tt-sized-pct';

const ROW_EDGE = { top: 'tt-rt', bottom: 'tt-rb' };
const COL_EDGE = { left: 'tt-cl', right: 'tt-cr' };
// tt-rule is the superseded single-row class: still understood, still styled,
// and cleared whenever a row is set through the dialog.
const ROW_EDGE_GROUP = Object.values(ROW_EDGE).concat(['tt-rule']);
const COL_EDGE_GROUP = Object.values(COL_EDGE);
// Thickness/type/colour live with the thing they style, so every row and every
// column keeps its own: on the <tr> for a row, and on the marked cells for a
// column, which has no element of its own to hang them from. Left and right
// are kept apart because one cell can sit on the right edge of one column and
// the left edge of the next, and those two may look nothing alike.
const ROW_LINE = { width: '--tt-row-width', style: '--tt-row-style', color: '--tt-row-color' };
const COL_LINE = {
    left: { width: '--tt-cl-width', style: '--tt-cl-style', color: '--tt-cl-color' },
    right: { width: '--tt-cr-width', style: '--tt-cr-style', color: '--tt-cr-color' },
};
// Written by an earlier design that shared one format per scope across the
// whole table; cleared whenever a row or column is set now.
const LEGACY_COL_LINE = { width: '--tt-col-width', style: '--tt-col-style', color: '--tt-col-color' };
// Thickness and colour ride on custom properties set once on the <table>,
// rather than a border declaration repeated on every cell line.
const LINE_WIDTH_PROP = '--tt-line-width';
const LINE_STYLE_PROP = '--tt-line-style';
const LINE_COLOR_PROP = '--tt-line-color';
const DEFAULT_LINE_WIDTH = '1px';
const DEFAULT_LINE_STYLE = 'solid';
const LINE_STYLES = [
    { key: 'solid', name: 'Solid' },
    { key: 'dashed', name: 'Dashed' },
    { key: 'dotted', name: 'Dotted' },
    { key: 'double', name: 'Double' },
];

// Canonical layout: one tag per line, one cell per line, no blank lines.
// The parser is deliberately strict — anything it rejects goes through the
// DOMParser reformat path instead of being guessed at.
const RE_TABLE_OPEN = /^[ \t]*<table\b([^>]*)>[ \t]*$/i;
const RE_TABLE_CLOSE = /^[ \t]*<\/table>[ \t]*$/i;
const RE_COLGROUP_OPEN = /^[ \t]*<colgroup\b([^>]*)>[ \t]*$/i;
const RE_COLGROUP_CLOSE = /^[ \t]*<\/colgroup>[ \t]*$/i;
const RE_COL = /^[ \t]*<col\b([^>]*?)\/?>[ \t]*$/i;
// Row markers ride on the <tr> line so they cost no extra lines, and the
// legend names the columns once at the top. Both are regenerated wholesale on
// every serialize and never patched, so they cannot drift out of step.
// The trailing comment is no longer written — it is only still accepted so
// that tables marked by an earlier version keep parsing, and lose it on the
// next write.
const RE_TR_OPEN = /^[ \t]*<tr\b([^>]*)>(?:\s*<!--([\s\S]*?)-->)?[ \t]*$/i;
// A marker sits just inside the cell, ahead of its content. The bare `c01`
// form is what earlier versions wrote alongside a marker on the <tr>; still
// read so those tables keep working, and replaced on the next write.
const RE_CELL_MARKER = /^<!--\s*(?:r[\d-]+)?c[\d-]+\s*-->/i;
// Recognised but never written: the standalone legend line earlier versions
// emitted. Parsing keeps working on those tables, and the first edit drops it.
const RE_LEGEND = /^[ \t]*<!--\s*cols:[\s\S]*?-->[ \t]*$/i;
const RE_TR_CLOSE = /^[ \t]*<\/tr>[ \t]*$/i;
const RE_CELL = /^[ \t]*<(td|th)\b([^>]*)>([\s\S]*)<\/\1>[ \t]*$/i;
// A cell may also run over several lines, closing on a later one. The tags are
// the delimiters, so long prose can be wrapped in the source the way it was
// typed rather than forced onto one very long line.
const RE_CELL_OPEN = /^[ \t]*<(td|th)\b([^>]*)>/i;
// Loose matchers, used only to find a table worth reformatting.
const RE_TABLE_OPEN_LOOSE = /<table\b/i;
const RE_TABLE_CLOSE_LOOSE = /<\/table>/i;

// Errors carrying this flag are expected, user-facing outcomes ("cannot delete
// the only column"), not bugs — they surface as a Notice.
function fail(msg) {
    const e = new Error(msg);
    e.ttUser = true;
    throw e;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

// Attributes are kept as an ordered list rather than a plain object so that
// re-serializing a table the user hand-edited does not shuffle their markup.
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(s) {
    const out = [];
    if (!s) return out;
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(s)) !== null) {
        const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        out.push({ name: m[1], value: v === undefined ? null : v });
    }
    return out;
}

function attrsToString(list) {
    return list
        .map((a) => (a.value === null ? ' ' + a.name : ' ' + a.name + '="' + a.value + '"'))
        .join('');
}

function findAttr(list, name) {
    const lower = name.toLowerCase();
    return list.find((a) => a.name.toLowerCase() === lower) || null;
}

function getAttr(list, name) {
    const a = findAttr(list, name);
    return a ? a.value : null;
}

function setAttr(list, name, value) {
    const a = findAttr(list, name);
    if (value === null) {
        if (a) list.splice(list.indexOf(a), 1);
        return;
    }
    if (a) a.value = value;
    else list.push({ name, value });
}

function getClasses(list) {
    const c = getAttr(list, 'class');
    return c ? c.split(/\s+/).filter(Boolean) : [];
}

function setClasses(list, classes) {
    setAttr(list, 'class', classes.length ? classes.join(' ') : null);
}

function addClass(list, cls) {
    const cur = getClasses(list);
    if (!cur.includes(cls)) {
        cur.push(cls);
        setClasses(list, cur);
    }
}

function removeClass(list, cls) {
    setClasses(list, getClasses(list).filter((c) => c !== cls));
}

// Set one class out of a mutually exclusive group. Re-applying the class that
// is already set clears it, so the same button toggles back to the default.
function applyExclusiveClass(list, cls, group) {
    const cur = getClasses(list);
    const had = cls !== null && cur.includes(cls);
    const next = cur.filter((c) => !group.includes(c));
    if (cls && !had) next.push(cls);
    setClasses(list, next);
}

// Like applyExclusiveClass, but always sets rather than toggling. Used where
// the choice comes from an explicit list — picking "Rows" in a dialog that
// already shows "Rows" as current should leave it on Rows, not clear it.
function setExclusiveClass(list, cls, group) {
    const next = getClasses(list).filter((c) => !group.includes(c));
    if (cls) next.push(cls);
    setClasses(list, next);
}

// Add, replace or remove one declaration in a style attribute, leaving the
// rest of it as the author wrote it.
function setStyleProp(attrs, prop, value) {
    const style = getAttr(attrs, 'style') || '';
    const kept = style
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && s.slice(0, s.indexOf(':')).trim().toLowerCase() !== prop.toLowerCase());
    if (value) kept.unshift(prop + ':' + value);
    setAttr(attrs, 'style', kept.length ? kept.join('; ') : null);
}

function getStyleProp(attrs, prop) {
    const style = getAttr(attrs, 'style') || '';
    for (const decl of style.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0 && decl.slice(0, i).trim().toLowerCase() === prop.toLowerCase()) {
            return decl.slice(i + 1).trim();
        }
    }
    return '';
}

function spanOf(cell, name) {
    const n = parseInt(getAttr(cell.attrs, name) || '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

function setSpan(cell, name, n) {
    setAttr(cell.attrs, name, n > 1 ? String(n) : null);
}

function newCell(tag) {
    return { tag: tag || 'td', attrs: [], content: '' };
}

// A row fully covered by a rowspan from above owns no cells of its own, so
// cell-scoped operations have nothing to act on there. Say so plainly instead
// of throwing on an undefined index.
function needCell(model, r, ci) {
    const row = model.rows[r];
    const cell = row && ci >= 0 ? row.cells[ci] : null;
    if (!cell) fail('Put the cursor in a table cell first (this row is covered by a merge).');
    return cell;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

// `lines` is the exact line range of the table, first line `<table ...>` and
// last `</table>`. Returns null when the layout is not canonical.
function parseTable(lines) {
    if (!lines.length) return null;
    const open = RE_TABLE_OPEN.exec(lines[0]);
    if (!open) return null;
    const last = lines.length - 1;
    if (last < 1 || !RE_TABLE_CLOSE.test(lines[last])) return null;

    const model = {
        attrs: parseAttrs(open[1]),
        colgroupAttrs: null,
        cols: null,
        markers: false,
        sourceLegend: false,
        rows: [],
    };
    let i = 1;

    if (RE_LEGEND.test(lines[i] || '')) {
        model.markers = true;
        model.sourceLegend = true;
        i++;
    }

    const cg = RE_COLGROUP_OPEN.exec(lines[i] || '');
    if (cg) {
        model.colgroupAttrs = parseAttrs(cg[1]);
        model.cols = [];
        i++;
        while (i < last && RE_COL.test(lines[i])) {
            model.cols.push(parseAttrs(RE_COL.exec(lines[i])[1]));
            i++;
        }
        if (i >= last || !RE_COLGROUP_CLOSE.test(lines[i])) return null;
        i++;
    }

    while (i < last) {
        const tr = RE_TR_OPEN.exec(lines[i]);
        if (!tr) return null;
        if (tr[2] !== undefined) model.markers = true;
        const row = { attrs: parseAttrs(tr[1]), cells: [] };
        i++;
        while (i < last) {
            const open = RE_CELL_OPEN.exec(lines[i]);
            if (!open) break;
            const tag = open[1].toLowerCase();
            const single = RE_CELL.exec(lines[i]);
            let content;

            if (single && single[1].toLowerCase() === tag) {
                // The content capture is greedy, so two cells sharing a line
                // would otherwise parse as one cell whose text contains
                // `</td><td>`. That silently breaks line-as-address, so reject
                // it. It also rules out a nested table, which cannot be held.
                if (/<\/(?:td|th)>/i.test(single[3])) return null;
                content = single[3];
            } else {
                // Runs past this line: gather until one ends with the matching
                // closing tag. A blank line still stops everything, because it
                // ends the HTML block itself and no parser leniency can undo
                // that.
                const parts = [lines[i].slice(open[0].length)];
                if (/<\/(?:td|th)>/i.test(parts[0])) return null;
                const closeRe = new RegExp('^([\\s\\S]*)<\\/' + tag + '>[ \\t]*$', 'i');
                let j = i + 1;
                let closed = false;
                while (j < last) {
                    const l = lines[j];
                    if (!l.trim()) return null;
                    const end = closeRe.exec(l);
                    if (end) { parts.push(end[1]); closed = true; break; }
                    if (/<\/(?:td|th)>/i.test(l)) return null;
                    parts.push(l);
                    j++;
                }
                if (!closed) return null;
                content = parts.join('\n');
                i = j;
            }

            // The marker is generated, not content: strip it so it cannot be
            // duplicated on the next write or leak into a merge's joined text.
            if (RE_CELL_MARKER.test(content)) {
                model.markers = true;
                content = content.replace(RE_CELL_MARKER, '');
            }
            row.cells.push({ tag, attrs: parseAttrs(open[2]), content });
            i++;
        }
        // A row emptied by a full-width rowspan above it is legal, so zero
        // cells is accepted here; only a missing </tr> is a parse failure.
        if (i >= last || !RE_TR_CLOSE.test(lines[i])) return null;
        i++;
        model.rows.push(row);
    }

    return model.rows.length ? model : null;
}

// One coordinate per cell, and nothing on the <tr> line at all. A comment
// sitting after <tr> reads like a labelled field with room after it, which
// invites typing there — and text on a <tr> line is exactly what the fast
// parser cannot read.
//
// Columns are numbered by GRID position, not by order within the row, so the
// number stays true underneath a colspan: in a row below a two-wide header the
// markers read c01 then c03, and the gap is the point. A cell that spans states
// its range on whichever axis it spans.
function cellMarker(r, col, rowspan, colspan, rowTotal, colTotal) {
    const pad = (n, w) => String(n).padStart(w, '0');
    const axis = (start, count, w) => (count > 1
        ? pad(start + 1, w) + '-' + pad(start + count, w)
        : pad(start + 1, w));
    return '<!-- r'
        + axis(r, rowspan, Math.max(2, String(rowTotal).length))
        + 'c'
        + axis(col, colspan, Math.max(2, String(colTotal).length))
        + ' -->';
}

function serializeTable(model) {
    const out = ['<table' + attrsToString(model.attrs) + '>'];
    if (model.cols) {
        out.push('<colgroup' + attrsToString(model.colgroupAttrs || []) + '>');
        for (const col of model.cols) out.push('<col' + attrsToString(col) + '>');
        out.push('</colgroup>');
    }
    // A cell wrapped across lines emits several, so the composed string is
    // split before it goes out — every element of the returned array is still
    // exactly one line.
    const info = model.markers ? gridInfo(model) : null;
    model.rows.forEach((row, r) => {
        out.push('<tr' + attrsToString(row.attrs) + '>');
        row.cells.forEach((cell, ci) => {
            const mark = info
                ? cellMarker(
                    r,
                    info.start.get(r + ':' + ci),
                    Math.min(spanOf(cell, 'rowspan'), model.rows.length - r),
                    spanOf(cell, 'colspan'),
                    model.rows.length,
                    info.cols
                )
                : '';
            const composed = '<' + cell.tag + attrsToString(cell.attrs) + '>'
                + mark + cell.content + '</' + cell.tag + '>';
            for (const part of composed.split('\n')) out.push(part);
        });
        out.push('</tr>');
    });
    out.push('</table>');
    return out;
}

// Lines before the first <tr>. Every marker rides on a line that exists
// anyway, so markers never shift this.
function preludeLines(model) {
    let n = 1;
    if (model.cols) n += 2 + model.cols.length;
    return n;
}

// How many source lines a cell occupies. One, unless its content was wrapped.
function cellLineCount(cell) {
    return 1 + (cell.content.match(/\n/g) || []).length;
}

function rowLineCount(row) {
    let n = 2; // <tr> and </tr>
    for (const cell of row.cells) n += cellLineCount(cell);
    return n;
}

// Cell address <-> line number is still arithmetic — walking line counts
// rather than counting cells, now that a cell can span more than one line.
// Returns the FIRST line of the cell.
function lineOfCell(model, r, ci) {
    let n = preludeLines(model);
    for (let i = 0; i < r; i++) n += rowLineCount(model.rows[i]);
    n += 1; // the <tr> line
    for (let k = 0; k < ci; k++) n += cellLineCount(model.rows[r].cells[k]);
    return n;
}

// Inverse of lineOfCell, mapping a line in the SOURCE we parsed. `cell` is -1
// on <tr>/</tr> lines, and row is -1 on the table/colgroup lines.
function cellAtLine(model, off) {
    let n = 1;
    // An older table may still carry the standalone `<!-- cols: … -->` legend
    // this format used to emit. It occupies a line in the source but is never
    // written back, so only this direction accounts for it.
    if (model.sourceLegend) {
        if (off === n) return { row: -1, cell: -1 };
        n += 1;
    }
    if (model.cols) {
        if (off >= n && off < n + 2 + model.cols.length) return { row: -1, cell: -1 };
        n += 2 + model.cols.length;
    }
    for (let r = 0; r < model.rows.length; r++) {
        if (off === n) return { row: r, cell: -1 };      // the <tr> line
        let m = n + 1;
        for (let ci = 0; ci < model.rows[r].cells.length; ci++) {
            const span = cellLineCount(model.rows[r].cells[ci]);
            // Anywhere within a wrapped cell counts as being in that cell.
            if (off >= m && off < m + span) return { row: r, cell: ci };
            m += span;
        }
        if (off === m) return { row: r, cell: -1 };      // the </tr> line
        n = m + 1;
    }
    return { row: -1, cell: -1 };
}

// Name the first line the fast parser cannot read, and why. Without this the
// failure is invisible: the toolbar dims to look exactly as it does when the
// cursor is outside a table, so nothing tells you that a stray character on a
// <tr> line is the reason. Messages are short enough for the status bar.
function diagnose(lines, base) {
    const at = (i, why) => ({ line: base + i, why });
    if (!lines.length || !RE_TABLE_OPEN.test(lines[0])) return at(0, 'the <table> tag needs a line to itself');

    const last = lines.length - 1;
    // Tracks the cell currently left open, so a wrapped cell's continuation
    // lines are read as its content rather than as stray text.
    let open = null;
    let openedAt = 0;
    for (let i = 1; i < last; i++) {
        const l = lines[i];
        if (!l.trim()) {
            return at(i, open
                ? 'a blank line ends the table; reformatting turns it into <br><br>'
                : 'a blank line ends the table');
        }
        if (open) {
            if (new RegExp('<\\/' + open + '>[ \\t]*$', 'i').test(l)) open = null;
            else if (/<\/(?:td|th)>/i.test(l)) return at(i, 'a different cell closes inside this one');
            continue;
        }
        if (/^[ \t]*<tr\b/i.test(l) && !RE_TR_OPEN.test(l)) {
            return at(i, 'text on the <tr> line — cell text belongs between <td> and </td>');
        }
        if (/^[ \t]*<\/tr>/i.test(l) && !RE_TR_CLOSE.test(l)) return at(i, 'text after </tr>');
        if (/<\/(?:td|th)>[\s\S]*<(?:td|th)\b/i.test(l)) return at(i, 'two cells share this line');
        const cellOpen = RE_CELL_OPEN.exec(l);
        if (cellOpen && !RE_CELL.test(l)) {
            if (/<\/(?:td|th)>/i.test(l.slice(cellOpen[0].length))) {
                return at(i, 'this cell does not close at the end of its line');
            }
            open = cellOpen[1].toLowerCase();
            openedAt = i;
            continue;
        }
        if (!/^[ \t]*<(?:tr\b|\/tr>|td\b|th\b|col\b|colgroup\b|\/colgroup>|!--)/i.test(l)) {
            return at(i, 'text outside a cell — it belongs between <td> and </td>');
        }
    }
    // Point at where the cell opened, not where we ran out of table — that is
    // the line whose closing tag is missing.
    if (open) return at(openedAt, 'this cell is never closed');
    if (!RE_TABLE_CLOSE.test(lines[last])) return at(last, 'the </table> tag needs a line to itself');
    return null;
}

// How many cells start before this line. A table being repaired does not
// parse, so there is no model to ask — counting opening tags is the only way
// to keep the caret near where the author was working instead of throwing
// them back to the first cell.
function cellsBefore(lines, offset) {
    let n = 0;
    for (let i = 0; i < offset && i < lines.length; i++) {
        if (RE_CELL_OPEN.test(lines[i])) n++;
    }
    return Math.max(0, n - 1);
}

// The nth cell of the table, counting across rows.
function cellByIndex(model, n) {
    let seen = 0;
    for (let r = 0; r < model.rows.length; r++) {
        const len = model.rows[r].cells.length;
        if (n < seen + len) return { row: r, cell: n - seen };
        seen += len;
    }
    return { row: 0, cell: 0 };
}

// Which cell an end of a mouse selection refers to. Endpoints routinely miss
// cell lines: dragging down through a row leaves the cursor at the start of
// the next line, which may be </tr>, and a drag can begin above the first cell
// or end past the last. Snap inwards to the nearest real cell instead of
// refusing — the alternative is a merge button that silently does nothing
// depending on exactly where the mouse came to rest.
function resolveEndpoint(model, off, atEnd) {
    const pos = cellAtLine(model, off);
    if (pos.row >= 0 && pos.cell >= 0) return pos;
    if (pos.row >= 0) {
        const count = model.rows[pos.row].cells.length;
        if (count) return { row: pos.row, cell: atEnd ? count - 1 : 0 };
    }
    // Off the rows altogether (the <table>, colgroup or </table> lines, or
    // past the end of the block): take the first or last cell in the table.
    const order = model.rows.map((r, i) => i);
    if (atEnd) order.reverse();
    for (const r of order) {
        const count = model.rows[r].cells.length;
        if (count) return { row: r, cell: atEnd ? count - 1 : 0 };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Grid map
// ---------------------------------------------------------------------------

// Expand colspan/rowspan into a dense matrix. Without this, "delete column 2"
// means different things in rows that carry merged cells; with it, every
// structural op works in grid coordinates and stays correct.
function gridInfo(model) {
    const rows = model.rows;
    const grid = rows.map(() => []);
    const start = new Map(); // "row:cellIndex" -> starting grid column

    for (let r = 0; r < rows.length; r++) {
        let c = 0;
        for (let ci = 0; ci < rows[r].cells.length; ci++) {
            const cell = rows[r].cells[ci];
            while (grid[r][c]) c++;
            const cs = spanOf(cell, 'colspan');
            // Clamp a rowspan that reaches past the last row: the extra rows
            // do not exist, and every op downstream assumes grid[r] is real.
            const rs = Math.min(spanOf(cell, 'rowspan'), rows.length - r);
            start.set(r + ':' + ci, c);
            for (let dr = 0; dr < rs; dr++) {
                for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = { row: r, cell: ci };
            }
            c += cs;
        }
    }

    let cols = 0;
    for (const g of grid) cols = Math.max(cols, g.length);
    for (const g of grid) {
        for (let c = 0; c < cols; c++) if (!g[c]) g[c] = null;
    }
    return { grid, cols, start };
}

function anchorKey(g) {
    return g.row + ':' + g.cell;
}

function cellOf(model, g) {
    return model.rows[g.row].cells[g.cell];
}

// Grid column a given cell occupies, for turning "the cursor is in row 2,
// cell 1" into "the cursor is in column 3".
function columnOfCell(model, r, ci) {
    if (r < 0 || ci < 0) return 0;
    const { start } = gridInfo(model);
    const c = start.get(r + ':' + ci);
    return c === undefined ? 0 : c;
}

// ---------------------------------------------------------------------------
// Structural operations (pure: mutate the model, return the cell to focus)
// ---------------------------------------------------------------------------

function insertRow(model, at) {
    const { grid, cols } = gridInfo(model);
    const bumped = new Set();
    let absorbed = 0;

    // A cell whose rowspan straddles the insertion point grows instead of the
    // new row getting a cell in that column.
    if (at > 0 && at < model.rows.length) {
        for (let c = 0; c < cols; c++) {
            const a = grid[at - 1][c];
            const b = grid[at][c];
            if (a && b && a.row === b.row && a.cell === b.cell) {
                absorbed++;
                const key = anchorKey(a);
                if (!bumped.has(key)) {
                    bumped.add(key);
                    const cell = cellOf(model, a);
                    setSpan(cell, 'rowspan', spanOf(cell, 'rowspan') + 1);
                }
            }
        }
    }

    const need = cols - absorbed;
    if (need <= 0) fail('Cannot insert a row here: every column is spanned across this boundary.');

    const cells = [];
    for (let k = 0; k < need; k++) cells.push(newCell('td'));
    model.rows.splice(at, 0, { attrs: [], cells });
    return { row: at, cell: 0 };
}

function deleteRow(model, r) {
    if (model.rows.length <= 1) fail('Cannot delete the only row. Use "Delete table" instead.');
    const { grid, cols, start } = gridInfo(model);

    const movers = [];
    const seen = new Set();
    for (let c = 0; c < cols; c++) {
        const g = grid[r][c];
        if (!g) continue;
        const key = anchorKey(g);
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = cellOf(model, g);
        const rs = spanOf(cell, 'rowspan');
        if (g.row < r) {
            // Passes through this row from above: it just gets shorter.
            setSpan(cell, 'rowspan', rs - 1);
        } else if (rs > 1) {
            // Anchored here but continues below: re-anchor it in the next row.
            setSpan(cell, 'rowspan', rs - 1);
            movers.push({ col: start.get(key), cell });
        }
    }

    // Columns of the next row's own cells, captured before the splice while
    // the grid coordinates are still valid.
    const keep = [];
    if (r + 1 < model.rows.length) {
        model.rows[r + 1].cells.forEach((cell, ci) => {
            keep.push({ col: start.get(r + 1 + ':' + ci), cell });
        });
    }

    model.rows.splice(r, 1);
    if (movers.length && r < model.rows.length) {
        model.rows[r].cells = keep.concat(movers).sort((a, b) => a.col - b.col).map((x) => x.cell);
    }
    return { row: Math.min(r, model.rows.length - 1), cell: 0 };
}

function insertColumn(model, at) {
    const { grid, cols, start } = gridInfo(model);
    const bumped = new Set();
    const covered = new Set(); // rows that need no new cell

    if (at > 0 && at < cols) {
        for (let r = 0; r < model.rows.length; r++) {
            const a = grid[r][at - 1];
            const b = grid[r][at];
            if (a && b && a.row === b.row && a.cell === b.cell) {
                covered.add(r);
                const key = anchorKey(a);
                if (!bumped.has(key)) {
                    bumped.add(key);
                    const cell = cellOf(model, a);
                    setSpan(cell, 'colspan', spanOf(cell, 'colspan') + 1);
                }
            }
        }
    }

    for (let r = 0; r < model.rows.length; r++) {
        if (covered.has(r)) continue;
        const row = model.rows[r];
        let idx = row.cells.length;
        for (let ci = 0; ci < row.cells.length; ci++) {
            if (start.get(r + ':' + ci) >= at) { idx = ci; break; }
        }
        const tag = row.cells.length && row.cells.every((c) => c.tag === 'th') ? 'th' : 'td';
        row.cells.splice(idx, 0, newCell(tag));
    }

    if (model.cols) {
        model.cols.splice(Math.min(at, model.cols.length), 0, []);
        syncColumnSizing(model);
    }
    return { row: 0, cell: 0, column: at };
}

function deleteColumn(model, at) {
    const { grid, cols } = gridInfo(model);
    if (cols <= 1) fail('Cannot delete the only column. Use "Delete table" instead.');

    const seen = new Set();
    const removals = [];
    for (let r = 0; r < model.rows.length; r++) {
        const g = grid[r][at];
        if (!g) continue;
        const key = anchorKey(g);
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = cellOf(model, g);
        const cs = spanOf(cell, 'colspan');
        if (cs > 1) setSpan(cell, 'colspan', cs - 1);
        else removals.push({ r: g.row, ci: g.cell });
    }

    // Descending order so earlier splices do not shift later indices.
    removals.sort((a, b) => (b.r - a.r) || (b.ci - a.ci));
    for (const x of removals) model.rows[x.r].cells.splice(x.ci, 1);
    model.rows = model.rows.filter((row) => row.cells.length);
    if (!model.rows.length) fail('That would empty the table. Use "Delete table" instead.');
    if (model.cols && at < model.cols.length) {
        model.cols.splice(at, 1);
        syncColumnSizing(model);
    }
    return { row: 0, cell: 0, column: Math.max(0, at - 1) };
}

// Merge the rectangle spanning two grid coordinates. The rectangle is grown
// until it contains every cell it touches in full, so merging over an already
// merged cell stays well-formed instead of producing overlapping spans.
function mergeCells(model, r1, c1, r2, c2) {
    const { grid, start } = gridInfo(model);
    let top = Math.min(r1, r2);
    let bot = Math.max(r1, r2);
    let left = Math.min(c1, c2);
    let right = Math.max(c1, c2);

    let changed = true;
    while (changed) {
        changed = false;
        for (let r = top; r <= bot; r++) {
            for (let c = left; c <= right; c++) {
                const g = grid[r] && grid[r][c];
                if (!g) continue;
                const cell = cellOf(model, g);
                const sc = start.get(anchorKey(g));
                const sr = g.row;
                const ec = sc + spanOf(cell, 'colspan') - 1;
                const er = sr + Math.min(spanOf(cell, 'rowspan'), model.rows.length - sr) - 1;
                if (sr < top) { top = sr; changed = true; }
                if (er > bot) { bot = er; changed = true; }
                if (sc < left) { left = sc; changed = true; }
                if (ec > right) { right = ec; changed = true; }
            }
        }
    }

    const members = [];
    const seen = new Set();
    for (let r = top; r <= bot; r++) {
        for (let c = left; c <= right; c++) {
            const g = grid[r][c];
            if (!g) continue;
            const key = anchorKey(g);
            if (seen.has(key)) continue;
            seen.add(key);
            members.push(g);
        }
    }
    if (members.length < 2) fail('Select at least two cells to merge.');

    const head = grid[top][left];
    const anchor = cellOf(model, head);
    const parts = members
        .map((g) => cellOf(model, g).content.trim())
        .filter(Boolean);
    anchor.content = parts.join('<br>');
    setSpan(anchor, 'colspan', right - left + 1);
    setSpan(anchor, 'rowspan', bot - top + 1);

    const drop = members
        .filter((g) => g.row !== head.row || g.cell !== head.cell)
        .sort((a, b) => (b.row - a.row) || (b.cell - a.cell));
    for (const g of drop) model.rows[g.row].cells.splice(g.cell, 1);

    // Removing cells shifts indices in the anchor's own row.
    const shift = drop.filter((g) => g.row === head.row && g.cell < head.cell).length;
    return { row: head.row, cell: head.cell - shift };
}

// Merge the cell holding the cursor with its neighbour. Needs no selection at
// all, which is what makes it work in Live Preview — there, dragging over a
// rendered table produces nothing the source-side selection logic can read.
// Both directions start from the cell's full extent, so a cell that is already
// merged grows rather than tangling its spans.
function mergeDirection(model, r, ci, dir) {
    const cell = needCell(model, r, ci);
    const { grid, cols, start } = gridInfo(model);
    const col = start.get(r + ':' + ci);
    const cs = spanOf(cell, 'colspan');
    const rs = Math.min(spanOf(cell, 'rowspan'), model.rows.length - r);

    if (dir === 'right') {
        const target = col + cs;
        if (target >= cols || !grid[r][target]) fail('There is no cell to the right of this one.');
        return mergeCells(model, r, col, r + rs - 1, target);
    }
    const targetRow = r + rs;
    if (targetRow >= model.rows.length || !grid[targetRow][col]) {
        fail('There is no cell below this one.');
    }
    return mergeCells(model, r, col, targetRow, col + cs - 1);
}

function splitCell(model, r, ci) {
    const cell = needCell(model, r, ci);
    const cs = spanOf(cell, 'colspan');
    const rs = Math.min(spanOf(cell, 'rowspan'), model.rows.length - r);
    if (cs === 1 && rs === 1) fail('This cell is not merged.');

    const col = columnOfCell(model, r, ci);
    setSpan(cell, 'colspan', 1);
    setSpan(cell, 'rowspan', 1);

    const extra = [];
    for (let k = 1; k < cs; k++) extra.push(newCell(cell.tag));
    model.rows[r].cells.splice(ci + 1, 0, ...extra);

    // Rows the cell used to cover now need real cells of their own. The grid
    // is recomputed each pass because the previous insertion moved columns.
    for (let rr = r + 1; rr < r + rs; rr++) {
        const info = gridInfo(model);
        const row = model.rows[rr];
        let idx = row.cells.length;
        for (let k = 0; k < row.cells.length; k++) {
            if (info.start.get(rr + ':' + k) >= col) { idx = k; break; }
        }
        const fresh = [];
        for (let k = 0; k < cs; k++) fresh.push(newCell('td'));
        row.cells.splice(idx, 0, ...fresh);
    }
    return { row: r, cell: ci };
}

function toggleHeaderRow(model, r) {
    const row = model.rows[r];
    if (!row.cells.length) fail('This row has no cells of its own (it is covered by a merge).');
    const toHeader = !row.cells.every((c) => c.tag === 'th');
    for (const c of row.cells) c.tag = toHeader ? 'th' : 'td';
    return { row: r, cell: 0 };
}

function setCellAlign(model, r, ci, align) {
    applyExclusiveClass(needCell(model, r, ci).attrs, CELL_ALIGN[align] || null, CELL_ALIGN_GROUP);
    return { row: r, cell: ci };
}

// Column alignment has to be per-cell: text-align is not among the handful of
// properties that apply to <col>, and it does not inherit through one either.
function setColumnAlign(model, col, align) {
    const { grid } = gridInfo(model);
    const seen = new Set();
    for (let r = 0; r < model.rows.length; r++) {
        const g = grid[r][col];
        if (!g) continue;
        const key = anchorKey(g);
        if (seen.has(key)) continue;
        seen.add(key);
        applyExclusiveClass(cellOf(model, g).attrs, CELL_ALIGN[align] || null, CELL_ALIGN_GROUP);
    }
    return null;
}

function setTableAlign(model, align) {
    applyExclusiveClass(model.attrs, TABLE_ALIGN[align] || null, TABLE_ALIGN_GROUP);
    return null;
}

// The table's own line, which is also what every row and column edge falls
// back to.
function tableLineFormat(model) {
    return {
        width: getStyleProp(model.attrs, LINE_WIDTH_PROP) || DEFAULT_LINE_WIDTH,
        style: getStyleProp(model.attrs, LINE_STYLE_PROP) || DEFAULT_LINE_STYLE,
        color: getStyleProp(model.attrs, LINE_COLOR_PROP),
    };
}

function currentBorder(model) {
    const classes = getClasses(model.attrs);
    for (const key of Object.keys(TABLE_BORDER)) {
        if (TABLE_BORDER[key] && classes.includes(TABLE_BORDER[key])) return key;
    }
    return 'grid';
}

function setTableBorder(model, preset, opts) {
    if (!(preset in TABLE_BORDER)) fail('Unknown border pattern.');
    const o = opts || {};
    if (o.style && !LINE_STYLES.some((s) => s.key === o.style)) fail('Unknown line type.');
    setExclusiveClass(model.attrs, TABLE_BORDER[preset], TABLE_BORDER_GROUP);
    // The stylesheet defaults to a 1px solid line in the theme's border
    // colour, so writing any of those out again would only add noise.
    setStyleProp(model.attrs, LINE_WIDTH_PROP, o.width && o.width !== DEFAULT_LINE_WIDTH ? o.width : '');
    setStyleProp(model.attrs, LINE_STYLE_PROP, o.style && o.style !== DEFAULT_LINE_STYLE ? o.style : '');
    setStyleProp(model.attrs, LINE_COLOR_PROP, o.color || '');
    return null;
}

// Thickness/type/colour for one row or column edge, written onto `attrs` —
// the <tr> or the cell, never the table. Only values that differ from the
// table's own line are written, so "same as the table" costs nothing in the
// source and keeps following the table if that changes later.
function writeLineProps(model, attrs, props, o, keep) {
    const t = tableLineFormat(model);
    setStyleProp(attrs, props.width, keep && o.width && o.width !== t.width ? o.width : '');
    setStyleProp(attrs, props.style, keep && o.style && o.style !== t.style ? o.style : '');
    setStyleProp(attrs, props.color, keep && o.color && o.color !== t.color ? o.color : '');
}

// The format an edge currently has, falling back to the table's line for
// anything it does not override.
function readLineProps(model, attrs, props) {
    const t = tableLineFormat(model);
    return {
        width: getStyleProp(attrs, props.width) || t.width,
        style: getStyleProp(attrs, props.style) || t.style,
        color: getStyleProp(attrs, props.color) || t.color,
    };
}

function checkEdges(edges, map, what) {
    for (const e of edges) if (!map[e]) fail('Unknown ' + what + ' edge.');
}

function rowEdges(model, r) {
    if (r < 0 || r >= model.rows.length) return [];
    const cls = getClasses(model.rows[r].attrs);
    const out = [];
    if (cls.includes(ROW_EDGE.top)) out.push('top');
    if (cls.includes(ROW_EDGE.bottom) || cls.includes('tt-rule')) out.push('bottom');
    return out;
}

function setRowBorder(model, r, edges, opts) {
    if (r < 0 || r >= model.rows.length) fail('That row does not exist.');
    const o = opts || {};
    if (o.style && !LINE_STYLES.some((s) => s.key === o.style)) fail('Unknown line type.');
    checkEdges(edges, ROW_EDGE, 'row');
    const attrs = model.rows[r].attrs;
    for (const c of ROW_EDGE_GROUP) removeClass(attrs, c);
    for (const e of edges) addClass(attrs, ROW_EDGE[e]);
    // On this row alone, so setting row 4 blue leaves row 2 red.
    writeLineProps(model, attrs, ROW_LINE, o, edges.length > 0);
    // Sweep up the table-level copy the earlier shared-format design wrote,
    // which would otherwise still be inherited by every other row.
    writeLineProps(model, model.attrs, ROW_LINE, {}, false);
    return { row: r, cell: 0 };
}

function rowLineFormat(model, r) {
    const attrs = r >= 0 && r < model.rows.length ? model.rows[r].attrs : [];
    return readLineProps(model, attrs, ROW_LINE);
}

// A column has no element of its own — <col> borders lose the collapsed-border
// conflict against the cells — so the edge is marked on the cells that sit on
// it. A cell spanning several columns counts as being on the left edge of the
// first and the right edge of the last.
function eachColumnEdge(model, col, fn) {
    const { start } = gridInfo(model);
    model.rows.forEach((row, r) => {
        row.cells.forEach((cell, ci) => {
            const first = start.get(r + ':' + ci);
            const last = first + spanOf(cell, 'colspan') - 1;
            if (first === col) fn(cell, 'left');
            if (last === col) fn(cell, 'right');
        });
    });
}

function columnEdges(model, col) {
    const found = new Set();
    eachColumnEdge(model, col, (cell, side) => {
        if (getClasses(cell.attrs).includes(COL_EDGE[side])) found.add(side);
    });
    return ['left', 'right'].filter((s) => found.has(s));
}

function setColumnBorder(model, col, edges, opts) {
    const { cols } = gridInfo(model);
    if (col < 0 || col >= cols) fail('That column does not exist.');
    const o = opts || {};
    if (o.style && !LINE_STYLES.some((s) => s.key === o.style)) fail('Unknown line type.');
    checkEdges(edges, COL_EDGE, 'column');
    const want = new Set(edges);
    eachColumnEdge(model, col, (cell, side) => {
        removeClass(cell.attrs, COL_EDGE[side]);
        if (want.has(side)) addClass(cell.attrs, COL_EDGE[side]);
        // On the cells of this column alone, and per side, so a cell serving
        // two columns can carry a different line on each of them.
        writeLineProps(model, cell.attrs, COL_LINE[side], o, want.has(side));
    });
    writeLineProps(model, model.attrs, LEGACY_COL_LINE, {}, false);
    return null;
}

function columnLineFormat(model, col) {
    let found = null;
    eachColumnEdge(model, col, (cell, side) => {
        if (!found && getClasses(cell.attrs).includes(COL_EDGE[side])) found = { cell, side };
    });
    return found
        ? readLineProps(model, found.cell.attrs, COL_LINE[found.side])
        : readLineProps(model, [], COL_LINE.left);
}

function ensureColgroup(model) {
    const { cols } = gridInfo(model);
    if (!model.cols) {
        model.colgroupAttrs = [];
        model.cols = [];
    }
    while (model.cols.length < cols) model.cols.push([]);
    return model.cols;
}

// A <col> width binds only in a fixed table layout, so that is recorded as a
// class for the stylesheet to act on, and comes off again when the last width
// goes.
function syncColumnSizing(model) {
    const widths = (model.cols || [])
        .map((col) => (getStyleProp(col, 'width') || '').trim())
        .filter(Boolean);
    setExclusiveClass(model.attrs, widths.length ? SIZED_CLASS : null, [SIZED_CLASS]);
    // Always cleared: a table styled while percentages were still offered
    // sheds the flag the first time anything touches it.
    setExclusiveClass(model.attrs, null, [SIZED_PCT_CLASS]);
}

function setColumnWidth(model, col, width) {
    // Written unchecked, a value with no unit — a bare "38" meant as a
    // width — becomes `width:38`, which is not a CSS length. The browser drops
    // it silently, so the column never moves and nothing says why.
    if (width && width.trim().endsWith('%')) {
        fail('Column widths use absolute units — try 12em or 220px. A percentage would have to be a percentage of a fixed table width, which changes how the whole table sits on the page.');
    }
    if (width && !isLengthish(width)) {
        fail('"' + width + '" is not a CSS length. Try 12em or 220px — a number on its own has no unit, so the browser ignores it.');
    }
    const cols = ensureColgroup(model);
    if (col >= cols.length) fail('That column does not exist.');
    setStyleProp(cols[col], 'width', width);
    // An all-empty colgroup is noise; drop it.
    if (model.cols.every((c) => !c.length)) {
        model.cols = null;
        model.colgroupAttrs = null;
    }
    syncColumnSizing(model);
    return null;
}

function setCellBackground(model, r, ci, color) {
    const attrs = needCell(model, r, ci).attrs;
    // Clear the longhand too, so a value written by hand as background-color
    // cannot survive underneath the shorthand we set.
    setStyleProp(attrs, 'background-color', '');
    setStyleProp(attrs, 'background', color);
    return { row: r, cell: ci };
}

// ---------------------------------------------------------------------------
// Fallback path: DOMParser -> canonical source
// ---------------------------------------------------------------------------

function modelFromElement(table) {
    const model = {
        attrs: [], colgroupAttrs: null, cols: null, markers: false, sourceLegend: false, rows: [],
    };
    for (const a of Array.from(table.attributes)) model.attrs.push({ name: a.name, value: a.value });

    const cg = table.querySelector(':scope > colgroup');
    if (cg) {
        model.colgroupAttrs = Array.from(cg.attributes).map((a) => ({ name: a.name, value: a.value }));
        model.cols = Array.from(cg.querySelectorAll(':scope > col'))
            .map((col) => Array.from(col.attributes).map((a) => ({ name: a.name, value: a.value })));
    }

    // table.rows flattens thead/tbody/tfoot, which is what the canonical
    // format wants — section tags carry no meaning we use.
    for (const tr of Array.from(table.rows)) {
        const row = {
            attrs: Array.from(tr.attributes).map((a) => ({ name: a.name, value: a.value })),
            cells: [],
        };
        for (const td of Array.from(tr.cells)) {
            row.cells.push({
                tag: td.tagName.toLowerCase(),
                attrs: Array.from(td.attributes).map((a) => ({ name: a.name, value: a.value })),
                // Markers are generated, and innerHTML hands them back as part
                // of the content — so without stripping them here a reformat
                // prepends a second one to the one already there. The fast
                // parser has always done this; the repair path had not.
                // A blank line inside an HTML block terminates it under
                // CommonMark, so a paragraph break cannot survive as one and
                // becomes two <br>. An ordinary wrap can survive, and is left
                // exactly as the author typed it. Trimmed first, so
                // indentation around the content does not become stray breaks.
                content: td.innerHTML
                    .trim()
                    .replace(RE_CELL_MARKER, '')
                    .replace(/[ \t]*\r?\n[ \t]*\r?\n\s*/g, '<br><br>'),
            });
        }
        model.rows.push(row);
    }
    return model.rows.length ? model : null;
}

function canonicalize(text, markers) {
    if (typeof DOMParser === 'undefined') return null;
    let doc;
    try {
        doc = new DOMParser().parseFromString(text, 'text/html');
    } catch (e) {
        return null;
    }
    const table = doc.querySelector('table');
    if (!table) return null;
    // A nested table would be flattened into its parent's cell content by the
    // line format; refuse rather than silently mangle it.
    if (table.querySelector('table')) return null;
    const model = modelFromElement(table);
    if (!model) return null;
    // Any existing legend/row comments were dropped with the rest of the DOM
    // noise; they get rebuilt from scratch here.
    model.markers = !!markers;
    stampMarker(model);
    return serializeTable(model);
}

function stampMarker(model) {
    const classes = getClasses(model.attrs);
    if (!classes.includes(TABLE_CLASS)) {
        classes.unshift(TABLE_CLASS);
        setClasses(model.attrs, classes);
    }
    setAttr(model.attrs, MARKER_ATTR, MARKER_VALUE);
}

function buildTableLines(rows, cols, header, markers) {
    const model = {
        attrs: [
            { name: 'class', value: TABLE_CLASS },
            { name: MARKER_ATTR, value: MARKER_VALUE },
        ],
        colgroupAttrs: null,
        cols: null,
        markers: !!markers,
        sourceLegend: false,
        rows: [],
    };
    for (let r = 0; r < rows; r++) {
        const cells = [];
        for (let c = 0; c < cols; c++) cells.push(newCell(header && r === 0 ? 'th' : 'td'));
        model.rows.push({ attrs: [], cells });
    }
    return serializeTable(model);
}

// Semi-transparent by design: a solid pastel that looks right on a light
// theme turns into a glaring block on a dark one, whereas a low-alpha wash
// tints whatever the note background happens to be.
const DEFAULT_CELL_SHADES = [
    { name: 'Yellow', value: 'rgba(255, 213, 0, 0.28)' },
    { name: 'Orange', value: 'rgba(255, 146, 43, 0.28)' },
    { name: 'Red', value: 'rgba(224, 49, 58, 0.24)' },
    { name: 'Pink', value: 'rgba(246, 89, 171, 0.24)' },
    { name: 'Purple', value: 'rgba(151, 117, 250, 0.26)' },
    { name: 'Blue', value: 'rgba(51, 154, 240, 0.26)' },
    { name: 'Teal', value: 'rgba(18, 184, 174, 0.26)' },
    { name: 'Green', value: 'rgba(64, 192, 87, 0.26)' },
    { name: 'Grey', value: 'rgba(128, 128, 128, 0.2)' },
];

// Parse #rgb / #rrggbb / rgb() / rgba() into { hex, alpha }, so a value the
// note already carries can be shown in the native picker — which speaks
// opaque hex only — without losing its transparency.
function parseColor(value) {
    const s = String(value || '').trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return { hex: '#' + m[1].toLowerCase(), alpha: 1 };
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
    if (m) return { hex: ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase(), alpha: 1 };
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(s);
    if (m) {
        const h = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
        return { hex: '#' + h(m[1]) + h(m[2]) + h(m[3]), alpha: m[4] === undefined ? 1 : Number(m[4]) };
    }
    return null;
}

// Worth remembering as "the last colour used"? Anything the picker can read,
// plus the forms it cannot but CSS can — a named colour or a variable.
function isColorish(value) {
    const s = String(value || '').trim();
    return !!s && (!!parseColor(s) || /^(?:[a-z-]+|var\(--[\w-]+\s*(?:,[^)]*)?\))$/i.test(s));
}

// Worth remembering as "the last width used"? A CSS length, a calc(), or one
// of the keywords that sizes a column without one. Anything else would only
// prefill the next dialog with something that cannot work.
function isLengthish(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    if (/^(?:auto|min-content|max-content|fit-content)$/i.test(s)) return true;
    if (/^calc\(.+\)$/i.test(s)) return true;
    return /^(?:\d+\.?\d*|\.\d+)(?:%|px|em|rem|ch|ex|vw|vh|vmin|vmax|pt|pc|cm|mm|in|q)$/i.test(s);
}

function toRgba(hex, alpha) {
    if (alpha >= 1) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + Number(alpha.toFixed(2)) + ')';
}

// Compare by parsed value, not by string: the same colour can be spelled
// several ways, and a swatch that fails to show as selected because the note
// says `0.2` where the preset says `0.20` is just confusing.
function sameColor(a, b) {
    if ((a || '') === (b || '')) return true;
    const pa = parseColor(a);
    const pb = parseColor(b);
    return !!pa && !!pb && pa.hex === pb.hex && Math.abs(pa.alpha - pb.alpha) < 0.005;
}

// Painting a translucent colour as a flat background would composite it
// against the modal, not the note. Laying it over the note's own background
// as a gradient shows what the cell will actually look like.
function paintSwatch(el, color) {
    el.style.backgroundImage = color ? 'linear-gradient(' + color + ', ' + color + ')' : '';
}

// Images in cells
// ---------------------------------------------------------------------------
// Obsidian resolves ![[image.png]] only for embeds it creates itself; a
// wikilink written inside an HTML block is never processed, and neither a
// vault-relative <img src> nor a hand-written internal-embed element is
// resolved either. So the note stores a readable vault path in an attribute of
// our own, and the plugin turns it into a real source at render time.
const IMG_ATTR = 'data-tt-src';

const IMAGE_EXT = /^(?:png|jpe?g|jfif|gif|webp|avif|svg|bmp|ico|tiff?|heic|heif)$/i;

// A vault's images, ordered so the one being looked for is usually near the
// top: those beside the note first, then most recently changed — which puts a
// just-pasted or just-moved file at the head of the list.
function imageChoices(files, sourcePath) {
    const cut = sourcePath ? sourcePath.lastIndexOf('/') : -1;
    const folder = cut >= 0 ? sourcePath.slice(0, cut + 1) : '';
    const near = (f) => (folder && f.path.startsWith(folder) ? 0 : 1);
    const when = (f) => (f.stat && f.stat.mtime) || 0;
    return files
        .filter((f) => IMAGE_EXT.test(f.extension || ''))
        .sort((a, b) => near(a) - near(b) || when(b) - when(a) || a.path.localeCompare(b.path));
}

// Width goes on the standard HTML attribute rather than an inline style, so
// the cell line stays short and the number is obvious when hand-editing. The
// stylesheet still caps it at the cell width, so a value too large for the
// column shrinks rather than forcing the table wider.
function imageWidth(value) {
    const n = parseInt(String(value || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function imageMarkup(path, width) {
    const name = path.split('/').pop();
    const w = imageWidth(width);
    return '<img ' + IMG_ATTR + '="' + path + '" alt="' + name + '"'
        + (w ? ' width="' + w + '"' : '') + '>';
}

// Resize every image in one cell. An empty width removes the attribute, which
// puts the image back to its natural size.
function setImageWidth(model, r, ci, width) {
    const cell = needCell(model, r, ci);
    const w = imageWidth(width);
    let found = 0;
    cell.content = cell.content.replace(/<img\b[^>]*>/gi, (tag) => {
        found++;
        const bare = tag.replace(/\s+width\s*=\s*"[^"]*"/gi, '');
        return w ? bare.replace(/\s*\/?>$/, ' width="' + w + '">') : bare;
    });
    if (!found) fail('There is no image in this cell.');
    return { row: r, cell: ci };
}

// The width already on the first image in a cell, if any.
function currentImageWidth(model, r, ci) {
    const cell = model.rows[r] && model.rows[r].cells[ci];
    if (!cell) return '';
    const tag = /<img\b[^>]*>/i.exec(cell.content);
    if (!tag) return '';
    const w = /\swidth\s*=\s*"([^"]*)"/i.exec(tag[0]);
    return w ? w[1] : '';
}

// `resolve` maps a vault path to something usable as a src, or null when the
// file cannot be found. Kept separate from Obsidian so it can be tested.
function resolveImages(root, resolve, selector) {
    let done = 0;
    const sel = selector || 'img[' + IMG_ATTR + ']';
    for (const img of Array.from(root.querySelectorAll(sel))) {
        const link = img.getAttribute(IMG_ATTR);
        if (!link) continue;
        const src = resolve(link);
        if (src) {
            img.setAttribute('src', src);
            img.removeClass ? img.removeClass('tt-img-missing') : null;
        } else {
            // Say so rather than leaving an empty element, which renders as
            // nothing at all and collapses the row it sits in.
            img.removeAttribute('src');
            if (img.addClass) img.addClass('tt-img-missing');
            img.setAttribute('alt', 'Missing image: ' + link);
        }
        done++;
    }
    return done;
}

function stripTags(html) {
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
    visible: true,
    // Auto show/hide is off to start with: a strip that appears and vanishes
    // as the cursor moves is the riskier default, so it is opt-in.
    contextual: false,
    statusBar: true,
    stackAboveFontToolbar: true,
    // Alone at the bottom of the window, show the full control set at the
    // font toolbar's size instead of the compact strip.
    expandWhenAlone: true,
    // Percent the bar darkens by when the cursor is outside a table.
    inactiveDim: 14,
    defaultRows: 3,
    defaultCols: 3,
    headerRow: true,
    // Off by default: markers are a navigation aid for big tables, not
    // something every three-row table should pay for in source noise.
    rowMarkers: false,
    cellShades: DEFAULT_CELL_SHADES,
    // Carried between dialogs so repeating a colour or a width across several
    // cells or columns is one click each.
    lastCellShade: '',
    lastColumnWidth: '',
    lastImageWidth: '300',
};

module.exports = class HtmlTableToolbarPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        this.app.workspace.onLayoutReady(() => {
            this.buildToolbar();
            this.watchNeighbour();
            this.watchImages();
            this.updateContext();
        });

        // Runs over every rendered block, in Reading mode and Live Preview
        // alike, turning the stored vault path into a real source.
        this.registerMarkdownPostProcessor((el, ctx) => {
            resolveImages(el, this.imageResolver(ctx && ctx.sourcePath));
        });

        this.addRibbonIcon('table', 'Toggle HTML table toolbar', () => this.toggleToolbar());
        this.addSettingTab(new HtmlTableToolbarSettingTab(this.app, this));

        if (this.settings.statusBar) {
            this.statusEl = this.addStatusBarItem();
            this.wireStatusBar();
        }

        for (const cmd of this.commandList()) {
            this.addCommand({ id: cmd.id, name: cmd.name, editorCallback: cmd.run });
        }
        this.addCommand({
            id: 'toggle-toolbar',
            name: 'Toggle toolbar',
            callback: () => this.toggleToolbar(),
        });

        // There is no cursor-move event in the Obsidian API; selectionchange on
        // the contenteditable is the reliable stand-in. Debounced so a cursor
        // travelling through a table does not make the strip flicker.
        this.requestContext = debounce(() => this.updateContext(), 150, true);
        this.registerDomEvent(document, 'selectionchange', () => this.requestContext());
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.requestContext()));
        this.registerEvent(this.app.workspace.on('editor-change', () => this.requestContext()));
        this.requestRebuild = debounce(() => this.rebuildToolbar(), 400, true);
    }

    onunload() {
        if (this.toolbar) this.toolbar.remove();
    }

    async loadSettings() {
        this.settings = Object.assign({}, structuredClone(DEFAULT_SETTINGS), await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // When the readout is reporting an unreadable table it doubles as the fix:
    // telling someone to "press a button" is no use if they cannot tell which
    // one, so the warning itself is the button.
    wireStatusBar() {
        if (!this.statusEl) return;
        this.statusEl.addClass('tt-status');
        this.registerDomEvent(this.statusEl, 'click', () => {
            if (this.statusEl.hasClass('tt-status-warn')) this.reformatTable();
        });
    }

    toggleToolbar() {
        this.settings.visible = !this.settings.visible;
        this.saveSettings();
        this.updateContext();
    }

    rebuildToolbar() {
        if (this.toolbar) this.toolbar.remove();
        this.buildToolbar();
        this.updateContext();
    }

    // ---------- locating the cursor ----------

    getEditor() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        return view ? view.editor : null;
    }

    // Find the table block containing `line`. Anything ambiguous — a table
    // closing above us, another opening below us, nesting — resolves to "not
    // in a table" rather than a guess.
    findTableBlock(ed, line) {
        const total = ed.lineCount();
        if (line < 0 || line >= total) return null;
        let start = -1;
        for (let i = line; i >= 0; i--) {
            const t = ed.getLine(i);
            if (i !== line && RE_TABLE_CLOSE.test(t)) return null;
            if (RE_TABLE_OPEN.test(t)) { start = i; break; }
        }
        if (start < 0) return null;
        let end = -1;
        for (let i = line; i < total; i++) {
            const t = ed.getLine(i);
            if (i !== start && RE_TABLE_OPEN.test(t)) return null;
            if (RE_TABLE_CLOSE.test(t)) { end = i; break; }
        }
        return end < 0 ? null : { start, end };
    }

    // Loose scan used only by "Reformat table", which exists precisely to fix
    // tables the strict matchers cannot read.
    findLooseBlock(ed, line) {
        const total = ed.lineCount();
        let start = -1;
        for (let i = line; i >= 0; i--) {
            const t = ed.getLine(i);
            if (i !== line && RE_TABLE_CLOSE_LOOSE.test(t) && !RE_TABLE_OPEN_LOOSE.test(t)) return null;
            if (RE_TABLE_OPEN_LOOSE.test(t)) { start = i; break; }
        }
        if (start < 0) return null;
        let end = -1;
        for (let i = start; i < total; i++) {
            if (RE_TABLE_CLOSE_LOOSE.test(ed.getLine(i))) { end = i; break; }
        }
        return end < 0 || end < line ? null : { start, end };
    }

    blockText(ed, block) {
        const lines = [];
        for (let i = block.start; i <= block.end; i++) lines.push(ed.getLine(i));
        return lines;
    }

    replaceBlock(ed, block, lines) {
        ed.replaceRange(
            lines.join('\n'),
            { line: block.start, ch: 0 },
            { line: block.end, ch: ed.getLine(block.end).length }
        );
    }

    // Returns { block, model, row, cell } or null. `repair` lets an operation
    // re-canonicalize a hand-broken table instead of refusing to run.
    locate(ed, repair) {
        const from = ed.getCursor('from');
        let block = this.findTableBlock(ed, from.line);
        if (!block) return null;
        let model = parseTable(this.blockText(ed, block));
        if (!model && repair) {
            const fixed = canonicalize(this.blockText(ed, block).join('\n'), this.settings.rowMarkers);
            if (fixed) {
                this.replaceBlock(ed, block, fixed);
                // Re-find from the <table> line, which cannot move, rather
                // than from the cursor's line, which can. Repair often makes
                // the block SHORTER — rejoining a cell split by a stray Enter
                // takes a line out — and a stale cursor line then sits past
                // </table>, so looking from there reported "not in a table"
                // immediately after successfully fixing the table.
                block = this.findTableBlock(ed, block.start);
                if (block) model = parseTable(this.blockText(ed, block));
            }
        }
        if (!model) return null;
        // A repair may have moved the ground under the cursor, so an offset
        // past the end of the block simply resolves to the first cell.
        const pos = cellAtLine(model, from.line - block.start);
        const row = pos.row < 0 ? 0 : pos.row;
        const cells = model.rows[row].cells.length;
        const cell = pos.cell < 0 ? Math.min(0, cells - 1) : pos.cell;
        return { block, model, row, cell: cells ? Math.max(cell, 0) : -1 };
    }

    // Grid rectangle covered by the current selection, for merge.
    selectionRect(ed, loc) {
        const from = ed.getCursor('from');
        const to = ed.getCursor('to');
        const a = resolveEndpoint(loc.model, from.line - loc.block.start, false);
        const b = resolveEndpoint(loc.model, to.line - loc.block.start, true);
        if (!a || !b) return null;
        const { start } = gridInfo(loc.model);
        const c1 = start.get(a.row + ':' + a.cell);
        const c2 = start.get(b.row + ':' + b.cell);
        if (c1 === undefined || c2 === undefined) return null;
        return { r1: a.row, c1, r2: b.row, c2, single: a.row === b.row && a.cell === b.cell };
    }

    // Every operation funnels through here: locate, mutate the model, write the
    // whole table back, then put the cursor in a sensible cell.
    runOp(mutate) {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        const loc = this.locate(ed, true);
        if (!loc) {
            new Notice('Put the cursor inside an HTML table first (try "Reformat table" if one is there).');
            return;
        }
        let target;
        try {
            target = mutate(loc.model, loc, ed);
        } catch (e) {
            if (e && e.ttUser) { new Notice(e.message); return; }
            console.error('[html-table-toolbar]', e);
            new Notice('That table operation failed — see the developer console.');
            return;
        }
        // Markers are a global mode, so any table this plugin writes conforms
        // to it regardless of what the source happened to carry.
        loc.model.markers = this.settings.rowMarkers;
        // Tables that had column widths set before those widths could bind
        // carry no sizing classes, so any action brings them up to date rather
        // than waiting for the width to be typed in again.
        syncColumnSizing(loc.model);
        stampMarker(loc.model);
        const lines = serializeTable(loc.model);
        this.replaceBlock(ed, loc.block, lines);
        this.focusCell(ed, loc.block.start, loc.model, target || { row: loc.row, cell: loc.cell });
        this.updateContext();
    }

    // Put the caret at the end of a cell's content, i.e. just before </td>.
    focusCell(ed, base, model, target) {
        if (!target || target.row === undefined) { ed.focus(); return; }
        const row = Math.max(0, Math.min(target.row, model.rows.length - 1));
        const cells = model.rows[row].cells.length;
        if (!cells) { ed.focus(); return; }
        const cell = Math.max(0, Math.min(target.cell === undefined ? 0 : target.cell, cells - 1));
        // The closing tag of a wrapped cell is on its last line, not its first.
        const line = base + lineOfCell(model, row, cell)
            + cellLineCount(model.rows[row].cells[cell]) - 1;
        const text = ed.getLine(line) || '';
        const ch = text.lastIndexOf('</');
        ed.setCursor({ line, ch: ch < 0 ? text.length : ch });
        ed.focus();
    }

    // ---------- operations bound to buttons and commands ----------

    // Checked before the size picker opens, so you are told up front rather
    // than after choosing a size.
    openInsertTable() {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        if (this.findTableBlock(ed, ed.getCursor('from').line)) {
            new Notice('The cursor is already in a table, and this format cannot nest them. Move outside it first.');
            return;
        }
        new GridPickerModal(this).open();
    }

    insertTable(rows, cols, header) {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        const cur0 = ed.getCursor('from');
        // Also guarded here, not only at the picker: splicing a <table> into
        // the middle of another one would break both beyond what the parser
        // can recover.
        if (this.findTableBlock(ed, cur0.line)) {
            new Notice('The cursor is already in a table, and this format cannot nest them. Move outside it first.');
            return;
        }
        const lines = buildTableLines(rows, cols, header, this.settings.rowMarkers);
        const cur = ed.getCursor('from');
        const curText = ed.getLine(cur.line);
        // An HTML block needs a blank line between it and a preceding
        // paragraph, or CommonMark folds it into that paragraph.
        const before = curText.trim() ? [curText, ''] : [''];
        const out = before.concat(lines, ['']);
        ed.replaceRange(out.join('\n'), { line: cur.line, ch: 0 }, { line: cur.line, ch: curText.length });
        const base = cur.line + before.length;
        const model = parseTable(lines);
        this.focusCell(ed, base, model, { row: 0, cell: 0 });
        this.updateContext();
    }

    reformatTable() {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        const from = ed.getCursor('from');
        const block = this.findTableBlock(ed, from.line) || this.findLooseBlock(ed, from.line);
        if (!block) { new Notice('Put the cursor inside an HTML table first'); return; }
        const source = this.blockText(ed, block);
        const fixed = canonicalize(source.join('\n'), this.settings.rowMarkers);
        if (!fixed) { new Notice('Could not read that table (nested tables are not supported).'); return; }
        // Where the caret was, in cells rather than lines, so it can be put
        // back after a repair that changes how many lines the table takes.
        const wasIn = cellsBefore(source, from.line - block.start);
        this.replaceBlock(ed, block, fixed);
        const model = parseTable(fixed);
        if (model) this.focusCell(ed, block.start, model, cellByIndex(model, wasIn));
        new Notice('Table reformatted');
        this.updateContext();
    }

    deleteTable() {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        const from = ed.getCursor('from');
        const block = this.findTableBlock(ed, from.line);
        if (!block) { new Notice('Put the cursor inside an HTML table first'); return; }
        const lastLine = ed.lineCount() - 1;
        const to = block.end < lastLine
            ? { line: block.end + 1, ch: 0 }
            : { line: block.end, ch: ed.getLine(block.end).length };
        ed.replaceRange('', { line: block.start, ch: 0 }, to);
        ed.focus();
        this.updateContext();
    }

    // ---------- status readout ----------

    describePosition(loc) {
        if (!loc || loc.cell < 0) return '';
        const col = columnOfCell(loc.model, loc.row, loc.cell);
        let label = '';
        const head = loc.model.rows[0];
        if (head && loc.row > 0) {
            const { grid } = gridInfo(loc.model);
            const g = grid[0][col];
            if (g && g.row === 0) label = stripTags(cellOf(loc.model, g).content).slice(0, 24);
        }
        return 'R' + (loc.row + 1) + ' · C' + (col + 1) + (label ? ' (' + label + ')' : '');
    }

    // Show/hide the strip and refresh the status readout.
    updateContext() {
        const ed = this.getEditor();
        const loc = ed ? this.locate(ed, false) : null;

        // Being inside a table the parser cannot read is a third state, and it
        // used to be indistinguishable from being outside one. The buttons
        // repair the table before acting, so the strip stays live here — it is
        // only the explanation that was missing.
        let problem = null;
        if (!loc && ed) {
            const block = this.findTableBlock(ed, ed.getCursor('from').line);
            if (block) problem = diagnose(this.blockText(ed, block), block.start);
        }
        const inTable = !!loc || !!problem;

        if (this.statusEl) {
            this.statusEl.setText(
                loc ? this.describePosition(loc)
                    : problem
                        ? 'Table: line ' + (problem.line + 1) + ' — ' + problem.why + ' · click to fix'
                        : ''
            );
            this.statusEl.toggleClass('tt-status-warn', !!problem);
            this.statusEl.title = problem
                ? 'Click to reformat this table and fix this'
                : '';
        }
        if (this.markerBtn) this.markerBtn.classList.toggle('tt-on', !!this.settings.rowMarkers);
        this.sweepImages();

        if (!this.toolbar) return;
        const show = this.settings.visible && (!this.settings.contextual || inTable);
        this.toolbar.classList.toggle('tt-hidden', !show);
        this.toolbar.classList.toggle('tt-inactive', !inTable);
        this.positionBar();
    }

    // The link resolver, shared by the post-processor and the sweep below.
    imageResolver(sourcePath) {
        return (link) => {
            const cache = this.app.metadataCache;
            const file = cache && cache.getFirstLinkpathDest(link, sourcePath || '');
            return file ? this.app.vault.getResourcePath(file) : null;
        };
    }

    // A safety net for images the post-processor never reached. Markdown post-
    // processors are the documented hook, but raw HTML blocks are not reliably
    // handed to them — Obsidian's own embed resolution does not reach markup
    // written by hand either — so anything still lacking a src gets picked up
    // here on the next cursor move or edit. Scoped to unresolved images, so a
    // page of already-working ones costs a single querySelectorAll.
    sweepImages() {
        if (typeof document === 'undefined') return 0;
        const root = document.querySelector('.workspace') || document.body;
        if (!root) return 0;
        const active = this.app.workspace.getActiveFile && this.app.workspace.getActiveFile();
        return resolveImages(
            root,
            this.imageResolver(active && active.path),
            'img[' + IMG_ATTR + ']:not([src])'
        );
    }

    // Sweeping on cursor and edit events alone loses a race: leaving a table
    // makes Obsidian re-render the block into fresh DOM, and that happens
    // AFTER the debounced sweep has already run — so the new <img> sat without
    // a source until the next click. Watching for the DOM actually changing
    // removes the guesswork.
    //
    // childList only, and the handler merely schedules: the work is one
    // selector for unresolved images, which is nothing when there are none.
    // Setting src is an attribute change, so the fix cannot retrigger this.
    watchImages() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
        const root = document.querySelector('.workspace') || document.body;
        if (!root) return;
        const run = debounce(() => this.sweepImages(), 50, true);
        const observer = new MutationObserver(() => run());
        observer.observe(root, { childList: true, subtree: true });
        this.register(() => observer.disconnect());
        this.sweepImages();
    }

    applyDim() {
        if (!this.toolbar) return;
        this.toolbar.style.setProperty('--tt-dim', (this.settings.inactiveDim || 0) + '%');
    }

    // Sit above the font toolbar when that plugin is installed and showing,
    // without either plugin importing the other.
    //
    // The offset is measured from the neighbour's actual box rather than
    // assuming its CSS `bottom`, so a user snippet that moves it, or a font
    // toolbar that has wrapped onto two rows, still lands correctly.
    positionBar() {
        if (!this.toolbar) return;
        const font = document.querySelector('.hft-toolbar:not(.hft-hidden)');
        const rect = font ? font.getBoundingClientRect() : null;
        // A zero box means it is present but not laid out yet; a later
        // mutation will bring us back here with real numbers.
        const sharing = !!(rect && rect.height > 0);

        let offset = BASE_BOTTOM;
        if (sharing && this.settings.stackAboveFontToolbar) {
            offset = (window.innerHeight - rect.top) + STACK_GAP;
        }
        this.toolbar.style.bottom = Math.round(offset) + 'px';

        // Alone at the bottom of the window there is room to spare, so spend
        // it: pull the promoted controls out of the overflow menu and take the
        // font toolbar's proportions instead of staying compact. Sharing the
        // space, shrink back. Note this keys off the neighbour actually being
        // there, not off the stacking preference.
        this.toolbar.classList.toggle('tt-expanded', !sharing && this.settings.expandWhenAlone);
    }

    // The neighbouring toolbar can appear, vanish, or change height at any
    // time — its plugin being enabled or disabled mid-session, its own hide
    // button, its settings rebuilding it, or the window narrowing enough to
    // wrap it onto a second row. None of those produce an event we receive,
    // so watch the DOM directly instead of only repositioning on cursor moves.
    watchNeighbour() {
        this.requestPosition = debounce(() => this.positionBar(), 50, true);

        // Cheap: body's direct children change rarely, and this is the only
        // signal for the font plugin loading or unloading.
        const bodyObserver = new MutationObserver(() => this.bindNeighbour());
        bodyObserver.observe(document.body, { childList: true });
        this.register(() => bodyObserver.disconnect());
        this.register(() => {
            if (this.neighbourObserver) this.neighbourObserver.disconnect();
        });

        this.registerDomEvent(window, 'resize', () => this.requestPosition());
        this.bindNeighbour();
    }

    // Re-target the attribute observer at the current font toolbar element.
    // Watching only that one node keeps this off the hot path — observing
    // attributes across the whole body subtree would fire constantly.
    bindNeighbour() {
        // Deliberately unfiltered by .hft-hidden: we need to be watching the
        // element precisely so we hear about that class being toggled.
        const bar = document.querySelector('.hft-toolbar');
        if (bar !== this.neighbourEl) {
            if (this.neighbourObserver) this.neighbourObserver.disconnect();
            this.neighbourEl = bar;
            if (bar) {
                this.neighbourObserver = new MutationObserver(() => this.requestPosition());
                this.neighbourObserver.observe(bar, { attributes: true, attributeFilter: ['class', 'style'] });
            }
        }
        this.requestPosition();
    }

    // ---------- commands ----------

    commandList() {
        const colOf = (model, loc) => columnOfCell(model, loc.row, loc.cell);
        return [
            { id: 'insert-table', name: 'Insert table…', run: () => this.openInsertTable() },
            { id: 'row-above', name: 'Insert row above', run: () => this.runOp((m, l) => insertRow(m, l.row)) },
            { id: 'row-below', name: 'Insert row below', run: () => this.runOp((m, l) => insertRow(m, l.row + 1)) },
            { id: 'row-delete', name: 'Delete row', run: () => this.runOp((m, l) => deleteRow(m, l.row)) },
            { id: 'col-left', name: 'Insert column left', run: () => this.runOp((m, l) => insertColumn(m, colOf(m, l))) },
            { id: 'col-right', name: 'Insert column right', run: () => this.runOp((m, l) => insertColumn(m, colOf(m, l) + 1)) },
            { id: 'col-delete', name: 'Delete column', run: () => this.runOp((m, l) => deleteColumn(m, colOf(m, l))) },
            { id: 'merge-cells', name: 'Merge selected cells', run: () => this.mergeSelection() },
            { id: 'merge-right', name: 'Merge with cell to the right', run: () => this.runOp((m, l) => mergeDirection(m, l.row, l.cell, 'right')) },
            { id: 'merge-down', name: 'Merge with cell below', run: () => this.runOp((m, l) => mergeDirection(m, l.row, l.cell, 'down')) },
            { id: 'split-cell', name: 'Split cell', run: () => this.runOp((m, l) => splitCell(m, l.row, l.cell)) },
            { id: 'toggle-header', name: 'Toggle header row', run: () => this.runOp((m, l) => toggleHeaderRow(m, l.row)) },
            { id: 'cell-align-left', name: 'Align cell left', run: () => this.runOp((m, l) => setCellAlign(m, l.row, l.cell, 'left')) },
            { id: 'cell-align-center', name: 'Align cell center', run: () => this.runOp((m, l) => setCellAlign(m, l.row, l.cell, 'center')) },
            { id: 'cell-align-right', name: 'Align cell right', run: () => this.runOp((m, l) => setCellAlign(m, l.row, l.cell, 'right')) },
            { id: 'column-align-left', name: 'Align column left', run: () => this.runOp((m, l) => setColumnAlign(m, colOf(m, l), 'left')) },
            { id: 'column-align-center', name: 'Align column center', run: () => this.runOp((m, l) => setColumnAlign(m, colOf(m, l), 'center')) },
            { id: 'column-align-right', name: 'Align column right', run: () => this.runOp((m, l) => setColumnAlign(m, colOf(m, l), 'right')) },
            { id: 'table-align-left', name: 'Align table left', run: () => this.runOp((m) => setTableAlign(m, 'left')) },
            { id: 'table-align-center', name: 'Center table', run: () => this.runOp((m) => setTableAlign(m, 'center')) },
            { id: 'table-align-right', name: 'Align table right', run: () => this.runOp((m) => setTableAlign(m, 'right')) },
            { id: 'insert-image', name: 'Insert image into cell…', run: () => this.promptInsertImage() },
            { id: 'image-width', name: 'Resize image in cell…', run: () => this.promptImageWidth() },
            { id: 'table-borders', name: 'Table borders…', run: () => this.promptTableBorders() },
            { id: 'row-borders', name: 'Row borders…', run: () => this.promptRowBorders() },
            { id: 'column-borders', name: 'Column borders…', run: () => this.promptColumnBorders() },
            { id: 'column-width', name: 'Set column width…', run: () => this.promptColumnWidth() },
            { id: 'cell-background', name: 'Set cell background…', run: () => this.promptCellBackground() },
            { id: 'toggle-row-markers', name: 'Toggle row and column markers', run: () => this.toggleMarkers() },
            { id: 'reformat-table', name: 'Reformat table', run: () => this.reformatTable() },
            { id: 'delete-table', name: 'Delete table', run: () => this.deleteTable() },
        ];
    }

    // Markers are one global mode, not per-table state: switching it on marks
    // every table in the note you are looking at and every table the plugin
    // touches from then on, and switching it off strips them the same way.
    toggleMarkers() {
        this.setMarkers(!this.settings.rowMarkers, true);
    }

    setMarkers(on, announce) {
        this.settings.rowMarkers = on;
        this.saveSettings();
        const ed = this.getEditor();
        const changed = ed ? this.applyMarkersToNote(ed, on) : 0;
        if (announce) {
            const tables = changed === 1 ? '1 table' : changed + ' tables';
            new Notice(
                (on ? 'Row and column markers on' : 'Row and column markers off') +
                (changed ? ' — ' + tables + ' updated in this note' : '')
            );
        }
        this.updateContext();
        return changed;
    }

    // Every table block in the active note, ignoring nested ones (the line
    // format cannot represent them, so they are left strictly alone).
    tableBlocks(ed) {
        const blocks = [];
        let depth = 0;
        let start = -1;
        let nested = false;
        for (let i = 0; i < ed.lineCount(); i++) {
            const t = ed.getLine(i);
            if (RE_TABLE_OPEN.test(t)) {
                depth++;
                if (depth === 1) { start = i; nested = false; } else nested = true;
            } else if (RE_TABLE_CLOSE.test(t) && depth > 0) {
                depth--;
                if (depth === 0) {
                    if (start >= 0 && !nested) blocks.push({ start, end: i });
                    start = -1;
                }
            }
        }
        return blocks;
    }

    // Bottom-up, so that a table shedding a legacy legend line cannot shift
    // the line numbers of blocks still to be visited.
    applyMarkersToNote(ed, on) {
        const blocks = this.tableBlocks(ed);
        let changed = 0;
        for (let k = blocks.length - 1; k >= 0; k--) {
            const block = blocks[k];
            const lines = this.blockText(ed, block);
            const model = parseTable(lines);
            // A table the fast parser cannot read is left as-is rather than
            // silently reformatted: this switch is about markers, nothing else.
            if (!model) continue;
            model.markers = on;
            const out = serializeTable(model);
            if (out.join('\n') === lines.join('\n')) continue;
            this.replaceBlock(ed, block, out);
            changed++;
        }
        // Markers ride on existing lines, so the cursor is still on the right
        // line — but its column shifted, so put it back inside its cell.
        const loc = this.locate(ed, false);
        if (loc && loc.cell >= 0) {
            this.focusCell(ed, loc.block.start, loc.model, { row: loc.row, cell: loc.cell });
        }
        return changed;
    }

    mergeSelection() {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return; }
        // No repair pass here, unlike every other operation: reformatting
        // rewrites the block, and the selection this depends on would not
        // survive it. Better to say precisely what is wrong than to discard
        // what was selected.
        const loc = this.cellTarget(false);
        if (!loc) return;
        const rect = this.selectionRect(ed, loc);
        if (!rect) { new Notice('Could not tell which cells are selected.'); return; }
        if (rect.single) {
            new Notice('Only one cell is selected. Drag the mouse across two or more cells, then merge.');
            return;
        }
        this.runOp((m) => mergeCells(m, rect.r1, rect.c1, rect.r2, rect.c2));
    }

    promptColumnWidth() {
        const loc = this.cellTarget(false);
        if (!loc) return;
        const col = columnOfCell(loc.model, loc.row, loc.cell);
        const current = loc.model.cols && loc.model.cols[col]
            ? (/width\s*:\s*([^;]+)/i.exec(getAttr(loc.model.cols[col], 'style') || '') || [])[1] || ''
            : '';
        new TextPromptModal(this.app, {
            title: 'Column ' + (col + 1) + ' width',
            desc: 'An absolute CSS length — 12em or 220px. Ems scale with your font size, pixels do not.',
            hint: 'Percentages are not accepted: one would only work by pinning the table to a fixed width of its own, which changes how the whole table sits on the page. An empty field lets the column size itself again.',
            // The column's own width if it has one, otherwise the width you
            // set last — so giving several columns the same width is one
            // click each.
            value: (current || '').trim() || this.settings.lastColumnWidth || '',
            placeholder: '12em',
            onSubmit: (v) => {
                const width = v.trim();
                if (isLengthish(width)) {
                    this.settings.lastColumnWidth = width;
                    this.saveSettings();
                }
                this.runOp((m) => setColumnWidth(m, col, width));
            },
        }).open();
    }

    // Shared by every dialog. A flat "put the cursor in a table" is misleading
    // when the cursor IS in one that simply cannot be read — so when a table
    // is there but unreadable, say which line and why, the same way the status
    // bar does. The dialogs deliberately do not repair on the way in: that
    // would rewrite the note before anything had been chosen.
    cellTarget(needsCell) {
        const ed = this.getEditor();
        if (!ed) { new Notice('Open a note in editing mode first'); return null; }
        const loc = this.locate(ed, false);
        if (loc && (!needsCell || loc.cell >= 0)) return loc;
        if (loc) {
            new Notice('Put the cursor in a table cell first — this row is covered by a merge.');
            return null;
        }
        const block = this.findTableBlock(ed, ed.getCursor('from').line);
        const problem = block && diagnose(this.blockText(ed, block), block.start);
        new Notice(problem
            ? 'This table cannot be read — line ' + (problem.line + 1) + ': ' + problem.why
                + '. Click the warning in the status bar, or run Reformat table, then try again.'
            : 'Put the cursor inside an HTML table first');
        return null;
    }

    borderTarget() {
        return this.cellTarget(false);
    }

    promptTableBorders() {
        const loc = this.borderTarget();
        if (!loc) return;
        new TableBorderModal(this, Object.assign(
            { preset: currentBorder(loc.model) },
            tableLineFormat(loc.model)
        ), (v) => this.runOp((m) => setTableBorder(m, v.preset, v))).open();
    }

    promptRowBorders() {
        const loc = this.borderTarget();
        if (!loc) return;
        // Naming rows by their first cell makes the list pickable without
        // counting down the table.
        const labels = loc.model.rows.map((row, i) => {
            const text = row.cells.length ? stripTags(row.cells[0].content).trim() : '';
            return 'Row ' + (i + 1) + (text ? ' — ' + text.slice(0, 20) : '');
        });
        const stateFor = (i) => Object.assign(
            { edges: rowEdges(loc.model, i) },
            rowLineFormat(loc.model, i)
        );
        new RowBorderModal(this, Object.assign(
            { index: loc.row, labels, stateFor },
            stateFor(loc.row)
        ), (v) => this.runOp((m) => setRowBorder(m, v.index, v.edges, v))).open();
    }

    promptColumnBorders() {
        const loc = this.borderTarget();
        if (!loc) return;
        const { grid, cols } = gridInfo(loc.model);
        const labels = [];
        for (let c = 0; c < cols; c++) {
            const g = grid[0] && grid[0][c];
            const text = g ? stripTags(cellOf(loc.model, g).content).trim() : '';
            labels.push('Column ' + (c + 1) + (text ? ' — ' + text.slice(0, 20) : ''));
        }
        const col = columnOfCell(loc.model, loc.row, loc.cell);
        const stateFor = (i) => Object.assign(
            { edges: columnEdges(loc.model, i) },
            columnLineFormat(loc.model, i)
        );
        new ColumnBorderModal(this, Object.assign(
            { index: col, labels, stateFor },
            stateFor(col)
        ), (v) => this.runOp((m) => setColumnBorder(m, v.index, v.edges, v))).open();
    }

    promptInsertImage() {
        const loc = this.cellTarget(true);
        if (!loc) return;
        const active = this.app.workspace.getActiveFile && this.app.workspace.getActiveFile();
        const images = imageChoices(this.app.vault.getFiles(), active ? active.path : '');
        if (!images.length) { new Notice('No images found in this vault'); return; }
        new ImagePickerModal(this.app, images, (file) => {
            // Width is asked for at the moment of inserting, pre-filled with
            // whatever was used last, so an image arrives the size it should be
            // rather than at whatever the original happens to measure.
            new TextPromptModal(this.app, {
                title: 'Width for ' + file.path.split('/').pop(),
                desc: 'Width in pixels — 300 is a good starting point for a table cell.',
                hint: 'Leave empty for the image\'s own size. It is capped at the cell width either way, so a value too large for the column shrinks instead of stretching the table.',
                value: this.settings.lastImageWidth || '',
                placeholder: '300',
                onSubmit: (v) => {
                    const width = imageWidth(v);
                    this.settings.lastImageWidth = width;
                    this.saveSettings();
                    this.runOp((m, l) => {
                        const cell = needCell(m, l.row, l.cell);
                        // Appended, so it joins whatever text is already there
                        // rather than replacing it.
                        cell.content += imageMarkup(file.path, width);
                        return { row: l.row, cell: l.cell };
                    });
                },
            }).open();
        }).open();
    }

    promptImageWidth() {
        const loc = this.cellTarget(true);
        if (!loc) return;
        const current = currentImageWidth(loc.model, loc.row, loc.cell);
        if (!current && !/<img\b/i.test(loc.model.rows[loc.row].cells[loc.cell].content)) {
            new Notice('There is no image in this cell.');
            return;
        }
        new TextPromptModal(this.app, {
            title: 'Image width',
            desc: 'Width in pixels for the image in this cell.',
            hint: 'Leave empty for the image\'s own size.',
            value: current || this.settings.lastImageWidth || '',
            placeholder: '300',
            onSubmit: (v) => {
                const width = imageWidth(v);
                this.settings.lastImageWidth = width;
                this.saveSettings();
                this.runOp((m, l) => setImageWidth(m, l.row, l.cell, width));
            },
        }).open();
    }

    promptCellBackground() {
        const loc = this.cellTarget(true);
        if (!loc) return;
        const style = getAttr(loc.model.rows[loc.row].cells[loc.cell].attrs, 'style') || '';
        const found = /background(?:-color)?\s*:\s*([^;]+)/i.exec(style);
        new CellShadeModal(this, found ? found[1].trim() : '', (v) => {
            if (isColorish(v)) {
                this.settings.lastCellShade = v;
                this.saveSettings();
            }
            this.runOp((m, l) => setCellBackground(m, l.row, l.cell, v));
        }).open();
    }

    // ---------- toolbar UI ----------

    buildToolbar() {
        const bar = document.createElement('div');
        bar.className = 'tt-toolbar';
        this.toolbar = bar;

        const mkGroup = (label, cls) => {
            const g = document.createElement('div');
            g.className = 'tt-group' + (cls ? ' ' + cls : '');
            if (label) {
                const l = document.createElement('span');
                l.className = 'tt-label';
                l.textContent = label;
                g.appendChild(l);
            }
            bar.appendChild(g);
            return g;
        };

        const mkBtn = (group, title, icon, fallback, onClick) => {
            const b = document.createElement('button');
            b.className = 'tt-btn';
            b.title = title;
            b.setAttribute('aria-label', title);
            // preventDefault on mousedown so the editor keeps focus + selection
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', onClick);
            group.appendChild(b);
            try { setIcon(b, icon); } catch (e) { /* icon set varies by version */ }
            if (!b.querySelector('svg')) b.textContent = fallback;
            return b;
        };

        const op = (fn) => () => this.runOp(fn);
        const colOf = (model, loc) => columnOfCell(model, loc.row, loc.cell);

        let g = mkGroup();
        // Usable only OUTSIDE a table, the exact inverse of every other
        // button, so it fades in the opposite state.
        mkBtn(g, 'Insert table…', 'table', '⊞', () => this.openInsertTable())
            .classList.add('tt-outside-only');

        // Whole-table alignment sits with the whole-table button rather than
        // with the cell and column alignments further along: it is the odd one
        // out of the three, acting on the element instead of on the cursor's
        // cell, and reads better next to Insert.
        g = mkGroup('Table', 'tt-extra');
        mkBtn(g, 'Align table left', 'align-left', '⌐', op((m) => setTableAlign(m, 'left')));
        mkBtn(g, 'Center table', 'align-center', '≡', op((m) => setTableAlign(m, 'center')));
        mkBtn(g, 'Align table right', 'align-right', '¬', op((m) => setTableAlign(m, 'right')));

        g = mkGroup('Row');
        mkBtn(g, 'Insert row above', 'chevron-up', '↑', op((m, l) => insertRow(m, l.row)));
        mkBtn(g, 'Insert row below', 'chevron-down', '↓', op((m, l) => insertRow(m, l.row + 1)));
        mkBtn(g, 'Delete row', 'trash-2', '✕', op((m, l) => deleteRow(m, l.row)));

        g = mkGroup('Col');
        mkBtn(g, 'Insert column left', 'chevron-left', '←', op((m, l) => insertColumn(m, colOf(m, l))));
        mkBtn(g, 'Insert column right', 'chevron-right', '→', op((m, l) => insertColumn(m, colOf(m, l) + 1)));
        mkBtn(g, 'Delete column', 'trash-2', '✕', op((m, l) => deleteColumn(m, colOf(m, l))));

        // The three border scopes, together: whole table, one row, one column.
        g = mkGroup(null, 'tt-extra');
        mkBtn(g, 'Table borders…', 'grid-3x3', '▦', () => this.promptTableBorders());
        mkBtn(g, 'Row borders…', 'rows-3', '▤', () => this.promptRowBorders());
        mkBtn(g, 'Column borders…', 'columns-3', '▥', () => this.promptColumnBorders());

        g = mkGroup();
        mkBtn(g, 'Merge selected cells (drag across cells in Source mode)', 'combine', '⊟', () => this.mergeSelection());
        // Selection-free merging, which is the only kind that works in Live
        // Preview. Shown when there is room; in the compact strip they live in
        // the ⋯ menu and on their own hotkeys.
        mkBtn(g, 'Merge with cell to the right', 'arrow-right-to-line', '⇥',
            op((m, l) => mergeDirection(m, l.row, l.cell, 'right'))).classList.add('tt-extra');
        mkBtn(g, 'Merge with cell below', 'arrow-down-to-line', '⇩',
            op((m, l) => mergeDirection(m, l.row, l.cell, 'down'))).classList.add('tt-extra');
        mkBtn(g, 'Split merged cell', 'ungroup', '⊞', op((m, l) => splitCell(m, l.row, l.cell)));
        mkBtn(g, 'Toggle header row', 'heading', 'TH', op((m, l) => toggleHeaderRow(m, l.row)));

        // Cell alignment is always on the bar. Its label only appears next to
        // the column and table alignment groups, where identical icons would
        // otherwise be impossible to tell apart.
        g = mkGroup();
        const cellLabel = document.createElement('span');
        cellLabel.className = 'tt-label tt-extra';
        cellLabel.textContent = 'Cell';
        g.appendChild(cellLabel);
        mkBtn(g, 'Align cell left', 'align-left', '⌐', op((m, l) => setCellAlign(m, l.row, l.cell, 'left')));
        mkBtn(g, 'Align cell center', 'align-center', '≡', op((m, l) => setCellAlign(m, l.row, l.cell, 'center')));
        mkBtn(g, 'Align cell right', 'align-right', '¬', op((m, l) => setCellAlign(m, l.row, l.cell, 'right')));

        // Promoted out of the overflow menu when this strip is on its own.
        // They are built once and revealed with a class, so switching between
        // compact and expanded costs no rebuild and cannot flicker.
        g = mkGroup('Col', 'tt-extra');
        mkBtn(g, 'Align column left', 'align-left', '⌐', op((m, l) => setColumnAlign(m, colOf(m, l), 'left')));
        mkBtn(g, 'Align column center', 'align-center', '≡', op((m, l) => setColumnAlign(m, colOf(m, l), 'center')));
        mkBtn(g, 'Align column right', 'align-right', '¬', op((m, l) => setColumnAlign(m, colOf(m, l), 'right')));

        g = mkGroup(null, 'tt-extra');
        mkBtn(g, 'Set column width…', 'move-horizontal', '↔', () => this.promptColumnWidth());
        mkBtn(g, 'Reformat table', 'wand', '↻', () => this.reformatTable());
        mkBtn(g, 'Set cell background…', 'paintbrush', '▨', () => this.promptCellBackground());
        mkBtn(g, 'Insert image into cell…', 'image', '🖼', () => this.promptInsertImage());
        mkBtn(g, 'Resize image in cell…', 'scaling', '⤢', () => this.promptImageWidth());
        // A mode rather than an action, so it carries its state as a pressed
        // look — the same thing the menu says with a tick.
        this.markerBtn = mkBtn(g, 'Row and column markers in source', 'hash', '#', () => this.toggleMarkers());
        this.markerBtn.classList.add('tt-always');

        // Closing group, mirroring the font toolbar's: erase, settings, hide.
        // Expanded there is room for all of it, so the overflow button steps
        // aside; compact, it is the only way in.
        g = mkGroup();
        mkBtn(g, 'More table options', 'more-horizontal', '⋯', (e) => this.showOverflow(e))
            .classList.add('tt-always', 'tt-compact-only');
        mkBtn(g, 'Delete table', 'eraser', '⌫', () => this.deleteTable())
            .classList.add('tt-extra');
        mkBtn(g, 'Plugin settings', 'settings', '⚙', () => this.openSettings())
            .classList.add('tt-extra', 'tt-always');
        mkBtn(g, 'Hide toolbar (table icon in the left ribbon brings it back)', '', '×', () => this.toggleToolbar())
            .classList.add('tt-always');

        document.body.appendChild(bar);
        this.applyDim();
        this.positionBar();
        if (!this.settings.visible) bar.classList.add('tt-hidden');
    }

    showOverflow(evt) {
        const menu = new Menu();
        const op = (fn) => () => this.runOp(fn);
        const colOf = (model, loc) => columnOfCell(model, loc.row, loc.cell);
        const item = (title, icon, cb) => menu.addItem((i) => {
            i.setTitle(title);
            if (icon) i.setIcon(icon);
            i.onClick(cb);
        });

        // Only reachable in compact mode — expanded, every one of these has a
        // button on the bar and the ⋯ that opens this menu is hidden.
        item('Merge with cell to the right', 'arrow-right-to-line',
            op((m, l) => mergeDirection(m, l.row, l.cell, 'right')));
        item('Merge with cell below', 'arrow-down-to-line',
            op((m, l) => mergeDirection(m, l.row, l.cell, 'down')));
        menu.addSeparator();
        item('Align column left', 'align-left', op((m, l) => setColumnAlign(m, colOf(m, l), 'left')));
        item('Align column center', 'align-center', op((m, l) => setColumnAlign(m, colOf(m, l), 'center')));
        item('Align column right', 'align-right', op((m, l) => setColumnAlign(m, colOf(m, l), 'right')));
        menu.addSeparator();
        item('Align table left', 'align-left', op((m) => setTableAlign(m, 'left')));
        item('Center table', 'align-center', op((m) => setTableAlign(m, 'center')));
        item('Align table right', 'align-right', op((m) => setTableAlign(m, 'right')));
        menu.addSeparator();
        item('Insert image into cell…', 'image', () => this.promptInsertImage());
        item('Resize image in cell…', 'scaling', () => this.promptImageWidth());
        item('Table borders…', 'grid-3x3', () => this.promptTableBorders());
        item('Row borders…', 'rows-3', () => this.promptRowBorders());
        item('Column borders…', 'columns-3', () => this.promptColumnBorders());
        menu.addSeparator();
        item('Set column width…', 'move-horizontal', () => this.promptColumnWidth());
        item('Set cell background…', 'paintbrush', () => this.promptCellBackground());
        menu.addSeparator();
        // A checkable item rather than a plain action: markers are a mode, and
        // the tick is what tells you which way it is currently set.
        menu.addItem((i) => i
            .setTitle('Row and column markers')
            .setIcon('hash')
            .setChecked(!!this.settings.rowMarkers)
            .onClick(() => this.toggleMarkers()));
        item('Reformat table', 'wand', () => this.reformatTable());
        item('Delete table', 'eraser', () => this.deleteTable());
        menu.addSeparator();
        item('Plugin settings', 'settings', () => this.openSettings());
        menu.showAtMouseEvent(evt);
    }

    // app.setting is undocumented API: guard so this degrades to a no-op if a
    // future Obsidian version changes it.
    openSettings() {
        const s = this.app.setting;
        if (s && typeof s.open === 'function' && typeof s.openTabById === 'function') {
            s.open();
            s.openTabById(this.manifest.id);
        }
    }
};

// Expose the pure engine for the test suite without shipping a second file
// (Obsidian loads main.js alone, with no bundler in this project).
module.exports.__internals = {
    parseTable, serializeTable, lineOfCell, cellAtLine, gridInfo, columnOfCell,
    insertRow, deleteRow, insertColumn, deleteColumn, mergeCells, mergeDirection, splitCell,
    toggleHeaderRow, setCellAlign, setColumnAlign, setTableAlign, setColumnWidth,
    setTableBorder, currentBorder, setStyleProp, getStyleProp, setExclusiveClass,
    syncColumnSizing,
    setRowBorder, rowEdges, rowLineFormat, setColumnBorder, columnEdges, columnLineFormat,
    setCellBackground, buildTableLines, stampMarker, parseAttrs, attrsToString,
    getAttr, setAttr, getClasses, canonicalize, cellMarker,
    parseColor, toRgba, sameColor, isColorish, isLengthish, DEFAULT_CELL_SHADES,
    resolveEndpoint, diagnose, imageMarkup, resolveImages, imageChoices, IMG_ATTR,
    imageWidth, setImageWidth, currentImageWidth,
};

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

// Word-style hover grid. Dragging past the edge grows the grid, so a 12-column
// table is still reachable without typing numbers.
const GRID_MAX_ROWS = 10;
const GRID_MAX_COLS = 12;

class GridPickerModal extends Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
        this.rows = plugin.settings.defaultRows;
        this.cols = plugin.settings.defaultCols;
        this.header = plugin.settings.headerRow;
    }

    onOpen() {
        this.modalEl.addClass('tt-grid-modal');
        this.titleEl.setText('Insert table');

        this.readout = this.contentEl.createDiv({ cls: 'tt-grid-readout' });
        const grid = this.contentEl.createDiv({ cls: 'tt-grid' });
        this.cells = [];
        for (let r = 0; r < GRID_MAX_ROWS; r++) {
            const rowEl = grid.createDiv({ cls: 'tt-grid-row' });
            const rowCells = [];
            for (let c = 0; c < GRID_MAX_COLS; c++) {
                const cell = rowEl.createDiv({ cls: 'tt-grid-cell' });
                cell.addEventListener('mouseenter', () => {
                    this.rows = r + 1;
                    this.cols = c + 1;
                    this.paint();
                });
                cell.addEventListener('click', () => this.commit());
                rowCells.push(cell);
            }
            this.cells.push(rowCells);
        }

        const opts = this.contentEl.createDiv({ cls: 'tt-grid-opts' });
        const label = opts.createEl('label');
        const box = label.createEl('input', { type: 'checkbox' });
        box.checked = this.header;
        label.appendText(' First row is a header');
        box.addEventListener('change', () => { this.header = box.checked; });

        const insert = opts.createEl('button', { text: 'Insert', cls: 'mod-cta' });
        insert.addEventListener('click', () => this.commit());

        this.paint();
    }

    paint() {
        for (let r = 0; r < GRID_MAX_ROWS; r++) {
            for (let c = 0; c < GRID_MAX_COLS; c++) {
                this.cells[r][c].toggleClass('tt-grid-on', r < this.rows && c < this.cols);
            }
        }
        this.readout.setText(this.rows + ' × ' + this.cols);
    }

    commit() {
        this.plugin.settings.defaultRows = this.rows;
        this.plugin.settings.defaultCols = this.cols;
        this.plugin.settings.headerRow = this.header;
        this.plugin.saveSettings();
        this.close();
        this.plugin.insertTable(this.rows, this.cols, this.header);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// The whole-table shapes. Individual rows and columns are laid over these by
// their own dialogs rather than being extra patterns here.
const BORDER_PRESETS = [
    { key: 'grid', name: 'Grid', desc: 'Lines around every cell' },
    { key: 'box', name: 'Outline', desc: 'One line around the table' },
    { key: 'none', name: 'None', desc: 'No lines at all' },
];

const EDGE_CHOICES = {
    row: [
        { key: 'none', name: 'None', edges: [] },
        { key: 'top', name: 'Top', edges: ['top'] },
        { key: 'bottom', name: 'Bottom', edges: ['bottom'] },
        { key: 'both', name: 'Both', edges: ['top', 'bottom'] },
    ],
    column: [
        { key: 'none', name: 'None', edges: [] },
        { key: 'left', name: 'Left', edges: ['left'] },
        { key: 'right', name: 'Right', edges: ['right'] },
        { key: 'both', name: 'Both', edges: ['left', 'right'] },
    ],
};

function edgeKey(options, edges) {
    const want = edges.slice().sort().join(',');
    const found = options.find((o) => o.edges.slice().sort().join(',') === want);
    return found ? found.key : 'none';
}

// Thickness, line type and colour are the same in all three border dialogs;
// only the section naming what is being styled differs.
class BorderModalBase extends Modal {
    constructor(plugin, current, onSubmit) {
        super(plugin.app);
        this.plugin = plugin;
        this.current = current;
        this.color = current.color || '';
        this.style = LINE_STYLES.some((s) => s.key === current.style)
            ? current.style
            : DEFAULT_LINE_STYLE;
        this.onSubmit = onSubmit;
        const px = parseInt(current.width, 10);
        this.width = Number.isFinite(px) && px > 0 ? Math.min(px, 8) : 1;
    }

    // Supplied by each dialog: its title, the section choosing what is being
    // styled, how that reads in the preview, and what to hand back on Apply.
    title() { return 'Borders'; }
    buildTarget() {}
    paintTarget() {}
    previewClasses() { return ''; }
    collect() { return {}; }

    // Both the pattern and the line-type pickers are the same control.
    choiceRow(parent, items, onPick) {
        const row = parent.createDiv({ cls: 'tt-choice-row' });
        return items.map((it) => {
            const b = row.createEl('button', { cls: 'tt-choice', text: it.name });
            if (it.desc) b.title = it.desc;
            b.addEventListener('click', () => onPick(it.key));
            return { key: it.key, el: b };
        });
    }

    onOpen() {
        this.modalEl.addClass('tt-border-modal');
        this.titleEl.setText(this.title());
        const c = this.contentEl;

        this.buildTarget(c);

        c.createDiv({ cls: 'tt-field-label', text: 'Thickness' });
        const thick = c.createDiv({ cls: 'tt-shade-custom' });
        const slider = thick.createEl('input', { type: 'range' });
        this.slider = slider;
        slider.min = '1';
        slider.max = '8';
        slider.step = '1';
        slider.value = String(this.width);
        this.widthLabel = thick.createSpan({ cls: 'tt-shade-alpha' });
        slider.addEventListener('input', () => {
            this.width = Number(slider.value);
            this.paint();
        });

        c.createDiv({ cls: 'tt-field-label', text: 'Colour' });
        const colorRow = c.createDiv({ cls: 'tt-shade-custom' });
        const picker = colorRow.createEl('input', { type: 'color' });
        this.picker = picker;
        picker.value = (parseColor(this.color) || {}).hex || '#888888';
        picker.title = 'Pick a line colour';
        picker.addEventListener('input', () => {
            this.color = picker.value;
            this.text.value = this.color;
            this.paint();
        });
        const reset = colorRow.createEl('button', { text: 'Theme default' });
        reset.title = 'Follow the theme\'s own border colour, in light and dark alike';
        reset.addEventListener('click', () => {
            this.color = '';
            this.text.value = '';
            this.paint();
        });
        this.text = c.createEl('input', {
            type: 'text',
            cls: 'tt-prompt-input',
            placeholder: 'Theme default',
        });
        this.text.value = this.color;
        this.text.addEventListener('input', () => {
            this.color = this.text.value.trim();
            this.paint();
        });
        c.createDiv({
            cls: 'tt-prompt-hint',
            text: 'An empty colour follows the theme, so the table stays legible in both light and dark.',
        });

        c.createDiv({ cls: 'tt-field-label tt-field-spaced', text: 'Line' });
        this.styleChoices = this.choiceRow(c, LINE_STYLES, (key) => {
            this.style = key;
            // Two lines and a gap have nothing to draw in under 3px, so a
            // Double that looks identical to Solid would just read as broken.
            if (key === 'double' && this.width < 3) this.width = 3;
            this.paint();
        });
        this.styleHint = c.createDiv({ cls: 'tt-prompt-hint' });

        this.preview = c.createDiv({ cls: 'tt-border-preview' });
        for (let i = 0; i < 6; i++) this.preview.createDiv({ cls: 'tt-border-cell' });

        const buttons = c.createDiv({ cls: 'tt-prompt-buttons' });
        buttons.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => this.close());
        buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' })
            .addEventListener('click', () => {
                this.close();
                this.onSubmit(Object.assign({
                    width: this.width + 'px',
                    style: this.style,
                    color: this.color,
                }, this.collect()));
            });

        this.paint();
    }

    paint() {
        this.paintTarget();
        for (const c of this.styleChoices) c.el.classList.toggle('tt-choice-on', c.key === this.style);
        // Kept in step because picking Double can raise the width for you.
        this.slider.value = String(this.width);
        this.widthLabel.setText(this.width + 'px');
        this.styleHint.setText(this.style === 'double'
            ? 'Double draws two lines with a gap between them, so it needs at least 3px to show as two.'
            : '');
        // The preview is a real 3x2 grid wearing the same rules the table
        // will, so the result is shown rather than described.
        this.preview.className = 'tt-border-preview ' + this.previewClasses();
        this.preview.style.setProperty(LINE_WIDTH_PROP, this.width + 'px');
        this.preview.style.setProperty(LINE_STYLE_PROP, this.style);
        this.preview.style.setProperty(LINE_COLOR_PROP, this.color || '');
    }

    onClose() {
        this.contentEl.empty();
    }
}

class TableBorderModal extends BorderModalBase {
    title() { return 'Table borders'; }

    buildTarget(c) {
        this.preset = this.current.preset;
        c.createDiv({ cls: 'tt-field-label', text: 'Pattern' });
        this.choices = this.choiceRow(c, BORDER_PRESETS, (key) => {
            this.preset = key;
            this.paint();
        });
    }

    paintTarget() {
        for (const ch of this.choices) ch.el.classList.toggle('tt-choice-on', ch.key === this.preset);
    }

    previewClasses() { return 'tt-preview-' + this.preset; }

    collect() { return { preset: this.preset }; }
}

// Rows and columns differ only in what they are called and which edges they
// offer, so they share everything else.
class EdgeBorderModal extends BorderModalBase {
    buildTarget(c) {
        const opts = this.edgeOptions();
        this.index = Number.isInteger(this.current.index) && this.current.index >= 0
            ? this.current.index
            : 0;
        this.edges = (this.current.edges || []).slice();

        c.createDiv({ cls: 'tt-field-label', text: this.pickLabel() });
        const wrap = c.createDiv({ cls: 'tt-rowpick' });
        const select = wrap.createEl('select', { cls: 'dropdown' });
        (this.current.labels || []).forEach((label, i) => select.add(new Option(label, String(i))));
        select.value = String(this.index);
        select.addEventListener('change', () => {
            this.index = Number(select.value);
            // Each row and column keeps its own edges AND its own format, so
            // switching the picker loads that one's settings rather than
            // carrying the last choice across and overwriting it on Apply.
            this.load(this.current.stateFor ? this.current.stateFor(this.index) : null);
            this.paint();
        });

        c.createDiv({ cls: 'tt-field-label tt-field-spaced', text: 'Edges' });
        this.edgeChoices = this.choiceRow(c, opts, (key) => {
            const found = opts.find((o) => o.key === key);
            this.edges = found ? found.edges.slice() : [];
            this.paint();
        });
        c.createDiv({ cls: 'tt-prompt-hint', text: this.sharedNote() });
    }

    // Pull a row's or column's own settings into the dialog's controls.
    load(state) {
        if (!state) return;
        this.edges = (state.edges || []).slice();
        this.style = LINE_STYLES.some((s) => s.key === state.style) ? state.style : DEFAULT_LINE_STYLE;
        this.color = state.color || '';
        const px = parseInt(state.width, 10);
        this.width = Number.isFinite(px) && px > 0 ? Math.min(px, 8) : 1;
        if (this.picker) this.picker.value = (parseColor(this.color) || {}).hex || '#888888';
        if (this.text) this.text.value = this.color;
    }

    paintTarget() {
        const key = edgeKey(this.edgeOptions(), this.edges);
        for (const ch of this.edgeChoices) ch.el.classList.toggle('tt-choice-on', ch.key === key);
    }

    collect() { return { index: this.index, edges: this.edges }; }
}

class RowBorderModal extends EdgeBorderModal {
    title() { return 'Row borders'; }
    pickLabel() { return 'Row'; }
    edgeOptions() { return EDGE_CHOICES.row; }
    sharedNote() {
        return 'Each row keeps its own line, so row 2 can be red while row 4 is blue. Switching rows above loads that row\'s settings.';
    }
    previewClasses() {
        return 'tt-preview-edges'
            + (this.edges.includes('top') ? ' tt-preview-rtop' : '')
            + (this.edges.includes('bottom') ? ' tt-preview-rbottom' : '');
    }
}

class ColumnBorderModal extends EdgeBorderModal {
    title() { return 'Column borders'; }
    pickLabel() { return 'Column'; }
    edgeOptions() { return EDGE_CHOICES.column; }
    sharedNote() {
        return 'Each column keeps its own line, and its left and right edges are independent. Switching columns above loads that column\'s settings.';
    }
    previewClasses() {
        return 'tt-preview-edges'
            + (this.edges.includes('left') ? ' tt-preview-cleft' : '')
            + (this.edges.includes('right') ? ' tt-preview-cright' : '');
    }
}

// Three ways in, in order of how often they are wanted: click a swatch and be
// done; mix one with the OS picker and an opacity slider; or type an exact
// value for anything the other two cannot express (a CSS variable, say).
class CellShadeModal extends Modal {
    constructor(plugin, current, onSubmit) {
        super(plugin.app);
        this.plugin = plugin;
        // What the cell actually has: drives which swatch reads as selected.
        this.current = current || '';
        // What Apply will do if you touch nothing. For an already-shaded cell
        // that is its own colour, so Apply is a no-op; for a bare one it is
        // the colour you used last, which makes shading a run of cells a
        // single click each.
        this.initial = this.current || plugin.settings.lastCellShade || '';
        this.onSubmit = onSubmit;
        const parsed = parseColor(this.initial);
        this.hex = parsed ? parsed.hex : '#ffd500';
        this.alpha = parsed ? parsed.alpha : 0.28;
    }

    onOpen() {
        this.modalEl.addClass('tt-shade-modal');
        this.titleEl.setText('Cell background');
        const c = this.contentEl;
        c.createDiv({
            cls: 'tt-prompt-desc',
            text: 'Click a colour to apply it. These are deliberately translucent, so they tint the note background and stay readable in both light and dark themes.',
        });

        const grid = c.createDiv({ cls: 'tt-shade-grid' });
        const none = grid.createEl('button', { cls: 'tt-shade tt-shade-none' });
        none.title = 'No background';
        if (!this.current) none.classList.add('tt-shade-on');
        none.addEventListener('click', () => this.commit(''));
        for (const s of this.plugin.settings.cellShades) {
            if (!s.value) continue;
            const b = grid.createEl('button', { cls: 'tt-shade' });
            b.title = s.name;
            paintSwatch(b, s.value);
            if (sameColor(this.current, s.value)) b.classList.add('tt-shade-on');
            b.addEventListener('click', () => this.commit(s.value));
        }

        const row = c.createDiv({ cls: 'tt-shade-custom' });
        row.createSpan({ text: 'Custom' });
        const picker = row.createEl('input', { type: 'color' });
        picker.value = this.hex;
        picker.title = 'Pick any colour';
        const slider = row.createEl('input', { type: 'range' });
        slider.min = '5';
        slider.max = '100';
        slider.step = '5';
        slider.value = String(Math.round(this.alpha * 100));
        slider.title = 'Opacity';
        const alphaLabel = row.createSpan({ cls: 'tt-shade-alpha' });
        const preview = row.createDiv({ cls: 'tt-shade-preview' });
        const use = row.createEl('button', { text: 'Use' });

        const text = c.createEl('input', {
            type: 'text',
            cls: 'tt-prompt-input',
            placeholder: 'rgba(255, 213, 0, 0.28)',
        });
        text.value = this.initial;
        c.createDiv({
            cls: 'tt-prompt-hint',
            text: 'Applying an empty field clears the cell\'s background — the same as Remove.',
        });

        const sync = () => {
            this.hex = picker.value;
            this.alpha = Number(slider.value) / 100;
            const value = toRgba(this.hex, this.alpha);
            alphaLabel.setText(slider.value + '%');
            paintSwatch(preview, value);
            text.value = value;
        };
        picker.addEventListener('input', sync);
        slider.addEventListener('input', sync);
        use.addEventListener('click', () => this.commit(text.value.trim()));
        text.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.commit(text.value.trim()); }
        });
        sync();
        // sync() rewrote the field from the picker's reading of the colour;
        // put back the exact text, which may be a form the picker cannot
        // express (a CSS variable) or simply spelled differently.
        text.value = this.initial;
        text.focus();
        text.select();

        const buttons = c.createDiv({ cls: 'tt-prompt-buttons' });
        buttons.createEl('button', { text: 'Remove' })
            .addEventListener('click', () => this.commit(''));
        buttons.createEl('button', { text: 'Cancel' })
            .addEventListener('click', () => this.close());
        buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' })
            .addEventListener('click', () => this.commit(text.value.trim()));
    }

    commit(value) {
        this.close();
        this.onSubmit(value);
    }

    onClose() {
        this.contentEl.empty();
    }
}

// Fuzzy picker over the vault's images, so nobody has to remember a path.
class ImagePickerModal extends FuzzySuggestModal {
    constructor(app, files, onChoose) {
        super(app);
        this.files = files;
        this.onChoose = onChoose;
        this.setPlaceholder('Type part of the name or folder — nearest and newest first');
    }
    getItems() { return this.files; }
    getItemText(file) { return file.path; }
    onChooseItem(file) { this.onChoose(file); }
}

class TextPromptModal extends Modal {
    constructor(app, opts) {
        super(app);
        this.opts = opts;
    }

    onOpen() {
        this.titleEl.setText(this.opts.title);
        if (this.opts.desc) this.contentEl.createDiv({ text: this.opts.desc, cls: 'tt-prompt-desc' });
        const input = this.contentEl.createEl('input', {
            type: 'text',
            cls: 'tt-prompt-input',
            placeholder: this.opts.placeholder || '',
        });
        input.value = this.opts.value || '';
        if (this.opts.hint) this.contentEl.createDiv({ cls: 'tt-prompt-hint', text: this.opts.hint });
        const submit = () => {
            const v = input.value;
            this.close();
            this.opts.onSubmit(v);
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        const row = this.contentEl.createDiv({ cls: 'tt-prompt-buttons' });
        row.createEl('button', { text: 'Apply', cls: 'mod-cta' }).addEventListener('click', submit);
        row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
        input.focus();
        input.select();
    }

    onClose() {
        this.contentEl.empty();
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

class HtmlTableToolbarSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    save() {
        this.plugin.saveSettings();
        this.plugin.requestRebuild();
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Show toolbar')
            .setDesc('The table ribbon icon and the "Toggle toolbar" command toggle this too.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.visible)
                .onChange((v) => {
                    if (v !== this.plugin.settings.visible) this.plugin.toggleToolbar();
                }));

        new Setting(containerEl)
            .setName('Only show inside tables')
            .setDesc('Hide the strip whenever the cursor is not in an HTML table. Off by default: a bar that appears and disappears as you move around takes some getting used to.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.contextual)
                .onChange((v) => {
                    this.plugin.settings.contextual = v;
                    this.plugin.saveSettings();
                    this.plugin.updateContext();
                }));

        new Setting(containerEl)
            .setName('Stack above the font toolbar')
            .setDesc('If the HTML Font Toolbar plugin is installed and visible, sit above it instead of overlapping. Has no effect when that plugin is absent.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.stackAboveFontToolbar)
                .onChange((v) => {
                    this.plugin.settings.stackAboveFontToolbar = v;
                    this.plugin.saveSettings();
                    this.plugin.positionBar();
                }));

        new Setting(containerEl)
            .setName('Expand when on its own')
            .setDesc('With no font toolbar sharing the bottom of the window, use the space: show column and table alignment, column width and reformat as buttons rather than menu entries. The strip wraps onto a second row instead of running wider, so it keeps roughly the footprint of the font toolbar it stands in for, and shrinks back to the compact single row automatically when that toolbar reappears.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.expandWhenAlone)
                .onChange((v) => {
                    this.plugin.settings.expandWhenAlone = v;
                    this.plugin.saveSettings();
                    this.plugin.positionBar();
                }));

        new Setting(containerEl)
            .setName('Dim when outside a table')
            .setDesc('How much darker the toolbar goes when the cursor is not in a table and the structural buttons cannot act. Set to 0 for no change at all. Only applies when "Only show inside tables" is off, since otherwise the toolbar simply disappears.')
            .addSlider((s) => s
                .setLimits(0, 40, 2)
                .setValue(this.plugin.settings.inactiveDim)
                .setDynamicTooltip()
                .onChange((v) => {
                    this.plugin.settings.inactiveDim = v;
                    this.plugin.saveSettings();
                    this.plugin.applyDim();
                }));

        new Setting(containerEl)
            .setName('Status bar position readout')
            .setDesc('Show the current cell as R2 · C3 (Owner) in the status bar. Takes effect after reloading Obsidian.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.statusBar)
                .onChange((v) => {
                    this.plugin.settings.statusBar = v;
                    this.plugin.saveSettings();
                    if (!v && this.plugin.statusEl) this.plugin.statusEl.setText('');
                }));

        new Setting(containerEl)
            .setName('Row and column markers')
            .setDesc('Label every cell with its coordinates — r02c01 — in an HTML comment, so you can tell where you are deep inside a long table. Nothing is written on the <tr> lines, which must stay empty. Visible in Source mode only; they render as nothing. This is one switch for all tables: turning it on marks every table in the note you have open, and any table the plugin edits afterwards; turning it off strips them again. The ⋯ menu has the same switch with a tick. Markers are rebuilt from scratch on every edit, so they cannot go stale.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.rowMarkers)
                .onChange((v) => this.plugin.setMarkers(v, false)));

        // Everything below this heading really is about newly inserted tables.
        // Markers are not — they are a global mode — so they sit above it.
        new Setting(containerEl)
            .setName('New tables')
            .setHeading();

        new Setting(containerEl)
            .setName('Header row by default')
            .setDesc('Pre-tick "First row is a header" in the insert dialog.')
            .addToggle((t) => t
                .setValue(this.plugin.settings.headerRow)
                .onChange((v) => {
                    this.plugin.settings.headerRow = v;
                    this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Default size')
            .setDesc('The size the insert grid starts on. It also remembers your last pick.')
            .addSlider((s) => s
                .setLimits(1, GRID_MAX_ROWS, 1)
                .setValue(this.plugin.settings.defaultRows)
                .setDynamicTooltip()
                .onChange((v) => {
                    this.plugin.settings.defaultRows = v;
                    this.plugin.saveSettings();
                }))
            .addSlider((s) => s
                .setLimits(1, GRID_MAX_COLS, 1)
                .setValue(this.plugin.settings.defaultCols)
                .setDynamicTooltip()
                .onChange((v) => {
                    this.plugin.settings.defaultCols = v;
                    this.plugin.saveSettings();
                }));

        this.shadeSection();
    }

    shadeSection() {
        const { containerEl } = this;
        const items = this.plugin.settings.cellShades;

        new Setting(containerEl)
            .setName('Cell background presets')
            .setDesc('Swatches offered by the paintbrush button. Values can be hex or rgba(); the fourth rgba() number is opacity (0 to 1). Translucent shades around 0.25 tint the note background rather than covering it, which is what keeps them readable in both light and dark themes — a solid pastel that looks right on one will not on the other. An entry with an empty value is skipped.')
            .setHeading()
            .addExtraButton((b) => b
                .setIcon('rotate-ccw')
                .setTooltip('Restore default presets')
                .onClick(() => {
                    this.plugin.settings.cellShades = structuredClone(DEFAULT_CELL_SHADES);
                    this.plugin.saveSettings();
                    this.display();
                }));

        items.forEach((item, idx) => {
            const row = new Setting(containerEl);
            row.settingEl.addClass('tt-setting-row');
            row.addText((t) => t
                .setPlaceholder('Name')
                .setValue(item.name)
                .onChange((v) => {
                    item.name = v;
                    this.plugin.saveSettings();
                }));
            let valueText;
            row.addText((t) => {
                valueText = t;
                t.setPlaceholder('rgba(255, 213, 0, 0.28)')
                    .setValue(item.value)
                    .onChange((v) => {
                        item.value = v.trim();
                        this.plugin.saveSettings();
                    });
                t.inputEl.addClass('tt-setting-value');
            });
            // The picker speaks opaque hex only, so it edits the colour while
            // the value's own opacity is carried across untouched.
            row.addColorPicker((c) => {
                const parsed = parseColor(item.value);
                c.setValue(parsed ? parsed.hex : '#000000')
                    .onChange((v) => {
                        const cur = parseColor(item.value);
                        item.value = toRgba(v, cur ? cur.alpha : 0.28);
                        valueText.setValue(item.value);
                        this.plugin.saveSettings();
                    });
            });
            row.addExtraButton((b) => b
                .setIcon('trash-2')
                .setTooltip('Remove')
                .onClick(() => {
                    items.splice(idx, 1);
                    this.plugin.saveSettings();
                    this.display();
                }));
        });

        new Setting(containerEl)
            .addButton((b) => b
                .setButtonText('Add')
                .onClick(() => {
                    items.push({ name: 'Shade', value: 'rgba(255, 213, 0, 0.28)' });
                    this.plugin.saveSettings();
                    this.display();
                }));
    }
}

/* nosourcemap */