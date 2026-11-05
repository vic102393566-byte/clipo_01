"use client";

import { Select as ClipoSelect } from "@/components/ui/clipo-select";
import { Eye, EyeOff } from "lucide-react";
import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type Size = "md" | "lg";

const control =
  "w-full rounded-field border bg-surface-2/80 text-ink outline-none transition-[border-color,box-shadow,background-color] duration-150 " +
  "placeholder:text-faint hover:border-line-strong focus:border-brand-soft/80 focus:bg-surface-2 " +
  "focus:shadow-[0_0_0_3px_rgb(17_103_255/0.22)] disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-danger/70 aria-[invalid=true]:focus:shadow-[0_0_0_3px_rgb(255_107_107/0.2)]";

const heights: Record<Size, string> = {
  md: "h-10 text-sm",
  // Campos do login.
  lg: "h-11 text-[0.95rem]",
};

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  icon?: ReactNode;
  revealable?: boolean;
  fieldSize?: Size;
  labelClassName?: string;
  /** Deixa o rótulo só para leitor de tela (quando a tela já mostra o contexto). */
  hideLabel?: boolean;
};

export function Field({
  label,
  hint,
  error,
  icon,
  revealable,
  fieldSize = "md",
  labelClassName = "",
  hideLabel,
  type = "text",
  className = "",
  ...input
}: FieldProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  const big = fieldSize === "lg";
  return (
    <div className={`grid ${big ? "gap-1.5" : "gap-1.5"} ${className}`}>
      <label
        htmlFor={id}
        className={`${hideLabel ? "sr-only" : ""} ${big ? "text-sm" : "text-[13px]"} font-medium text-ink-2 ${labelClassName}`}
      >
        {label}
      </label>
      <div className="relative">
        {icon ? (
          <span
            aria-hidden
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted ${big ? "left-3.5 [&>svg]:h-[1.15rem] [&>svg]:w-[1.15rem]" : "left-3 [&>svg]:h-4 [&>svg]:w-4"}`}
          >
            {icon}
          </span>
        ) : null}
        <input
          id={id}
          type={revealable && revealed ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${control} ${heights[fieldSize]} border-line ${icon ? (big ? "pl-11" : "pl-9") : big ? "pl-3.5" : "pl-3"} ${revealable ? (big ? "pr-11" : "pr-10") : big ? "pr-3.5" : "pr-3"}`}
          {...input}
        />
        {revealable ? (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? "Esconder senha" : "Mostrar senha"}
            aria-pressed={revealed}
            className={`absolute top-1/2 -translate-y-1/2 rounded-md text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-soft ${big ? "right-2.5 p-1.5 [&>svg]:h-[1.15rem] [&>svg]:w-[1.15rem]" : "right-2 p-1 [&>svg]:h-4 [&>svg]:w-4"}`}
          >
            {revealed ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
          </button>
        ) : null}
      </div>
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-[#ff9a9a]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode; error?: string }) {
  const id = useId();
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-desc` : undefined}
        className={`${control} min-h-24 resize-y border-line px-3 py-2.5 text-sm leading-relaxed`}
        {...rest}
      />
      {hint || error ? (
        <p id={`${id}-desc`} className={`text-xs ${error ? "font-medium text-[#ff9a9a]" : "text-muted"}`}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  hint,
  className = "",
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  name,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  name?: string;
}) {
  const id = useId();
  return (
    <div className={`grid gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      <ClipoSelect
        id={id}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        disabled={disabled}
        name={name}
        className={`${control} h-10 border-line pr-3 pl-3 text-sm`}
      >
        {children}
      </ClipoSelect>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
