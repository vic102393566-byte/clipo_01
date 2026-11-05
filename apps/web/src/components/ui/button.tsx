import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "xl";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold " +
  "transition-[background-color,border-color,color,box-shadow,transform,filter] duration-150 ease-out " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-soft " +
  "disabled:pointer-events-none disabled:opacity-55 active:translate-y-px cursor-pointer";

const variants: Record<Variant, string> = {
  // O "Entrar" da referência.
  primary: "btn-glow text-white hover:brightness-110 hover:shadow-[0_0_28px_-2px_rgb(17_103_255/0.7)]",
  // O "Entrar com Google" da referência: fundo escuro, borda fina.
  secondary: "border border-line-strong bg-surface-2/70 text-ink hover:border-[#2c4262] hover:bg-surface-3",
  outline: "border border-line-strong text-ink-2 hover:border-brand-soft/60 hover:text-ink",
  ghost: "text-ink-2 hover:bg-surface-3 hover:text-ink",
  danger: "border border-danger/40 bg-danger/10 text-[#ffb3b3] hover:bg-danger/20",
};

const sizes: Record<Size, string> = {
  sm: "h-8 rounded-lg px-3 text-[13px]",
  md: "h-10 rounded-[0.625rem] px-4 text-sm",
  lg: "h-12 rounded-full px-6 text-[15px]",
  // Altura dos botões do login.
  xl: "h-12 rounded-full px-6 text-[0.98rem]",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra = "") {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`${className} inline-block animate-spin rounded-full border-2 border-current border-r-transparent opacity-80`}
    />
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  pending?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  pending = false,
  icon,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
