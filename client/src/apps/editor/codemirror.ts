/**
 * The CodeMirror side of the Editor: the extensions every buffer gets, the
 * language for a file name, the SpecOS theme and the flash that marks lines
 * someone else just changed.
 */
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export interface FileLanguage {
  /** The name the status bar shows. */
  label: string;
  support: LanguageSupport | null;
  /** Prose wraps at the window's edge; code keeps its lines. */
  prose: boolean;
  indent: string;
}

const PLAIN: FileLanguage = { label: 'Plain text', support: null, prose: true, indent: '  ' };

const BY_EXTENSION: Record<string, () => FileLanguage> = {
  js: () => ({ label: 'JavaScript', support: javascript(), prose: false, indent: '  ' }),
  mjs: () => ({ label: 'JavaScript', support: javascript(), prose: false, indent: '  ' }),
  cjs: () => ({ label: 'JavaScript', support: javascript(), prose: false, indent: '  ' }),
  jsx: () => ({ label: 'JSX', support: javascript({ jsx: true }), prose: false, indent: '  ' }),
  ts: () => ({ label: 'TypeScript', support: javascript({ typescript: true }), prose: false, indent: '  ' }),
  mts: () => ({ label: 'TypeScript', support: javascript({ typescript: true }), prose: false, indent: '  ' }),
  cts: () => ({ label: 'TypeScript', support: javascript({ typescript: true }), prose: false, indent: '  ' }),
  tsx: () => ({ label: 'TSX', support: javascript({ typescript: true, jsx: true }), prose: false, indent: '  ' }),
  json: () => ({ label: 'JSON', support: json(), prose: false, indent: '  ' }),
  md: () => ({ label: 'Markdown', support: markdown({ base: markdownLanguage }), prose: true, indent: '  ' }),
  markdown: () => ({ label: 'Markdown', support: markdown({ base: markdownLanguage }), prose: true, indent: '  ' }),
  html: () => ({ label: 'HTML', support: html(), prose: false, indent: '  ' }),
  htm: () => ({ label: 'HTML', support: html(), prose: false, indent: '  ' }),
  css: () => ({ label: 'CSS', support: css(), prose: false, indent: '  ' }),
  py: () => ({ label: 'Python', support: python(), prose: false, indent: '    ' }),
};

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const isMarkdown = (path: string): boolean => ['md', 'markdown'].includes(extensionOf(path));

export function languageFor(path: string): FileLanguage {
  return BY_EXTENSION[extensionOf(path)]?.() ?? PLAIN;
}

/*
 * The theme is written against CSS variables (the design tokens, and the
 * --code-* colours editor.css defines for each theme), so one set of rules
 * serves light and dark and a theme switch needs no work here.
 */
const chrome = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink)',
    backgroundColor: 'var(--surface)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'none',
    lineHeight: '1.62',
    overflow: 'auto',
  },
  '.cm-content': { padding: '10px 0 96px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 20px 0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--accent)', marginLeft: '-1px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--pressed)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--selection)' },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-gutters': {
    border: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink-faint)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '46px',
    padding: '0 10px 0 14px',
    fontSize: '11.5px',
    lineHeight: '21.06px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-activeLine': { backgroundColor: 'var(--code-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)',
    borderRadius: '2px',
  },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-match)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--warning-soft)',
    outline: '1px solid color-mix(in oklch, var(--warning) 55%, transparent)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--selected)', outlineColor: 'var(--accent)' },

  // The line flash: a wash in the author's colour that drains away, with a bar at the margin.
  '.cm-line.cm-flash': {
    animation: 'editor-line-flash 1600ms var(--ease-out) both',
    boxShadow: 'inset 2px 0 0 var(--flash-solid)',
  },

  // The search panel, in the window's own chrome.
  '.cm-panels': { backgroundColor: 'var(--surface-sunken)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--hairline)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--hairline)' },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 36px 8px 12px',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-sm)',
  },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: '0', content: '""' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    margin: '0 4px 0 2px',
    color: 'var(--ink-muted)',
    fontSize: 'var(--text-xs)',
  },
  '.cm-panel.cm-search input[type=checkbox]': { margin: '0', accentColor: 'var(--accent-fill)' },
  '.cm-textfield': {
    height: '26px',
    margin: '0',
    padding: '0 8px',
    border: '1px solid var(--hairline-strong)',
    borderRadius: 'var(--r-sm)',
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-sm)',
  },
  '.cm-textfield:focus': { outline: '2px solid var(--focus-ring)', outlineOffset: '-1px', borderColor: 'transparent' },
  '.cm-button': {
    height: '26px',
    margin: '0',
    padding: '0 10px',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    backgroundImage: 'none',
    backgroundColor: 'var(--hover)',
    color: 'var(--ink-soft)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-sm)',
    textTransform: 'capitalize',
  },
  '.cm-button:hover': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent-ink)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--selected)' },
  '.cm-panel.cm-search [name=close]': {
    top: '8px',
    right: '8px',
    width: '26px',
    height: '26px',
    borderRadius: 'var(--r-sm)',
    color: 'var(--ink-muted)',
    fontSize: '18px',
    lineHeight: '1',
  },
  '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--hover)', color: 'var(--ink)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: 'var(--code-string)' },
  { tag: [t.regexp, t.escape], color: 'var(--code-regexp)' },
  { tag: [t.number, t.integer, t.float, t.unit], color: 'var(--code-number)' },
  { tag: [t.bool, t.null, t.atom, t.self, t.special(t.variableName), t.constant(t.name)], color: 'var(--code-constant)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: 'var(--code-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName], color: 'var(--code-function)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--code-definition)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.tagName], color: 'var(--code-keyword)' },
  { tag: [t.angleBracket, t.punctuation, t.separator, t.bracket, t.operator, t.derefOperator], color: 'var(--code-punctuation)' },
  { tag: [t.meta, t.processingInstruction, t.documentMeta, t.annotation], color: 'var(--code-meta)' },
  { tag: t.heading, color: 'var(--ink)', fontWeight: '700' },
  { tag: [t.heading1, t.heading2], color: 'var(--ink)', fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--code-function)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: [t.quote, t.contentSeparator], color: 'var(--code-comment)' },
  { tag: t.monospace, color: 'var(--code-string)' },
  { tag: t.inserted, color: 'var(--code-string)' },
  { tag: t.deleted, color: 'var(--code-keyword)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

/** Lines to flash, as document positions inside them, and the colours of who changed them. */
export interface Flash {
  lines: number[];
  soft: string;
  solid: string;
}

export const flashLines = StateEffect.define<Flash>();
export const clearFlash = StateEffect.define<null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(clearFlash)) next = Decoration.none;
      if (effect.is(flashLines)) {
        const { lines, soft, solid } = effect.value;
        const style = `--flash-soft: ${soft}; --flash-solid: ${solid}`;
        const ranges: Array<Range<Decoration>> = lines.map((position) =>
          Decoration.line({ class: 'cm-flash', attributes: { style } }).range(position),
        );
        next = Decoration.set(ranges, true);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Everything a buffer needs apart from what depends on the file or the theme. */
export function baseExtensions(language: FileLanguage): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.tabSize.of(language.indent.length),
    indentUnit.of(language.indent),
    EditorState.allowMultipleSelections.of(true),
    language.prose ? EditorView.lineWrapping : [],
    language.support ?? [],
    syntaxHighlighting(highlight),
    chrome,
    flashField,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
  ];
}
