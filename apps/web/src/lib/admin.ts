// Rótulos das telas do Super Admin.

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  plan_id: string;
  status: string;
  subscription_status: string | null;
  created_at: string;
  last_active_at: string | null;
};

export const ROLE_LABEL: Record<string, string> = { user: "Cliente", support: "Suporte", admin: "Admin", super_admin: "Super admin" };
export const STATUS: Record<string, ["success" | "danger" | "warning", string]> = {
  active: ["success", "Ativa"],
  suspended: ["danger", "Suspensa"],
  pending_deletion: ["warning", "Excluindo"],
};
