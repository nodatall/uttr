import { afterEach, describe, expect, mock, test } from "bun:test";

let sendResult: {
  data: { id: string } | null;
  error: { message: string; name: string } | null;
} = {
  data: { id: "email_123" },
  error: null,
};
const sent: Array<Record<string, unknown>> = [];

mock.module("resend", () => ({
  Resend: class {
    emails = {
      send: async (payload: Record<string, unknown>) => {
        sent.push(payload);
        return sendResult;
      },
    };
  },
}));
mock.module("@/lib/env", () => ({
  readEmailConfig: () => ({
    resendApiKey: "re_test",
    from: "Uttr <noreply@uttr.test>",
  }),
}));

const { sendTransactionalEmail } = await import("./email");
const payload = {
  to: "user@uttr.test",
  subject: "Welcome",
  html: "<p>Welcome</p>",
};

afterEach(() => {
  sent.length = 0;
  sendResult = { data: { id: "email_123" }, error: null };
});

describe("transactional email adapter", () => {
  test("sends the configured sender and message", async () => {
    await expect(sendTransactionalEmail(payload)).resolves.toBeUndefined();
    expect(sent).toEqual([{ from: "Uttr <noreply@uttr.test>", ...payload }]);
  });

  test("rejects Resend errors returned without a thrown exception", async () => {
    sendResult = {
      data: null,
      error: { name: "validation_error", message: "Domain is not verified." },
    };
    await expect(sendTransactionalEmail(payload)).rejects.toThrow(
      "Domain is not verified.",
    );
  });
});
