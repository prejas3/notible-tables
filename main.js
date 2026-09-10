/**
 * Notible Tables — a small spreadsheet, kept as an ordinary workspace object.
 *
 * One ES module, no build step, no dependencies, no network. A table is one
 * object (type "table"); its whole grid — columns and rows — lives in
 * `props`, the same way a habit's whole year of ticks lives in one object's
 * props. That means a table syncs, searches, exports and trashes like
 * anything else, with no schema of its own for Core to know about.
 *
 * Registration is two pieces, same split as every other builtin-shaped
 * plugin: `commands.register({ creates })` puts "Data table" in the "+" menu
 * next to "New note", and `views.registerObjectTab` is what Core mounts when a
 * table object is opened — by clicking it in the tree, or by clicking a
 * `[[Table name]]` link in any note. `"table"` was added to Core's
 * `OBJECT_TAB_TYPES` allowlist (packages/plugin-api) for exactly this; ONLY
 * that allowlist changed in Core, everything else here is this plugin's own.
 *
 * The pure functions below are exported by name so `self-check.mjs` can run
 * them under plain node; the plugin itself is the default export.
 */

export const TABLE_TYPE = "table";

const NAME_LIMIT = 200;
const CELL_LIMIT = 4000;
const MAX_COLUMNS = 40;
const MAX_ROWS = 2000;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 640;

/** The four cell kinds this version understands. Anything else in stored
 * data (a future version's addition, a hand-edited import) is read as
 * "text" rather than thrown away — see `parseTable`. */
export const COLUMN_TYPES = ["text", "number", "date", "checkbox", "select", "link"];

/** Presentation-only number formatting, held on a `number` column as
 * `column.format`. The stored cell value stays a raw number — this only
 * changes how it is shown, copied, exported and summed. */
export function parseNumberFormat(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const style = ["plain", "currency", "percent"].includes(raw.style) ? raw.style : "plain";
  const decimals = Number.isFinite(Number(raw.decimals)) ? Math.min(4, Math.max(0, Math.round(Number(raw.decimals)))) : 0;
  const symbol = typeof raw.symbol === "string" ? raw.symbol.slice(0, 6) : "";
  if (style === "plain" && decimals === 0 && !symbol) return undefined; // the default carries no format
  return { style, decimals, ...(style === "currency" && symbol ? { symbol } : {}) };
}

/** Render one numeric value through a `column.format`. A non-number (an empty
 * cell) passes straight through as "". */
export function formatNumber(value, format) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const decimals = format?.decimals ?? 0;
  if (format?.style === "percent") return `${(value * 100).toFixed(decimals)}%`;
  const body = value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (format?.style === "currency" && format.symbol) return `${format.symbol} ${body}`;
  return body;
}

// ------------------------------------------------------------ formula engine
//
// A cell whose text starts with "=" is a formula. Supported: + - * / ( ),
// unary minus, cell refs (A1), ranges (A1:B3), and SUM / AVERAGE (AVG) /
// COUNT / MIN / MAX. A1 is column A (first column), row 1 (first STORED row)
// — sort and filter are view-only and never move a formula's targets.
// Results are computed on every render and never stored; the "=" string is
// all that lives in props. Errors surface in the cell as #REF! / #CYCLE! /
// #DIV/0! / #ERR!.

export const FORMULA_FUNCTIONS = ["SUM", "AVERAGE", "AVG", "COUNT", "MIN", "MAX"];

/** Is this cell value a formula (leading "=" after optional whitespace)? */
export function isFormula(value) {
  return typeof value === "string" && value.trimStart().startsWith("=");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnLetter(index) {
  let n = index;
  let out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26; -1 for anything that is not A-Z letters. */
export function columnIndexFromLetter(letters) {
  if (!/^[A-Z]+$/.test(letters)) return -1;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

class FormulaError extends Error {}

/** Tokenise a formula body (the part after "="). */
function tokenizeFormula(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") { i += 1; continue; }
    if ("+-*/(),:".includes(ch)) { tokens.push({ t: ch }); i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new FormulaError("#ERR!");
      tokens.push({ t: "num", v: num });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      const ref = /^([A-Za-z]+)([0-9]+)$/.exec(word);
      if (ref) tokens.push({ t: "ref", col: columnIndexFromLetter(ref[1].toUpperCase()), row: Number(ref[2]) - 1 });
      else tokens.push({ t: "name", v: word.toUpperCase() });
      i = j;
      continue;
    }
    throw new FormulaError("#ERR!");
  }
  return tokens;
}

/** Recursive-descent parse into a tiny AST. `getCell(col,row)` is called
 * lazily during eval and must return a number (or throw a FormulaError). */
function parseFormulaTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => { if (!tokens[pos] || (t && tokens[pos].t !== t)) throw new FormulaError("#ERR!"); return tokens[pos++]; };

  function parseExpr() {
    let node = parseTerm();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = eat().t;
      node = { k: "bin", op, l: node, r: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (peek() && (peek().t === "*" || peek().t === "/")) {
      const op = eat().t;
      node = { k: "bin", op, l: node, r: parseUnary() };
    }
    return node;
  }
  function parseUnary() {
    if (peek() && peek().t === "-") { eat(); return { k: "neg", v: parseUnary() }; }
    if (peek() && peek().t === "+") { eat(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new FormulaError("#ERR!");
    if (tk.t === "num") { eat(); return { k: "num", v: tk.v }; }
    if (tk.t === "(") { eat("("); const e = parseExpr(); eat(")"); return e; }
    if (tk.t === "ref") {
      eat();
      if (peek() && peek().t === ":") { eat(":"); const end = eat("ref"); return { k: "range", a: tk, b: end }; }
      return { k: "ref", ref: tk };
    }
    if (tk.t === "name") {
      eat();
      if (!FORMULA_FUNCTIONS.includes(tk.v)) throw new FormulaError("#ERR!");
      eat("(");
      const args = [];
      if (peek() && peek().t !== ")") {
        args.push(parseArg());
        while (peek() && peek().t === ",") { eat(","); args.push(parseArg()); }
      }
      eat(")");
      return { k: "call", name: tk.v, args };
    }
    throw new FormulaError("#ERR!");
  }
  function parseArg() {
    // a function argument is either a range or a full expression
    if (peek() && peek().t === "ref" && tokens[pos + 1] && tokens[pos + 1].t === ":") {
      const a = eat("ref"); eat(":"); const b = eat("ref");
      return { k: "range", a, b };
    }
    return parseExpr();
  }

  const ast = parseExpr();
  if (pos !== tokens.length) throw new FormulaError("#ERR!");
  return ast;
}

/** Evaluate a parsed formula. `getNumber(col,row)` resolves one cell to a
 * finite number (0 for blank/non-numeric) or throws FormulaError("#REF!"). */
function evalFormulaAst(node, getNumber) {
  const rangeValues = (a, b) => {
    if (a.col < 0 || b.col < 0 || a.row < 0 || b.row < 0) throw new FormulaError("#REF!");
    const out = [];
    const [c0, c1] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
    const [r0, r1] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
    for (let c = c0; c <= c1; c += 1) for (let r = r0; r <= r1; r += 1) out.push(getNumber(c, r));
    return out;
  };
  const flatArgs = (args) => args.flatMap((arg) => (arg.k === "range" ? rangeValues(arg.a, arg.b) : [evalFormulaAst(arg, getNumber)]));
  switch (node.k) {
    case "num": return node.v;
    case "neg": return -evalFormulaAst(node.v, getNumber);
    case "ref":
      if (node.ref.col < 0 || node.ref.row < 0) throw new FormulaError("#REF!");
      return getNumber(node.ref.col, node.ref.row);
    case "range": throw new FormulaError("#ERR!"); // a bare range outside a function is meaningless
    case "bin": {
      const l = evalFormulaAst(node.l, getNumber);
      const r = evalFormulaAst(node.r, getNumber);
      if (node.op === "+") return l + r;
      if (node.op === "-") return l - r;
      if (node.op === "*") return l * r;
      if (r === 0) throw new FormulaError("#DIV/0!");
      return l / r;
    }
    case "call": {
      const vals = flatArgs(node.args);
      if (node.name === "COUNT") return vals.length;
      if (node.name === "SUM") return vals.reduce((a, b) => a + b, 0);
      if (node.name === "AVERAGE" || node.name === "AVG") return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      if (node.name === "MIN") return vals.length ? Math.min(...vals) : 0;
      if (node.name === "MAX") return vals.length ? Math.max(...vals) : 0;
      throw new FormulaError("#ERR!");
    }
    default: throw new FormulaError("#ERR!");
  }
}

/** Coerce any stored cell value to the number a formula should see. */
function cellAsNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === true) return 1;
  if (value === false || value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute every formula cell in `table`. Returns a
 * `Map<"rowId:colId", number | "#REF!" | "#CYCLE!" | "#DIV/0!" | "#ERR!">`.
 * Non-formula cells are absent. Cycle-safe and memoised.
 */
export function computeFormulas(table) {
  const results = new Map();
  const asts = new Map();
  const visiting = new Set();

  const parseAt = (key, src) => {
    if (asts.has(key)) return asts.get(key);
    let ast = null;
    try { ast = parseFormulaTokens(tokenizeFormula(src.trimStart().slice(1))); }
    catch { ast = "#ERR!"; }
    asts.set(key, ast);
    return ast;
  };

  const valueAt = (colIndex, rowIndex) => {
    const column = table.columns[colIndex];
    const row = table.rows[rowIndex];
    if (!column || !row) throw new FormulaError("#REF!");
    const raw = row.cells[column.id];
    if (!isFormula(raw)) return cellAsNumber(raw);
    const key = `${row.id}:${column.id}`;
    if (results.has(key)) {
      const cached = results.get(key);
      if (typeof cached === "string") throw new FormulaError(cached);
      return cached;
    }
    if (visiting.has(key)) throw new FormulaError("#CYCLE!");
    visiting.add(key);
    let out;
    try {
      const ast = parseAt(key, raw);
      out = ast === "#ERR!" ? "#ERR!" : evalFormulaAst(ast, valueAt);
      if (typeof out === "number" && !Number.isFinite(out)) out = "#ERR!";
    } catch (error) {
      out = error instanceof FormulaError ? error.message : "#ERR!";
    } finally {
      visiting.delete(key);
    }
    results.set(key, out);
    if (typeof out === "string") throw new FormulaError(out);
    return out;
  };

  for (const [rowIndex, row] of table.rows.entries()) {
    for (const [colIndex, column] of table.columns.entries()) {
      if (!isFormula(row.cells[column.id])) continue;
      const key = `${row.id}:${column.id}`;
      if (results.has(key)) continue;
      try { valueAt(colIndex, rowIndex); }
      catch (error) { results.set(key, error instanceof FormulaError ? error.message : "#ERR!"); }
    }
  }
  return results;
}

/** A shallow copy of `table` with every formula cell replaced by its
 * computed value (or its error string) — the view everything except the
 * cell editor works from. */
export function resolveFormulas(table) {
  const computed = computeFormulas(table);
  if (computed.size === 0) return table;
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(table.columns.map((column) => {
        const raw = row.cells[column.id];
        return [column.id, isFormula(raw) ? (computed.get(`${row.id}:${column.id}`) ?? "#ERR!") : raw];
      })),
    })),
  };
}

/** The same six pens the note editor's highlighter already offers
 * (HIGHLIGHT_COLOURS in coreMarkdownMarks.ts) — duplicated by value, not by
 * import: a plugin is a standalone ES module and cannot reach into
 * src/core. Keeping the exact same six names is what makes a table's
 * coloring read as "the same feature" as the editor's, not a lookalike. */
export const HIGHLIGHT_COLOURS = ["yellow", "green", "blue", "pink", "purple", "orange"];

function randomId() {
  // Not a UUID library: this only has to be unique inside one table's own
  // column/row arrays, and crypto.randomUUID is not guaranteed in every
  // WebView2 build this plugin might run under.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clampText(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/** The value an empty cell of `type` reads as — never `undefined`, so a cell
 * a column's type was just switched to always has something to render and
 * to compare. */
export function defaultCellValue(type) {
  if (type === "number") return "";
  if (type === "checkbox") return false;
  return "";
}

/** One column, normalised. An unrecognised `type` (older export, hand-edited
 * JSON, a future version's addition) degrades to "text" — the failure mode
 * of a broken column type is "shows as text", not "table won't open". */
function parseColumn(raw) {
  const type = COLUMN_TYPES.includes(raw?.type) ? raw.type : "text";
  const options = type === "select" && Array.isArray(raw?.options)
    ? raw.options.filter((option) => typeof option === "string" && option.trim()).slice(0, 50)
    : undefined;
  const format = type === "number" ? parseNumberFormat(raw?.format) : undefined;
  const rawWidth = Number(raw?.width);
  const width = Number.isFinite(rawWidth)
    ? Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, rawWidth)))
    : undefined;
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : randomId(),
    name: clampText(raw?.name, NAME_LIMIT) || "Column",
    type,
    wrap: raw?.wrap === true,
    ...(options ? { options } : {}),
    ...(format ? { format } : {}),
    ...(width ? { width } : {}),
  };
}

function parseCellValue(value, type) {
  if (type === "checkbox") return value === true;
  // A formula string survives in any text/number cell — it is evaluated at
  // render, never stored as its result.
  if ((type === "text" || type === "number") && isFormula(value)) return clampText(value, CELL_LIMIT);
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : (value === "" || value == null ? "" : Number(value) || 0);
  return clampText(typeof value === "string" ? value : value == null ? "" : String(value), CELL_LIMIT);
}

function parseRow(raw, columns) {
  const cells = {};
  for (const column of columns) {
    cells[column.id] = raw?.cells && typeof raw.cells === "object"
      ? parseCellValue(raw.cells[column.id], column.type)
      : defaultCellValue(column.type);
  }
  return { id: typeof raw?.id === "string" && raw.id ? raw.id : randomId(), cells };
}

/** `table.styles`, tolerating anything stored props may contain — same
 * trust boundary as every other parse function here. A malformed entry (bad
 * key shape, unrecognised color, neither flag set) is dropped rather than
 * kept, so a hand-edited or older-version import degrades to "no style on
 * that cell" instead of failing the whole table. */
function parseStyles(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const styles = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || !key.includes(":")) continue;
    const bold = value?.bold === true;
    const color = HIGHLIGHT_COLOURS.includes(value?.color) ? value.color : undefined;
    if (!bold && !color) continue;
    styles[key] = { ...(bold ? { bold: true } : {}), ...(color ? { color } : {}) };
  }
  return styles;
}

/** `table.merges`, tolerating anything stored props may contain. A merge
 * that is out of bounds, has fewer than 2 cells, or overlaps one already
 * accepted is dropped — the same "degrade, don't throw" rule every other
 * parse function in this file follows. Overlap is checked against merges
 * ACCEPTED so far, in stored order, so the result never depends on which
 * malformed entry happened to come first. */
function parseMerges(raw, columnCount, rowCount) {
  if (!Array.isArray(raw)) return [];
  const accepted = [];
  for (const item of raw) {
    const startRowIndex = Number(item?.startRowIndex);
    const startColIndex = Number(item?.startColIndex);
    const rowSpan = Number(item?.rowSpan);
    const colSpan = Number(item?.colSpan);
    if (![startRowIndex, startColIndex, rowSpan, colSpan].every(Number.isInteger)) continue;
    if (rowSpan < 1 || colSpan < 1 || rowSpan * colSpan < 2) continue;
    if (startRowIndex < 0 || startColIndex < 0) continue;
    if (startRowIndex + rowSpan > rowCount || startColIndex + colSpan > columnCount) continue;
    const overlapsAccepted = accepted.some((existing) => rectanglesOverlap(
      startRowIndex, startColIndex, rowSpan, colSpan,
      existing.startRowIndex, existing.startColIndex, existing.rowSpan, existing.colSpan,
    ));
    if (overlapsAccepted) continue;
    accepted.push({ startRowIndex, startColIndex, rowSpan, colSpan });
  }
  return accepted;
}

function rectanglesOverlap(aRow, aCol, aRowSpan, aColSpan, bRow, bCol, bRowSpan, bColSpan) {
  return !(aRow + aRowSpan <= bRow || bRow + bRowSpan <= aRow || aCol + aColSpan <= bCol || bCol + bColSpan <= aCol);
}

/** Read one object into a table, tolerating anything its props may contain —
 * same trust boundary as every other plugin reading from `props`: it is a
 * string from the database, fed by import, by sync, by another machine's
 * newer version of this plugin. A broken table degrades to an empty grid
 * instead of throwing inside a render. */
export function parseTable(object) {
  let parsed = null;
  try {
    parsed = JSON.parse(object?.props || "{}");
  } catch {
    parsed = null;
  }
  const columns = Array.isArray(parsed?.columns) ? parsed.columns.slice(0, MAX_COLUMNS).map(parseColumn) : [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows.slice(0, MAX_ROWS).map((row) => parseRow(row, columns)) : [];
  return {
    id: object?.id ?? null,
    name: typeof object?.title === "string" ? object.title.slice(0, NAME_LIMIT) : "",
    columns,
    rows,
    styles: parseStyles(parsed?.styles),
    merges: parseMerges(parsed?.merges, columns.length, rows.length),
    lockWidths: parsed?.lockWidths === true,
  };
}

/** Columns and rows back into `props`. Cells for a column that no longer
 * exists are dropped by `parseRow` on the next read, so nothing here has to
 * clean them up on write. */
export function serializeTable(table) {
  return JSON.stringify({
    columns: table.columns.map(({ id, name, type, options, format, wrap, width }) => ({
      id, name, type,
      ...(options ? { options } : {}),
      ...(format ? { format } : {}),
      ...(wrap ? { wrap: true } : {}),
      ...(width ? { width } : {}),
    })),
    rows: table.rows.map((row) => ({ id: row.id, cells: row.cells })),
    ...(Object.keys(table.styles ?? {}).length ? { styles: table.styles } : {}),
    ...((table.merges ?? []).length ? { merges: table.merges } : {}),
    ...(table.lockWidths ? { lockWidths: true } : {}),
  });
}

/** Append a column with a fresh id, and give every existing row the new
 * column's default value — a cell no row has yet is still there to fill in,
 * not a gap that only appears once someone types into it. */
export function addColumn(table, { name, type, options } = {}) {
  if (table.columns.length >= MAX_COLUMNS) return table;
  const column = parseColumn({ name: name || `Column ${table.columns.length + 1}`, type, options });
  return {
    ...table,
    columns: [...table.columns, column],
    rows: table.rows.map((row) => ({ ...row, cells: { ...row.cells, [column.id]: defaultCellValue(column.type) } })),
  };
}

/** Patch one column (rename, change type, change select options). Changing
 * `type` re-reads every row's cell for this column through the new type's
 * parser, so a text column full of digits becomes real numbers the moment
 * you switch it to Number, rather than showing NaN until each cell is
 * retyped by hand. */
export function updateColumn(table, columnId, patch) {
  const index = table.columns.findIndex((column) => column.id === columnId);
  if (index === -1) return table;
  const next = parseColumn({ ...table.columns[index], ...patch, id: columnId });
  const columns = [...table.columns];
  columns[index] = next;
  const typeChanged = next.type !== table.columns[index].type;
  return {
    ...table,
    columns,
    rows: typeChanged
      ? table.rows.map((row) => ({ ...row, cells: { ...row.cells, [columnId]: parseCellValue(row.cells[columnId], next.type) } }))
      : table.rows,
  };
}

/** Adjust `merges` for the removal of the row/column at `removedIndex` on
 * `axis` ("row" or "col"). A merge whose span COVERED the removed line loses
 * its identity as a rectangle and is dropped; a merge entirely AFTER it
 * shifts its start index down by one to stay pointed at the same cells;
 * a merge entirely BEFORE it is untouched. Without this, a merge's
 * `startRowIndex`/`startColIndex` goes stale the moment a row/column above
 * or left of it is removed, and the stale index gets persisted on save. */
function adjustMergesForRemoval(merges, axis, removedIndex) {
  const startKey = axis === "row" ? "startRowIndex" : "startColIndex";
  const spanKey = axis === "row" ? "rowSpan" : "colSpan";
  const next = [];
  for (const merge of merges) {
    const start = merge[startKey];
    const span = merge[spanKey];
    if (removedIndex >= start && removedIndex < start + span) continue; // dropped
    if (removedIndex < start) next.push({ ...merge, [startKey]: start - 1 });
    else next.push(merge);
  }
  return next;
}

/** Drop a column and every row's value for it. */
export function removeColumn(table, columnId) {
  const columnIndex = table.columns.findIndex((column) => column.id === columnId);
  return {
    ...table,
    columns: table.columns.filter((column) => column.id !== columnId),
    rows: table.rows.map((row) => {
      const cells = { ...row.cells };
      delete cells[columnId];
      return { ...row, cells };
    }),
    merges: columnIndex === -1 ? (table.merges ?? []) : adjustMergesForRemoval(table.merges ?? [], "col", columnIndex),
  };
}

/** Move one column next to another by dragging its header. A no-op while any
 * merge exists: a merge's `startColIndex`/`colSpan` is a range in STORAGE
 * order (see `parseMerges`), and reordering columns can pull a merge's span
 * apart in ways a simple index shift (unlike `adjustMergesForRemoval`'s
 * single before/after case) cannot generally repair — so, same "degrade,
 * don't produce a stale merge" rule as everywhere else here, reorder simply
 * declines while merges are in play rather than risk corrupting one. */
export function reorderColumn(table, draggedColumnId, targetColumnId) {
  if (draggedColumnId === targetColumnId) return table;
  if ((table.merges ?? []).length > 0) return table;
  const fromIndex = table.columns.findIndex((column) => column.id === draggedColumnId);
  const toIndex = table.columns.findIndex((column) => column.id === targetColumnId);
  if (fromIndex === -1 || toIndex === -1) return table;
  const columns = [...table.columns];
  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, moved);
  return { ...table, columns };
}

/** Adjust `merges` for a row/column newly INSERTED at `insertedIndex` on
 * `axis` — the mirror of `adjustMergesForRemoval`. A merge starting at or
 * after the insertion point shifts down by one to keep pointing at the same
 * cells; a merge whose span already COVERED the insertion point grows by one
 * instead, so a row/column added in the middle of a merged block stays part
 * of it rather than splitting it. */
function adjustMergesForInsertion(merges, axis, insertedIndex) {
  const startKey = axis === "row" ? "startRowIndex" : "startColIndex";
  const spanKey = axis === "row" ? "rowSpan" : "colSpan";
  return merges.map((merge) => {
    const start = merge[startKey];
    const span = merge[spanKey];
    if (insertedIndex <= start) return { ...merge, [startKey]: start + 1 };
    if (insertedIndex < start + span) return { ...merge, [spanKey]: span + 1 };
    return merge;
  });
}

/** Insert a new column next to `columnId` — `position` is "before" or
 * "after" — with a fresh id and every existing row given the new column's
 * default value, same as `addColumn` but at a chosen spot instead of the
 * end. */
export function insertColumnAt(table, columnId, position, spec = {}) {
  if (table.columns.length >= MAX_COLUMNS) return table;
  const anchorIndex = table.columns.findIndex((candidate) => candidate.id === columnId);
  if (anchorIndex === -1) return table;
  const insertAt = position === "before" ? anchorIndex : anchorIndex + 1;
  const column = parseColumn({ name: spec.name || `Column ${table.columns.length + 1}`, type: spec.type, options: spec.options });
  const columns = [...table.columns];
  columns.splice(insertAt, 0, column);
  return {
    ...table,
    columns,
    rows: table.rows.map((row) => ({ ...row, cells: { ...row.cells, [column.id]: defaultCellValue(column.type) } })),
    merges: adjustMergesForInsertion(table.merges ?? [], "col", insertAt),
  };
}

/** Move one row next to another by dragging its handle. Same merges guard as
 * `reorderColumn`, for the same reason. */
export function reorderRow(table, draggedRowId, targetRowId) {
  if (draggedRowId === targetRowId) return table;
  if ((table.merges ?? []).length > 0) return table;
  const fromIndex = table.rows.findIndex((row) => row.id === draggedRowId);
  const toIndex = table.rows.findIndex((row) => row.id === targetRowId);
  if (fromIndex === -1 || toIndex === -1) return table;
  const rows = [...table.rows];
  const [moved] = rows.splice(fromIndex, 1);
  rows.splice(toIndex, 0, moved);
  return { ...table, rows };
}

/** Append one empty row, one default cell per existing column. */
export function addRow(table) {
  if (table.rows.length >= MAX_ROWS) return table;
  const cells = {};
  for (const column of table.columns) cells[column.id] = defaultCellValue(column.type);
  return { ...table, rows: [...table.rows, { id: randomId(), cells }] };
}

/** Insert a new empty row next to `rowId` — `position` is "above" or
 * "below" — one default cell per existing column, same as `addRow` but at a
 * chosen spot instead of the end. */
export function insertRow(table, rowId, position) {
  if (table.rows.length >= MAX_ROWS) return table;
  const anchorIndex = table.rows.findIndex((row) => row.id === rowId);
  if (anchorIndex === -1) return table;
  const insertAt = position === "above" ? anchorIndex : anchorIndex + 1;
  const cells = {};
  for (const column of table.columns) cells[column.id] = defaultCellValue(column.type);
  const rows = [...table.rows];
  rows.splice(insertAt, 0, { id: randomId(), cells });
  return { ...table, rows, merges: adjustMergesForInsertion(table.merges ?? [], "row", insertAt) };
}

/** Insert a copy of one row immediately after it, with a fresh id — the
 * spreadsheet "duplicate row" action. */
export function duplicateRow(table, rowId) {
  if (table.rows.length >= MAX_ROWS) return table;
  const index = table.rows.findIndex((row) => row.id === rowId);
  if (index === -1) return table;
  const copy = { id: randomId(), cells: { ...table.rows[index].cells } };
  const rows = [...table.rows];
  rows.splice(index + 1, 0, copy);
  return { ...table, rows, merges: adjustMergesForInsertion(table.merges ?? [], "row", index + 1) };
}

export function removeRow(table, rowId) {
  const rowIndex = table.rows.findIndex((row) => row.id === rowId);
  return {
    ...table,
    rows: table.rows.filter((row) => row.id !== rowId),
    merges: rowIndex === -1 ? (table.merges ?? []) : adjustMergesForRemoval(table.merges ?? [], "row", rowIndex),
  };
}

/** A fresh 3×3 grid of text columns — what "New data table" actually hands
 * back, rather than the zero-column empty state, which is the right shape
 * once a table already has data but reads as a dead end the first time
 * anyone opens a table they just created. */
export function blankTable(table) {
  let next = table;
  for (let i = 0; i < 3; i++) next = addColumn(next, { type: "text" });
  for (let i = 0; i < 3; i++) next = addRow(next);
  return next;
}

export function setCell(table, rowId, columnId, value) {
  const column = table.columns.find((candidate) => candidate.id === columnId);
  if (!column) return table;
  const parsed = parseCellValue(value, column.type);
  return {
    ...table,
    rows: table.rows.map((row) => row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: parsed } } : row),
  };
}

/** Patch (or add) one cell's style, dropping the entry entirely once it
 * carries no flag — the sparse-map convention `filters`/`table.styles`
 * both follow: absent means "nothing set", never an empty object. */
export function setCellStyle(table, rowId, columnId, patch) {
  const key = `${rowId}:${columnId}`;
  const current = (table.styles ?? {})[key] ?? {};
  const next = { ...current, ...patch };
  const bold = next.bold === true;
  const color = HIGHLIGHT_COLOURS.includes(next.color) ? next.color : undefined;
  const styles = { ...(table.styles ?? {}) };
  if (!bold && !color) delete styles[key];
  else styles[key] = { ...(bold ? { bold: true } : {}), ...(color ? { color } : {}) };
  return { ...table, styles };
}

export function clearCellStyle(table, rowId, columnId) {
  const styles = { ...(table.styles ?? {}) };
  delete styles[`${rowId}:${columnId}`];
  return { ...table, styles };
}

/** Apply the same patch to every cell in a rectangular range — one
 * `store.apply` in the caller covers the whole selection, this just folds
 * `setCellStyle` over it. */
export function setRangeStyle(table, range, patch) {
  let next = table;
  for (const rowId of range.rowIds) {
    for (const columnId of range.columnIds) next = setCellStyle(next, rowId, columnId, patch);
  }
  return next;
}

export function clearRangeStyle(table, range) {
  let next = table;
  for (const rowId of range.rowIds) {
    for (const columnId of range.columnIds) next = clearCellStyle(next, rowId, columnId);
  }
  return next;
}

/** Merge is unavailable while a sort or filter is active: `startRowIndex`/
 * `startColIndex` are indices into `table.rows`/`table.columns` in STORAGE
 * order, and that only matches what is on screen when the view is
 * unsorted and unfiltered — see the design doc's Data model section. The
 * UI is expected to disable the "Merge cells" action in that state, but
 * this no-op is the actual guarantee: nothing calling this function can
 * produce a merge whose indices lie about what is rendered. */
export function mergeCells(table, range, sort, filters) {
  if (sort) return table;
  if (Object.values(filters ?? {}).some((value) => value !== undefined && value !== null && value !== "")) return table;
  const rowIndexes = range.rowIds.map((id) => table.rows.findIndex((row) => row.id === id));
  const colIndexes = range.columnIds.map((id) => table.columns.findIndex((column) => column.id === id));
  if (rowIndexes.includes(-1) || colIndexes.includes(-1)) return table;
  const startRowIndex = Math.min(...rowIndexes);
  const startColIndex = Math.min(...colIndexes);
  const rowSpan = rowIndexes.length;
  const colSpan = colIndexes.length;
  if (rowSpan * colSpan < 2) return table;
  const existing = table.merges ?? [];
  const overlaps = existing.some((m) => rectanglesOverlap(startRowIndex, startColIndex, rowSpan, colSpan, m.startRowIndex, m.startColIndex, m.rowSpan, m.colSpan));
  if (overlaps) return table;
  return { ...table, merges: [...existing, { startRowIndex, startColIndex, rowSpan, colSpan }] };
}

export function unmergeCells(table, startRowIndex, startColIndex) {
  return { ...table, merges: (table.merges ?? []).filter((m) => !(m.startRowIndex === startRowIndex && m.startColIndex === startColIndex)) };
}

/** How one cell's value reads as plain text — shared by clipboard copy and
 * CSV export, which format cells the same way. Checkbox becomes TRUE/FALSE
 * (Excel's own convention for a boolean cell) rather than "true"/"false" or
 * a checkmark glyph a TSV/CSV reader would not recognise as boolean. */
function formatCellForCopy(value, column, resolveTitle) {
  const type = typeof column === "string" ? column : column?.type; // tolerate the old (value, type) callers
  if (type === "checkbox") return value === true ? "TRUE" : "FALSE";
  if (type === "link") return typeof value === "string" && value ? (resolveTitle?.(value) ?? value) : "";
  if (type === "number" && column?.format && typeof value === "number") return formatNumber(value, column.format);
  return value == null ? "" : String(value);
}

export function cellsToTsv(table, range, resolveTitle) {
  const columns = range.columnIds.map((id) => table.columns.find((column) => column.id === id)).filter(Boolean);
  const rows = range.rowIds.map((id) => table.rows.find((row) => row.id === id)).filter(Boolean);
  return rows.map((row) => columns.map((column) => formatCellForCopy(row.cells[column.id], column, resolveTitle)).join("\t")).join("\n");
}

/** Writes a pasted TSV block (e.g. copied from Excel) starting at the
 * range's first row/column, growing the table with new rows/columns when the
 * block runs past its current edge — up to MAX_ROWS/MAX_COLUMNS, the same
 * cap `addRow`/`addColumn` already enforce, so this never bypasses them.
 *
 * Growth only happens when the view is unsorted and unfiltered: `sort`
 * would mean the "first row" the paste started on is in DISPLAY order, not
 * STORAGE order, so appending rows at the end of storage would silently
 * land the new cells somewhere other than where the paste visually began —
 * the same view-constrained guard `mergeCells` already applies, for the same
 * reason. Sorted/filtered stays clamped to what already exists, same as
 * before. */
export function applyTsvPaste(table, range, tsv, sort, filters) {
  const grid = tsv.replace(/\r\n/g, "\n").split("\n").map((line) => line.split("\t"));
  // A copy from Excel/Sheets ends in a newline, which becomes one trailing
  // empty "row" here — without trimming it, every paste would grow the
  // table by one extra blank row it never showed the user.
  while (grid.length > 1 && grid[grid.length - 1].length === 1 && grid[grid.length - 1][0] === "") grid.pop();
  const startRowIndex = table.rows.findIndex((row) => row.id === range.rowIds[0]);
  const startColIndex = table.columns.findIndex((column) => column.id === range.columnIds[0]);
  if (startRowIndex === -1 || startColIndex === -1) return table;

  let next = table;
  const viewConstrained = Boolean(sort) || Object.values(filters ?? {}).some((value) => value !== undefined && value !== null && value !== "");
  if (!viewConstrained) {
    const neededRows = startRowIndex + grid.length;
    while (next.rows.length < neededRows && next.rows.length < MAX_ROWS) next = addRow(next);
    const neededColumns = grid.reduce((max, line) => Math.max(max, startColIndex + line.length), 0);
    while (next.columns.length < neededColumns && next.columns.length < MAX_COLUMNS) next = addColumn(next);
  }

  for (let r = 0; r < grid.length; r++) {
    const targetRow = next.rows[startRowIndex + r];
    if (!targetRow) break;
    for (let c = 0; c < grid[r].length; c++) {
      const targetColumn = next.columns[startColIndex + c];
      if (!targetColumn) break;
      next = setCell(next, targetRow.id, targetColumn.id, grid[r][c]);
    }
  }
  return next;
}

export function clearRangeCells(table, range) {
  let next = table;
  for (const rowId of range.rowIds) {
    for (const columnId of range.columnIds) {
      const column = next.columns.find((candidate) => candidate.id === columnId);
      if (column) next = setCell(next, rowId, columnId, defaultCellValue(column.type));
    }
  }
  return next;
}

/** RFC-4180-ish quoting: a field containing a comma, quote or newline is
 * wrapped in quotes, with quotes doubled inside. Not a general CSV library —
 * this table only ever writes fields it built itself from typed cell
 * values, never re-parses CSV, so this one direction is all it needs. */
function csvField(value) {
  const stringValue = String(value ?? "");
  return /[",\n]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

/** The whole table, ignoring any active filter — an export that silently
 * dropped filtered-out rows would be a data-loss surprise the next time
 * someone opens the file expecting everything that was in the table. */
export function toCsv(table, resolveTitle) {
  const header = table.columns.map((column) => csvField(column.name)).join(",");
  const lines = table.rows.map((row) => table.columns.map((column) => csvField(formatCellForCopy(row.cells[column.id], column, resolveTitle))).join(","));
  return [header, ...lines].join("\r\n");
}

/** Compare two cell values of the same column `type`. Numbers and checkboxes
 * compare numerically (`false` < `true`); text and date compare as strings —
 * a date column is stored `YYYY-MM-DD`, which already sorts correctly as
 * text, so it does not need its own branch. */
function compareCells(a, b, type) {
  if (type === "number") return (typeof a === "number" ? a : 0) - (typeof b === "number" ? b : 0);
  if (type === "checkbox") return Number(a === true) - Number(b === true);
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base", numeric: true });
}

/**
 * Sort rows by one column, or return them in their stored order for
 * `sort: null` — a table with no sort applied keeps the order rows were
 * added in, same as it would on disk.
 */
export function sortRows(rows, columns, sort) {
  if (!sort) return rows;
  const column = columns.find((candidate) => candidate.id === sort.columnId);
  if (!column) return rows;
  const direction = sort.direction === "desc" ? -1 : 1;
  // A stable copy: Array.prototype.sort mutates, and every caller here holds
  // the array as a prop value that must not change out from under React.
  return [...rows].sort((left, right) => direction * compareCells(left.cells[column.id], right.cells[column.id], column.type));
}

/** Does `row` pass every active filter? A checkbox filter is
 * `"any" | "checked" | "unchecked"`; every other column type filters by
 * case-insensitive substring on its displayed text. An absent or blank
 * filter for a column always passes — filtering is opt-in per column. */
export function matchesFilters(row, columns, filters) {
  if (!filters) return true;
  for (const column of columns) {
    const filter = filters[column.id];
    if (filter === undefined || filter === null || filter === "") continue;
    const value = row.cells[column.id];
    if (column.type === "checkbox") {
      if (filter === "checked" && value !== true) return false;
      if (filter === "unchecked" && value !== false) return false;
      continue;
    }
    const haystack = String(value ?? "").toLocaleLowerCase();
    if (!haystack.includes(String(filter).toLocaleLowerCase())) return false;
  }
  return true;
}

export function filterRows(rows, columns, filters) {
  return rows.filter((row) => matchesFilters(row, columns, filters));
}

/** Filter, then sort — the order the grid always applies them in: sorting a
 * filtered-out row would be wasted work, and a user watching a column's sort
 * arrow expects it to describe what is currently on screen. */
export function visibleRows(table, filters, sort) {
  return sortRows(filterRows(table.rows, table.columns, filters), table.columns, sort);
}

/** Which row ids / column ids fall inside a selection, resolved against one
 * render's row/column order. `selection` holds row/column IDs, not indices
 * — an edit anywhere else in the table must not silently move or invalidate
 * an in-progress selection the way an index would. Returns null if either
 * endpoint no longer exists (its row or column was deleted). */
export function resolveSelection(rows, columns, selection) {
  if (!selection) return null;
  const rowIds = rows.map((row) => row.id);
  const colIds = columns.map((column) => column.id);
  const anchorRowIndex = rowIds.indexOf(selection.anchorRow);
  const focusRowIndex = rowIds.indexOf(selection.focusRow);
  const anchorColIndex = colIds.indexOf(selection.anchorCol);
  const focusColIndex = colIds.indexOf(selection.focusCol);
  if (anchorRowIndex === -1 || focusRowIndex === -1 || anchorColIndex === -1 || focusColIndex === -1) return null;
  const rowStart = Math.min(anchorRowIndex, focusRowIndex);
  const rowEnd = Math.max(anchorRowIndex, focusRowIndex);
  const colStart = Math.min(anchorColIndex, focusColIndex);
  const colEnd = Math.max(anchorColIndex, focusColIndex);
  return {
    rowIds: rowIds.slice(rowStart, rowEnd + 1),
    columnIds: colIds.slice(colStart, colEnd + 1),
  };
}

/** Sum of every number-column's cells across `rows` — the footer totals
 * row. Only number columns get an entry; a text/date/checkbox/select column
 * has nothing to sum, so its id is simply absent (the sparse-map convention
 * `styles` already follows). */
export function columnSums(rows, columns) {
  const sums = {};
  for (const column of columns) {
    if (column.type !== "number") continue;
    sums[column.id] = rows.reduce((total, row) => total + (typeof row.cells[column.id] === "number" ? row.cells[column.id] : 0), 0);
  }
  return sums;
}

/** The drag-to-fill handle's mechanics: copy `source`'s cell values across
 * `target`, cycling through source rows/columns to cover a larger target.
 * No series detection (1, 2, 3…) — every filled cell is a literal copy of
 * whichever source cell lines up with it, same as dragging a single Excel
 * cell's fill handle without holding any modifier. */
export function fillRange(table, source, target) {
  if (source.rowIds.length === 0 || source.columnIds.length === 0) return table;
  let next = table;
  for (let r = 0; r < target.rowIds.length; r++) {
    const sourceRow = table.rows.find((row) => row.id === source.rowIds[r % source.rowIds.length]);
    if (!sourceRow) continue;
    for (let c = 0; c < target.columnIds.length; c++) {
      const sourceColumnId = source.columnIds[c % source.columnIds.length];
      next = setCell(next, target.rowIds[r], target.columnIds[c], sourceRow.cells[sourceColumnId]);
    }
  }
  return next;
}

// ------------------------------------------------------------------- DOM

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  for (const child of children) node.append(child);
  return node;
}

/** Every string drawn below reaches the DOM through `textContent` or a
 * form control's `.value`, never through markup built from a string — same
 * rule notible-habits keeps, for the same reason: a table's cells and column
 * names arrive from sync and import like any other object content. */
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

class TableStore {
  constructor(context, objectId) {
    this.context = context;
    this.objectId = objectId;
    this.table = { id: objectId, name: "", columns: [], rows: [] };
    this.listeners = new Set();
    this.loading = true;
    this.error = null;
    this.updatedAt = undefined;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announce() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken surface must not stop the others from redrawing.
      }
    }
  }

  async load() {
    this.loading = true;
    this.announce();
    try {
      const object = await this.context.data.objects.get(this.objectId);
      if (!object) {
        this.error = "This table no longer exists.";
      } else {
        this.table = parseTable(object);
        this.updatedAt = object.updated_at;
        this.error = null;
      }
    } catch (cause) {
      this.error = String(cause?.message ?? cause);
    } finally {
      this.loading = false;
      this.announce();
    }
  }

  /** Apply a pure edit optimistically, then persist. The optimistic-lock
   * conflict that `data.objects.update` can throw (another surface, or a
   * sync pull, wrote this table since it was loaded) is resolved the same
   * way the Properties plugin resolves it: refetch and retry once with the
   * fresh timestamp, rather than surfacing a raw "conflict" on every
   * keystroke of a fast typist. */
  async apply(next) {
    this.table = next;
    this.announce();
    const patch = { props: serializeTable(next) };
    try {
      const updated = await this.context.data.objects.update(this.objectId, patch, this.updatedAt);
      this.updatedAt = updated.updated_at;
    } catch (cause) {
      if (!String(cause?.message ?? cause).toLowerCase().includes("conflict")) {
        this.context.ui.notice(`Could not save this table: ${String(cause?.message ?? cause)}`);
        return;
      }
      try {
        const fresh = await this.context.data.objects.get(this.objectId);
        if (!fresh) throw new Error("This table no longer exists.");
        const updated = await this.context.data.objects.update(this.objectId, patch, fresh.updated_at);
        this.updatedAt = updated.updated_at;
      } catch (retryCause) {
        this.context.ui.notice(`Could not save this table: ${String(retryCause?.message ?? retryCause)}`);
        await this.load();
      }
    }
  }
}

const TYPE_LABEL = { text: "Text", number: "Number", date: "Date", checkbox: "Checkbox", select: "Select", link: "Link" };

/** One cell's input control, keyed to `column.type`. Committed on blur/change
 * rather than on every keystroke — a table's `apply` writes the whole grid,
 * so debouncing at the character level would mean every other cell's edit
 * races the same network write. */
function cellInput(store, row, column, resolveTitle, rawRow) {
  const value = row.cells[column.id];
  const commit = (next) => void store.apply(setCell(store.table, row.id, column.id, next));
  // Committing a cell rebuilds the whole grid (see mountGrid's render), which
  // would otherwise strand a click that landed on the very input being
  // replaced — the same `data-focus-key` mechanism the header filters use,
  // keyed to this row+column so the rebuilt cell gets focus back rather than
  // requiring a second click.
  const focusKey = `cell:${row.id}:${column.id}`;
  // A formula cell (any text/number column). Idle shows the computed value
  // (`value` here is already the resolved view's cell); focus swaps in the
  // "=" source for editing; commit stores whatever was typed.
  const source = rawRow ? rawRow.cells[column.id] : value;
  if (isFormula(source)) {
    const display = column.type === "number" && column.format && typeof value === "number"
      ? formatNumber(value, column.format)
      : (value == null ? "" : String(value));
    const input = element("input", { type: "text", className: "ntbl-cell-input ntbl-cell-formula", value: display });
    input.dataset.focusKey = focusKey;
    input.addEventListener("focus", () => { input.value = String(source); input.select(); });
    input.addEventListener("blur", () => { input.value = display; });
    input.addEventListener("change", () => commit(input.value));
    return input;
  }
  if (column.type === "checkbox") {
    const input = element("input", { type: "checkbox", checked: value === true, className: "ntbl-check" });
    input.dataset.focusKey = focusKey;
    input.addEventListener("change", () => commit(input.checked));
    return input;
  }
  if (column.type === "select") {
    const input = element("select", { className: "ntbl-cell-input" });
    input.dataset.focusKey = focusKey;
    input.append(element("option", { value: "", textContent: "—" }));
    for (const option of column.options ?? []) input.append(element("option", { value: option, textContent: option, selected: option === value }));
    input.addEventListener("change", () => commit(input.value));
    return input;
  }
  // A reference to another workspace object. The cell stores its id; the
  // input shows/edits its title. Type or paste `[[Title]]` (or a bare
  // title) and, on commit, the plugin resolves it to the object whose
  // title matches — exact first, then a unique prefix. No match clears it.
  if (column.type === "link") {
    const wrap = element("div", { className: "ntbl-link-cell" });
    const title = typeof value === "string" && value ? resolveTitle?.(value) : undefined;
    const input = element("input", {
      type: "text",
      className: "ntbl-cell-input ntbl-cell-link",
      value: typeof value === "string" && value ? `[[${title ?? value}]]` : "",
      placeholder: "[[Object title]]",
    });
    input.dataset.focusKey = focusKey;
    input.addEventListener("change", async () => {
      const query = input.value.replace(/^\s*\[\[|\]\]\s*$/g, "").trim();
      if (!query) { commit(""); return; }
      try {
        const objects = await store.context.data.objects.query({ limit: 5000 });
        const exact = objects.find((object) => (object.title || "").toLowerCase() === query.toLowerCase());
        const prefix = objects.filter((object) => (object.title || "").toLowerCase().startsWith(query.toLowerCase()));
        const hit = exact ?? (prefix.length === 1 ? prefix[0] : null);
        if (hit) commit(hit.id);
        else { store.context.ui.notice(`No single object titled "${query}".`); commit(value); }
      } catch (cause) { store.context.ui.notice(`Could not look up "${query}": ${String(cause?.message ?? cause)}`); commit(value); }
    });
    wrap.append(input);
    if (typeof value === "string" && value) {
      const open = element("button", { type: "button", className: "ntbl-link-open", title: title ? `Open "${title}"` : "This reference no longer resolves", textContent: "↗" });
      if (!title) open.disabled = true;
      open.addEventListener("click", () => void store.context.ui.openObject(value));
      wrap.append(open);
    }
    return wrap;
  }
  // A number column with a display format: show the formatted value while
  // idle, the raw number while focused, and parse the typed text back on
  // commit (strip the symbol / grouping / percent sign). A plain number
  // column keeps the native <input type="number">.
  if (column.type === "number" && column.format) {
    const input = element("input", {
      type: "text",
      inputMode: "decimal",
      className: "ntbl-cell-input",
      value: typeof value === "number" ? formatNumber(value, column.format) : "",
    });
    input.dataset.focusKey = focusKey;
    input.addEventListener("focus", () => { input.value = typeof value === "number" ? String(value) : ""; });
    input.addEventListener("blur", () => { input.value = typeof value === "number" ? formatNumber(value, column.format) : input.value; });
    input.addEventListener("change", () => {
      const raw = input.value.replace(/[^0-9.\-]/g, "");
      commit(raw === "" ? "" : Number(raw) || 0);
    });
    return input;
  }
  // A plain <input> cannot wrap its text onto a second line — a wrapped
  // text column needs a control that can, so it swaps to a <textarea> only
  // when both conditions hold. Every other type/column keeps the <input>.
  if (column.type === "text" && column.wrap) {
    const textarea = element("textarea", {
      className: "ntbl-cell-textarea",
      value: value == null ? "" : String(value),
      rows: 2,
    });
    textarea.dataset.focusKey = focusKey;
    textarea.addEventListener("change", () => commit(textarea.value));
    return textarea;
  }
  const input = element("input", {
    type: column.type === "number" ? "number" : column.type === "date" ? "date" : "text",
    value: value == null ? "" : String(value),
    className: "ntbl-cell-input",
  });
  input.dataset.focusKey = focusKey;
  input.addEventListener("change", () => commit(input.value));
  return input;
}

/** The filter control for one column: a tri-state select for checkbox
 * columns, a free-text substring box for everything else. Lives in the
 * right-click menu now, not the header itself — see columnMenu. */
function filterControl(column, filters, setFilter) {
  if (column.type === "checkbox") {
    const select = element("select", { className: "ntbl-th-filter" });
    for (const [value, label] of [["", "Any"], ["checked", "Checked"], ["unchecked", "Unchecked"]]) select.append(element("option", { value, textContent: label, selected: (filters[column.id] ?? "") === value }));
    select.addEventListener("change", () => setFilter(column.id, select.value));
    return select;
  }
  const input = element("input", { className: "ntbl-th-filter", placeholder: "Filter…", value: filters[column.id] ?? "" });
  // A live filter's own render() rebuilds the whole grid on every keystroke
  // (the filtered row set can only be recomputed from a fresh table read),
  // which would otherwise replace this very input out from under the caret
  // typing into it. `data-focus-key` is how render() finds "the same" input
  // again after rebuilding and gives it back focus and its caret position.
  input.dataset.focusKey = `filter:${column.id}`;
  input.addEventListener("input", () => setFilter(column.id, input.value));
  return input;
}

/** The right-click panel for one column: sort, format (type + select
 * options) and filter — everything that used to sit permanently under the
 * column name, now opened on demand so a table with several columns does not
 * read as a wall of controls before anyone has touched one. */
function columnMenu(store, column, sort, setSort, filters, setFilter) {
  const menu = element("div", { className: "ntbl-colmenu" });

  const sortRow = element("div", { className: "ntbl-colmenu-row" });
  sortRow.append(text("span", "Sort", "ntbl-colmenu-label"));
  const sortGroup = element("div", { className: "ntbl-colmenu-sort" });
  for (const [direction, label, glyph] of [["asc", "Ascending", "▲"], ["desc", "Descending", "▼"]]) {
    const isActive = sort?.columnId === column.id && sort.direction === direction;
    const button = element("button", {
      type: "button",
      className: `ntbl-colmenu-btn${isActive ? " is-active" : ""}`,
      title: label,
      textContent: glyph,
    });
    button.addEventListener("click", () => setSort(isActive ? null : { columnId: column.id, direction }));
    sortGroup.append(button);
  }
  sortRow.append(sortGroup);
  menu.append(sortRow);

  const formatRow = element("div", { className: "ntbl-colmenu-row" });
  formatRow.append(text("span", "Format", "ntbl-colmenu-label"));
  const typeSelect = element("select", { className: "ntbl-th-type" });
  for (const type of COLUMN_TYPES) typeSelect.append(element("option", { value: type, textContent: TYPE_LABEL[type], selected: type === column.type }));
  typeSelect.addEventListener("change", () => void store.apply(updateColumn(store.table, column.id, { type: typeSelect.value })));
  formatRow.append(typeSelect);
  menu.append(formatRow);

  if (column.type === "text") {
    const wrapRow = element("div", { className: "ntbl-colmenu-row ntbl-colmenu-row--inline" });
    const wrapLabel = element("label", { className: "ntbl-colmenu-checkbox" });
    const wrapCheckbox = element("input", { type: "checkbox", checked: column.wrap === true });
    wrapCheckbox.addEventListener("change", () => void store.apply(updateColumn(store.table, column.id, { wrap: wrapCheckbox.checked })));
    wrapLabel.append(wrapCheckbox, text("span", "Wrap text"));
    wrapRow.append(wrapLabel);
    menu.append(wrapRow);
  }

  if (column.type === "select") {
    const optionsRow = element("div", { className: "ntbl-colmenu-row" });
    optionsRow.append(text("span", "Options", "ntbl-colmenu-label"));
    const options = element("input", {
      className: "ntbl-th-options",
      placeholder: "Comma separated",
      value: (column.options ?? []).join(", "),
    });
    options.addEventListener("change", () => {
      const next = options.value.split(",").map((option) => option.trim()).filter(Boolean);
      void store.apply(updateColumn(store.table, column.id, { options: next }));
    });
    optionsRow.append(options);
    menu.append(optionsRow);
  }

  if (column.type === "number") {
    const fmt = column.format ?? { style: "plain", decimals: 0 };
    const applyFormat = (patch) => {
      const next = { style: fmt.style, decimals: fmt.decimals, ...(fmt.symbol ? { symbol: fmt.symbol } : {}), ...patch };
      void store.apply(updateColumn(store.table, column.id, { format: next }));
    };
    const numRow = element("div", { className: "ntbl-colmenu-row" });
    numRow.append(text("span", "Number", "ntbl-colmenu-label"));
    const styleSelect = element("select", { className: "ntbl-th-type" });
    for (const [value, label] of [["plain", "Plain"], ["currency", "Currency"], ["percent", "Percent"]]) {
      styleSelect.append(element("option", { value, textContent: label, selected: value === fmt.style }));
    }
    styleSelect.addEventListener("change", () => applyFormat({ style: styleSelect.value }));
    numRow.append(styleSelect);
    const decimals = element("input", { type: "number", className: "ntbl-th-decimals", min: 0, max: 4, value: String(fmt.decimals ?? 0), title: "Decimal places" });
    decimals.addEventListener("change", () => applyFormat({ decimals: Math.min(4, Math.max(0, Math.round(Number(decimals.value) || 0))) }));
    numRow.append(decimals);
    if (fmt.style === "currency") {
      const symbol = element("input", { className: "ntbl-th-symbol", placeholder: "zł", value: fmt.symbol ?? "", title: "Currency symbol" });
      symbol.addEventListener("change", () => applyFormat({ symbol: symbol.value.trim() }));
      numRow.append(symbol);
    }
    menu.append(numRow);
  }

  const filterRow = element("div", { className: "ntbl-colmenu-row" });
  filterRow.append(text("span", "Filter", "ntbl-colmenu-label"));
  filterRow.append(filterControl(column, filters, setFilter));
  menu.append(filterRow);

  const insertRow_ = element("div", { className: "ntbl-colmenu-row" });
  insertRow_.append(text("span", "Insert", "ntbl-colmenu-label"));
  const insertGroup = element("div", { className: "ntbl-colmenu-sort" });
  const insertLeftButton = element("button", { type: "button", className: "ntbl-colmenu-btn", title: "Insert column left", textContent: "◀+" });
  insertLeftButton.addEventListener("click", () => void store.apply(insertColumnAt(store.table, column.id, "before")));
  const insertRightButton = element("button", { type: "button", className: "ntbl-colmenu-btn", title: "Insert column right", textContent: "+▶" });
  insertRightButton.addEventListener("click", () => void store.apply(insertColumnAt(store.table, column.id, "after")));
  insertGroup.append(insertLeftButton, insertRightButton);
  insertRow_.append(insertGroup);
  menu.append(insertRow_);

  return menu;
}

/** The floating bar over a multi-cell selection: bold, the six highlight
 * colors (plus "none"), and a clear-formatting button — all bulk actions
 * over the whole range in one `store.apply`, same reasoning as
 * `setRangeStyle` itself: N cells, one network write. Only shown for a
 * range bigger than one cell — a single cell already edits inline, there
 * is nothing to act on "in bulk" yet. */
function formattingToolbar(store, range) {
  const bar = element("div", { className: "ntbl-format-bar" });

  const boldButton = element("button", { type: "button", className: "ntbl-format-btn", title: "Bold", textContent: "B" });
  boldButton.style.fontWeight = "700";
  boldButton.addEventListener("click", () => void store.apply(setRangeStyle(store.table, range, { bold: true })));
  bar.append(boldButton);

  for (const colour of HIGHLIGHT_COLOURS) {
    const swatch = element("button", { type: "button", className: "ntbl-format-swatch", title: colour });
    swatch.dataset.color = colour;
    swatch.addEventListener("click", () => void store.apply(setRangeStyle(store.table, range, { color: colour })));
    bar.append(swatch);
  }

  const noneSwatch = element("button", { type: "button", className: "ntbl-format-swatch ntbl-format-swatch--none", title: "No color" });
  noneSwatch.addEventListener("click", () => void store.apply(setRangeStyle(store.table, range, { color: undefined })));
  bar.append(noneSwatch);

  const clearButton = element("button", { type: "button", className: "ntbl-format-btn", title: "Clear formatting", textContent: "Clear" });
  clearButton.addEventListener("click", () => void store.apply(clearRangeStyle(store.table, range)));
  bar.append(clearButton);

  return bar;
}

/** Right-click panel for one cell: "Merge cells" (only offered when the
 * selection spans more than one cell, disabled with an explanatory title
 * while a sort or filter is active) or "Unmerge" when the right-clicked
 * cell is the top-left of an existing merge — plus row/column insert and
 * duplicate actions for `rowId`/`colId`, the actual cell that was
 * right-clicked, which always apply regardless of how big the selection is. */
function rangeMenu_(store, range, sort, filters, rowId, colId, closeMenu) {
  const menu = element("div", { className: "ntbl-rangemenu" });
  const isMultiCell = range.rowIds.length > 1 || range.columnIds.length > 1;
  const rowIndexes = range.rowIds.map((id) => store.table.rows.findIndex((row) => row.id === id));
  const colIndexes = range.columnIds.map((id) => store.table.columns.findIndex((column) => column.id === id));
  const startRowIndex = Math.min(...rowIndexes);
  const startColIndex = Math.min(...colIndexes);
  const existingMerge = (store.table.merges ?? []).find((m) => m.startRowIndex === startRowIndex && m.startColIndex === startColIndex);

  if (existingMerge) {
    const unmergeButton = element("button", { type: "button", className: "ntbl-rangemenu-btn", textContent: "Unmerge" });
    unmergeButton.addEventListener("click", () => { closeMenu(); void store.apply(unmergeCells(store.table, existingMerge.startRowIndex, existingMerge.startColIndex)); });
    menu.append(unmergeButton);
  } else if (isMultiCell) {
    const viewConstrained = Boolean(sort) || Object.values(filters ?? {}).some((value) => value !== undefined && value !== null && value !== "");
    const mergeButton = element("button", { type: "button", className: "ntbl-rangemenu-btn", textContent: "Merge cells" });
    mergeButton.disabled = viewConstrained;
    mergeButton.title = viewConstrained ? "Clear the active sort or filter first — merge needs rows and columns in their stored order." : "";
    mergeButton.addEventListener("click", () => { closeMenu(); void store.apply(mergeCells(store.table, range, sort, filters)); });
    menu.append(mergeButton);
  }

  menu.append(element("div", { className: "ntbl-rangemenu-sep" }));
  for (const [label, action, danger] of [
    ["Insert row above", () => insertRow(store.table, rowId, "above")],
    ["Insert row below", () => insertRow(store.table, rowId, "below")],
    ["Duplicate row", () => duplicateRow(store.table, rowId)],
    ["Delete row", () => removeRow(store.table, rowId), true],
  ]) {
    const button = element("button", { type: "button", className: danger ? "ntbl-rangemenu-btn ntbl-rangemenu-btn--danger" : "ntbl-rangemenu-btn", textContent: label });
    if (danger && store.table.rows.length <= 1) button.disabled = true;
    button.addEventListener("click", () => { closeMenu(); void store.apply(action()); });
    menu.append(button);
  }

  menu.append(element("div", { className: "ntbl-rangemenu-sep" }));
  for (const [label, action, danger] of [
    ["Insert column left", () => insertColumnAt(store.table, colId, "before")],
    ["Insert column right", () => insertColumnAt(store.table, colId, "after")],
    ["Delete column", () => removeColumn(store.table, colId), true],
  ]) {
    const button = element("button", { type: "button", className: danger ? "ntbl-rangemenu-btn ntbl-rangemenu-btn--danger" : "ntbl-rangemenu-btn", textContent: label });
    if (danger && store.table.columns.length <= 1) button.disabled = true;
    button.addEventListener("click", () => { closeMenu(); void store.apply(action()); });
    menu.append(button);
  }

  return menu;
}

/** A column header drags to reorder from a dedicated grip, and resizes from
 * a strip on its trailing edge — the two live only on the `th`, so neither
 * touches a single cell's DOM and neither can be triggered by an ordinary
 * click into the name field. */
function columnHeader(store, column, sort, setSort, filters, setFilter, openMenu, startColumnDrag, selectColumn) {
  const active = sort?.columnId === column.id;
  const filtered = (filters[column.id] ?? "") !== "";
  const th = element("th", { className: "ntbl-th" });
  th.dataset.colId = column.id;
  if (column.width) th.style.width = `${column.width}px`;
  th.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(column.id, event.clientX, event.clientY);
  });
  // Click the header chrome (label, badges, padding) to select the whole
  // column; shift-click a second header to span a block of columns. Clicks
  // on the rename input, the menu / remove buttons and the resize handle
  // keep their own behaviour. The ⠿ drag handle: a plain click (no drag)
  // falls through here and selects, a drag ends in a store.apply/render.
  th.addEventListener("click", (event) => {
    if (event.target.closest("input, .ntbl-th-resize, .ntbl-th-menu, .ntbl-th-remove")) return;
    selectColumn(column.id, event.shiftKey);
  });

  // Reorder is plain mousedown/mousemove/mouseup, not HTML5 drag-and-drop —
  // Tauri's window has native OS drag-drop handling enabled by default
  // (`dragDropEnabled`), which swallows the browser's own dragstart before
  // it ever fires, so a `draggable` element never starts a drag inside this
  // app. The rest of this grid already drags cell selections and resizes
  // columns the same pointer-tracking way, so this just follows suit.
  const dragHandle = element("button", { type: "button", className: "ntbl-th-drag", title: "Drag to move this column", textContent: "⠿" });
  dragHandle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startColumnDrag(column.id);
  });

  const nameRow = element("div", { className: "ntbl-th-name" });
  nameRow.append(dragHandle);
  const nameInput = element("input", { className: "ntbl-th-input", value: column.name });
  nameInput.addEventListener("change", () => void store.apply(updateColumn(store.table, column.id, { name: nameInput.value })));
  nameRow.append(nameInput);

  // Read-only feedback for state set through the menu — a column that is
  // sorted or filtered still has to say so when the header itself carries
  // no controls any more.
  if (active) nameRow.append(text("span", sort.direction === "asc" ? "▲" : "▼", "ntbl-th-badge"));
  if (filtered) nameRow.append(text("span", "⏷", "ntbl-th-badge"));

  const menuButton = element("button", {
    type: "button",
    className: "ntbl-th-menu",
    title: "Sort, format and filter this column",
    textContent: "⋯",
  });
  menuButton.addEventListener("click", (event) => {
    const rect = menuButton.getBoundingClientRect();
    openMenu(column.id, rect.left, rect.bottom + 4);
  });
  nameRow.append(menuButton);

  const removeButton = element("button", { type: "button", className: "ntbl-th-remove", title: "Remove column", textContent: "×" });
  removeButton.addEventListener("click", () => void store.apply(removeColumn(store.table, column.id)));
  nameRow.append(removeButton);
  th.append(nameRow);

  // Width resize: dragged live on the `th`'s own inline style (cheap, no
  // grid rebuild, so it never fights a cell's focus the way the selection
  // bug did) and only written to the table — one store.apply — on release.
  // Skipped entirely when the table has its widths locked.
  if (store.table.lockWidths) return th;
  const resizeHandle = element("div", { className: "ntbl-th-resize" });
  resizeHandle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    resizeHandle.setPointerCapture(event.pointerId);
    function onMove(moveEvent) {
      const width = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX))));
      th.style.width = `${width}px`;
      th.style.minWidth = `${width}px`;
    }
    function onUp(upEvent) {
      resizeHandle.releasePointerCapture(upEvent.pointerId);
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onUp);
      const width = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, startWidth + (upEvent.clientX - startX))));
      void store.apply(updateColumn(store.table, column.id, { width }));
    }
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp);
  });
  th.append(resizeHandle);

  return th;
}

/**
 * The grid: column headers (rename, retype, filter, sort, remove) over rows
 * of typed cell inputs, with add-row/add-column controls. Mounted through
 * `views.registerObjectTab` — Core hands this the object id of the table
 * that was opened, whether that was a click in the sidebar tree or a
 * `[[Table name]]` link inside a note.
 */
function mountGrid(context, container, objectId) {
  const store = new TableStore(context, objectId);
  let sort = null;
  const filters = {};
  // The one column-menu popup open at a time, right-clicked or opened via
  // the header's "⋯" button. Position is where the trigger fired, clamped
  // into the viewport when the panel is built — see render().
  let openMenu = null;
  // A rectangular range, by row/column ID so it survives a re-render.
  // `dragging` is true between mousedown and mouseup on a cell, so a
  // mousemove elsewhere on the page (e.g. after the pointer leaves the
  // table) does not keep extending it once the button is no longer down.
  let selection = null;
  let dragging = false;
  // A right-click inside a multi-cell selection, or on a merged cell's
  // top-left — shows the merge/unmerge panel.
  let rangeMenu = null; // { x, y }
  // The column being dragged by its header handle — { id, overId } — tracked
  // the same mousedown/mousemove/mouseup way as cell-range selection above,
  // not HTML5 drag-and-drop (see columnHeader's comment on why).
  let columnDrag = null;
  // Same idea, for a row dragged by its leading handle.
  let rowDrag = null;
  // The fill handle, dragged from the bottom-right corner of the current
  // selection — { source, overRowId }. Downward-only (see fillRange's doc):
  // it repeats the selected cell(s) into every visible row between the
  // selection and wherever the pointer is released.
  let fillDrag = null;

  // `link` cells store an object id; this map turns it into the object's
  // current title for display / copy / sort. Filled once on mount and after
  // any edit — a title that changes elsewhere refreshes on the next reopen,
  // which is enough for a reference column.
  let titleById = new Map();
  let titlesInFlight = false;
  const resolveTitle = (id) => titleById.get(id);
  /** Referenced object ids across every `link` column that we don't have a
   * title for yet. */
  function unresolvedLinkIds() {
    const ids = new Set();
    for (const column of store.table?.columns ?? []) {
      if (column.type !== "link") continue;
      for (const row of store.table.rows) {
        const id = row.cells[column.id];
        if (typeof id === "string" && id && !titleById.has(id)) ids.add(id);
      }
    }
    return ids;
  }
  async function refreshLinkTitles() {
    if (titlesInFlight || unresolvedLinkIds().size === 0) return;
    titlesInFlight = true;
    try {
      const objects = await context.data.objects.query({ limit: 5000 });
      titleById = new Map(objects.map((object) => [object.id, object.title || "Untitled"]));
    } catch { /* leave ids showing */ }
    finally { titlesInFlight = false; }
    render();
  }

  const root = element("div", { className: "ntbl" });
  root.append(element("style", { textContent: styles }));
  const shell = element("div", { className: "ntbl-shell" });
  root.append(shell);
  shell.addEventListener("mousedown", onGridMouseDown);
  shell.addEventListener("mouseover", onGridMouseOver);
  shell.addEventListener("contextmenu", (event) => {
    const td = event.target instanceof Element ? event.target.closest("td[data-row-id]") : null;
    if (!td) return;
    event.preventDefault();
    showRangeMenu(event.clientX, event.clientY, td.dataset.rowId, td.dataset.colId);
  });

  function setSort(next) { sort = next; render(); }
  function setFilter(columnId, value) { filters[columnId] = value; render(); }
  function showColumnMenu(columnId, x, y) { openMenu = { columnId, x, y }; render(); }
  function hideColumnMenu() { if (openMenu) { openMenu = null; render(); } }
  // Row/column id are the cell that was actually right-clicked, not the
  // (possibly bigger) selection — rangeMenu_ needs both: the selection for
  // merge/unmerge, this specific cell for insert/duplicate row/column.
  function showRangeMenu(x, y, rowId, colId) { rangeMenu = { x, y, rowId, colId }; render(); }
  function hideRangeMenu() { if (rangeMenu) { rangeMenu = null; render(); } }

  // Resolved against the RENDERED view (post-sort, post-filter) — the same
  // row order render() draws into <tbody> — not storage order. Merge
  // creation/lookup (mergeCells, rangeMenu_) deliberately still resolves
  // storage-order indices on its own; only this function's callers see the
  // view-order result.
  function getSelectionRange() { return resolveSelection(visibleRows(store.table, filters, sort), store.table.columns, selection); }

  // Selection is a pure highlight state — it never touches `table`, so it
  // must never rebuild the grid's DOM. A full render() here would tear down
  // and recreate every cell's <input>, including the one the mousedown that
  // started this very selection just focused — the exact "click a cell,
  // can't type into it" bug class. Toggling classes on the existing <td>s
  // (and refreshing only the format-bar overlay, which doesn't touch
  // cellInput nodes) keeps every input's DOM identity — and focus — intact.
  // The fill handle is position:fixed, so it does not move when the grid is
  // scrolled sideways or the page scrolls — re-read the anchor cell's rect
  // and reposition it on any scroll under `root` (capture: scroll doesn't
  // bubble) and on window scroll/resize.
  function repositionFillHandle() {
    if (selection) updateFillHandle(getSelectionRange());
  }
  root.addEventListener("scroll", repositionFillHandle, true);
  window.addEventListener("scroll", repositionFillHandle, true);
  window.addEventListener("resize", repositionFillHandle);

  function updateSelectionVisuals() {
    const range = getSelectionRange();
    for (const td of shell.querySelectorAll("td[data-row-id]")) {
      const rowId = td.dataset.rowId;
      const colId = td.dataset.colId;
      const inRange = Boolean(range && range.rowIds.includes(rowId) && range.columnIds.includes(colId));
      td.classList.toggle("is-selected", inRange);
      td.classList.toggle("is-sel-top", inRange && rowId === range.rowIds[0]);
      td.classList.toggle("is-sel-bottom", inRange && rowId === range.rowIds[range.rowIds.length - 1]);
      td.classList.toggle("is-sel-left", inRange && colId === range.columnIds[0]);
      td.classList.toggle("is-sel-right", inRange && colId === range.columnIds[range.columnIds.length - 1]);
    }
    // Header / row-handle highlight when the selection covers a full column
    // or a full row.
    const fullCol = Boolean(range && range.rowIds.length === visibleRows(store.table, filters, sort).length);
    const fullRow = Boolean(range && range.columnIds.length === store.table.columns.length);
    for (const th of shell.querySelectorAll("th[data-col-id]")) {
      th.classList.toggle("is-col-selected", fullCol && range.columnIds.includes(th.dataset.colId));
    }
    for (const tr of shell.querySelectorAll("tr[data-row-id]")) {
      tr.querySelector("td.ntbl-td-handle")?.classList.toggle("is-row-selected", fullRow && range.rowIds.includes(tr.dataset.rowId));
    }
    root.querySelector(".ntbl-format-bar-overlay")?.remove();
    if (range && (range.rowIds.length > 1 || range.columnIds.length > 1)) {
      const anchorTd = shell.querySelector(`td[data-row-id="${CSS.escape(range.rowIds[0])}"][data-col-id="${CSS.escape(range.columnIds[0])}"]`);
      if (anchorTd instanceof HTMLElement) {
        const rect = anchorTd.getBoundingClientRect();
        const overlay = element("div", { className: "ntbl-format-bar-overlay" });
        const bar = formattingToolbar(store, range);
        bar.style.left = `${Math.max(8, rect.left)}px`;
        bar.style.top = `${Math.max(8, rect.top - 44)}px`;
        overlay.append(bar);
        root.append(overlay);
      }
    }
    updateFillHandle(range);
  }
  // The small square at the bottom-right corner of the selection, dragged
  // to fill — lives on `root` like the other overlays above, rebuilt on
  // every selection change (cheap: one element, no grid touched).
  function updateFillHandle(range) {
    root.querySelector(".ntbl-fill-handle")?.remove();
    if (!range) return;
    const lastTd = shell.querySelector(`td[data-row-id="${CSS.escape(range.rowIds[range.rowIds.length - 1])}"][data-col-id="${CSS.escape(range.columnIds[range.columnIds.length - 1])}"]`);
    if (!(lastTd instanceof HTMLElement)) return;
    const rect = lastTd.getBoundingClientRect();
    const handle = element("div", { className: "ntbl-fill-handle" });
    handle.style.left = `${rect.right - 4}px`;
    handle.style.top = `${rect.bottom - 4}px`;
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      fillDrag = { source: range, overRowId: null };
    });
    root.append(handle);
  }
  function startSelection(rowId, colId, extend) {
    if (extend && selection) selection = { ...selection, focusRow: rowId, focusCol: colId };
    else selection = { anchorRow: rowId, anchorCol: colId, focusRow: rowId, focusCol: colId };
    updateSelectionVisuals();
  }
  function extendSelection(rowId, colId) {
    if (!selection) return;
    selection = { ...selection, focusRow: rowId, focusCol: colId };
    updateSelectionVisuals();
  }
  // Whole-column / whole-row selection: span every visible row (resp. every
  // column) and pin the other axis to the clicked id. `extend` (shift-click)
  // keeps the existing anchor on the pinned axis so a second click grows a
  // contiguous block of columns / rows.
  function selectColumn(colId, extend) {
    const visIds = visibleRows(store.table, filters, sort).map((row) => row.id);
    if (!visIds.length) return;
    const first = visIds[0];
    const last = visIds[visIds.length - 1];
    selection = extend && selection
      ? { ...selection, anchorRow: first, focusRow: last, focusCol: colId }
      : { anchorRow: first, anchorCol: colId, focusRow: last, focusCol: colId };
    updateSelectionVisuals();
  }
  function selectRow(rowId, extend) {
    const colIds = store.table.columns.map((column) => column.id);
    if (!colIds.length) return;
    const first = colIds[0];
    const last = colIds[colIds.length - 1];
    selection = extend && selection
      ? { ...selection, anchorCol: first, focusCol: last, focusRow: rowId }
      : { anchorRow: rowId, anchorCol: first, focusRow: rowId, focusCol: last };
    updateSelectionVisuals();
  }

  function onGridMouseDown(event) {
    if (event.button !== 0) return; // only a left-click starts/moves selection
    const td = event.target instanceof Element ? event.target.closest("td[data-row-id]") : null;
    if (!td) return;
    dragging = true;
    // Deferred: at mousedown time document.activeElement is still the
    // PREVIOUSLY focused control — the browser moves focus to the clicked
    // target as part of mousedown's own default action, which runs AFTER
    // this handler returns. Calling startSelection (and its render(), which
    // replaces the whole grid) synchronously would read the stale
    // activeElement, restore focus to the OLD cell, and detach the node the
    // pending native focus step was about to target — the project's known
    // "double click needed to edit a cell" bug class. Deferring lets the
    // browser finish focusing the newly-clicked cell first.
    const rowId = td.dataset.rowId;
    const colId = td.dataset.colId;
    const extend = event.shiftKey;
    queueMicrotask(() => startSelection(rowId, colId, extend));
  }
  function onGridMouseOver(event) {
    if (!dragging) return;
    const td = event.target instanceof Element ? event.target.closest("td[data-row-id]") : null;
    if (!td) return;
    extendSelection(td.dataset.rowId, td.dataset.colId);
  }
  function onDocumentMouseUp() { dragging = false; }
  document.addEventListener("mouseup", onDocumentMouseUp);

  function startColumnDrag(columnId) {
    columnDrag = { id: columnId, overId: null };
    const th = shell.querySelector(`th[data-col-id="${CSS.escape(columnId)}"]`);
    th?.classList.add("is-dragging");
  }
  // Pointer capture isn't used here (unlike the resize handle below) because
  // this needs to know which OTHER header the pointer is currently over —
  // capturing would route every move back to the handle instead.
  function onColumnDragMove(event) {
    if (!columnDrag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const overTh = target instanceof Element ? target.closest("th[data-col-id]") : null;
    for (const el of shell.querySelectorAll(".ntbl-th.is-drag-over")) el.classList.remove("is-drag-over");
    const overId = overTh && overTh.dataset.colId !== columnDrag.id ? overTh.dataset.colId : null;
    columnDrag.overId = overId;
    if (overId) overTh.classList.add("is-drag-over");
  }
  function onColumnDragEnd() {
    if (!columnDrag) return;
    const { id, overId } = columnDrag;
    columnDrag = null;
    for (const el of shell.querySelectorAll(".ntbl-th.is-dragging, .ntbl-th.is-drag-over")) el.classList.remove("is-dragging", "is-drag-over");
    if (overId) void store.apply(reorderColumn(store.table, id, overId));
  }
  document.addEventListener("mousemove", onColumnDragMove);
  document.addEventListener("mouseup", onColumnDragEnd);

  function startRowDrag(rowId) {
    rowDrag = { id: rowId, overId: null };
    const tr = shell.querySelector(`tr[data-row-id="${CSS.escape(rowId)}"]`);
    tr?.classList.add("is-dragging");
  }
  function onRowDragMove(event) {
    if (!rowDrag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const overTr = target instanceof Element ? target.closest("tr[data-row-id]") : null;
    for (const el of shell.querySelectorAll("tr.is-drag-over")) el.classList.remove("is-drag-over");
    const overId = overTr && overTr.dataset.rowId !== rowDrag.id ? overTr.dataset.rowId : null;
    rowDrag.overId = overId;
    if (overId) overTr.classList.add("is-drag-over");
  }
  function onRowDragEnd() {
    if (!rowDrag) return;
    const { id, overId } = rowDrag;
    rowDrag = null;
    for (const el of shell.querySelectorAll("tr.is-dragging, tr.is-drag-over")) el.classList.remove("is-dragging", "is-drag-over");
    if (overId) void store.apply(reorderRow(store.table, id, overId));
  }
  document.addEventListener("mousemove", onRowDragMove);
  document.addEventListener("mouseup", onRowDragEnd);

  // Downward-only, matching `fillRange`'s doc: the target is every VISIBLE
  // row strictly below the selection's last row, up to wherever the pointer
  // is when it releases.
  function computeFillTargetRows(source, overRowId) {
    const visIds = visibleRows(store.table, filters, sort).map((row) => row.id);
    const sourceEndIndex = visIds.indexOf(source.rowIds[source.rowIds.length - 1]);
    const overIndex = visIds.indexOf(overRowId);
    if (sourceEndIndex === -1 || overIndex === -1 || overIndex <= sourceEndIndex) return null;
    return { rowIds: visIds.slice(sourceEndIndex + 1, overIndex + 1), columnIds: source.columnIds };
  }
  function onFillDragMove(event) {
    if (!fillDrag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const td = target instanceof Element ? target.closest("td[data-row-id]") : null;
    for (const el of shell.querySelectorAll(".is-fill-preview")) el.classList.remove("is-fill-preview");
    fillDrag.overRowId = td?.dataset.rowId ?? null;
    if (!fillDrag.overRowId) return;
    const targetRows = computeFillTargetRows(fillDrag.source, fillDrag.overRowId);
    if (!targetRows) return;
    for (const rowId of targetRows.rowIds) {
      for (const colId of targetRows.columnIds) {
        shell.querySelector(`td[data-row-id="${CSS.escape(rowId)}"][data-col-id="${CSS.escape(colId)}"]`)?.classList.add("is-fill-preview");
      }
    }
  }
  function onFillDragEnd() {
    if (!fillDrag) return;
    const { source, overRowId } = fillDrag;
    fillDrag = null;
    for (const el of shell.querySelectorAll(".is-fill-preview")) el.classList.remove("is-fill-preview");
    const targetRows = overRowId ? computeFillTargetRows(source, overRowId) : null;
    if (targetRows) void store.apply(fillRange(store.table, source, targetRows));
  }
  document.addEventListener("mousemove", onFillDragMove);
  document.addEventListener("mouseup", onFillDragEnd);

  // A right-click panel closes like any other popover: a click outside it,
  // or Escape. Both listen on the document because the panel is positioned
  // fixed, outside the scroll container it was opened from.
  function onDocumentPointerDown(event) {
    const target = event.target;
    if (openMenu && !(target instanceof Element && target.closest(".ntbl-colmenu, .ntbl-th-menu"))) hideColumnMenu();
    if (rangeMenu && !(target instanceof Element && target.closest(".ntbl-rangemenu"))) hideRangeMenu();
  }
  // Ctrl/Cmd+C and Delete/Backspace are only intercepted for a MULTI-cell
  // range. A single selected cell is also how "click to edit" looks (see
  // startSelection) — leaving that case alone means normal text editing
  // (typing, native copy of a text selection inside one input, Backspace
  // while typing) keeps working exactly as it did in 0.2.0, untouched by any
  // of this. Paste is handled separately, in onGridPaste below — it needs to
  // fire even for a single selected cell (that is the common case when
  // pasting a whole column from Excel), which this multi-cell-only guard
  // would otherwise block.
  function onDocumentKeyDown(event) {
    if (event.key === "Escape") { hideColumnMenu(); hideRangeMenu(); return; }

    // Tab/Enter move the active cell — Excel's own bindings for "confirm
    // and move on" — and work for a single selected cell (unlike Ctrl+C/
    // Delete below), since a single cell IS the common case while filling
    // in a table one field at a time. Only intercepted while focus is
    // actually inside one of this grid's own controls, so Tab/Enter
    // anywhere else in the app keeps its normal meaning.
    if (event.key === "Tab" || event.key === "Enter") {
      const focused = document.activeElement;
      const isGridControl = focused instanceof Element && shell.contains(focused) && ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName);
      if (!isGridControl) return;
      const range = getSelectionRange();
      if (!range) return;
      const visibleIds = visibleRows(store.table, filters, sort).map((row) => row.id);
      const columnIds = store.table.columns.map((column) => column.id);
      let rowIndex = visibleIds.indexOf(range.rowIds[range.rowIds.length - 1]);
      let colIndex = columnIds.indexOf(range.columnIds[range.columnIds.length - 1]);
      if (rowIndex === -1 || colIndex === -1) return;
      if (event.key === "Enter") rowIndex += event.shiftKey ? -1 : 1;
      else colIndex += event.shiftKey ? -1 : 1;
      if (rowIndex < 0 || rowIndex >= visibleIds.length || colIndex < 0 || colIndex >= columnIds.length) return;
      event.preventDefault();
      const nextRowId = visibleIds[rowIndex];
      const nextColId = columnIds[colIndex];
      startSelection(nextRowId, nextColId, false);
      const nextTd = shell.querySelector(`td[data-row-id="${CSS.escape(nextRowId)}"][data-col-id="${CSS.escape(nextColId)}"]`);
      const control = nextTd?.querySelector("input, textarea, select");
      if (control instanceof HTMLElement) control.focus();
      return;
    }

    const range = getSelectionRange();
    if (!range || (range.rowIds.length === 1 && range.columnIds.length === 1)) return;
    // "a cell is genuinely mid-edit" — only bail to the browser's native
    // Ctrl+C/Delete/Backspace when the focused cell control actually holds a
    // non-collapsed text selection (the user picked a fragment inside one
    // cell). Plain focus is not enough: every cell IS an <input>, so focus
    // sits in one right after a drag-select — the previous check made
    // multi-cell copy silently fall through to copying a single cell.
    // ponytail: selectionStart is null on <input type=number>/checkbox, so
    // those never match here and the range op runs, which is what we want.
    const active = document.activeElement;
    const editingText = active instanceof HTMLElement && shell.contains(active)
      && ["INPUT", "TEXTAREA"].includes(active.tagName)
      && typeof active.selectionStart === "number"
      && active.selectionStart !== active.selectionEnd;
    if (editingText) return;
    const meta = event.ctrlKey || event.metaKey;
    if (meta && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void navigator.clipboard.writeText(cellsToTsv(resolveFormulas(store.table), range, resolveTitle)).catch(() => {
        context.ui.notice("Could not copy: the clipboard is unavailable.");
      });
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      void store.apply(clearRangeCells(store.table, range));
    }
  }
  document.addEventListener("mousedown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeyDown);

  // The native `paste` event, not a Ctrl+V keydown + navigator.clipboard
  // read: this needs to decide SYNCHRONOUSLY, before the browser's own
  // paste lands, whether to take over — an async clipboard read can only
  // preventDefault too late, after the browser has already pasted natively.
  // `event.clipboardData` gives that synchronous read.
  //
  // A single selected cell is the common case for pasting a whole Excel
  // column (one cell clicked, not a range dragged first), so this fires for
  // single cells too — restricted to clipboard content that actually looks
  // like a grid (more than one line, or tab-separated), so pasting a short
  // one-line snippet mid-edit inside a text cell still lands at the caret
  // via the browser's own paste instead of overwriting the whole cell.
  function onGridPaste(event) {
    const range = getSelectionRange();
    if (!range) return;
    const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
    if (!clipboardText) return;
    const isMultiCell = range.rowIds.length > 1 || range.columnIds.length > 1;
    const looksLikeGrid = /\r\n|\n|\t/.test(clipboardText.replace(/\r?\n$/, ""));
    if (!isMultiCell && !looksLikeGrid) return;
    event.preventDefault();
    void store.apply(applyTsvPaste(store.table, range, clipboardText, sort, filters));
  }
  shell.addEventListener("paste", onGridPaste);

  function render() {
    // Filtering as you type calls this on every keystroke — see the
    // `dataset.focusKey` comment on the filter input above. Save which
    // control had focus (and where its caret was) before the rebuild
    // destroys it, then hand both back once the new one exists.
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLElement && shell.contains(focused) ? focused.dataset.focusKey : undefined;
    const caretRange = focusKey && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;

    shell.replaceChildren();
    if (store.loading) { shell.append(text("p", "Loading…", "ntbl-empty")); return; }
    if (store.error) { shell.append(text("p", store.error, "ntbl-empty")); return; }

    const raw = store.table;
    // Everything below display/export/sums/sort works from the resolved
    // view — formula cells replaced by their computed value. The cell
    // EDITOR still needs the "=" source, so it is handed the raw row too.
    const table = resolveFormulas(raw);
    const rawById = new Map(raw.rows.map((row) => [row.id, row]));

    if (table.columns.length === 0) {
      shell.append(text("p", "No columns yet.", "ntbl-empty"));
    } else {
      const scroll = element("div", { className: "ntbl-scroll" });
      const tableEl = element("table", { className: "ntbl-table" });
      const thead = element("thead");
      const headRow = element("tr");
      headRow.append(element("th", { className: "ntbl-th ntbl-th-spacer" })); // aligns with each row's leading drag-handle cell
      for (const column of table.columns) headRow.append(columnHeader(store, column, sort, setSort, filters, setFilter, showColumnMenu, startColumnDrag, selectColumn));
      headRow.append(element("th", { className: "ntbl-th ntbl-th-spacer" }));
      thead.append(headRow);
      tableEl.append(thead);

      const tbody = element("tbody");
      const rows = visibleRows(table, filters, sort);
      const range = getSelectionRange();
      const merges = table.merges ?? [];
      const coveredCells = new Set();
      for (const m of merges) {
        for (let r = m.startRowIndex; r < m.startRowIndex + m.rowSpan; r++) {
          for (let c = m.startColIndex; c < m.startColIndex + m.colSpan; c++) {
            if (r === m.startRowIndex && c === m.startColIndex) continue;
            coveredCells.add(`${r}:${c}`);
          }
        }
      }
      for (const [rowIndex, row] of rows.entries()) {
        const tr = element("tr");
        tr.dataset.rowId = row.id;
        const handleCell = element("td", { className: "ntbl-td ntbl-td-handle" });
        // Click the handle cell to select the whole row; shift-click to span
        // a block of rows. A real drag ends in a store.apply/render that
        // replaces this node, so a trailing click here is inert.
        handleCell.addEventListener("click", (event) => selectRow(row.id, event.shiftKey));
        const rowDragHandle = element("button", { type: "button", className: "ntbl-row-drag", title: "Drag to move this row", textContent: "⠿" });
        rowDragHandle.addEventListener("mousedown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          if (sort) { context.ui.notice("Clear the active sort first to reorder rows."); return; }
          startRowDrag(row.id);
        });
        handleCell.append(rowDragHandle);
        tr.append(handleCell);
        for (const [colIndex, column] of table.columns.entries()) {
          if (coveredCells.has(`${rowIndex}:${colIndex}`)) continue;
          const style = (table.styles ?? {})[`${row.id}:${column.id}`];
          const inRange = range && range.rowIds.includes(row.id) && range.columnIds.includes(column.id);
          const classes = ["ntbl-td"];
          if (style?.bold) classes.push("is-bold");
          if (inRange) {
            classes.push("is-selected");
            if (row.id === range.rowIds[0]) classes.push("is-sel-top");
            if (row.id === range.rowIds[range.rowIds.length - 1]) classes.push("is-sel-bottom");
            if (column.id === range.columnIds[0]) classes.push("is-sel-left");
            if (column.id === range.columnIds[range.columnIds.length - 1]) classes.push("is-sel-right");
          }
          const td = element("td", { className: classes.join(" ") });
          td.dataset.rowId = row.id;
          td.dataset.colId = column.id;
          if (style?.color) td.dataset.color = style.color;
          const covering = merges.find((m) => m.startRowIndex === rowIndex && m.startColIndex === colIndex);
          if (covering) { td.rowSpan = covering.rowSpan; td.colSpan = covering.colSpan; }
          td.append(cellInput(store, row, column, resolveTitle, rawById.get(row.id)));
          tr.append(td);
        }
        const removeCell = element("td", { className: "ntbl-td ntbl-td-remove" });
        const removeButton = element("button", { type: "button", className: "ntbl-row-remove", title: "Remove row", textContent: "×" });
        removeButton.addEventListener("click", () => void store.apply(removeRow(store.table, row.id)));
        removeCell.append(removeButton);
        tr.append(removeCell);
        tbody.append(tr);
      }
      tableEl.append(tbody);

      // A totals footer, only when there is at least one number column to
      // total — an all-text table has nothing to sum and would just show a
      // row of dashes. Sums use the currently VISIBLE rows, same as the
      // "Showing X of Y" hint below: a totals row that silently included
      // filtered-out rows would disagree with what is on screen.
      if (table.columns.some((column) => column.type === "number")) {
        const sums = columnSums(rows, table.columns);
        const tfoot = element("tfoot");
        const footRow = element("tr", { className: "ntbl-foot" });
        footRow.append(element("td", { className: "ntbl-td" }));
        for (const column of table.columns) {
          const cell = element("td", { className: "ntbl-td ntbl-foot-cell" });
          if (column.type === "number") cell.textContent = column.format ? formatNumber(sums[column.id] ?? 0, column.format) : String(sums[column.id] ?? 0);
          footRow.append(cell);
        }
        footRow.append(element("td", { className: "ntbl-td" }));
        tfoot.append(footRow);
        tableEl.append(tfoot);
      }

      scroll.append(tableEl);
      shell.append(scroll);

      if (rows.length !== table.rows.length) {
        shell.append(text("p", `Showing ${rows.length} of ${table.rows.length} rows.`, "ntbl-hint"));
      }
    }

    const actions = element("div", { className: "ntbl-actions" });
    const addRowButton = element("button", { type: "button", className: "ntbl-button", textContent: "+ Row" });
    addRowButton.disabled = table.columns.length === 0;
    addRowButton.addEventListener("click", () => void store.apply(addRow(store.table)));
    const addColumnButton = element("button", { type: "button", className: "ntbl-button", textContent: "+ Column" });
    addColumnButton.addEventListener("click", () => void store.apply(addColumn(store.table, {})));
    // Same Blob + <a download> pattern plugins/builtin/domain-plugin-ui.tsx
    // and CoreOnlyApp.tsx already use for Markdown export — no Tauri
    // save-dialog call needed, no new permission.
    const exportButton = element("button", { type: "button", className: "ntbl-button", textContent: "Export CSV" });
    exportButton.disabled = table.columns.length === 0;
    exportButton.addEventListener("click", () => {
      const blob = new Blob([toCsv(table, resolveTitle)], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(table.name || "table").replace(/[\\/:*?"<>|]/g, "_")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      context.ui.notice(`Downloaded "${link.download}".`);
    });
    const lockButton = element("button", {
      type: "button",
      className: table.lockWidths ? "ntbl-button ntbl-button--on" : "ntbl-button",
      textContent: table.lockWidths ? "🔒 Widths locked" : "Lock widths",
      title: table.lockWidths ? "Column widths are locked — click to allow resizing again." : "Freeze every column width and hide the resize handles.",
    });
    lockButton.disabled = table.columns.length === 0;
    lockButton.addEventListener("click", () => void store.apply({ ...store.table, lockWidths: !store.table.lockWidths }));
    actions.append(addRowButton, addColumnButton, lockButton, exportButton);
    shell.append(actions);

    if (focusKey) {
      const next = shell.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
      if (next instanceof HTMLElement) {
        next.focus();
        if (caretRange && "setSelectionRange" in next) {
          try { next.setSelectionRange(caretRange[0], caretRange[1]); } catch { /* not every input type supports it (e.g. type=number) */ }
        }
      }
    }

    // The popup lives on `root`, not `shell`, so it survives the
    // `shell.replaceChildren()` above — it is removed and rebuilt here
    // instead, every render, same as the rest of the grid.
    root.querySelector(".ntbl-colmenu-overlay")?.remove();
    const menuColumn = openMenu && table.columns.find((column) => column.id === openMenu.columnId);
    if (openMenu && !menuColumn) openMenu = null;
    if (menuColumn) {
      const overlay = element("div", { className: "ntbl-colmenu-overlay" });
      const panel = columnMenu(store, menuColumn, sort, setSort, filters, setFilter);
      // Clamped so a column near the right or bottom edge does not open a
      // panel partly off-screen.
      const left = Math.min(openMenu.x, window.innerWidth - 240);
      const top = Math.min(openMenu.y, window.innerHeight - 220);
      panel.style.left = `${Math.max(8, left)}px`;
      panel.style.top = `${Math.max(8, top)}px`;
      overlay.append(panel);
      root.append(overlay);
    }

    // Same "lives on root, rebuilt every render" mechanics as the column
    // menu overlay above — this one is keyed off the selection instead of
    // openMenu, and only appears for a range bigger than one cell.
    root.querySelector(".ntbl-format-bar-overlay")?.remove();
    const formatRange = getSelectionRange();
    if (formatRange && (formatRange.rowIds.length > 1 || formatRange.columnIds.length > 1)) {
      const anchorTd = shell.querySelector(`td[data-row-id="${CSS.escape(formatRange.rowIds[0])}"][data-col-id="${CSS.escape(formatRange.columnIds[0])}"]`);
      if (anchorTd instanceof HTMLElement) {
        const rect = anchorTd.getBoundingClientRect();
        const overlay = element("div", { className: "ntbl-format-bar-overlay" });
        const bar = formattingToolbar(store, formatRange);
        bar.style.left = `${Math.max(8, rect.left)}px`;
        bar.style.top = `${Math.max(8, rect.top - 44)}px`;
        overlay.append(bar);
        root.append(overlay);
      }
    }
    updateFillHandle(formatRange);

    root.querySelector(".ntbl-rangemenu-overlay")?.remove();
    if (rangeMenu) {
      const rowStillExists = table.rows.some((row) => row.id === rangeMenu.rowId);
      const colStillExists = table.columns.some((column) => column.id === rangeMenu.colId);
      if (!rowStillExists || !colStillExists) {
        rangeMenu = null;
      } else {
        const selRange = getSelectionRange();
        // The menu's row/column actions always target the actually
        // right-clicked cell; merge/unmerge only cares about the current
        // selection, or falls back to that single cell when there is none
        // (e.g. right-clicking straight onto a merged cell with no drag).
        const range = selRange && selRange.rowIds.includes(rangeMenu.rowId) && selRange.columnIds.includes(rangeMenu.colId)
          ? selRange
          : { rowIds: [rangeMenu.rowId], columnIds: [rangeMenu.colId] };
        const overlay = element("div", { className: "ntbl-rangemenu-overlay" });
        const panel = rangeMenu_(store, range, sort, filters, rangeMenu.rowId, rangeMenu.colId, hideRangeMenu);
        panel.style.left = `${Math.max(8, Math.min(rangeMenu.x, window.innerWidth - 200))}px`;
        panel.style.top = `${Math.max(8, Math.min(rangeMenu.y, window.innerHeight - 100))}px`;
        overlay.append(panel);
        root.append(overlay);
      }
    }
  }

  const stop = store.onChange(() => { render(); void refreshLinkTitles(); });
  void store.load();
  container.append(root);
  return {
    dispose: () => {
      stop();
      document.removeEventListener("mousedown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
      document.removeEventListener("mouseup", onDocumentMouseUp);
      document.removeEventListener("mousemove", onColumnDragMove);
      document.removeEventListener("mouseup", onColumnDragEnd);
      document.removeEventListener("mousemove", onRowDragMove);
      document.removeEventListener("mouseup", onRowDragEnd);
      document.removeEventListener("mousemove", onFillDragMove);
      document.removeEventListener("mouseup", onFillDragEnd);
      root.removeEventListener("scroll", repositionFillHandle, true);
      window.removeEventListener("scroll", repositionFillHandle, true);
      window.removeEventListener("resize", repositionFillHandle);
      root.remove();
    },
  };
}

// ------------------------------------------------------------------ CSS
//
// Public token contract (--notible-*) only, no colour literals, so
// `scripts/plugin-css-token-check.mjs` passes and the grid follows the
// user's theme. Same house rules as every other builtin-shaped surface: an
// outline instead of a fill, no card inside a card.
const styles = `
.ntbl { color: var(--notible-text); font-size: 13px; min-width: 0; }
/* minmax(0,1fr) keeps the shell (lead text, summary, actions) at the
   container's width; the wide table below overflows it and Core's own
   .core-container-slot — the one scroll box, height-bounded to the viewport —
   does the scrolling on BOTH axes. */
.ntbl-shell { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-content: start; }
.ntbl-empty, .ntbl-hint { margin: 0; color: var(--notible-muted); font-size: 12px; }
/* A real grid, not a hairline table: this is a spreadsheet-style tool
   with sortable/filterable/mergeable columns, so it reads better as an
   actual grid than the restraint a note's inline Markdown table uses.
   Every cell gets a full border; header cells get the stronger one. */
/* NOT a scroll container. It used to be overflow-x:auto, which trapped the
   horizontal overflow in a box as tall as the whole table — so its scrollbar
   sat past the end of a long table and you had to scroll to the bottom to
   reach it. Adding overflow-y on top just stacked a second vertical scrollbar
   inside Core's. Let the table overflow straight through to
   .core-container-slot instead; the sticky header then sticks to that box. */
.ntbl-scroll { min-width: 0; }
/* table-layout: fixed makes column width follow the th width, not the
   width the browser's auto algorithm thinks a column's content needs —
   under the default auto layout, an explicit width/min-width on a th is
   only ever a hint the algorithm can still widen a column past, never
   something it lets a column shrink below its content's natural size. That
   was the resize handle's actual bug: growing a column worked, narrowing it
   below its starting content-driven width silently did nothing.

   width:max-content (not 100%) so widening one column grows the TABLE and
   the .ntbl-scroll wrapper scrolls, instead of the fixed layout stealing
   that width back from its neighbours. No min-width:100% — that forced the
   table wide and brought the redistribution straight back. Every column
   without an explicit width falls back to the .ntbl-th 140px. */
.ntbl-table { border-collapse: collapse; width: max-content; table-layout: fixed; }
/* Sticky header (top) and leading handle column (left) — position:sticky
   still lets an absolutely-positioned child (the resize handle) anchor to
   this cell, so it does not conflict with the old position:relative. */
.ntbl-th { position: sticky; top: 0; z-index: 2; vertical-align: top; padding: 6px 8px 8px; border: 1px solid var(--notible-border); width: 140px; overflow: hidden; background: var(--notible-surface); }
.ntbl-th.is-drag-over { border-left: 2px solid var(--notible-accent); }
.ntbl-th.is-dragging { opacity: .5; }
.ntbl-th.is-col-selected { background: var(--notible-hover); }
.ntbl-th-name { cursor: pointer; }
.ntbl-th-spacer { min-width: 0; width: 28px; }
.ntbl-th-spacer:first-child { left: 0; z-index: 3; }
.ntbl-th-name { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.ntbl-th-input { flex: 1; min-width: 0; border: 0; background: none; padding: 2px; color: var(--notible-text); font: inherit; font-weight: 700; }
.ntbl-th-badge { flex: none; color: var(--notible-accent); font-size: 11px; }
.ntbl-th-drag, .ntbl-th-menu, .ntbl-th-remove { flex: none; border: 0; background: none; padding: 2px 4px; color: var(--notible-muted); cursor: pointer; font-size: 12px; }
.ntbl-th-drag { cursor: grab; }
.ntbl-th-drag:hover, .ntbl-th-menu:hover, .ntbl-th-remove:hover { color: var(--notible-text); }
/* A thin strip on the trailing edge, dragged to resize the column — wide
   enough to grab without a pixel-perfect click, invisible until hovered so
   it does not read as a stray vertical line across every header. */
.ntbl-th-resize { position: absolute; top: 0; right: -3px; bottom: 0; width: 6px; cursor: col-resize; touch-action: none; z-index: 1; }
.ntbl-th-resize:hover, .ntbl-th-resize:active { background: var(--notible-accent); }
.ntbl-th-type, .ntbl-th-filter, .ntbl-th-options { width: 100%; box-sizing: border-box; border: 1px solid var(--notible-border); border-radius: 6px; background: var(--notible-surface); padding: 4px 6px; color: var(--notible-text); font: inherit; font-size: 12px; }
.ntbl-colmenu-row .ntbl-th-type { width: auto; flex: 1; }
.ntbl-th-decimals { width: 48px; box-sizing: border-box; border: 1px solid var(--notible-border); border-radius: 6px; background: var(--notible-surface); padding: 4px 6px; color: var(--notible-text); font: inherit; font-size: 12px; }
.ntbl-th-symbol { width: 56px; box-sizing: border-box; border: 1px solid var(--notible-border); border-radius: 6px; background: var(--notible-surface); padding: 4px 6px; color: var(--notible-text); font: inherit; font-size: 12px; }
.ntbl-cell-formula:not(:focus) { color: var(--notible-muted); }
.ntbl-link-cell { display: flex; align-items: center; gap: 2px; }
.ntbl-cell-link { flex: 1; min-width: 0; }
.ntbl-link-open { flex: none; border: 0; background: none; color: var(--notible-accent); cursor: pointer; font-size: 12px; padding: 2px 4px; }
.ntbl-link-open:disabled { color: var(--notible-faint); cursor: default; }
/* The right-click column panel: fixed so it floats above the scrollable
   grid regardless of where the column that opened it is scrolled to. */
.ntbl-colmenu { position: fixed; z-index: 30; display: grid; gap: 8px; width: 224px; border: 1px solid var(--notible-border); border-radius: 9px; background: var(--notible-surface); padding: 10px; box-shadow: 0 14px 34px rgb(0 0 0 / 18%); }
.ntbl-colmenu-row { display: grid; gap: 4px; }
.ntbl-colmenu-label { color: var(--notible-muted); font-size: 11px; letter-spacing: .03em; text-transform: uppercase; }
.ntbl-colmenu-sort { display: flex; gap: 4px; }
.ntbl-colmenu-btn { border: 1px solid var(--notible-border); border-radius: 6px; background: none; padding: 4px 10px; color: var(--notible-muted); font: inherit; font-size: 12px; cursor: pointer; }
.ntbl-colmenu-btn:hover { color: var(--notible-text); }
.ntbl-colmenu-btn.is-active { border-color: var(--notible-accent); color: var(--notible-accent); }
.ntbl-td { padding: 0; border: 1px solid var(--notible-border-subtle); }
.ntbl-td.is-bold input, .ntbl-td.is-bold textarea, .ntbl-td.is-bold select { font-weight: 700; }
.ntbl-td[data-color="yellow"] { background: var(--notible-highlight-yellow); }
.ntbl-td[data-color="green"] { background: var(--notible-highlight-green); }
.ntbl-td[data-color="blue"] { background: var(--notible-highlight-blue); }
.ntbl-td[data-color="pink"] { background: var(--notible-highlight-pink); }
.ntbl-td[data-color="purple"] { background: var(--notible-highlight-purple); }
.ntbl-td[data-color="orange"] { background: var(--notible-highlight-orange); }
/* A ring around the outside of the range, not a border on every cell in
   it — four directional classes, one accent-colored border each, so
   interior cell-to-cell borders stay the plain grid lines. */
.ntbl-td.is-selected { background: var(--notible-selected-soft); }
.ntbl-td.is-sel-top { border-top: 2px solid var(--notible-accent); }
.ntbl-td.is-sel-bottom { border-bottom: 2px solid var(--notible-accent); }
.ntbl-td.is-sel-left { border-left: 2px solid var(--notible-accent); }
.ntbl-td.is-sel-right { border-right: 2px solid var(--notible-accent); }
/* The host's global input reset in core-only.css outweighs a bare
   .ntbl-cell-input, so every cell's input was getting a 36px-tall bordered
   rounded box on --core-raised — a card stacked on top of each grid cell, in
   a colour that isn't ours. These compound selectors (0,3,0) beat that reset
   and hand the cell back to its own .ntbl-td border, which collapse-borders
   into plain grid lines. The :not() is only there for the specificity bump. */
.ntbl-td .ntbl-cell-input:not([type="checkbox"]),
.ntbl-td .ntbl-cell-textarea:not([hidden]),
.ntbl-th .ntbl-th-input:not([type="checkbox"]) {
  min-height: 0;
  min-block-size: 0;
  border: 0;
  border-radius: 0;
  background: none;
}
.ntbl-cell-input { width: 100%; box-sizing: border-box; border: 0; background: none; padding: 6px 8px; color: var(--notible-text); font: inherit; }
.ntbl-cell-input:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: -2px; }
.ntbl-cell-textarea { width: 100%; box-sizing: border-box; resize: vertical; border: 0; background: none; padding: 6px 8px; color: var(--notible-text); font: inherit; }
.ntbl-cell-textarea:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: -2px; }
.ntbl-colmenu-row--inline { display: flex; }
.ntbl-colmenu-checkbox { display: flex; align-items: center; gap: 6px; color: var(--notible-text); font-size: 12px; cursor: pointer; }
.ntbl-format-bar { position: fixed; z-index: 31; display: flex; align-items: center; gap: 4px; border: 1px solid var(--notible-border); border-radius: 9px; background: var(--notible-surface); padding: 6px; box-shadow: 0 14px 34px rgb(0 0 0 / 18%); }
.ntbl-format-btn { border: 1px solid var(--notible-border); border-radius: 6px; background: none; padding: 4px 10px; color: var(--notible-text); font: inherit; font-size: 12px; cursor: pointer; }
.ntbl-format-btn:hover { border-color: var(--notible-accent); }
.ntbl-format-swatch { width: 20px; height: 20px; border: 1px solid var(--notible-border); border-radius: 5px; cursor: pointer; }
.ntbl-format-swatch[data-color="yellow"] { background: var(--notible-highlight-yellow); }
.ntbl-format-swatch[data-color="green"] { background: var(--notible-highlight-green); }
.ntbl-format-swatch[data-color="blue"] { background: var(--notible-highlight-blue); }
.ntbl-format-swatch[data-color="pink"] { background: var(--notible-highlight-pink); }
.ntbl-format-swatch[data-color="purple"] { background: var(--notible-highlight-purple); }
.ntbl-format-swatch[data-color="orange"] { background: var(--notible-highlight-orange); }
.ntbl-rangemenu { position: fixed; z-index: 31; display: grid; min-width: 160px; padding: 5px; border: 1px solid var(--notible-border); border-radius: 9px; background: var(--notible-surface); box-shadow: 0 14px 34px rgb(0 0 0 / 18%); }
.ntbl-rangemenu-btn { display: block; width: 100%; border: 0; border-radius: 6px; padding: 8px 9px; background: none; color: var(--notible-text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.ntbl-rangemenu-btn:hover:not(:disabled) { background: var(--notible-hover); }
.ntbl-rangemenu-btn:disabled { color: var(--notible-faint); cursor: not-allowed; }
.ntbl-rangemenu-btn--danger { color: var(--notible-danger); }
.ntbl-rangemenu-btn--danger:hover:not(:disabled) { background: var(--notible-danger-surface); }
.ntbl-format-swatch--none { background: var(--notible-surface); }
.ntbl-check { margin: 0 8px; accent-color: var(--notible-accent); }
.ntbl-td-remove { text-align: center; }
.ntbl-row-remove { border: 0; background: none; padding: 4px 8px; color: var(--notible-faint); cursor: pointer; }
.ntbl-row-remove:hover { color: var(--notible-danger); }
/* The leading per-row handle cell, sticky on the left the same way the
   header is sticky on top — a long row stays identifiable by its drag grip
   even when scrolled sideways past its own first data column. */
.ntbl-td-handle { position: sticky; left: 0; z-index: 1; width: 28px; text-align: center; background: var(--notible-surface); cursor: pointer; }
.ntbl-td-handle.is-row-selected { background: var(--notible-hover); }
.ntbl-row-drag { border: 0; background: none; padding: 4px; color: var(--notible-faint); cursor: grab; font-size: 12px; }
.ntbl-row-drag:hover { color: var(--notible-text); }
tr.is-dragging { opacity: .5; }
tr.is-drag-over > td { border-top: 2px solid var(--notible-accent); }
/* The drag-to-fill handle at the selection's bottom-right corner, and the
   dashed preview it paints over cells it would fill on release. */
.ntbl-fill-handle { position: fixed; z-index: 32; width: 8px; height: 8px; background: var(--notible-accent); border: 1px solid var(--notible-surface); border-radius: 1px; cursor: crosshair; }
.ntbl-td.is-fill-preview { outline: 1px dashed var(--notible-accent); outline-offset: -1px; }
.ntbl-rangemenu-sep { height: 1px; margin: 4px 2px; background: var(--notible-border); }
.ntbl-foot-cell { padding: 6px 8px; text-align: right; color: var(--notible-text); font-weight: 600; }
.ntbl-actions { display: flex; gap: 8px; }
.ntbl-button { align-self: flex-start; border: 1px solid var(--notible-border); border-radius: 7px; background: none; padding: 6px 12px; color: var(--notible-muted); font: inherit; font-size: 12px; cursor: pointer; }
.ntbl-button:hover:not(:disabled) { border-color: var(--notible-accent); color: var(--notible-text); }
.ntbl-button:disabled { opacity: .5; cursor: default; }
.ntbl-button--on { border-color: var(--notible-accent); color: var(--notible-text); background: var(--notible-hover); }
`;

export default {
  manifest: {
    id: "notible.tables",
    name: "Notible Tables",
    version: "0.6.1",
    apiVersion: "1.8",
    description: "A lightweight spreadsheet-style table, kept as an ordinary workspace object. New tables start as a 3x3 grid. Select a range to copy/paste/delete or bulk bold/color it, merge cells for headers or section labels, export to CSV, and wrap long text in a column. Right-click a column header for sort, format and filter. Create one from the \"+\" menu and link it into any note with [[Table name]]; opening the link opens the full grid.",
    author: "Notible",
    permissions: ["data.read", "data.write", "workspace.ui"],
  },

  onload(context) {
    this._disposables = [];

    // A blank icon/name is better than "unknown type"; failing this must not
    // take the plugin down with it — tables still work untyped.
    void context.data.types.upsert(TABLE_TYPE, JSON.stringify({ fields: [] }), "table").catch(() => {});

    // Puts "Data table" in the "+" menu beside "New note"/"New task" — Core
    // reads `creates` off any active plugin's commands, so this needed no
    // Core change at all (unlike the object-tab registration below). Any
    // `creates` command is ALSO offered from the in-note "/" menu (Core's
    // own convention, shared with New task/New project/Whiteboard) — and
    // Core's own built-in "/table" already means something completely
    // different: `coreCommands.ts`'s `{ id: "table", name: "Table" }` inserts
    // an inline Markdown table at the caret. Naming this "Table" too would
    // put two identically-labelled "/table" entries in the same menu, one of
    // which silently creates an unrelated object elsewhere instead of
    // inserting anything — "Data table" keeps it findable without reading as
    // the same command.
    this._disposables.push(context.commands.register({
      id: "new-table",
      name: "New data table",
      description: "Create a table you can fill with typed columns and link into any note. Not the same as the \"/table\" Markdown table — this is its own object.",
      // No self-navigation here, on purpose: a `creates` command's caller
      // decides what happens with the object it hands back — Core's own "+"
      // menu (`addPluginObject`) already opens it, and doing so again here
      // would double-navigate. See work-models.ts/whiteboard.ts for the same
      // convention.
      creates: { objectType: TABLE_TYPE, label: "Data table", icon: "table" },
      execute: async () => context.data.objects.create({
        type: TABLE_TYPE,
        title: "New table",
        props: serializeTable(blankTable(parseTable({ props: "{}" }))),
      }),
    }));

    // The grid itself: mounted whenever a table object is opened, by row
    // click or by a [[wikilink]] to it. `"table"` is in Core's
    // `OBJECT_TAB_TYPES` allowlist for this purpose.
    this._disposables.push(context.views.registerObjectTab({
      id: "grid",
      label: "Table",
      objectTypes: [TABLE_TYPE],
      mount: (container, tabContext) => mountGrid(context, container, tabContext.objectId),
    }));
  },

  onunload() {
    for (const disposable of this._disposables ?? []) disposable.dispose?.();
    this._disposables = [];
  },
};
