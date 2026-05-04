export type LicensePayload = {
  license_id?: string;
  license_type?: string;
  status?: string;
  customer_email?: string | null;
  customer_name?: string | null;
  valid_from?: string;
  valid_until?: string;
  fallback_allowed?: boolean;
  max_devices?: number | null;
  max_users?: number | null;
  max_agents?: number | null;
  max_environments?: number | null;
  reseller_billing_enabled?: boolean;
  token_consumption_billing_enabled?: boolean;
  features?: string[];
};

export type Device = {
  id: string;
  device_hash?: string;
  device_name?: string | null;
  platform?: string | null;
  app_version?: string | null;
  activated_at?: string;
  last_seen_at?: string;
  deactivated_at?: string | null;
};

export type LicenseEntitlement = {
  licensed?: boolean;
  scope?: "personal" | "workspace";
  workspaceId?: string | null;
  workspaceName?: string | null;
  role?: "admin" | "member" | null;
  license?: {
    payload?: LicensePayload;
  };
  licenseKey?: string | null;
  devices?: Device[];
  canManageLicense?: boolean;
};

export type LicenseStatus = {
  licensed?: boolean;
  status?: string;
  workspaceId?: string | null;
  license?: {
    payload?: LicensePayload;
  };
  licenseKey?: string | null;
  devices?: Device[];
  canManageLicense?: boolean;
  licenses?: LicenseEntitlement[];
  error?: string;
};

export type Artifact = {
  id: string;
  version: string;
  platform?: string;
  file_url?: string | null;
  archive_url?: string | null;
  checksum?: string | null;
  release_notes_url?: string | null;
  git_ref?: string | null;
  public_mirror_after?: string | null;
  created_at?: string;
};

export type DownloadsStatus = {
  licensed?: boolean;
  canReceiveUpdates?: boolean;
  licenseStatus?: string;
  message?: string;
  downloads?: Artifact[];
  sourceSnapshots?: Artifact[];
  error?: string;
};
