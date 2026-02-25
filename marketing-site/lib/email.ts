import { Resend } from "resend";
import { readEmailConfig } from "@/lib/env";

let resendClient: Resend | null = null;

function getResend() {
  const { resendApiKey } = readEmailConfig();
  if (!resendApiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(resendApiKey);
  }

  return resendClient;
}

type MailPayload = {
  to: string;
  subject: string;
  html: string;
};

export async function sendTransactionalEmail(payload: MailPayload) {
  const client = getResend();
  const { from } = readEmailConfig();

  if (!client) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "email_skipped",
        reason: "missing_resend_api_key",
        to: payload.to,
        subject: payload.subject,
      }),
    );
    return;
  }

  await client.emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  });
}
