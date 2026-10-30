"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const Tag = Component as keyof JSX.IntrinsicElements;

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    <Tag
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent animate-[shimmer-slide_var(--shimmer-duration)_linear_infinite]",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-duration": `${duration}s`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
          backgroundPosition: "100% center",
        } as CSSProperties
      }
    >
      {children}
    </Tag>
  );
};

export const Shimmer = memo(ShimmerComponent);
