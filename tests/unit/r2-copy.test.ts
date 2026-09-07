import { afterEach, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({}) }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...original,
    S3Client: class {
      send = send;
    },
  };
});
import { R2Storage } from "@/lib/storage/r2";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("initializes the bucket before building CopySource on a fresh restore request", async () => {
  vi.stubEnv("R2_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_BUCKET", "test-bucket");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
  await new R2Storage().copy("drafts/old version.html", "drafts/new.html", "text/html");
  expect(send.mock.calls[0]![0].input).toMatchObject({
    Bucket: "test-bucket",
    CopySource: "test-bucket/drafts/old%20version.html",
    Key: "drafts/new.html",
    IfNoneMatch: "*",
  });
});
