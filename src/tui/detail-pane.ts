import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  ImageRenderable,
  MarkdownRenderable,
  RGBA,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type TextChunk,
} from '@opentui/core';
import type { AnsiSpan } from '../view-model/ansi.ts';
import type { DetailModel, ImageRef } from '../view-model/detail.ts';

export interface DetailPalette {
  fg: string;
  mutedFg: string;
  headingFg: string;
  errorFg: string;
  borderFg: string;
  buttonBg: string;
  buttonFg: string;
  addedBg: string;
  removedBg: string;
  addedSign: string;
  removedSign: string;
  ansi: Record<string, string>;
}

export function getDetailPalette(mode: 'dark' | 'light'): DetailPalette {
  if (mode === 'light') {
    return {
      fg: '#111827',
      mutedFg: '#6b7280',
      headingFg: '#1d4ed8',
      errorFg: '#b91c1c',
      borderFg: '#d1d5db',
      buttonBg: '#e5e7eb',
      buttonFg: '#111827',
      addedBg: '#dcfce7',
      removedBg: '#fee2e2',
      addedSign: '#15803d',
      removedSign: '#b91c1c',
      ansi: {
        'ansi-black': '#111827',
        'ansi-red': '#dc2626',
        'ansi-green': '#16a34a',
        'ansi-yellow': '#ca8a04',
        'ansi-blue': '#2563eb',
        'ansi-magenta': '#9333ea',
        'ansi-cyan': '#0891b2',
        'ansi-white': '#4b5563',
        'ansi-bright-black': '#6b7280',
        'ansi-bright-red': '#ef4444',
        'ansi-bright-green': '#22c55e',
        'ansi-bright-yellow': '#eab308',
        'ansi-bright-blue': '#3b82f6',
        'ansi-bright-magenta': '#a855f7',
        'ansi-bright-cyan': '#06b6d4',
        'ansi-bright-white': '#111827',
      },
    };
  }
  return {
    fg: '#f3f4f6',
    mutedFg: '#9ca3af',
    headingFg: '#93c5fd',
    errorFg: '#f87171',
    borderFg: '#374151',
    buttonBg: '#374151',
    buttonFg: '#f9fafb',
    addedBg: '#064e3b',
    removedBg: '#7f1d1d',
    addedSign: '#4ade80',
    removedSign: '#f87171',
    ansi: {
      'ansi-black': '#374151',
      'ansi-red': '#f87171',
      'ansi-green': '#4ade80',
      'ansi-yellow': '#facc15',
      'ansi-blue': '#60a5fa',
      'ansi-magenta': '#c084fc',
      'ansi-cyan': '#22d3ee',
      'ansi-white': '#e5e7eb',
      'ansi-bright-black': '#6b7280',
      'ansi-bright-red': '#fca5a5',
      'ansi-bright-green': '#86efac',
      'ansi-bright-yellow': '#fde047',
      'ansi-bright-blue': '#93c5fd',
      'ansi-bright-magenta': '#d8b4fe',
      'ansi-bright-cyan': '#67e8f9',
      'ansi-bright-white': '#ffffff',
    },
  };
}

export function createDetailSyntaxStyle(renderer: CliRenderer, mode: 'dark' | 'light'): SyntaxStyle {
  if (mode === 'light') {
    return SyntaxStyle.fromStyles(
      {
        default: { fg: RGBA.fromHex('#111827') },
        keyword: { fg: RGBA.fromHex('#7c3aed'), bold: true },
        string: { fg: RGBA.fromHex('#15803d') },
        comment: { fg: RGBA.fromHex('#6b7280'), italic: true },
        number: { fg: RGBA.fromHex('#b45309') },
        function: { fg: RGBA.fromHex('#1d4ed8') },
        type: { fg: RGBA.fromHex('#0f766e') },
        operator: { fg: RGBA.fromHex('#374151') },
        punctuation: { fg: RGBA.fromHex('#4b5563') },
        variable: { fg: RGBA.fromHex('#111827') },
        property: { fg: RGBA.fromHex('#0369a1') },
        'markup.heading': { fg: RGBA.fromHex('#1d4ed8'), bold: true },
        'markup.bold': { bold: true },
        'markup.italic': { italic: true },
        'markup.raw': { fg: RGBA.fromHex('#b45309') },
        conceal: { fg: RGBA.fromHex('#9ca3af') },
      },
      renderer.nativeScene,
    );
  }
  return SyntaxStyle.fromStyles(
    {
      default: { fg: RGBA.fromHex('#f3f4f6') },
      keyword: { fg: RGBA.fromHex('#c084fc'), bold: true },
      string: { fg: RGBA.fromHex('#86efac') },
      comment: { fg: RGBA.fromHex('#9ca3af'), italic: true },
      number: { fg: RGBA.fromHex('#fbbf24') },
      function: { fg: RGBA.fromHex('#60a5fa') },
      type: { fg: RGBA.fromHex('#2dd4bf') },
      operator: { fg: RGBA.fromHex('#d1d5db') },
      punctuation: { fg: RGBA.fromHex('#9ca3af') },
      variable: { fg: RGBA.fromHex('#f3f4f6') },
      property: { fg: RGBA.fromHex('#7dd3fc') },
      'markup.heading': { fg: RGBA.fromHex('#93c5fd'), bold: true },
      'markup.bold': { bold: true },
      'markup.italic': { italic: true },
      'markup.raw': { fg: RGBA.fromHex('#fcd34d') },
      conceal: { fg: RGBA.fromHex('#6b7280') },
    },
    renderer.nativeScene,
  );
}

function resolveAnsiColor(color: string | undefined, palette: DetailPalette): RGBA | undefined {
  if (!color) return undefined;
  if (color.startsWith('rgb(')) {
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color);
    if (m) return RGBA.fromInts(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const mapped = palette.ansi[color];
  return mapped ? RGBA.fromHex(mapped) : undefined;
}

function ansiToStyledText(spans: AnsiSpan[], palette: DetailPalette): StyledText {
  const chunks: TextChunk[] = spans.map((s) => {
    let attributes = TextAttributes.NONE;
    if (s.bold) attributes |= TextAttributes.BOLD;
    if (s.dim) attributes |= TextAttributes.DIM;
    if (s.italic) attributes |= TextAttributes.ITALIC;
    if (s.underline) attributes |= TextAttributes.UNDERLINE;
    return {
      __isChunk: true,
      text: s.text,
      fg: resolveAnsiColor(s.fg, palette),
      bg: resolveAnsiColor(s.bg, palette),
      attributes,
    };
  });
  return new StyledText(chunks);
}

export interface LoadedImage {
  ref: ImageRef;
  buffer?: Buffer;
}

export interface RenderDetailOptions {
  renderer: CliRenderer;
  scrollBox: ScrollBoxRenderable;
  model: DetailModel;
  images: LoadedImage[];
  supportsImages: boolean;
  palette: DetailPalette;
  syntaxStyle: SyntaxStyle;
  onToggleRaw: () => void;
  onToggleOutputExpand: () => void;
}

/** Populate the detail ScrollBoxRenderable with OpenTUI nodes for the selected step. */
export function renderDetailContent(opts: RenderDetailOptions): void {
  const { renderer, scrollBox, model, images, supportsImages, palette, syntaxStyle } = opts;

  for (const child of [...scrollBox.getChildren()]) {
    scrollBox.remove(child);
    child.destroyRecursively();
  }

  // Header bar inside detail pane
  const headRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    width: '100%',
    flexShrink: 0,
    justifyContent: 'space-between',
    paddingBottom: 1,
  });
  const metaParts = [
    model.title,
    model.durationText,
    model.tokensText,
  ].filter(Boolean);
  headRow.add(
    new TextRenderable(renderer, {
      content: metaParts.join('  ·  '),
      fg: model.failed ? palette.errorFg : palette.headingFg,
    }),
  );

  if (model.canToggleRaw) {
    const rawBtn = new BoxRenderable(renderer, {
      backgroundColor: palette.buttonBg,
      paddingLeft: 1,
      paddingRight: 1,
      onMouseDown: () => opts.onToggleRaw(),
    });
    rawBtn.add(
      new TextRenderable(renderer, {
        content: model.rawMode ? '[Rendered (r)]' : '[Raw (r)]',
        fg: palette.buttonFg,
      }),
    );
    headRow.add(rawBtn);
  }
  scrollBox.add(headRow);

  for (const block of model.blocks) {
    switch (block.kind) {
      case 'heading': {
        scrollBox.add(
          new TextRenderable(renderer, {
            content: block.text,
            fg: block.tone === 'error' ? palette.errorFg : palette.headingFg,
            paddingTop: 1,
          }),
        );
        break;
      }
      case 'empty': {
        scrollBox.add(
          new TextRenderable(renderer, {
            content: block.text,
            fg: palette.mutedFg,
          }),
        );
        break;
      }
      case 'markdown': {
        if (block.raw) {
          scrollBox.add(
            new TextRenderable(renderer, {
              content: block.text,
              fg: palette.fg,
            }),
          );
        } else {
          scrollBox.add(
            new MarkdownRenderable(renderer, {
              content: block.text,
              syntaxStyle,
              fg: palette.fg,
              width: '100%',
            }),
          );
        }
        break;
      }
      case 'code': {
        if (block.title) {
          scrollBox.add(
            new TextRenderable(renderer, {
              content: block.title,
              fg: palette.mutedFg,
            }),
          );
        }
        scrollBox.add(
          new CodeRenderable(renderer, {
            content: block.code,
            filetype: block.lang ?? undefined,
            syntaxStyle,
            fg: palette.fg,
            width: '100%',
          }),
        );
        break;
      }
      case 'diff': {
        if (block.title) {
          scrollBox.add(
            new TextRenderable(renderer, {
              content: block.title,
              fg: palette.mutedFg,
            }),
          );
        }
        scrollBox.add(
          new DiffRenderable(renderer, {
            diff: block.diffText,
            view: 'unified',
            syntaxStyle,
            fg: palette.fg,
            addedBg: palette.addedBg,
            removedBg: palette.removedBg,
            addedSignColor: palette.addedSign,
            removedSignColor: palette.removedSign,
            showLineNumbers: true,
            width: '100%',
          }),
        );
        break;
      }
      case 'ansi': {
        scrollBox.add(
          new TextRenderable(renderer, {
            content: ansiToStyledText(block.spans, palette),
          }),
        );
        break;
      }
      case 'text': {
        scrollBox.add(
          new TextRenderable(renderer, {
            content: block.text,
            fg: palette.fg,
          }),
        );
        break;
      }
    }
  }

  if (model.hasCollapsibleOutput) {
    const toggleBtn = new BoxRenderable(renderer, {
      backgroundColor: palette.buttonBg,
      paddingLeft: 1,
      paddingRight: 1,
      marginTop: 1,
      alignSelf: 'flex-start',
      onMouseDown: () => opts.onToggleOutputExpand(),
    });
    toggleBtn.add(
      new TextRenderable(renderer, {
        content: model.outputExpanded
          ? '[Collapse (e)]'
          : `[Show all ${model.totalOutputLines} lines (e)]`,
        fg: palette.buttonFg,
      }),
    );
    scrollBox.add(toggleBtn);
  }

  for (const img of images) {
    if (supportsImages && img.buffer) {
      scrollBox.add(
        new ImageRenderable(renderer, {
          source: img.buffer,
          fit: 'fit',
          width: '100%',
          height: 12,
        }),
      );
    } else {
      scrollBox.add(
        new TextRenderable(renderer, {
          content: `[Image: ${img.ref.location}]`,
          fg: palette.mutedFg,
          paddingTop: 1,
        }),
      );
    }
  }
}
