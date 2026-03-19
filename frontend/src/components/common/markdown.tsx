'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface MarkdownProps {
  content: string;
  className?: string;
}

/** Parse inline markdown (bold, italic, code, links, strikethrough) into React elements */
function parseInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match: **bold**, *italic*, `code`, [link](url), ~~strike~~
  const regex =
    /(\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*(.+?)\*|_(.+?)_|~~(.+?)~~)/g;
  let lastIndex = 0;
  let key = 0;

  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] || match[3]) {
      nodes.push(<strong key={key++}>{match[2] || match[3]}</strong>);
    } else if (match[4]) {
      nodes.push(
        <code key={key++} className="inline-code">
          {match[4]}
        </code>,
      );
    } else if (match[5] && match[6]) {
      nodes.push(
        <a
          key={key++}
          href={match[6]}
          target="_blank"
          rel="noopener noreferrer"
        >
          {match[5]}
        </a>,
      );
    } else if (match[7] || match[8]) {
      nodes.push(<em key={key++}>{match[7] || match[8]}</em>);
    } else if (match[9]) {
      nodes.push(<del key={key++}>{match[9]}</del>);
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes.length > 0 ? nodes : [text];
}

/** Convert markdown string to React elements */
function renderMarkdown(content: string): React.ReactNode[] {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={key++} className="code-block" data-lang={lang}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const Tag = `h${level}` as const;
      elements.push(<Tag key={key++}>{parseInline(headerMatch[2])}</Tag>);
      i++;
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}$/.test(line)) {
      elements.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={key++}>
          {quoteLines.map((ql, qi) => (
            <p key={qi}>{parseInline(ql)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // Unordered lists
    if (/^[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[-*]\s+/, '');
        // Task list items
        if (itemText.startsWith('[ ] ')) {
          items.push(
            <li key={items.length} className="task-item">
              <input type="checkbox" disabled />{' '}
              {parseInline(itemText.slice(4))}
            </li>,
          );
        } else if (/^\[x\]\s+/i.test(itemText)) {
          items.push(
            <li key={items.length} className="task-item">
              <input type="checkbox" checked disabled />{' '}
              {parseInline(itemText.replace(/^\[x\]\s+/i, ''))}
            </li>,
          );
        } else {
          items.push(<li key={items.length}>{parseInline(itemText)}</li>);
        }
        i++;
      }
      elements.push(<ul key={key++}>{items}</ul>);
      continue;
    }

    // Ordered lists
    if (/^\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(
          <li key={items.length}>
            {parseInline(lines[i].replace(/^\d+\.\s+/, ''))}
          </li>,
        );
        i++;
      }
      elements.push(<ol key={key++}>{items}</ol>);
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraphs (collect consecutive non-empty, non-special lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('> ') &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^[-*_]{3,}$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <p key={key++}>
          {paraLines.map((pl, pi) => (
            <React.Fragment key={pi}>
              {pi > 0 && <br />}
              {parseInline(pl)}
            </React.Fragment>
          ))}
        </p>,
      );
    }
  }

  return elements;
}

export function Markdown({ content, className }: MarkdownProps) {
  const elements = React.useMemo(() => renderMarkdown(content), [content]);

  return (
    <div className={cn('prose-nearly markdown-content', className)}>
      {elements}
    </div>
  );
}

// Code block component
export function CodeBlock({
  code,
  language,
  showLineNumbers = true,
}: {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const lines = code.split('\n');

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="code-block-wrapper relative group rounded-lg overflow-hidden border">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <span className="text-xs text-muted-foreground font-mono">
          {language || 'plaintext'}
        </span>
        <button
          type="button"
          onClick={copyToClipboard}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <pre className="p-4 text-sm">
          <code>
            {showLineNumbers ? (
              <table className="border-collapse">
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={`line-${i}`}>
                      <td className="pr-4 text-muted-foreground select-none text-right w-8">
                        {i + 1}
                      </td>
                      <td>{line}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span>{code}</span>
            )}
          </code>
        </pre>
      </div>
    </div>
  );
}

// Spoiler component
export function Spoiler({
  children,
  label = 'Spoiler',
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <div className="spoiler-wrapper">
      {revealed ? (
        <div className="spoiler-content p-3 rounded-lg bg-muted">
          {children}
          <button
            type="button"
            onClick={() => setRevealed(false)}
            className="text-xs text-muted-foreground hover:text-foreground mt-2"
          >
            Hide
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRevealed(true)}
          className="px-3 py-2 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
        >
          {label} (click to reveal)
        </button>
      )}
    </div>
  );
}

// Quote component
export function Quote({
  children,
  author,
  source,
}: {
  children: React.ReactNode;
  author?: string;
  source?: string;
}) {
  return (
    <blockquote className="border-l-4 border-primary pl-4 py-2 my-4">
      <div className="italic">{children}</div>
      {(author || source) && (
        <footer className="text-sm text-muted-foreground mt-2">
          {author && <span>— {author}</span>}
          {source && <cite className="ml-1">({source})</cite>}
        </footer>
      )}
    </blockquote>
  );
}

// Table component
export function Table({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-x-auto my-4">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {headers.map((header, i) => (
              <th
                key={`h-${i}`}
                className="px-4 py-2 text-left font-medium border-b bg-muted/50"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`r-${i}`} className="hover:bg-muted/30">
              {row.map((cell, j) => (
                <td key={`c-${j}`} className="px-4 py-2 border-b">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
