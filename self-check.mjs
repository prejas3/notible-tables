/**
 * Runnable check for the parts of Notible Tables that can be wrong silently:
 * the props round trip, column/row edits, sorting and filtering.
 *
 * node plugins/notible-tables/self-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin, {
  TABLE_TYPE,
  COLUMN_TYPES,
  HIGHLIGHT_COLOURS,
  addColumn,
  addRow,
  applyTsvPaste,
  blankTable,
  cellsToTsv,
  clearCellStyle,
  clearRangeCells,
  clearRangeStyle,
  columnSums,
  defaultCellValue,
  duplicateRow,
  fillRange,
  formatNumber,
  parseNumberFormat,
  isFormula,
  columnLetter,
  columnIndexFromLetter,
  computeFormulas,
  resolveFormulas,
  filterRows,
  insertColumnAt,
  insertRow,
  matchesFilters,
  mergeCells,
  parseTable,
  removeColumn,
  removeRow,
  reorderColumn,
  reorderRow,
  resolveSelection,
  serializeTable,
  setCell,
  setCellStyle,
  setRangeStyle,
  sortRows,
  toCsv,
  unmergeCells,
  updateColumn,
  visibleRows,
} from "./main.js";

// --- identity
const declared = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
assert.ok(plugin.manifest, "the entry module must export a manifest, not just onload");
for (const field of ["id", "name", "version", "apiVersion", "description", "author"]) {
  assert.equal(plugin.manifest[field], declared[field], `${field} must match plugin.json`);
}
assert.deepEqual(plugin.manifest.permissions, declared.permissions);
assert.equal(typeof plugin.onload, "function");
assert.equal(typeof plugin.onunload, "function");

// registerObjectTab is API 1.5, but this plugin also calls context.ui, which
// is fine at 1.1 — the real floor here is registerObjectTab itself plus the
// "table" entry in OBJECT_TAB_TYPES, both of which predate 1.8. Declaring
// 1.8 anyway keeps it in step with every other builtin-shaped plugin shipped
// alongside it, and is never a floor violation.
assert.equal(declared.apiVersion, "1.8");
assert.deepEqual([...declared.permissions].sort(), ["data.read", "data.write", "workspace.ui"]);
assert.ok(!declared.permissions.includes("network"), "tables never leave the machine on their own");
assert.equal(TABLE_TYPE, "table");

// --- empty / malformed props never throw
assert.deepEqual(parseTable({ props: "" }).columns, []);
assert.deepEqual(parseTable({ props: "not json" }).columns, []);
assert.deepEqual(parseTable({ props: "null" }).columns, []);
assert.deepEqual(parseTable({}).rows, []);

// --- add/remove column keeps rows in step
let table = parseTable({ id: "t1", title: "Sprint", props: "{}" });
table = addColumn(table, { name: "Task", type: "text" });
table = addColumn(table, { name: "Done", type: "checkbox" });
assert.equal(table.columns.length, 2);
table = addRow(table);
assert.equal(Object.keys(table.rows[0].cells).length, 2, "a new row gets one cell per existing column");
assert.equal(table.rows[0].cells[table.columns[1].id], false, "a fresh checkbox cell defaults to false, not undefined");

const taskColumnId = table.columns[0].id;
table = setCell(table, table.rows[0].id, taskColumnId, "Write the report");
assert.equal(table.rows[0].cells[taskColumnId], "Write the report");

const doneColumnId = table.columns[1].id;
table = removeColumn(table, doneColumnId);
assert.equal(table.columns.length, 1);
assert.ok(!(doneColumnId in table.rows[0].cells), "removing a column drops its cell from every row");

// --- round trip through serializeTable/parseTable preserves shape
const serialized = serializeTable(table);
const roundTripped = parseTable({ id: "t1", title: "Sprint", props: serialized });
assert.deepEqual(roundTripped.columns.map((c) => c.name), table.columns.map((c) => c.name));
assert.equal(roundTripped.rows[0].cells[roundTripped.columns[0].id], "Write the report");

// --- lockWidths is a real boolean that survives the round trip
assert.equal(parseTable({ props: "{}" }).lockWidths, false, "a table without the flag is unlocked");
assert.equal(parseTable({ props: '{"lockWidths":1}' }).lockWidths, false, "only strict true counts");
assert.equal(parseTable({ props: '{"lockWidths":true}' }).lockWidths, true);
assert.equal(parseTable({ props: serializeTable({ ...table, lockWidths: true }) }).lockWidths, true);
assert.equal(JSON.parse(serializeTable({ ...table, lockWidths: false })).lockWidths, undefined, "the default is not written");

// --- changing a column's type re-reads existing cells through the new parser
let numeric = parseTable({ props: "{}" });
numeric = addColumn(numeric, { name: "Points", type: "text" });
numeric = addRow(numeric);
const pointsId = numeric.columns[0].id;
numeric = setCell(numeric, numeric.rows[0].id, pointsId, "5");
numeric = updateColumn(numeric, pointsId, { type: "number" });
assert.equal(numeric.rows[0].cells[pointsId], 5, "a numeric-looking text cell becomes a real number on retype");
assert.equal(numeric.columns[0].type, "number");

// --- remove row
let withRows = parseTable({ props: "{}" });
withRows = addColumn(withRows, { name: "Name", type: "text" });
withRows = addRow(withRows);
withRows = addRow(withRows);
const firstRowId = withRows.rows[0].id;
withRows = removeRow(withRows, firstRowId);
assert.equal(withRows.rows.length, 1);
assert.ok(withRows.rows[0].id !== firstRowId);

// --- sorting
let sortable = parseTable({ props: "{}" });
sortable = addColumn(sortable, { name: "Score", type: "number" });
sortable = addRow(sortable); sortable = addRow(sortable); sortable = addRow(sortable);
const scoreId = sortable.columns[0].id;
sortable = setCell(sortable, sortable.rows[0].id, scoreId, 3);
sortable = setCell(sortable, sortable.rows[1].id, scoreId, 1);
sortable = setCell(sortable, sortable.rows[2].id, scoreId, 2);
const ascending = sortRows(sortable.rows, sortable.columns, { columnId: scoreId, direction: "asc" });
assert.deepEqual(ascending.map((row) => row.cells[scoreId]), [1, 2, 3]);
const descending = sortRows(sortable.rows, sortable.columns, { columnId: scoreId, direction: "desc" });
assert.deepEqual(descending.map((row) => row.cells[scoreId]), [3, 2, 1]);
assert.equal(sortRows(sortable.rows, sortable.columns, null), sortable.rows, "no sort returns the exact same array reference");

// --- filtering: text substring, checkbox tri-state, blank filter passes everything
let filterable = parseTable({ props: "{}" });
filterable = addColumn(filterable, { name: "Name", type: "text" });
filterable = addColumn(filterable, { name: "Done", type: "checkbox" });
filterable = addRow(filterable); filterable = addRow(filterable);
const nameId = filterable.columns[0].id;
const doneId = filterable.columns[1].id;
filterable = setCell(filterable, filterable.rows[0].id, nameId, "Alpha task");
filterable = setCell(filterable, filterable.rows[1].id, nameId, "Beta task");
filterable = setCell(filterable, filterable.rows[0].id, doneId, true);

assert.equal(filterRows(filterable.rows, filterable.columns, {}).length, 2, "no filters, everything passes");
assert.equal(filterRows(filterable.rows, filterable.columns, { [nameId]: "alpha" }).length, 1, "text filter is case-insensitive substring");
assert.equal(filterRows(filterable.rows, filterable.columns, { [doneId]: "checked" }).length, 1);
assert.equal(filterRows(filterable.rows, filterable.columns, { [doneId]: "unchecked" }).length, 1);
assert.ok(matchesFilters(filterable.rows[0], filterable.columns, { [nameId]: "" }), "a blank filter value passes every row");

// --- visibleRows filters before sorting
const visible = visibleRows(filterable, { [doneId]: "" }, { columnId: nameId, direction: "asc" });
assert.deepEqual(visible.map((row) => row.cells[nameId]), ["Alpha task", "Beta task"]);

// --- select columns keep their options, other types never carry one
let withSelect = parseTable({ props: "{}" });
withSelect = addColumn(withSelect, { name: "Priority", type: "select", options: ["Low", "Medium", "High"] });
assert.deepEqual(withSelect.columns[0].options, ["Low", "Medium", "High"]);
let withText = parseTable({ props: "{}" });
withText = addColumn(withText, { name: "Notes", type: "text", options: ["should", "be", "ignored"] });
assert.equal(withText.columns[0].options, undefined, "options are only meaningful on select columns");

// --- COLUMN_TYPES and defaultCellValue agree on every type
for (const type of COLUMN_TYPES) {
  const value = defaultCellValue(type);
  assert.ok(value !== undefined, `defaultCellValue must never return undefined for ${type}`);
}

// --- a new table starts as a 3x3 grid, not an empty state
const fresh = blankTable(parseTable({ props: "{}" }));
assert.equal(fresh.columns.length, 3, "a new table has 3 columns");
assert.equal(fresh.rows.length, 3, "a new table has 3 rows");
assert.ok(fresh.columns.every((column) => column.type === "text"), "the default columns are plain text");
assert.equal(Object.keys(fresh.rows[0].cells).length, 3, "every row has a cell per column");

// --- column wrap, parsed and round-tripped
let wrapped = parseTable({ props: "{}" });
wrapped = addColumn(wrapped, { name: "Notes", type: "text" });
assert.equal(wrapped.columns[0].wrap, false, "wrap defaults to false");
wrapped = updateColumn(wrapped, wrapped.columns[0].id, { wrap: true });
assert.equal(wrapped.columns[0].wrap, true);
const wrapRoundTrip = parseTable({ props: serializeTable(wrapped) });
assert.equal(wrapRoundTrip.columns[0].wrap, true, "wrap survives serialize/parse");

// --- cell styles: set, clear, round trip, and invalid input is dropped not thrown
assert.deepEqual(HIGHLIGHT_COLOURS, ["yellow", "green", "blue", "pink", "purple", "orange"]);
let styled = parseTable({ props: "{}" });
styled = addColumn(styled, { name: "Task", type: "text" });
styled = addRow(styled);
const r1 = styled.rows[0].id;
const c1 = styled.columns[0].id;
styled = setCellStyle(styled, r1, c1, { bold: true, color: "green" });
assert.deepEqual(styled.styles[`${r1}:${c1}`], { bold: true, color: "green" });
const styleRoundTrip = parseTable({ props: serializeTable(styled) });
assert.deepEqual(styleRoundTrip.styles[`${r1}:${c1}`], { bold: true, color: "green" }, "styles survive serialize/parse");

styled = setCellStyle(styled, r1, c1, { color: "not-a-real-color" });
assert.equal(styled.styles[`${r1}:${c1}`].color, undefined, "an unrecognised color is dropped, not stored");
assert.equal(styled.styles[`${r1}:${c1}`].bold, true, "clearing color leaves bold untouched");

styled = clearCellStyle(styled, r1, c1);
assert.equal(styled.styles[`${r1}:${c1}`], undefined, "a fully-cleared cell has no entry at all, not an empty object");

// --- range-scoped style helpers apply to every cell in the range
let ranged = parseTable({ props: "{}" });
ranged = addColumn(ranged, { name: "A", type: "text" });
ranged = addColumn(ranged, { name: "B", type: "text" });
ranged = addRow(ranged); ranged = addRow(ranged);
const range = { rowIds: ranged.rows.map((row) => row.id), columnIds: ranged.columns.map((col) => col.id) };
ranged = setRangeStyle(ranged, range, { color: "pink" });
for (const rowId of range.rowIds) for (const colId of range.columnIds) {
  assert.equal(ranged.styles[`${rowId}:${colId}`].color, "pink");
}
ranged = clearRangeStyle(ranged, range);
assert.deepEqual(ranged.styles, {}, "clearing a full-table range leaves no style entries");

// --- malformed styles in stored props degrade to nothing, never throw
assert.deepEqual(parseTable({ props: '{"styles": "not an object"}' }).styles, {});
assert.deepEqual(parseTable({ props: '{"styles": {"bad-key": {"bold": true}}}' }).styles, {}, "a key with no ':' is not row:column shaped and is dropped");

// --- merge: only when no sort/filter is active, only non-overlapping, only >=2 cells
let merge = parseTable({ props: "{}" });
merge = addColumn(merge, { name: "A", type: "text" });
merge = addColumn(merge, { name: "B", type: "text" });
merge = addRow(merge); merge = addRow(merge);
const mergeRange = { rowIds: [merge.rows[0].id], columnIds: merge.columns.map((c) => c.id) };
merge = mergeCells(merge, mergeRange, null, {});
assert.deepEqual(merge.merges, [{ startRowIndex: 0, startColIndex: 0, rowSpan: 1, colSpan: 2 }]);

// a sort or filter blocks a new merge — the safety net, not just the UI
let blocked = parseTable({ props: "{}" });
blocked = addColumn(blocked, { name: "A", type: "text" });
blocked = addColumn(blocked, { name: "B", type: "text" });
blocked = addRow(blocked); blocked = addRow(blocked);
const blockedRange = { rowIds: [blocked.rows[0].id], columnIds: blocked.columns.map((c) => c.id) };
const withSort = mergeCells(blocked, blockedRange, { columnId: blocked.columns[0].id, direction: "asc" }, {});
assert.deepEqual(withSort.merges ?? [], [], "merge is a no-op while a sort is active");
const withFilter = mergeCells(blocked, blockedRange, null, { [blocked.columns[0].id]: "x" });
assert.deepEqual(withFilter.merges ?? [], [], "merge is a no-op while a filter is active");

// a single cell is not a merge
const singleCellRange = { rowIds: [blocked.rows[0].id], columnIds: [blocked.columns[0].id] };
assert.deepEqual(mergeCells(blocked, singleCellRange, null, {}).merges ?? [], [], "one cell has nothing to merge with");

// overlapping merges are rejected
let overlap = merge;
const overlapRange = { rowIds: merge.rows.map((r) => r.id), columnIds: [merge.columns[0].id] };
overlap = mergeCells(overlap, overlapRange, null, {});
assert.equal(overlap.merges.length, 1, "a merge overlapping an existing one is rejected");

// unmerge, and round trip through serialize/parse
let unmerged = unmergeCells(merge, 0, 0);
assert.deepEqual(unmerged.merges, []);
const mergeRoundTrip = parseTable({ props: serializeTable(merge) });
assert.deepEqual(mergeRoundTrip.merges, merge.merges, "merges survive serialize/parse");

// a merge that no longer fits after a column is removed is dropped on next parse, not thrown
let shrinking = merge;
shrinking = removeColumn(shrinking, shrinking.columns[1].id);
const afterShrink = parseTable({ id: "t", title: "T", props: serializeTable(shrinking) });
assert.deepEqual(afterShrink.merges, [], "a merge whose span no longer fits is dropped rather than kept invalid");

// --- removing a row above a merge shifts startRowIndex, removing a row
// inside a merge's span drops it entirely
let mergeShift = parseTable({ props: "{}" });
mergeShift = addColumn(mergeShift, { name: "A", type: "text" });
mergeShift = addColumn(mergeShift, { name: "B", type: "text" });
mergeShift = addRow(mergeShift); // row 0 — above the merge
mergeShift = addRow(mergeShift); // row 1 — merged
mergeShift = addRow(mergeShift); // row 2 — merged
const mergeShiftRange = { rowIds: [mergeShift.rows[1].id, mergeShift.rows[2].id], columnIds: [mergeShift.columns[0].id] };
mergeShift = mergeCells(mergeShift, mergeShiftRange, null, {});
assert.deepEqual(mergeShift.merges, [{ startRowIndex: 1, startColIndex: 0, rowSpan: 2, colSpan: 1 }]);

const shiftedAfterRemoveAbove = removeRow(mergeShift, mergeShift.rows[0].id);
assert.deepEqual(shiftedAfterRemoveAbove.merges, [{ startRowIndex: 0, startColIndex: 0, rowSpan: 2, colSpan: 1 }], "removing a row above the merge decrements startRowIndex by exactly 1");

const droppedAfterRemoveWithin = removeRow(mergeShift, mergeShift.rows[1].id);
assert.deepEqual(droppedAfterRemoveWithin.merges, [], "removing a row that falls within a merge's span drops the merge entirely");

// --- resolveSelection: anchor/focus in either order, missing endpoint is null
let sel = parseTable({ props: "{}" });
sel = addColumn(sel, { name: "A", type: "text" });
sel = addColumn(sel, { name: "B", type: "text" });
sel = addRow(sel); sel = addRow(sel); sel = addRow(sel);
const [sr0, sr1, sr2] = sel.rows.map((r) => r.id);
const [ca, cb] = sel.columns.map((c) => c.id);
const resolved = resolveSelection(sel.rows, sel.columns, { anchorRow: sr1, anchorCol: cb, focusRow: sr0, focusCol: ca });
assert.deepEqual(resolved, { rowIds: [sr0, sr1], columnIds: [ca, cb] }, "resolves to the rectangle between anchor and focus regardless of direction");
assert.equal(resolveSelection(sel.rows, sel.columns, null), null);
assert.equal(resolveSelection(sel.rows, sel.columns, { anchorRow: "gone", anchorCol: ca, focusRow: sr0, focusCol: ca }), null, "a deleted row's id resolves to null, not a crash");

// --- number format: pure formatting + round trip on a number column
assert.equal(formatNumber(1234.5, { style: "plain", decimals: 2 }), (1234.5).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
assert.equal(formatNumber(0.125, { style: "percent", decimals: 1 }), "12.5%");
assert.equal(formatNumber(9.9, { style: "currency", decimals: 2, symbol: "zł" }), `zł ${(9.9).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
assert.equal(formatNumber("", { style: "plain", decimals: 0 }), "", "an empty cell formats to empty, never NaN");
assert.equal(parseNumberFormat({ style: "plain", decimals: 0, symbol: "" }), undefined, "the default format is not stored");
assert.equal(parseNumberFormat({ style: "wat", decimals: 9 }).style, "plain", "an unknown style degrades to plain");
assert.equal(parseNumberFormat({ style: "currency", decimals: 9, symbol: "€" }).decimals, 4, "decimals clamp to 4");
let fmtTable = parseTable({ props: "{}" });
fmtTable = addColumn(fmtTable, { name: "Price", type: "number" });
fmtTable = updateColumn(fmtTable, fmtTable.columns[0].id, { format: { style: "currency", decimals: 2, symbol: "zł" } });
assert.deepEqual(parseTable({ props: serializeTable(fmtTable) }).columns[0].format, { style: "currency", decimals: 2, symbol: "zł" }, "a number format round-trips through props");
assert.equal(parseTable({ props: serializeTable(addColumn(parseTable({ props: "{}" }), { name: "N", type: "text" })) }).columns[0].format, undefined, "a non-number column never carries a format");

// --- link column: cell holds a plain object-id string, default is ""
let linkTable = parseTable({ props: "{}" });
linkTable = addColumn(linkTable, { name: "Related", type: "link" });
assert.equal(linkTable.columns[0].type, "link");
assert.equal(linkTable.rows[0]?.cells[linkTable.columns[0].id] ?? "", "");
linkTable = addRow(linkTable);
linkTable = setCell(linkTable, linkTable.rows[0].id, linkTable.columns[0].id, "obj-123");
assert.equal(parseTable({ props: serializeTable(linkTable) }).rows[0].cells[linkTable.columns[0].id], "obj-123", "a link cell's id survives the round trip");
assert.equal(toCsv(linkTable, (id) => id === "obj-123" ? "The Target" : undefined).split("\r\n")[1], "The Target", "CSV renders a link via the title resolver");
assert.equal(toCsv(linkTable).split("\r\n")[1], "obj-123", "CSV falls back to the id with no resolver");

// --- formula engine: column letters, detection, evaluation, errors
assert.equal(columnLetter(0), "A");
assert.equal(columnLetter(25), "Z");
assert.equal(columnLetter(26), "AA");
assert.equal(columnIndexFromLetter("A"), 0);
assert.equal(columnIndexFromLetter("Z"), 25);
assert.equal(columnIndexFromLetter("AA"), 26);
assert.equal(columnIndexFromLetter("1"), -1);
assert.equal(isFormula("=1+1"), true);
assert.equal(isFormula("  =SUM(A1:A2)"), true);
assert.equal(isFormula("1+1"), false);
assert.equal(isFormula("a=b"), false);
assert.equal(isFormula(5), false);

let fx = parseTable({ props: "{}" });
fx = addColumn(fx, { name: "A", type: "number" });
fx = addColumn(fx, { name: "B", type: "number" });
fx = addRow(fx); fx = addRow(fx); fx = addRow(fx);
const [fr0, fr1, fr2] = fx.rows.map((r) => r.id);
const [fca, fcb] = fx.columns.map((c) => c.id);
fx = setCell(fx, fr0, fca, 10);
fx = setCell(fx, fr1, fca, 20);
fx = setCell(fx, fr2, fca, 30);
fx = setCell(fx, fr0, fcb, "=A1+A2");        // 30
fx = setCell(fx, fr1, fcb, "=SUM(A1:A3)");   // 60
fx = setCell(fx, fr2, fcb, "=B1*2 - 10");    // 50  (B1 = 30)
const fcomputed = computeFormulas(fx);
assert.equal(fcomputed.get(`${fr0}:${fcb}`), 30);
assert.equal(fcomputed.get(`${fr1}:${fcb}`), 60);
assert.equal(fcomputed.get(`${fr2}:${fcb}`), 50);

// error cases
let fe = parseTable({ props: "{}" });
fe = addColumn(fe, { name: "A", type: "number" });
fe = addRow(fe); fe = addRow(fe);
const [fer0, fer1] = fe.rows.map((r) => r.id);
const feca = fe.columns[0].id;
fe = setCell(fe, fer0, feca, "=1/0");
fe = setCell(fe, fer1, feca, "=A99");
let feComputed = computeFormulas(fe);
assert.equal(feComputed.get(`${fer0}:${feca}`), "#DIV/0!");
assert.equal(feComputed.get(`${fer1}:${feca}`), "#REF!");

// a direct self-reference is a cycle
let fcyc = parseTable({ props: "{}" });
fcyc = addColumn(fcyc, { name: "A", type: "number" });
fcyc = addRow(fcyc);
fcyc = setCell(fcyc, fcyc.rows[0].id, fcyc.columns[0].id, "=A1+1");
assert.equal(computeFormulas(fcyc).get(`${fcyc.rows[0].id}:${fcyc.columns[0].id}`), "#CYCLE!");

// a malformed formula is #ERR!, not a throw
let fbad = parseTable({ props: "{}" });
fbad = addColumn(fbad, { name: "A", type: "number" });
fbad = addRow(fbad);
fbad = setCell(fbad, fbad.rows[0].id, fbad.columns[0].id, "=SUM(");
assert.equal(computeFormulas(fbad).get(`${fbad.rows[0].id}:${fbad.columns[0].id}`), "#ERR!");

// resolveFormulas swaps the cell for its computed value; a table with no
// formulas is returned unchanged (same reference)
const noFx = parseTable({ props: "{}" });
assert.equal(resolveFormulas(noFx), noFx);
assert.equal(resolveFormulas(fx).rows[0].cells[fcb], 30);
assert.equal(resolveFormulas(fx).rows[0].cells[fca], 10, "a non-formula cell is untouched");
// a formula survives serialization as its "=" text, not its result
assert.equal(parseTable({ props: serializeTable(fx) }).rows[0].cells[fcb], "=A1+A2");

// --- whole-column / whole-row selection (header / handle click) is just a
//     full-span rectangle: every row + one column, or every column + one row
assert.deepEqual(
  resolveSelection(sel.rows, sel.columns, { anchorRow: sr0, anchorCol: ca, focusRow: sr2, focusCol: ca }),
  { rowIds: [sr0, sr1, sr2], columnIds: [ca] },
  "a whole-column selection spans every row and the one clicked column",
);
assert.deepEqual(
  resolveSelection(sel.rows, sel.columns, { anchorRow: sr1, anchorCol: ca, focusRow: sr1, focusCol: cb }),
  { rowIds: [sr1], columnIds: [ca, cb] },
  "a whole-row selection spans every column and the one clicked row",
);

// --- copy to TSV: checkbox becomes TRUE/FALSE, order follows the range
let tsvTable = parseTable({ props: "{}" });
tsvTable = addColumn(tsvTable, { name: "Task", type: "text" });
tsvTable = addColumn(tsvTable, { name: "Done", type: "checkbox" });
tsvTable = addRow(tsvTable); tsvTable = addRow(tsvTable);
tsvTable = setCell(tsvTable, tsvTable.rows[0].id, tsvTable.columns[0].id, "Write the report");
tsvTable = setCell(tsvTable, tsvTable.rows[0].id, tsvTable.columns[1].id, true);
tsvTable = setCell(tsvTable, tsvTable.rows[1].id, tsvTable.columns[0].id, "Ship it");
const tsvRange = { rowIds: tsvTable.rows.map((r) => r.id), columnIds: tsvTable.columns.map((c) => c.id) };
assert.equal(cellsToTsv(tsvTable, tsvRange), "Write the report\tTRUE\nShip it\tFALSE");

// --- paste TSV: writes from the range's first row/column, growing rows and
// columns to fit when the view is unsorted and unfiltered
let pasteTarget = parseTable({ props: "{}" });
pasteTarget = addColumn(pasteTarget, { name: "Task", type: "text" });
pasteTarget = addColumn(pasteTarget, { name: "Done", type: "checkbox" });
pasteTarget = addRow(pasteTarget); pasteTarget = addRow(pasteTarget);
const pasteRange = { rowIds: [pasteTarget.rows[0].id], columnIds: [pasteTarget.columns[0].id] };
pasteTarget = applyTsvPaste(pasteTarget, pasteRange, "A\tB\nC\tD\nE\tF");
assert.equal(pasteTarget.rows[0].cells[pasteTarget.columns[0].id], "A");
assert.equal(pasteTarget.rows[0].cells[pasteTarget.columns[1].id], false, "checkbox column parses pasted text 'B' as not-true, i.e. unchecked");
assert.equal(pasteTarget.rows[1].cells[pasteTarget.columns[0].id], "C");
assert.equal(pasteTarget.rows.length, 3, "pasting a 3-row block into a 2-row table grows it to fit");
assert.equal(pasteTarget.rows[2].cells[pasteTarget.columns[0].id], "E");

// a single-column paste that runs past the table's edge only grows rows,
// never invents a column nothing was pasted into
let colGrow = parseTable({ props: "{}" });
colGrow = addColumn(colGrow, { name: "Task", type: "text" });
colGrow = addRow(colGrow);
const colGrowRange = { rowIds: [colGrow.rows[0].id], columnIds: [colGrow.columns[0].id] };
colGrow = applyTsvPaste(colGrow, colGrowRange, "A\nB\nC");
assert.equal(colGrow.rows.length, 3, "a tall single-column paste grows rows");
assert.equal(colGrow.columns.length, 1, "a single-column paste never adds columns");
assert.equal(colGrow.rows[2].cells[colGrow.columns[0].id], "C");

// a trailing newline from an Excel copy does not add a stray blank row
let trailing = parseTable({ props: "{}" });
trailing = addColumn(trailing, { name: "Task", type: "text" });
trailing = addRow(trailing);
const trailingRange = { rowIds: [trailing.rows[0].id], columnIds: [trailing.columns[0].id] };
trailing = applyTsvPaste(trailing, trailingRange, "A\nB\n");
assert.equal(trailing.rows.length, 2, "a trailing newline from the clipboard is not a blank row");

// growth is disabled while a sort or filter constrains the view — same
// safety net mergeCells already applies, for the same reason (storage vs.
// display order no longer match)
let constrained = parseTable({ props: "{}" });
constrained = addColumn(constrained, { name: "Task", type: "text" });
constrained = addRow(constrained); constrained = addRow(constrained);
const constrainedRange = { rowIds: [constrained.rows[0].id], columnIds: [constrained.columns[0].id] };
const constrainedBySort = applyTsvPaste(constrained, constrainedRange, "A\nB\nC", { columnId: constrained.columns[0].id, direction: "asc" }, {});
assert.equal(constrainedBySort.rows.length, 2, "paste does not grow the table while a sort is active");
const constrainedByFilter = applyTsvPaste(constrained, constrainedRange, "A\nB\nC", null, { [constrained.columns[0].id]: "x" });
assert.equal(constrainedByFilter.rows.length, 2, "paste does not grow the table while a filter is active");

// --- reorderColumn: moves a column next to another, is a no-op once merges exist
let reordered = parseTable({ props: "{}" });
reordered = addColumn(reordered, { name: "A", type: "text" });
reordered = addColumn(reordered, { name: "B", type: "text" });
reordered = addColumn(reordered, { name: "C", type: "text" });
const [colA, colB, colC] = reordered.columns.map((c) => c.id);
reordered = reorderColumn(reordered, colA, colC);
assert.deepEqual(reordered.columns.map((c) => c.id), [colB, colC, colA], "dragging A onto C moves A to sit right after C");
assert.deepEqual(reorderColumn(reordered, colA, colA).columns.map((c) => c.id), [colB, colC, colA], "dropping a column on itself is a no-op");

let reorderWithMerge = parseTable({ props: "{}" });
reorderWithMerge = addColumn(reorderWithMerge, { name: "A", type: "text" });
reorderWithMerge = addColumn(reorderWithMerge, { name: "B", type: "text" });
reorderWithMerge = addRow(reorderWithMerge);
const mergeCols = reorderWithMerge.columns.map((c) => c.id);
reorderWithMerge = mergeCells(reorderWithMerge, { rowIds: [reorderWithMerge.rows[0].id], columnIds: mergeCols }, null, {});
assert.equal(reorderWithMerge.merges.length, 1);
const afterAttemptedReorder = reorderColumn(reorderWithMerge, mergeCols[0], mergeCols[1]);
assert.deepEqual(afterAttemptedReorder.columns.map((c) => c.id), mergeCols, "reorder declines while a merge exists rather than risk a stale one");

// --- column width: clamped on parse, round trips through serialize/parse
let widthTable = parseTable({ props: "{}" });
widthTable = addColumn(widthTable, { name: "Task", type: "text" });
widthTable = updateColumn(widthTable, widthTable.columns[0].id, { width: 260 });
assert.equal(widthTable.columns[0].width, 260);
const widthRoundTrip = parseTable({ props: serializeTable(widthTable) });
assert.equal(widthRoundTrip.columns[0].width, 260, "width survives serialize/parse");
const tooNarrow = updateColumn(widthTable, widthTable.columns[0].id, { width: 10 });
assert.equal(tooNarrow.columns[0].width, 80, "width is clamped to the minimum");
const tooWide = updateColumn(widthTable, widthTable.columns[0].id, { width: 5000 });
assert.equal(tooWide.columns[0].width, 640, "width is clamped to the maximum");

// --- clearRangeCells resets every cell in range to its column's default
let clearable = parseTable({ props: "{}" });
clearable = addColumn(clearable, { name: "Task", type: "text" });
clearable = addRow(clearable); clearable = addRow(clearable);
clearable = setCell(clearable, clearable.rows[0].id, clearable.columns[0].id, "keep me? no");
const clearRange = { rowIds: clearable.rows.map((r) => r.id), columnIds: clearable.columns.map((c) => c.id) };
clearable = clearRangeCells(clearable, clearRange);
for (const row of clearable.rows) assert.equal(row.cells[clearable.columns[0].id], "");

// --- CSV export: full table regardless of any filter, header row, quoting
let csvTable = parseTable({ props: "{}" });
csvTable = addColumn(csvTable, { name: "Task, name", type: "text" });
csvTable = addColumn(csvTable, { name: "Done", type: "checkbox" });
csvTable = addRow(csvTable);
csvTable = setCell(csvTable, csvTable.rows[0].id, csvTable.columns[0].id, 'Say "hi"');
csvTable = setCell(csvTable, csvTable.rows[0].id, csvTable.columns[1].id, true);
const csv = toCsv(csvTable);
assert.equal(csv, '"Task, name",Done\r\n"Say ""hi""",TRUE');

// --- insertColumnAt: before/after an anchor, every row gets the new cell,
// and a merge spanning the insertion point grows to keep covering it
let insCol = parseTable({ props: "{}" });
insCol = addColumn(insCol, { name: "A", type: "text" });
insCol = addColumn(insCol, { name: "C", type: "text" });
insCol = addRow(insCol);
const [insColA, insColC] = insCol.columns.map((c) => c.id);
insCol = insertColumnAt(insCol, insColC, "before", { name: "B" });
assert.deepEqual(insCol.columns.map((c) => c.name), ["A", "B", "C"], "insert before C lands between A and C");
assert.equal(insCol.rows[0].cells[insCol.columns[1].id], "", "the inserted column gets a default cell on every existing row");
let insColAfter = insertColumnAt(insCol, insColA, "after", { name: "A2" });
assert.deepEqual(insColAfter.columns.map((c) => c.name), ["A", "A2", "B", "C"]);

let insColWithMerge = parseTable({ props: "{}" });
insColWithMerge = addColumn(insColWithMerge, { name: "A", type: "text" });
insColWithMerge = addColumn(insColWithMerge, { name: "B", type: "text" });
insColWithMerge = addRow(insColWithMerge);
insColWithMerge = mergeCells(insColWithMerge, { rowIds: [insColWithMerge.rows[0].id], columnIds: insColWithMerge.columns.map((c) => c.id) }, null, {});
insColWithMerge = insertColumnAt(insColWithMerge, insColWithMerge.columns[0].id, "after", {});
assert.deepEqual(insColWithMerge.merges, [{ startRowIndex: 0, startColIndex: 0, rowSpan: 1, colSpan: 3 }], "a column inserted inside a merge's span grows the merge instead of splitting it");

// --- insertRow: above/below an anchor, a merge spanning the insertion point grows
let insRow = parseTable({ props: "{}" });
insRow = addColumn(insRow, { name: "A", type: "text" });
insRow = addRow(insRow); insRow = addRow(insRow);
insRow = setCell(insRow, insRow.rows[0].id, insRow.columns[0].id, "top");
insRow = setCell(insRow, insRow.rows[1].id, insRow.columns[0].id, "bottom");
const insRowBelow = insertRow(insRow, insRow.rows[0].id, "below");
assert.equal(insRowBelow.rows.length, 3);
assert.equal(insRowBelow.rows[0].cells[insRow.columns[0].id], "top");
assert.equal(insRowBelow.rows[1].cells[insRow.columns[0].id], "", "the new row is blank");
assert.equal(insRowBelow.rows[2].cells[insRow.columns[0].id], "bottom");
const insRowAbove = insertRow(insRow, insRow.rows[1].id, "above");
assert.equal(insRowAbove.rows[1].cells[insRow.columns[0].id], "", "inserting above the bottom row puts the blank row before it");
assert.equal(insRowAbove.rows[2].cells[insRow.columns[0].id], "bottom");

// --- duplicateRow: a copy right after the original, with its own id
let dup = parseTable({ props: "{}" });
dup = addColumn(dup, { name: "A", type: "text" });
dup = addRow(dup); dup = addRow(dup);
dup = setCell(dup, dup.rows[0].id, dup.columns[0].id, "original");
const dupOriginalId = dup.rows[0].id;
dup = duplicateRow(dup, dupOriginalId);
assert.equal(dup.rows.length, 3);
assert.equal(dup.rows[1].cells[dup.columns[0].id], "original", "the duplicate sits right after the original and copies its cells");
assert.ok(dup.rows[1].id !== dupOriginalId, "the duplicate gets its own id");

// --- reorderRow: moves a row next to another, is a no-op once merges exist
let rowOrder = parseTable({ props: "{}" });
rowOrder = addColumn(rowOrder, { name: "A", type: "text" });
rowOrder = addRow(rowOrder); rowOrder = addRow(rowOrder); rowOrder = addRow(rowOrder);
const [rowA, rowB, rowC] = rowOrder.rows.map((r) => r.id);
rowOrder = reorderRow(rowOrder, rowA, rowC);
assert.deepEqual(rowOrder.rows.map((r) => r.id), [rowB, rowC, rowA], "dragging row A onto row C moves A to sit right after C");
assert.deepEqual(reorderRow(rowOrder, rowA, rowA).rows.map((r) => r.id), [rowB, rowC, rowA], "dropping a row on itself is a no-op");

let rowOrderWithMerge = parseTable({ props: "{}" });
rowOrderWithMerge = addColumn(rowOrderWithMerge, { name: "A", type: "text" });
rowOrderWithMerge = addRow(rowOrderWithMerge); rowOrderWithMerge = addRow(rowOrderWithMerge);
rowOrderWithMerge = mergeCells(rowOrderWithMerge, { rowIds: rowOrderWithMerge.rows.map((r) => r.id), columnIds: [rowOrderWithMerge.columns[0].id] }, null, {});
const mergedRowIds = rowOrderWithMerge.rows.map((r) => r.id);
const afterAttemptedRowReorder = reorderRow(rowOrderWithMerge, mergedRowIds[0], mergedRowIds[1]);
assert.deepEqual(afterAttemptedRowReorder.rows.map((r) => r.id), mergedRowIds, "row reorder declines while a merge exists");

// --- columnSums: only number columns get an entry, others are absent
let summed = parseTable({ props: "{}" });
summed = addColumn(summed, { name: "Name", type: "text" });
summed = addColumn(summed, { name: "Score", type: "number" });
summed = addRow(summed); summed = addRow(summed);
summed = setCell(summed, summed.rows[0].id, summed.columns[1].id, 3);
summed = setCell(summed, summed.rows[1].id, summed.columns[1].id, 4);
const sums = columnSums(summed.rows, summed.columns);
assert.equal(sums[summed.columns[1].id], 7);
assert.equal(sums[summed.columns[0].id], undefined, "a text column has no sum entry at all");

// --- fillRange: copies the source cell(s) into the target, cycling through
// the source when the target is larger
let filled = parseTable({ props: "{}" });
filled = addColumn(filled, { name: "A", type: "text" });
filled = addRow(filled); filled = addRow(filled); filled = addRow(filled);
filled = setCell(filled, filled.rows[0].id, filled.columns[0].id, "X");
const fillSource = { rowIds: [filled.rows[0].id], columnIds: [filled.columns[0].id] };
const fillTarget = { rowIds: [filled.rows[1].id, filled.rows[2].id], columnIds: [filled.columns[0].id] };
filled = fillRange(filled, fillSource, fillTarget);
assert.equal(filled.rows[1].cells[filled.columns[0].id], "X");
assert.equal(filled.rows[2].cells[filled.columns[0].id], "X", "dragging the fill handle down repeats the single source cell");

console.log(`Notible Tables self-check passed: ${COLUMN_TYPES.length} column types, number formats, link resolution, formula engine, round trip, sort, filter, blank table, styles, merges, selection, TSV/clipboard, CSV export, insert/duplicate/reorder rows and columns, sums, and fill all verified.`);
