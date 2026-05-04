export type AdminLicense = {
  id: string;
  organization_id?: string | null;
  workspace_id?: string | null;
  user_id?: string | null;
  license_type: "personal" | "enterprise" | "enterprise_reseller";
  status: "active" | "past_due" | "expired" | "canceled" | "suspended" | "terminated";
  customer_email?: string | null;
  customer_name?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  fallback_allowed?: boolean | null;
  reseller_billing_enabled?: boolean | null;
  token_consumption_billing_enabled?: boolean | null;
  features?: string[] | null;
  created_at?: string | null;
};

export type AdminArtifact = {
  id: string;
  version: string;
  channel?: "stable" | "beta" | "dev" | "enterprise";
  platform?: string | null;
  file_url?: string | null;
  archive_url?: string | null;
  checksum?: string | null;
  release_notes_url?: string | null;
  git_ref?: string | null;
  license_type_allowed?: string[] | null;
  public_mirror_after?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
};

export type LicenseType = AdminLicense["license_type"];
export type LicenseStatus = AdminLicense["status"];
export type ArtifactKind = "download" | "source_snapshot";
export type ArtifactChannel = "stable" | "beta" | "dev" | "enterprise";
