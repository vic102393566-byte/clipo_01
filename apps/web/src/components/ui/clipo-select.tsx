"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/*
 * Select do Clipo: mesma forma de usar do <select> nativo (value, onChange com e.target.value e
 * <option> como filhos), mas com a lista no visual escuro da plataforma.
 * Teclado: setas mudam o destaque, Enter/Espaço escolhem, Esc fecha, letras pulam para a opção.
 */

type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };
type Option = { value: string; label: ReactNode; text: string; disabled: boolean };

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function readOptions(children: ReactNode): Option[] {
  const out: Option[] = [];
  Children.toArray(children).forEach((child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<OptionProps & { children?: ReactNode }>;
    if (el.type === "optgroup") {
      out.push(...readOptions(el.props.children));
      return;
    }
    const label = el.props.children;
    const value = el.props.value ?? textOf(label);
    out.push({ value: String(value), label, text: textOf(label), disabled: Boolean(el.props.disabled) });
  });
  return out;
}

type ChangeEvent = { target: { value: string; name?: string }; currentTarget: { value: string } };

export function Select({
  value,
  defaultValue,
  onChange,
  children,
  disabled,
  className = "",
  name,
  title,
  id,
  placeholder = "Selecione",
  "aria-label": ariaLabel,
}: {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: ChangeEvent) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  name?: string;
  title?: string;
  id?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const options = readOptions(children);
  const [inner, setInner] = useState(String(defaultValue ?? options[0]?.value ?? ""));
  const current = value !== undefined ? String(value) : inner;
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  // Classes de largura vão para o contêiner (o botão ocupa o contêiner); sem elas, o select fica do
  // tamanho do texto, como o nativo.
  const widthClasses = className.split(/\s+/).filter((c) => /^(w-|min-w-|max-w-|flex-1|grow|shrink|basis-|sm:w-|md:w-|lg:w-)/.test(c));
  const triggerClasses = className.split(/\s+/).filter((c) => !widthClasses.includes(c)).join(" ");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // A lista flutua fixa na tela (cartões com overflow escondido não cortam) e acompanha rolagem.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < 260 && r.top > 260;
      setPos({ top: up ? r.top - 6 : r.bottom + 6, left: r.left, width: r.width, up });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (opt: Option) => {
    if (opt.disabled) return;
    if (value === undefined) setInner(opt.value);
    onChange?.({ target: { value: opt.value, name }, currentTarget: { value: opt.value } });
    setOpen(false);
    button.current?.focus();
  };

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };

  const move = (step: number) => {
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + step + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (options[active]) choose(options[active]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    } else if (e.key.length === 1) {
      const i = options.findIndex((o) => o.text.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div ref={wrap} className={`relative ${widthClasses.length ? widthClasses.join(" ") : "inline-block"}`}>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKey}
        className={`flex w-full items-center justify-between gap-2 whitespace-nowrap text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#38bdf8] ${triggerClasses}`}
      >
        <span className="min-w-0 truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-[#6e87a8] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      {open ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={-1}
          style={
            pos
              ? { top: pos.top, left: pos.left, minWidth: pos.width, transform: pos.up ? "translateY(-100%)" : undefined }
              : { visibility: "hidden" }
          }
          className="fixed z-[1000] max-h-64 w-max max-w-[22rem] overflow-y-auto rounded-xl border border-[#1b3456] bg-[#061224]/98 p-1 shadow-[0_18px_40px_rgba(0,0,0,0.6)] backdrop-blur-md animate-rise-in"
        >
          {options.map((opt, i) => {
            const isSel = opt.value === current;
            return (
              <li
                key={`${opt.value}-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSel}
                aria-disabled={opt.disabled || undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(opt)}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs transition-colors ${
                  opt.disabled
                    ? "cursor-not-allowed text-[#3d5677]"
                    : i === active
                      ? "bg-[#0c2444] text-white"
                      : isSel
                        ? "text-[#38bdf8]"
                        : "text-[#c4d4eb]"
                }`}
              >
                <span className="min-w-0 truncate">{opt.label}</span>
                {isSel ? <Check className="h-3.5 w-3.5 shrink-0 text-[#38bdf8]" aria-hidden /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
