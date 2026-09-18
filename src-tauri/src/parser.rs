//! Markdown block parsing and per-block HTML rendering.
//!
//! The editor is block-based: a document is split into independent blocks
//! (paragraphs, headings, lists, tables, blockquotes, fenced code, blank
//! lines). `parse_blocks` is the state machine that does the splitting; each
//! block's HTML comes from pulldown-cmark.

use pulldown_cmark::{Event, Options, Parser, html};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

// Whether to escape unsafe raw HTML (e.g. <style>, <script>) when rendering,
// showing it as text instead of live HTML. Set from the frontend via the
// set_escape_unsafe_html command. Default on (safe).
pub static ESCAPE_UNSAFE_HTML: AtomicBool = AtomicBool::new(true);

// Raw HTML tags safe to render as-is. Anything not listed (style, link, script,
// iframe, form, object, embed, ...) is escaped to text when the setting is on.
// Block structure (p, table, ...) comes from Markdown, not raw HTML, so it is
// unaffected; this list only governs literal HTML the user typed.
const ALLOWED_HTML_TAGS: &[&str] = &[
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "picture",
    "pre",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "small",
    "source",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
    "wbr",
];

// True when every tag in a raw HTML chunk is allowlisted. Scans the WHOLE chunk,
// not just the first tag, so a disallowed tag nested in an allowed one - e.g.
// `<div><style>body{opacity:0}</style></div>` - is still caught and the whole
// chunk gets escaped. A `<` that does not open a tag (text, comment, doctype) is
// skipped, but the real tags after it are still checked.
fn is_allowed_html(chunk: &str) -> bool {
    // Each piece after a '<' starts a tag (the first split piece is the text
    // before any '<', so skip it). Checking every piece catches a disallowed tag
    // nested in an allowed wrapper, e.g. <div><style>...</style></div>.
    for piece in chunk.split('<').skip(1) {
        let piece = piece.strip_prefix('/').unwrap_or(piece);
        // Tag name = up to the first whitespace, '/' or '>'. Read it whole (not
        // just letters), or a custom element like <a-widget> is misread as <a>.
        let name = piece
            .split(|c: char| c.is_whitespace() || c == '/' || c == '>')
            .next()
            .unwrap_or("");
        // A piece not starting with a letter is text/comment/doctype, not a tag.
        if name.starts_with(|c: char| c.is_ascii_alphabetic())
            && !ALLOWED_HTML_TAGS
                .iter()
                .any(|t| name.eq_ignore_ascii_case(t))
        {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    Line,
    EmptyLine,
    CodeBlock,
    List,
    Table,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: u64,
    pub markdown: String,
    pub html: String,
    pub kind: BlockKind,
}

// Explicit option set so a pulldown-cmark upgrade can't silently change the
// HTML. Smart punctuation is intentionally off (keep `--` as `--`, plain
// quotes). ENABLE_MATH is required: it turns `$...$` / `$$...$$` into
// `.math-inline` / `.math-display` spans that KaTeX then renders. Shared by
// rendering and by toggle_task_marker so the task offsets line up with what the
// HTML showed.
fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_HEADING_ATTRIBUTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM // GitHub alerts: > [!NOTE] etc. -> blockquote.markdown-alert-*
        | Options::ENABLE_DEFINITION_LIST // `term` then `: definition` -> <dl><dt><dd>
        | Options::ENABLE_SUPERSCRIPT // `^text^` -> <sup>
        | Options::ENABLE_SUBSCRIPT // `~text~` -> <sub>; note: this makes single
    // `~...~` subscript (was strikethrough). Double `~~...~~` strikethrough still works.
}

fn render_markdown(markdown: &str) -> String {
    // Render each GFM task checkbox ourselves so it carries data-marku-task-index:
    // the frontend then finds task checkboxes by that attribute alone, with an
    // index that already matches toggle_task_marker - no guessing from the <li>
    // structure or pulldown's exact markup, and a raw <input> can't be confused
    // for a task. The index resets per render (per block), matching how the toggle
    // command counts markers within one block. `disabled` keeps it inert until the
    // frontend enables it.
    let escape_unsafe = ESCAPE_UNSAFE_HTML.load(Ordering::Relaxed);
    let mut task_index = 0usize;
    let parser = Parser::new_ext(markdown, markdown_options()).map(|event| match event {
        Event::TaskListMarker(checked) => {
            let checked = if checked { " checked" } else { "" };
            let html = format!(
                "<input type=\"checkbox\" disabled data-marku-task-index=\"{task_index}\"{checked}>"
            );
            task_index += 1;
            Event::InlineHtml(html.into())
        }
        // Render-time safety: show disallowed raw HTML (style/script/iframe/...)
        // as text, not live HTML. Turning it into a Text event lets push_html
        // escape <, > and & for us. Only literal HTML from the source reaches
        // here - the generated checkbox above is produced, not re-matched.
        Event::Html(h) if escape_unsafe && !is_allowed_html(&h) => Event::Text(h),
        Event::InlineHtml(h) if escape_unsafe && !is_allowed_html(&h) => Event::Text(h),
        other => other,
    });
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}

// Flip the Nth GFM task-list checkbox in `markdown`, returning the new markdown.
// pulldown-cmark is the single source of truth for what counts as a task marker,
// so this covers `-`/`*`/`+`, `1.`/`1)` and nested lists without re-implementing
// list syntax in the frontend, and avoids any byte-offset (Rust) vs UTF-16 (JS)
// mismatch. `index` is the document order of the rendered checkboxes, which is
// exactly the order TaskListMarker events appear.
pub fn toggle_task_marker(markdown: &str, index: usize) -> String {
    let range = Parser::new_ext(markdown, markdown_options())
        .into_offset_iter()
        .filter_map(|(ev, range)| match ev {
            Event::TaskListMarker(_) => Some(range),
            _ => None,
        })
        .nth(index);
    let Some(range) = range else {
        return markdown.to_string();
    };
    // The marker span is `[ ]` / `[x]` / `[X]`; flip the checked state.
    let marker = &markdown[range.clone()];
    let replacement = if marker.contains('x') || marker.contains('X') {
        "[ ]"
    } else {
        "[x]"
    };
    let mut out = String::with_capacity(markdown.len());
    out.push_str(&markdown[..range.start]);
    out.push_str(replacement);
    out.push_str(&markdown[range.end..]);
    out
}

pub fn render_block_html(markdown: &str, kind: &BlockKind) -> String {
    match kind {
        BlockKind::EmptyLine => String::new(),
        _ => render_markdown(markdown),
    }
}

fn is_ordered_list(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    // CommonMark allows both `.` and `)` after the number: `1. item` / `1) item`.
    i > 0 && i + 1 < bytes.len() && (bytes[i] == b'.' || bytes[i] == b')') && bytes[i + 1] == b' '
}

// True if `line` starts with `ch`, allowing up to 3 leading spaces (CommonMark
// permits 1-3 spaces of indentation before block markers like > and |).
fn starts_with_indented(line: &str, ch: char) -> bool {
    let t = line.trim_start();
    line.len() - t.len() <= 3 && t.starts_with(ch)
}

fn is_list_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("- ")
        || t.starts_with("* ")
        || t.starts_with("+ ")
        || t.starts_with("- [")
        || t.starts_with("* [")
        || is_ordered_list(t)
}

fn is_list_continuation(line: &str) -> bool {
    if line.trim().is_empty() {
        return false;
    }
    is_list_line(line) || line.starts_with("  ") || line.starts_with('\t')
}

// Definition-list marker: a `:` definition line, allowing up to 3 leading
// spaces (CommonMark-hs lists). Must be `:` followed by whitespace.
fn is_def_marker(line: &str) -> bool {
    let t = line.trim_start();
    line.len() - t.len() <= 3 && (t.starts_with(": ") || t.starts_with(":\t"))
}

// Does `line` continue an open definition list? `next` is the line after it.
// Continues on: a `: definition` line; a new term (a plain line immediately
// followed by a `: ...` marker); an indented lazy continuation of a definition.
// A blank line, a heading, or an ordinary paragraph ends the list instead of
// being swallowed.
fn is_def_continuation(line: &str, next: Option<&str>) -> bool {
    if line.trim().is_empty() {
        return false;
    }
    is_def_marker(line)
        || next.is_some_and(is_def_marker)
        || line.starts_with("  ")
        || line.starts_with('\t')
}

// Opening code fence: ``` or ~~~ at up to 3 spaces of indent (CommonMark).
fn opens_code_fence(line: &str) -> bool {
    let t = line.trim_start();
    line.len() - t.len() <= 3 && (t.starts_with("```") || t.starts_with("~~~"))
}

// A GFM table row: up to 3 spaces indent, non-empty, contains a pipe. Covers
// rows with or without outer pipes (`| a | b |` and `a | b` both qualify).
fn is_table_row(line: &str) -> bool {
    let t = line.trim_start();
    line.len() - t.len() <= 3 && t.contains('|') && !t.trim().is_empty()
}

// A GFM table delimiter row: cells of dashes with optional alignment colons,
// separated by pipes, outer pipes optional (`| --- | :--: |`, `--- | ---`,
// `:--|--:`). A bare `---` has no pipe and is a thematic break, not a table, so
// a pipe is required (is_table_row enforces it).
fn is_table_delimiter(line: &str) -> bool {
    if !is_table_row(line) {
        return false;
    }
    let t = line.trim();
    let inner = t.strip_prefix('|').unwrap_or(t);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    inner.split('|').all(|cell| {
        let c = cell.trim();
        let c = c.strip_prefix(':').unwrap_or(c);
        let c = c.strip_suffix(':').unwrap_or(c);
        !c.is_empty() && c.bytes().all(|b| b == b'-')
    })
}

pub fn parse_blocks(content: &str) -> Vec<(String, BlockKind)> {
    enum State {
        Normal,
        CodeBlock {
            fence_char: char,
            fence_len: usize,
            lines: Vec<String>,
        },
        DisplayMath {
            lines: Vec<String>,
        },
        Blockquote {
            lines: Vec<String>,
        },
        List {
            lines: Vec<String>,
        },
        Table {
            lines: Vec<String>,
        },
        DefinitionList {
            lines: Vec<String>,
        },
    }

    let raw_lines: Vec<&str> = content.split('\n').collect();
    let mut blocks: Vec<(String, BlockKind)> = Vec::new();
    let mut state = State::Normal;
    let mut i = 0;

    while i < raw_lines.len() {
        let line = raw_lines[i].to_string();
        let s = std::mem::replace(&mut state, State::Normal);

        let (new_state, advance) = match s {
            State::Normal => {
                if line.trim().is_empty() {
                    blocks.push((String::new(), BlockKind::EmptyLine));
                    (State::Normal, true)
                } else if opens_code_fence(&line) {
                    let t = line.trim_start();
                    let fence_char = if t.starts_with("```") { '`' } else { '~' };
                    let fence_len = t.chars().take_while(|&c| c == fence_char).count();
                    (
                        State::CodeBlock {
                            fence_char,
                            fence_len,
                            lines: vec![line],
                        },
                        true,
                    )
                } else if line.trim() == "$$" {
                    (State::DisplayMath { lines: vec![line] }, true)
                } else if starts_with_indented(&line, '>') {
                    (State::Blockquote { lines: vec![line] }, true)
                } else if is_list_line(&line) {
                    (State::List { lines: vec![line] }, true)
                } else if is_table_row(&line)
                    && i + 1 < raw_lines.len()
                    && is_table_delimiter(raw_lines[i + 1])
                {
                    // GFM table: a header row followed by a delimiter row. Outer
                    // pipes are optional, so detect by the delimiter, not a `|`
                    // at the line start.
                    (State::Table { lines: vec![line] }, true)
                } else if i + 1 < raw_lines.len() && is_def_marker(raw_lines[i + 1]) {
                    // Plain line whose next line is `: ...` - start of a definition list.
                    (State::DefinitionList { lines: vec![line] }, true)
                } else {
                    blocks.push((line, BlockKind::Line));
                    (State::Normal, true)
                }
            }
            State::CodeBlock {
                fence_char,
                fence_len,
                mut lines,
            } => {
                // Closing fence: same char, length >= opening (CommonMark), so a
                // shorter run inside a longer fence stays part of the content.
                // Up to 3 spaces of indent, same as the opener (more = content).
                let t = line.trim_start();
                let indent = line.len() - t.len();
                let tr = t.trim_end();
                let is_closing = !lines.is_empty()
                    && indent <= 3
                    && !tr.is_empty()
                    && tr.chars().all(|c| c == fence_char)
                    && tr.chars().count() >= fence_len;
                lines.push(line);
                if is_closing {
                    blocks.push((lines.join("\n"), BlockKind::CodeBlock));
                    (State::Normal, true)
                } else {
                    (
                        State::CodeBlock {
                            fence_char,
                            fence_len,
                            lines,
                        },
                        true,
                    )
                }
            }
            State::DisplayMath { mut lines } => {
                // Any following `$$` line closes the block, including the empty
                // `$$\n$$` form - otherwise the closing fence and the text after
                // it get glued into one editor block.
                let is_closing = line.trim() == "$$";
                lines.push(line);
                if is_closing {
                    blocks.push((lines.join("\n"), BlockKind::Line));
                    (State::Normal, true)
                } else {
                    (State::DisplayMath { lines }, true)
                }
            }
            State::Blockquote { mut lines } => {
                if starts_with_indented(&line, '>') {
                    lines.push(line);
                    (State::Blockquote { lines }, true)
                } else {
                    blocks.push((lines.join("\n"), BlockKind::Line));
                    (State::Normal, false)
                }
            }
            State::List { mut lines } => {
                if is_list_continuation(&line) {
                    lines.push(line);
                    (State::List { lines }, true)
                } else {
                    blocks.push((lines.join("\n"), BlockKind::List));
                    (State::Normal, false)
                }
            }
            State::Table { mut lines } => {
                // Body rows continue while they stay table rows (pipe-bearing);
                // a blank or pipe-less line ends the table.
                if is_table_row(&line) {
                    lines.push(line);
                    (State::Table { lines }, true)
                } else {
                    blocks.push((lines.join("\n"), BlockKind::Table));
                    (State::Normal, false)
                }
            }
            State::DefinitionList { mut lines } => {
                // Continue only on real definition-list lines; a heading,
                // paragraph or blank line ends the list and is reprocessed in
                // Normal instead of being swallowed.
                if is_def_continuation(&line, raw_lines.get(i + 1).copied()) {
                    lines.push(line);
                    (State::DefinitionList { lines }, true)
                } else {
                    blocks.push((lines.join("\n"), BlockKind::Line));
                    (State::Normal, false)
                }
            }
        };

        state = new_state;
        if advance {
            i += 1;
        }
    }

    // flush remaining state
    match state {
        State::CodeBlock { lines, .. } => blocks.push((lines.join("\n"), BlockKind::CodeBlock)),
        State::DisplayMath { lines } => blocks.push((lines.join("\n"), BlockKind::Line)),
        State::Blockquote { lines } => blocks.push((lines.join("\n"), BlockKind::Line)),
        State::List { lines } => blocks.push((lines.join("\n"), BlockKind::List)),
        State::Table { lines } => blocks.push((lines.join("\n"), BlockKind::Table)),
        State::DefinitionList { lines } => blocks.push((lines.join("\n"), BlockKind::Line)),
        State::Normal => {}
    }

    blocks
}

#[cfg(test)]
mod tests {
    use super::*;
    use BlockKind::*;

    // Just the kinds, in order - most rules are about how lines group.
    fn kinds(content: &str) -> Vec<BlockKind> {
        parse_blocks(content).into_iter().map(|(_, k)| k).collect()
    }

    // The (markdown, kind) pairs, for tests that care about block contents too.
    fn blocks(content: &str) -> Vec<(String, BlockKind)> {
        parse_blocks(content)
    }

    #[test]
    fn single_paragraph() {
        assert_eq!(blocks("hello"), vec![("hello".into(), Line)]);
    }

    #[test]
    fn blank_line_is_its_own_block() {
        assert_eq!(blocks(""), vec![(String::new(), EmptyLine)]);
    }

    #[test]
    fn consecutive_plain_lines_are_separate_blocks() {
        // No blank line between them, but each non-special line stands alone.
        assert_eq!(kinds("a\nb"), vec![Line, Line]);
    }

    #[test]
    fn paragraphs_split_on_blank_line() {
        assert_eq!(kinds("a\n\nb"), vec![Line, EmptyLine, Line]);
    }

    #[test]
    fn trailing_newline_yields_trailing_empty_block() {
        assert_eq!(
            blocks("a\n"),
            vec![("a".into(), Line), (String::new(), EmptyLine)]
        );
    }

    // Tables

    #[test]
    fn table_with_outer_pipes() {
        let src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
        assert_eq!(blocks(src), vec![(src.into(), Table)]);
    }

    #[test]
    fn table_without_outer_pipes() {
        let src = "a | b\n--- | ---\n1 | 2";
        assert_eq!(blocks(src), vec![(src.into(), Table)]);
    }

    #[test]
    fn table_with_alignment_colons() {
        let src = "a | b | c\n:-- | :--: | --:\n1 | 2 | 3";
        assert_eq!(blocks(src), vec![(src.into(), Table)]);
    }

    #[test]
    fn bare_dashes_without_pipe_are_not_a_table() {
        // `---` has no pipe, so it's a thematic break, not a delimiter row.
        assert_eq!(kinds("a\n---"), vec![Line, Line]);
    }

    #[test]
    fn table_ends_at_a_pipeless_line() {
        let src = "a | b\n--- | ---\n1 | 2\nplain";
        assert_eq!(
            blocks(src),
            vec![
                ("a | b\n--- | ---\n1 | 2".into(), Table),
                ("plain".into(), Line)
            ]
        );
    }

    #[test]
    fn header_without_delimiter_is_not_a_table() {
        // A pipe-bearing line not followed by a delimiter row stays a paragraph.
        assert_eq!(kinds("a | b\nc | d"), vec![Line, Line]);
    }

    // Lists

    #[test]
    fn simple_list() {
        let src = "- a\n- b";
        assert_eq!(blocks(src), vec![(src.into(), List)]);
    }

    #[test]
    fn nested_list_stays_one_block() {
        let src = "- a\n  - b";
        assert_eq!(blocks(src), vec![(src.into(), List)]);
    }

    #[test]
    fn ordered_list() {
        let src = "1. a\n2. b";
        assert_eq!(blocks(src), vec![(src.into(), List)]);
    }

    #[test]
    fn ordered_list_paren_marker() {
        let src = "1) a\n2) b";
        assert_eq!(blocks(src), vec![(src.into(), List)]);
    }

    #[test]
    fn blank_line_splits_lists_no_loose_lists() {
        // A blank line is a block separator - two lists do not merge.
        assert_eq!(kinds("- a\n\n- b"), vec![List, EmptyLine, List]);
    }

    // Fenced code

    #[test]
    fn closed_code_fence() {
        let src = "```\ncode\n```";
        assert_eq!(blocks(src), vec![(src.into(), CodeBlock)]);
    }

    #[test]
    fn unclosed_code_fence_runs_to_end() {
        let src = "```\ncode";
        assert_eq!(blocks(src), vec![(src.into(), CodeBlock)]);
    }

    #[test]
    fn shorter_fence_inside_longer_fence_is_content() {
        // The inner ``` (len 3) can't close a ```` (len 4) opener.
        let src = "````\n```\n````";
        assert_eq!(blocks(src), vec![(src.into(), CodeBlock)]);
    }

    #[test]
    fn fence_indented_up_to_three_spaces() {
        let src = "   ```\ncode\n   ```";
        assert_eq!(blocks(src), vec![(src.into(), CodeBlock)]);
    }

    #[test]
    fn fence_indented_four_spaces_is_not_a_fence() {
        // 4 spaces is the indented-code threshold, so this opener isn't recognized.
        assert_eq!(kinds("    ```\ncode"), vec![Line, Line]);
    }

    // Display math

    #[test]
    fn closed_display_math_is_a_line_block() {
        let src = "$$\nx = 1\n$$";
        assert_eq!(blocks(src), vec![(src.into(), Line)]);
    }

    #[test]
    fn unclosed_display_math_runs_to_end() {
        let src = "$$\nx = 1";
        assert_eq!(blocks(src), vec![(src.into(), Line)]);
    }

    #[test]
    fn empty_display_math_separates_from_following_text() {
        let src = "$$\n$$\nhe";
        assert_eq!(
            blocks(src),
            vec![("$$\n$$".into(), Line), ("he".into(), Line)]
        );
    }

    // Blockquote

    #[test]
    fn blockquote_is_one_line_block() {
        let src = "> a\n> b";
        assert_eq!(blocks(src), vec![(src.into(), Line)]);
    }

    #[test]
    fn blockquote_ends_at_a_non_quote_line() {
        assert_eq!(kinds("> a\nplain"), vec![Line, Line]);
    }

    // Definition lists

    #[test]
    fn definition_list_up_to_three_spaces() {
        let src = "TERM\n: def";
        assert_eq!(blocks(src), vec![(src.into(), Line)]);
        let src3 = "TERM\n   : def";
        assert_eq!(blocks(src3), vec![(src3.into(), Line)]);
    }

    #[test]
    fn definition_list_four_spaces_splits_current_behavior() {
        // KNOWN ISSUE: exactly 4 spaces before `:` is past the def-marker indent
        // limit, so TERM and the `: def` line do not group. See the parser task
        // in .claude/Tasks.md. This test documents today's behavior; update it
        // when the issue is resolved.
        assert_eq!(kinds("TERM\n    : def"), vec![Line, Line]);
    }

    #[test]
    fn definition_list_ends_at_heading() {
        let src = "Term\n: def\n# Heading\npara";
        assert_eq!(
            blocks(src),
            vec![
                ("Term\n: def".into(), Line),
                ("# Heading".into(), Line),
                ("para".into(), Line),
            ]
        );
    }

    #[test]
    fn definition_list_keeps_multiple_terms() {
        let src = "Term 1\n: def 1\nTerm 2\n: def 2";
        assert_eq!(blocks(src), vec![(src.into(), Line)]);
    }

    // Task-list toggle

    #[test]
    fn toggle_task_checks_and_unchecks_by_index() {
        let src = "- [ ] a\n- [x] b";
        assert_eq!(toggle_task_marker(src, 0), "- [x] a\n- [x] b");
        assert_eq!(toggle_task_marker(src, 1), "- [ ] a\n- [ ] b");
    }

    #[test]
    fn toggle_task_handles_paren_and_dot_ordered_markers() {
        assert_eq!(toggle_task_marker("1) [ ] a", 0), "1) [x] a");
        assert_eq!(toggle_task_marker("1. [x] a", 0), "1. [ ] a");
    }

    #[test]
    fn toggle_task_out_of_range_is_noop() {
        let src = "- [ ] a";
        assert_eq!(toggle_task_marker(src, 5), src);
    }

    #[test]
    fn toggle_task_indexes_only_checkboxes_not_plain_items() {
        // A plain bullet between two tasks must not shift the index.
        let src = "- [ ] a\n- plain\n- [ ] b";
        assert_eq!(toggle_task_marker(src, 1), "- [ ] a\n- plain\n- [x] b");
    }

    #[test]
    fn render_tags_task_checkboxes_with_index() {
        let html = render_markdown("- [ ] a\n- [x] b");
        assert!(html.contains("data-marku-task-index=\"0\""));
        assert!(html.contains("data-marku-task-index=\"1\""));
        // The second marker is checked.
        assert!(html.contains("data-marku-task-index=\"1\" checked"));
    }

    #[test]
    fn allowed_html_passes_safe_tags() {
        for chunk in [
            "<div>",
            "</div>",
            "<details>",
            "<summary>",
            "<kbd>",
            "<img src=\"x\" alt=\"a\">",
            "<DIV>",                   // case-insensitive
            "plain text",              // no tags
            "1 &lt; 2",                // already-escaped, no real tag
            "<!-- just a comment -->", // comment is not a tag
        ] {
            assert!(is_allowed_html(chunk), "should allow: {chunk}");
        }
    }

    #[test]
    fn allowed_html_rejects_unsafe_tags() {
        for chunk in [
            "<style>body{}</style>",
            "<script>alert(1)</script>",
            "<iframe src=\"x\">",
            "<form action=\"x\">",
            "<link rel=\"stylesheet\">",
            "<svg>",
            "<base href=\"x\">",
            "<a-widget>", // custom element, not the allowed <a>
        ] {
            assert!(!is_allowed_html(chunk), "should reject: {chunk}");
        }
    }

    #[test]
    fn allowed_html_rejects_unsafe_tag_nested_in_safe_one() {
        // The whole chunk must be scanned: a disallowed tag inside an allowed
        // wrapper still makes the chunk unsafe.
        assert!(!is_allowed_html(
            "<div><style>body{opacity:0}</style></div>"
        ));
        assert!(!is_allowed_html("<details><script>x</script></details>"));
        assert!(!is_allowed_html("<!-- c --><style>x</style>"));
    }

    #[test]
    fn render_escapes_unsafe_html_by_default() {
        // ESCAPE_UNSAFE_HTML defaults to true; a <style> renders as text.
        let html = render_markdown("<style>body{opacity:0}</style>");
        assert!(!html.contains("<style>"));
        assert!(html.contains("&lt;style&gt;"));
    }
}
