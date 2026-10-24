import type { DocumentOutline } from './importer.js';

/** Marks the system prompt as a scorecard import, so the mock model can recognise it. */
export const IMPORT_MARKER = 'SCORECARD_IMPORT';

/** Change this with any change to the import prompt or the draft checks, so cached conversions are made again. */
export const IMPORT_VERSION = 'import/3.0';

const FORMAT = `{
  "scorecard": {
    "id": "SC-SHORT-ID",
    "name": "Readable name",
    "version": "1.0",
    "judges": "D1 schema design" | "D3 output document",   // must start with D1 or D3
    "step": "optional step label",
    "thresholds": { "accept": 75, "refine": 60 },
    "red_at_or_below": 2,                                   // optional, only if the source says a gate at or below N means red
    "aggregate": { "rule": "mean_floor", "zero_caps_at": 2, "unmeasured_caps_at": 3 },   // how criteria combine, only as the source states it (see rule 4)
    "artifact": { "sheets": [ { "name": "Sheet or 'Page 1-170'", "header_row": 1 } ], "context_sheets": [] },
    "dimensions": [
      {
        "id": "G01", "name": "...", "weight": 5, "critical": false,
        "measure": "the question, in one sentence",
        "anchors": { "0": "...", "1": "...", "2": "...", "3": "...", "4": "...", "5": "..." },   // the dimension's general anchors; criteria without their own use these
        "return_to": "Discover" | "Define" | "Generate" | "Analyse" | "Validate" | "Refine",
        "reads": ["Page 7-9"],                                                                    // the pages, sheets or "Sheet[Col|Col]" it needs, most relevant first
        "criteria": [                                                                              // every criterion of the source dimension
          { "id": "G02-C01", "name": "Field-level source trace", "kind": "judged", "measure": "the criterion's own question",
            "anchors": { "0": "...", "1": "...", "2": "...", "3": "...", "4": "...", "5": "..." } },  // the source's anchor for this criterion, if it has one
          { "id": "G02-C02", "name": "Second independent run agrees", "kind": "unmeasurable" },
          { "id": "G04-C04", "name": "Vague-term free", "kind": "counted",
            "check": { "id": "text_terms_absent", "params": { "terms": ["etc", "TBD"] } } },     // optional, see rule 9
          { "id": "G05-C01", "name": "Every NFR id is unique", "kind": "counted", "source_n": 58, "source_d": 58,
            "check": { "id": "unique", "params": { "sheet": "Register", "column": "nfr_id" } } }
        ]
      }
    ]
  },
  "general_anchor": { "0": "...", "1": "...", "2": "...", "3": "...", "4": "...", "5": "..." },   // the source's general anchor, if it has one
  "uncertain": ["each thing you were not sure about, one sentence each"],
  "adjustments": ["each judgement call you made, one sentence each"]
}`;

export const importSystem = (maxPages: number) => `${IMPORT_MARKER}
You convert a scorecard written in any layout into the JSON format below. Your result is used straight away to score work, with no person checking it, so be exact.

Rules:
1. Copy ids, names, weights, gate (critical) flags and thresholds exactly as the source states them. Never invent a criterion, weight or rule. If something is missing, leave it out and say so in "uncertain".
2. A question judged by reading the document needs its own anchors for 0 to 5, written for THAT question: say what the document would show at each level, in the question's own terms (what is present, what is missing). Use the source's own wording for a criterion where it has it (for example "5 all four; 3 two or three; 1 one"), filling the levels in between. Do NOT paste the same general anchor under every question; use the general anchor only as the fallback, and say so in "uncertain" when you did.
3. Give every criterion one kind. "counted": a count over the document settles it exactly (blank cells, unique ids, values in an allowed list, a share of items that have something). "judged": a reader can score it by reading the document (the source may call it "Anchored", or it asks whether something is covered, clear or sound). "unmeasurable": it needs something that is NOT in the document: a second independent run, an interview or answers from the author, a sample checked against a source document that was not given, or a sign-off. The examiners still score an unmeasurable criterion from what the document records about it. Prefer counted when a check below can do it exactly, else judged. Do not set measured_by on a dimension that has criteria.
4. Keep one dimension per source dimension, with its source id, name, weight and gate flag, and list EVERY criterion of it under "criteria" with its id, kind, its own measure and its own anchors when the source gives them. Do NOT split a dimension into several, and do not leave a criterion out: each criterion is scored on its own and code combines them into the dimension's score. Set "aggregate" to the rule the source states for combining criteria: "mean_floor" when the dimension is the mean of its criteria rounded down, "mean" for the plain mean, "weighted" when criteria carry weights; "zero_caps_at" when a criterion scored 0 caps the dimension (for example at 2); "unmeasured_caps_at" when a not-measurable criterion caps it (for example at 3). Leave "aggregate" out when the source states no rule. Nothing is ever held for a person, and a criterion the examiners find nothing to measure is handled by that rule automatically.
5. A dimension the source calls a GATE or critical gets "critical": true. If the source says a gate dimension at or below some score forces a red result, set red_at_or_below.
6. judges is "D1 schema design" when the scorecard judges a schema or design, and "D3 output document" when it judges a produced document.
7. artifact and reads: use only the sheet or page names in the document outline you are given. For a PDF write ranges like "Page 7-9", keep each question to at most ${maxPages} pages in total, and give each question the pages that hold its evidence, most relevant first (use the first lines to choose). For an Excel file use sheet names, and for a sheet with many columns name only the columns the question needs, as "Sheet[Column A|Column B]" with the column titles exactly as the outline lists them (an id column plus the few columns that hold the evidence; at most 8). A question that reads whole big sheets is too large for the models. If no outline is given, use one sheet named "Sheet1" and say in "uncertain" that it must be set.
8. If the source refers to sheets, tables or documents that are NOT in the document outline (for example in a column that says which sheet each check reads), say so in "uncertain" in one sentence that starts "The scorecard refers to sheets or documents the file does not have:" and name them. Questions about them cannot be scored from this file.
   Also say plainly in "uncertain" about anything you guessed, and about any rule in the source that this format cannot hold (for example caps, averages or formulas). Leave out steps that only a person can do and that the source keeps outside the score (sign-offs, interviews, approvals); they are not questions.
9. A counted criterion carries a "check" that code will run exactly, and the app tries it on the real file, so a wrong sheet or column name drops it. Two families:
   a) For an Excel document, use the sheet and column names EXACTLY as the document outline lists them (the outline also gives each sheet's header row). Pick one of: "column_filled" (params: sheet, column, optional pattern as a regular expression; share of rows whose cell is filled and matches), "unique" (params: sheet, column; share of rows with a value that appears once), "values_in_list" (params: sheet, column, lists_sheet, lists_name_column, lists_value_column, list; share of values that are members of the named allowed list), "max_value" (params: sheet, column, max; share of rows whose number is at most max), "value_not_in" (params: sheet, column, forbidden as a list of words, optional blank_fails; share of rows whose value is not one of them), "any_filled" (params: sheet, columns as a list; share of rows with at least one of them filled), "row_count_at_least" (params: sheet, min). Any of these may take "where": {"column": "...", "equals": "..."} or {"column": "...", "not_blank": true} to count only some rows. Use a check only when the criterion is exactly such a count.
   b) For text (a PDF, or an Excel read as text): "text_terms_absent" (params: terms; share of lines containing none of the terms, for example vague words), "text_terms_present" (params: terms; share of the required terms that appear anywhere), "text_ids_valid" (params: find, a loose regular expression for things that look like IDs, and valid, the strict regular expression an ID must fit). Use the terms or pattern the source states. If the source does not list them, propose them and say so in "uncertain" ("terms for X were proposed by the model; confirm").
   When the source states the figures it counted for a criterion (for example N = 40 and D = 58), copy them into the criterion as "source_n" and "source_d". The app runs your check on the real file and compares it with those figures, and drops a check that gives a different answer, so choose the columns and words that reproduce the source's own count.
   If no check can settle a counted criterion exactly, give no "check": the examiners will estimate it by reading the document. Never invent a check.

Reply with one JSON object and nothing else, in this shape (the // notes are for you, do not write them):
${FORMAT}`;

export function buildImportUser(sourceName: string, sourceText: string, outline: DocumentOutline | null): string {
  return [
    `<source_file name=${JSON.stringify(sourceName)}>\n${sourceText}\n</source_file>`,
    outline ? `<document_outline>\n${outline.text}\n</document_outline>` : '<document_outline>\nnone given\n</document_outline>',
  ].join('\n\n');
}
