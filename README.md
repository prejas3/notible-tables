# Notible Tables

A lightweight spreadsheet-style table, kept as an ordinary workspace object.

- Create one from the **+** menu ("Data table"), or via the "New data table"
  command. Named "Data table" rather than "Table" on purpose — Core's own
  `/table` slash command inserts an inline Markdown table, a different thing,
  and the two would be indistinguishable in the "/" menu under the same name.
  A new table starts as a 3×3 grid, not an empty state.
- Add typed columns: text, number, date, checkbox, select.
- Right-click a column header (or its "⋯" button) for sort, format (column
  type, and options for a select column) and filter — a small badge on the
  header name shows when a column is sorted or filtered. Type into the
  filter box to narrow rows; a checkbox column filters by "Any / Checked /
  Unchecked".
- Link a table into any note with `[[Table name]]` — clicking the link opens
  the full grid, the same way clicking it in the sidebar does.
- Select a range by clicking and dragging, or Shift-click to extend it.
  `Ctrl`/`Cmd`+`C` copies it as tab-separated text; `Ctrl`/`Cmd`+`V` pastes a
  tab-separated block starting at the selection (clamped to the table's
  existing rows/columns — it never grows the table); `Delete`/`Backspace`
  clears every cell in the range.
- A range bigger than one cell gets a floating toolbar for bulk **bold** and
  **cell color** (the same six colors as the note editor's highlighter),
  plus a way to clear formatting.
- Right-click a multi-cell range (or a merged cell) for **Merge cells** /
  **Unmerge** — for a wide header spanning columns or a section label
  spanning rows. Unavailable while a sort or filter is active.
- **Export CSV** in the actions row exports the whole table, ignoring the
  active filter. Cell colors and merges are not representable in CSV and
  are not included.
- A text column can turn on **Wrap text** (in its right-click menu) so long
  values wrap onto multiple lines instead of scrolling.

## What it is not (yet)

The table does not render live inside a note's text — only as a link that
opens the full editor. Rendering a table inline in the note body would need
Core's Markdown editor to support a new live block type, which is a larger
change kept out of this first version on purpose.

Rich text *inside* a cell (bolding one word in a sentence), a true `.xlsx`
export, and arbitrary Excel-style merge anywhere are all intentionally out
of scope — see the design doc's Non-goals for why.

## Data shape

One object, type `table`. Everything lives in `props`:

```json
{
  "columns": [{ "id": "c1", "name": "Task", "type": "text", "wrap": true }],
  "rows": [{ "id": "r1", "cells": { "c1": "Write the report" } }],
  "styles": { "r1:c1": { "bold": true, "color": "green" } },
  "merges": [{ "startRowIndex": 0, "startColIndex": 0, "rowSpan": 1, "colSpan": 2 }]
}
```

A table therefore syncs, searches, exports and trashes exactly like any
other workspace object — nothing plugin-specific to migrate.

## Development

```
node plugins/notible-tables/self-check.mjs
```

## Install

In Notible: **Settings -> Plugins -> Market**, then install "Notible Tables".
This repo is the source; the market pulls `plugin.json` + `notible.tables.zip` from the latest GitHub Release.
