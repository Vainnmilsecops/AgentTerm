export interface SkeletonProps {
  readonly height?: string;
  readonly width?: string;
}

export function Skeleton({ height = '0.8rem', width = '100%' }: SkeletonProps) {
  return <span aria-hidden="true" className="skeleton" style={{ height, width }} />;
}
