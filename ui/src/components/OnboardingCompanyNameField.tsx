import { useId, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";

interface OnboardingCompanyNameFieldProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export function OnboardingCompanyNameField({
  value,
  onChange,
  onKeyDown,
}: OnboardingCompanyNameFieldProps) {
  const inputId = useId();

  return (
    <div className="mt-3 group">
      <label
        htmlFor={inputId}
        className={cn(
          "text-xs mb-1 block transition-colors",
          value.trim()
            ? "text-foreground"
            : "text-muted-foreground group-focus-within:text-foreground",
        )}
      >
        Company name
      </label>
      <input
        id={inputId}
        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
        placeholder="Acme Corp"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
    </div>
  );
}
