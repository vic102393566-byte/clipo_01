"use client";

import { ArrowRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { AuthHeading } from "@/components/auth/auth-frame";
import { AuthLink } from "@/components/auth/oauth";
import { Button } from "@/components/ui/button";
import { Field as BaseField } from "@/components/ui/field";
import { Notice as BaseNotice } from "@/components/ui/notice";

/**
 * Peças das telas de entrada. A moldura (foto, vidro, logo) vem do layout de (auth);
 * aqui fica o miolo do card: título, formulário e o rodapé ("Ainda não tem conta?").
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <>
      <AuthHeading title={title} subtitle={subtitle} />
      {children}
      {footer ? <p className="mt-4 text-center text-[0.92rem] text-muted">{footer}</p> : null}
    </>
  );
}

export function Field(props: ComponentProps<typeof BaseField>) {
  return <BaseField fieldSize="lg" {...props} />;
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" variant="primary" size="xl" pending={pending} className="mt-1 w-full">
      {children}
      {pending ? null : <ArrowRight aria-hidden className="h-4 w-4" />}
    </Button>
  );
}

export function Notice({ tone, children }: { tone: "error" | "success" | "info"; children: ReactNode }) {
  return <BaseNotice tone={tone}>{children}</BaseNotice>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <AuthLink href={href}>{children}</AuthLink>;
}
