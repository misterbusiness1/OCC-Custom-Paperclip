import { createContext, useContext, type ReactNode } from "react";

/**
 * The heading level of the section labels inside a request ("Recommendation", "Why", ...).
 * A surface that shows the request under a heading of its own sets the level one below that
 * heading: the card under its h3 title, the approval's page under its h1. Where no level is
 * set (an inbox row), the label stays a plain paragraph. The label looks the same either way.
 */
export const ApprovalSectionHeadingLevel = createContext<2 | 3 | 4 | 5 | null>(null);

export function ApprovalSectionLabel({
  id,
  className,
  children,
}: {
  id?: string;
  className: string;
  children: ReactNode;
}) {
  const level = useContext(ApprovalSectionHeadingLevel);
  const Tag = level ? (`h${level}` as const) : "p";
  return (
    <Tag id={id} className={className}>
      {children}
    </Tag>
  );
}
