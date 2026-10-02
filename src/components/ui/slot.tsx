import { cloneElement, isValidElement, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Minimal "asChild" helper: merges className/props onto the single child element (e.g. a Next Link). */
export function Slot({ children, className, ...props }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  if (!isValidElement(children)) return null;
  const child = children as ReactElement<{ className?: string }>;
  return cloneElement(child, { ...props, className: cn(className, child.props.className) });
}
