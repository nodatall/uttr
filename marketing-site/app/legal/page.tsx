import type { Metadata } from "next";
import { LegalShell } from "@/components/legal-shell";

const supportEmail =
  process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@uttr.pro";

export const metadata: Metadata = {
  title: "Terms & Privacy | Uttr",
  description: "Uttr terms of service and privacy policy.",
};

export default function LegalPage() {
  return (
    <LegalShell title="Terms & Privacy" updated="April 17, 2026">
      <section id="terms" className="space-y-4">
        <h2>Terms of Service</h2>

        <h3>1. Using Uttr</h3>
        <p>
          Uttr is a desktop speech-to-text app and related website services. You
          may use Uttr only if you can form a binding agreement and you follow
          these terms and applicable law.
        </p>

        <h3>2. Accounts and access</h3>
        <p>
          Some features require an account, subscription, install token, or
          trial access. You are responsible for keeping your account credentials
          and device access secure. We may limit, suspend, or end access if we
          believe the service is being abused, attacked, resold without
          permission, or used in a way that harms Uttr or other users.
        </p>

        <h3>3. Subscriptions and billing</h3>
        <p>
          Paid plans are billed through Stripe. Subscription prices, billing
          intervals, and included features are shown before checkout. Unless
          cancelled, subscriptions renew automatically. You can cancel through
          the account or billing portal where available, or by contacting us.
        </p>
        <p>
          Fees are generally non-refundable except where required by law or
          where we choose to provide a refund. Stripe may collect and process
          billing information under its own terms and privacy policy.
        </p>

        <h3>4. Your content</h3>
        <p>
          You keep ownership of the audio, transcripts, prompts, and other
          content you use with Uttr. You give us permission to process that
          content only as needed to provide, secure, troubleshoot, and improve
          the service features you use.
        </p>

        <h3>5. Acceptable use</h3>
        <p>You agree not to use Uttr to:</p>
        <ul>
          <li>break the law or violate someone else&apos;s rights;</li>
          <li>submit content you do not have the right to process;</li>
          <li>reverse engineer, overload, scrape, or disrupt the service;</li>
          <li>
            share access tokens, bypass usage limits, or resell the service
            without permission.
          </li>
        </ul>

        <h3>6. Third-party services</h3>
        <p>
          Uttr may use third-party providers for payments, account
          infrastructure, email, hosting, analytics, and cloud transcription.
          Those providers are responsible for their own services, and their
          terms may apply when you use features that depend on them.
        </p>

        <h3>7. No warranty</h3>
        <p>
          Uttr is provided as is and as available. Transcription output may be
          incomplete, inaccurate, delayed, or unavailable. You are responsible
          for reviewing transcripts before relying on them, especially for
          professional, legal, medical, financial, or safety-sensitive uses.
        </p>

        <h3>8. Limitation of liability</h3>
        <p>
          To the maximum extent allowed by law, Uttr will not be liable for
          indirect, incidental, special, consequential, exemplary, or punitive
          damages, or for lost profits, lost data, lost goodwill, or service
          interruption.
        </p>

        <h3>9. Changes</h3>
        <p>
          We may update these terms as the product changes. If a change is
          material, we will make reasonable efforts to provide notice. Continued
          use of Uttr after an update means you accept the updated terms.
        </p>
      </section>

      <section id="privacy" className="space-y-4 pt-6">
        <h2>Privacy Policy</h2>

        <h3>1. Information we collect</h3>
        <p>
          We collect the information needed to run Uttr, including account
          email, subscription and entitlement status, Stripe customer and
          subscription identifiers, install or trial identifiers, hashed device
          fingerprints, usage event metadata such as feature source and audio
          duration, support messages, and basic server logs.
        </p>

        <h3>2. Audio, transcripts, and prompts</h3>
        <p>
          Uttr&apos;s desktop app is designed to keep local app history on your
          device. When you use cloud transcription or related hosted features,
          audio and request metadata are sent to Uttr&apos;s server and
          transcription provider so the request can be processed. We do not sell
          your audio, transcripts, or prompts.
        </p>

        <h3>3. How we use information</h3>
        <p>We use information to:</p>
        <ul>
          <li>
            provide transcription, account, trial, and paid access features;
          </li>
          <li>process payments and subscription status;</li>
          <li>prevent abuse, debug errors, and keep the service secure;</li>
          <li>respond to support requests;</li>
          <li>understand aggregate usage so we can improve Uttr.</li>
        </ul>

        <h3>4. Sharing</h3>
        <p>
          We share information with service providers only as needed to operate
          Uttr, such as Stripe for billing, Supabase for account and entitlement
          storage, email providers for transactional messages, hosting
          providers, and transcription providers for cloud transcription. We may
          also disclose information if required by law or to protect Uttr,
          users, or others.
        </p>

        <h3>5. Retention</h3>
        <p>
          We keep account, billing, entitlement, support, usage, and log data
          for as long as needed to provide the service, meet legal and
          accounting obligations, resolve disputes, prevent abuse, and maintain
          security. Local transcripts stored by the desktop app remain under
          your control on your device unless you delete or export them.
        </p>

        <h3>6. Security</h3>
        <p>
          We use reasonable technical and organizational measures to protect the
          service. No internet or desktop software can be guaranteed perfectly
          secure, so you should use strong account credentials and keep your
          device protected.
        </p>

        <h3>7. Your choices</h3>
        <p>
          You can cancel a paid subscription, stop using cloud transcription
          features, delete local app history from your device where the app
          provides that control, or contact us to request access, correction,
          deletion, or export of personal information.
        </p>

        <h3>8. Children</h3>
        <p>
          Uttr is not intended for children under 13, and we do not knowingly
          collect personal information from children under 13.
        </p>

        <h3>9. Contact</h3>
        <p>
          Questions about these terms or this privacy policy can be sent to{" "}
          <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
        </p>
      </section>
    </LegalShell>
  );
}
