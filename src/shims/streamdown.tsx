import type { HTMLAttributes, ReactNode } from "react";

type StreamdownProps = HTMLAttributes<HTMLDivElement> & {
  children?: ReactNode;
  plugins?: unknown;
  isAnimating?: boolean;
};

export function Streamdown({ children, className, plugins: _plugins, isAnimating: _anim, ...props }: StreamdownProps) {
  const text =
    typeof children === "string"
      ? children
      : Array.isArray(children)
        ? children.join("")
        : String(children ?? "");

  return (
    <div className={className} data-streamdown-shim {...props}>
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{text}</pre>
    </div>
  );
}
