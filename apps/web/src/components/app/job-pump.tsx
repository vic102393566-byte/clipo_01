"use client";

import { useEffect } from "react";

import { pumpJobs } from "@/lib/job-pump";

/** Com o Clipo aberto, avança a fila e o agendador uma vez por minuto (publicações no horário). */
export function JobPump() {
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void pumpJobs();
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
