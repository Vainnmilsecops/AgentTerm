'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface RevealProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly delayMs?: number;
}

export function Reveal({ children, className, delayMs = 0 }: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      element.dataset.revealed = 'true';
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            window.setTimeout(() => {
              element.dataset.revealed = 'true';
            }, delayMs);
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.18 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [delayMs]);

  return (
    <div className={className} data-reveal="" ref={ref}>
      {children}
    </div>
  );
}
