import { sendTransactionalEmail } from "@/lib/email/resend";

export type EnterpriseLead = {
  name?: string;
  email?: string;
  company?: string;
  companySize?: string;
  useCase?: string;
  deploymentPreference?: string;
  expectedUsers?: string;
  expectedAgents?: string;
  expectedEnvironments?: string;
  complianceNeeds?: string;
  sourceAccess?: boolean | string;
  resellerRights?: boolean | string;
  message?: string;
};

function asString(value: unknown, max = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function yesNo(value: unknown): string {
  return value === true || value === "true" || value === "on" ? "yes" : "no";
}

export function enterpriseSalesEmail(): string {
  return process.env.ENTERPRISE_SALES_EMAIL || "sales@gogroovy.ai";
}

export function renderEnterpriseLeadText(body: EnterpriseLead): string {
  return [
    "New Groovy Enterprise Lead",
    `Sales inbox: ${enterpriseSalesEmail()}`,
    `Name: ${asString(body.name) || "(missing)"}`,
    `Email: ${asString(body.email) || "(missing)"}`,
    `Company: ${asString(body.company) || "(missing)"}`,
    `Company size: ${asString(body.companySize) || "(missing)"}`,
    `Deployment: ${asString(body.deploymentPreference) || "(missing)"}`,
    `Users: ${asString(body.expectedUsers) || "(missing)"}`,
    `Agents: ${asString(body.expectedAgents) || "(missing)"}`,
    `Environments: ${asString(body.expectedEnvironments) || "(missing)"}`,
    `Source access: ${yesNo(body.sourceAccess)}`,
    `Reseller rights: ${yesNo(body.resellerRights)}`,
    `Use case: ${asString(body.useCase, 1000) || "(missing)"}`,
    `Compliance: ${asString(body.complianceNeeds, 1000) || "(none)"}`,
    `Message: ${asString(body.message, 1000) || "(none)"}`,
  ].join("\n");
}

async function sendWebhook(text: string): Promise<boolean> {
  const webhook = process.env.ENTERPRISE_SALES_WEBHOOK_URL || process.env.HOSTED_MACS_SLACK_WEBHOOK_URL;
  if (!webhook) return false;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}

async function sendResendEmail(subject: string, text: string): Promise<boolean> {
  const result = await sendTransactionalEmail({
    from:
      process.env.ENTERPRISE_SALES_FROM ||
      "Groovy Sales <sales@hi.gogroovy.ai>",
    to: enterpriseSalesEmail(),
    subject,
    text,
  });
  return result.ok;
}

export async function notifyEnterpriseSalesLead(body: EnterpriseLead): Promise<{
  emailSent: boolean;
  webhookSent: boolean;
}> {
  const text = renderEnterpriseLeadText(body);
  const [emailSent, webhookSent] = await Promise.all([
    sendResendEmail("New Groovy Enterprise lead", text).catch(() => false),
    sendWebhook(text).catch(() => false),
  ]);
  return { emailSent, webhookSent };
}
