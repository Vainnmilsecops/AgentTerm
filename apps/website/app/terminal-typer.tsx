'use client';

import { useEffect, useRef, useState } from 'react';

interface TyperProps {
  readonly lines: readonly string[];
  readonly intervalMs?: number;
  readonly loop?: boolean;
}

export function TerminalTyper({ intervalMs = 2400, lines, loop = true }: TyperProps) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const line = lines[index % lines.length] ?? '';
    let cancelled = false;
    let charIndex = 0;
    const typeNext = (): void => {
      if (cancelled) {
        return;
      }
      if (charIndex <= line.length) {
        setText(line.slice(0, charIndex));
        charIndex += 1;
        timeoutRef.current = setTimeout(typeNext, 30);
      } else {
        timeoutRef.current = setTimeout(() => {
          if (cancelled) {
            return;
          }
          if (loop || index + 1 < lines.length) {
            setIndex((current) => current + 1);
          }
        }, intervalMs);
      }
    };
    typeNext();
    return () => {
      cancelled = true;
      if (timeoutRef.current !== undefined) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [index, intervalMs, lines, loop]);

  return (
    <span className="terminal-typer">
      <span className="terminal-typer__text">{text}</span>
      <span aria-hidden="true" className="terminal-typer__cursor">
        ▍
      </span>
    </span>
  );
}
